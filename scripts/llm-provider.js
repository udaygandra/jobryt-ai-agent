/**
 * Unified Multi-Provider LLM & Dynamic Prompt Helper Module
 * Supports: Gemini, OpenAI, Claude (Anthropic), and Ollama.
 */

async function callLLMProvider({ prompt, systemInstruction = '', provider, model, env = process.env, httpRequestHelper = null }) {
  const selectedProvider = (provider || env.LLM_PROVIDER || 'gemini').toLowerCase().trim();
  
  // Default models per provider
  const defaultModels = {
    gemini: ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    claude: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    anthropic: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    ollama: ['llama3.2', 'llama3', 'mistral', 'qwen2.5']
  };

  const modelList = model ? [model] : (defaultModels[selectedProvider] || defaultModels.gemini);

  const makeRequest = async (requestConfig) => {
    if (httpRequestHelper) {
      return await httpRequestHelper(requestConfig);
    }
    // Fallback using global fetch (Node 18+)
    const headers = requestConfig.headers || {};
    if (requestConfig.json && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(requestConfig.url, {
      method: requestConfig.method || 'POST',
      headers,
      body: requestConfig.body ? JSON.stringify(requestConfig.body) : undefined
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 && (!requestConfig._retryCount || requestConfig._retryCount < 2)) {
        let waitMs = 10000;
        try {
          const parsedErr = JSON.parse(errText);
          const retryInfo = parsedErr.error?.details?.find(d => d['@type'] && d['@type'].includes('RetryInfo'));
          if (retryInfo && retryInfo.retryDelay && retryInfo.retryDelay.endsWith('s')) {
            waitMs = (parseFloat(retryInfo.retryDelay.replace('s', '')) + 1) * 1000;
          }
        } catch(e) {}
        console.log(`⚠️ HTTP 429 Rate limited. Waiting ${Math.round(waitMs/1000)}s before retrying...`);
        await new Promise(r => setTimeout(r, Math.min(waitMs, 30000)));
        requestConfig._retryCount = (requestConfig._retryCount || 0) + 1;
        return await makeRequest(requestConfig);
      }
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return await res.json();
  };

  let lastError = null;

  for (const currentModel of modelList) {
    try {
      if (selectedProvider === 'gemini') {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;
        const contents = [];
        if (systemInstruction) {
          contents.push({ role: 'user', parts: [{ text: systemInstruction }] });
        }
        contents.push({ role: 'user', parts: [{ text: prompt }] });
        const response = await makeRequest({
          method: 'POST',
          url,
          body: {
            contents,
            generationConfig: { response_mime_type: 'application/json' }
          },
          json: true
        });
        const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { success: true, provider: 'gemini', model: currentModel, rawText, response };
      }

      if (selectedProvider === 'openai') {
        const apiKey = env.OPENAI_API_KEY;
        const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
        if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set.');
        const messages = [];
        if (systemInstruction) {
          messages.push({ role: 'system', content: systemInstruction });
        }
        messages.push({ role: 'user', content: prompt });
        const response = await makeRequest({
          method: 'POST',
          url: `${baseUrl}/chat/completions`,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: {
            model: currentModel,
            messages,
            response_format: { type: 'json_object' }
          },
          json: true
        });
        const rawText = response.choices?.[0]?.message?.content || '';
        return { success: true, provider: 'openai', model: currentModel, rawText, response };
      }

      if (selectedProvider === 'claude' || selectedProvider === 'anthropic') {
        const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
        const response = await makeRequest({
          method: 'POST',
          url: 'https://api.anthropic.com/v1/messages',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: {
            model: currentModel,
            max_tokens: 4096,
            system: systemInstruction || undefined,
            messages: [{ role: 'user', content: prompt }]
          },
          json: true
        });
        const rawText = response.content?.[0]?.text || '';
        return { success: true, provider: 'claude', model: currentModel, rawText, response };
      }

      if (selectedProvider === 'ollama') {
        const baseUrl = (env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
        const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
        const response = await makeRequest({
          method: 'POST',
          url: `${baseUrl}/api/generate`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            model: currentModel,
            prompt: fullPrompt,
            stream: false,
            format: 'json'
          },
          json: true
        });
        const rawText = response.response || response.choices?.[0]?.message?.content || '';
        return { success: true, provider: 'ollama', model: currentModel, rawText, response };
      }

      throw new Error(`Unsupported LLM provider: ${selectedProvider}`);
    } catch (err) {
      console.log(`Provider ${selectedProvider} with model ${currentModel} failed:`, err.message);
      lastError = err;
    }
  }

  return { success: false, provider: selectedProvider, error: lastError ? lastError.message : 'All models failed' };
}

/**
 * Universal JSON response parser across all LLM providers
 */
function extractLLMResponseText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  
  // Gemini format
  if (item.candidates && item.candidates[0] && item.candidates[0].content && item.candidates[0].content.parts) {
    return item.candidates[0].content.parts[0].text || '';
  }
  // OpenAI / Ollama Chat Format
  if (item.choices && item.choices[0] && item.choices[0].message) {
    return item.choices[0].message.content || '';
  }
  // Anthropic / Claude Format
  if (item.content && item.content[0] && item.content[0].text) {
    return item.content[0].text || '';
  }
  // Ollama native format
  if (item.response) {
    return item.response || '';
  }
  // Direct raw text property
  if (item.rawText) {
    return item.rawText;
  }
  return '';
}

/**
 * Clean markdown blocks and parse JSON
 */
function parseLLMJsonResponse(rawText) {
  if (!rawText) return null;
  const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleanText);
  } catch (e) {
    return null;
  }
}

