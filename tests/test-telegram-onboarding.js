/**
 * test-telegram-onboarding.js — Comprehensive Test Suite for Conversational Onboarding
 *
 * Verifies:
 * 1. Geographic extraction from candidate profiles (CA, US, Worldwide).
 * 2. Smart role generation based on experience heuristics.
 * 3. State machine transitions:
 *    - Ingestion -> AWAIT_LOCATION_CHOICE
 *    - Location selection -> AWAIT_WORK_TYPE_CHOICE
 *    - Workplace selection -> AWAIT_ROLE_CHOICE
 *    - Role selection -> Master Profile & Settings synchronization.
 * 4. Multi-board ingestion and LLM score engine compatibility.
 */

process.env.TEST_MODE = 'true';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  loadGeoHierarchy,
  extractLocationOptions,
  parseSmartLocations,
  expandCustomLocationsWithGeo,
  detectTargetCountryScope,
  harmonizeLocationAndWorkType,
  generateSmartRoleSuggestions,
  isJobLocationEligible,
  isJobWorkplaceEligible,
  isJobRoleRelevant
} = require('../scripts/core/geo-helper');

const onboardingHandler = require('../scripts/bot/onboarding-handler');
const { getSettings } = require('../scripts/core/settings-helper');

const profilePath = path.join(__dirname, '../data/profiles/master-profile.json');
const settingsPath = path.join(__dirname, '../data/config/settings.json');
const originalProfileData = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : null;
const originalSettingsData = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;

console.log('🧪 Starting Telegram Onboarding & Preference Verification Tests...\n');

// ── Test 1: Geo Hierarchy & Location Extraction ─────────────────────────────
console.log('Test 1: Geographic Hierarchy & Extraction...');
const caProfile = {
  name: 'Canadian Candidate',
  contact: { location: 'Toronto, Ontario, Canada' },
  target_titles: ['Data Analyst'],
  experience: [{ dates: '2020 - 2024', bullets: ['Built dashboards'] }]
};

const caOptions = extractLocationOptions(caProfile);
console.log('   CA Options:', caOptions);
assert(caOptions.some(o => o.includes('GTA') || o.includes('Toronto')), 'Should include GTA or Toronto');
assert(caOptions.some(o => o.includes('Canada')), 'Should include Canada');
assert(caOptions.some(o => o.includes('Remote')), 'Should include Remote');

const usProfile = {
  name: 'US Candidate',
  contact: { location: 'Austin, Texas, United States' },
  target_titles: ['Software Engineer'],
  experience: [{ dates: '2018 - 2024', bullets: ['Backend systems'] }]
};

const usOptions = extractLocationOptions(usProfile);
console.log('   US Options:', usOptions);
assert(usOptions.some(o => o.includes('Austin') || o.includes('Texas')), 'Should include Austin or Texas');
assert(usOptions.some(o => o.includes('United States')), 'Should include United States');
assert(usOptions.some(o => o.includes('Remote')), 'Should include Remote');
console.log('   ✅ Test 1 Passed.\n');

// ── Test 2: Country Scope Detection ─────────────────────────────────────────
console.log('Test 2: Country Scope Routing...');
assert.strictEqual(detectTargetCountryScope(['Toronto, ON']), 'CA');
assert.strictEqual(detectTargetCountryScope(['Austin, TX']), 'US');
assert.strictEqual(detectTargetCountryScope(['Toronto, ON', 'Austin, TX']), 'US_CA');
assert.strictEqual(detectTargetCountryScope(['North America (US & Canada)']), 'US_CA');
assert.strictEqual(detectTargetCountryScope(['Remote / Anywhere']), 'GLOBAL');
console.log('   ✅ Test 2 Passed.\n');

// ── Test 3: Role Heuristics ─────────────────────────────────────────────────
console.log('Test 3: Role Generation & Experience Heuristics...');
const juniorCandidate = {
  target_titles: ['Data Analyst'],
  experience: [{ dates: '2023 - 2024' }]
};
const seniorCandidate = {
  target_titles: ['Data Analyst'],
  experience: [{ dates: '2018 - 2024' }]
};
const leadCandidate = {
  target_titles: ['Data Analyst'],
  experience: [{ dates: '2014 - 2024' }]
};

const jRoles = generateSmartRoleSuggestions(juniorCandidate);
const sRoles = generateSmartRoleSuggestions(seniorCandidate);
const lRoles = generateSmartRoleSuggestions(leadCandidate);

assert.strictEqual(jRoles.seniorityRole, 'Associate Data Analyst');
assert.strictEqual(sRoles.seniorityRole, 'Senior Data Analyst');
assert.strictEqual(lRoles.seniorityRole, 'Lead Data Analyst');
console.log('   Junior:', jRoles.seniorityRole);
console.log('   Senior:', sRoles.seniorityRole);
console.log('   Lead:', lRoles.seniorityRole);
console.log('   ✅ Test 3 Passed.\n');

