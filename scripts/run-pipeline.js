const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// Parse .env manually
try {
  const envContent = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  });
} catch(e) {}

const { normalizeJob, runFreshnessFilter, runDedupFilter, runParseScore } = require('./node-logic');
const { callLLMProvider, buildDynamicScoringPrompt } = require('./llm-provider');

const dataDir = path.join(__dirname, '../data');
const profileFile = path.join(dataDir, 'master-profile.json');
const seenFile = path.join(dataDir, 'seen_jobs.json');
const pendingFile = path.join(dataDir, 'pending_approval.json');
const loggedFile = path.join(dataDir, 'logged_jobs.json');
const dashboardFile = path.join(dataDir, 'dashboard.csv');

// Helper function to fetch live LinkedIn jobs via Apify API if APIFY_API_TOKEN is provided
async function fetchApifyLinkedInJobs(targetTitle, location) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return [];
  
  console.log(`🌐 Calling Apify LinkedIn Scraper Actor for role: "${targetTitle}" in "${location}"...`);
  try {
    const actorId = 'BHzefUZlZRKWxkTck';
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractType: "F",
        location: location,
        publishedAt: "r86400",
        title: targetTitle,
        workType: "3"
      })
    });
    if (!runRes.ok) {
      console.log(`Apify API call returned ${runRes.status}`);
      return [];
    }
    const items = await runRes.json();
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.log(`Apify LinkedIn fetch error: ${err.message}`);
    return [];
  }
}

