/**
 * telegram-bridge.js — Zero-Failure Telegram Callback Bridge
 *
 * PURPOSE:
 *   Listens for Telegram button clicks and commands via long-polling,
 *   and instantly forwards them to the n8n webhook or internal scripts.
 *   Avoids the need for exposed Webhook endpoints.
 *
 * USAGE:
 *   node scripts/telegram-bridge.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { loadEnv } = require('../core/load-env');
loadEnv();

const onboardingHandler = require('./onboarding-handler');
const settingsHelper = require('../core/settings-helper');
const { getDataDir } = require('../core/common-utils');
const { getSeenJobsCount, findJobRecord } = require('../core/jobs-db');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const defaultChatId = process.env.TELEGRAM_CHAT_ID;
const allowedUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS || defaultChatId || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const n8nBaseUrl = process.env.N8N_URL || 'http://localhost:5678';
const webhookPath = (process.env.TELEGRAM_WEBHOOK_PATH || 'telegram-callback').replace(/^\/+/, '');
const targetWebhookUrl = `${n8nBaseUrl.replace(/\/+$/, '')}/webhook/${webhookPath}`;

if (!botToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

function isAuthorizedSender(senderId) {
  if (allowedUserIds.length === 0) {
    console.warn('⚠️ No authorized Telegram chat/user IDs configured. Set TELEGRAM_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS.');
    return false;
  }
  return allowedUserIds.includes(String(senderId));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function clearWebhook() {
  return new Promise(resolve => {
    https.get(`https://api.telegram.org/bot${botToken}/deleteWebhook`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).ok));
    }).on('error', () => resolve(false));
  });
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!botToken || !chatId) return;
  return new Promise(resolve => {
    const bodyObj = { chat_id: chatId, parse_mode: 'HTML', text };
    if (replyMarkup) bodyObj.reply_markup = replyMarkup;
    const payload = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${botToken}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function downloadFile(fileId, destPath) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, res => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) return reject(new Error('Failed to getFile'));
          const fileUrl = `https://api.telegram.org/file/bot${botToken}/${json.result.file_path}`;
          const stream = fs.createWriteStream(destPath);
          https.get(fileUrl, fileRes => {
            fileRes.pipe(stream);
            stream.on('finish', () => { stream.close(); resolve(destPath); });
          }).on('error', reject);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function forwardToN8n(update, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const status = await new Promise(resolve => {
      const payload = JSON.stringify(update);
      const parsed = new URL(targetWebhookUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: parsed.hostname, port: parsed.port || (client === https ? 443 : 80),
        path: parsed.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, res => {
        let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(null));
      req.write(payload);
      req.end();
    });

    if (status === 200) {
      return 200;
    }

    if (attempt < maxRetries) {
      console.log(`⏳ n8n webhook returned ${status} on attempt ${attempt}/${maxRetries}. Retrying in 1.5s...`);
      await new Promise(r => setTimeout(r, 1500));
    } else {
      return status;
    }
  }
}


const { getLLMState, getNextWaterfallModel } = require('../engine/llm-state-manager');

function renderHelpMessage() {
  return `🤖 <b>JOBRYT AI JOB HUNT AGENT — HELP & COMMAND GUIDE</b>\n\n` +
    `Here is a full breakdown of all available action commands and features:\n\n` +
    `🚀 <b>CORE ACTIONS</b>\n` +
    `• <code>/scan</code> or <code>/find-jobs</code> — Trigger instant multi-board job search & scoring scan\n` +
    `• <code>/profile</code> — View your master profile, skills, verified experience & settings\n` +
    `• <code>/settings</code> — Open the interactive visual settings dashboard\n` +
    `• <code>/import-resume</code> — Upload a new resume (PDF/DOCX/TXT) to parse & calibrate profile\n` +
    `• <code>/recruiters &lt;company&gt;</code> — Find hiring team contacts & 1-tap Google search\n• <code>/status</code> — Check system health, LLM quota status, and seen job metrics\n\n` +
    `⚡ <b>FAST CONFIGURATION COMMANDS</b>\n` +
    `• <code>/location &lt;cities&gt;</code> — Set target search cities (e.g. <code>/location Toronto, Remote</code>)\n` +
    `• <code>/worktype &lt;mode&gt;</code> — Set arrangement (<code>Remote Only</code>, <code>Hybrid & Remote</code>, <code>Open to All</code>)\n` +
    `• <code>/roles &lt;titles&gt;</code> — Set target job titles (e.g. <code>/roles Data Analyst, BI Developer</code>)\n` +
    `• <code>/threshold &lt;score&gt;</code> — Set minimum match score (40–95, e.g. <code>/threshold 75</code>)\n` +
    `• <code>/freshness &lt;hours&gt;</code> — Set freshness window (1–168, e.g. <code>/freshness 24</code>)\n` +
    `• <code>/scope &lt;scope&gt;</code> — Set country scope (<code>CA</code>, <code>US</code>, <code>US_CA</code>, <code>GLOBAL</code>)\n` +
    `• <code>/cancel</code> — Reset or abort any ongoing onboarding/conversational dialog\n\n` +
    `💡 <i>You can also directly attach and send your resume file (.pdf or .docx) at any time to re-import!</i>\n\n` +
    `👇 <b>Quick Actions:</b> Tap a button below to run instantly:`;
}

function getHelpKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔍 Find Jobs Now', callback_data: 'TRIGGER_PIPELINE' },
        { text: '🤝 Find Recruiters', callback_data: 'PROMPT_RECRUITERS' }
      ],
      [
        { text: '👤 My Profile', callback_data: 'VIEW_PROFILE' },
        { text: '⚙️ Settings Dashboard', callback_data: 'SET_MENU:MAIN' }
      ],
      [
        { text: '📊 System Status', callback_data: 'VIEW_STATUS' },
        { text: '📑 Export Applied (.xlsx)', callback_data: 'EXPORT_JOBS' }
      ]
    ]
  };
}

function renderStatusMessage() {
  const dataDir = getDataDir();
  const profilePath = path.join(dataDir, 'profiles', 'master-profile.json');
  let prof = {};
  try { prof = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }

  const settings = settingsHelper.getSettings();

  let seenCount = 0;
  try {
    seenCount = getSeenJobsCount();
  } catch (e) { }

  let activeModel = 'gemini-3.8-flash';
  let callsToday = 0;
  try {
    const next = getNextWaterfallModel();
    activeModel = next ? next.id : 'Waterfall Active';
    const state = getLLMState();
    if (state && state[activeModel]) {
      callsToday = state[activeModel].calls_today || 0;
    }
  } catch (e) { }

  return `📊 <b>JOBRYT AI AGENT — SYSTEM & PIPELINE STATUS</b>\n\n` +
    `🟢 <b>System Health:</b> Operational & Ready\n` +
    `👤 <b>Active Candidate:</b> ${prof.name || 'Not Configured'}\n` +
    `🎯 <b>Target Roles:</b> ${(prof.target_titles || []).slice(0, 3).join(', ')}${(prof.target_titles || []).length > 3 ? '...' : ''}\n` +
    `📍 <b>Target Location:</b> ${(prof.locations || []).join(', ')} <i>(Scope: ${prof.country_scope || settings.country_scope || 'CA'})</i>\n` +
    `🏢 <b>Workplace Arrangement:</b> ${prof.work_type || settings.work_type || 'Open to All'}\n\n` +
    `⚙️ <b>Scoring Threshold:</b> <code>${settings.score_threshold}/100</code>\n` +
    `🕒 <b>Freshness Window:</b> <code>${settings.freshness_hours === 0 ? 'Disabled (Any Time)' : settings.freshness_hours + ' hours'}</code>\n` +
    `⏰ <b>Automation Schedule:</b> ${settings.cron_description || settings.cron_schedule} (<code>${settings.timezone || 'America/Toronto'}</code>)\n` +
    `🤖 <b>Active LLM Model:</b> <code>${activeModel}</code> (Today: ${callsToday} calls)\n` +
    `📦 <b>Total Seen Jobs Tracked:</b> <code>${seenCount} jobs</code>`;
}

// ── Main Polling Loop ───────────────────────────────────────────────────────
async function pollLoop() {
  await clearWebhook();
  console.log(`🚀 Telegram Real-Time Callback Bridge is ACTIVE!`);

  let offset = 0;
  let isRunning = true;

  process.on('SIGINT', () => { isRunning = false; process.exit(0); });

  while (isRunning) {
    try {
      const updates = await new Promise((resolve, reject) => {
        const req = https.get(
          `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["callback_query","message"]`,
          { timeout: 35000 },
          res => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
          }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });

      if (updates?.ok && Array.isArray(updates.result)) {
        for (const update of updates.result) {
          offset = update.update_id + 1;

          // 1. Handle Inline Button Clicks
          if (update.callback_query) {
            const cb = update.callback_query;
            const action = cb.data || 'Unknown';
            const senderId = cb.from?.id || cb.message?.chat?.id;

            if (!isAuthorizedSender(senderId)) {
              console.warn(`🛑 Unauthorized click from ${senderId}`);
              continue;
            }

            if (['TRIGGER_PIPELINE', 'FIND_JOBS', 'SCAN_NOW'].includes(action)) {
              await sendTelegramMessage(senderId, `🔍 <b>Job Scan Triggered manually!</b>\n\nEstimated time: ~60 seconds...`);
              const scriptPath = path.join(__dirname, '../engine/run-pipeline.js');
              cp.execFile('node', [scriptPath, String(senderId)], { env: process.env }, (err, stdout, stderr) => {
                if (err) {
                  console.error('❌ Pipeline manual execution error:', err.message, stderr);
                  sendTelegramMessage(senderId, `⚠️ <b>Job Scan Notice:</b> Scan encountered an error: ${err.message}`);
                } else {
                  console.log('✅ Pipeline manual scan finished successfully.');
                }
              });
              continue;
            }

            // Direct interception of Onboarding callbacks
            if (action.startsWith('ONBOARD_')) {
              const handled = await onboardingHandler.processUpdate(update);
              if (handled) continue;
            }

            // Direct interception of Settings callbacks
            if (action.startsWith('SET_MENU:') || action.startsWith('SET_VAL:')) {
              const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
              let prof = {};
              try { prof = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
              const resMenu = settingsHelper.handleSettingCallback(action, prof);
              await sendTelegramMessage(senderId, resMenu.text, resMenu.reply_markup);
              continue;
            }

            // Callback for View Help
            if (action === 'VIEW_HELP') {
              await sendTelegramMessage(senderId, renderHelpMessage(), getHelpKeyboard());
              continue;
            }

            // Callback for View Status
            if (action === 'VIEW_STATUS') {
              const statusText = renderStatusMessage();
              await sendTelegramMessage(senderId, statusText, {
                inline_keyboard: [
                  [{ text: '🔍 Find Jobs Now', callback_data: 'TRIGGER_PIPELINE' }],
                  [{ text: '⚙️ Settings Dashboard', callback_data: 'SET_MENU:MAIN' }],
                  [{ text: '📖 Help & Commands', callback_data: 'VIEW_HELP' }]
                ]
              });
              continue;
            }

            // Callback for Prompt Recruiters
            if (action === 'PROMPT_RECRUITERS') {
              await sendTelegramMessage(
                senderId,
                `🤝 <b>Find Recruiter & HR Contacts</b>\n\n` +
                `To look up live recruiters for any employer, type in chat:\n` +
                `👉 <code>/recruiters &lt;company&gt;</code>\n\n` +
                `<b>Examples:</b>\n` +
                `• <code>/recruiters Shopify</code>\n` +
                `• <code>/recruiters Google, Toronto</code>\n` +
                `• <code>/recruiters Amazon, Vancouver</code>\n\n` +
                `<i>Includes live Google X-Ray search, verified LinkedIn profiles, tailored connection notes, and pre-filled Gmail composer!</i>`
              );
              continue;
            }

            // Callback for Export Applied Jobs
            if (action === 'EXPORT_JOBS' || action === 'VIEW_APPLIED') {
              await sendTelegramMessage(
                senderId,
                `📊 <b>Generating Applied Jobs Spreadsheet...</b>\n\n<i>Querying application records from SQLite database (<code>data/tracking/jobs.db</code>) and compiling formatted Excel file (.xlsx)...</i>`
              );
              const exportScript = path.join(__dirname, '../admin/export-applied-jobs.js');
              cp.execFile('node', [exportScript, String(senderId)], { env: process.env }, (err, stdout, stderr) => {
                if (err) {
                  console.error('Export error:', err.message, stderr);
                  sendTelegramMessage(senderId, `⚠️ <b>Export Error:</b> Could not compile spreadsheet: ${err.message}`);
                }
              });
              continue;
            }

            // Direct interception of View Profile callback
            if (action === 'VIEW_PROFILE') {
              const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
              let currentProf = {};
              try { currentProf = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
              const totalBullets = (currentProf.experience || []).reduce((acc, exp) => acc + (exp.bullets ? exp.bullets.length : 0), 0);
              const summaryText = `👤 <b>MASTER PROFILE — ${currentProf.name || 'Candidate'}</b>\n\n` +
                `📧 <b>Email:</b> ${(currentProf.contact && currentProf.contact.email) || 'N/A'}\n` +
                `📞 <b>Phone:</b> ${(currentProf.contact && currentProf.contact.phone) || 'N/A'}\n` +
                `📍 <b>Target Locations:</b> ${(currentProf.locations || []).join(', ')} <i>(Scope: ${currentProf.country_scope || 'CA'})</i>\n` +
                `🏢 <b>Workplace Mode:</b> ${currentProf.work_type || 'Open to All'}\n` +
                `🎯 <b>Target Roles:</b> ${(currentProf.target_titles || []).join(', ')}\n` +
                `💼 <b>Experience:</b> ${(currentProf.experience || []).length} positions (${totalBullets} achievements)\n` +
                `🛠️ <b>Skills:</b> ${(currentProf.skills || []).length} indexed skills\n\n` +
                `💾 <b>Saved to:</b> <code>data/profiles/master-profile.json</code>`;

              await sendTelegramMessage(senderId, summaryText, {
                inline_keyboard: [
                  [{ text: '🔍 Find Jobs Now', callback_data: 'TRIGGER_PIPELINE' }],
                  [{ text: '⚙️ Settings Dashboard', callback_data: 'SET_MENU:MAIN' }],
                  [{ text: '📖 Help & Commands', callback_data: 'VIEW_HELP' }]
                ]
              });
              continue;
            }

            // Attach the stored job so n8n can still act if its own DB lookup misses.
            const jobMatch = action.match(/^(APPLY|REJECT):(.+)$/);
            if (jobMatch) {
              try {
                const record = findJobRecord(jobMatch[2].trim());
                if (record) update.job_record = record;
                else console.warn(`⚠️ No stored record for ${jobMatch[2]}; n8n will fall back to the card text.`);
              } catch (e) {
                console.error('Job lookup failed in bridge:', e.message);
              }
            }

            console.log(`📩 Forwarding action "${action}" to n8n...`);
            const status = await forwardToN8n(update);
            if (status !== 200) {
              console.error(`❌ n8n webhook returned ${status} for "${action}"`);
              await sendTelegramMessage(senderId, `⚠️ <b>Automation engine is restarting.</b> Please tap the button again in a few seconds.`);
            }
          }

          // 2. Handle Direct Messages (Commands & File Uploads)
          else if (update.message) {
            const msg = update.message;
            const senderId = msg.from?.id;

            if (!isAuthorizedSender(senderId)) {
              console.warn(`🛑 Unauthorized message from ${senderId}`);
              continue;
            }

            // Document Uploads (Resumes)
            if (msg.document) {
              const doc = msg.document;
              const ext = path.extname(doc.file_name || '').toLowerCase() || '.pdf';

              const maxUploadMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '5', 10);
              const maxUploadBytes = maxUploadMb * 1024 * 1024;

              if (!['.pdf', '.docx', '.txt', '.json'].includes(ext)) {
                await sendTelegramMessage(senderId, `⚠️ <b>Unsupported File Type:</b> <code>${ext || 'unknown'}</code>\n\nPlease attach a valid <code>.pdf</code>, <code>.docx</code>, <code>.txt</code>, or <code>.json</code> document.`);
                continue;
              }

              if (doc.file_size && doc.file_size > maxUploadBytes) {
                const fileSizeMb = (doc.file_size / (1024 * 1024)).toFixed(1);
                await sendTelegramMessage(senderId, `⚠️ <b>File Too Large:</b> Upload rejected.\n\nYour file is <b>${fileSizeMb} MB</b>, but the maximum allowed upload limit is <b>${maxUploadMb} MB</b>.`);
                continue;
              }

              const dataDir = getDataDir();
              const cacheDir = path.join(dataDir, 'cache');
              if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

              // When a user uploads a resume, delete any previous temp resume files in cache
              try {
                const existingFiles = fs.readdirSync(cacheDir);
                for (const ef of existingFiles) {
                  if (ef.startsWith('uploaded_doc.') || ef.startsWith('uploaded_resume.') || ef.startsWith('resume.')) {
                    try { fs.unlinkSync(path.join(cacheDir, ef)); } catch (_) { }
                  }
                }
              } catch (_) { }

              const tempPath = path.join(cacheDir, `uploaded_doc${ext}`);

              // Download from Telegram -> temp cache path (deleted after parsing into JSON)
              await downloadFile(doc.file_id, tempPath);

              if (ext === '.json') {
                const targetProfile = path.join(dataDir, 'profiles', 'master-profile.json');
                fs.mkdirSync(path.dirname(targetProfile), { recursive: true });
                fs.copyFileSync(tempPath, targetProfile);
                try { fs.unlinkSync(tempPath); } catch (_) { }
                await sendTelegramMessage(senderId, `✅ Master profile updated via JSON.`);
              } else {
                onboardingHandler.startOnboarding(tempPath, senderId).catch(err => {
                  console.error('Error starting onboarding:', err);
                });
              }
              continue;
            }

            // Text Commands
            const text = (msg.text || '').trim();
            const cmd = text.split(/\s+/)[0].toLowerCase();

            // Check if user is in middle of interactive onboarding interview
            const activeOnboardState = onboardingHandler.getActiveState(senderId);
            if (activeOnboardState && !['/find-jobs', '/scan', '/help', '/start', '/cancel'].includes(cmd)) {
              const handled = await onboardingHandler.processUpdate(update);
              if (handled) continue;
            }

            // Help & Start Commands
            if (['/help', '/start', '/commands', '/info'].includes(cmd)) {
              await sendTelegramMessage(senderId, renderHelpMessage(), getHelpKeyboard());
              continue;
            }

            // Status Command
            if (['/status', '/stats', '/health'].includes(cmd)) {
              const statusText = renderStatusMessage();
              await sendTelegramMessage(senderId, statusText, {
                inline_keyboard: [
                  [{ text: '🔍 Find Jobs Now', callback_data: 'TRIGGER_PIPELINE' }],
                  [{ text: '⚙️ Settings Dashboard', callback_data: 'SET_MENU:MAIN' }],
                  [{ text: '📖 Help & Commands', callback_data: 'VIEW_HELP' }]
                ]
              });
              continue;
            }

            // Cancel / Reset Command
            if (['/cancel', '/reset', '/abort'].includes(cmd)) {
              onboardingHandler.setActiveState(senderId, null);
              await sendTelegramMessage(senderId, `✅ <b>Active dialog/onboarding reset.</b> All previous settings and master profile remain intact.`);
              continue;
            }

            // Resume Import
            if (cmd === '/import-resume' || text.startsWith('/import-resume')) {
              onboardingHandler.setActiveState(senderId, { action: 'AWAIT_RESUME_FILE' });
              await sendTelegramMessage(
                senderId,
                `📑 <b>Import Resume to Master Profile</b>\n\n` +
                `✨ I will extract all verified career history, achievements, and skills with zero fabrication.\n\n` +
                `📥 <b>Please attach and send your resume document</b> (<code>.docx</code>, <code>.pdf</code>, or <code>.txt</code>) directly in this chat!\n\n` +
                `<i>(Type <code>/cancel</code> anytime to abort)</i>`
              );
              continue;
            }

            // Quick Configuration: Locations
            if (text.startsWith('/location')) {
              const locs = text.replace(/^\/location\s*/i, '').split(',').map(s => s.trim()).filter(Boolean);
              if (locs.length > 0) {
                const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
                let profile = {};
                try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
                profile.locations = locs;
                fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
                await sendTelegramMessage(senderId, `✅ <b>Target Locations Updated!</b>\n\nThe Multi-Board Scraper and LLM will now strictly route for:\n- ${locs.join('\n- ')}`);
              } else {
                await sendTelegramMessage(senderId, `⚠️ <b>Format Error</b>\nPlease use: <code>/location Toronto, Vancouver, Remote</code>`);
              }
              continue;
            }

            // Quick Configuration: Work Type
            if (text.startsWith('/worktype')) {
              const wt = text.replace(/^\/worktype\s*/i, '').trim();
              if (wt) {
                const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
                let profile = {};
                try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
                profile.work_type = wt;
                fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
                settingsHelper.updateSettings({ work_type: wt });
                await sendTelegramMessage(senderId, `✅ <b>Work Arrangement Updated!</b>\n\nNow set to: <b>${wt}</b>`);
              } else {
                await sendTelegramMessage(senderId, `⚠️ <b>Format Error</b>\nPlease use: <code>/worktype Remote Only</code> or <code>/worktype Hybrid & Remote</code>`);
              }
              continue;
            }

            // Quick Configuration: Target Roles
            if (text.startsWith('/roles') || text.startsWith('/titles')) {
              const rawRoles = text.replace(/^\/(roles|titles)\s*/i, '').split(/[,;]+/).map(s => s.trim()).filter(Boolean);
              if (rawRoles.length > 0) {
                const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
                let profile = {};
                try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
                profile.target_titles = rawRoles;
                fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
                await sendTelegramMessage(senderId, `✅ <b>Target Roles Updated!</b>\n\nMulti-role sweep will now search for:\n- ${rawRoles.join('\n- ')}`);
              } else {
                await sendTelegramMessage(senderId, `⚠️ <b>Format Error</b>\nPlease use: <code>/roles Data Analyst, BI Developer, Power BI Analyst</code>`);
              }
              continue;
            }

            // Quick Configuration: Match Threshold
            if (text.startsWith('/threshold') || text.startsWith('/score')) {
              const rawNum = parseInt(text.replace(/^\/(threshold|score)\s*/i, '').trim(), 10);
              if (!isNaN(rawNum) && rawNum >= 40 && rawNum <= 95) {
                settingsHelper.updateSettings({ score_threshold: rawNum });
                await sendTelegramMessage(senderId, `✅ <b>Score Gate Threshold Updated!</b>\n\nMinimum match score required for notifications: <b>${rawNum}/100</b>`);
              } else {
                await sendTelegramMessage(senderId, `⚠️ <b>Format Error</b>\nPlease provide a score between 40 and 95 (e.g. <code>/threshold 75</code>).`);
              }
              continue;
            }

            // Quick Configuration: Freshness Window
            if (text.startsWith('/freshness') || text.startsWith('/hours')) {
              const arg = text.replace(/^\/(freshness|hours)\s*/i, '').trim().toLowerCase();
              if (['0', 'off', 'none', 'disable', 'disabled', 'all', 'any'].includes(arg)) {
                settingsHelper.updateSettings({ freshness_hours: 0 });
                await sendTelegramMessage(senderId, `✅ <b>Freshness Filter Disabled!</b>\n\nJobs of any age / publication date will now be evaluated (no freshness cutoff).`);
              } else {
                const rawHours = parseInt(arg, 10);
                if (!isNaN(rawHours) && rawHours >= 1 && rawHours <= 720) {
                  settingsHelper.updateSettings({ freshness_hours: rawHours });
                  await sendTelegramMessage(senderId, `✅ <b>Freshness Window Updated!</b>\n\nOnly jobs posted within the last <b>${rawHours} hours</b> will be evaluated.`);
                } else {
                  await sendTelegramMessage(senderId, `⚠️ <b>Format Error</b>\nPlease provide hours between 1 and 720 (e.g. <code>/freshness 24</code>), or send <code>/freshness off</code> to disable.`);
                }
              }
              continue;
            }

            // Quick Configuration: Country Scope
            if (text.startsWith('/scope')) {
              const sc = text.replace(/^\/scope\s*/i, '').trim().toUpperCase();
              if (['CA', 'US', 'US_CA', 'GLOBAL', 'AUTO'].includes(sc)) {
                const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
                let profile = {};
                try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
                profile.country_scope = sc;
                fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
                settingsHelper.updateSettings({ country_scope: sc });
                await sendTelegramMessage(senderId, `✅ <b>Country Scope Updated!</b>\n\nJob board routing is now strictly locked to: <b>${sc}</b>`);
              } else {
                await sendTelegramMessage(senderId, `⚠️ <b>Format Error</b>\nAllowed scopes: <code>CA</code>, <code>US</code>, <code>US_CA</code>, <code>GLOBAL</code>, <code>AUTO</code> (e.g. <code>/scope CA</code>).`);
              }
              continue;
            }

            // Quick Configuration: Timezone
            if (text.startsWith('/timezone') || text.startsWith('/tz')) {
              const rawTz = text.replace(/^\/(timezone|tz)\s*/i, '').trim();
              if (rawTz) {
                try {
                  Intl.DateTimeFormat(undefined, { timeZone: rawTz });
                  const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
                  let profile = {};
                  try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
                  profile.timezone = rawTz;
                  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
                  settingsHelper.updateSettings({ timezone: rawTz });
                  await sendTelegramMessage(senderId, `✅ <b>Candidate Timezone Updated!</b>\n\nAutomation schedule and daily sweeps are now scheduled for:\n<b>${rawTz}</b> <i>(Saved to master-profile.json)</i>`);
                } catch (_) {
                  await sendTelegramMessage(senderId, `⚠️ <b>Invalid Timezone</b>\nPlease provide a valid IANA timezone (e.g. <code>/timezone America/Toronto</code>, <code>/timezone America/Vancouver</code>, <code>/timezone America/New_York</code>).`);
                }
              } else {
                const currentTz = settingsHelper.getSettings().timezone || 'America/Toronto';
                await sendTelegramMessage(senderId, `🕒 <b>Current Timezone:</b> <code>${currentTz}</code>\n\nTo update, send: <code>/timezone America/Vancouver</code> or <code>/timezone America/New_York</code>`);
              }
              continue;
            }

            if (['/settings', '/preferences', '/config'].includes(cmd)) {
              const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
              let prof = {};
              try { prof = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
              const resMenu = settingsHelper.renderSettingsDashboard(settingsHelper.getSettings(), prof);
              await sendTelegramMessage(senderId, resMenu.text, resMenu.reply_markup);
              continue;
            }

            if (['/profile', '/view-profile', '/myprofile'].includes(cmd)) {
              const profilePath = path.join(__dirname, '../../data/profiles/master-profile.json');
              let currentProf = {};
              try { currentProf = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) { }
              const totalBullets = (currentProf.experience || []).reduce((acc, exp) => acc + (exp.bullets ? exp.bullets.length : 0), 0);
              const summaryText = `👤 <b>MASTER PROFILE — ${currentProf.name || 'Candidate'}</b>\n\n` +
                `📧 <b>Email:</b> ${(currentProf.contact && currentProf.contact.email) || 'N/A'}\n` +
                `📞 <b>Phone:</b> ${(currentProf.contact && currentProf.contact.phone) || 'N/A'}\n` +
                `📍 <b>Target Locations:</b> ${(currentProf.locations || []).join(', ')} <i>(Scope: ${currentProf.country_scope || 'CA'})</i>\n` +
                `🏢 <b>Workplace Mode:</b> ${currentProf.work_type || 'Open to All'}\n` +
                `🎯 <b>Target Roles:</b> ${(currentProf.target_titles || []).join(', ')}\n` +
                `💼 <b>Experience:</b> ${(currentProf.experience || []).length} positions (${totalBullets} achievements)\n` +
                `🛠️ <b>Skills:</b> ${(currentProf.skills || []).length} indexed skills\n\n` +
                `💾 <b>Saved to:</b> <code>data/profiles/master-profile.json</code>`;

              await sendTelegramMessage(senderId, summaryText, {
                inline_keyboard: [
                  [{ text: '🔍 Find Jobs Now', callback_data: 'TRIGGER_PIPELINE' }],
                  [{ text: '⚙️ Settings Dashboard', callback_data: 'SET_MENU:MAIN' }],
                  [{ text: '📖 Help & Commands', callback_data: 'VIEW_HELP' }]
                ]
              });
              continue;
            }

            if (['/find-jobs', '/findjobs', '/find_jobs', '/scan', '/jobs', '/search', '/fetch'].includes(cmd)) {
              await sendTelegramMessage(senderId, `🔍 <b>Job Scan Triggered manually!</b>\n\nEstimated time: ~60 seconds...`);
              const scriptPath = path.join(__dirname, '../engine/run-pipeline.js');
              cp.execFile('node', [scriptPath, String(senderId)], { env: process.env }, (err, stdout, stderr) => {
                if (err) {
                  console.error('❌ Pipeline manual execution error:', err.message, stderr);
                  sendTelegramMessage(senderId, `⚠️ <b>Job Scan Notice:</b> Scan encountered an error: ${err.message}`);
                } else {
                  console.log('✅ Pipeline manual scan finished successfully.');
                }
              });
              continue;
            }

            if (['/recruiters', '/recruiter', '/contacts', '/hr'].includes(cmd)) {
              const compArg = text.replace(/^\/(recruiters|recruiter|contacts|hr)\s*/i, '').trim();
              if (!compArg) {
                await sendTelegramMessage(
                  senderId,
                  `🤝 <b>Recruiter & Hiring Team Finder</b>\n\n` +
                  `Please specify the target company name:\n` +
                  `👉 <code>/recruiters Shopify</code>\n` +
                  `👉 <code>/recruiters Google, Toronto</code>\n` +
                  `👉 <code>/recruiters Amazon, Vancouver</code>\n\n` +
                  `<i>Includes live Google X-Ray query, LinkedIn recruiter links, tailored connection notes, and pre-filled Gmail composer.</i>`
                );
                continue;
              }
              // Company provided -> forward to n8n to execute Find Recruiters node
              await forwardToN8n(update);
              continue;
            }

            if (['/export', '/export-jobs', '/export_jobs', '/applied', '/applications'].includes(cmd) || text.toLowerCase().startsWith('/export jobs')) {
              await sendTelegramMessage(
                senderId,
                `📊 <b>Generating Applied Jobs Spreadsheet...</b>\n\n<i>Querying application records from SQLite database (<code>data/tracking/jobs.db</code>) and compiling formatted Excel file (.xlsx)...</i>`
              );
              const exportScript = path.join(__dirname, '../admin/export-applied-jobs.js');
              cp.execFile('node', [exportScript, String(senderId)], { env: process.env }, (err, stdout, stderr) => {
                if (err) {
                  console.error('Export error:', err.message, stderr);
                  sendTelegramMessage(senderId, `⚠️ <b>Export Error:</b> Could not compile spreadsheet: ${err.message}`);
                }
              });
              continue;
            }

            // Forward text messages to n8n
            await forwardToN8n(update);
          }
        }
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

pollLoop().catch(e => console.error('Fatal bridge error:', e));
