const fs = require('fs');
const path = require('path');

const workflowsDir = path.join(__dirname, '../workflows');

// Helper snippet to reliably load profileObj in any n8n Code node
const profileLoaderSnippet = `const fs = require('fs');
let profileObj = {};
try {
  const profileItem = $('Format Profile').first();
  if (profileItem && profileItem.json && profileItem.json.profile && profileItem.json.profile.name) {
    profileObj = profileItem.json.profile;
  }
} catch(e) {}

if (!profileObj.name || !profileObj.target_titles) {
  try {
    profileObj = JSON.parse(fs.readFileSync('/data/master-profile.json', 'utf8'));
  } catch(e) {
    try {
      profileObj = JSON.parse(fs.readFileSync('data/master-profile.json', 'utf8'));
    } catch(e2) {}
  }
}`;

// 1. Definition for Format Profile node (reads directly from /data/master-profile.json)
const formatProfileJsCode = `const fs = require('fs');
let profileObj = {};
try {
  profileObj = JSON.parse(fs.readFileSync('/data/master-profile.json', 'utf8'));
} catch (e) {
  try {
    profileObj = JSON.parse(fs.readFileSync('data/master-profile.json', 'utf8'));
  } catch (e2) {
    for (let item of $input.all()) {
      if (item.json && item.json.name) profileObj = item.json;
    }
  }
}

return [{
  json: {
    profile: profileObj,
    profileString: JSON.stringify(profileObj)
  }
}];`;

// 2. Definition for Prepare Search Queries node (Rotates roles, queries pages 1 & 2 per run to prevent 429)
const prepareQueriesNode = {
  parameters: {
    jsCode: `${profileLoaderSnippet}
const targetTitles = Array.isArray(profileObj.target_titles) && profileObj.target_titles.length > 0
  ? profileObj.target_titles
  : [$env.ADZUNA_SEARCH_ROLE || 'Data Analyst'];

const targetLocations = Array.isArray(profileObj.locations) && profileObj.locations.length > 0
  ? profileObj.locations.map(l => l.split(',')[0].trim())
  : [$env.ADZUNA_SEARCH_LOCATION || 'Toronto'];

// Rotate role per execution to conserve Adzuna rate limits and monthly quota
let roleIdx = 0;
const idxFile = '/data/adzuna_role_idx.json';
try {
  if (fs.existsSync(idxFile)) {
    const data = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    roleIdx = (data.idx || 0) % targetTitles.length;
  }
} catch(e) {}

try {
  fs.writeFileSync(idxFile, JSON.stringify({ idx: (roleIdx + 1) % targetTitles.length }));
} catch(e) {}

const currentRole = targetTitles[roleIdx];
const currentLoc = targetLocations[0] || 'Toronto';

// 2 pages per run spaced out by 2.5s
return [
  { json: { role: currentRole, page: 1, where: currentLoc } },
  { json: { role: currentRole, page: 2, where: currentLoc } }
];`
  },
  name: "Prepare Search Queries",
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [700, 0]
};

// 3. Definition for Adzuna Fetch node (Includes 2.5s batchInterval to strictly obey 1 req/sec limit)
const adzunaFetchNode = {
  parameters: {
    url: "=https://api.adzuna.com/v1/api/jobs/ca/search/{{ $json.page }}",
    sendQuery: true,
    queryParameters: {
      parameters: [
        {
          name: "app_id",
          value: "={{ $env.ADZUNA_APP_ID }}"
        },
        {
          name: "app_key",
          value: "={{ $env.ADZUNA_APP_KEY }}"
        },
        {
          name: "what_phrase",
          value: "={{ $json.role }}"
        },
        {
          name: "where",
          value: "={{ $json.where }}"
        },
        {
          name: "sort_by",
          value: "date"
        },
        {
          name: "max_days_old",
          value: "14"
        },
        {
          name: "results_per_page",
          value: "20"
        }
      ]
    },
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 2500
        }
      }
    }
  },
  name: "Adzuna Fetch",
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.1,
  position: [900, 0],
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  onError: "continueRegularOutput"
};

