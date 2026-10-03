/**
 * llm-provider.js — Unified LLM API Integration
 *
 * PURPOSE:
 *   Provides a unified interface for calling multiple LLM providers:
 *   Gemini, OpenAI, Anthropic/Claude, Groq, DeepSeek, OpenRouter, and Ollama.
 *   Handles retries, rate limiting, and unified JSON response parsing.
 *
 * USAGE:
 *   const { callLLMProvider } = require('./llm-provider');
 *   const result = await callLLMProvider({ provider: 'gemini', prompt: 'Hello' });
 */

const { loadPrompt } = require('../core/prompt-loader');
const {
  getNextWaterfallModel,
  recordModelCall,
  recordModelError
} = require('./llm-state-manager');

// ── Default Models Configuration ─────────────────────────────────────────────
const DEFAULT_MODELS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-31b', 'gemma-4-26b'],
  google: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-31b', 'gemma-4-26b'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'gpt-3.5-turbo'],
  claude: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
  anthropic: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
  groq: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'llama-3.1-8b-instant'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'],
  ollama: ['llama3.2', 'llama3', 'mistral', 'qwen2.5'],
};

// ── Core LLM Calling Function ───────────────────────────────────────────────
/**
 * Calls an LLM provider using either a provided HTTP helper or the native fetch API.
 * Supports fallback to a list of models if the primary model fails.
 */
