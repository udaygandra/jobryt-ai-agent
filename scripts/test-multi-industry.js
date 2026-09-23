const assert = require('assert');
const { runParseScore, computeHeuristicScore, evaluateDynamicTitleFit } = require('./node-logic');

console.log('=== MULTI-INDUSTRY UNIVERSAL SCORING VERIFICATION ===\n');

// 1. Candidate: Data Analyst
const dataAnalystProfile = {
  name: 'Data Candidate',
  target_titles: ['Data Analyst', 'Senior Data Analyst', 'Business Intelligence Analyst'],
  skills: ['SQL', 'Power BI', 'Python', 'Excel', 'Data Warehousing']
};

console.log('--- Test Profile 1: Tech / Analytics Candidate ---');
const daJobs = [
  { title: 'Senior Data Analyst, Procurement', expectedPass: true },
  { title: 'Business Intelligence Analyst', expectedPass: true },
  { title: 'RQ10953 - Software Developer - CRM - Senior', expectedPass: false },
  { title: 'Senior Solution Architect', expectedPass: false },
  { title: 'Senior Data Engineer', expectedPass: false },
  { title: 'Registered Nurse - Acute Care', expectedPass: false }
];

daJobs.forEach(job => {
  const scored = runParseScore({ json: { title: job.title, description: 'General duties' } }, dataAnalystProfile).json;
  console.log(`[Role: Data Analyst] Job: "${job.title}" => Score: ${scored.score}, Should Apply: ${scored.should_apply}`);
  if (job.expectedPass) {
    assert.ok(scored.score >= 70, `Expected "${job.title}" to pass for Data Analyst profile`);
  } else {
    assert.ok(scored.score <= 45, `Expected "${job.title}" to be rejected for Data Analyst profile`);
    assert.strictEqual(scored.should_apply, false);
  }
});

// 2. Candidate: Non-Tech Healthcare (Registered Nurse)
console.log('\n--- Test Profile 2: Healthcare / Nursing Candidate ---');
const nurseProfile = {
  name: 'Nurse Candidate',
  target_titles: ['Registered Nurse', 'Staff Nurse', 'Clinical Nurse Specialist'],
  skills: ['Patient Care', 'Triage', 'ICU', 'Medication Administration', 'BLS', 'ACLS']
};

const nurseJobs = [
  { title: 'Registered Nurse - Emergency Dept', expectedPass: true },
  { title: 'Staff Nurse (Full-Time)', expectedPass: true },
  { title: 'Senior Data Analyst', expectedPass: false },
  { title: 'Software Developer', expectedPass: false },
  { title: 'Account Executive', expectedPass: false }
];

nurseJobs.forEach(job => {
  const scored = runParseScore({ json: { title: job.title, description: 'Hospital clinical environment.' } }, nurseProfile).json;
  console.log(`[Role: Nurse] Job: "${job.title}" => Score: ${scored.score}, Should Apply: ${scored.should_apply}`);
  if (job.expectedPass) {
    assert.ok(scored.score >= 70, `Expected "${job.title}" to pass for Nurse profile`);
  } else {
    assert.ok(scored.score <= 45, `Expected "${job.title}" to be rejected for Nurse profile`);
    assert.strictEqual(scored.should_apply, false);
  }
});

// 3. Candidate: Non-Tech Sales / Business
console.log('\n--- Test Profile 3: Commercial Sales Candidate ---');
const salesProfile = {
  name: 'Sales Candidate',
  target_titles: ['Account Executive', 'Enterprise Sales Representative', 'Sales Manager'],
  skills: ['B2B Sales', 'Prospecting', 'CRM', 'Negotiation', 'Closing', 'Pipeline Management']
};

const salesJobs = [
  { title: 'Enterprise Account Executive', expectedPass: true },
  { title: 'Senior Sales Representative - B2B', expectedPass: true },
  { title: 'Data Analyst', expectedPass: false },
  { title: 'Software Developer', expectedPass: false },
  { title: 'Registered Nurse', expectedPass: false }
];

salesJobs.forEach(job => {
  const scored = runParseScore({ json: { title: job.title, description: 'B2B enterprise sales.' } }, salesProfile).json;
  console.log(`[Role: Sales] Job: "${job.title}" => Score: ${scored.score}, Should Apply: ${scored.should_apply}`);
  if (job.expectedPass) {
    assert.ok(scored.score >= 70, `Expected "${job.title}" to pass for Sales profile`);
  } else {
    assert.ok(scored.score <= 45, `Expected "${job.title}" to be rejected for Sales profile`);
    assert.strictEqual(scored.should_apply, false);
  }
});

console.log('\n✅ ALL MULTI-INDUSTRY UNIVERSAL SCORING TESTS PASSED!');