// 4. Definition for LLM Match Score node (Reliably loads profile context, uses gemini-3.5-flash-lite, pacing delay)
const llmMatchScoreJsCode = `const provider = ($env.LLM_PROVIDER || 'gemini').toLowerCase().trim();
const modelOverride = $env.LLM_MODEL || null;

${profileLoaderSnippet}

const candidateName = profileObj.name || 'Candidate';
const targetTitlesArr = Array.isArray(profileObj.target_titles) ? profileObj.target_titles : [profileObj.target_titles || 'N/A'];
const candidateSkills = Array.isArray(profileObj.skills) ? profileObj.skills.join(', ') : (profileObj.skills || 'N/A');
const experienceSummary = Array.isArray(profileObj.experience) ? profileObj.experience.map(e => \`\${e.role} at \${e.company} (\${e.dates})\`).join('; ') : '';
const locationsStr = Array.isArray(profileObj.locations) ? profileObj.locations.join(', ') : (profileObj.locations || 'N/A');

for (let item of $input.all()) {
  const title = item.json.title || "";
  const desc = item.json.description || "";

  const prompt = \`You are a world-class AI career strategist, technical recruiter, and hiring manager evaluating job opportunities for candidate \${candidateName}.

TARGET CANDIDATE CONTEXT:
- Candidate Name: \${candidateName}
- Target Roles: \${targetTitlesArr.join(', ')}
- Targeted Locations / Work Preferences: \${locationsStr}
- Core Professional Skills: \${candidateSkills}
- Background Summary: \${profileObj.summary || ''}
- Career History Overview: \${experienceSummary}

EVALUATION RULES & MANDATES (UNIVERSAL FOR ANY INDUSTRY: TECH & NON-TECH):
1. STRICT TITLE & CORE PROFESSION ALIGNMENT (ZERO-TOLERANCE FOR MISMATCHED ROLES):
   - The candidate is EXCLUSIVELY targeting: \${targetTitlesArr.join(', ')}.
   - You MUST evaluate whether the job title and primary function directly match the candidate's target roles.
   - If the job title represents a DIFFERENT profession, functional area, or trade than the candidate's target roles (\${targetTitlesArr.join(', ')}), you MUST assign:
     * title_fit_score < 40 (or 0 if totally unrelated)
     * overall_score <= 40
     * should_apply = false
   - If the job title IS a direct match or strong seniority variation of the target roles (e.g. Data Analyst, Senior Data Analyst, Business Intelligence Analyst for a candidate targeting Data Analyst), evaluate the skills, seniority, and domain fit fairly and award appropriate scores (70-95).
   - HARD RULE: If title_fit_score < 50, overall_score MUST be <= 45 and should_apply MUST be false.

2. ORGANIZATION QUALITY & REPUTATION:
   - Categorize organization into: "FAANG / Top Product", "Top Product / Enterprise", "Strong Startup", "Mid-tier", or "Low-quality / Agency".
   - Automatically penalize/reject mass recruiters, unknown staffing agencies, spam listings, or low-quality postings.

3. SCORING PILLARS (0-100 scale each):
   - title_fit_score: Direct alignment of the job title with candidate target roles: \${targetTitlesArr.join(', ')}.
   - skills_fit_score: Direct overlap with candidate's actual professional skills: \${candidateSkills}.
   - seniority_fit_score: Alignment with candidate experience level and tenure.
   - domain_fit_score: Direct match or transferability to candidate demonstrated domains and background.

OVERALL SCORE FORMULA:
overall_score = Math.round((title_fit_score * 0.40) + (skills_fit_score * 0.35) + (seniority_fit_score * 0.15) + (domain_fit_score * 0.10))
CRITICAL CONSTRAINT: If title_fit_score < 50, overall_score MUST be capped at <= 45 and should_apply MUST be false.

Job Title: \${title}
Job Description: \${desc}

Respond ONLY with a valid JSON object matching this exact schema:
{
  "overall_score": number,
  "breakdown": {
    "title_fit_score": number,
    "skills_fit_score": number,
    "seniority_fit_score": number,
    "domain_fit_score": number
  },
  "should_apply": boolean,
  "company_tier": "FAANG / Top Product / Top Product / Enterprise / Strong Startup / Mid-tier / Low-quality",
  "work_type": "Remote / Hybrid / Onsite / Unknown",
  "safety_tier": "Strongest Application / Stretch Opportunity / Safe Opportunity",
  "priority_level": "High / Medium / Low",
  "key_matched_skills": [string],
  "missing_skills": [string],
  "experience_match_summary": string,
  "why_this_fits": string,
  "disqualification_reasons": [string],
  "compensation_insight": string,
  "notes_concerns": string,
  "reasoning": string
}\`;

  let responseData = null;

  if (provider === 'gemini') {
    const apiKey = $env.GEMINI_API_KEY;
    const models = modelOverride ? [modelOverride] : ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];
    for (let model of models) {
      try {
        responseData = await this.helpers.httpRequest({
          method: 'POST',
          url: \`https://generativelanguage.googleapis.com/v1beta/models/\${model}:generateContent?key=\${apiKey}\`,
          body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: "application/json" } },
          json: true
        });
        if (responseData && responseData.candidates && responseData.candidates[0]) {
          break;
        }
      } catch (e) {
        continue;
      }
    }
  } else if (provider === 'openai') {
    const apiKey = $env.OPENAI_API_KEY;
    const baseUrl = ($env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\\/+$/, '');
    const models = modelOverride ? [modelOverride] : ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
    for (let model of models) {
      try {
        responseData = await this.helpers.httpRequest({
          method: 'POST',
          url: \`\${baseUrl}/chat/completions\`,
          headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
          body: { model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } },
          json: true
        });
        break;
      } catch (e) { continue; }
    }
  }

  if (responseData) {
    item.json = { ...item.json, ...responseData };
  } else {
    item.json.llm_failed = true;
  }
  
  // Pacing delay to avoid burst rate-limiting
  await new Promise(r => setTimeout(r, 400));
}
return $input.all();`;

