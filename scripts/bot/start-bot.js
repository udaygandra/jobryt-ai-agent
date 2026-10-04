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
const rootDir = path.resolve(__dirname, '..', '..');
loadEnv();

// Auto-generate or sanitize N8N_ENCRYPTION_KEY if missing or default placeholder
let encryptionKey = (process.env.N8N_ENCRYPTION_KEY || '').trim();
if (!encryptionKey || encryptionKey === 'your_32_char_encryption_key' || encryptionKey.length < 16) {
  const crypto = require('crypto');
  encryptionKey = crypto.randomBytes(16).toString('hex');
  process.env.N8N_ENCRYPTION_KEY = encryptionKey;

  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.includes('N8N_ENCRYPTION_KEY=')) {
        envContent = envContent.replace(/^N8N_ENCRYPTION_KEY=.*$/m, `N8N_ENCRYPTION_KEY=${encryptionKey}`);
      } else {
        envContent += `\nN8N_ENCRYPTION_KEY=${encryptionKey}\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('✨ [Auto-Config] Generated secure 32-character N8N_ENCRYPTION_KEY in .env');
    } catch (_) {}
  }
}

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

// Initialize state files (tracking database is managed automatically by jobs-db.js)
const DEFAULT_STATE_FILES = [
  { name: 'cache/adzuna_role_idx.json', content: JSON.stringify({ idx: 0 }, null, 2) },
  { name: 'tracking/dashboard.csv', content: 'Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills\n' },
];

for (const file of DEFAULT_STATE_FILES) {
  const filePath = path.join(dataDir, file.name);
  const fileParent = path.dirname(filePath);
  if (!fs.existsSync(fileParent)) fs.mkdirSync(fileParent, { recursive: true });
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

const envFile = process.env.ENV_FILE || '.env';
const isProdMode = process.env.NODE_ENV === 'production' || envFile.includes('.env.prod');
// Separate project names keep local and prod n8n volumes (and their encryption keys) isolated.
const projectName = isProdMode ? 'jobryt-prod' : 'jobryt-public';
const composeFiles = (isProdMode && fs.existsSync(path.join(rootDir, 'docker-compose.prod.yml')))
  ? `-p ${projectName} --env-file ${envFile} -f docker-compose.yml -f docker-compose.prod.yml`
  : `-p ${projectName} --env-file ${envFile} -f docker-compose.yml`;
const dc = `${composeCmd} ${composeFiles}`;

console.log(`\n🐳 Starting containers via: ${dc} up -d ...`);
try {
  execSync(`${dc} up -d`, { cwd: rootDir, stdio: 'inherit' });
} catch (err) {
  console.error('❌ Failed to launch Docker containers:', err.message);
  process.exit(1);
}

// ── Step 3.5: Turnkey Auto-Provisioning & Database Sync ────────────────────
console.log('🔄 Checking n8n container dependencies & workflow database sync...');
try {
  // Wait for n8n container to create and initialize database.sqlite
  let isReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      // Inspect docker container status for restart loops / key mismatch crashes
      const inspectState = execSync(`${dc} ps n8n --format json`, { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      if (inspectState.includes('"Restarting"') || inspectState.includes('Restarting (')) {
        const logs = execSync(`${dc} logs --tail 20 n8n`, { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        if (logs.includes('Mismatching encryption keys') || logs.includes('Failed to load command')) {
          console.warn('⚠️ [Auto-Recovery] Detected stale n8n encryption key mismatch. Resetting container volume...');
          execSync(`${dc} down -v`, { cwd: rootDir, stdio: 'ignore' });
          execSync(`${dc} up -d`, { cwd: rootDir, stdio: 'ignore' });
        }
      }

      execSync(`${dc} exec -T n8n node -e "const fs = require('fs'); if (!fs.existsSync('/home/node/.n8n/database.sqlite')) process.exit(1);"`, { cwd: rootDir, stdio: 'ignore' });
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
        `${dc} exec -T n8n sh -c "if [ ! -d /home/node/.n8n/node_modules/xlsx ] || [ ! -d /home/node/.n8n/node_modules/pdfkit ]; then echo '📦 Installing container dependencies (xlsx, pdfkit)...' && cd /home/node/.n8n && npm install --no-audit --no-fund xlsx pdfkit; fi"`,
        { cwd: rootDir, stdio: 'inherit' }
      );
    } catch (e) {
      console.warn('⚠️ Dependency auto-install check completed with note:', e.message);
    }

    // 2. Automatically sync master workflow and webhooks into n8n SQLite database
    try {
      let synced = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          execSync(`${dc} exec -T n8n node /scripts/admin/sync-n8n-db.js`, { cwd: rootDir, stdio: 'inherit' });
          synced = true;
          break;
        } catch (_) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
      }
      if (synced) {
        // Restart n8n container once so in-memory webhook listeners reload from SQLite
        execSync(`${dc} restart n8n`, { cwd: rootDir, stdio: 'ignore' });
        console.log('🔄 Waiting for n8n webhook listener to become active...');
      }
      
      // Verification loop: Ensure webhook route responds before declaring ready
      let webhookLive = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const testRes = execSync(
            `${dc} exec -T telegram-bridge node -e "fetch('http://n8n:5678/webhook/telegram-callback', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'PING'})}).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1));"`,
            { cwd: rootDir, stdio: 'ignore' }
          );
          webhookLive = true;
          break;
        } catch (_) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
      }
      if (webhookLive) {
        console.log('✅ n8n workflow & webhooks verified active & ready.');
      } else {
        console.warn('⚠️ Webhook listener took longer than expected to bind, will retry automatically on first action.');
      }
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
const parts = dc.split(' ');
const logProc = spawn(parts[0], [...parts.slice(1), 'logs', '-f', 'telegram-bridge'], {
  cwd: rootDir,
  stdio: 'inherit',
});

// Clean shutdown on Ctrl+C
process.on('SIGINT', () => { logProc.kill(); process.exit(0); });
process.on('SIGTERM', () => { logProc.kill(); process.exit(0); });