/**
 * Dynamic Prompt Generators based on Master Profile
 */
function buildDynamicScoringPrompt(profileObj, jobTitle, jobDescription) {
  const name = profileObj.name || 'the candidate';
  const targetTitles = Array.isArray(profileObj.target_titles) ? profileObj.target_titles.join(', ') : (profileObj.target_titles || 'N/A');
  const skills = Array.isArray(profileObj.skills) ? profileObj.skills.join(', ') : (profileObj.skills || 'N/A');
  const locations = Array.isArray(profileObj.locations) ? profileObj.locations.join(', ') : (profileObj.locations || 'N/A');
  const summary = profileObj.summary || '';
  
  let experienceSummary = '';
  if (Array.isArray(profileObj.experience)) {
    experienceSummary = profileObj.experience.map(e => `${e.role} at ${e.company} (${e.dates})`).join('; ');
  }

  return `You are a world-class AI career strategist, technical recruiter, and hiring manager evaluating job opportunities for candidate ${name}.

TARGET CANDIDATE CONTEXT:
- Candidate Name: ${name}
- Target Roles: ${targetTitles}
- Targeted Locations / Work Preferences: ${locations}
- Core Professional Skills: ${skills}
- Background Summary: ${summary}
- Career History Overview: ${experienceSummary}

EVALUATION RULES & MANDATES (UNIVERSAL FOR ANY INDUSTRY: TECH & NON-TECH):
1. STRICT TITLE & CORE PROFESSION ALIGNMENT (ZERO-TOLERANCE FOR MISMATCHED ROLES):
   - The candidate is EXCLUSIVELY targeting: ${targetTitles}.
   - You MUST evaluate whether the job title and primary function directly match the candidate's target roles.
   - If the job title represents a DIFFERENT profession, functional area, or trade than the candidate's target roles (${targetTitles}), you MUST assign:
     * title_fit_score < 40 (or 0 if totally unrelated)
     * overall_score <= 40
     * should_apply = false
   - STRICT MANDATE: Never award a high match score based on tangential or generic transferable skills (e.g. general computing, communication, coordination) if the core job title does not match what the candidate is targeting.
   - HARD RULE: If title_fit_score < 50, overall_score MUST be <= 45 and should_apply MUST be false.

2. ORGANIZATION QUALITY & REPUTATION:
   - Categorize organization into: "FAANG / Top Product", "Top Product / Enterprise", "Strong Startup", "Mid-tier", or "Low-quality / Agency".
   - Prioritize reputable established employers, leading institutions, or high-growth organizations in candidate's target field.
   - Automatically penalize / reject mass recruiters, unknown staffing agencies, spam listings, or low-quality postings.

3. SCORING PILLARS (0-100 scale each):
   - Title & Role Alignment (35% weight): Direct semantic fit with target roles: ${targetTitles}.
   - Skill & Tool Overlap (35% weight): Direct overlap with candidate's actual documented skills: ${skills}.
   - Experience & Seniority Fit (15% weight): Alignment with candidate's years of professional experience and career stage.
   - Domain & Industry Relevance (15% weight): Relevance to candidate's background and target industry preferences.

OVERALL SCORE FORMULA:
overall_score = Math.round((title_fit_score * 0.35) + (skills_fit_score * 0.35) + (seniority_fit_score * 0.15) + (domain_fit_score * 0.15))
If title_fit_score < 50, overall_score MUST be <= 45 and should_apply MUST be false.

4. STRATEGIC SAFETY TIER:
   - Categorize opportunity into one of:
     * "Strongest Application": High fit (Score >= 85), high quality, strong hiring probability.
     * "Stretch Opportunity": High upside target (Score 75-84) with ambitious growth potential.
     * "Safe Opportunity": Direct 1-to-1 skill match (Score >= 80) maximizing callback rates.

Job Title: ${jobTitle}
Job Description: ${jobDescription}

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
}`;
}

function buildDynamicGenerationPrompt(profileStr, jobDescription) {
  return `Using ONLY the facts in this candidate profile: ${profileStr}.
Do NOT invent employers, job titles, skills, certifications, or metrics that are not present in the profile.

Task:
1. Write 3 tailored resume accomplishment bullets for the candidate's most relevant role, emphasizing overlap with this job description: ${jobDescription}.
2. Write a 250-word cover letter specific to this company and role based strictly on profile facts.

Return ONLY a valid JSON object:
{
  "resume_bullets": [string, string, string],
  "cover_letter": string
}`;
}

function buildDynamicHumanizingPrompt(writingSample, draftJsonStr) {
  return `Rewrite the following JSON object so the text values match the voice, rhythm, tone and phrasing patterns of this candidate writing sample: "${writingSample}".

IMPORTANT: Preserve all underlying facts, achievements, metrics, and details exactly.
Return ONLY a valid JSON object with the exact same keys ("resume_bullets" array and "cover_letter" string).

JSON to rewrite:
${draftJsonStr}`;
}

module.exports = {
  callLLMProvider,
  extractLLMResponseText,
  parseLLMJsonResponse,
  buildDynamicScoringPrompt,
  buildDynamicGenerationPrompt,
  buildDynamicHumanizingPrompt
};
