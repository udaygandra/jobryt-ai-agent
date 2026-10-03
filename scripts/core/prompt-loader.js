/**
 * prompt-loader.js — Externalized Prompt Template Loader
 *
 * PURPOSE:
 *   Loads text prompt templates from the /prompts directory and replaces
 *   {{PLACEHOLDERS}} with actual values. Used by LLM scoring, resume
 *   generation, and cover letter drafting.
 *
 * HOW IT WORKS:
 *   1. Searches multiple possible locations for the prompt file
 *   2. Reads the template text
 *   3. Replaces all {{KEY}} placeholders with provided values
 *
 * USAGE:
 *   const { loadPrompt } = require('./prompt-loader');
 *   const prompt = loadPrompt('scoring.txt', { JOB_TITLE: 'Engineer', PROFILE: '...' });
 */

const fs = require('fs');
const path = require('path');

// ── Find the prompt file ────────────────────────────────────────────────────
// Checks multiple possible locations for the prompt file.
// Works in local dev (prompts/ folder) and Docker (/prompts mount).
function getPromptPath(filename) {
  const envPromptsDir = process.env.PROMPTS_DIR;

  // Build a list of places to look, in priority order
  const candidates = [
    // 1. Custom prompts directory from env var
    ...(envPromptsDir ? [path.join(envPromptsDir, filename), path.resolve(envPromptsDir, filename)] : []),
    // 2. Docker container mount
    path.join('/prompts', filename),
    // 3. Project root prompts folder (one level up from scripts/)
    path.join(__dirname, '..', '..', 'prompts', filename),
    // 4. Current working directory
    path.join(process.cwd(), 'prompts', filename),
    // 5. n8n home directory
    path.join('/home/node', 'prompts', filename),
  ];

  // Return the first file that actually exists
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

// ── Load and fill a prompt template ─────────────────────────────────────────
// Reads the template file and replaces {{KEY}} placeholders with real values.
//
// Example:
//   loadPrompt('scoring.txt', { JOB_TITLE: 'Engineer' })
//   Template: "Score this {{JOB_TITLE}} job"
//   Result:   "Score this Engineer job"
function loadPrompt(filename, variables = {}, fallback = '') {
  let template = fallback;
  const filePath = getPromptPath(filename);

  // Read the template file (or use fallback if not found)
  if (filePath) {
    try {
      template = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.warn(`[prompt-loader] Could not read ${filePath}, using fallback: ${err.message}`);
    }
  }

  // Replace all {{KEY}} placeholders with their values
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match;
  });
}

module.exports = { getPromptPath, loadPrompt };
