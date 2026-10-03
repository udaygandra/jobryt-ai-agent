/**
 * import-resume-telegram.js — Interactive Resume Onboarding CLI Invoker
 *
 * PURPOSE:
 *   CLI entry point called by telegram-bridge or direct execution.
 *   Delegates to scripts/bot/onboarding-handler.js to parse the resume,
 *   stage the profile, and initiate the 3-step conversational flow.
 *
 * USAGE:
 *   node scripts/bot/import-resume-telegram.js <file-path> <chat-id>
 */

const { loadEnv } = require('../core/load-env');
loadEnv();

const { startOnboarding } = require('./onboarding-handler');

const args = process.argv.slice(2);
const filePath = args[0] && !args[0].match(/^[0-9]+$/) ? args[0] : null;
const chatId = args.find(a => a.match(/^[0-9]+$/)) || process.env.TELEGRAM_CHAT_ID;

if (!filePath) {
  console.error('❌ Usage: node scripts/bot/import-resume-telegram.js <file-path> [chat-id]');
  process.exit(1);
}

startOnboarding(filePath, chatId)
  .then(success => {
    if (success) {
      console.log('✅ Interactive onboarding initiated successfully.');
      process.exit(0);
    } else {
      console.error('❌ Failed to initiate onboarding.');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('❌ Fatal error during onboarding initiation:', err);
    process.exit(1);
  });
