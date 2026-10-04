/**
 * node-logic.js — Core Evaluation and Filtering Logic
 *
 * PURPOSE:
 *   Provides the deterministic filtering (freshness, deduplication, geo) and
 *   scoring heuristics used by the n8n pipelines before and after LLM calls.
 *
 * EXPORTS:
 *   - normalizeJob: Standardizes job payload formats across different APIs.
 *   - runFreshnessFilter: Drops jobs older than the user's setting.
 *   - runDedupFilter: Drops jobs already present in seen_jobs.
 *   - computeHeuristicScore: Fallback CPU-based scoring if the LLM fails.
 *   - evaluateDynamicTitleFit: String-matching algorithm for job titles.
 */

const assert = require('assert');

// ── 1. Job Normalization ────────────────────────────────────────────────────
function normalizeJob(rawJob, defaultSource = 'unknown') {
  if (!rawJob) return null;

  let source = defaultSource;
  if (rawJob.source) source = String(rawJob.source).toLowerCase().replace(/\s+/g, '_');
  else if (rawJob.jobUrl?.includes('linkedin.com')) source = 'linkedin';
  else if (rawJob.adref || String(rawJob.__CLASS__ || '').includes('Adzuna')) source = 'adzuna';

  const rawId = String(rawJob.id || rawJob.jobUrl || rawJob.redirect_url || Math.random().toString(36).substring(7));
  const cleanId = rawId.startsWith(`${source}_`) ? rawId : `${source}_${rawId}`;

  const title = rawJob.title || rawJob.job_title || 'Untitled Role';
  const company = typeof rawJob.company === 'string' ? rawJob.company : rawJob.company?.display_name || rawJob.companyName || 'Unknown Company';
  const location = typeof rawJob.location === 'string' ? rawJob.location : rawJob.location?.display_name || 'Remote / Unspecified';
  const created = rawJob.created || rawJob.publishedAt || rawJob.postedTime || new Date().toISOString();
  const targetUrl = rawJob.redirect_url || rawJob.jobUrl || rawJob.applyUrl || rawJob.url || rawJob.link || '';

  return {
    id: cleanId,
    source,
    title,
    company,
    location,
    created,
    contract_type: rawJob.contractType || rawJob.contract_time || 'Full-time',
    experience_level: rawJob.experienceLevel || rawJob.experience_level || 'Mid-Senior level',
    apply_url: targetUrl,
    job_url: targetUrl,
    redirect_url: targetUrl,
    url: targetUrl,
    link: targetUrl,
    description: rawJob.description || rawJob.descriptionHtml || '',
  };
}

// ── 2. Deterministic Filtering ──────────────────────────────────────────────
function runFreshnessFilter(items, maxHours = null) {
  let limitHours = maxHours;

  if (limitHours == null) {
    try {
      const fs = require('fs');
      const path = require('path');
      const settingsPath = fs.existsSync('/data/config/settings.json')
        ? '/data/config/settings.json'
        : path.join(__dirname, '..', '..', 'data', 'config', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.freshness_hours !== undefined) limitHours = parseFloat(settings.freshness_hours);
    } catch (_) {}
  }
  
  if (limitHours == null || isNaN(limitHours)) limitHours = 24;

  // If freshness filter is disabled (0 or negative), pass all items through without date filtering
  if (limitHours <= 0) {
    return items;
  }

  const maxAgeMs = limitHours * 60 * 60 * 1000;
  const nowMs = Date.now();

  return items.filter(item => {
    const job = item.json || item;
    if (!job.created) return true;
    try {
      const createdMs = new Date(job.created).getTime();
      return isNaN(createdMs) || (nowMs - createdMs) <= maxAgeMs;
    } catch (_) {
      return true;
    }
  });
}

