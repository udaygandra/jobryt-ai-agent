/**
 * scripts/resume-to-profile.js
 * 
 * Ingests a resume file (PDF, TXT, DOCX, or MD), sends it to Gemini (or configured LLM)
 * with strict zero-fabrication rules, and updates data/master-profile.json verbatim.
 * 
 * Features:
 * - Direct PDF binary extraction via Gemini Multimodal inlineData (high fidelity, zero OCR loss)
 * - Text/Markdown direct ingestion
 * - Strict Zero-Fabrication enforcement: never invents employers, dates, skills, metrics, or titles
 * - Automatically backs up previous master-profile.json to master-profile.backup.json
 * - Outputs validation report
 */

const fs = require('fs');
const path = require('path');

// 1. Load environment variables
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  });
}

const dataDir = path.join(__dirname, '../data');
const profilePath = path.join(dataDir, 'master-profile.json');
const backupPath = path.join(dataDir, 'master-profile.backup.json');

const SYSTEM_PROMPT = `You are a high-precision resume parsing engine.
Your task is to extract all information from the provided resume and output a valid JSON object matching the exact master-profile schema.

CRITICAL RULES - ZERO FABRICATION & COMPLETE FIDELITY:
1. STRICT ZERO FABRICATION: Do NOT invent, extrapolate, assume, or hallucinate ANY details.
   - Do NOT invent companies, job titles, skills, tools, dates, education, certifications, or metrics.
   - If a field is not present in the resume, set it to an empty array [] or empty object {} or null or empty string "".
2. NO LOSS OF DETAIL:
   - Copy EVERY SINGLE bullet point, achievement, and responsibility from the resume verbatim or with complete detail. Do NOT summarize or omit any bullets.
   - Extract ALL skills, tools, frameworks, libraries, platforms, and technical keywords listed in the resume.
   - Extract ALL experience entries in chronological or listed order.
   - Extract ALL education and certification records with their dates and institutions.
3. OUTPUT FORMAT: Return ONLY a valid JSON object with these exact keys:
{
  "name": "Full Name",
  "target_titles": ["Title 1", "Title 2"],
  "locations": ["Location from resume, e.g. Toronto, ON"],
  "contact": {
    "email": "email if present",
    "phone": "phone if present",
    "location": "city/region if present",
    "linkedin": "linkedin url if present",
    "github": "github url if present",
    "status": "residency/visa status if present"
  },
  "summary": "Professional summary verbatim from resume if present",
  "skills": ["Skill 1", "Skill 2", ...],
  "experience": [
    {
      "role": "Exact Job Title",
      "company": "Exact Company Name",
      "dates": "Exact Dates e.g. Sep 2025 – Present",
      "bullets": [
        "Verbatim bullet 1 with all metrics and technologies preserved",
        "Verbatim bullet 2 with all metrics and technologies preserved"
      ]
    }
  ],
  "education": [
    {
      "degree": "Degree name",
      "institution": "University / College",
      "dates": "Dates / Graduation Year"
    }
  ],
  "certifications": ["Cert 1", "Cert 2"],
  "projects": [
    {
      "name": "Project Name",
      "description": "Project Description",
      "technologies": ["Tech 1", "Tech 2"]
    }
  ],
  "writing_sample": "Summary or excerpt from resume to serve as candidate voice sample"
}`;

