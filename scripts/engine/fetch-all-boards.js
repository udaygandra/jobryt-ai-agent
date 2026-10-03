/**
 * fetch-all-boards.js — Multi-Board Job Ingestion Engine
 *
 * PURPOSE:
 *   High-performance, zero-token job ingestion from multiple sources:
 *   1. Adzuna API (Free Tier)
 *   2. Canada Job Bank (Direct Open Web Ingestion)
 *   3. LinkedIn Jobs (High-speed Direct Guest API)
 *   4. USAJOBS Federal API (for US queries)
 *   5. Remotive & Jobicy Feeds (Global & NA Tech/Remote)
 *
 * HOW IT WORKS:
 *   1. Loads the candidate's master profile to determine target roles/locations.
 *   2. Checks `settings.json` to see which boards are enabled.
 *   3. Fetches jobs from all enabled boards in parallel.
 *   4. Filters out jobs that don't match the target roles/locations/work type.
 *   5. Outputs a single JSON array of normalized job objects to stdout.
 *
 * USAGE:
 *   node scripts/fetch-all-boards.js > fetched_jobs.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Step 1: Load Environment and Configuration ──────────────────────────────
const { loadEnv } = require('../core/load-env');
loadEnv();

const { getDataDir, readJsonFile } = require('../core/common-utils');
const { getSettings } = require('../core/settings-helper');
const {
  detectTargetCountryScope,
  isJobLocationEligible,
  isJobWorkplaceEligible,
  isJobRoleRelevant,
  getSearchLocationQuery,
} = require('../core/geo-helper');

const dataDir = getDataDir();
const profileObj = readJsonFile(path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json'), {});
const settings = getSettings();

// ── Step 2: Determine Search Parameters ─────────────────────────────────────
// Fallback to environment variables if profile is empty
const targetTitles = Array.isArray(profileObj.target_titles) && profileObj.target_titles.length > 0
  ? profileObj.target_titles
  : (process.env.ADZUNA_SEARCH_ROLE ? [process.env.ADZUNA_SEARCH_ROLE] : ['Target Role']);

const targetLocations = Array.isArray(profileObj.locations) && profileObj.locations.length > 0
  ? profileObj.locations.map(l => l.split(',')[0].trim())
  : (process.env.ADZUNA_SEARCH_LOCATION ? [process.env.ADZUNA_SEARCH_LOCATION] : ['Remote']);

const candidateWorkType = settings.work_type || profileObj.work_type || 'Open to All';
const freshnessHours = settings.freshness_hours !== undefined ? settings.freshness_hours : 24;
const isFreshnessDisabled = freshnessHours <= 0;
const maxDaysOld = isFreshnessDisabled ? 365 : Math.max(1, Math.ceil(freshnessHours / 24));
const boardsEnabled = settings.boards_enabled || {};

// Country scope determines which region-specific boards to query (e.g. Canada Job Bank vs USAJOBS)
const countryScope = (settings.country_scope && settings.country_scope !== 'AUTO')
  ? settings.country_scope
  : detectTargetCountryScope(profileObj.locations || targetLocations);

// ── Step 3: Rotate Search Role and Location ─────────────────────────────────
// To avoid hitting API limits and get varied results, we cycle through the
// candidate's target roles and locations on each run.
function rotateIndex(filename, maxLimit) {
  const cacheDir = path.join(dataDir, 'cache');
  if (!fs.existsSync(cacheDir)) {
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  }
  const filepath = path.join(cacheDir, filename);
  let idx = 0;
  try {
    if (fs.existsSync(filepath)) {
      idx = (JSON.parse(fs.readFileSync(filepath, 'utf8')).idx || 0) % maxLimit;
    }
    fs.writeFileSync(filepath, JSON.stringify({ idx: (idx + 1) % maxLimit }));
  } catch (err) {
    console.error(`[Warning] Could not rotate ${filename}:`, err.message);
  }
  return idx;
}

const roleIdx = rotateIndex('adzuna_role_idx.json', targetTitles.length);
const locIdx = rotateIndex('adzuna_loc_idx.json', targetLocations.length);

let currentRole = targetTitles[roleIdx] || 'Target Role';
let currentLoc = targetLocations[locIdx] || targetLocations[0] || 'Remote';
const country = (countryScope === 'US' ? 'us' : (process.env.ADZUNA_COUNTRY || 'ca')).toLowerCase().trim();

console.error(`[Multi-Board Ingestion] Scope: "${countryScope}" | Role [${roleIdx + 1}/${targetTitles.length}]: "${currentRole}" | Loc [${locIdx + 1}/${targetLocations.length}]: "${currentLoc}" | Mode: "${candidateWorkType}" | Freshness: ${isFreshnessDisabled ? 'Disabled (Any Time)' : freshnessHours + 'h'}...`);

// Shared array to collect all fetched jobs
const allFetchedJobs = [];

// ── Step 4: Board Fetcher Implementations ───────────────────────────────────

/**
 * Fetches jobs from Adzuna (Free API).
 */
