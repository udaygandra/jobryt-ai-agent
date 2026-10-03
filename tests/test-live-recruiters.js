const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../scripts/core/load-env');
loadEnv();

const code = fs.readFileSync(path.join(__dirname, '../scripts/engine/find-recruiters-code.js'), 'utf8');

const mockItem = {
  json: {
    action: 'APPLY',
    title: 'Senior Data Analyst',
    company: 'Shopify',
    company_name: 'Shopify',
    location: 'Toronto, ON',
    chat_id: process.env.TELEGRAM_CHAT_ID || '123456789'
  }
};

let outputMessage = null;
let outputMarkup = null;

const helpers = {
  httpRequest: async (opts) => {
    if (opts.url && opts.url.includes('sendMessage')) {
      outputMessage = opts.body.text;
      outputMarkup = opts.body.reply_markup;
      return { ok: true };
    }

    const fetchOpts = {
      method: opts.method || 'GET',
      headers: opts.headers || {}
    };

    if (opts.body) {
      fetchOpts.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    const res = await fetch(opts.url, fetchOpts);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${res.statusText}`);
      err.statusCode = res.status;
      throw err;
    }
    return res.json();
  }
};

async function testLive() {
  console.log('🧪 Testing Live Recruiter Discovery (Serper & Hunter APIs)...');
  console.log('  SERPER_API_KEY:', process.env.SERPER_API_KEY ? 'Present' : 'Missing');
  console.log('  HUNTER_API_KEY:', process.env.HUNTER_API_KEY ? 'Present' : 'Missing');

  const wrapped = `
    const $env = envObj;
    const $input = inputObj;
    this.helpers = mockHelpers;
    ${code}
  `;

  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const runner = new AsyncFunction('require', 'envObj', 'inputObj', 'mockHelpers', wrapped);

  const context = { helpers };
  await runner.call(context, require, process.env, { all: () => [mockItem] }, helpers);

  console.log('\n───────────────── CAPTURED TELEGRAM OUTPUT ─────────────────');
  console.log(outputMessage);
  console.log('────────────────────────────────────────────────────────────');
  if (outputMarkup) {
    console.log('Buttons:', JSON.stringify(outputMarkup.inline_keyboard, null, 2));
  }

  if (outputMessage.includes('Verified Contacts Found')) {
    console.log('✅ LIVE RECRUITER DISCOVERY SUCCEEDED WITH REAL CONTACTS!');
  } else {
    console.log('⚠️ No contacts parsed, but Google X-Ray fallback was generated.');
  }
}

testLive().catch(err => {
  console.error('❌ Error during live recruiter test:', err);
  process.exit(1);
});
