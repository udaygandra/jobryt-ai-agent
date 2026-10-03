/**
 * settings-helper.js — User Preferences & Configuration Manager
 *
 * PURPOSE:
 *   Manages all user-configurable settings: freshness filter, score threshold,
 *   cron schedule, enabled job boards, and work type preference.
 *   Provides Telegram interactive menus for changing settings via button taps.
 *
 * DATA FILE:
 *   Reads/writes data/config/settings.json
 *
 * USAGE:
 *   const { getSettings, updateSettings } = require('./settings-helper');
 *   const settings = getSettings();                   // Read current settings
 *   updateSettings({ score_threshold: 80 });          // Change a setting
 */

const path = require('path');
const { getDataDir, readJsonFile, writeJsonFile } = require('./common-utils');

// ── Default Settings ────────────────────────────────────────────────────────
// These values are used when settings.json is missing or has incomplete data.
// They define a sensible starting configuration for a new user.
const DEFAULT_SETTINGS = Object.freeze({
  freshness_hours: 24,           // Only show jobs posted in last 24 hours
  score_threshold: 60,           // Minimum match score to notify (0-100)
  cron_schedule: '30 8,11,14,17,20 * * *',  // When to run the pipeline
  cron_description: '5 times daily (8:30 AM, 11:30 AM, 2:30 PM, 5:30 PM, 8:30 PM)',
  work_type: 'Open to All',      // Remote, Hybrid, Onsite, or all
  country_scope: 'AUTO',         // CA, US, US_CA, GLOBAL, or AUTO-detect
  timezone: 'America/Toronto',   // Candidate timezone for scheduling
  boards_enabled: {
    linkedin: true,
    canada_job_bank: true,
    adzuna: true,
    usajobs: true,
    jobicy: true,
    remotive: true,
    arbeitnow: true,
    himalayas: true,
  },
});

// ── Schedule Presets ────────────────────────────────────────────────────────
// Pre-defined cron schedules users can pick from Telegram buttons.
const SCHEDULE_PRESETS = Object.freeze({
  '5X':       { cron: '30 8,11,14,17,20 * * *', desc: '5 times daily (8:30 AM, 11:30 AM, 2:30 PM, 5:30 PM, 8:30 PM)' },
  '3X':       { cron: '0 8,13,18 * * *',        desc: '3 times daily (8:00 AM, 1:00 PM, 6:00 PM)' },
  'DAILY':    { cron: '0 9 * * *',               desc: 'Daily at 9:00 AM' },
  '2H':       { cron: '0 */2 * * *',             desc: 'Every 2 hours' },
  'HOURLY':   { cron: '0 * * * *',               desc: 'Every hour' },
  'TWICE':    { cron: '0 9,17 * * *',            desc: 'Twice daily (9:00 AM, 5:00 PM)' },
  'WEEKDAYS': { cron: '0 9 * * 1-5',             desc: 'Weekdays at 9:00 AM (Mon-Fri)' },
});

// ── Work Mode Options ───────────────────────────────────────────────────────
// Maps short keys (used in Telegram callbacks) to display labels.
const WORK_MODES = Object.freeze({
  'REMOTE': 'Remote Only',
  'HYBRID': 'Hybrid & Remote',
  'ONSITE': 'Onsite / Any',
  'ALL':    'Open to All',
});

// ── Settings Validation ─────────────────────────────────────────────────────
// Merges user settings with defaults and validates numeric bounds.
// This ensures we never end up with invalid values (e.g., negative hours).
function sanitizeSettings(raw, masterProfile = null) {
  if (!raw || typeof raw !== 'object') raw = {};

  let candidateTz = 'America/Toronto';
  try {
    const { detectCandidateTimezone } = require('./geo-helper');
    candidateTz = detectCandidateTimezone(masterProfile || {});
  } catch (_) {}

  // Merge user values on top of defaults
  const sanitized = {
    ...DEFAULT_SETTINGS,
    timezone: masterProfile?.timezone || raw.timezone || candidateTz,
    ...raw,
    boards_enabled: { ...DEFAULT_SETTINGS.boards_enabled, ...(raw.boards_enabled || {}) },
  };

  if (masterProfile && masterProfile.timezone) {
    sanitized.timezone = masterProfile.timezone;
  } else if (!sanitized.timezone) {
    sanitized.timezone = candidateTz;
  }

  // Allow freshness_hours between 0 and 720 (0 = Disabled / Any Time)
  const hours = parseInt(sanitized.freshness_hours, 10);
  sanitized.freshness_hours = (!isNaN(hours) && hours >= 0 && hours <= 720) ? hours : 24;

  // Clamp score_threshold between 40 and 95
  const score = parseInt(sanitized.score_threshold, 10);
  sanitized.score_threshold = (!isNaN(score) && score >= 40 && score <= 95) ? score : 60;

  return sanitized;
}