// 5. Definition for Parse Score node (Universal dynamic contiguous phrase matching + Graceful Heuristic Fallback)
const parseScoreJsCode = `function evaluateDynamicTitleFit(jobTitle, targetTitles) {
  if (!jobTitle) return 0;
  if (!Array.isArray(targetTitles) || targetTitles.length === 0) return 70;
  const cleanJob = jobTitle.toLowerCase().replace(/[^a-z0-9\\s]/g, ' ');
  const jobTokens = new Set(cleanJob.split(/\\s+/).filter(w => w.length > 1));
  let maxFit = 0;
  for (const target of targetTitles) {
    if (!target) continue;
    const cleanTarget = target.toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').trim();
    if (cleanJob.includes(cleanTarget) || cleanTarget.includes(cleanJob)) {
      maxFit = Math.max(maxFit, 95);
      continue;
    }
    const targetTokens = cleanTarget.split(/\\s+/).filter(w => w.length > 1);
    if (targetTokens.length === 0) continue;
    const modifiers = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'associate', 'intermediate', 'ii', 'iii', 'iv', 'enterprise', 'b2b', 'corporate', 'commercial']);
    const coreTokens = targetTokens.filter(t => !modifiers.has(t));
    const tokensToCheck = coreTokens.length > 0 ? coreTokens : targetTokens;
    const corePhrase = tokensToCheck.join(' ');
    if (tokensToCheck.length >= 2 && cleanJob.includes(corePhrase)) {
      let phraseScore = 90;
      const isSeniorJob = cleanJob.includes('senior') || cleanJob.includes('sr') || cleanJob.includes('lead');
      const isSeniorTarget = cleanTarget.includes('senior') || cleanTarget.includes('sr') || cleanTarget.includes('lead');
      if (isSeniorJob === isSeniorTarget) phraseScore = 95;
      if (phraseScore > maxFit) maxFit = phraseScore;
      continue;
    }
    let matchedCount = 0;
    for (const token of tokensToCheck) {
      if (jobTokens.has(token)) matchedCount++;
    }
    const ratio = matchedCount / tokensToCheck.length;
    let score = Math.round(ratio * 40);
    if (matchedCount === tokensToCheck.length) score = 80;
    if (score > maxFit) maxFit = score;
  }
  return maxFit;
}

${profileLoaderSnippet}

const targetTitles = Array.isArray(profileObj.target_titles) && profileObj.target_titles.length > 0 
  ? profileObj.target_titles 
  : ['Data Analyst'];

const extractText = (item) => {
  if (item.candidates && item.candidates[0] && item.candidates[0].content && item.candidates[0].content.parts) {
    return item.candidates[0].content.parts[0].text || '';
  }
  if (item.choices && item.choices[0] && item.choices[0].message) {
    return item.choices[0].message.content || '';
  }
  if (item.content && item.content[0] && item.content[0].text) {
    return item.content[0].text || '';
  }
  if (item.response) {
    return item.response || '';
  }
  return '';
};

const originalItems = $('Dedup Filter').all();
for (let i = 0; i < $input.all().length; i++) {
  let original = originalItems[i] ? originalItems[i].json : {};
  let item = $input.all()[i];
  let title = (original.title || item.json.title || '').trim();
  let desc = (original.description || item.json.description || '').toLowerCase();

  const dynamicFit = evaluateDynamicTitleFit(title, targetTitles);
  let rawText = extractText(item.json);
  let parsed = null;

  if (rawText) {
    try {
      let cleanText = rawText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
      parsed = JSON.parse(cleanText);
    } catch (e) {}
  }

  if (parsed && typeof parsed.overall_score === 'number' && parsed.overall_score > 0) {
    let score = parsed.overall_score;
    let titleFit = parsed.breakdown?.title_fit_score ?? dynamicFit;

    if (targetTitles.length > 0 && dynamicFit < 40) {
      titleFit = Math.min(titleFit, dynamicFit);
      score = Math.min(score, 35);
    } else if (targetTitles.length > 0 && dynamicFit < 50) {
      titleFit = Math.min(titleFit, dynamicFit);
      score = Math.min(score, 45);
    }
    if (typeof titleFit === 'number' && titleFit < 50) {
      score = Math.min(score, 45);
    }

    item.json = {
      ...original,
      score: score,
      breakdown: parsed.breakdown || { title_fit_score: titleFit, skills_fit_score: score, seniority_fit_score: score, domain_fit_score: score },
      should_apply: score >= 70 && titleFit >= 50,
      company_tier: parsed.company_tier || 'Unknown',
      work_type: parsed.work_type || 'Unknown',
      safety_tier: parsed.safety_tier || (score >= 85 ? 'Strongest Application' : score >= 80 ? 'Safe Opportunity' : 'Stretch Opportunity'),
      priority_level: parsed.priority_level || (score >= 85 ? 'High' : score >= 70 ? 'Medium' : 'Low'),
      key_matched_skills: parsed.key_matched_skills || [],
      missing_skills: parsed.missing_skills || [],
      experience_match_summary: parsed.experience_match_summary || '',
      why_this_fits: parsed.why_this_fits || '',
      disqualification_reasons: parsed.disqualification_reasons || (titleFit < 50 ? [\`Title mismatch: "\${title}" does not align with target roles (\${targetTitles.join(', ')}).\`] : []),
      compensation_insight: parsed.compensation_insight || 'N/A',
      notes_concerns: parsed.notes_concerns || '',
      reasoning: parsed.reasoning || '',
      parse_error: false
    };
  } else {
    // Dynamic Heuristic Fallback: Ensures genuine roles pass and non-targets fail even if LLM has temporary hiccup
    const candidateSkills = (profileObj.skills || []).map(s => String(s).toLowerCase());
    const fullText = \`\${title.toLowerCase()} \${desc}\`;
    const matchedSkills = candidateSkills.filter(s => s.length > 2 && fullText.includes(s));
    const skillsScore = matchedSkills.length > 0 
      ? Math.min(100, Math.round(60 + (matchedSkills.length / Math.min(candidateSkills.length, 5)) * 40)) 
      : 50;

    let overall = Math.round((dynamicFit * 0.40) + (skillsScore * 0.35) + (80 * 0.15) + (70 * 0.10));
    if (dynamicFit < 50) {
      overall = Math.min(overall, 40);
    }
    const shouldApply = overall >= 70 && dynamicFit >= 50;

    item.json = {
      ...original,
      score: overall,
      breakdown: { title_fit_score: dynamicFit, skills_fit_score: skillsScore, seniority_fit_score: 80, domain_fit_score: 70 },
      should_apply: shouldApply,
      company_tier: 'Enterprise / Product',
      work_type: 'Unknown',
      safety_tier: overall >= 85 ? 'Strongest Application' : overall >= 80 ? 'Safe Opportunity' : 'Stretch Opportunity',
      priority_level: overall >= 85 ? 'High' : overall >= 70 ? 'Medium' : 'Low',
      key_matched_skills: matchedSkills.slice(0, 10).map(s => s.toUpperCase()),
      missing_skills: [],
      experience_match_summary: 'Evaluated via dynamic candidate profile alignment',
      why_this_fits: shouldApply ? 'Strong alignment with target profession and profile skills' : 'Non-aligned profession',
      disqualification_reasons: dynamicFit < 50 ? [\`Title mismatch: "\${title}" does not align with target roles (\${targetTitles.join(', ')}).\`] : [],
      compensation_insight: 'Market standard',
      notes_concerns: '',
      reasoning: shouldApply 
        ? \`Candidate target title match (\${dynamicFit}%) with confirmed skills: \${matchedSkills.slice(0, 5).join(', ')}.\`
        : \`Title mismatch: "\${title}" does not match target roles (\${targetTitles.join(', ')}).\`,
      parse_error: false
    };
  }
}

let items = $input.all();
items.sort((a, b) => b.json.score - a.json.score);
return items;`;