// ── Test 4: Location & Work Type Harmonization ──────────────────────────────
console.log('Test 4: Location & Workplace Harmonization...');
const remoteHarmonized = harmonizeLocationAndWorkType(['Toronto, ON'], 'Remote Only');
assert(remoteHarmonized.locations.includes('Toronto, ON'), 'Locations should preserve target city');
assert.strictEqual(remoteHarmonized.work_type, 'Remote Only');

const hybridHarmonized = harmonizeLocationAndWorkType([], 'Hybrid & Remote', 'Toronto, ON');
assert(hybridHarmonized.locations.includes('Toronto, ON'), 'Hybrid should inherit detected city if empty');
console.log('   ✅ Test 4 Passed.\n');

// ── Test 5: Onboarding State Machine End-to-End Simulation ──────────────────
console.log('Test 5: Full Onboarding State Machine Transitions...');
const testChatId = '999999999';

// Setup Mock Staged Profile in state
onboardingHandler.setActiveState(testChatId, {
  action: 'AWAIT_LOCATION_CHOICE',
  stagedProfile: {
    name: 'Test Candidate',
    contact: { email: 'test@example.com', location: 'Toronto, ON' },
    skills: ['SQL', 'Python', 'Power BI'],
    experience: [{ role: 'Analyst', company: 'ABC Corp', dates: '2021-2024', bullets: ['Data reporting'] }]
  },
  locationOptions: ['GTA (Greater Toronto Area)', 'Canada (All Provinces / Nationwide)', 'Worldwide / Global Remote'],
  primaryRole: 'Data Analyst',
  seniorityRole: 'Senior Data Analyst',
  yearsOfExp: 4,
  variationsStr: 'Data Analyst; Business Intelligence Analyst'
});