// ── Read Current Settings ───────────────────────────────────────────────────
// Loads settings.json from the data directory and merges with defaults and profile.
function getSettings(masterProfile = null) {
  if (!masterProfile) {
    try {
      const profilePath = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json');
      masterProfile = readJsonFile(profilePath, {});
    } catch (_) {}
  }
  const settingsPath = path.join(__dirname, '..', '..', 'data', 'config', 'settings.json');
  const parsed = readJsonFile(settingsPath, null);
  return sanitizeSettings(parsed, masterProfile);
}

// ── Update Settings ─────────────────────────────────────────────────────────
// Merges partial updates into current settings and saves to disk.
// Returns the new settings object.
function updateSettings(partial = {}, masterProfile = null) {
  if (!masterProfile) {
    try {
      const profilePath = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json');
      masterProfile = readJsonFile(profilePath, {});
    } catch (_) {}
  }
  const current = getSettings(masterProfile);

  // Deep merge boards_enabled
  const merged = {
    ...current,
    ...partial,
    boards_enabled: { ...current.boards_enabled, ...(partial.boards_enabled || {}) },
  };

  const validated = sanitizeSettings(merged, masterProfile);
  const settingsPath = path.join(__dirname, '..', '..', 'data', 'config', 'settings.json');
  writeJsonFile(settingsPath, validated);

  // If timezone was explicitly updated, sync to master-profile.json as well
  if (partial.timezone && masterProfile && typeof masterProfile === 'object') {
    masterProfile.timezone = partial.timezone;
    try {
      const profilePath = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json');
      writeJsonFile(profilePath, masterProfile);
    } catch (_) {}
  }

  return validated;
}

