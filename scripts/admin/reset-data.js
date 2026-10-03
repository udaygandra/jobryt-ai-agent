/**
 * reset-data.js — Pipeline Tracking Data Reset (Soft Reset)
 *
 * PURPOSE:
 *   Resets only the pipeline tracking files (seen_jobs, pending_approval, etc.)
 *   to empty arrays, giving you a fresh run without losing your profile
 *   or configuration.
 *
 * WHAT IT PRESERVES:
 *   - master-profile.json (your candidate profile)
 *   - master-profile.example.json (example template)
 *   - resume-template.html (PDF template)
 *   - settings.json (your preferences)
 *
 * WHAT IT RESETS:
 *   - seen_jobs.json → []
 *   - pending_approval.json → []
 *   - qualified_jobs.json → []
 *   - rejected_jobs.json → []
 *   - logged_jobs.json → []
 *   - processed_jobs.json → []
 *   - dashboard.csv → header row only
 *   - adzuna_role_idx.json → { idx: 0 }
 *
 * USAGE:
 *   npm run reset
 *   # or: node scripts/reset-data.js
 */

const fs = require('fs');
const path = require('path');

// Resolve data directory
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');

// Files that reset to empty arrays
const TRACKING_FILES = [
  'seen_jobs.json',
  'pending_approval.json',
  'qualified_jobs.json',
  'rejected_jobs.json',
  'logged_jobs.json',
  'processed_jobs.json',
];

function resetData() {
  console.log('🧹 Resetting pipeline tracking data for a clean fresh run...\n');

  // Step 1: Reset SQLite database pipeline tables (seen_jobs, pending_jobs, rejected_jobs)
  try {
    const { clearPipelineData } = require('../core/jobs-db');
    clearPipelineData();
    console.log('  ✔ Reset SQLite tables: seen_jobs, pending_jobs, rejected_jobs');
  } catch (err) {
    console.warn('  ⚠️ Could not reset SQLite pipeline data:', err.message);
  }

  // Step 2: Reset legacy tracking files if any exist
  for (const filename of TRACKING_FILES) {
    const trackingPath = path.join(dataDir, 'tracking', filename);
    const rootPath = path.join(dataDir, filename);
    if (fs.existsSync(trackingPath)) {
      try { fs.unlinkSync(trackingPath); console.log(`  ✔ Cleaned legacy ${filename}`); } catch (_) {}
    }
    if (fs.existsSync(rootPath)) {
      try { fs.unlinkSync(rootPath); console.log(`  ✔ Cleaned legacy root ${filename}`); } catch (_) {}
    }
  }

  // Step 2: Reset dashboard CSV with header row
  const csvPath = path.join(dataDir, 'tracking', 'dashboard.csv');
  try {
    fs.writeFileSync(csvPath, 'Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills\n');
    console.log('  ✔ Reset dashboard.csv -> [CSV Headers]');
  } catch (_) {}

  // Step 3: Reset LLM State
  const llmStatePath = path.join(dataDir, 'tracking', 'llm_state.json');
  try {
    const initialLlmState = {};
    const WATERFALL_IDS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-31b', 'gemma-4-26b'];
    WATERFALL_IDS.forEach(id => {
      initialLlmState[id] = { calls_today: 0, minute: [], blocked_until: 0, day: new Date().toISOString().split('T')[0], blacklisted: false };
    });
    fs.writeFileSync(llmStatePath, JSON.stringify(initialLlmState, null, 2));
    console.log('  ✔ Reset llm_state.json -> [Fresh Quotas]');
  } catch (_) {}

  // Step 4: Reset Adzuna role rotation index
  const roleIdxPath = path.join(dataDir, 'cache', 'adzuna_role_idx.json');
  try {
    fs.writeFileSync(roleIdxPath, JSON.stringify({ idx: 0 }, null, 2));
    console.log('  ✔ Reset adzuna_role_idx.json -> {"idx": 0}');
  } catch (_) {}

  // Step 5: Reset Telegram Chat State
  const telegramStatePath = path.join(dataDir, 'bot', 'telegram_state.json');
  try {
    if (fs.existsSync(telegramStatePath)) {
      fs.writeFileSync(telegramStatePath, '{}', 'utf8');
      console.log('  ✔ Reset telegram_state.json -> {}');
    }
  } catch (_) {}

  console.log('\n✨ Fresh run environment ready! Trigger your workflow in n8n or run scripts.');
}

resetData();