async function callLLMProvider({ prompt, systemInstruction = '', provider, model, env = process.env, httpRequestHelper = null }) {
  const selectedProvider = (provider || env.LLM_PROVIDER || 'gemini').toLowerCase().trim();
  
  let candidateModel = null;
  if (selectedProvider === 'gemini' || selectedProvider === 'google') {
    const nextObj = getNextWaterfallModel();
    if (nextObj && nextObj.model) candidateModel = nextObj.model.id;
  }

  const modelList = candidateModel
    ? [candidateModel, ...(DEFAULT_MODELS.gemini.filter(m => m !== candidateModel))]
    : (model ? [model] : (DEFAULT_MODELS[selectedProvider] || DEFAULT_MODELS.gemini));

  // Helper for making HTTP requests with automatic 429 rate limit retries
  const makeRequest = async (config) => {
    if (httpRequestHelper) return await httpRequestHelper(config);

    const headers = config.headers || {};
    if (config.json && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const res = await fetch(config.url, {
      method: config.method || 'POST',
      headers,
      body: config.body ? JSON.stringify(config.body) : undefined,
    });

    if (!res.ok) {
      const errText = await res.text();
      const isExhausted = errText.includes('RESOURCE_EXHAUSTED') || errText.includes('Quota exceeded');
      
      // Auto-retry once on 429 (Rate Limit) if not completely exhausted
      if (res.status === 429 && !isExhausted && (!config._retryCount || config._retryCount < 1)) {
        let waitMs = 3000;
        try {
          const parsedErr = JSON.parse(errText);
          const retryInfo = parsedErr.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
          if (retryInfo?.retryDelay?.endsWith('s')) {
            waitMs = (parseFloat(retryInfo.retryDelay.replace('s', '')) + 1) * 1000;
          }
        } catch (_) {}
        
        const actualWait = Math.min(waitMs, 3000);
        console.log(`⚠️ HTTP 429 Rate limited. Waiting ${Math.round(actualWait / 1000)}s before retry...`);
        await new Promise(r => setTimeout(r, actualWait));
        
        config._retryCount = (config._retryCount || 0) + 1;
        return await makeRequest(config);
      }
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return await res.json();
  };

  let lastError = null;

  // Try each model in the fallback list until one succeeds
  for (const currentModel of modelList) {
    try {
      // 1. Google Gemini
      if (selectedProvider === 'gemini' || selectedProvider === 'google') {
        const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
        if (!geminiKey) throw new Error('GEMINI_API_KEY is not set.');
        const contents = [];
        if (systemInstruction) contents.push({ role: 'user', parts: [{ text: systemInstruction }] });
        contents.push({ role: 'user', parts: [{ text: prompt }] });
        
        const response = await makeRequest({
          url: `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${geminiKey}`,
          body: { contents, generationConfig: { response_mime_type: 'application/json' } },
          json: true,
        });
        const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        recordModelCall(currentModel);
        return { success: true, provider: 'gemini', model: currentModel, rawText, response };
      }

      // 2. OpenAI / Groq / DeepSeek / OpenRouter (OpenAI-compatible APIs)
      if (['openai', 'groq', 'deepseek', 'openrouter'].includes(selectedProvider)) {
        const keyMap = { openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
        const baseMap = { openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1', deepseek: 'https://api.deepseek.com/v1', openrouter: 'https://openrouter.ai/api/v1' };
        
        const apiKey = env[keyMap[selectedProvider]];
        const baseUrl = (env[`${selectedProvider.toUpperCase()}_BASE_URL`] || baseMap[selectedProvider]).replace(/\/+$/, '');
        
        if (!apiKey) throw new Error(`${keyMap[selectedProvider]} is not set.`);
        
        const messages = [];
        if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
        messages.push({ role: 'user', content: prompt });
        
        const response = await makeRequest({
          url: `${baseUrl}/chat/completions`,
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: { model: currentModel, messages, response_format: { type: 'json_object' } },
          json: true,
        });
        const rawText = response.choices?.[0]?.message?.content || '';
        return { success: true, provider: selectedProvider, model: currentModel, rawText, response };
      }

      // 3. Anthropic (Claude)
      if (selectedProvider === 'claude' || selectedProvider === 'anthropic') {
        const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
        
        const response = await makeRequest({
          url: 'https://api.anthropic.com/v1/messages',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: {
            model: currentModel,
            max_tokens: 4096,
            system: systemInstruction || undefined,
            messages: [{ role: 'user', content: prompt }],
          },
          json: true,
        });
        const rawText = response.content?.[0]?.text || '';
        return { success: true, provider: 'claude', model: currentModel, rawText, response };
      }

      // 4. Ollama (Local)
      if (selectedProvider === 'ollama') {
        const baseUrl = (env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
        const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
        
        const response = await makeRequest({
          url: `${baseUrl}/api/generate`,
          body: { model: currentModel, prompt: fullPrompt, stream: false, format: 'json' },
          json: true,
        });
        const rawText = response.response || response.choices?.[0]?.message?.content || '';
        return { success: true, provider: selectedProvider, model: currentModel, rawText, response };
      }

      throw new Error(`Unsupported LLM provider: ${selectedProvider}`);
    } catch (err) {
      const errMsg = err.message || '';
      console.log(`[LLM] Provider ${selectedProvider} with model ${currentModel} failed:`, errMsg);
      recordModelError(currentModel, err);
      lastError = err;
    }
  }

  return { success: false, provider: selectedProvider, error: lastError ? lastError.message : 'All models failed' };
}

// ── Utility: Parse JSON output across different providers ───────────────────
function extractLLMResponseText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (item.candidates?.[0]?.content?.parts?.[0]) return item.candidates[0].content.parts[0].text || ''; // Gemini
  if (item.choices?.[0]?.message) return item.choices[0].message.content || ''; // OpenAI/Groq/Ollama Chat
  if (item.content?.[0]?.text) return item.content[0].text || ''; // Anthropic
  if (item.response) return item.response || ''; // Ollama native
  if (item.rawText) return item.rawText;
  return '';
}

function parseLLMJsonResponse(rawText) {
  if (!rawText) return null;
  const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleanText); } catch (_) { return null; }
}

// ── Dynamic Prompts ─────────────────────────────────────────────────────────

function buildDynamicScoringPrompt(profileObj, jobTitle, jobDescription, company = 'Direct Employer') {
  const name = profileObj.name || 'Candidate';
  const targetTitles = Array.isArray(profileObj.target_titles) ? profileObj.target_titles.join(', ') : (profileObj.target_titles || 'N/A');
  const skills = Array.isArray(profileObj.skills) ? profileObj.skills.join(', ') : (profileObj.skills || 'N/A');
  const locations = Array.isArray(profileObj.locations) ? profileObj.locations.join(', ') : (profileObj.locations || 'Remote / Any');
  const summary = profileObj.summary || '';
  const workStatus = profileObj.contact?.status || profileObj.work_authorization || 'Permanent Resident / Authorized to work';
  const yearsExperience = profileObj.years_of_experience || (Array.isArray(profileObj.experience) ? Math.max(1, profileObj.experience.length * 2) : 3);
  
  const experienceSummary = Array.isArray(profileObj.experience)
    ? profileObj.experience.map(e => `${e.role}${e.project ? ` (${e.project})` : ''} at ${e.company} (${e.dates})`).join('; ')
    : '';

  const fallbackScoringPrompt = `You are evaluating one job posting against one candidate.
<candidate>
Name: {{CANDIDATE_NAME}}
Target roles: {{TARGET_ROLES}}
Locations / work preferences: {{LOCATIONS}}
Work authorization: {{WORK_STATUS}}
Years of experience: {{YEARS_EXPERIENCE}}
Skills: {{SKILLS}}
Summary: {{SUMMARY}}
Experience overview: {{EXPERIENCE_SUMMARY}}
</candidate>

<job_posting>
Title: {{JOB_TITLE}}
Company: {{COMPANY}}
Description: {{JOB_DESCRIPTION}}
</job_posting>

Return ONLY JSON. Do NOT compute overall_score or should_apply.
{
  "key_matched_skills": [string],
  "missing_skills": [string],
  "disqualification_reasons": [string],
  "experience_match_summary": string,
  "why_this_fits": string,
  "notes_concerns": string,
  "reasoning": string,
  "compensation_insight": string,
  "company_tier": "FAANG_TOP_PRODUCT|TOP_ENTERPRISE|STRONG_STARTUP|MID_TIER|LOW_QUALITY|UNKNOWN",
  "work_type": "Remote|Hybrid|Onsite|Unknown",
  "breakdown": {"title_fit_score": number, "skills_fit_score": number, "seniority_fit_score": number, "domain_fit_score": number}
}`;

  return loadPrompt('job-scoring.txt', {
    CANDIDATE_NAME: name,
    TARGET_ROLES: targetTitles,
    LOCATIONS: locations,
    WORK_STATUS: workStatus,
    YEARS_EXPERIENCE: String(yearsExperience),
    SKILLS: skills,
    SUMMARY: summary,
    EXPERIENCE_SUMMARY: experienceSummary,
    JOB_TITLE: jobTitle,
    COMPANY: company,
    JOB_DESCRIPTION: jobDescription,
  }, fallbackScoringPrompt);
}

function buildDynamicGenerationPrompt(profileData, jobDescription, jobTitle = 'Target Role', company = 'Target Company') {
  const profileJsonStr = typeof profileData === 'string' ? profileData : JSON.stringify(profileData, null, 2);
  const fallbackGenPrompt = `You tailor a resume summary and cover letter to one job. Use ONLY facts in <profile>.
<profile>{{PROFILE_JSON}}</profile>
<job_posting>Title: {{JOB_TITLE}} | Company: {{COMPANY}}
{{JOB_DESCRIPTION}}</job_posting>

Return ONLY JSON: {"tailored_summary": "...", "cover_letter": "..."}`;

  return loadPrompt('resume-tailoring.txt', {
    PROFILE_JSON: profileJsonStr,
    CANDIDATE_PROFILE: profileJsonStr, // Backwards compatibility
    JOB_TITLE: jobTitle,
    COMPANY: company,
    JOB_DESCRIPTION: jobDescription,
  }, fallbackGenPrompt);
}

function buildDynamicHumanizingPrompt(writingSample, draftJsonStr) {
  const fallbackHumanizePrompt = `Rewrite the following JSON object so the text values match the voice of this writing sample.
<writing_sample>
{{WRITING_SAMPLE}}
</writing_sample>
<draft_json>
{{DRAFT_JSON}}
</draft_json>
Return ONLY valid JSON: {"tailored_summary": "...", "cover_letter": "..."}`;

  return loadPrompt('humanize.txt', {
    WRITING_SAMPLE: writingSample || 'Concise, direct, data-driven executive tone.',
    DRAFT_JSON: draftJsonStr,
  }, fallbackHumanizePrompt);
}

function buildDynamicColdEmailPrompt(candidateName, email, jobTitle, company, contactName, matchedAchievements, jobDescription) {
  const achievementsStr = Array.isArray(matchedAchievements)
    ? matchedAchievements.map(a => `• ${a}`).join('\n')
    : String(matchedAchievements || '');

  const fallbackEmailPrompt = `Write a cold email about the {{JOB_TITLE}} role at {{COMPANY}} to {{CONTACT_NAME}}.
<candidate_facts>{{MATCHED_ACHIEVEMENTS}}</candidate_facts>
<job_posting>{{JOB_DESCRIPTION}}</job_posting>
Return ONLY JSON: {"subject": "...", "body": "..."}`;

  return loadPrompt('cold-email.txt', {
    JOB_TITLE: jobTitle,
    COMPANY: company,
    CONTACT_NAME: contactName || '',
    MATCHED_ACHIEVEMENTS: achievementsStr,
    JOB_DESCRIPTION: jobDescription,
    CANDIDATE_NAME: candidateName || 'Candidate',
    EMAIL: email || 'candidate@example.com',
  }, fallbackEmailPrompt);
}

module.exports = {
  callLLMProvider,
  extractLLMResponseText,
  parseLLMJsonResponse,
  buildDynamicScoringPrompt,
  buildDynamicGenerationPrompt,
  buildDynamicHumanizingPrompt,
  buildDynamicColdEmailPrompt,
};
