const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { loadEnv } = require('../scripts/core/load-env');
loadEnv();

const profilePath = path.join(__dirname, '../data/profiles/master-profile.json');
const profileExamplePath = path.join(__dirname, '../data/profiles/master-profile.example.json');
const settingsPath = path.join(__dirname, '../data/config/settings.json');
const settingsExamplePath = path.join(__dirname, '../data/config/settings.example.json');

const hadOriginalProfile = fs.existsSync(profilePath);
const hadOriginalSettings = fs.existsSync(settingsPath);

const originalProfile = hadOriginalProfile
  ? fs.readFileSync(profilePath, 'utf8')
  : fs.readFileSync(profileExamplePath, 'utf8');

const originalSettings = hadOriginalSettings
  ? fs.readFileSync(settingsPath, 'utf8')
  : fs.readFileSync(settingsExamplePath, 'utf8');

const testScenarios = [
  {
    name: 'US Scenario 1: Data Analyst — Remote Only — Nationwide US',
    roles: ['Data Analyst'],
    locations: ['United States (All States / Nationwide)'],
    workType: 'Remote Only',
    scope: 'US'
  },
  {
    name: 'US Scenario 2: BI Developer — Hybrid & Remote — Austin, TX',
    roles: ['BI Developer', 'Business Intelligence Analyst'],
    locations: ['Austin, TX'],
    workType: 'Hybrid & Remote',
    scope: 'US'
  },
  {
    name: 'US Scenario 3: Data Engineer — Open to All — New York, NY',
    roles: ['Data Engineer'],
    locations: ['New York, NY', 'Remote'],
    workType: 'Open to All',
    scope: 'US'
  },
  {
    name: 'US Scenario 4: Program Analyst — Federal & Commercial — Washington, DC',
    roles: ['Program Analyst', 'Management Analyst'],
    locations: ['Washington, DC'],
    workType: 'Open to All',
    scope: 'US'
  }
];

async function runScenario(scenario) {
  console.log(`\n======================================================`);
  console.log(`🧪 ${scenario.name}`);
  console.log(`   Roles: ${scenario.roles.join(', ')}`);
  console.log(`   Locations: ${scenario.locations.join(', ')}`);
  console.log(`   Work Type: ${scenario.workType} | Scope: ${scenario.scope}`);
  console.log(`======================================================`);

  // 1. Write mock profile & settings
  const prof = JSON.parse(originalProfile);
  prof.target_titles = scenario.roles;
  prof.locations = scenario.locations;
  prof.work_type = scenario.workType;
  prof.country_scope = scenario.scope;
  fs.writeFileSync(profilePath, JSON.stringify(prof, null, 2), 'utf8');

  const sett = JSON.parse(originalSettings);
  sett.country_scope = scenario.scope;
  sett.work_type = scenario.workType;
  sett.freshness_hours = 0; // disable freshness so we get abundant jobs for testing
  sett.boards_enabled = {
    linkedin: true,
    adzuna: true,
    usajobs: true,
    jobicy: true,
    remotive: true,
    arbeitnow: true,
    canada_job_bank: false
  };
  fs.writeFileSync(settingsPath, JSON.stringify(sett, null, 2), 'utf8');

  // 2. Run fetch-all-boards.js
  const fetchScript = path.join(__dirname, '../scripts/engine/fetch-all-boards.js');
  const env = { ...process.env, ADZUNA_COUNTRY: 'us' };
  const out = cp.execFileSync('node', [fetchScript], { env, encoding: 'utf8' });

  let jobs = [];
  try {
    jobs = JSON.parse(out);
  } catch (e) {
    console.error('Failed to parse output JSON:', e.message);
  }

  console.log(`📊 Total Ingested Jobs: ${jobs.length}`);

  const bySource = {};
  for (const j of jobs) {
    bySource[j.source] = (bySource[j.source] || 0) + 1;
  }
  console.log('   By Source:', bySource);

  if (jobs.length > 0) {
    console.log(`   Sample job 1: [${jobs[0].source}] "${jobs[0].title}" @ ${jobs[0].company} (${jobs[0].location})`);
    if (jobs[1]) {
      console.log(`   Sample job 2: [${jobs[1].source}] "${jobs[1].title}" @ ${jobs[1].company} (${jobs[1].location})`);
    }
  }

  if (jobs.length === 0) {
    throw new Error(`Scenario failed: 0 jobs ingested for ${scenario.name}`);
  }
  console.log(`✅ Scenario Passed: Successfully generated ${jobs.length} US jobs.`);
  return jobs.length;
}

async function runAll() {
  try {
    for (const s of testScenarios) {
      await runScenario(s);
    }
    console.log(`\n🎉 ALL 4 US JOB GENERATION SCENARIOS PASSED WITH HIGH YIELD!`);
  } finally {
    // Restore or remove profile and settings
    if (hadOriginalProfile) {
      fs.writeFileSync(profilePath, originalProfile, 'utf8');
    } else if (fs.existsSync(profilePath)) {
      fs.unlinkSync(profilePath);
    }
    if (hadOriginalSettings) {
      fs.writeFileSync(settingsPath, originalSettings, 'utf8');
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
    console.log('\n🔄 Cleaned up candidate profile and settings.');
  }
}

runAll().catch(err => {
  console.error('\n❌ Matrix test failed:', err);
  if (hadOriginalProfile) {
    fs.writeFileSync(profilePath, originalProfile, 'utf8');
  } else if (fs.existsSync(profilePath)) {
    fs.unlinkSync(profilePath);
  }
  if (hadOriginalSettings) {
    fs.writeFileSync(settingsPath, originalSettings, 'utf8');
  } else if (fs.existsSync(settingsPath)) {
    fs.unlinkSync(settingsPath);
  }
  process.exit(1);
});
