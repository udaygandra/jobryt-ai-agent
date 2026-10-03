/**
 * common-utils.js — Shared Utility Functions
 *
 * PURPOSE:
 *   Central library of helper functions used by every script in the project.
 *   Handles data directory lookup, file I/O, HTML escaping, and security.
 *
 * USAGE:
 *   const { getDataDir, readJsonFile, writeJsonFile } = require('./common-utils');
 */

const fs = require('fs');
const path = require('path');

// ── Data Directory Resolution ───────────────────────────────────────────────
// Finds where the project's data files live (seen-jobs.json, settings.json, etc).
// Works in both local dev and Docker containers.
//
// Priority order:
//   1. n8n's $env.DATA_DIR (when running inside an n8n Code node)
//   2. process.env.DATA_DIR (set via .env or Docker)
//   3. /data (Docker container default mount)
//   4. <project-root>/data (local development)
//   5. Current directory (last resort fallback)
function getDataDir() {
  // Check 1: n8n runtime environment
  if (typeof $env !== 'undefined' && $env && $env.DATA_DIR) {
    return $env.DATA_DIR;
  }

  // Check 2: System environment variable
  if (process.env && process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }

  // Check 3: Docker container default
  if (fs.existsSync('/data')) {
    return '/data';
  }

  // Check 4: Local project "data/" folder (one level up from scripts/)
  const projectDataDir = path.join(__dirname, '..', '..', 'data');
  if (fs.existsSync(projectDataDir)) {
    return projectDataDir;
  }

  // Check 5: Relative "data/" folder from current directory
  if (fs.existsSync('data')) {
    return 'data';
  }

  // Fallback: current directory
  return '.';
}

// ── Environment Variable Accessor ───────────────────────────────────────────
// Gets an env var from either n8n's $env context or process.env.
// Auto-loads .env if it hasn't been loaded yet.
function getEnv(key, defaultVal = '') {
  // Try n8n's runtime context first
  if (typeof $env !== 'undefined' && $env && $env[key] !== undefined) {
    return $env[key];
  }

  // Try process.env (auto-load .env if needed)
  if (process.env) {
    if (process.env[key] !== undefined) return process.env[key];

    // Lazy-load the .env file on first access
    try {
      const { loadEnv } = require('./load-env');
      loadEnv();
      if (process.env[key] !== undefined) return process.env[key];
    } catch (_) {
      // Silently fail if load-env is unavailable (e.g. inside n8n sandbox)
    }
  }

  return defaultVal;
}

// ── HTML Escaping ───────────────────────────────────────────────────────────
// Converts special characters to HTML entities for safe Telegram/web display.
// Example: escapeHtml('<b>test</b>') => '&lt;b&gt;test&lt;/b&gt;'
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const unescaped = String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
  return unescaped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Safe JSON Parser ────────────────────────────────────────────────────────
// Parses a JSON string without crashing. Returns the fallback if parsing fails.
// Example: safeJsonParse('bad json', []) => []
function safeJsonParse(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

// ── Read JSON File ──────────────────────────────────────────────────────────
// Reads a JSON file from disk and returns the parsed object.
// Returns the fallback value if the file doesn't exist or can't be parsed.
function readJsonFile(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return safeJsonParse(content, fallback);
    }
  } catch (err) {
    console.warn(`[common-utils] Could not read ${filePath}: ${err.message}`);
  }
  return fallback;
}

// ── Write JSON File ─────────────────────────────────────────────────────────
// Writes a JavaScript object to a JSON file (pretty-printed).
// Creates parent directories if they don't exist.
function writeJsonFile(filePath, data) {
  try {
    // Create parent directories if needed
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write the JSON file
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, jsonStr, 'utf8');
    return true;
  } catch (err) {
    console.error(`[common-utils] Failed to write ${filePath}: ${err.message}`);
    return false;
  }
}

// ── Filename Sanitizer ──────────────────────────────────────────────────────
// Removes dangerous characters from filenames to prevent path traversal.
// Example: sanitizeFilename('../../etc/passwd') => '__.._etc_passwd'
function sanitizeFilename(name, fallback = 'document') {
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Replace illegal filesystem chars
    .replace(/\.{2,}/g, '.')                    // Collapse ".." to "."
    .replace(/\s+/g, '_')                       // Replace whitespace with underscores
    .trim();
  return cleaned || fallback;
}

// ── Safe Path Join ──────────────────────────────────────────────────────────
// Joins path segments and VERIFIES the result stays within the base directory.
// Throws an error if someone tries to escape (e.g. using "../../").
function safeJoin(baseDir, ...parts) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...parts);
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error('Security violation: path traversal detected outside base directory');
  }
  return resolvedTarget;
}

module.exports = {
  getDataDir,
  getEnv,
  escapeHtml,
  safeJsonParse,
  readJsonFile,
  writeJsonFile,
  sanitizeFilename,
  safeJoin,
};
