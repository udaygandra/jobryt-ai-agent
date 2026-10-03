/**
 * load-env.js — SSOT Environment Configuration Loader
 *
 * PURPOSE:
 *   Loads environment variables from the project root .env file into
 *   process.env. This is the ONLY file that reads .env in the entire project.
 *   Every other script calls `require('./load-env').loadEnv()` at startup.
 *
 * HOW IT WORKS:
 *   1. Finds the .env file using a priority list of locations
 *   2. Parses each KEY=VALUE line and sets process.env[KEY]
 *   3. Only runs once per process (idempotent) to avoid re-reading the file
 *
 * PRIORITY ORDER (first match wins):
 *   1. ENV_FILE env var (for CI or custom setups)
 *   2. Project root .env (one folder up from /scripts)
 *   3. Current working directory .env
 *   4. /data/config/.env (Docker container mount)
 */

const fs = require('fs');
const path = require('path');

// ── State Tracking ──────────────────────────────────────────────────────────
// These flags ensure the .env file is read only once per Node.js process.
let isEnvLoaded = false;
let loadedFilePath = null;

// ── Step 1: Find the .env file ──────────────────────────────────────────────
// Checks 4 possible locations in order. Returns the first one that exists.
function resolveCanonicalEnvPath() {
  // Location 1: Custom path from ENV_FILE environment variable
  if (process.env.ENV_FILE) {
    const customPath = path.isAbsolute(process.env.ENV_FILE)
      ? process.env.ENV_FILE
      : path.resolve(process.cwd(), process.env.ENV_FILE);
    if (fs.existsSync(customPath)) return customPath;
  }

  // Location 2: Project root (scripts/core/../../.env)
  const rootEnvPath = path.resolve(__dirname, '..', '..', '.env');
  if (fs.existsSync(rootEnvPath)) return rootEnvPath;

  // Location 3: Current working directory
  const cwdEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(cwdEnvPath)) return cwdEnvPath;

  // Location 4: Docker container mount
  const containerEnvPath = '/data/.env';
  if (fs.existsSync(containerEnvPath)) return containerEnvPath;

  return null;
}

// ── Step 2: Parse a .env file ───────────────────────────────────────────────
// Reads each line, extracts KEY=VALUE pairs, and adds them to process.env.
// By default, existing env vars are NOT overwritten (set override=true to force).
function parseEnvFile(filePath, override = false) {
  if (!filePath || !fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Skip blank lines and comments
      if (!line || line.startsWith('#')) continue;

      // Find the first "=" to split key from value
      const equalIndex = line.indexOf('=');
      if (equalIndex === -1) continue;

      const key = line.substring(0, equalIndex).trim();
      let value = line.substring(equalIndex + 1).trim();

      // Strip unquoted inline comments (e.g., VALUE # comment or # comment when empty)
      if (!value.startsWith('"') && !value.startsWith("'")) {
        if (value.startsWith('#')) {
          value = '';
        } else {
          const commentIdx = value.indexOf('#');
          if (commentIdx !== -1) {
            value = value.substring(0, commentIdx).trim();
          }
        }
      }

      // Remove surrounding quotes ("value" or 'value')
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.substring(1, value.length - 1);
      }

      // Only set the variable if it doesn't already exist (or override is true)
      if (key && (override || process.env[key] === undefined)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.error(`[load-env] Failed to read ${filePath}:`, err.message);
  }
}

function sanitizeEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let changed = false;
    const cleanLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.substring(0, eqIdx).trim();
      const val = line.substring(eqIdx + 1).trim();
      if (val.startsWith('#')) {
        changed = true;
        return `${val}\n${key}=`;
      }
      return line;
    });
    if (changed) {
      fs.writeFileSync(filePath, cleanLines.join('\n'), 'utf8');
      console.log(`[load-env] Sanitized inline comments in ${filePath}`);
    }
  } catch (_) {}
}

// ── Step 3: Main Loader (call this from any script) ─────────────────────────
// Example usage: const { loadEnv } = require('./load-env'); loadEnv();
function loadEnv(forceReload = false) {
  // Skip if already loaded (unless forced)
  if (isEnvLoaded && !forceReload) return process.env;

  // Find and parse the canonical .env file
  const canonicalPath = resolveCanonicalEnvPath();
  if (canonicalPath) {
    sanitizeEnvFile(canonicalPath);
    parseEnvFile(canonicalPath, false);
    loadedFilePath = canonicalPath;

    // Also load .env.local if it exists next to .env (for local dev overrides)
    const localOverlayPath = path.join(path.dirname(canonicalPath), '.env.local');
    if (fs.existsSync(localOverlayPath)) {
      parseEnvFile(localOverlayPath, true);
    }
  }

  isEnvLoaded = true;
  return process.env;
}

// ── Step 4: Safe env var getter ─────────────────────────────────────────────
// Retrieves an env var by name, with a fallback default value.
function getEnvVar(key, defaultValue = '') {
  if (!isEnvLoaded) loadEnv();
  const value = process.env[key];
  return (value !== undefined && value !== '') ? value : defaultValue;
}

module.exports = { loadEnv, parseEnvFile, resolveCanonicalEnvPath, getEnvVar };