async function fetchAdzuna() {
  if (boardsEnabled.adzuna === false) return console.error('[Fetch] Adzuna disabled.');
  const adzunaAppId = process.env.ADZUNA_APP_ID;
  const adzunaAppKey = process.env.ADZUNA_APP_KEY;
  if (!adzunaAppId || !adzunaAppKey || adzunaAppId === 'your_adzuna_app_id') {
    return console.error('[Fetch] Adzuna credentials missing, skipping.');
  }

  let count = 0;
  const isExplicitRemote = candidateWorkType.toLowerCase().includes('remote') || currentLoc.toLowerCase() === 'remote';
  let searchWhere = isExplicitRemote ? '' : currentLoc;
  try {
    const resolvedLoc = getSearchLocationQuery(currentLoc);
    if (resolvedLoc && searchWhere && searchWhere.toLowerCase() !== 'remote') searchWhere = resolvedLoc.split(',')[0].trim();
  } catch (err) {}

  for (let page = 1; page <= 2; page++) {
    try {
      const whereParam = searchWhere ? `&where=${encodeURIComponent(searchWhere)}` : '';
      const adzunaDays = Math.max(7, maxDaysOld);
      const cleanRole = currentRole.replace(/^(senior|lead|principal|sr\.?)\s+/i, '').trim() || currentRole;
      const adzunaRoleQuery = cleanRole;
      
      const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?app_id=${adzunaAppId}&app_key=${adzunaAppKey}&what=${encodeURIComponent(adzunaRoleQuery)}${whereParam}&sort_by=date&max_days_old=${adzunaDays}&results_per_page=20`;
      
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        console.error(`[Fetch] Adzuna HTTP ${res.status}`);
        break;
      }
      
      const data = await res.json();
      if (!data || !Array.isArray(data.results)) break;

      for (const item of data.results) {
        const rawLoc = (item.location && item.location.display_name) || (isExplicitRemote ? 'Canada (Remote)' : currentLoc);
        const rawTitle = item.title ? item.title.replace(/<\/?[^>]+(>|$)/g, "").trim() : currentRole;
        const rawDesc = item.description ? item.description.replace(/<\/?[^>]+(>|$)/g, "").trim() : '';
        
        const isRemoteAdzuna = isExplicitRemote || /\b(remote|work from home|wfh|telecommute|virtual|anywhere)\b/i.test(`${rawTitle} ${rawDesc} ${rawLoc}`);
        // Filter jobs based on profile match
        if (!isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope, isRemoteAdzuna)) continue;
        if (!isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles)) continue;
        if (typeof isJobWorkplaceEligible === 'function' && !isJobWorkplaceEligible(rawLoc, rawDesc, rawTitle, candidateWorkType, isRemoteAdzuna)) continue;
        
        allFetchedJobs.push({
          id: `adzuna_${item.id}`,
          title: rawTitle,
          company: (item.company && (item.company.display_name || item.company.name)) || 'Company',
          location: rawLoc,
          created: item.created || new Date().toISOString(),
          description: rawDesc,
          redirect_url: item.redirect_url || item.url || '',
          source: 'Adzuna'
        });
        count++;
      }
    } catch (err) {
      console.error(`[Fetch] Adzuna error on page ${page}:`, err.message);
    }
  }
  console.error(`[Fetch] Adzuna found: ${count} jobs`);
}

/**
 * Fetches jobs from Canada Job Bank (Direct HTML parsing).
 */
async function fetchCanadaJobBank() {
  if (boardsEnabled.canada_job_bank === false) return console.error('[Fetch] Canada Job Bank disabled.');
  if (countryScope === 'US') return console.error('[Fetch] Canada Job Bank skipped (US mode).');
  
  let count = 0;
  try {
    const isExplicitRemote = candidateWorkType.toLowerCase().includes('remote') || currentLoc.toLowerCase() === 'remote';
    const rawSearchLoc = getSearchLocationQuery(currentLoc);
    const jobBankLoc = isExplicitRemote ? 'Canada' : (rawSearchLoc.split(',')[0].trim() || 'Toronto');
    const cleanSearchRole = currentRole.replace(/\s+(II|III|IV|I)\b/i, '').trim() || currentRole;
    const url = `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=${encodeURIComponent(cleanSearchRole)}&locationstring=${encodeURIComponent(jobBankLoc)}&sort=D`;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-CA,en-US;q=0.9'
      }
    });

    if (!res.ok) return console.error(`[Fetch] Job Bank HTTP ${res.status}`);

    const htmlText = await res.text();
    const articles = htmlText.split('<article').slice(1);
    
    for (const article of articles) {
      const titleMatch = article.match(/<span class="noctitle">([\s\S]*?)<\/span>/i) || article.match(/<h3[\s\S]*?>([\s\S]*?)<\/h3>/i);
      const linkMatch = article.match(/href="\/jobsearch\/jobposting\/([0-9]+)"/i) || article.match(/href="(\/jobsearch\/jobposting\/[^"]*)"/i);
      const compMatch = article.match(/<li class="business">([\s\S]*?)<\/li>/i);
      const locMatch = article.match(/<li class="location">([\s\S]*?)<\/li>/i);

      let rawTitle = titleMatch ? titleMatch[1].replace(/<\/?[^>]+(>|$)/g, "").replace(/\s+/g, ' ').trim() : '';
      rawTitle = rawTitle.replace(/^(New|Nouveau)\s*/i, '').replace(/^(indeed\.com)\s*/i, '').trim();

      const postingIdRaw = linkMatch ? linkMatch[1] : '';
      const cleanPostingId = postingIdRaw.replace(/^.*\/jobsearch\/jobposting\//, '').replace(/;.*$/, '').replace(/^\//, '');
      const rawLink = cleanPostingId ? `https://www.jobbank.gc.ca/jobsearch/jobposting/${cleanPostingId}` : '';
      const rawComp = compMatch ? compMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim() : 'Gov of Canada Employer';
      const rawLoc = locMatch ? locMatch[1].replace(/<\/?[^>]+(>|$)/g, "").replace(/\s+/g, ' ').replace(/^Location\s*/i, '').trim() : currentLoc;
      const isJbRemote = /telework|remote|virtual|distance/i.test(article);
      const rawDesc = `${rawTitle} at ${rawComp} in ${rawLoc || currentLoc}${isJbRemote ? ' (Remote)' : ''}`;

      if (rawTitle && rawLink && isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope, isJbRemote) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(rawLoc, rawDesc, rawTitle, candidateWorkType, isJbRemote)) {
        const jbId = cleanPostingId || crypto.createHash('md5').update(rawLink).digest('hex').slice(0, 10);
        allFetchedJobs.push({
          id: `jobbank_${jbId}`,
          title: rawTitle,
          company: rawComp,
          location: rawLoc || currentLoc,
          created: new Date().toISOString(),
          description: rawDesc,
          redirect_url: rawLink,
          source: 'Canada Job Bank'
        });
        count++;
      }
    }
  } catch (err) {
    console.error('[Fetch] Canada Job Bank error:', err.message);
  }
  console.error(`[Fetch] Canada Job Bank found: ${count} jobs`);
}

