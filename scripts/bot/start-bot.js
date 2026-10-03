/**
 * start-bot.js — Turnkey Bot Launcher
 *
 * PURPOSE:
 *   One-command launcher that brings up the entire JobRyt AI Agent stack:
 *   n8n workflow engine + Telegram polling bridge, running in Docker.
 *
 * WHAT IT DOES:
 *   1. Loads environment variables from .env
 *   2. Auto-creates missing data files (seen_jobs.json, etc.)
 *   3. Starts Docker Compose (n8n + telegram-bridge containers)
 *   4. Streams live logs from the Telegram bridge container
 *
 * USAGE:
 *   npm start
 *   # or: node scripts/start-bot.js
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../core/load-env');

// ── Step 1: Load environment configuration ──────────────────────────────────
const rootDir = path.join(__dirname, '..');
loadEnv();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const geminiKey = process.env.GEMINI_API_KEY;
const n8nPort = process.env.N8N_PORT || '5678';
const activeEnv = process.env.ENV_FILE || process.env.NODE_ENV || 'local';

// Warn about missing critical env vars (but don't crash)
if (!botToken || !chatId || !geminiKey) {
  console.warn('⚠️ WARNING: Core API keys appear to be missing in .env:');
  if (!botToken) console.warn('   - TELEGRAM_BOT_TOKEN is missing');
  if (!chatId) console.warn('   - TELEGRAM_CHAT_ID is missing');
  if (!geminiKey) console.warn('   - GEMINI_API_KEY is missing');
  console.warn('Please fill them in .env for full pipeline automation.\n');
}

// ── Step 2: Auto-provision directories and state files ──────────────────────
const dataDir = process.env.DATA_DIR
  ? path.resolve(rootDir, process.env.DATA_DIR)
  : path.join(rootDir, 'data');
const promptsDir = process.env.PROMPTS_DIR
  ? path.resolve(rootDir, process.env.PROMPTS_DIR)
  : path.join(rootDir, 'prompts');

// Create directories if they don't exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(promptsDir)) fs.mkdirSync(promptsDir, { recursive: true });

// Initialize empty state files that the pipeline needs
const DEFAULT_STATE_FILES = [
  { name: 'seen_jobs.json', content: '[]' },
  { name: 'pending_approval.json', content: '[]' },
  { name: 'logged_jobs.json', content: '[]' },
  { name: 'rejected_jobs.json', content: '[]' },
  { name: 'qualified_jobs.json', content: '[]' },
  { name: 'processed_jobs.json', content: '[]' },
  { name: 'adzuna_role_idx.json', content: JSON.stringify({ idx: 0 }, null, 2) },
  { name: 'dashboard.csv', content: 'Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills\n' },
];

for (const file of DEFAULT_STATE_FILES) {
  const filePath = path.join(dataDir, file.name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, file.content, 'utf8');
    console.log(`✨ [Auto-Init] Created missing state file: data/${file.name}`);
  }
}

// Create master-profile.json if it doesn't exist
const profilePath = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json');
const exampleProfilePath = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.example.json');

if (!fs.existsSync(profilePath)) {
  if (fs.existsSync(exampleProfilePath)) {
    // Copy from example template
    fs.copyFileSync(exampleProfilePath, profilePath);
    console.log('✨ [Auto-Init] Created data/profiles/master-profile.json from template.');
  } else {
    // Create a minimal starter profile
    fs.writeFileSync(profilePath, JSON.stringify({
      name: 'Candidate Name',
      target_titles: ['Target Role'],
      locations: ['Primary Location', 'Remote'],
      skills: ['Core Competency 1', 'Core Competency 2'],
      experience: [],
    }, null, 2));
    console.log('✨ [Auto-Init] Created starter data/profiles/master-profile.json.');
  }
  console.log('💡 Edit data/profiles/master-profile.json or run "npm run parse-resume <resume.pdf>" to load your experience.\n');
}

// ── Step 3: Detect and start Docker Compose ─────────────────────────────────
let composeCmd = 'docker compose';
try {
  execSync('docker compose version', { stdio: 'ignore' });
} catch (_) {
  try {
    execSync('docker-compose version', { stdio: 'ignore' });
    composeCmd = 'docker-compose';
  } catch (_) {
    console.error('❌ ERROR: Docker or Docker Compose is not installed/running!');
    console.error('Please ensure Docker Desktop (or docker-ce) is running.\n');
    process.exit(1);
  }
}

console.log(`\n🐳 Starting containers via: ${composeCmd} up -d ...`);
try {
  execSync(`${composeCmd} up -d`, { cwd: rootDir, stdio: 'inherit' });
} catch (err) {
  console.error('❌ Failed to launch Docker containers:', err.message);
  process.exit(1);
}

// ── Step 3.5: Turnkey Auto-Provisioning & Database Sync ────────────────────
console.log('🔄 Checking n8n container dependencies & workflow database sync...');
try {
  // Wait a few seconds for n8n container to respond
  let isReady = false;
  for (let i = 0; i < 15; i++) {
    try {
      execSync(`${composeCmd} exec -T n8n node -e "require('node:sqlite');"`, { cwd: rootDir, stdio: 'ignore' });
      isReady = true;
      break;
    } catch (_) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }

  if (isReady) {
    // 1. Ensure required NPM packages (xlsx, pdfkit) exist inside container
    try {
      execSync(
        `${composeCmd} exec -T n8n sh -c "if [ ! -d /home/node/.n8n/node_modules/xlsx ] || [ ! -d /home/node/.n8n/node_modules/pdfkit ]; then echo '📦 Installing container dependencies (xlsx, pdfkit)...' && cd /home/node/.n8n && npm install --no-audit --no-fund xlsx pdfkit; fi"`,
        { cwd: rootDir, stdio: 'inherit' }
      );
    } catch (e) {
      console.warn('⚠️ Dependency auto-install check completed with note:', e.message);
    }

    // 2. Automatically sync master workflow and webhooks into n8n SQLite database
    try {
      execSync(`${composeCmd} exec -T n8n node /scripts/admin/sync-n8n-db.js`, { cwd: rootDir, stdio: 'inherit' });
    } catch (e) {
      console.warn('⚠️ n8n database sync check:', e.message);
    }
  }
} catch (provisionErr) {
  console.warn('⚠️ Auto-provisioning note:', provisionErr.message);
}

// ── Step 4: Print status and stream logs ────────────────────────────────────
console.log('\n================================================================');
console.log(`🚀 JOBRYT AI AGENT IS ACTIVE & RUNNING [ENV: ${activeEnv}]`);
console.log('================================================================');
console.log(`🖥️  n8n Editor UI       : http://localhost:${n8nPort}`);
console.log(`📱 Telegram Chat ID    : ${chatId || 'Not configured'}`);
console.log('⚡ Telegram Integration : Built-in Docker Callback Bridge (24/7)');
console.log('================================================================');
console.log('💡 Live Telegram Bridge Logs (Press Ctrl+C to stop; Docker stays running):\n');

// Stream live logs from the telegram-bridge container
const parts = composeCmd.split(' ');
const logProc = spawn(parts[0], [...parts.slice(1), 'logs', '-f', 'telegram-bridge'], {
  cwd: rootDir,
  stdio: 'inherit',
});

// Clean shutdown on Ctrl+C
process.on('SIGINT', () => { logProc.kill(); process.exit(0); });
process.on('SIGTERM', () => { logProc.kill(); process.exit(0); });