function updateWorkflow(filename) {
  const filePath = path.join(workflowsDir, filename);
  const wf = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Update Format Profile node
  const formatProfileNode = wf.nodes.find(n => n.name === "Format Profile");
  if (formatProfileNode) {
    formatProfileNode.parameters.jsCode = formatProfileJsCode;
  }

  // Replace or add Prepare Search Queries and Adzuna Fetch
  let nodes = wf.nodes.filter(n => n.name !== "Prepare Search Queries" && n.name !== "Adzuna Fetch");
  
  const readSeenIdx = nodes.findIndex(n => n.name === "Read Seen Jobs");
  nodes.splice(readSeenIdx + 1, 0, prepareQueriesNode, adzunaFetchNode);

  // Update LLM Match Score
  const llmNode = nodes.find(n => n.name === "LLM Match Score");
  if (llmNode) {
    llmNode.parameters.jsCode = llmMatchScoreJsCode;
  }

  // Update Parse Score
  const parseNode = nodes.find(n => n.name === "Parse Score");
  if (parseNode) {
    parseNode.parameters.jsCode = parseScoreJsCode;
  }

  // Update connections
  wf.connections["Read Seen Jobs"] = {
    main: [[{ node: "Prepare Search Queries", type: "main", index: 0 }]]
  };
  wf.connections["Prepare Search Queries"] = {
    main: [[{ node: "Adzuna Fetch", type: "main", index: 0 }]]
  };
  wf.connections["Adzuna Fetch"] = {
    main: [[{ node: "Split Out", type: "main", index: 0 }]]
  };

  wf.nodes = nodes;
  fs.writeFileSync(filePath, JSON.stringify(wf, null, 2));
  console.log(`✅ Updated ${filename}`);
  return wf;
}

updateWorkflow('1-fetch-dedup-score.json');
updateWorkflow('master-workflow.json');
console.log('Workflows successfully updated on disk.');
