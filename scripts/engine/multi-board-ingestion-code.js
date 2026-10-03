/**
 * multi-board-ingestion-code.js — n8n Code Node Bridge
 *
 * PURPOSE:
 *   This script is pasted into an n8n "Code" node. It runs fetch-all-boards.js
 *   as a subprocess and returns the fetched jobs to the n8n workflow.
 *
 * HOW IT WORKS:
 *   1. Finds fetch-all-boards.js on disk (checks multiple possible locations)
 *   2. Runs it as a child process with a 120-second timeout
 *   3. Parses the JSON output (array of job objects)
 *   4. Returns the jobs in n8n's expected format: [{ json: jobObject }, ...]
 *
 * FALLBACK:
 *   If subprocess execution fails (e.g. in restricted environments), it falls
 *   back to importing the module directly with require().
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ── Step 1: Find the fetch-all-boards.js script ─────────────────────────────
function resolveScriptPath() {
  const dir = typeof __dirname !== 'undefined' ? __dirname : '';
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '.';

  const candidates = [
    '/scripts/engine/fetch-all-boards.js',                         // Docker mount
    path.join(cwd, 'scripts', 'engine', 'fetch-all-boards.js'),       // Relative to CWD
    dir ? path.join(dir, 'fetch-all-boards.js') : null,     // Same directory
    'scripts/engine/fetch-all-boards.js',                          // Simple relative
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

// ── Step 2: Execute and return jobs ─────────────────────────────────────────
const scriptPath = resolveScriptPath();
let jobs = [];

if (scriptPath) {
  try {
    // Merge process.env and n8n's $env into one environment object
    const envObj = Object.assign(
      {},
      (typeof process !== 'undefined' && process.env) ? process.env : {},
      (typeof $env !== 'undefined') ? $env : {},
    );

    // Run fetch-all-boards.js as a subprocess (30MB buffer, 120s timeout)
    const rawOutput = cp.execFileSync('node', [scriptPath], {
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
      timeout: 120000,
      env: envObj,
    });

    const parsed = JSON.parse(rawOutput);
    if (Array.isArray(parsed)) jobs = parsed;

  } catch (err) {
    // Fallback: try to import the module directly
    console.warn('[Multi-Board Ingestion] Subprocess failed, trying in-process:', err.message);
    try {
      const fetcher = require(scriptPath);
      if (fetcher && typeof fetcher.fetchAllJobs === 'function') {
        jobs = await fetcher.fetchAllJobs();
      }
    } catch (modErr) {
      console.error('[Multi-Board Ingestion] In-process execution also failed:', modErr.message);
    }
  }
} else {
  console.error('[Multi-Board Ingestion] Could not locate fetch-all-boards.js');
}

// Return jobs in n8n format: each job wrapped in { json: ... }
return jobs.map(j => ({ json: j }));