(async () => {
  try {
    // Step 1: User selects Location Option 0 ("GTA (Greater Toronto Area)")
    const updateStep1 = {
      callback_query: {
        id: 'cb_1',
        data: 'ONBOARD_LOC:0',
        from: { id: testChatId }
      }
    };

    const handled1 = await onboardingHandler.processUpdate(updateStep1);
    assert(handled1, 'Step 1 should be handled');
    const stateAfter1 = onboardingHandler.getActiveState(testChatId);
    assert.strictEqual(stateAfter1.action, 'AWAIT_WORK_TYPE_CHOICE', 'Should advance to AWAIT_WORK_TYPE_CHOICE');
    assert.deepStrictEqual(stateAfter1.stagedProfile.locations, ['GTA (Greater Toronto Area)']);

    // Step 2: User selects Workplace Mode "Remote Only"
    const updateStep2 = {
      callback_query: {
        id: 'cb_2',
        data: 'ONBOARD_WORK:REMOTE',
        from: { id: testChatId }
      }
    };

    const handled2 = await onboardingHandler.processUpdate(updateStep2);
    assert(handled2, 'Step 2 should be handled');
    const stateAfter2 = onboardingHandler.getActiveState(testChatId);
    assert.strictEqual(stateAfter2.action, 'AWAIT_ROLE_CHOICE', 'Should advance to AWAIT_ROLE_CHOICE');
    assert.strictEqual(stateAfter2.stagedProfile.work_type, 'Remote Only');
    assert.deepStrictEqual(stateAfter2.stagedProfile.locations, ['GTA (Greater Toronto Area)']);

    // Step 3: User selects "All Suggested Variations"
    const updateStep3 = {
      callback_query: {
        id: 'cb_3',
        data: 'ONBOARD_ROLE:VARIATIONS',
        from: { id: testChatId }
      }
    };

    const handled3 = await onboardingHandler.processUpdate(updateStep3);
    assert(handled3, 'Step 3 should be handled');
    const finalState = onboardingHandler.getActiveState(testChatId);
    assert.strictEqual(finalState, null, 'State should be cleared upon final profile activation');

    // Verify master-profile.json was written correctly by the state machine
    const savedProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.strictEqual(savedProfile.name, 'Test Candidate');
    assert.strictEqual(savedProfile.work_type, 'Remote Only');
    assert(savedProfile.target_titles.length >= 2, 'Should have multiple target titles');
    assert.strictEqual(savedProfile.country_scope, 'CA', 'Country scope should be CA');

    // Verify settings.json
    const settings = getSettings();
    assert.strictEqual(settings.work_type, 'Remote Only');
    assert.strictEqual(settings.country_scope, 'CA');

    console.log('   ✅ Test 5 Passed: Profile & Settings verified on disk.\n');

    // ── Test 6: Ingestion Filter Verification with Activated Profile ───────────
    console.log('Test 6: Ingestion Filter Compatibility...');
    const testJob1 = {
      title: 'Senior Data Analyst',
      location: 'Toronto, ON',
      description: 'We offer full remote work options.'
    };
    const testJob2 = {
      title: 'Registered Nurse',
      location: 'Calgary, AB',
      description: 'On-site hospital environment.'
    };

    // Test 6: Ingestion Filter Compatibility (Smart role relevance - rejects unrelated professions)
    assert(isJobRoleRelevant(testJob1.title, savedProfile.target_titles), 'Senior Data Analyst should pass');
    assert(!isJobRoleRelevant(testJob2.title, savedProfile.target_titles), 'Registered Nurse should be rejected');

    assert(isJobLocationEligible(testJob1.location, savedProfile.locations, savedProfile.country_scope), 'Toronto should be eligible');
    assert(isJobWorkplaceEligible(testJob1.location, testJob1.description, testJob1.title, savedProfile.work_type), 'Remote job should be eligible for Remote Only');
    assert(!isJobWorkplaceEligible(testJob2.location, testJob2.description, testJob2.title, savedProfile.work_type), 'Onsite job should be rejected for Remote Only');

    // Test 6b: LinkedIn Matching Model Verification (Remote vs Hybrid vs Onsite)
    console.log('   Testing LinkedIn Model A: Toronto candidate with Remote Only:');
    const torontoLocs = ['GTA (Greater Toronto Area)'];
    assert(isJobLocationEligible('Toronto, ON (Remote)', torontoLocs, 'CA'), 'Toronto Remote -> Accepted');
    assert(isJobLocationEligible('Mississauga, ON (Remote)', torontoLocs, 'CA'), 'GTA/Mississauga Remote -> Accepted');
    assert(isJobLocationEligible('Vancouver, BC (Remote)', torontoLocs, 'CA'), 'Vancouver Remote -> Accepted (Remote within Canada)');
    assert(isJobLocationEligible('Calgary, AB (Remote)', torontoLocs, 'CA'), 'Calgary Remote -> Accepted (Remote within Canada)');
    assert(isJobLocationEligible('Remote, Canada', torontoLocs, 'CA'), 'Pure Remote Canada -> Accepted');
    assert(!isJobLocationEligible('Austin, TX (Remote)', torontoLocs, 'CA'), 'US Remote -> Rejected for CA scope');

    console.log('   Testing LinkedIn Model B: Toronto candidate with Hybrid & Remote:');
    assert(isJobLocationEligible('Toronto, ON', torontoLocs, 'CA'), 'Toronto Onsite/Hybrid -> Accepted (Local commute)');
    assert(isJobLocationEligible('Mississauga, ON', torontoLocs, 'CA'), 'GTA Onsite/Hybrid -> Accepted (Local commute)');
    assert(isJobLocationEligible('Vancouver, BC (Remote)', torontoLocs, 'CA'), 'Vancouver Remote -> Accepted');
    assert(!isJobLocationEligible('Vancouver, BC', torontoLocs, 'CA'), 'Vancouver Onsite/Hybrid -> Rejected (Cannot commute)');
    assert(!isJobLocationEligible('Calgary, AB', torontoLocs, 'CA'), 'Calgary Onsite/Hybrid -> Rejected (Cannot commute)');

    console.log('   Testing LinkedIn Model C: Worldwide candidate with Remote Only:');
    const globalLocs = ['Worldwide / Global Remote'];
    assert(isJobLocationEligible('Toronto, ON (Remote)', globalLocs, 'GLOBAL'), 'Toronto Remote -> Accepted');
    assert(isJobLocationEligible('London, UK (Remote)', globalLocs, 'GLOBAL'), 'UK Remote -> Accepted');
    assert(isJobLocationEligible('San Francisco, CA (Remote)', globalLocs, 'GLOBAL'), 'SF Remote -> Accepted');

    console.log('   ✅ Test 6 Passed: LinkedIn matching model verified.\n');
    console.log('🎉 ALL ONBOARDING & PREFERENCE MAPPING TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    // Restore original profile and settings so tests never corrupt live candidate profile
    try {
      if (originalProfileData) {
        fs.writeFileSync(profilePath, originalProfileData, 'utf8');
      } else if (fs.existsSync(profilePath)) {
        fs.unlinkSync(profilePath);
      }
      if (originalSettingsData && settingsPath) {
        fs.writeFileSync(settingsPath, originalSettingsData, 'utf8');
      } else if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
      }
      const backupTestPath = path.join(__dirname, '../data/profiles/test-master-profile.backup.json');
      if (fs.existsSync(backupTestPath)) fs.unlinkSync(backupTestPath);
      const testProfPath = path.join(__dirname, '../data/profiles/test-master-profile.json');
      if (fs.existsSync(testProfPath)) fs.unlinkSync(testProfPath);
    } catch (_) {}
  }
})();

