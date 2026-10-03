/**
 * send-telegram-doc.js — Zero-Dependency Telegram File Sender
 *
 * PURPOSE:
 *   Sends a file (PDF, XLSX, JSON, DOCX, TXT) to a Telegram chat using
 *   the Telegram Bot API. Uses only Node.js built-in modules (no npm deps).
 *
 * USAGE (command line):
 *   node send-telegram-doc.js <botToken> <chatId> <filePath> [fileName] [caption]
 *
 * USAGE (from other scripts):
 *   Called as a subprocess by export-applied-jobs.js and telegram-bridge.js.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

// Load environment variables (non-critical if it fails)
try { const { loadEnv } = require('../core/load-env'); loadEnv(); } catch (_) {}

// ── Parse Command Line Arguments ────────────────────────────────────────────
const args = process.argv.slice(2);
const botToken = (args[0] && args[0].trim()) || process.env.TELEGRAM_BOT_TOKEN;
const chatId = (args[1] && args[1].trim()) || process.env.TELEGRAM_CHAT_ID;
const docPath = args[2];
const docFileName = args[3] || (docPath ? path.basename(docPath) : 'document.pdf');
const caption = args[4] || '';

// Validate required arguments
if (!botToken || !chatId || !docPath) {
  console.error('Usage: node send-telegram-doc.js <botToken> <chatId> <docPath> [fileName] [caption]');
  process.exit(1);
}
if (!fs.existsSync(docPath)) {
  console.error('File does not exist:', docPath);
  process.exit(1);
}

// ── Map file extensions to MIME types ───────────────────────────────────────
const CONTENT_TYPE_MAP = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
};

// ── Send the file via Telegram API ──────────────────────────────────────────
function sendDocument() {
  const boundary = '----JobRytFormBoundary' + Math.random().toString(36).substring(2) + Date.now();
  const fileBuffer = fs.readFileSync(docPath);

  // Determine MIME type from file extension
  const ext = path.extname(docFileName).toLowerCase();
  const contentType = CONTENT_TYPE_MAP[ext] || 'application/octet-stream';

  // Build multipart form data manually (no external library needed)
  let preBody = '';
  preBody += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;

  if (caption) {
    preBody += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    preBody += `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`;
  }

  const preFile = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${docFileName}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const postFile = `\r\n--${boundary}--\r\n`;

  // Calculate total Content-Length for the request
  const totalLength =
    Buffer.byteLength(preBody, 'utf8') +
    Buffer.byteLength(preFile, 'utf8') +
    fileBuffer.length +
    Buffer.byteLength(postFile, 'utf8');

  // Send the HTTP request to Telegram
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendDocument`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': totalLength,
    },
    timeout: 30000,
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (json.ok) {
          console.log('SUCCESS:', json.result && json.result.message_id);
          try {
            if (fs.existsSync(docPath)) {
              fs.unlinkSync(docPath);
              console.log('Successfully cleaned up sent file from data folder:', docPath);
            }
          } catch (cleanErr) {
            console.error('File cleanup error:', cleanErr.message);
          }
          process.exit(0);
        } else {
          console.error('TELEGRAM_ERROR:', body);
          process.exit(1);
        }
      } catch (_) {
        console.error('PARSE_ERROR:', body);
        process.exit(1);
      }
    });
  });

  req.on('error', (err) => { console.error('REQUEST_ERROR:', err.message); process.exit(1); });
  req.on('timeout', () => { req.destroy(); console.error('TIMEOUT'); process.exit(1); });

  // Write the multipart body parts in order
  req.write(preBody, 'utf8');
  req.write(preFile, 'utf8');
  req.write(fileBuffer);
  req.write(postFile, 'utf8');
  req.end();
}

sendDocument();
