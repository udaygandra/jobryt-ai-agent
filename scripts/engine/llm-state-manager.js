/**
 * llm-state-manager.js — Waterfall Rate-Limiter & State Tracker
 *
 * Implements sliding-window RPM (requests per minute) and Pacific-midnight RPD
 * (requests per day) quota tracking across the Gemini & Gemma model waterfall.
 */

const fs = require('fs');
const path = require('path');

// ── User-Specified Waterfall Configuration ───────────────────────────────────
const WATERFALL = [
  { id: 'gemini-3.8-flash',      rpm: 5,  rpd: 20,    max_tokens: 250000 },
  { id: 'gemini-3.7-flash',      rpm: 5,  rpd: 20,    max_tokens: 250000 },
  { id: 'gemini-3.6-flash',      rpm: 5,  rpd: 20,    max_tokens: 250000 },
  { id: 'gemini-3.5-flash',      rpm: 5,  rpd: 20,    max_tokens: 250000 },
  { id: 'gemini-3-flash',        rpm: 5,  rpd: 20,    max_tokens: 250000 },
  { id: 'gemini-2.5-flash',      rpm: 5,  rpd: 20,    max_tokens: 250000 },
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500,   max_tokens: 250000 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500,   max_tokens: 250000 },
  { id: 'gemma-4-31b',           rpm: 30, rpd: 14400, max_tokens: 16000 },
  { id: 'gemma-4-26b',           rpm: 30, rpd: 14400, max_tokens: 16000 }
];

function resolveStateFilePath() {
  const dataDir = (process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data'))).replace(/\\/g, '/');
  const trackingDir = dataDir.endsWith('/tracking') ? dataDir : path.join(dataDir, 'tracking');
  if (!fs.existsSync(trackingDir)) {
    try { fs.mkdirSync(trackingDir, { recursive: true }); } catch (_) {}
  }
  return path.join(trackingDir, 'llm_state.json');
}

function getPacificDateStr() {
  // Quotas reset at midnight Pacific (UTC-8)
  const nowUtc = new Date();
  const pacificTime = new Date(nowUtc.getTime() - (8 * 3600 * 1000));
  return pacificTime.toISOString().split('T')[0];
}

function getLLMState() {
  const filePath = resolveStateFilePath();
  let state = {};
  try {
    if (fs.existsSync(filePath)) {
      state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.warn('[LLM State] Error reading state file:', err.message);
  }

  const today = getPacificDateStr();
  for (const m of WATERFALL) {
    if (!state[m.id]) {
      state[m.id] = { calls_today: 0, minute: [], blocked_until: 0.0, day: today, blacklisted: false };
    }
    // Daily reset check
    if (state[m.id].day !== today) {
      state[m.id].day = today;
      state[m.id].calls_today = 0;
    }
  }
  return state;
}

function saveLLMState(state) {
  const filePath = resolveStateFilePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[LLM State] Error saving state file:', err.message);
  }
}

function isModelAvailable(m, state, estTokens = 0) {
  if (estTokens > m.max_tokens) return false;
  const s = state[m.id];
  if (!s || s.blacklisted) return false;

  const today = getPacificDateStr();
  if (s.day !== today) {
    s.day = today;
    s.calls_today = 0;
  }

  const nowSec = Date.now() / 1000;
  s.minute = (s.minute || []).filter(t => nowSec - t < 60);

  return (
    nowSec >= (s.blocked_until || 0) &&
    s.calls_today < m.rpd &&
    s.minute.length < m.rpm
  );
}

/**
 * Returns the next available model in the waterfall.
 * If all models are rate limited, returns waitMs for earliest unlock.
 */
function getNextWaterfallModel(estTokens = 0) {
  const state = getLLMState();
  const nowSec = Date.now() / 1000;
  let earliestUnlock = Infinity;
  let fallbackModel = null;

  for (const m of WATERFALL) {
    if (isModelAvailable(m, state, estTokens)) {
      saveLLMState(state);
      return { model: m, waitMs: 0, state };
    }

    const s = state[m.id];
    if (s && !s.blacklisted && s.calls_today < m.rpd) {
      const unlockTime = Math.max(s.blocked_until || 0, s.minute.length >= m.rpm ? (s.minute[0] + 60) : nowSec);
      if (unlockTime < earliestUnlock) {
        earliestUnlock = unlockTime;
        fallbackModel = m;
      }
    }
  }

  saveLLMState(state);
  const waitMs = (earliestUnlock !== Infinity && earliestUnlock > nowSec)
    ? Math.round((earliestUnlock - nowSec) * 1000)
    : 0;

  return { model: fallbackModel || WATERFALL[0], waitMs, state };
}

function recordModelCall(modelId) {
  const state = getLLMState();
  const nowSec = Date.now() / 1000;
  const s = state[modelId] || { calls_today: 0, minute: [], blocked_until: 0, day: getPacificDateStr() };
  s.minute = (s.minute || []).filter(t => nowSec - t < 60);
  s.minute.push(nowSec);
  s.calls_today = (s.calls_today || 0) + 1;
  state[modelId] = s;
  saveLLMState(state);
}

function recordModelError(modelId, error) {
  const state = getLLMState();
  const nowSec = Date.now() / 1000;
  const s = state[modelId] || { calls_today: 0, minute: [], blocked_until: 0, day: getPacificDateStr() };
  const errMsg = (typeof error === 'string' ? error : (error?.message || '')).toLowerCase();

  if (errMsg.includes('429') || errMsg.includes('resource_exhausted') || errMsg.includes('quota exceeded')) {
    if (errMsg.includes('per day') || errMsg.includes('daily')) {
      const cfg = WATERFALL.find(m => m.id === modelId);
      s.calls_today = cfg ? cfg.rpd : 99999;
      console.warn(`⏳ Model [${modelId}] reached daily quota limit.`);
    } else {
      s.blocked_until = nowSec + 60; // 60s per-minute block
      console.warn(`⏳ Model [${modelId}] blocked for 60s (RPM limit).`);
    }
  } else if (errMsg.includes('500') || errMsg.includes('503') || errMsg.includes('service unavailable')) {
    s.blocked_until = nowSec + 30; // 30s server error block
    console.warn(`⚠️ Model [${modelId}] 500/503 temporary error. Blocked for 30s.`);
  } else if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('unsupported')) {
    s.blacklisted = true;
    console.warn(`🚫 Model [${modelId}] permanently blacklisted (404 Not Found).`);
  }

  state[modelId] = s;
  saveLLMState(state);
}

module.exports = {
  WATERFALL,
  getLLMState,
  saveLLMState,
  getNextWaterfallModel,
  isModelAvailable,
  recordModelCall,
  recordModelError
};
