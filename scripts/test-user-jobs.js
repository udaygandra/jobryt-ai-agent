const assert = require('assert');
const { runParseScore, computeHeuristicScore } = require('../scripts/node-logic');

const userSubmittedJobs = [
  { id: '1', title: 'Senior Business Analyst', company: 'Metrolinx' },
  { id: '2', title: 'Senior Data Analyst, Merchandise Procurement', company: 'Canadian Tire Corporation' },
  { id: '3', title: 'Manager, Fraud Analytics, Systems Mgmt.', company: 'BMO' },
  { id: '4', title: 'RQ10953 - Software Developer - CRM - Senior', company: 'Maarut' },
  { id: '5', title: 'Senior Data Engineer', company: 'Talent To Hire Inc.' },
  { id: '6', title: 'Intermediate Data Engineer', company: 'BMO' },
  { id: '7', title: 'Senior Data Architect', company: 'Kraft Heinz' },
  { id: '8', title: 'Senior Data Platform Engineer', company: 'Norton Rose Fulbright' },
  { id: '9', title: 'Senior Solution Architect', company: 'Technitask' },
  { id: '10', title: 'Data Privacy Analyst', company: 'RemoteJobsOne' }
];

console.log('=== Testing User Problem Scenarios ===\n');

userSubmittedJobs.forEach(job => {
  // Test both with simulated inflated LLM response and with heuristic
  const mockItem = {
    json: {
      ...job,
      description: 'Enterprise data and analytics environment.',
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              overall_score: 92,
              breakdown: { title_fit_score: 85, skills_fit_score: 90, seniority_fit_score: 85, domain_fit_score: 85 },
              should_apply: true,
              company_tier: 'Enterprise / Product',
              reasoning: 'Simulated LLM response'
            })
          }]
        }
      }]
    }
  };

  const scored = runParseScore(mockItem).json;
  console.log(`[Job] "${scored.title}" @ ${scored.company}`);
  console.log(`      Final Score: ${scored.score} | Should Apply: ${scored.should_apply}`);
  if (scored.disqualification_reasons && scored.disqualification_reasons.length > 0) {
    console.log(`      Reason: ${scored.disqualification_reasons[0]}`);
  }
});

// Assertions: Non-matching roles must be rejected (score <= 45, should_apply = false)
const crmJob = runParseScore({ json: { title: 'RQ10953 - Software Developer - CRM - Senior' } }).json;
assert.ok(crmJob.score <= 45, 'CRM Developer must score <= 45');
assert.strictEqual(crmJob.should_apply, false);

const archJob = runParseScore({ json: { title: 'Senior Solution Architect' } }).json;
assert.ok(archJob.score <= 45, 'Solution Architect must score <= 45');
assert.strictEqual(archJob.should_apply, false);

const engJob = runParseScore({ json: { title: 'Senior Data Engineer' } }).json;
assert.ok(engJob.score <= 45, 'Data Engineer must score <= 45');
assert.strictEqual(engJob.should_apply, false);

const baJob = runParseScore({ json: { title: 'Senior Business Analyst' } }).json;
assert.ok(baJob.score <= 45, 'Business Analyst must score <= 45');
assert.strictEqual(baJob.should_apply, false);

const privacyJob = runParseScore({ json: { title: 'Data Privacy Analyst' } }).json;
assert.ok(privacyJob.score <= 45, 'Data Privacy Analyst must score <= 45');
assert.strictEqual(privacyJob.should_apply, false);

const dataAnalyst = runParseScore({ json: { title: 'Senior Data Analyst, Merchandise Procurement', description: 'SQL Power BI Python Pandas' } }).json;
assert.ok(dataAnalyst.score >= 70, 'Senior Data Analyst must score >= 70');
assert.strictEqual(dataAnalyst.should_apply, true);

console.log('\n✅ All User Test Cases Verified Successfully! Only genuine Data Analyst jobs pass.');
