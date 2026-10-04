/**
 * run-pipeline.js — Intelligent Job Pipeline Orchestrator
 *
 * PURPOSE:
 *   High-performance, resilient job search pipeline runner.
 *   Orchestrates the entire job evaluation lifecycle:
 *   1. Multi-board job fetching (via fetch-all-boards.js)
 *   2. Deterministic filtering (Freshness & Deduplication)
 *   3. Deterministic title gating ($0 token pre-filter)
 *   4. LLM / Heuristic match scoring
 *   5. Interactive Telegram card delivery with [Apply]/[Reject] buttons
 *   6. Comprehensive logging to CSV and JSON tracking files
 *
 * USAGE:
 *   node scripts/run-pipeline.js [chatId]
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

// ── Step 1: Load Environment and Common Utilities ───────────────────────────
const { loadEnv } = require('../core/load-env');
loadEnv();

const { getDataDir, readJsonFile, writeJsonFile, escapeHtml } = require('../core/common-utils');
const { fetchAllJobs } = require('./fetch-all-boards');
const { getSettings } = require('../core/settings-helper');
const { callLLMProvider, buildDynamicScoringPrompt } = require('./llm-provider');
const {
  normalizeJob,
  runFreshnessFilter,
  runDedupFilter,
  runGeoFilter,
  evaluateDynamicTitleFit,
  computeHeuristicScore,
  runParseScore,
} = require('./node-logic');

// SQLite Database & File paths
const jobsDb = require('../core/jobs-db');
const dataDir = getDataDir();
const profileFile = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json');
const dashboardFile = path.join(__dirname, '..', '..', 'data', 'tracking', 'dashboard.csv');

// Telegram Configuration
const targetChatId = process.argv[2] || process.env.TELEGRAM_CHAT_ID;
const botToken = process.env.TELEGRAM_BOT_TOKEN;

// ── Helper: Telegram Messaging ──────────────────────────────────────────────
async function sendTelegramMessage(text, replyMarkup = null) {
  if (!botToken || !targetChatId) return null;

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: targetChatId,
      parse_mode: 'HTML',
      text,
      ...(replyMarkup && { reply_markup: replyMarkup }),
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => {
      console.error('[Telegram] Send error:', err.message);
      resolve(null);
    });
    
    req.write(payload);
    req.end();
  });
}

async function sendJobAlertCard(job) {
  const jobUrl = job.redirect_url || job.job_url || job.apply_url || job.url || job.link || '';
  const urlLine = jobUrl ? `\n🔗 <b>Job Link:</b> <a href="${jobUrl}">${jobUrl}</a>\n` : '';
  const tier = job.company_tier || 'Enterprise / Product';
  const priority = job.priority_level || (job.score >= 80 ? 'High' : 'Medium');
  const score = job.score || job.overall_score || 0;
  const reasoning = job.reasoning || job.why_this_fits || 'Direct alignment with verified experience and skills.';

  const msgText = `🎯 <b>HIGH MATCH FOUND:</b>\n\n` +
    `<b>Role:</b> ${escapeHtml(job.title || 'Unknown')}\n` +
    `<b>Company:</b> ${escapeHtml(job.company || 'Unknown')}\n` +
    `<b>Tier:</b> ${escapeHtml(tier)}\n` +
    `📈 <b>Score:</b> ${score}/100 (${escapeHtml(priority)} Priority)\n` +
    urlLine +
    `\n<b>Reasoning:</b>\n${escapeHtml(reasoning)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Apply', callback_data: `APPLY:${job.id}`.slice(0, 64) },
        { text: '❌ Reject', callback_data: `REJECT:${job.id}`.slice(0, 64) }
      ]
    ]
  };

  return sendTelegramMessage(msgText, keyboard);
}

// ── Core Pipeline Orchestrator ──────────────────────────────────────────────
async function runPipeline() {
  console.log('🚀 Starting Intelligent Job Pipeline Execution...');

  // 1. Load configuration and candidate profile
  const profile = readJsonFile(profileFile, {});
  const settings = getSettings();
  const minThreshold = settings.score_threshold || (process.env?.MIN_SCORE_THRESHOLD ? Number(process.env.MIN_SCORE_THRESHOLD) : 60);
  const freshnessHours = settings.freshness_hours !== undefined ? settings.freshness_hours : 24;

  const targetTitles = Array.isArray(profile.target_titles) && profile.target_titles.length > 0 ? profile.target_titles : ['Target Role'];
  const locations = Array.isArray(profile.locations) && profile.locations.length > 0 ? profile.locations : ['Remote'];

  console.log(`👤 Candidate: ${profile.name || 'Candidate'}`);
  console.log(`🎯 Target Titles: ${targetTitles.join(', ')}`);
  console.log(`📍 Locations: ${locations.join(', ')}`);
  console.log(`🕒 Freshness Window: ${freshnessHours === 0 ? 'Disabled (Any Time)' : freshnessHours + 'h'} | Threshold: ${minThreshold}+`);

  // 2. Multi-Board Ingestion
  console.log('\n📡 Fetching live jobs across active boards...');
  let rawFetchedJobs = [];
  try {
    rawFetchedJobs = await fetchAllJobs();
  } catch (err) {
    console.error('❌ Error fetching jobs:', err.message);
  }

  const allRawItems = rawFetchedJobs.map(j => normalizeJob(j, j.source || 'unknown')).filter(Boolean);
  console.log(`📥 Total raw jobs fetched: ${allRawItems.length}`);

  // 3. Apply Freshness & Geo Filters (Exact same sequence as n8n master workflow)
  let filteredItems = runFreshnessFilter(allRawItems.map(j => ({ json: j })), freshnessHours);
  filteredItems = runGeoFilter(filteredItems, profile);
  const freshItems = filteredItems.map(i => i.json);
  console.log(`⌛ Freshness & Geo Filter passed: ${freshItems.length} jobs`);

  // 4. Apply Deduplication Filter using SQLite jobsDb
  const unSeenJobs = freshItems.filter(job => {
    const id = job.id ? String(job.id) : null;
    const url = job.redirect_url || job.job_url || null;
    const compClean = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const titClean = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sig = compClean && titClean ? `comp_${compClean}_tit_${titClean}` : null;
    if (id && jobsDb.isJobSeen(id)) return false;
    if (url && jobsDb.isJobSeen(url)) return false;
    if (sig && jobsDb.isJobSeen(sig)) return false;
    return true;
  });
  console.log(`🔄 Dedup Filter passed: ${unSeenJobs.length} new unseen jobs`);

  // 5. Code-First Deterministic Title Gating
  const candidateJobs = [...unSeenJobs];
  console.log(`🎯 Gating passed: ${candidateJobs.length} candidates ready for evaluation`);

  // 6. Evaluation & Scoring (Capped at 100 jobs max, matching n8n workflow)
  const MAX_JOBS_TO_SCORE = 100;
  const jobsToScore = candidateJobs.slice(0, MAX_JOBS_TO_SCORE);
  console.log(`⚡ Scoring batch of ${jobsToScore.length} jobs (capped at ${MAX_JOBS_TO_SCORE} max)...`);
  const scoredJobs = [];
  const newlySeenIds = [];

  for (const job of jobsToScore) {
    // Track newly seen ID/URL for jobs that are actually evaluated
    if (job.id) newlySeenIds.push(String(job.id));
    if (job.job_url) newlySeenIds.push(String(job.job_url));
    if (job.redirect_url) newlySeenIds.push(String(job.redirect_url));
    const compClean = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const titClean = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (compClean && titClean) newlySeenIds.push(`comp_${compClean}_tit_${titClean}`);

    console.log(`⚡ Evaluating: ${job.title} @ ${job.company}...`);
    let scoredItem = null;

    try {
      const prompt = buildDynamicScoringPrompt(profile, job.title, job.description, job.company);
      const llmRes = await callLLMProvider({ prompt, provider: process.env.LLM_PROVIDER });

      if (llmRes.success) {
        job.rawText = llmRes.rawText;
        scoredItem = runParseScore({ json: { ...job } }, profile).json;
      }
    } catch (err) {
      console.warn(`⚠️ LLM scoring failed, using heuristic fallback:`, err.message);
    }

    // Fallback to CPU-based heuristic scoring if LLM fails or is malformed
    if (!scoredItem || typeof scoredItem.score !== 'number') {
      scoredItem = computeHeuristicScore(job, profile);
    }

    const finalScoredJob = {
      ...job,
      ...scoredItem,
      id: job.id || scoredItem.id,
      title: (job.title || scoredItem.title || 'Target Role').trim(),
      company: (job.company || scoredItem.company || 'Direct Employer').trim(),
      location: (job.location || scoredItem.location || 'Remote / Hybrid').trim(),
      source: job.source || scoredItem.source || 'Direct',
      job_url: job.job_url || job.redirect_url || scoredItem.job_url || scoredItem.redirect_url || '',
      redirect_url: job.redirect_url || job.job_url || scoredItem.redirect_url || scoredItem.job_url || '',
      why_this_fits: scoredItem.why_this_fits || scoredItem.reasoning || 'Strong profile alignment',
    };

    scoredJobs.push(finalScoredJob);
    console.log(`   └─ Score: ${finalScoredJob.score}/100 (Apply: ${finalScoredJob.should_apply})`);

    // Pacing delay to respect API limits
    await new Promise(r => setTimeout(r, 600));
  }

  // 7. Sort Descending by Score (Matching n8n Master Workflow)
  scoredJobs.sort((a, b) => (b.score || b.overall_score || 0) - (a.score || a.overall_score || 0));

  // 8. Update SQLite Database
  const qualified = scoredJobs.filter(j => (j.score || j.overall_score || 0) > minThreshold && j.should_apply !== false);
  const rejected = scoredJobs.filter(j => (j.score || j.overall_score || 0) <= minThreshold || j.should_apply === false);

  try { jobsDb.markJobsSeen(newlySeenIds); } catch (err) { console.error('markJobsSeen failed:', err.message); }
  rejected.forEach(r => { try { jobsDb.saveRejectedJob(r); } catch (err) { console.error('saveRejectedJob failed:', err.message); } });

  // A card's [Apply] button only works if its job row exists, so verify each save.
  const deliverable = [];
  for (const q of qualified) {
    const saved = jobsDb.savePendingJob(q) !== false && jobsDb.findJobRecord(q.id);
    if (saved) deliverable.push(q);
    else console.error(`❌ Could not persist pending job ${q.id}; skipping its Telegram card.`);
  }

  // Update CSV Dashboard
  try {
    let csvLines = fs.existsSync(dashboardFile)
      ? fs.readFileSync(dashboardFile, 'utf8').split('\n').filter(Boolean)
      : ['Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills'];

    for (const j of scoredJobs) {
      const src = (j.source || 'unknown').replace(/,/g, '');
      const comp = (j.company || 'Unknown').replace(/,/g, '');
      const tit = (j.title || '').replace(/,/g, '');
      const stat = j.score > minThreshold ? 'Qualified' : 'Rejected';
      const miss = (j.missing_skills || []).join('; ').replace(/,/g, '');
      csvLines.push(`${new Date().toISOString()},${j.id},${src},"${tit}","${comp}",${j.score},${stat},"${miss}"`);
    }
    fs.writeFileSync(dashboardFile, csvLines.join('\n') + '\n', 'utf8');
  } catch (_) {}

  // 8. Deliver Telegram Alerts
  for (const qJob of deliverable) {
    try {
      await sendJobAlertCard(qJob);
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}
  }

  // 9. Send Summary Report via Telegram
  if (qualified.length > 0) {
    const avgScore = Math.round(qualified.reduce((sum, j) => sum + (j.score || 0), 0) / qualified.length);
    const topMatch = qualified[0];
    await sendTelegramMessage(
      `🎉 <b>Job Scan Complete!</b>\n\n` +
      `📊 <b>Scan Summary:</b>\n` +
      `• <b>Analyzed:</b> ${allRawItems.length}\n` +
      `• <b>Qualified (≥${minThreshold}):</b> ${qualified.length}\n` +
      `• <b>Avg Score:</b> ${avgScore}/100\n` +
      `• <b>Top Match:</b> ${escapeHtml(topMatch.title)} @ ${escapeHtml(topMatch.company)} (<b>${topMatch.score}/100</b>)\n\n` +
      `✨ <i>Click [ 🚀 Apply ] on any card to generate a tailored resume & cover letter!</i>`
    );
  } else if (unSeenJobs.length > 0) {
    await sendTelegramMessage(
      `ℹ️ <b>Job Scan Complete — No High Matches</b>\n\n` +
      `• <b>Analyzed:</b> ${allRawItems.length}\n` +
      `• <b>New Listings:</b> ${unSeenJobs.length}\n` +
      `• <b>Result:</b> None met the <b>${minThreshold}+</b> threshold.\n\n` +
      `💡 <b>Tips:</b> Send <code>/freshness-filter 72</code> to widen the search window, or <code>/roles</code> to add adjacent titles.`
    );
  } else {
    const pendingJobs = jobsDb.getPendingJobs(500);
    if (pendingJobs.length > 0) {
      const topP = pendingJobs[0];
      await sendTelegramMessage(
        `ℹ️ <b>Listings Up to Date</b>\n\n` +
        `All ${allRawItems.length} active listings have already been evaluated.\n` +
        `📋 <b>Active Queue (${pendingJobs.length}):</b>\n` +
        `• <b>${escapeHtml(topP.title || 'Target Role')}</b> @ ${escapeHtml(topP.company || 'Company')} (<b>${topP.score || topP.match_score || 80}/100</b>)`
      );
    } else {
      await sendTelegramMessage(
        `ℹ️ <b>No New Postings Found</b>\n\n` +
        `All ${allRawItems.length} active listings have been evaluated.\n` +
        `💡 <i>Tip: Check back during the morning posting wave (8:30–10:30 AM EST).</i>`
      );
    }
  }

  console.log(`✅ Pipeline Complete. Qualified: ${qualified.length} | Scored: ${scoredJobs.length}`);
  return { success: true, totalRaw: allRawItems.length, unSeen: unSeenJobs.length, qualified: qualified.length };
}

// ── Execute if run directly ─────────────────────────────────────────────────
if (require.main === module) {
  runPipeline().catch(err => {
    console.error('❌ Fatal pipeline error:', err);
    sendTelegramMessage(`⚠️ <b>Job Scan Notice:</b> A network error occurred while scanning job boards. The system will retry automatically.`);
    process.exit(1);
  });
}

module.exports = { runPipeline };