// Helper function to fetch live jobs from Adzuna API with pagination and exact phrase matching
async function fetchLiveAdzunaJobs(targetTitle, location, page = 1) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    console.log('⚠️ ADZUNA_APP_ID or ADZUNA_APP_KEY missing from environment.');
    return [];
  }
  
  console.log(`🌐 Calling Live Adzuna API for role: "${targetTitle}" (page ${page}) in "${location}"...`);
  try {
    const locClean = (location || 'Toronto').split(',')[0].trim();
    // Use what_phrase for exact phrase search to avoid loose keyword scatter
    const url = `https://api.adzuna.com/v1/api/jobs/ca/search/${page}?app_id=${appId}&app_key=${appKey}&what_phrase=${encodeURIComponent(targetTitle)}&where=${encodeURIComponent(locClean)}&sort_by=date&max_days_old=14&results_per_page=20`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`Adzuna API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    console.log(`Adzuna fetch error: ${err.message}`);
    return [];
  }
}

async function runPipeline() {
  console.log('🚀 Starting Fresh Job Search Scan...');
  
  // 1. Ensure state files exist (preserve seen_jobs so we never re-score old jobs)
  if (!fs.existsSync(seenFile)) {
    fs.writeFileSync(seenFile, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(pendingFile)) {
    fs.writeFileSync(pendingFile, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(loggedFile)) {
    fs.writeFileSync(loggedFile, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(dashboardFile)) {
    fs.writeFileSync(dashboardFile, 'Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills\n');
  }

  // 2. Read Master Profile
  if (!fs.existsSync(profileFile)) {
    throw new Error('master-profile.json missing from data directory!');
  }
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const targetTitles = profile.target_titles || ['Data Analyst'];
  const locations = profile.locations || ['Toronto, ON, Canada'];
  console.log(`👤 Candidate: ${profile.name || 'Candidate'}`);
  console.log(`🎯 Target Titles: ${targetTitles.join(', ')}`);
  console.log(`📍 Target Locations: ${locations.join(', ')}`);

  // 3. Multi-Source Live Raw Job Ingestion (Multi-Role & Multi-Page Adzuna API + LinkedIn Apify)
  let rawAdzunaJobs = [];
  const searchPages = [1, 2]; // Fetch pages 1 and 2 to access fresh varied listings
  for (let title of targetTitles) {
    for (let loc of locations) {
      for (let p of searchPages) {
        const liveJobs = await fetchLiveAdzunaJobs(title, loc, p);
        rawAdzunaJobs = rawAdzunaJobs.concat(liveJobs);
      }
    }
  }

  // Fetch live Apify LinkedIn jobs if token is present
  const liveApifyJobs = await fetchApifyLinkedInJobs(targetTitles[0], locations[0]);

  const allRawItems = [
    ...rawAdzunaJobs.map(j => normalizeJob(j, 'adzuna')),
    ...liveApifyJobs.map(j => normalizeJob(j, 'linkedin'))
  ].filter(Boolean);

  console.log(`📥 Ingested & Normalized ${allRawItems.length} LIVE jobs across Adzuna & LinkedIn.`);

  // 4. Freshness Filter
  const freshItems = runFreshnessFilter(allRawItems.map(j => ({ json: j }))).map(i => i.json);
  console.log(`⌛ Freshness Filter passed: ${freshItems.length} jobs`);

  // 5. Dedup Filter
  const seenIds = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  const dedupedJobs = runDedupFilter(freshItems.map(j => ({ json: j })), seenIds).map(i => i.json);
  console.log(`🔄 Dedup Filter passed: ${dedupedJobs.length} unique jobs`);

  // 6. Dynamic Evaluation & Scoring
  const processedJobs = [];
  const newlySeenIds = [];

  for (let job of dedupedJobs) {
    const title = job.title || "";
    newlySeenIds.push(job.id);
    if (job.job_url) newlySeenIds.push(job.job_url);

    // Delay to respect free tier rate limits (5 RPM)
    await new Promise(r => setTimeout(r, 2500));

    // LLM Scoring for candidates against profile
    console.log(`⚡ Scoring with LLM: [${job.source.toUpperCase()}] ${title} @ ${job.company}...`);
    const prompt = buildDynamicScoringPrompt(profile, job.title, job.description);
    const llmRes = await callLLMProvider({ prompt, provider: process.env.LLM_PROVIDER || 'gemini' });

    if (llmRes.success) {
      job.rawText = llmRes.rawText;
    } else {
      job.parse_error = true;
      job.parse_error_msg = llmRes.error;
    }

    const parsedItem = runParseScore({ json: job }, profile).json;
    processedJobs.push(parsedItem);
    console.log(`   └─ Overall Score: ${parsedItem.score} (Should Apply: ${parsedItem.should_apply})`);
  }

  // Update seen_jobs.json
  const updatedSeen = [...new Set([...seenIds, ...newlySeenIds])];
  fs.writeFileSync(seenFile, JSON.stringify(updatedSeen, null, 2));

  // Score Gate & Routing
  const qualified = processedJobs.filter(j => j.score >= 70);
  const rejected = processedJobs.filter(j => j.score < 70);

  fs.writeFileSync(pendingFile, JSON.stringify(qualified, null, 2));
  fs.writeFileSync(loggedFile, JSON.stringify(rejected, null, 2));

  // Update CSV Dashboard
  let csvContent = 'Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills\n';
  processedJobs.forEach(j => {
    const timestamp = new Date().toISOString();
    const source = j.source || 'unknown';
    const company = (j.company || 'Unknown').replace(/,/g, '');
    const title = (j.title || '').replace(/,/g, '');
    const status = j.score >= 70 ? 'Qualified' : 'Rejected';
    const missing = (j.missing_skills || []).join('; ').replace(/,/g, '');
    csvContent += `${timestamp},${j.id},${source},"${title}","${company}",${j.score},${status},"${missing}"\n`;
  });
  fs.writeFileSync(dashboardFile, csvContent);

  console.log('\n=============================================');
  console.log(`✅ Live Multi-Source Pipeline Execution Complete!`);
  console.log(`- Total Live Jobs Ingested: ${allRawItems.length}`);
  console.log(`- Unique Jobs Processed: ${processedJobs.length}`);
  console.log(`- Qualified (Score >= 70) saved to pending_approval.json: ${qualified.length}`);
  console.log(`- Rejected (Score < 70) saved to logged_jobs.json: ${rejected.length}`);
  console.log(`- Dashboard updated in dashboard.csv`);
  console.log('=============================================\n');
}

runPipeline().catch(console.error);
