#!/usr/bin/env node
/**
 * setup-wizard.js — Interactive 60-Second Setup Wizard for Jobryt AI Agent
 *
 * PURPOSE:
 *   Guides non-technical users through the setup process step-by-step.
 *   Auto-generates encryption keys, provides 1-click links for API tokens,
 *   and writes a production-ready .env configuration file automatically.
 *
 * USAGE:
 *   npm run setup
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const envPath = path.resolve(__dirname, '..', '..', '.env');
const examplePath = path.resolve(__dirname, '..', '..', '.env.example');

// Parse existing .env if present
const existingEnv = {};
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      existingEnv[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question, defaultValue = '') {
  return new Promise(resolve => {
    const prompt = defaultValue ? `${question} [Default: ${defaultValue}]: ` : `${question}: `;
    rl.question(prompt, answer => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function runWizard() {
  console.log('\n' + '='.repeat(70));
  console.log('🤖  JOBRYT AI AGENT — 60-SECOND INTERACTIVE SETUP WIZARD');
  console.log('='.repeat(70));
  console.log('This wizard will guide you through setting up your bot in simple steps.\n');

  // 1. Auto-generate or preserve N8N_ENCRYPTION_KEY
  const currentKey = existingEnv.N8N_ENCRYPTION_KEY || crypto.randomBytes(16).toString('hex');

  // 2. Telegram Bot Token
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log('📱 STEP 1 of 5: Telegram Bot Token (Required)');
  console.log('   1. Open the Telegram app on your phone or desktop.');
  console.log('   2. In the search bar, search for: @BotFather');
  console.log('   3. Send the command: /newbot');
  console.log('   4. Choose a name and a username for your bot.');
  console.log('   5. BotFather will reply with an API token (e.g. 123456789:ABCdefGh...).');
  console.log('──────────────────────────────────────────────────────────────────────');
  const botToken = await ask('Paste your Telegram Bot Token', existingEnv.TELEGRAM_BOT_TOKEN || '');

  // 3. Telegram Chat ID
  console.log('\n──────────────────────────────────────────────────────────────────────');
  console.log('👤 STEP 2 of 5: Your Telegram Chat ID (Required)');
  console.log('   1. In Telegram, search for: @userinfobot');
  console.log('   2. Tap "Start" or send "hi".');
  console.log('   3. It will immediately reply with your numeric "Id" (e.g. 123456789).');
  console.log('   (This locks the bot strictly to YOU so no stranger can access it)');
  console.log('──────────────────────────────────────────────────────────────────────');
  const chatId = await ask('Paste your Telegram Chat ID', existingEnv.TELEGRAM_CHAT_ID || '');

  // 4. Google Gemini API Key
  console.log('\n──────────────────────────────────────────────────────────────────────');
  console.log('🧠 STEP 3 of 5: Google Gemini API Key (Required - 100% Free)');
  console.log('   1. Open in your browser: https://aistudio.google.com/app/apikey');
  console.log('   2. Sign in with any free Google account.');
  console.log('   3. Click "Create API Key" and copy the key (starts with AIzaSy...).');
  console.log('──────────────────────────────────────────────────────────────────────');
  const geminiKey = await ask('Paste your Gemini API Key', existingEnv.GEMINI_API_KEY || '');

  // 5. Optional Adzuna API
  console.log('\n──────────────────────────────────────────────────────────────────────');
  console.log('💼 STEP 4 of 5: Job Board API Keys (Optional)');
  console.log('   Note: LinkedIn, Canada Job Bank, Jobicy, Remotive, Himalayas, and');
  console.log('   ArbeitNow work immediately with $0 cost and NO API keys.');
  console.log('   If you have a free Adzuna developer account, enter your keys below.');
  console.log('   (Press Enter to skip if you do not have one yet).');
  console.log('──────────────────────────────────────────────────────────────────────');
  const adzunaId = await ask('Adzuna App ID (optional)', existingEnv.ADZUNA_APP_ID || '');
  const adzunaKey = await ask('Adzuna App Key (optional)', existingEnv.ADZUNA_APP_KEY || '');
  const usajobsKey = await ask('USAJOBS Federal API Key (optional - US Federal jobs)', existingEnv.USAJOBS_API_KEY || '');

  // 6. Recruiter Outreach Keys
  console.log('\n──────────────────────────────────────────────────────────────────────');
  console.log('🤝 STEP 5 of 5: Recruiter & Hiring Outreach (Optional)');
  console.log('   Note: If skipped, or if your API key is invalid/stale/expired, the bot');
  console.log('   automatically and seamlessly falls back to 1-Tap Google X-Ray Search');
  console.log('   with $0 cost, zero API keys required, and zero interruptions.');
  console.log('   • Serper API (google.serper.dev - free 2,500 Google searches)');
  console.log('   • Hunter.io (hunter.io - free 25 HR email searches/month)');
  console.log('   (Press Enter to skip if you do not have them or prefer Google Search).');
  console.log('──────────────────────────────────────────────────────────────────────');
  const serperKey = await ask('Serper API Key (optional - Google search for recruiters)', existingEnv.SERPER_API_KEY || '');
  const hunterKey = await ask('Hunter API Key (optional - HR email discovery)', existingEnv.HUNTER_API_KEY || '');

  // Build pristine .env content
  const envContent = `# Mandatory

# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=${botToken}
# Authorized Telegram chat ID from @userinfobot
TELEGRAM_CHAT_ID=${chatId}
# Google Gemini API key
GEMINI_API_KEY=${geminiKey}
# AI Provider
LLM_PROVIDER=${existingEnv.LLM_PROVIDER || 'gemini'}
# n8n Database Encryption Key (Auto-Generated)
N8N_ENCRYPTION_KEY=${currentKey}
# n8n Dashboard Port & Binding
N8N_PORT=${existingEnv.N8N_PORT || '5678'}
N8N_HOST_BINDING=${existingEnv.N8N_HOST_BINDING || '127.0.0.1'}
N8N_WORKFLOW_ID=${existingEnv.N8N_WORKFLOW_ID || 'master-bot'}
# n8n Dashboard Authentication
N8N_BASIC_AUTH_ACTIVE=${existingEnv.N8N_BASIC_AUTH_ACTIVE || 'false'}
N8N_BASIC_AUTH_USER=${existingEnv.N8N_BASIC_AUTH_USER || 'admin@local.dev'}
N8N_BASIC_AUTH_PASSWORD=${existingEnv.N8N_BASIC_AUTH_PASSWORD || crypto.randomBytes(8).toString('hex')}
# Adzuna API Credentials
ADZUNA_APP_ID=${adzunaId}
ADZUNA_APP_KEY=${adzunaKey}
# USAJOBS Federal API Key
USAJOBS_API_KEY=${usajobsKey}
# SMTP Email Credentials (Workflow 3)
SMTP_HOST=${existingEnv.SMTP_HOST || 'smtp.gmail.com'}
SMTP_PORT=${existingEnv.SMTP_PORT || '465'}
SMTP_USER=${existingEnv.SMTP_USER || ''}
SMTP_PASSWORD=${existingEnv.SMTP_PASSWORD || ''}
# Internal Project Directories
DATA_DIR=${existingEnv.DATA_DIR || './data'}
SCRIPTS_DIR=${existingEnv.SCRIPTS_DIR || './scripts'}
PROMPTS_DIR=${existingEnv.PROMPTS_DIR || './prompts'}
WORKFLOWS_DIR=${existingEnv.WORKFLOWS_DIR || './workflows'}
# Telegram Webhook Routing
TELEGRAM_WEBHOOK_PATH=${existingEnv.TELEGRAM_WEBHOOK_PATH || 'telegram-callback'}
TELEGRAM_WEBHOOK_ID=${existingEnv.TELEGRAM_WEBHOOK_ID || 'e6a4b123-5e6f-7a8b-9c0d-1e2f3a4b5c6d'}

# Optional

ADZUNA_COUNTRY=${existingEnv.ADZUNA_COUNTRY || 'ca'}
MIN_SCORE_THRESHOLD=${existingEnv.MIN_SCORE_THRESHOLD || '60'}
MAX_UPLOAD_SIZE_MB=${existingEnv.MAX_UPLOAD_SIZE_MB || '5'}
TIMEZONE=${existingEnv.TIMEZONE || 'America/Toronto'}
ADZUNA_SEARCH_ROLE=${existingEnv.ADZUNA_SEARCH_ROLE || 'Data Analyst'}
ADZUNA_SEARCH_LOCATION=${existingEnv.ADZUNA_SEARCH_LOCATION || 'Toronto'}
SERPER_API_KEY=${serperKey}
HUNTER_API_KEY=${hunterKey}
LLM_MODEL=${existingEnv.LLM_MODEL || ''}
LLM_API_KEY=${existingEnv.LLM_API_KEY || ''}
OPENAI_API_KEY=${existingEnv.OPENAI_API_KEY || ''}
OPENAI_BASE_URL=${existingEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1'}
ANTHROPIC_API_KEY=${existingEnv.ANTHROPIC_API_KEY || ''}
GROQ_API_KEY=${existingEnv.GROQ_API_KEY || ''}
DEEPSEEK_API_KEY=${existingEnv.DEEPSEEK_API_KEY || ''}
OPENROUTER_API_KEY=${existingEnv.OPENROUTER_API_KEY || ''}
OLLAMA_BASE_URL=${existingEnv.OLLAMA_BASE_URL || 'http://localhost:11434'}
WEBHOOK_URL=${existingEnv.WEBHOOK_URL || ''}
CLOUDFLARE_TUNNEL_TOKEN=${existingEnv.CLOUDFLARE_TUNNEL_TOKEN || ''}
`;

  fs.writeFileSync(envPath, envContent, 'utf8');

  console.log('\n' + '='.repeat(70));
  console.log('🎉 CONFIGURATION SAVED SUCCESSFULLY TO .env!');
  console.log('='.repeat(70));
  console.log('🚀 Next Steps:');
  console.log('   1. Ingest your resume:');
  console.log('      npm run parse-resume "path/to/Your_Resume.pdf"');
  console.log('      (Or simply send your resume file to your bot in Telegram!)');
  console.log('   2. Start your bot:');
  console.log('      npm start');
  console.log('   3. Open Telegram and send /start to your bot!');
  console.log('='.repeat(70) + '\n');

  rl.close();
}

runWizard().catch(err => {
  console.error('\n❌ Setup Wizard encountered an error:', err);
  rl.close();
  process.exit(1);
});