// ── Parse Human-Readable Schedule Input ─────────────────────────────────────
// Converts natural language like "hourly" or "3 times daily" into a cron expression.
// Also accepts raw 5-field cron format (e.g. "0 8,13,18 * * *").
// Returns { cron, desc } or null if unrecognized.
function parseHumanSchedule(input) {
  if (!input || typeof input !== 'string') return null;
  const clean = input.toLowerCase().trim();

  // Map common phrases to schedule presets
  const humanMap = {
    'hourly':               SCHEDULE_PRESETS['HOURLY'],
    'every hour':           SCHEDULE_PRESETS['HOURLY'],
    '1h':                   SCHEDULE_PRESETS['HOURLY'],
    'every 2 hours':        SCHEDULE_PRESETS['2H'],
    'every 2h':             SCHEDULE_PRESETS['2H'],
    '2h':                   SCHEDULE_PRESETS['2H'],
    'every 3 hours':        { cron: '0 */3 * * *', desc: 'Every 3 hours' },
    'every 4 hours':        { cron: '0 */4 * * *', desc: 'Every 4 hours' },
    'every 6 hours':        { cron: '0 */6 * * *', desc: 'Every 6 hours' },
    'daily':                SCHEDULE_PRESETS['DAILY'],
    'once a day':           SCHEDULE_PRESETS['DAILY'],
    'every morning':        SCHEDULE_PRESETS['DAILY'],
    '9am':                  SCHEDULE_PRESETS['DAILY'],
    '5 times daily':        SCHEDULE_PRESETS['5X'],
    '5x daily':             SCHEDULE_PRESETS['5X'],
    '5x':                   SCHEDULE_PRESETS['5X'],
    '3 times daily':        SCHEDULE_PRESETS['3X'],
    '3x daily':             SCHEDULE_PRESETS['3X'],
    'twice daily':          SCHEDULE_PRESETS['TWICE'],
    '2x daily':             SCHEDULE_PRESETS['TWICE'],
    'weekdays':             SCHEDULE_PRESETS['WEEKDAYS'],
    'monday to friday':     SCHEDULE_PRESETS['WEEKDAYS'],
  };

  if (humanMap[clean]) return humanMap[clean];

  // Check if it's a raw cron expression (5 space-separated fields)
  const parts = clean.split(/\s+/);
  if (parts.length === 5) {
    return { cron: input.trim(), desc: `Custom cron: ${input.trim()}` };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM UI RENDERING
// Everything below builds Telegram bot inline keyboard menus for settings.
// ═══════════════════════════════════════════════════════════════════════════

// ── Main Settings Dashboard ─────────────────────────────────────────────────
// Shows all current settings at a glance with buttons to change each one.
function renderSettingsDashboard(settings, masterProfile = {}) {
  const b = settings.boards_enabled || {};

  // Build the job board status list
  const boardList = [
    `• LinkedIn: ${b.linkedin !== false ? '✅ On' : '❌ Off'}`,
    `• Canada Job Bank: ${b.canada_job_bank !== false ? '✅ On' : '❌ Off'}`,
    `• Adzuna: ${b.adzuna !== false ? '✅ On' : '❌ Off'}`,
    `• USAJOBS (Federal): ${b.usajobs !== false ? '✅ On' : '❌ Off'}`,
    `• Jobicy Remote: ${b.jobicy !== false ? '✅ On' : '❌ Off'}`,
    `• Remotive Remote: ${b.remotive !== false ? '✅ On' : '❌ Off'}`,
    `• ArbeitNow Remote: ${b.arbeitnow !== false ? '✅ On' : '❌ Off'}`,
    `• Himalayas Remote: ${b.himalayas !== false ? '✅ On' : '❌ Off'}`,
  ].join('\n');

  const roles = (masterProfile.target_titles || ['Not configured']).join(', ');
  const locs = (masterProfile.locations || ['Not configured']).join(', ');

  // Build the message text (Telegram HTML format)
  const text =
    `⚙️ <b>BOT PREFERENCES & SETTINGS DASHBOARD</b>\n\n` +
    `👤 <b>Candidate:</b> ${masterProfile.name || 'Candidate'}\n` +
    `🎯 <b>Target Roles:</b> ${roles}\n` +
    `📍 <b>Locations:</b> ${locs}\n` +
    `🏢 <b>Work Mode:</b> ${settings.work_type || 'Open to All'}\n\n` +
    `🕒 <b>Freshness Window:</b> <code>${settings.freshness_hours === 0 ? 'Disabled (Any Time)' : settings.freshness_hours + ' hours'}</code>\n` +
    `🎯 <b>Min Match Score:</b> <code>${settings.score_threshold}/100</code>\n` +
    `⏰ <b>Automation Schedule:</b> ${settings.cron_description || settings.cron_schedule} (<code>${settings.timezone || 'America/Toronto'}</code>)\n\n` +
    `📋 <b>Active Job Boards:</b>\n${boardList}\n\n` +
    `<i>Tap a button below to update any preference instantly:</i>`;

  // Build the inline keyboard buttons
  const keyboard = [
    [
      { text: `🕒 Freshness (${settings.freshness_hours === 0 ? 'Off' : settings.freshness_hours + 'h'})`, callback_data: 'SET_MENU:FRESH' },
      { text: `🎯 Threshold (${settings.score_threshold})`, callback_data: 'SET_MENU:SCORE' },
    ],
    [
      { text: '🏢 Work Mode', callback_data: 'SET_MENU:WORK' },
      { text: '⏰ Schedule', callback_data: 'SET_MENU:SCHED' },
    ],
    [
      { text: '📋 Toggle Job Boards', callback_data: 'SET_MENU:BOARDS' },
      { text: '🔄 Refresh', callback_data: 'SET_MENU:MAIN' },
    ],
  ];

  return { text, reply_markup: { inline_keyboard: keyboard } };
}

// ── Sub-Menu Renderer ───────────────────────────────────────────────────────
// Shows a focused settings page for one category (freshness, score, etc.).
// Each option shows ✅ if it's the currently selected value.
function renderSubMenu(menuKey, settings, masterProfile = {}) {
  const backBtn = { text: '🔙 Back to Settings Dashboard', callback_data: 'SET_MENU:MAIN' };

  // ─ Freshness filter sub-menu ─
  if (menuKey === 'FRESH') {
    const isOff = settings.freshness_hours === 0;
    return {
      text:
        `🕒 <b>Configure Freshness Filter Window</b>\n\n` +
        `Current Setting: <b>${isOff ? 'Disabled (Any Time)' : settings.freshness_hours + ' hours'}</b>\n\n` +
        `Select how recent job postings must be to be evaluated, or turn off the filter to review jobs of any age:`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: settings.freshness_hours === 24 ? '✅ 24 Hours (1 Day)' : '24 Hours (1 Day)', callback_data: 'SET_VAL:FRESH:24' },
            { text: settings.freshness_hours === 48 ? '✅ 48 Hours (2 Days)' : '48 Hours (2 Days)', callback_data: 'SET_VAL:FRESH:48' },
          ],
          [
            { text: settings.freshness_hours === 72 ? '✅ 72 Hours (3 Days)' : '72 Hours (3 Days)', callback_data: 'SET_VAL:FRESH:72' },
            { text: settings.freshness_hours === 168 ? '✅ 7 Days (1 Week)' : '7 Days (1 Week)', callback_data: 'SET_VAL:FRESH:168' },
          ],
          [
            { text: settings.freshness_hours === 720 ? '✅ 30 Days (1 Month)' : '30 Days (1 Month)', callback_data: 'SET_VAL:FRESH:720' },
            { text: isOff ? '✅ 🚫 Off (No Filter / Any Time)' : '🚫 Off (No Filter / Any Time)', callback_data: 'SET_VAL:FRESH:0' },
          ],
          [backBtn],
        ],
      },
    };
  }

  // ─ Score threshold sub-menu ─
  if (menuKey === 'SCORE') {
    return {
      text:
        `🎯 <b>Configure Match Score Threshold</b>\n\n` +
        `Current Setting: <b>${settings.score_threshold}/100</b>\n\n` +
        `Select the minimum score gate for job notifications:`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: settings.score_threshold === 60 ? '✅ 60+ (>60 Broad)' : '60+ (>60 Broad)', callback_data: 'SET_VAL:SCORE:60' },
            { text: settings.score_threshold === 70 ? '✅ 70+ (Standard)' : '70+ (Standard)', callback_data: 'SET_VAL:SCORE:70' },
          ],
          [
            { text: settings.score_threshold === 75 ? '✅ 75+ (Selective)' : '75+ (Selective)', callback_data: 'SET_VAL:SCORE:75' },
            { text: settings.score_threshold === 80 ? '✅ 80+ (Strict)' : '80+ (Strict)', callback_data: 'SET_VAL:SCORE:80' },
          ],
          [backBtn],
        ],
      },
    };
  }

  // ─ Work mode sub-menu ─
  if (menuKey === 'WORK') {
    return {
      text:
        `🏢 <b>Configure Workplace Preference</b>\n\n` +
        `Current Setting: <b>${settings.work_type || 'Open to All'}</b>\n\n` +
        `Select your work arrangement:`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: settings.work_type === 'Remote Only' ? '✅ 🌐 Remote Only' : '🌐 Remote Only', callback_data: 'SET_VAL:WORK:REMOTE' },
            { text: settings.work_type === 'Hybrid & Remote' ? '✅ 🏢 Hybrid & Remote' : '🏢 Hybrid & Remote', callback_data: 'SET_VAL:WORK:HYBRID' },
          ],
          [
            { text: settings.work_type === 'Onsite / Any' ? '✅ 📍 Onsite / Any' : '📍 Onsite / Any', callback_data: 'SET_VAL:WORK:ONSITE' },
            { text: settings.work_type === 'Open to All' ? '✅ ✨ Open to All' : '✨ Open to All', callback_data: 'SET_VAL:WORK:ALL' },
          ],
          [backBtn],
        ],
      },
    };
  }

  // ─ Schedule sub-menu ─
  if (menuKey === 'SCHED') {
    return {
      text:
        `⏰ <b>Configure Automation Schedule</b>\n\n` +
        `Current Setting: <b>${settings.cron_description || settings.cron_schedule}</b>\n` +
        `🕒 <b>Candidate Timezone:</b> <code>${settings.timezone || 'America/Toronto'}</code> <i>(Synced from master-profile.json)</i>\n\n` +
        `Select automated execution frequency:`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎯 5x Daily (8:30, 11:30, 2:30, 5:30, 8:30)', callback_data: 'SET_VAL:SCHED:5X' },
            { text: '🌅 3x Daily (8am, 1pm, 6pm)', callback_data: 'SET_VAL:SCHED:3X' },
          ],
          [
            { text: '☀️ Daily (9:00 AM)', callback_data: 'SET_VAL:SCHED:DAILY' },
            { text: '⚡ Every 2 Hours', callback_data: 'SET_VAL:SCHED:2H' },
          ],
          [{ text: '⏱️ Hourly', callback_data: 'SET_VAL:SCHED:HOURLY' }],
          [backBtn],
        ],
      },
    };
  }

  // ─ Job boards toggle sub-menu ─
  if (menuKey === 'BOARDS') {
    const b = settings.boards_enabled || {};
    return {
      text:
        `📋 <b>Configure Enabled Job Boards</b>\n\n` +
        `Tap any board to toggle it On or Off:`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: `LinkedIn: ${b.linkedin !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_linkedin' },
            { text: `Canada Job Bank: ${b.canada_job_bank !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_canada_job_bank' },
          ],
          [
            { text: `Adzuna: ${b.adzuna !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_adzuna' },
            { text: `USAJOBS: ${b.usajobs !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_usajobs' },
          ],
          [
            { text: `Jobicy: ${b.jobicy !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_jobicy' },
            { text: `Remotive: ${b.remotive !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_remotive' },
          ],
          [
            { text: `ArbeitNow: ${b.arbeitnow !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_arbeitnow' },
            { text: `Himalayas: ${b.himalayas !== false ? '✅ On' : '❌ Off'}`, callback_data: 'SET_VAL:BOARD:TOGGLE_himalayas' },
          ],
          [backBtn],
        ],
      },
    };
  }

  // Unknown menu key → show main dashboard
  return renderSettingsDashboard(settings, masterProfile);
}

// ── Handle Telegram Callback Actions ────────────────────────────────────────
// Called when a user taps an inline keyboard button in Telegram.
// Updates the setting in settings.json and returns the refreshed menu.
function handleSettingCallback(data, masterProfile = {}) {
  let settings = getSettings();

  // ─ Handle value updates (SET_VAL:...) ─

  if (data.startsWith('SET_VAL:FRESH:')) {
    const hours = parseInt(data.replace('SET_VAL:FRESH:', ''), 10);
    settings = updateSettings({ freshness_hours: hours });
    return renderSubMenu('FRESH', settings, masterProfile);
  }

  if (data.startsWith('SET_VAL:SCORE:')) {
    const score = parseInt(data.replace('SET_VAL:SCORE:', ''), 10);
    settings = updateSettings({ score_threshold: score });
    return renderSubMenu('SCORE', settings, masterProfile);
  }

  if (data.startsWith('SET_VAL:WORK:')) {
    const modeKey = data.replace('SET_VAL:WORK:', '');
    const modeStr = WORK_MODES[modeKey] || 'Open to All';
    settings = updateSettings({ work_type: modeStr });

    // Also persist work_type to master-profile for scoring consistency
    if (masterProfile && typeof masterProfile === 'object') {
      masterProfile.work_type = modeStr;
      const profilePath = path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json');
      writeJsonFile(profilePath, masterProfile);
    }
    return renderSubMenu('WORK', settings, masterProfile);
  }

  if (data.startsWith('SET_VAL:SCHED:')) {
    const presetKey = data.replace('SET_VAL:SCHED:', '');
    const preset = SCHEDULE_PRESETS[presetKey] || SCHEDULE_PRESETS['3X'];
    settings = updateSettings({ cron_schedule: preset.cron, cron_description: preset.desc });
    return renderSubMenu('SCHED', settings, masterProfile);
  }

  if (data.startsWith('SET_VAL:BOARD:TOGGLE_')) {
    const boardKey = data.replace('SET_VAL:BOARD:TOGGLE_', '');
    const isCurrentlyOn = settings.boards_enabled?.[boardKey] !== false;
    settings = updateSettings({ boards_enabled: { [boardKey]: !isCurrentlyOn } });
    return renderSubMenu('BOARDS', settings, masterProfile);
  }

  // ─ Handle menu navigation (SET_MENU:...) ─

  if (data.startsWith('SET_MENU:')) {
    const menuKey = data.replace('SET_MENU:', '');
    if (menuKey === 'MAIN') return renderSettingsDashboard(settings, masterProfile);
    return renderSubMenu(menuKey, settings, masterProfile);
  }

  // Default: show main dashboard
  return renderSettingsDashboard(settings, masterProfile);
}

module.exports = {
  DEFAULT_SETTINGS,
  SCHEDULE_PRESETS,
  WORK_MODES,
  getSettings,
  updateSettings,
  parseHumanSchedule,
  renderSettingsDashboard,
  renderSubMenu,
  handleSettingCallback,
};
