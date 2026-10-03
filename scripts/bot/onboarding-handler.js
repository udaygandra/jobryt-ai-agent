/**
 * onboarding-handler.js — Interactive Candidate Onboarding State Machine
 *
 * PURPOSE:
 *   Guides the user through a 3-step conversational interview via Telegram:
 *   1. Target Locations & Country Scope (Dynamic from geo-hierarchy.json)
 *   2. Workplace Arrangement (Remote Only / Hybrid & Remote / Onsite / Open to All)
 *   3. Target Roles & Titles (Experience-adjusted suggestions or custom)
 *
 *   Persists verified data to:
 *   - data/profiles/master-profile.json
 *   - data/config/settings.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { loadEnv } = require('../core/load-env');
loadEnv();

const { getDataDir } = require('../core/common-utils');
const {
  loadGeoHierarchy,
  extractLocationOptions,
  parseSmartLocations,
  expandCustomLocationsWithGeo,
  detectTargetCountryScope,
  harmonizeLocationAndWorkType,
  generateSmartRoleSuggestions,
  detectCandidateTimezone
} = require('../core/geo-helper');
const { getSettings, updateSettings } = require('../core/settings-helper');
const { parseResume, roundYearsOfExperience } = require('../engine/resume-to-profile');

const botToken = process.env.TELEGRAM_BOT_TOKEN;

// ── Telegram Transport Helper ────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!botToken || !chatId) return null;
  return new Promise(resolve => {
    const payload = JSON.stringify({
      chat_id: chatId,
      parse_mode: 'HTML',
      text,
      ...(replyMarkup && { reply_markup: replyMarkup })
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function answerCallbackQuery(callbackQueryId, text = null) {
  if (!botToken || !callbackQueryId) return;
  return new Promise(resolve => {
    const payload = JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(text && { text })
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/answerCallbackQuery`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// ── State Persistence ────────────────────────────────────────────────────────
function getStateFilePath() {
  const dataDir = getDataDir();
  const dir = path.join(dataDir, 'bot');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'telegram_state.json');
}

function getActiveState(chatId) {
  if (!chatId) return null;
  const statePath = getStateFilePath();
  try {
    if (fs.existsSync(statePath)) {
      const all = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const st = all[String(chatId)];
      if (st && (Date.now() - (st.timestamp || 0)) < 1800000) { // 30-min TTL
        return st;
      }
    }
  } catch (e) {}
  return null;
}

function setActiveState(chatId, stateObj) {
  if (!chatId) return;
  const statePath = getStateFilePath();
  let all = {};
  try {
    if (fs.existsSync(statePath)) {
      all = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) {}
  if (stateObj) {
    all[String(chatId)] = { ...stateObj, timestamp: Date.now() };
  } else {
    delete all[String(chatId)];
  }
  try {
    fs.writeFileSync(statePath, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {}
}

// ── Step 0: Start Onboarding (Resume Ingestion) ──────────────────────────────
async function startOnboarding(filePath, chatId) {
  console.log(`[Onboarding] Starting interactive onboarding for chat ${chatId} with ${filePath}`);
  await sendTelegramMessage(
    chatId,
    `⏳ <b>Ingesting Resume...</b>\n<i>Parsing career history, verified achievements, and skills with zero fabrication.</i>`
  );

  try {
    const profile = await parseResume(filePath, { dryRun: false, isTest: false, deleteAfterParsing: true });
    if (!profile || !profile.name) {
      throw new Error('Failed to extract candidate name or experience from resume.');
    }

    // Stage parsed profile
    const dataDir = getDataDir();
    const profilesDir = path.join(dataDir, 'profiles');
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'staged_imported_profile.json'), JSON.stringify(profile, null, 2));

    const scannedExp = profile.years_of_experience || 0;
    const roundedExp = roundYearsOfExperience(scannedExp);
    profile.years_of_experience = roundedExp;

    const locationOptions = extractLocationOptions(profile);
    const roleData = generateSmartRoleSuggestions(profile);

    // Save initial state for Experience Confirmation
    setActiveState(chatId, {
      action: 'AWAIT_EXP_CONFIRMATION',
      stagedProfile: profile,
      locationOptions,
      primaryRole: roleData.primaryRole,
      seniorityRole: roleData.seniorityRole,
      yearsOfExp: roundedExp,
      variationsStr: roleData.variationsStr
    });

    const detectedLoc = profile.contact?.location || profile.locations?.[0] || 'Detected from profile';
    const totalBullets = (profile.experience || []).reduce((acc, exp) => acc + (exp.bullets ? exp.bullets.length : 0), 0);

    const msg = `✅ <b>RESUME PARSED SUCCESSFULLY!</b>\n\n` +
      `👤 <b>Candidate:</b> ${profile.name}\n` +
      `💼 <b>Roles Extracted:</b> ${(profile.experience || []).length} positions (${totalBullets} bullets preserved)\n` +
      `🛠️ <b>Skills Indexed:</b> ${(profile.skills || []).length} verified skills\n` +
      `📍 <b>Detected Home Base:</b> ${detectedLoc}\n` +
      `⏳ <b>Scanned Total Experience:</b> <code>${roundedExp} years</code>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏳ <b>Verify Years of Experience</b>\n` +
      `We scanned <b>${roundedExp} years</b> of experience from your resume.\n\n` +
      `Is this accurate? If not, please enter your total years (e.g. <code>6</code>, <code>6.5</code>, <code>7</code>):\n` +
      `• <i>Tap <b>"Confirm ${roundedExp} Years"</b> below, OR</i>\n` +
      `• <i>Reply in chat with your exact years (e.g. <code>6</code>, <code>6.5</code>, <code>7</code>)</i>`;

    const inline_keyboard = [
      [{ text: `✅ Confirm ${roundedExp} Years`, callback_data: 'ONBOARD_EXP:CONFIRM' }],
      [{ text: '✍️ Type Custom Years in Chat', callback_data: 'ONBOARD_EXP:CUSTOM' }]
    ];

    await sendTelegramMessage(chatId, msg, { inline_keyboard });
    console.log(`[Onboarding] Experience verification prompt delivered to chat ${chatId}`);
    return true;
  } catch (err) {
    console.error(`[Onboarding] Ingestion failed:`, err);
    await sendTelegramMessage(
      chatId,
      `❌ <b>Resume Ingestion Failed:</b>\n${err.message}\n\nPlease check the file format (.pdf/.docx/.txt) and try again.`
    );
    return false;
  } finally {
    // Delete the resume file after parsing into JSON
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Onboarding] Deleted resume file after parsing into JSON: ${filePath}`);
      }
    } catch (e) {
      console.warn(`[Onboarding] Warning deleting resume file: ${e.message}`);
    }
  }
}

// ── Step 0.5 Handling: Experience Verification ────────────────────────────────
async function handleExpStep(chatId, choiceVal, isCustom = false) {
  const userState = getActiveState(chatId);
  if (!userState || !userState.stagedProfile) return false;

  if (choiceVal === 'CUSTOM' && !isCustom) {
    await sendTelegramMessage(
      chatId,
      `✍️ <b>Custom Years of Experience:</b>\n\nPlease reply in chat with your total years of experience (e.g. <code>6</code>, <code>6.5</code>, <code>7</code>).\n\n<i>(Type <code>/cancel</code> to abort)</i>`
    );
    return true;
  }

  let finalYears = userState.yearsOfExp || 1;
  if (isCustom) {
    const rawNum = parseFloat(String(choiceVal).replace(/[^0-9.]/g, ''));
    if (!isNaN(rawNum) && rawNum >= 0) {
      finalYears = roundYearsOfExperience(rawNum);
    }
  } else {
    finalYears = roundYearsOfExperience(userState.yearsOfExp || 1);
  }

  userState.stagedProfile.years_of_experience = finalYears;
  userState.yearsOfExp = finalYears;

  // Re-generate smart role suggestions with verified experience
  const roleData = generateSmartRoleSuggestions(userState.stagedProfile);
  userState.primaryRole = userState.primaryRole || roleData.primaryRole;
  userState.seniorityRole = roleData.seniorityRole;
  userState.variationsStr = userState.variationsStr || roleData.variationsStr;
  if (!userState.variationsStr.includes(';') && roleData.variationsStr.includes(';')) {
    userState.variationsStr = roleData.variationsStr;
  }

  return await sendLocationStepPrompt(chatId, userState);
}

async function sendLocationStepPrompt(chatId, userState) {
  const locationOptions = userState.locationOptions || extractLocationOptions(userState.stagedProfile);

  setActiveState(chatId, {
    action: 'AWAIT_LOCATION_CHOICE',
    stagedProfile: userState.stagedProfile,
    locationOptions,
    primaryRole: userState.primaryRole || 'Target Role',
    seniorityRole: userState.seniorityRole || 'Target Role',
    yearsOfExp: userState.stagedProfile.years_of_experience,
    variationsStr: userState.variationsStr || 'Target Role'
  });

  const geo = loadGeoHierarchy();
  const inline_keyboard = locationOptions.map((opt, idx) => {
    let icon = '📍';
    const low = opt.toLowerCase();
    if (geo.caProvs.has(low) || low.includes('canada') || low.includes('gta') || low.includes('toronto') || low.includes('vancouver') || low.includes('montreal') || low.includes('calgary') || low.includes('ottawa')) {
      icon = '🍁';
    } else if (geo.usStates.has(low) || low.includes('united states') || low.includes('usa') || low.includes('tx') || low.includes('ny') || low.includes('ca')) {
      icon = '🇺🇸';
    } else if (low.includes('remote') || low.includes('anywhere') || low.includes('worldwide')) {
      icon = '🌐';
    } else if (low.includes('north america') || low.includes('us & canada')) {
      icon = '🌎';
    }
    return [{ text: `${icon} ${opt}`, callback_data: `ONBOARD_LOC:${idx}` }];
  });
  inline_keyboard.push([{ text: '✍️ Type Custom Location(s)', callback_data: 'ONBOARD_LOC:CUSTOM' }]);

  const msg = `⏳ <b>Verified Experience:</b> <b>${userState.stagedProfile.years_of_experience} years</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📍 <b>Step 1 of 3: Target Geographic Scope</b>\n` +
    `Where do you want to target your job search?\n\n` +
    `• <i>Tap a suggested scope below, OR</i>\n` +
    `• <i>Tap 'Type Custom' or type directly in chat (e.g. <code>Toronto, ON; Remote</code> or <code>Austin, TX</code>)</i>`;

  await sendTelegramMessage(chatId, msg, { inline_keyboard });
  console.log(`[Onboarding] Step 1 prompt delivered to chat ${chatId}`);
  return true;
}

// ── Step 1 Handling: Location Choice ─────────────────────────────────────────
async function handleLocationStep(chatId, choiceVal, isCustom = false) {
  const userState = getActiveState(chatId);
  if (!userState || !userState.stagedProfile) return false;

  let chosenLocs = [];
  let nearestNote = '';

  if (choiceVal === 'CUSTOM' || isCustom) {
    if (choiceVal === 'CUSTOM' && !isCustom) {
      await sendTelegramMessage(
        chatId,
        `✍️ <b>Custom Target Location(s):</b>\n\nPlease reply with your target city/region (e.g. <code>Toronto, ON; Remote</code> or <code>Austin, TX</code> or <code>Vancouver, BC</code>).\n\n<i>(Type <code>/cancel</code> to abort)</i>`
      );
      return true;
    }
    const expansion = expandCustomLocationsWithGeo(choiceVal);
    chosenLocs = expansion.locations;
    if (expansion.note) nearestNote = `\n${expansion.note}`;
  } else {
    const locIdx = parseInt(choiceVal);
    const locOpts = userState.locationOptions || ['Remote / Anywhere'];
    const chosen = (!isNaN(locIdx) && locOpts[locIdx]) ? locOpts[locIdx] : locOpts[0];
    chosenLocs = [chosen];
  }

  userState.stagedProfile.locations = chosenLocs;
  const detectedScope = detectTargetCountryScope(chosenLocs);

  setActiveState(chatId, {
    action: 'AWAIT_WORK_TYPE_CHOICE',
    stagedProfile: userState.stagedProfile,
    locationOptions: userState.locationOptions,
    countryScope: detectedScope,
    primaryRole: userState.primaryRole || 'Target Role',
    seniorityRole: userState.seniorityRole || userState.primaryRole || 'Target Role',
    yearsOfExp: userState.yearsOfExp || 1,
    variationsStr: userState.variationsStr || 'Target Role; Senior Target Role'
  });

  const msg = `📍 <b>Target Location Configured:</b> ${chosenLocs.join(', ')} <i>(Scope: ${detectedScope})</i>${nearestNote}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏢 <b>Step 2 of 3: Workplace Arrangement</b>\n` +
    `What type of work setup are you targeting?\n\n` +
    `• <b>Remote Only:</b> 100% Work from Home (strictly excludes onsite)\n` +
    `• <b>Hybrid & Remote:</b> Flexible (open to 1–3 office days or remote)\n` +
    `• <b>Onsite / Any:</b> Open to office, hybrid, or remote\n` +
    `• <b>Open to All:</b> Cast widest possible net`;

  const inline_keyboard = [
    [
      { text: '🌐 Remote Only', callback_data: 'ONBOARD_WORK:REMOTE' },
      { text: '🏢 Hybrid & Remote', callback_data: 'ONBOARD_WORK:HYBRID' }
    ],
    [
      { text: '📍 Onsite / Any', callback_data: 'ONBOARD_WORK:ONSITE' },
      { text: '✨ Open to All', callback_data: 'ONBOARD_WORK:ALL' }
    ]
  ];

  await sendTelegramMessage(chatId, msg, { inline_keyboard });
  return true;
}

// ── Step 2 Handling: Work Type Choice ────────────────────────────────────────
async function handleWorkTypeStep(chatId, rawMode) {
  const userState = getActiveState(chatId);
  if (!userState || !userState.stagedProfile) return false;

  let modeStr = 'Open to All';
  const low = String(rawMode).toLowerCase();
  if (low.includes('remote') && !low.includes('hybrid') && !low.includes('all')) {
    modeStr = 'Remote Only';
  } else if (low.includes('hybrid')) {
    modeStr = 'Hybrid & Remote';
  } else if (low.includes('onsite') || low.includes('on-site')) {
    modeStr = 'Onsite / Any';
  } else {
    modeStr = 'Open to All';
  }

  const fallbackCity = userState.locationOptions?.[0] || null;
  const harmonized = harmonizeLocationAndWorkType(userState.stagedProfile.locations, modeStr, fallbackCity);
  userState.stagedProfile.locations = harmonized.locations;
  userState.stagedProfile.work_type = harmonized.work_type;

  setActiveState(chatId, {
    action: 'AWAIT_ROLE_CHOICE',
    stagedProfile: userState.stagedProfile,
    locationOptions: userState.locationOptions,
    countryScope: userState.countryScope || detectTargetCountryScope(harmonized.locations),
    primaryRole: userState.primaryRole || 'Target Role',
    seniorityRole: userState.seniorityRole || userState.primaryRole || 'Target Role',
    yearsOfExp: userState.yearsOfExp || 1,
    variationsStr: userState.variationsStr || 'Target Role'
  });

  const noteText = harmonized.harmonizationNote ? `\n<i>${harmonized.harmonizationNote}</i>` : '';
  const expLabel = userState.yearsOfExp > 0 ? ` (${userState.yearsOfExp}+ yrs verified exp)` : '';

  const msg = `🏢 <b>Workplace Mode Configured:</b> <b>${harmonized.work_type}</b>${noteText}\n` +
    `📍 <b>Active Locations:</b> ${harmonized.locations.join(', ')}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Step 3 of 3: Target Job Titles</b>\n\n` +
    `Suggested roles based on your career trajectory${expLabel}:\n` +
    `1️⃣ <b>${userState.primaryRole}</b> <i>(Primary role)</i>\n` +
    `2️⃣ <b>${userState.seniorityRole}</b> <i>(Seniority-aligned)</i>\n` +
    `3️⃣ <b>${userState.variationsStr}</b> <i>(All variations)</i>\n\n` +
    `• <i>Tap a button below, OR</i>\n` +
    `• <i>Type custom titles in chat (e.g. <code>Data Analyst; BI Analyst; Analytics Specialist</code>)</i>`;

  const inline_keyboard = [
    [{ text: `🎯 ${userState.primaryRole} (Primary)`, callback_data: 'ONBOARD_ROLE:PRIMARY' }],
    [{ text: `🚀 ${userState.seniorityRole} (Exp-Aligned)`, callback_data: 'ONBOARD_ROLE:SENIORITY' }],
    [{ text: '💡 All Suggested Variations', callback_data: 'ONBOARD_ROLE:VARIATIONS' }],
    [{ text: '✍️ Type Custom Titles in Chat', callback_data: 'ONBOARD_ROLE:CUSTOM' }]
  ];

  await sendTelegramMessage(chatId, msg, { inline_keyboard });
  return true;
}

// ── Step 3 Handling: Target Roles Choice ─────────────────────────────────────
async function handleRoleStep(chatId, choiceVal, isCustom = false) {
  const userState = getActiveState(chatId);
  if (!userState || !userState.stagedProfile) return false;

  let chosenRoles = [];

  if (choiceVal === 'CUSTOM' && !isCustom) {
    await sendTelegramMessage(
      chatId,
      `✍️ <b>Custom Target Roles:</b>\n\nPlease reply with your desired titles separated by semicolons (e.g. <code>Data Analyst; Business Intelligence Analyst; Analytics Engineer</code>).\n\n<i>(Type <code>/cancel</code> to abort)</i>`
    );
    return true;
  }

  if (isCustom) {
    chosenRoles = choiceVal.split(/[;,|\r\n]+/).map(s => s.trim()).filter(Boolean);
    if (chosenRoles.length === 0) chosenRoles = [userState.primaryRole || 'Target Role'];
  } else if (choiceVal === 'PRIMARY') {
    chosenRoles = [userState.primaryRole || 'Target Role'];
  } else if (choiceVal === 'SENIORITY') {
    chosenRoles = [userState.seniorityRole || userState.primaryRole || 'Target Role'];
  } else if (choiceVal === 'VARIATIONS') {
    chosenRoles = (userState.variationsStr || userState.primaryRole || 'Target Role')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
  } else {
    chosenRoles = [userState.primaryRole || 'Target Role'];
  }

  // Finalize Master Profile
  const finalProfile = userState.stagedProfile;
  finalProfile.target_titles = chosenRoles;
  finalProfile.country_scope = userState.countryScope || detectTargetCountryScope(finalProfile.locations);

  const dataDir = getDataDir();
  const profilesDir = path.join(dataDir, 'profiles');
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

  const isTest = process.env.TEST_MODE === 'true' || process.env.NODE_ENV === 'test';
  const masterPath = isTest ? path.join(profilesDir, 'test-master-profile.json') : path.join(profilesDir, 'master-profile.json');
  const backupPath = isTest ? path.join(profilesDir, 'test-master-profile.backup.json') : path.join(profilesDir, 'master-profile.backup.json');

  if (!finalProfile.timezone) {
    finalProfile.timezone = detectCandidateTimezone(finalProfile);
  }

  try {
    if (fs.existsSync(masterPath)) {
      try { fs.writeFileSync(backupPath, fs.readFileSync(masterPath)); } catch (e) {}
    }
    fs.writeFileSync(masterPath, JSON.stringify(finalProfile, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving master profile:', err);
  }

  // Synchronize with settings.json
  updateSettings({
    work_type: finalProfile.work_type,
    country_scope: finalProfile.country_scope,
    timezone: finalProfile.timezone
  }, finalProfile);

  // Clear Onboarding State
  setActiveState(chatId, null);

  const totalBullets = (finalProfile.experience || []).reduce((acc, exp) => acc + (exp.bullets ? exp.bullets.length : 0), 0);
  const skillsList = Array.isArray(finalProfile.skills) ? finalProfile.skills : [];

  const msg = `🎉 <b>MASTER PROFILE CONFIGURED & ACTIVATED!</b>\n\n` +
    `👤 <b>Candidate:</b> ${finalProfile.name || 'Candidate'}\n` +
    `🎯 <b>Target Roles:</b> ${finalProfile.target_titles.join(', ')}\n` +
    `📍 <b>Target Locations:</b> ${finalProfile.locations.join(', ')} <i>(Scope: ${finalProfile.country_scope})</i>\n` +
    `🏢 <b>Workplace Mode:</b> ${finalProfile.work_type || 'Open to All'}\n` +
    `🕒 <b>Scheduler Timezone:</b> <code>${finalProfile.timezone}</code>\n\n` +
    `💼 <b>Verified Experience:</b> ${(finalProfile.experience || []).length} Roles (${totalBullets} bullets preserved verbatim)\n` +
    `🛠️ <b>Verified Skills:</b> ${skillsList.length} skills indexed\n\n` +
    `💾 <b>Saved to:</b> <code>data/profiles/master-profile.json</code>\n` +
    `⚙️ <b>Settings Synced:</b> Multi-board scraper and LLM scoring are now aligned with your preferences.\n\n` +
    `🚀 <b>Ready for Action!</b> Tap a button below to get started:`;

  const inline_keyboard = [
    [
      { text: '🔍 Find Jobs Now (Multi-Board Scan)', callback_data: 'TRIGGER_PIPELINE' }
    ],
    [
      { text: '⚙️ Settings Dashboard', callback_data: 'SET_MENU:MAIN' },
      { text: '📄 View Master Profile', callback_data: 'VIEW_PROFILE' }
    ]
  ];

  await sendTelegramMessage(chatId, msg, { inline_keyboard });
  console.log(`[Onboarding] Completed successfully for candidate ${finalProfile.name}`);
  return true;
}

// ── Unified Update Router ───────────────────────────────────────────────────
async function processUpdate(update) {
  // 1. Callback Query Handler
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const chatId = cb.from?.id || cb.message?.chat?.id;
    const cbId = cb.id;

    if (data.startsWith('ONBOARD_EXP:')) {
      await answerCallbackQuery(cbId);
      const choice = data.replace('ONBOARD_EXP:', '');
      return await handleExpStep(chatId, choice, false);
    }

    if (data.startsWith('ONBOARD_LOC:')) {
      await answerCallbackQuery(cbId);
      const choice = data.replace('ONBOARD_LOC:', '');
      return await handleLocationStep(chatId, choice, false);
    }

    if (data.startsWith('ONBOARD_WORK:')) {
      await answerCallbackQuery(cbId);
      const choice = data.replace('ONBOARD_WORK:', '');
      return await handleWorkTypeStep(chatId, choice);
    }

    if (data.startsWith('ONBOARD_ROLE:')) {
      await answerCallbackQuery(cbId);
      const choice = data.replace('ONBOARD_ROLE:', '');
      return await handleRoleStep(chatId, choice, false);
    }
  }

  // 2. Direct Text Message Handler
  if (update.message && update.message.text) {
    const text = update.message.text.trim();
    const chatId = update.message.from?.id || update.message.chat?.id;

    if (text.startsWith('/')) {
      if (['/cancel', '/abort', '/stop'].includes(text.toLowerCase().split(' ')[0])) {
        const state = getActiveState(chatId);
        if (state) {
          setActiveState(chatId, null);
          await sendTelegramMessage(chatId, `✅ <b>Onboarding Cancelled.</b> Your previous profile remains unchanged.`);
          return true;
        }
      }
      return false; // Let standard command handlers deal with slash commands
    }

    const state = getActiveState(chatId);
    if (!state) return false;

    if (state.action === 'AWAIT_EXP_CONFIRMATION') {
      return await handleExpStep(chatId, text, true);
    }
    if (state.action === 'AWAIT_LOCATION_CHOICE') {
      return await handleLocationStep(chatId, text, true);
    }
    if (state.action === 'AWAIT_WORK_TYPE_CHOICE') {
      return await handleWorkTypeStep(chatId, text);
    }
    if (state.action === 'AWAIT_ROLE_CHOICE') {
      return await handleRoleStep(chatId, text, true);
    }
  }

  return false;
}

module.exports = {
  startOnboarding,
  processUpdate,
  getActiveState,
  setActiveState,
  sendTelegramMessage
};
