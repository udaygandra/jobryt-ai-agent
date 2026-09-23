const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// Configuration
const dataDir = path.join(__dirname, '../data');
const seenJobsFile = path.join(dataDir, 'seen_jobs.json');
const loggedJobsFile = path.join(dataDir, 'logged_jobs.json');
const masterProfileFile = path.join(dataDir, 'master-profile.json');

// Helper to reset state for tests
function resetDataFiles() {
  fs.writeFileSync(seenJobsFile, JSON.stringify(["old_job_1"]));
  fs.writeFileSync(loggedJobsFile, JSON.stringify([]));
}

// Node Logics
function runFreshnessFilter(items) {
  const now = DateTime.now();
  return items.filter(item => {
    if (!item.created) return true;
    const posted = DateTime.fromISO(item.created);
    return now.diff(posted, 'hours').hours < 2;
  });
}

function runDedupFilter(items, seenIds) {
  return items.filter(item => !seenIds.includes(item.id));
}

const { runParseScore } = require('./node-logic');

// Integration Test Runner
async function runWorkflow1Test() {
  console.log("=== Starting Workflow 1 Integration Test ===");
  resetDataFiles();

  // 1. Mock Adzuna Response
  const now = DateTime.now();
  const mockAdzunaResults = [
    { id: "old_job_1", created: now.minus({ minutes: 30 }).toISO(), title: "Data Analyst" }, // Seen
    { id: "stale_job_2", created: now.minus({ hours: 5 }).toISO(), title: "BI Analyst" },   // Stale
    { id: "fresh_good_job_3", created: now.minus({ minutes: 10 }).toISO(), title: "Senior Data Analyst" }, // Fresh, Good
    { id: "fresh_bad_crm", created: now.minus({ minutes: 15 }).toISO(), title: "RQ10953 - Software Developer - CRM - Senior" }, // Mismatched Developer
    { id: "fresh_bad_arch", created: now.minus({ minutes: 20 }).toISO(), title: "Senior Solution Architect" }, // Mismatched Architect
    { id: "fresh_bad_eng", created: now.minus({ minutes: 25 }).toISO(), title: "Senior Data Engineer" }, // Mismatched Engineer
    { id: "fresh_bad_ba", created: now.minus({ minutes: 35 }).toISO(), title: "Senior Business Analyst" }, // Non-data BA
    { id: "fresh_bad_job_4", created: now.minus({ minutes: 45 }).toISO(), title: "Data Entry" } // Fresh, Bad
  ];
  console.log(`Fetched ${mockAdzunaResults.length} jobs from Adzuna (mock)`);

  // 2. Freshness Filter
  const freshItems = runFreshnessFilter(mockAdzunaResults);
  console.log(`Passed Freshness Filter: ${freshItems.length}`);

  // 3. Read Seen Jobs
  const seenIds = JSON.parse(fs.readFileSync(seenJobsFile, 'utf8'));

  // 4. Dedup Filter
  const dedupedItems = runDedupFilter(freshItems, seenIds);
  console.log(`Passed Dedup Filter: ${dedupedItems.length}`);

  // 5. Read Master Profile
  const profile = JSON.parse(fs.readFileSync(masterProfileFile, 'utf8'));

  // 6 & 7. Mock LLM Match Score & Parse
  const scoredItems = dedupedItems.map(item => {
    // Simulate what happened: Even if LLM returned an inflated score for CRM or Architect,
    // runParseScore must catch it!
    if (item.id === "fresh_bad_crm") {
      // LLM mistakenly tries to return 92
      item.candidates = [{
        content: {
          parts: [{
            text: JSON.stringify({
              overall_score: 92,
              breakdown: { title_fit_score: 90, skills_fit_score: 92, seniority_fit_score: 90, domain_fit_score: 90 },
              should_apply: true,
              reasoning: "Transferable skills hallucinated by LLM"
            })
          }]
        }
      }];
    } else if (item.id === "fresh_good_job_3") {
      item.candidates = [{
        content: {
          parts: [{
            text: JSON.stringify({
              overall_score: 95,
              breakdown: { title_fit_score: 95, skills_fit_score: 95, seniority_fit_score: 90, domain_fit_score: 95 },
              should_apply: true,
              company_tier: "Top Target",
              priority_level: "High",
              key_matched_skills: ["SQL", "Power BI", "Python"],
              missing_skills: [],
              reasoning: "Great fit for Senior Data Analyst role"
            })
          }]
        }
      }];
    } else {
      // Fallback or lower score
      item.candidates = [{
        content: {
          parts: [{
            text: JSON.stringify({
              overall_score: 40,
              breakdown: { title_fit_score: 30, skills_fit_score: 40, seniority_fit_score: 50, domain_fit_score: 40 },
              should_apply: false,
              company_tier: "Low-quality",
              priority_level: "Low",
              key_matched_skills: [],
              missing_skills: ["Excel"],
              reasoning: "Not a good fit"
            })
          }]
        }
      }];
    }
    return runParseScore({ json: item }).json;
  });

  // 8. Update Seen Jobs
  const newSeenIds = [...seenIds, ...scoredItems.map(i => i.id)];
  fs.writeFileSync(seenJobsFile, JSON.stringify(newSeenIds, null, 2));
  console.log(`Updated seen_jobs.json with ${scoredItems.length} new IDs`);

  // 9. Score Gate
  const passedGate = [];
  const rejected = [];
  scoredItems.forEach(item => {
    if (item.score >= 70) {
      passedGate.push(item);
    } else {
      rejected.push(item);
    }
  });

  // 10. Log Rejected
  fs.writeFileSync(loggedJobsFile, JSON.stringify(rejected, null, 2));

  console.log(`Passed Score Gate (to Workflow 2): ${passedGate.length}`);
  console.log(`Rejected (Logged): ${rejected.length}`);

  // Assertions
  const finalSeenIds = JSON.parse(fs.readFileSync(seenJobsFile, 'utf8'));
  if (!finalSeenIds.includes("fresh_good_job_3") || !finalSeenIds.includes("fresh_bad_job_4")) {
    throw new Error("Validation Failed: New seen IDs were not correctly appended.");
  }
  if (passedGate.length !== 1 || passedGate[0].id !== "fresh_good_job_3") {
    throw new Error(`Validation Failed: Score gate passed ${passedGate.length} jobs instead of only 1 (fresh_good_job_3).`);
  }
  const crmJob = scoredItems.find(i => i.id === "fresh_bad_crm");
  if (!crmJob || crmJob.score >= 70) {
    throw new Error(`Validation Failed: CRM Developer job was not rejected. Score: ${crmJob?.score}`);
  }
  const archJob = scoredItems.find(i => i.id === "fresh_bad_arch");
  if (!archJob || archJob.score >= 70) {
    throw new Error(`Validation Failed: Solution Architect job was not rejected. Score: ${archJob?.score}`);
  }
  const engJob = scoredItems.find(i => i.id === "fresh_bad_eng");
  if (!engJob || engJob.score >= 70) {
    throw new Error(`Validation Failed: Data Engineer job was not rejected. Score: ${engJob?.score}`);
  }

  console.log("✅ All Integration Tests Passed Successfully! Inappropriate jobs were strictly rejected.");
}

runWorkflow1Test().catch(console.error);