function runDedupFilter(items, seenIds) {
  const seenSet = new Set(seenIds.map(s => String(s).toLowerCase()));
  
  return items.filter(item => {
    const job = item.json || item;
    
    const isSeenId = job.id && seenSet.has(String(job.id).toLowerCase());
    const isSeenUrl = job.job_url && seenSet.has(String(job.job_url).toLowerCase());
    
    // Create a composite key for fuzzy deduping (Company + Title + Desc Snippet)
    const company = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const title = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Hash the description to catch real differences. We hash the entire description to ensure we don't falsely dedup different jobs with the same boilerplate prefix.
    const cleanDesc = String(job.description || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let descHash = '';
    if (cleanDesc) {
      descHash = require('crypto').createHash('md5').update(cleanDesc).digest('hex').substring(0, 8);
    }
    
    const compositeKey = company && title ? `comp_${company}_tit_${title}_desc_${descHash}` : null;
    
    const isSeenComposite = compositeKey && seenSet.has(compositeKey);

    if (isSeenId || isSeenUrl || isSeenComposite) {
      return false; // Skip duplicate
    }

    // Mark as seen for subsequent items and future runs
    if (job.id) {
      seenIds.push(String(job.id).toLowerCase());
      seenSet.add(String(job.id).toLowerCase());
    }
    if (compositeKey) {
      seenIds.push(compositeKey);
      seenSet.add(compositeKey);
    }
    
    return true; // Keep unique job
  });
}

function runGeoFilter(items, profileObj = null) {
  let isJobLocationEligible, detectTargetCountryScope;
  try {
    const gh = require('../core/geo-helper');
    isJobLocationEligible = gh.isJobLocationEligible;
    detectTargetCountryScope = gh.detectTargetCountryScope;
  } catch (_) {
    return items; // Fallback if geo-helper is missing
  }

  const profile = profileObj || getMasterProfile();
  const locations = profile.locations || [];
  const countryScope = detectTargetCountryScope ? detectTargetCountryScope(locations) : 'CA';

  return items.filter(item => {
    const loc = (item.json || item).location || '';
    return isJobLocationEligible(loc, locations, countryScope);
  });
}

// ── 3. Heuristic Scoring (CPU Fallback) ─────────────────────────────────────
function evaluateDynamicTitleFit(jobTitle, targetTitles = []) {
  // Title fit is deprecated to prevent losing qualified roles across varied company titles
  return 90;
}

function getMasterProfile() {
  const fs = require('fs');
  const path = require('path');
  const paths = [
    process.env.DATA_DIR ? path.join(__dirname, '..', '..', 'data', 'profiles', 'master-profile.json') : null,
    path.join(__dirname, '../../../data/profiles/master-profile.json'),
    '/data/profiles/master-profile.json',
  ].filter(Boolean);

  for (const p of paths) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  return {};
}

function computeHeuristicScore(job, profileObj = null) {
  const desc = (job.description || '').toLowerCase();
  const title = (job.title || '').toLowerCase();
  const fullText = `${title} ${desc}`;

  const profile = profileObj || getMasterProfile();
  const candidateSkills = (profile.skills || job.profile_skills || []).map(s => String(s).toLowerCase());
  const targetTitles = profile.target_titles || [];
  let skillsScore = 70;
  let matchedSkills = [];

  if (candidateSkills.length > 0) {
    matchedSkills = candidateSkills.filter(s => s.length > 2 && fullText.includes(s));
    skillsScore = matchedSkills.length > 0
      ? Math.min(100, Math.round(60 + (matchedSkills.length / Math.min(candidateSkills.length, 5)) * 40))
      : 65;
  }

  // Seniority & Title Hierarchy Alignment
  const wantsExec = targetTitles.some(t => /\b(director|vp|vice president|head of|chief|svp|avp)\b/i.test(t));
  const wantsManager = wantsExec || targetTitles.some(t => /\b(manager|management)\b/i.test(t));
  const wantsLead = targetTitles.some(t => /\b(lead|principal|staff|architect)\b/i.test(t));

  const isExecTitle = /\b(director|vp|vice president|head of|chief|svp|avp)\b/i.test(title);
  const isManagerTitle = /\b(manager|general manager)\b/i.test(title) || isExecTitle;
  const isLeadTitle = /\b(team lead|tech lead|technical lead|lead analyst|lead developer|lead engineer|reporting lead|solutions lead)\b/i.test(title) || /^(lead|principal|staff|architect)\b/i.test(title);
  const isJuniorTitle = /\b(junior|jr\.?|intern|internship|co-op|entry level|graduate)\b/i.test(title);

  let seniorityScore = 80;
  const disqs = [];

  if (isExecTitle && !wantsExec) {
    seniorityScore = 20;
    disqs.push('Role is an Executive/Director position; candidate targets individual contributor roles.');
  } else if (isManagerTitle && !wantsManager) {
    seniorityScore = 25;
    disqs.push('Role is a Manager/Executive level position; candidate targets individual contributor roles.');
  } else if (isLeadTitle && !wantsLead) {
    seniorityScore = 35;
    disqs.push('Role is a Lead/Principal position requiring higher seniority than candidate target.');
  } else if ((wantsExec || wantsManager) && isJuniorTitle) {
    seniorityScore = 20;
    disqs.push('Role is an entry-level/junior position; candidate is seeking management or executive roles.');
  }

  const workplaceScore = 80;
  const domainScore = 75;
  
  // Skills: 60%, Seniority: 25%, Workplace: 15%
  let overall = Math.round((skillsScore * 0.60) + (seniorityScore * 0.25) + (workplaceScore * 0.15));
  if (disqs.length > 0) overall = Math.min(overall, 45);

  const minThreshold = (typeof process !== 'undefined' && process.env?.MIN_SCORE_THRESHOLD) ? (parseInt(process.env.MIN_SCORE_THRESHOLD, 10) || 60) : 60;
  const isQualified = overall > minThreshold && disqs.length === 0;

  return {
    ...job,
    score: overall,
    breakdown: { skills_fit_score: skillsScore, seniority_fit_score: seniorityScore, workplace_fit_score: workplaceScore, domain_fit_score: domainScore },
    should_apply: isQualified,
    company_tier: 'Enterprise / Product',
    priority_level: overall >= 85 ? 'High' : overall > minThreshold ? 'Medium' : 'Low',
    key_matched_skills: matchedSkills.slice(0, 10).map(s => s.toUpperCase()),
    missing_skills: [],
    disqualification_reasons: disqs,
    reasoning: disqs.length > 0 ? disqs[0] : `Heuristic Scorer Evaluated core skills (${skillsScore}%) and seniority fit (${seniorityScore}%).`,
    why_this_fits: disqs.length > 0 ? 'Seniority / level mismatch' : `Strong skills match (${skillsScore}%)`,
    parse_error: false
  };
}

// ── 4. Quality Assurance (Workflow 2) ───────────────────────────────────────
function runClicheScanner(item) {
  const text = item.json.draft || '';
  const clicheRegex = /\b(delve|moreover|furthermore|leverage|seamless|testament to|unlock|robust|tapestry|elevate|boast)\b/gi;
  const hits = (text.match(clicheRegex) || []).length;
  item.json.cliche_hits = hits;
  item.json.needs_rewrite = hits > 2;
  return item;
}

function numericTokens(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value || '');
  return s.match(/\d[\d,.]*(?:%|[a-zA-Z]+)?/g) || [];
}

