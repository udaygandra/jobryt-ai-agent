/**
 * resume-to-profile.js — Resume Parser & Profile Generator
 *
 * PURPOSE:
 *   Ingests a resume file (PDF, TXT, DOCX, MD), parses it using an LLM 
 *   with strict zero-fabrication rules, and updates data/profiles/master-profile.json.
 *
 * FEATURES:
 *   - Multimodal PDF processing
 *   - Strict enforcement against hallucination
 *   - Automatic profile backup
 *
 * USAGE:
 *   node scripts/resume-to-profile.js <path-to-resume> [--test] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Step 1: Environment & Setup ─────────────────────────────────────────────
const { loadEnv } = require('../core/load-env');
loadEnv();

const { getDataDir } = require('../core/common-utils');
const { loadPrompt } = require('../core/prompt-loader');
const dataDir = getDataDir();
const profilePath = path.join(dataDir, 'profiles', 'master-profile.json');
const backupPath = path.join(dataDir, 'profiles', 'master-profile.backup.json');

const DEFAULT_SYSTEM_PROMPT = `You are a high-precision resume parsing engine.
Your task is to extract all information from the provided resume and output a valid JSON object matching the exact master-profile schema.

CRITICAL RULES - ZERO FABRICATION:
1. Do NOT invent, extrapolate, or hallucinate ANY details (companies, titles, skills, dates).
2. Copy EVERY bullet point verbatim. Do NOT condense or omit.
3. Extract ALL skills, tools, and technologies as individual strings in an array.
4. Extract complete contact details (email, phone, location, linkedin).

Respond ONLY with valid JSON in this schema:
{
  "name": "Full Name",
  "target_titles": ["Title 1", "Title 2"],
  "locations": ["City, Region"],
  "contact": { "email": "", "phone": "", "location": "", "linkedin": "" },
  "summary": "Professional summary verbatim",
  "skills": ["Skill 1", "Skill 2"],
  "experience": [
    {
      "role": "Exact Job Title",
      "company": "Exact Company Name",
      "dates": "Exact Dates",
      "bullets": ["Verbatim bullet 1", "Verbatim bullet 2"]
    }
  ],
  "education": [
    { "degree": "", "institution": "", "dates": "" }
  ]
}`;

const SYSTEM_PROMPT = loadPrompt('resume-parser.txt', {}, DEFAULT_SYSTEM_PROMPT);

function cleanDocxAndMarkdownArtifacts(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    // Strip bold/italic asterisks embedded in words (e.g. Pyt****hon -> Python)
    .replace(/([a-zA-Z0-9])\*+([a-zA-Z0-9])/g, '$1$2')
    // Strip stray markdown markers like ** ****&**** ** -> &
    .replace(/\*+/g, '')
    // Normalize dashes and quotation marks
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    // Collapse multiple consecutive spaces and whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

function calculateYearsOfExperience(experience = []) {
  if (!Array.isArray(experience) || experience.length === 0) return 0;
  let totalMonths = 0;
  for (const exp of experience) {
    const datesStr = exp.dates || '';
    const match = datesStr.match(/([a-zA-Z]+)?\s*(\d{4})\s*[\u2013\u2014\-–—to]+\s*([a-zA-Z]+)?\s*(\d{4}|present|current)/i);
    if (match) {
      const startYear = parseInt(match[2], 10);
      const endYear = match[4].toLowerCase().includes('pres') || match[4].toLowerCase().includes('curr')
        ? new Date().getFullYear()
        : parseInt(match[4], 10);
      if (!isNaN(startYear) && !isNaN(endYear) && endYear >= startYear) {
        totalMonths += Math.max(12, (endYear - startYear) * 12);
      }
    }
  }
  const years = Math.round(totalMonths / 12);
  return years > 0 ? years : 1;
}

function extractDocxText(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 30) return '';

  function xmlToText(xml) {
    if (!xml || typeof xml !== 'string') return '';
    return xml
      .replace(/<w:p[^>]*>/g, '\n')
      .replace(/<w:br[^>]*>/g, '\n')
      .replace(/<w:tab[^>]*>/g, '\t')
      .replace(/<w:tr[^>]*>/g, '\n')
      .replace(/<w:tc[^>]*>/g, '  ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  }

  try {
    // 1. Preferred & Standard: Central Directory (EOCD) Scan
    // Correctly extracts docx entries even when local file headers use streaming/data descriptors (compSize = 0)
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    const xmlParts = [];

    if (eocdOffset !== -1) {
      const cdOffset = buf.readUInt32LE(eocdOffset + 16);
      const totalEntries = buf.readUInt16LE(eocdOffset + 10);
      let offset = cdOffset;
      const targetXmls = {};

      for (let i = 0; i < totalEntries && offset < eocdOffset; i++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) break;
        const compMethod = buf.readUInt16LE(offset + 10);
        const compSize = buf.readUInt32LE(offset + 20);
        const fileNameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localHeaderOffset = buf.readUInt32LE(offset + 42);
        const fileName = buf.slice(offset + 46, offset + 46 + fileNameLen).toString('utf8');

        if (fileName === 'word/document.xml' || fileName.startsWith('word/header') || fileName.startsWith('word/footer')) {
          try {
            const localFileNameLen = buf.readUInt16LE(localHeaderOffset + 26);
            const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
            const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;
            const compData = buf.slice(dataStart, dataStart + compSize);
            const xml = compMethod === 8 ? zlib.inflateRawSync(compData).toString('utf8') : compData.toString('utf8');
            targetXmls[fileName] = xml;
          } catch (e) {
            console.warn(`[Docx Part Decompress Warning] ${fileName}: ${e.message}`);
          }
        }
        offset += 46 + fileNameLen + extraLen + commentLen;
      }

      // Concatenate header parts (often contains candidate name/contact), then main body, then footer
      const headerKeys = Object.keys(targetXmls).filter(k => k.startsWith('word/header')).sort();
      for (const hk of headerKeys) {
        const txt = xmlToText(targetXmls[hk]);
        if (txt) xmlParts.push(txt);
      }
      if (targetXmls['word/document.xml']) {
        const bodyTxt = xmlToText(targetXmls['word/document.xml']);
        if (bodyTxt) xmlParts.push(bodyTxt);
      }
      const footerKeys = Object.keys(targetXmls).filter(k => k.startsWith('word/footer')).sort();
      for (const fk of footerKeys) {
        const txt = xmlToText(targetXmls[fk]);
        if (txt) xmlParts.push(txt);
      }

      if (xmlParts.length > 0) {
        return cleanDocxAndMarkdownArtifacts(xmlParts.join('\n\n'));
      }
    }

    // 2. Fallback: Local File Header Scan
    let offset = 0;
    while (offset < buf.length - 30) {
      if (buf.readUInt32LE(offset) === 0x04034b50) {
        const compMethod = buf.readUInt16LE(offset + 8);
        const compSize = buf.readUInt32LE(offset + 18);
        const fileNameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const fileName = buf.slice(offset + 30, offset + 30 + fileNameLen).toString('utf8');
        const dataStart = offset + 30 + fileNameLen + extraLen;
        if (fileName === 'word/document.xml' && compSize > 0) {
          const compData = buf.slice(dataStart, dataStart + compSize);
          const xml = compMethod === 8 ? zlib.inflateRawSync(compData).toString('utf8') : compData.toString('utf8');
          const bodyTxt = xmlToText(xml);
          if (bodyTxt) return cleanDocxAndMarkdownArtifacts(bodyTxt);
        }
        offset = dataStart + Math.max(1, compSize);
      } else {
        offset++;
      }
    }
  } catch (e) {
    console.warn('[Docx Extraction Warning]', e.message);
  }

  return '';
}

// ── Step 2: Core Parsing Logic ──────────────────────────────────────────────
async function parseResume(inputFilePath, options = {}) {
  const isDryRun = options.dryRun || false;
  const isTest = options.isTest || false;
  const outPath = options.outPath || (isTest ? path.join(dataDir, 'test-profile.json') : profilePath);
  let targetPath = inputFilePath;

  // Auto-detect resume: check cache dir first, then try restoring from SQLite DB
  if (!targetPath) {
    const cacheDir = path.join(dataDir, 'cache');
    const candidates = ['uploaded_doc.docx', 'uploaded_doc.pdf', 'uploaded_resume.pdf', 'resume.pdf', 'resume.docx', 'resume.txt'];
    for (const f of candidates) {
      const cachePath = path.join(cacheDir, f);
      if (fs.existsSync(cachePath)) {
        targetPath = cachePath;
        break;
      }
      // Also check data root for backward compat
      if (fs.existsSync(path.join(dataDir, f))) {
        targetPath = path.join(dataDir, f);
        break;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error(`Resume file not found. Checked: ${targetPath}`);
  }

  console.log(`📄 Ingesting resume: ${targetPath}`);
  const ext = path.extname(targetPath).toLowerCase();
  const fileBuf = fs.readFileSync(targetPath);
  const maxUploadMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '5', 10);
  const maxUploadBytes = maxUploadMb * 1024 * 1024;
  if (fileBuf.length > maxUploadBytes) {
    const sizeMb = (fileBuf.length / (1024 * 1024)).toFixed(1);
    throw new Error(`File too large (${sizeMb} MB). Maximum allowed size is ${maxUploadMb} MB.`);
  }

  let apiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8'));
      apiKey = settings.llm_api_key;
    } catch (_) {}
  }

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or LLM_API_KEY is not configured in .env or settings.json');
  }

  // Prepare Payload
  let requestBody;
  if (ext === '.pdf') {
    requestBody = {
      contents: [{
        parts: [
          { text: SYSTEM_PROMPT },
          { text: "Extract profile verbatim from this PDF resume." },
          { inlineData: { mimeType: 'application/pdf', data: fileBuf.toString('base64') } }
        ]
      }],
      generationConfig: { response_mime_type: 'application/json' }
    };
  } else if (ext === '.docx') {
    const extractedText = extractDocxText(fileBuf);
    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('Unable to extract readable text from DOCX document. Please ensure the document contains text and is not password-protected, or convert to PDF.');
    }
    requestBody = {
      contents: [{
        parts: [
          { text: SYSTEM_PROMPT },
          { text: `Extract profile from this resume text:\n\n${extractedText}` }
        ]
      }],
      generationConfig: { response_mime_type: 'application/json' }
    };
  } else {
    requestBody = {
      contents: [{
        parts: [
          { text: SYSTEM_PROMPT },
          { text: `Extract profile from this text:\n\n${fileBuf.toString('utf8')}` }
        ]
      }],
      generationConfig: { response_mime_type: 'application/json' }
    };
  }

  // Multi-Model Fallback Hierarchy (Prioritize active high-quota models)
  const CANDIDATE_MODELS = [
    process.env.GEMINI_MODEL,
    process.env.LLM_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-flash-latest'
  ].filter(Boolean);

  const uniqueModels = [...new Set(CANDIDATE_MODELS)];
  let rawText = '';
  let lastError = null;

  for (const modelName of uniqueModels) {
    try {
      console.log(`🤖 Parsing resume via Gemini (${modelName})...`);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        const errTxt = await res.text();
        console.warn(`⚠️ Model ${modelName} returned HTTP ${res.status}, trying next model...`);
        lastError = new Error(`HTTP ${res.status}: ${errTxt}`);
        continue;
      }

      const json = await res.json();
      rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) break;
    } catch (e) {
      console.warn(`⚠️ Model ${modelName} request failed: ${e.message}`);
      lastError = e;
    }
  }

  if (!rawText) {
    console.error('❌ Failed to parse response from any Gemini model:', lastError?.message);
    throw lastError || new Error('No response from LLM');
  }

  const parsedProfile = JSON.parse(rawText.replace(/```json/gi, '').replace(/```/g, '').trim());

  if (!parsedProfile.name && !parsedProfile.skills) {
    console.error('❌ Profile missing key fields.');
    throw new Error('Parsed profile missing name and skills');
  }

  // Clean formatting artifacts from experience bullets, names, and summaries
  if (Array.isArray(parsedProfile.experience)) {
    for (const exp of parsedProfile.experience) {
      if (typeof exp.role === 'string') exp.role = cleanDocxAndMarkdownArtifacts(exp.role);
      if (typeof exp.project === 'string') exp.project = cleanDocxAndMarkdownArtifacts(exp.project);
      if (Array.isArray(exp.bullets)) {
        exp.bullets = exp.bullets.map(b => cleanDocxAndMarkdownArtifacts(b)).filter(Boolean);
      }
    }
  }
  if (Array.isArray(parsedProfile.skills)) {
    parsedProfile.skills = parsedProfile.skills.map(s => cleanDocxAndMarkdownArtifacts(s)).filter(Boolean);
  }
  if (Array.isArray(parsedProfile.skills_familiar)) {
    parsedProfile.skills_familiar = parsedProfile.skills_familiar.map(s => cleanDocxAndMarkdownArtifacts(s)).filter(Boolean);
  } else {
    parsedProfile.skills_familiar = [];
  }
  if (!Array.isArray(parsedProfile.projects)) {
    parsedProfile.projects = [];
  }
  if (typeof parsedProfile.summary === 'string') {
    parsedProfile.summary = cleanDocxAndMarkdownArtifacts(parsedProfile.summary);
  }
  parsedProfile.years_of_experience = calculateYearsOfExperience(parsedProfile.experience);

  // ── Step 3: Save Output ───────────────────────────────────────────────────
  if (isDryRun) {
    console.log(`ℹ️ [DRY RUN] Parsing successful. Skipping write.`);
  } else if (isTest) {
    fs.writeFileSync(outPath, JSON.stringify(parsedProfile, null, 2));
    console.log(`🧪 Test profile written to ${outPath}`);
  } else {
    if (fs.existsSync(outPath)) {
      fs.writeFileSync(backupPath, fs.readFileSync(outPath, 'utf8'));
      console.log(`💾 Backed up previous profile to ${backupPath}`);
    }
    fs.writeFileSync(outPath, JSON.stringify(parsedProfile, null, 2));
    console.log(`✅ Successfully updated ${outPath}`);
  }

  // Delete the source resume file after parsing into JSON if requested
  if (options.deleteAfterParsing && targetPath && fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(targetPath);
      console.log(`🗑️ Deleted source resume after parsing into JSON: ${targetPath}`);
    } catch (e) {
      console.warn(`⚠️ Could not delete resume after parsing: ${e.message}`);
    }
  }

  console.log('\n--- Extraction Summary ---');
  console.log(`👤 Name: ${parsedProfile.name || 'N/A'}`);
  console.log(`💼 Roles Extracted: ${(parsedProfile.experience || []).length}`);
  console.log(`🛠️  Skills Extracted: ${(parsedProfile.skills || []).length}`);

  return parsedProfile;
}

function promoteTestProfile() {
  const testPath = path.join(dataDir, 'test-profile.json');
  if (!fs.existsSync(testPath)) {
    console.error('❌ No test profile found. Run with --test first.');
    process.exit(1);
  }
  if (fs.existsSync(profilePath)) fs.writeFileSync(backupPath, fs.readFileSync(profilePath, 'utf8'));
  fs.writeFileSync(profilePath, fs.readFileSync(testPath, 'utf8'));
  console.log('🎉 test-profile.json promoted to master-profile.json!');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--promote')) return promoteTestProfile();

  parseResume(args.find(a => !a.startsWith('--')), {
    dryRun: args.includes('--dry-run'),
    isTest: args.includes('--test'),
    deleteAfterParsing: args.includes('--delete-after-parsing')
  }).catch(e => console.error('Fatal error:', e));
}

module.exports = {
  parseResume,
  SYSTEM_PROMPT,
  calculateYearsOfExperience,
  cleanDocxAndMarkdownArtifacts
};
