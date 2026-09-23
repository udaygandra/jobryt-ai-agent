const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dataDir = path.join(__dirname, '../data');
const templateFile = path.join(dataDir, 'resume-template.html');
const hydratedFile = path.join(dataDir, 'hydrated.html');
const finalPdfFile = path.join(dataDir, 'resume_final.pdf');
const masterProfileFile = path.join(dataDir, 'master-profile.json');

// --- WORKFLOW 2 MOCK RUNNER ---
function runWorkflow2Mock() {
  console.log("=== Starting Workflow 2 Integration Test ===");
  
  // 1. Mock Generate
  console.log("Mocking Gemini Generate...");
  const mockDraft = {
    resume_bullets: ["Developed robust data models.", "Delved into seamless analytics.", "Elevated the tapestry of BI tools."],
    cover_letter: "I am a robust analyst who leverages data."
  };

  // 2. Cliché Scanner
  console.log("Running Cliché Scanner...");
  const textToScan = mockDraft.resume_bullets.join(' ') + " " + mockDraft.cover_letter;
  const clicheRegex = /\b(delve|moreover|furthermore|leverage|seamless|testament to|unlock|robust|tapestry|elevate|boast)\b/gi;
  const hits = (textToScan.match(clicheRegex) || []).length;
  console.log(`Cliché Hits: ${hits}`);
  let needsRewrite = hits > 2;

  // 3. Cliché Gate
  if (needsRewrite) {
    console.log("Cliché Gate FAILED. Needs rewrite. Mocking rewrite...");
    // Mock humanize / clean up
    mockDraft.resume_bullets = ["Developed data models.", "Analyzed metrics.", "Built BI dashboards."];
    mockDraft.cover_letter = "I am an analyst who works with data.";
  }

  // 4. ATS Coverage
  console.log("Running ATS Coverage...");
  const jobDescription = "We need data models, metrics, and BI dashboards for an analyst.";
  const words = jobDescription.split(/\W+/).filter(w => w.length > 4);
  const uniqueKeywords = [...new Set(words.map(w => w.toLowerCase()))];
  const resumeText = mockDraft.resume_bullets.join(' ').toLowerCase();
  
  const covered = uniqueKeywords.filter(k => resumeText.includes(k));
  const coveragePct = uniqueKeywords.length ? Math.round((covered.length / uniqueKeywords.length) * 100) : 100;
  console.log(`ATS Coverage: ${coveragePct}%`);

  // 5. Hydrate HTML
  console.log("Hydrating HTML Template...");
  let htmlTemplate = fs.readFileSync(templateFile, 'utf8');
  let profile = { name: "Mock Candidate", target_titles: ["Data Analyst"], locations: ["Toronto"], skills: ["SQL"] };
  try {
      profile = JSON.parse(fs.readFileSync(masterProfileFile, 'utf8'));
  } catch(e) { }

  let hydrated = htmlTemplate
    .replace(/{{NAME}}/g, profile.name || "Test User")
    .replace(/{{LOCATION}}/g, (profile.locations || []).join(', '))
    .replace(/{{TARGET_TITLES}}/g, (profile.target_titles || []).join(', '))
    .replace(/{{COVER_LETTER}}/g, mockDraft.cover_letter)
    .replace(/{{RELEVANT_ROLE}}/g, "Data Analyst")
    .replace(/{{RELEVANT_COMPANY}}/g, "Mock Corp")
    .replace(/{{RELEVANT_DATES}}/g, "2023 - Present")
    .replace(/{{BULLETS_HTML}}/g, mockDraft.resume_bullets.map(b => `<li>${b}</li>`).join(''))
    .replace(/{{SKILLS}}/g, (profile.skills || []).join(', '));
  
  fs.writeFileSync(hydratedFile, hydrated);

  // 6. Generate PDF
  console.log("Generating PDF...");
  try {
      execSync(`node scripts/html-to-pdf.js "${hydratedFile}" "${finalPdfFile}"`, { stdio: 'inherit' });
      console.log(`✅ Workflow 2 Integration Test Passed! Created ${finalPdfFile}`);
  } catch(err) {
      console.error("PDF Generation Failed!");
      throw err;
  }
}

runWorkflow2Mock();
