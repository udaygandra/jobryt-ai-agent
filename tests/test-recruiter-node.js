const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '../scripts/engine/find-recruiters-code.js'), 'utf8');

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

async function executeNode(envObj, mockItem, httpRequestMock) {
  let capturedTelegramMsg = null;
  let capturedMarkup = null;
  const helpers = {
    httpRequest: async (opts) => {
      if (opts.url && opts.url.includes('sendMessage')) {
        capturedTelegramMsg = opts.body.text;
        capturedMarkup = opts.body.reply_markup;
        return { ok: true };
      }
      return httpRequestMock(opts);
    }
  };

  const inputObj = {
    all: () => [JSON.parse(JSON.stringify(mockItem))]
  };

  const wrapped = `
    const $env = envObj;
    const $input = inputObj;
    this.helpers = mockHelpers;
    ${code}
  `;

  const runner = new AsyncFunction('require', 'envObj', 'inputObj', 'mockHelpers', wrapped);
  await runner(require, envObj, inputObj, helpers);
  return { text: capturedTelegramMsg, reply_markup: capturedMarkup };
}

async function runTests() {
  const cachePath = path.join(__dirname, '../data/tracking/recruiter_cache.json');
  if (fs.existsSync(cachePath)) {
    fs.writeFileSync(cachePath, '{}', 'utf8');
  }

  const baseItem = {
    json: {
      action: 'APPLY',
      title: 'Senior Data Analyst',
      company: 'Shopify',
      company_name: 'Shopify',
      location: 'Toronto, ON',
      chat_id: '123456789'
    }
  };

  // Test 1: Keys skipped (empty) -> Fallback to Google Search with Double-Check Warning
  console.log('🧪 TEST 1: User skips API keys -> verify Google Search fallback & double check warning...');
  fs.writeFileSync(cachePath, '{}', 'utf8');
  const resSkipped = await executeNode(
    {
      DATA_DIR: path.join(__dirname, '../data'),
      SERPER_API_KEY: '',
      HUNTER_API_KEY: '',
      TELEGRAM_BOT_TOKEN: 'mock_token'
    },
    baseItem,
    async () => ({})
  );

  const msgSkipped = resSkipped.text;
  if (!msgSkipped.includes('SAFETY DOUBLE-CHECK REQUIRED')) {
    throw new Error('Test 1 Failed: Expected SAFETY DOUBLE-CHECK warning banner.');
  }
  if (!msgSkipped.includes('Google X-Ray Search') || !msgSkipped.includes('1-Tap Google Search')) {
    throw new Error('Test 1 Failed: Expected 1-Tap Google Search fallback header and links.');
  }
  if (!msgSkipped.includes('LinkedIn Connection Note') || !msgSkipped.includes('Shopify')) {
    throw new Error('Test 1 Failed: Expected tailored LinkedIn connection note.');
  }
  if (!resSkipped.reply_markup || !resSkipped.reply_markup.inline_keyboard) {
    throw new Error('Test 1 Failed: Expected inline keyboard with search buttons.');
  }
  console.log('✅ TEST 1 PASSED: Seamless fallback to Google search with safety warning banner.');

  // Test 2: Keys provided, but stale/invalid (401 Unauthorized or network error) -> Fallback to Google Search
  console.log('\n🧪 TEST 2: API key is stale / returns 401 Unauthorized -> verify Google Search fallback without crashing...');
  fs.writeFileSync(cachePath, '{}', 'utf8');
  const resStale = await executeNode(
    {
      DATA_DIR: path.join(__dirname, '../data'),
      SERPER_API_KEY: 'stale_expired_key_123',
      HUNTER_API_KEY: 'stale_expired_key_456',
      TELEGRAM_BOT_TOKEN: 'mock_token'
    },
    baseItem,
    async (opts) => {
      if (opts.url.includes('serper.dev') || opts.url.includes('hunter.io')) {
        const err = new Error('HTTP 401: Unauthorized - Invalid or expired API key');
        err.statusCode = 401;
        throw err;
      }
      return {};
    }
  );

  const msgStale = resStale.text;
  if (!msgStale.includes('SAFETY DOUBLE-CHECK REQUIRED')) {
    throw new Error('Test 2 Failed: Expected SAFETY DOUBLE-CHECK warning banner.');
  }
  if (!msgStale.includes('Google X-Ray Search') || !msgStale.includes('1-Tap Google Search')) {
    throw new Error('Test 2 Failed: Expected graceful fallback to 1-Tap Google Search on stale keys.');
  }
  console.log('✅ TEST 2 PASSED: Graceful fallback to Google search on stale/bad API keys.');

  // Test 3: Keys provided and valid -> Verified contacts found, Gmail composer & profile verify buttons
  console.log('\n🧪 TEST 3: Keys provided and valid -> verify contacts, Gmail composer button & inspection links...');
  const resValid = await executeNode(
    {
      DATA_DIR: path.join(__dirname, '../data'),
      SERPER_API_KEY: 'valid_serper_key',
      HUNTER_API_KEY: 'valid_hunter_key',
      TELEGRAM_BOT_TOKEN: 'mock_token'
    },
    baseItem,
    async (opts) => {
      if (opts.url.includes('serper.dev')) {
        return {
          organic: [
            {
              title: 'Sarah Jenkins - Senior Technical Recruiter - Shopify | LinkedIn',
              link: 'https://ca.linkedin.com/in/sarahjenkins-shopify',
              snippet: 'Senior Technical Recruiter at Shopify in Toronto, ON helping build engineering teams.'
            }
          ]
        };
      }
      if (opts.url.includes('hunter.io')) {
        return {
          data: {
            domain: 'shopify.com',
            emails: [
              {
                first_name: 'Sarah',
                last_name: 'Jenkins',
                position: 'Senior Recruiter',
                type: 'personal',
                confidence: 92,
                value: 'sjenkins@shopify.com',
                linkedin: 'https://ca.linkedin.com/in/sarahjenkins-shopify'
              }
            ]
          }
        };
      }
      return {};
    }
  );

  const msgValid = resValid.text;
  if (!msgValid.includes('Sarah Jenkins') || !msgValid.includes('Verified Contacts Found')) {
    throw new Error('Test 3 Failed: Expected verified contact Sarah Jenkins in output.');
  }
  if (!msgValid.includes('Inspect & Verify Profile on LinkedIn')) {
    throw new Error('Test 3 Failed: Expected profile inspection link.');
  }
  if (!msgValid.includes('Requires Human Validation') || !msgValid.includes('Never send unverified emails')) {
    throw new Error('Test 3 Failed: Expected explicit cold email human validation warning.');
  }
  
  const buttons = resValid.reply_markup.inline_keyboard.flat();
  const verifyBtn = buttons.find(b => b.text.includes('Verify Sarah on LinkedIn'));
  const gmailBtn = buttons.find(b => b.text.includes('Review & Send via Gmail'));

  if (!verifyBtn || !verifyBtn.url.includes('linkedin.com')) {
    throw new Error('Test 3 Failed: Expected 1-tap LinkedIn verification button.');
  }
  if (!gmailBtn || !gmailBtn.url.includes('mail.google.com')) {
    throw new Error('Test 3 Failed: Expected 1-tap Gmail pre-filled compose button.');
  }

  console.log('✅ TEST 3 PASSED: Verified contacts, direct LinkedIn inspection link, and pre-filled Gmail composer verified.');

  console.log('\n🎉 ALL RECRUITER NODE HUMAN VALIDATION & SAFETY TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