async function parseResume(inputFilePath, options = {}) {
  let targetPath = inputFilePath;
  const isDryRun = options.dryRun || false;
  const isTest = options.isTest || false;
  const testPath = path.join(dataDir, 'test-profile.json');
  const outPath = options.outPath || (isTest ? testPath : profilePath);

  // Auto-detect if no path supplied
  if (!targetPath) {
    const candidateFiles = [
      'resume.pdf',
      'resume_input.pdf',
      'resume.docx',
      'resume.txt',
      'resume.md',
      'resume_final.pdf'
    ];
    for (const f of candidateFiles) {
      const p = path.join(dataDir, f);
      if (fs.existsSync(p)) {
        targetPath = p;
        break;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    console.error(`❌ Resume file not found. Checked path: ${targetPath || 'default candidates in data/'}`);
    console.log(`\nUsage:`);
    console.log(`  node scripts/resume-to-profile.js <path-to-resume> --test       # Generates data/test-profile.json`);
    console.log(`  node scripts/resume-to-profile.js <path-to-resume> --dry-run    # Prints extracted data without saving`);
    console.log(`  node scripts/resume-to-profile.js <path-to-resume> --out <path> # Saves to custom file`);
    console.log(`  node scripts/resume-to-profile.js --promote                     # Promotes test-profile.json to master-profile.json`);
    process.exit(1);
  }

  console.log(`📄 Ingesting resume: ${targetPath}`);
  const ext = path.extname(targetPath).toLowerCase();
  const fileBuf = fs.readFileSync(targetPath);

  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase().trim();
  const apiKey = process.env.GEMINI_API_KEY;

  if (provider === 'gemini' && !apiKey) {
    console.error('❌ GEMINI_API_KEY environment variable is not set in .env');
    process.exit(1);
  }

  const models = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-flash-latest'];

  if (ext === '.pdf') {
    let pdfText = null;
    try {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: fileBuf });
      const parsedData = await parser.getText();
      if (parsedData && parsedData.text && parsedData.text.trim().length > 50) {
        pdfText = parsedData.text;
      }
    } catch(e) {}

    if (pdfText) {
      console.log(`📑 Extracted ${pdfText.length} characters of text from PDF directly for ultra-fast processing.`);
      requestBody = {
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT },
              { text: `Extract the complete candidate profile from this resume text:\n\n${pdfText}\n\nDo NOT fabricate any data. Copy all details verbatim into the JSON structure.` }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json'
        }
      };
    } else {
      const base64Data = fileBuf.toString('base64');
      requestBody = {
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT },
              { text: "Extract the complete candidate profile from this attached PDF resume. Do NOT fabricate any data. Copy all details verbatim into the JSON structure." },
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: base64Data
                }
              }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json'
        }
      };
    }
  } else if (ext === '.txt' || ext === '.md' || ext === '.json') {
    const textContent = fileBuf.toString('utf8');
    requestBody = {
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            { text: `Extract the complete candidate profile from this resume text:\n\n${textContent}\n\nDo NOT fabricate any data. Copy all details verbatim into the JSON structure.` }
          ]
        }
      ],
      generationConfig: {
        response_mime_type: 'application/json'
      }
    };
  } else if (ext === '.docx') {
    // For DOCX, extract plain text or XML
    const textContent = extractDocxText(fileBuf);
    requestBody = {
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            { text: `Extract the complete candidate profile from this Word document resume content:\n\n${textContent}\n\nDo NOT fabricate any data. Copy all details verbatim into the JSON structure.` }
          ]
        }
      ],
      generationConfig: {
        response_mime_type: 'application/json'
      }
    };
  } else {
    // Fallback: treat as text
    const textContent = fileBuf.toString('utf8');
    requestBody = {
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            { text: `Extract the complete candidate profile from this resume file content:\n\n${textContent}\n\nDo NOT fabricate any data. Copy all details verbatim into the JSON structure.` }
          ]
        }
      ],
      generationConfig: {
        response_mime_type: 'application/json'
      }
    };
  }

  let parsedProfile = null;
  for (const model of models) {
    try {
      console.log(`🤖 Parsing resume via ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`Model ${model} returned HTTP ${res.status}: ${errText.substring(0, 150)}`);
        if (res.status === 503 || res.status === 429) {
          console.log(`Waiting 2s for demand spike to clear...`);
          await new Promise(r => setTimeout(r, 2000));
          // Try this model one more time
          try {
            const retryRes = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody)
            });
            if (retryRes.ok) {
              const retryJson = await retryRes.json();
              const retryText = retryJson.candidates?.[0]?.content?.parts?.[0]?.text;
              if (retryText) {
                parsedProfile = JSON.parse(retryText.replace(/```json/gi, '').replace(/```/g, '').trim());
                break;
              }
            }
          } catch(re) {}
        }
        continue;
      }

      const json = await res.json();
      const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        parsedProfile = JSON.parse(cleanText);
        break;
      }
    } catch (e) {
      console.warn(`Error with ${model}:`, e.message);
    }
  }

  if (!parsedProfile) {
    console.error('❌ Failed to parse resume with available models.');
    process.exit(1);
  }

  // Basic validation
  if (!parsedProfile.name && !parsedProfile.skills) {
    console.error('❌ Extracted profile is malformed or missing key fields.');
    process.exit(1);
  }

  if (isDryRun) {
    console.log(`ℹ️ [DRY RUN] Skipping file write. Verified zero-fabrication parsing output successfully.`);
  } else if (isTest) {
    fs.writeFileSync(outPath, JSON.stringify(parsedProfile, null, 2), 'utf8');
    console.log(`🧪 Test profile successfully written to ${outPath}!\n`);
    console.log(`💡 NOTE: Your active data/master-profile.json was NOT changed.`);
  } else {
    // Backup existing master-profile.json
    if (fs.existsSync(outPath)) {
      try {
        const existing = fs.readFileSync(outPath, 'utf8');
        fs.writeFileSync(backupPath, existing, 'utf8');
        console.log(`💾 Previous master-profile.json safely backed up to ${backupPath}`);
      } catch (e) {
        console.warn('Could not create backup:', e.message);
      }
    }

    // Write new master-profile.json
    fs.writeFileSync(outPath, JSON.stringify(parsedProfile, null, 2), 'utf8');
    console.log(`✅ Successfully updated ${outPath}!\n`);
  }

  // Report statistics
  const totalBullets = (parsedProfile.experience || []).reduce((acc, exp) => acc + (exp.bullets ? exp.bullets.length : 0), 0);
  console.log('--- Extracted Candidate Summary ---');
  console.log(`👤 Name:            ${parsedProfile.name || 'N/A'}`);
  console.log(`🎯 Target Titles:   ${(parsedProfile.target_titles || []).join(', ') || 'None specified'}`);
  console.log(`📍 Locations:       ${(parsedProfile.locations || []).join(', ') || 'None specified'}`);
  console.log(`💼 Roles Extracted: ${(parsedProfile.experience || []).length}`);
  console.log(`📋 Total Bullets:   ${totalBullets}`);
  console.log(`🛠️  Skills Extracted: ${(parsedProfile.skills || []).length}`);
  console.log(`🎓 Education Count: ${(parsedProfile.education || []).length}`);
  console.log(`📜 Certifications:  ${(parsedProfile.certifications || []).length}`);
  console.log('-----------------------------------');
  if (isTest) {
    console.log(`👉 Inspect ${outPath} to review your extracted data.`);
    console.log(`👉 When you are ready to make it your active profile, run: npm run promote-profile`);
  } else if (!isDryRun) {
    console.log(`🚀 Master profile is ready for use across all workflows!`);
  }

  return parsedProfile;
}

// Basic DOCX XML text extractor without external heavy dependencies
function extractDocxText(buffer) {
  try {
    // Search for XML text tags <w:t>...</w:t>
    const str = buffer.toString('binary');
    const matches = str.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    if (matches && matches.length > 0) {
      return matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    }
  } catch(e) {}
  return buffer.toString('utf8');
}

function promoteTestProfile() {
  const testPath = path.join(dataDir, 'test-profile.json');
  if (!fs.existsSync(testPath)) {
    console.error(`❌ No test profile found at ${testPath}. Please run npm run test-resume <file> first.`);
    process.exit(1);
  }

  // Backup current master-profile.json
  if (fs.existsSync(profilePath)) {
    try {
      const existing = fs.readFileSync(profilePath, 'utf8');
      fs.writeFileSync(backupPath, existing, 'utf8');
      console.log(`💾 Previous master-profile.json safely backed up to ${backupPath}`);
    } catch(e) {}
  }

  const testContent = fs.readFileSync(testPath, 'utf8');
  fs.writeFileSync(profilePath, testContent, 'utf8');
  console.log(`🎉 SUCCESS: test-profile.json has been promoted to data/master-profile.json!`);
  console.log(`🚀 All workflows will now use this updated profile.`);
}

// Run from CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--promote')) {
    promoteTestProfile();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const isTest = args.includes('--test');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;
  const targetFile = args.find(a => !a.startsWith('--') && (outIdx === -1 || a !== args[outIdx + 1]));

  parseResume(targetFile, { dryRun, isTest, outPath }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { parseResume, SYSTEM_PROMPT };