/**
 * Fetches jobs from LinkedIn (Direct Guest API).
 */
async function fetchLinkedIn() {
  if (boardsEnabled.linkedin === false) return console.error('[Fetch] LinkedIn disabled.');
  
  let count = 0;
  let searchLoc = getSearchLocationQuery(currentLoc);
  const isExplicitRemote = candidateWorkType.toLowerCase().includes('remote') || currentLoc.toLowerCase() === 'remote';

  let f_wt = '';
  if (isExplicitRemote) {
    f_wt = '&f_WT=2';
    searchLoc = countryScope === 'CA' ? 'Canada' : (countryScope === 'US' ? 'United States' : (searchLoc || 'Canada'));
  } else if (candidateWorkType.toLowerCase().includes('hybrid')) {
    f_wt = '&f_WT=3';
  } else if (candidateWorkType.toLowerCase().includes('onsite') || candidateWorkType.toLowerCase().includes('on-site')) {
    f_wt = '&f_WT=1';
  }

  const fTprParam = isFreshnessDisabled ? '' : (freshnessHours <= 24 ? '&f_TPR=r86400' : (freshnessHours <= 72 ? '&f_TPR=r259200' : (freshnessHours <= 168 ? '&f_TPR=r604800' : '')));

  try {
    for (let page = 0; page <= 1; page++) {
      const start = page * 10;
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(currentRole)}&location=${encodeURIComponent(searchLoc)}${f_wt}${fTprParam}&start=${start}`;
      
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html'
        }
      });
      
      if (!res.ok) continue;

      const html = await res.text();
      const items = html.split('<li').slice(1);
      
      for (const it of items) {
        const titleM = it.match(/<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/);
        const compM = it.match(/<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>/);
        const locM = it.match(/<span class="job-search-card__location">([\s\S]*?)<\/span>/);
        const linkM = it.match(/href="([^"]+jobs\/view\/[^"]+)"/);
        const dateM = it.match(/<time datetime="([^"]+)"/);
        
        if (titleM && linkM) {
          const rawTitle = titleM[1].trim();
          const rawComp = compM ? compM[1].trim().replace(/<[^>]+>/g, '').trim() : 'LinkedIn Employer';
          const rawLoc = locM ? locM[1].trim() : currentLoc;
          const rawUrl = linkM[1].split('?')[0];
          const rawDate = dateM ? dateM[1] : new Date().toISOString();

          if (rawTitle && rawUrl && isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(rawLoc, `${rawTitle} at ${rawComp}`, rawTitle, candidateWorkType, isExplicitRemote)) {
            const numId = (rawUrl.match(/-([0-9]{5,})/i) || rawUrl.match(/\/([0-9]{5,})/i) || [])[1];
            const cleanLiId = numId ? `li_${numId}` : `li_${crypto.createHash('md5').update(rawUrl).digest('hex').slice(0, 10)}`;
            
            allFetchedJobs.push({
              id: cleanLiId,
              title: rawTitle,
              company: rawComp,
              location: rawLoc,
              created: rawDate,
              description: `${rawTitle} at ${rawComp} in ${rawLoc}`,
              redirect_url: rawUrl,
              source: 'LinkedIn Jobs'
            });
            count++;
          }
        }
      }
    }
  } catch (err) {
    console.error('[Fetch] LinkedIn error:', err.message);
  }
  console.error(`[Fetch] LinkedIn found: ${count} jobs`);
}

/**
 * Fetches jobs from USAJOBS Federal API.
 */
async function fetchUSAJobs() {
  if (boardsEnabled.usajobs === false) return console.error('[Fetch] USAJOBS disabled.');
  if (countryScope === 'CA') return console.error('[Fetch] USAJOBS skipped (Canada mode).');
  
  const usajobsKey = process.env.USAJOBS_API_KEY || process.env.USAJOBS_AUTH_KEY;
  if (!usajobsKey) return;

  let count = 0;
  try {
    const userAgent = process.env.USAJOBS_USER_AGENT || process.env.USAJOBS_EMAIL || process.env.SMTP_USER || process.env.N8N_BASIC_AUTH_USER || profileObj.contact?.email || 'candidate@local.dev';
    const isNationwideOrRemote = /remote|anywhere|united states|usa|all states/i.test(currentLoc);
    let locQuery = '';
    if (!isNationwideOrRemote && currentLoc) {
      locQuery = `&LocationName=${encodeURIComponent(currentLoc)}`;
    }

    const cleanRole = currentRole.replace(/^(senior|lead|principal|sr\.?)\s+/i, '').trim() || currentRole;
    const url = `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(cleanRole)}${locQuery}&ResultsPerPage=25`;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Authorization-Key': usajobsKey,
        'Host': 'data.usajobs.gov'
      }
    });

    if (!res.ok) return console.error(`[Fetch] USAJOBS HTTP ${res.status}`);

    const data = await res.json();
    const items = data.SearchResult?.SearchResultItems || [];
    
    for (const wrap of items) {
      const desc = wrap.MatchedObjectDescriptor || {};
      const rawTitle = desc.PositionTitle || '';
      const rawUrl = desc.PositionURI || (desc.ApplyURI && desc.ApplyURI[0]) || '';
      const rawCompany = desc.OrganizationName || desc.DepartmentName || 'US Federal Government';
      const locDisplay = (desc.PositionLocation && desc.PositionLocation[0] && desc.PositionLocation[0].LocationName) || 'United States';
      const rawSummary = desc.UserArea?.Details?.JobSummary || desc.QualificationSummary || `${rawTitle} at ${rawCompany}`;
      const isTelework = Boolean(desc.UserArea?.Details?.TeleworkEligible || desc.UserArea?.Details?.RemoteIndicator || /remote|telework/i.test(locDisplay) || /remote|telework/i.test(rawSummary));

      if (rawTitle && rawUrl && isJobLocationEligible(locDisplay, profileObj.locations || targetLocations, countryScope, isTelework) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(locDisplay, rawSummary, rawTitle, candidateWorkType, isTelework)) {
        const ujId = wrap.MatchedObjectId || crypto.createHash('md5').update(rawUrl).digest('hex').slice(0, 10);
        allFetchedJobs.push({
          id: `usajobs_${ujId}`,
          title: rawTitle,
          company: rawCompany,
          location: locDisplay,
          created: desc.PublicationStartDate || new Date().toISOString(),
          description: rawSummary,
          redirect_url: rawUrl,
          source: 'USAJOBS'
        });
        count++;
      }
    }
  } catch (err) {
    console.error('[Fetch] USAJOBS error:', err.message);
  }
  console.error(`[Fetch] USAJOBS found: ${count} jobs`);
}

/**
 * Fetches jobs from Remotive, Jobicy, ArbeitNow, and Himalayas.
 */
async function fetchGlobalRemoteFeeds() {
  let count = 0;

  // 1. ArbeitNow API
  if (boardsEnabled.arbeitnow !== false) {
    try {
      const url = `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(currentRole)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const data = await res.json();
        for (const item of (data.data || []).slice(0, 20)) {
          const rawTitle = item.title || '';
          const rawUrl = item.url || '';
          const rawCompany = item.company_name || 'Tech Employer';
          const rawLoc = item.remote ? `${item.location || 'Remote'} (Remote)` : (item.location || 'Remote');
          const rawDesc = item.description ? item.description.replace(/<\/?[^>]+(>|$)/g, "").trim() : `${rawTitle} at ${rawCompany}`;

          if (rawTitle && rawUrl && isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(rawLoc, rawDesc, rawTitle, candidateWorkType, item.remote)) {
            allFetchedJobs.push({
              id: `arbeitnow_${item.slug || crypto.createHash('md5').update(rawUrl).digest('hex').slice(0, 10)}`,
              title: rawTitle,
              company: rawCompany,
              location: rawLoc,
              created: item.created_at ? new Date(item.created_at * 1000).toISOString() : new Date().toISOString(),
              description: rawDesc,
              redirect_url: rawUrl,
              source: 'ArbeitNow'
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.error('[Fetch] ArbeitNow error:', err.message);
    }
  }

  // 2. Himalayas Remote API
  if (boardsEnabled.himalayas !== false) {
    try {
      const url = `https://himalayas.app/jobs/api?search=${encodeURIComponent(currentRole)}&limit=20`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const data = await res.json();
        for (const item of (data.jobs || [])) {
          const rawTitle = item.title || '';
          const rawUrl = item.applicationLink || `https://himalayas.app/companies/${item.companySlug}/jobs/${item.slug}`;
          const rawCompany = item.companyName || 'Remote Employer';
          const rawLoc = (item.locationRestrictions && item.locationRestrictions.length > 0) ? item.locationRestrictions.join(', ') : 'Worldwide (Remote)';
          const rawDesc = item.excerpt || `${rawTitle} at ${rawCompany}`;

          if (rawTitle && rawUrl && isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(rawLoc, rawDesc, rawTitle, candidateWorkType, true)) {
            allFetchedJobs.push({
              id: `himalayas_${item.id || crypto.createHash('md5').update(rawUrl).digest('hex').slice(0, 10)}`,
              title: rawTitle,
              company: rawCompany,
              location: rawLoc,
              created: item.pubDate ? new Date(item.pubDate * 1000).toISOString() : new Date().toISOString(),
              description: rawDesc,
              redirect_url: rawUrl,
              source: 'Himalayas'
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.error('[Fetch] Himalayas error:', err.message);
    }
  }

  // 3. Remotive API
  if (boardsEnabled.remotive !== false) {
    try {
      const lowerRole = currentRole.toLowerCase();
      let remotiveCategory = '';
      if (/data|analytics|bi\b|database|sql/i.test(lowerRole)) remotiveCategory = '&category=data';
      else if (/software|developer|engineer|devops|frontend|backend|fullstack/i.test(lowerRole)) remotiveCategory = '&category=software-dev';
      else if (/product/i.test(lowerRole)) remotiveCategory = '&category=product';
      else if (/design|ux|ui/i.test(lowerRole)) remotiveCategory = '&category=design';
      else if (/marketing|seo/i.test(lowerRole)) remotiveCategory = '&category=marketing';
      else if (/sales|account exec/i.test(lowerRole)) remotiveCategory = '&category=sales';
      else if (/finance|accounting/i.test(lowerRole)) remotiveCategory = '&category=finance-legal';
      else if (/hr|recruiter|people/i.test(lowerRole)) remotiveCategory = '&category=hr';

      const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(currentRole)}${remotiveCategory}&limit=20`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const data = await res.json();
        for (const item of (data.jobs || [])) {
          const rawTitle = item.title ? item.title.replace(/<\/?[^>]+(>|$)/g, "").trim() : '';
          const rawUrl = item.url || '';
          const rawCompany = item.company_name || 'Remote Employer';
          const rawLoc = item.candidate_required_location ? `${item.candidate_required_location} (Remote)` : 'Worldwide (Remote)';
          const rawDesc = item.description ? item.description.replace(/<\/?[^>]+(>|$)/g, "").trim() : `${rawTitle} at ${rawCompany}`;
          
          if (rawTitle && rawUrl && isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(rawLoc, rawDesc, rawTitle, candidateWorkType, true)) {
            allFetchedJobs.push({
              id: `remotive_${item.id}`,
              title: rawTitle,
              company: rawCompany,
              location: rawLoc,
              created: item.publication_date || new Date().toISOString(),
              description: rawDesc,
              redirect_url: rawUrl,
              source: 'Remotive'
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.error('[Fetch] Remotive error:', err.message);
    }
  }

  // 4. Jobicy API
  if (boardsEnabled.jobicy !== false) {
    try {
      const lowerRole = currentRole.toLowerCase();
      let jobicyIndustry = '';
      if (/data|analytics|bi\b|database|sql/i.test(lowerRole)) jobicyIndustry = '&industry=data-science';
      else if (/software|developer|engineer|devops|frontend|backend|fullstack/i.test(lowerRole)) jobicyIndustry = '&industry=dev';
      else if (/product/i.test(lowerRole)) jobicyIndustry = '&industry=product';
      else if (/design|ux|ui/i.test(lowerRole)) jobicyIndustry = '&industry=design';
      else if (/marketing|seo/i.test(lowerRole)) jobicyIndustry = '&industry=marketing';
      else if (/sales|account exec/i.test(lowerRole)) jobicyIndustry = '&industry=sales';
      else if (/finance|accounting/i.test(lowerRole)) jobicyIndustry = '&industry=finance';
      else if (/hr|recruiter|people/i.test(lowerRole)) jobicyIndustry = '&industry=supporting';

      const geoParam = countryScope === 'CA' ? 'canada' : (countryScope === 'US' ? 'usa' : '');
      const url = geoParam
        ? `https://jobicy.com/api/v2/remote-jobs?count=20&geo=${geoParam}${jobicyIndustry}&tag=${encodeURIComponent(currentRole)}`
        : `https://jobicy.com/api/v2/remote-jobs?count=20${jobicyIndustry}&tag=${encodeURIComponent(currentRole)}`;
        
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const data = await res.json();
        for (const item of (data.jobs || [])) {
          const rawTitle = item.jobTitle ? item.jobTitle.replace(/<\/?[^>]+(>|$)/g, "").trim() : '';
          const rawUrl = item.url || '';
          const rawCompany = item.companyName || 'Remote Employer';
          const rawLoc = item.jobGeo ? `${item.jobGeo} (Remote)` : 'Worldwide (Remote)';
          const rawDesc = item.jobDescription ? item.jobDescription.replace(/<\/?[^>]+(>|$)/g, "").trim() : `${rawTitle} at ${rawCompany}`;
          
          if (rawTitle && rawUrl && isJobLocationEligible(rawLoc, profileObj.locations || targetLocations, countryScope) && isJobRoleRelevant(rawTitle, profileObj.target_titles || targetTitles) && isJobWorkplaceEligible(rawLoc, rawDesc, rawTitle, candidateWorkType, true)) {
            allFetchedJobs.push({
              id: `jobicy_${item.id}`,
              title: rawTitle,
              company: rawCompany,
              location: rawLoc,
              created: item.pubDate || new Date().toISOString(),
              description: rawDesc,
              redirect_url: rawUrl,
              source: 'Jobicy'
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.error('[Fetch] Jobicy error:', err.message);
    }
  }

  console.error(`[Fetch] Global Remote Feeds found: ${count} jobs`);
}

function deduplicateJobList(jobs) {
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenKeys = new Set();
  const bySource = {};

  for (const job of jobs) {
    if (!job) continue;
    const cleanId = String(job.id || '').trim();
    const cleanUrl = String(job.redirect_url || job.url || '').split('?')[0].trim().toLowerCase();
    const cleanKey = `${(job.title || '').toLowerCase().trim()}:::${(job.company || '').toLowerCase().trim()}`;

    if (cleanId && seenIds.has(cleanId)) continue;
    if (cleanUrl && seenUrls.has(cleanUrl)) continue;
    if (cleanKey && cleanKey !== ':::' && seenKeys.has(cleanKey)) continue;

    if (cleanId) seenIds.add(cleanId);
    if (cleanUrl) seenUrls.add(cleanUrl);
    if (cleanKey && cleanKey !== ':::') seenKeys.add(cleanKey);

    const src = job.source || 'Other';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(job);
  }

  // Interleave round-robin across sources so no single board monopolizes the batch
  const balanced = [];
  const sources = Object.keys(bySource);
  let hasMore = true;
  let idx = 0;

  while (hasMore) {
    hasMore = false;
    for (const src of sources) {
      if (idx < bySource[src].length) {
        balanced.push(bySource[src][idx]);
        hasMore = true;
      }
    }
    idx++;
  }

  return balanced;
}

// ── Step 5: Main Execution ──────────────────────────────────────────────────
/**
 * Executes all enabled fetchers in parallel and returns the aggregated list.
 */
async function fetchAllJobs() {
  allFetchedJobs.length = 0; // Reset array
  
  console.error(`[Multi-Board Ingestion] Executing full sweep across all ${targetTitles.length} target roles for location: ${currentLoc}`);

  for (let i = 0; i < targetTitles.length; i++) {
    currentRole = targetTitles[i];
    console.error(`\n>>> Sweeping Role [${i + 1}/${targetTitles.length}]: "${currentRole}" <<<`);
    
    // Run all fetchers concurrently for this specific role
    await Promise.allSettled([
      fetchAdzuna(),
      fetchCanadaJobBank(),
      fetchUSAJobs(),
      fetchGlobalRemoteFeeds(),
      fetchLinkedIn()
    ]);
    
    if (i < targetTitles.length - 1) {
      await new Promise(res => setTimeout(res, 1500));
    }
  }

  const uniqueJobs = deduplicateJobList(allFetchedJobs);
  console.error(`\n[Multi-Board Ingestion] Full sweep complete. Total jobs fetched: ${allFetchedJobs.length} (Unique: ${uniqueJobs.length})`);
  return uniqueJobs;
}

// If run directly from the command line, execute and print to stdout
if (require.main === module) {
  fetchAllJobs().then(jobs => {
    process.stdout.write(JSON.stringify(jobs));
  }).catch(err => {
    console.error('[Multi-Board Ingestion] Fatal error:', err);
    process.stdout.write(JSON.stringify([])); // Output empty array on failure
    process.exit(1);
  });
}

// Export for testing or direct module usage
module.exports = {
  fetchAllJobs,
  fetchAdzuna,
  fetchCanadaJobBank,
  fetchUSAJobs,
  fetchGlobalRemoteFeeds,
  fetchLinkedIn
};