function multiset(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function runMetricVerification(originalDraft, humanizedDraft) {
  const beforeTokens = numericTokens(originalDraft);
  const afterTokens = numericTokens(humanizedDraft);

  const a = multiset(beforeTokens);
  const b = multiset(afterTokens);

  const changed =
    [...a.entries()].some(([k, n]) => (b.get(k) || 0) !== n) ||
    [...b.entries()].some(([k, n]) => (a.get(k) || 0) !== n);

  return {
    passed: !changed,
    changed,
    beforeTokens,
    afterTokens
  };
}

function runAtsCoverage(item) {
  const desc = item.json.description || '';
  const bullets = item.json.resume_bullets || [];
  
  const words = desc.split(/\W+/).filter(w => w.length > 4);
  const uniqueKeywords = [...new Set(words.map(w => w.toLowerCase()))];
  
  const resumeText = bullets.join(' ').toLowerCase();
  
  if (uniqueKeywords.length === 0) {
    item.json.ats_coverage_pct = 100;
    return item;
  }
  
  const covered = uniqueKeywords.filter(k => resumeText.includes(k));
  item.json.ats_coverage_pct = Math.round((covered.length / uniqueKeywords.length) * 100);
  return item;
}

// ── LLM Parse Score ─────────────────────────────────────────────────────────
const { extractLLMResponseText, parseLLMJsonResponse } = require('./llm-provider');

function runParseScore(item, profileObj = null) {
  if (item.json?.disqualified_deterministic) {
    Object.assign(item.json, {
      score: 0,
      overall_score: 0,
      breakdown: { title_fit_score: 0, skills_fit_score: 0, seniority_fit_score: 0, domain_fit_score: 0 },
      should_apply: false,
      priority_level: 'Low',
      reasoning: item.json.deterministic_reasoning,
      parse_error: false
    });
    return item;
  }

  // 1. If LLM provided rawText, parse it safely
  let parsed = null;
  if (item.json?.rawText) {
    parsed = parseLLMJsonResponse(item.json.rawText);
  } else if (item.json?.breakdown) {
    parsed = item.json;
  }

  // 2. Fallback: If LLM failed or response unparseable
  if (item.json?.llm_failed === true || !parsed) {
    item.json = { ...item.json, ...computeHeuristicScore(item.json, profileObj), scored_by: 'Heuristic' };
    item.json.reasoning = item.json.reasoning || "Heuristic Scorer evaluated this job because LLM was offline.";
    return item;
  }

  // 3. Deterministic Code Node Computation:
  const b = parsed.breakdown || {};
  const titleFit = typeof b.title_fit_score === 'number' ? b.title_fit_score : 80;
  const skillsFit = typeof b.skills_fit_score === 'number' ? b.skills_fit_score : 70;
  const seniorityFit = typeof b.seniority_fit_score === 'number' ? b.seniority_fit_score : 75;
  const domainFit = typeof b.domain_fit_score === 'number' ? b.domain_fit_score : 70;

  const prof = profileObj || getMasterProfile();
  const targetTitles = prof.target_titles || [];
  const wantsExec = targetTitles.some(t => /\b(director|vp|vice president|head of|chief|svp|avp)\b/i.test(t));
  const wantsManager = wantsExec || targetTitles.some(t => /\b(manager|management)\b/i.test(t));
  const wantsLead = targetTitles.some(t => /\b(lead|principal|staff|architect)\b/i.test(t));
  const jobTitle = String(item.json.title || '').toLowerCase();

  const isExecTitle = /\b(director|vp|vice president|head of|chief|svp|avp)\b/i.test(jobTitle);
  const isManagerTitle = /\b(manager|general manager)\b/i.test(jobTitle) || isExecTitle;
  const isLeadTitle = /\b(team lead|tech lead|technical lead|lead analyst|lead developer|lead engineer|reporting lead|solutions lead)\b/i.test(jobTitle) || /^(lead|principal|staff|architect)\b/i.test(jobTitle);
  const isJuniorTitle = /\b(junior|jr\.?|intern|internship|co-op|entry level|graduate)\b/i.test(jobTitle);

  const disqs = Array.isArray(parsed.disqualification_reasons) ? [...parsed.disqualification_reasons] : [];

  if (isExecTitle && !wantsExec) {
    disqs.push('Role is an Executive/Director position; candidate targets individual contributor roles.');
  } else if (isManagerTitle && !wantsManager) {
    disqs.push('Role is a Manager/Executive level position; candidate targets individual contributor roles.');
  } else if (isLeadTitle && !wantsLead) {
    disqs.push('Role is a Lead/Principal position requiring higher seniority than candidate target.');
  } else if ((wantsExec || wantsManager) && isJuniorTitle) {
    disqs.push('Role is an entry-level/junior position; candidate is seeking management or executive roles.');
  }

  // Code node arithmetic:
  let overall = Math.round(titleFit * 0.40 + skillsFit * 0.35 + seniorityFit * 0.15 + domainFit * 0.10);
  if (titleFit < 50 || disqs.length > 0) overall = Math.min(overall, 45);

  const minThreshold = (typeof process !== 'undefined' && process.env?.MIN_SCORE_THRESHOLD) ? (parseInt(process.env.MIN_SCORE_THRESHOLD, 10) || 60) : 60;
  const shouldApply = overall > minThreshold && titleFit >= 50 && disqs.length === 0;
  const priorityLevel = overall >= 80 ? 'High' : overall >= 65 ? 'Medium' : 'Low';
  const safetyTier = overall >= 80 ? 'Strongest Application' : overall >= 65 ? 'Safe Opportunity' : 'Stretch Opportunity';

  Object.assign(item.json, {
    ...parsed,
    score: overall,
    overall_score: overall,
    should_apply: shouldApply,
    priority_level: priorityLevel,
    safety_tier: safetyTier,
    disqualification_reasons: disqs,
    breakdown: {
      title_fit_score: titleFit,
      skills_fit_score: skillsFit,
      seniority_fit_score: seniorityFit,
      domain_fit_score: domainFit
    },
    parse_error: false
  });

  return item;
}

module.exports = {
  normalizeJob,
  runFreshnessFilter,
  runDedupFilter,
  runGeoFilter,
  runParseScore,
  evaluateDynamicTitleFit,
  computeHeuristicScore,
  runClicheScanner,
  runAtsCoverage,
  runMetricVerification
};
