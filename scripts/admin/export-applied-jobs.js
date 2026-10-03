/**
 * export-applied-jobs.js — All-in-One Comprehensive Excel Generator for Applied Jobs
 *
 * PURPOSE:
 *   Reads application records, tailored resumes, cover letters, and recruiter
 *   outreach data directly from the SQLite database (data/tracking/jobs.db) and
 *   compiles a complete multi-tab workbook (.xlsx) containing all information in one Excel file:
 *     - Tab 1: "Applications Master" — Complete overview with scores, links, summary, skills, cover letter, recruiter contacts, and full resume JSON
 *     - Tab 2: "Resumes & Cover Letters" — Clean reading view for easy review and copy/pasting
 *     - Tab 3: "Resume JSON Archive" — Structured JSON payloads for all tailored resumes
 *     - Tab 4: "Recruiter Outreach" — Consolidated hiring team contacts, emails, and LinkedIn profiles
 *
 * USAGE:
 *   node scripts/admin/export-applied-jobs.js              # Generate spreadsheet only
 *   node scripts/admin/export-applied-jobs.js <chatId>     # Generate + send to Telegram
 *
 * OUTPUT:
 *   data/Applied_Jobs_YYYY-MM-DD.xlsx
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// Try to load the xlsx library
let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {
  try { XLSX = require('/home/node/.n8n/node_modules/xlsx'); } catch (_) {}
}

const { getDataDir, readJsonFile } = require('../core/common-utils');
const {
  getAppliedJobs,
  getTailoredResume,
  getRecruiterLogs
} = require('../core/jobs-db');

// ── Configuration ───────────────────────────────────────────────────────────
const dataDir = getDataDir();
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const defaultChatId = process.env.TELEGRAM_CHAT_ID;
const targetChatId = process.argv[2] || defaultChatId;

function runExport() {
  if (!XLSX) {
    console.error('❌ XLSX library is not available. Install with: npm install xlsx');
    process.exit(1);
  }

  // 1. Fetch applied jobs from SQLite
  let appliedJobs = [];
  try {
    appliedJobs = getAppliedJobs(500);
  } catch (err) {
    console.warn('Warning: Could not fetch from jobsDb.getAppliedJobs:', err.message);
  }

  // Fallback to legacy json if database returned empty
  if (!appliedJobs || appliedJobs.length === 0) {
    const legacyPath = path.join(dataDir, 'tracking', 'logged_jobs.json');
    appliedJobs = readJsonFile(legacyPath, []);
  }

  // Load candidate master profile for fallback values
  const profileObj = readJsonFile(path.join(dataDir, 'profiles', 'master-profile.json'), {});

  // Fetch recruiter logs for outreach tab
  let recruiterLogs = [];
  try {
    recruiterLogs = getRecruiterLogs(200);
  } catch (_) {}

  // ── Sheet 1: Applications Master ───────────────────────────────────────────
  const masterRows = appliedJobs.map((job, idx) => {
    // Resolve absolute local PDF path for Excel hyperlink
    let localPdfPath = job.pdf_path || '';
    if (localPdfPath && !path.isAbsolute(localPdfPath)) {
      localPdfPath = path.resolve(dataDir, path.basename(localPdfPath));
    } else if (localPdfPath.startsWith('/data/')) {
      localPdfPath = path.join(dataDir, path.basename(localPdfPath));
    }

    const pdfFileName = job.pdf_filename || (localPdfPath ? path.basename(localPdfPath) : 'Resume.pdf');
    const pdfFormula = (localPdfPath && fs.existsSync(localPdfPath))
      ? `=HYPERLINK("${localPdfPath.replace(/\\/g, '/')}", "📄 Open ${pdfFileName}")`
      : pdfFileName;

    let jobUrl = job.job_url || job.redirect_url || job.apply_url || job.url || '';
    if (!jobUrl && job.payload_json) {
      try {
        const p = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json;
        jobUrl = p.job_url || p.redirect_url || p.apply_url || p.url || p.link || '';
      } catch (_) {}
    }
    const jobLinkFormula = jobUrl ? `=HYPERLINK("${jobUrl}", "🔗 View Job Posting")` : 'N/A';

    // Format categorized skills as readable text
    let formattedSkills = '';
    if (job.categorized_skills) {
      try {
        const cat = typeof job.categorized_skills === 'string'
          ? JSON.parse(job.categorized_skills)
          : job.categorized_skills;
        formattedSkills = Object.entries(cat)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n');
      } catch (_) {
        formattedSkills = String(job.categorized_skills);
      }
    }

    // Format resume JSON
    let resumeJsonStr = '';
    if (job.tailored_resume_json) {
      try {
        const rObj = typeof job.tailored_resume_json === 'string'
          ? JSON.parse(job.tailored_resume_json)
          : job.tailored_resume_json;
        resumeJsonStr = JSON.stringify(rObj, null, 2);
      } catch (_) {
        resumeJsonStr = String(job.tailored_resume_json);
      }
    } else {
      // Check tailored_resumes table
      const tResume = getTailoredResume(job.job_id || job.id);
      if (tResume && tResume.resume_data) {
        resumeJsonStr = JSON.stringify(tResume.resume_data, null, 2);
      }
    }

    return {
      '#': idx + 1,
      'Applied Date': (job.applied_at || job.appliedAt)
        ? new Date(job.applied_at || job.appliedAt).toISOString().replace('T', ' ').slice(0, 16)
        : 'N/A',
      'Job Title': job.title || job.tailored_title || (profileObj.target_titles?.[0]) || 'Role',
      'Company': job.company || job.company_name || 'Company',
      'Location': job.location || profileObj.locations?.[0] || 'Remote / Unspecified',
      'Source': job.source || 'Direct',
      'Match Score': parseInt(job.match_score || job.score || job.overall_score || 85, 10),
      'ATS Fit %': job.ats_keyword_fit ? `${job.ats_keyword_fit}%` : '95%',
      'Status': job.status || 'Applied',
      'Job Posting URL': jobUrl || 'N/A',
      'Job Link': jobLinkFormula,
      'Resume PDF': pdfFormula,
      'Tailored Resume (JSON)': resumeJsonStr || 'N/A',
      'Tailored Professional Summary': job.tailored_summary || '',
      'Categorized Core Skills': formattedSkills || 'N/A',
      'Tailored Cover Letter': job.cover_letter || '',
      'Recruiter Name': job.recruiter_name || 'Hiring Team',
      'Recruiter Email': job.recruiter_email || '',
      'Recruiter LinkedIn': job.recruiter_linkedin || ''
    };
  });

  if (masterRows.length === 0) {
    masterRows.push({
      '#': 1,
      'Applied Date': new Date().toISOString().replace('T', ' ').slice(0, 16),
      'Job Title': 'No applied jobs recorded yet',
      'Company': 'Run /scan or approve jobs in Telegram',
      'Location': 'N/A',
      'Source': 'System',
      'Match Score': 0,
      'ATS Fit %': '0%',
      'Status': 'Pending First Application',
      'Job Posting URL': 'N/A',
      'Job Link': '',
      'Resume PDF': '',
      'Tailored Resume (JSON)': '{}',
      'Tailored Professional Summary': 'Applications you generate with /apply or the bot will appear here.',
      'Categorized Core Skills': '',
      'Tailored Cover Letter': '',
      'Recruiter Name': '',
      'Recruiter Email': '',
      'Recruiter LinkedIn': ''
    });
  }

  // ── Sheet 2: Resumes & Cover Letters (Reading View) ─────────────────────────
  const readingRows = appliedJobs.map((job, idx) => {
    let jobUrl = job.job_url || job.redirect_url || job.apply_url || job.url || '';
    if (!jobUrl && job.payload_json) {
      try {
        const p = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json;
        jobUrl = p.job_url || p.redirect_url || p.apply_url || p.url || p.link || '';
      } catch (_) {}
    }

    let formattedSkills = '';
    if (job.categorized_skills) {
      try {
        const cat = typeof job.categorized_skills === 'string'
          ? JSON.parse(job.categorized_skills)
          : job.categorized_skills;
        formattedSkills = Object.entries(cat)
          .map(([k, v]) => `• ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n');
      } catch (_) {
        formattedSkills = String(job.categorized_skills);
      }
    }

    let expText = '';
    if (job.tailored_experience) {
      try {
        const expArr = typeof job.tailored_experience === 'string'
          ? JSON.parse(job.tailored_experience)
          : job.tailored_experience;
        if (Array.isArray(expArr)) {
          expText = expArr.map(e => {
            const role = `${e.title || 'Role'} @ ${e.company || 'Company'} (${e.dates || e.date || ''})`;
            const bullets = (e.bullets || []).map(b => `  - ${b}`).join('\n');
            return `${role}\n${bullets}`;
          }).join('\n\n');
        } else {
          expText = String(job.tailored_experience);
        }
      } catch (_) {
        expText = String(job.tailored_experience);
      }
    }

    let localPdfPath = job.pdf_path || '';
    if (localPdfPath && !path.isAbsolute(localPdfPath)) {
      localPdfPath = path.resolve(dataDir, path.basename(localPdfPath));
    } else if (localPdfPath.startsWith('/data/')) {
      localPdfPath = path.join(dataDir, path.basename(localPdfPath));
    }

    return {
      '#': idx + 1,
      'Job Title': job.title || 'Role',
      'Company': job.company || 'Company',
      'Location': job.location || '',
      'Job Posting URL': jobUrl || 'N/A',
      'Tailored Professional Summary': job.tailored_summary || '',
      'Categorized Core Skills': formattedSkills || 'N/A',
      'Tailored Work Experience': expText || 'N/A',
      'Tailored Cover Letter': job.cover_letter || '',
      'PDF Filename': job.pdf_filename || (localPdfPath ? path.basename(localPdfPath) : ''),
      'Local PDF Path': localPdfPath || ''
    };
  });

  // ── Sheet 3: Resume JSON Archive ───────────────────────────────────────────
  const jsonRows = appliedJobs.map((job, idx) => {
    let jobUrl = job.job_url || job.redirect_url || job.apply_url || job.url || '';
    if (!jobUrl && job.payload_json) {
      try {
        const p = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json;
        jobUrl = p.job_url || p.redirect_url || p.apply_url || p.url || p.link || '';
      } catch (_) {}
    }

    let rawJson = '';
    if (job.tailored_resume_json) {
      try {
        const rObj = typeof job.tailored_resume_json === 'string'
          ? JSON.parse(job.tailored_resume_json)
          : job.tailored_resume_json;
        rawJson = JSON.stringify(rObj, null, 2);
      } catch (_) {
        rawJson = String(job.tailored_resume_json);
      }
    } else {
      const tResume = getTailoredResume(job.job_id || job.id);
      if (tResume && tResume.resume_data) {
        rawJson = JSON.stringify(tResume.resume_data, null, 2);
      }
    }

    return {
      '#': idx + 1,
      'Job ID': job.job_id || job.id,
      'Job Title': job.title || 'Role',
      'Company': job.company || 'Company',
      'Applied Date': (job.applied_at || job.appliedAt) || 'N/A',
      'Job Posting URL': jobUrl || 'N/A',
      'Resume JSON': rawJson || '{}'
    };
  });

  // ── Sheet 4: Recruiter Outreach ───────────────────────────────────────────
  const recruiterRows = [];
  let recIdx = 1;

  // Direct contacts from applied jobs
  for (const job of appliedJobs) {
    let jobUrl = job.job_url || job.redirect_url || job.apply_url || job.url || '';
    if (!jobUrl && job.payload_json) {
      try {
        const p = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json;
        jobUrl = p.job_url || p.redirect_url || p.apply_url || p.url || p.link || '';
      } catch (_) {}
    }

    if (job.recruiter_name || job.recruiter_email || job.recruiter_linkedin) {
      recruiterRows.push({
        '#': recIdx++,
        'Company': job.company || 'Company',
        'Target Role': job.title || 'Role',
        'Contact Name': job.recruiter_name || 'Hiring Team',
        'Email Address': job.recruiter_email || '',
        'LinkedIn Profile': job.recruiter_linkedin ? `=HYPERLINK("${job.recruiter_linkedin}", "${job.recruiter_linkedin}")` : '',
        'Discovery Source': 'Application Flow',
        'Job Posting URL': jobUrl || ''
      });
    }
  }

  // Additional recruiter logs from search/outreach history
  for (const log of recruiterLogs) {
    const contacts = Array.isArray(log.contacts) ? log.contacts : [];
    for (const c of contacts) {
      // Avoid exact duplicates
      const exists = recruiterRows.some(r =>
        r['Company']?.toLowerCase() === log.company?.toLowerCase() &&
        r['Contact Name']?.toLowerCase() === (c.name || '').toLowerCase()
      );
      if (!exists && (c.name || c.email || c.linkedin)) {
        recruiterRows.push({
          '#': recIdx++,
          'Company': log.company || 'Company',
          'Target Role': log.city ? `Team @ ${log.city}` : 'Recruiting Team',
          'Contact Name': c.name || 'Recruiter',
          'Email Address': c.email || '',
          'LinkedIn Profile': c.linkedin ? `=HYPERLINK("${c.linkedin}", "${c.linkedin}")` : '',
          'Discovery Source': c.source ? `Discovery (${c.source})` : 'Talent Sourcing',
          'Job Posting URL': ''
        });
      }
    }
  }

  if (recruiterRows.length === 0) {
    recruiterRows.push({
      '#': 1,
      'Company': 'Use /recruiters <company> to discover hiring team contacts',
      'Target Role': 'HR / Talent Acquisition',
      'Contact Name': 'Example Recruiter',
      'Email Address': 'recruiter@company.com',
      'LinkedIn Profile': '',
      'Discovery Source': 'System',
      'Job Posting URL': ''
    });
  }

  // ── Build Workbook and Format Columns ──────────────────────────────────────
  const workbook = XLSX.utils.book_new();

  // Helper to attach native cell hyperlinks
  const attachNativeLinks = (ws) => {
    if (!ws || !ws['!ref']) return;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r + 1; R <= range.e.r; ++R) {
      for (let C = range.s.c; C <= range.e.c; ++C) {
        const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[cellRef];
        if (cell && cell.v) {
          const val = String(cell.v);
          if (val.startsWith('http://') || val.startsWith('https://')) {
            cell.l = { Target: val };
          }
        }
      }
    }
  };

  // Tab 1
  const wsMaster = XLSX.utils.json_to_sheet(masterRows);
  attachNativeLinks(wsMaster);
  wsMaster['!cols'] = [
    { wch: 4 },   // #
    { wch: 18 },  // Applied Date
    { wch: 34 },  // Job Title
    { wch: 26 },  // Company
    { wch: 22 },  // Location
    { wch: 14 },  // Source
    { wch: 12 },  // Match Score
    { wch: 11 },  // ATS Fit %
    { wch: 12 },  // Status
    { wch: 55 },  // Job Posting URL
    { wch: 22 },  // Job Link
    { wch: 36 },  // Resume PDF
    { wch: 45 },  // Tailored Resume (JSON)
    { wch: 45 },  // Tailored Summary
    { wch: 40 },  // Categorized Skills
    { wch: 50 },  // Cover Letter
    { wch: 24 },  // Recruiter Name
    { wch: 28 },  // Recruiter Email
    { wch: 35 },  // Recruiter LinkedIn
  ];
  XLSX.utils.book_append_sheet(workbook, wsMaster, 'Applications Master');

  // Tab 2
  const wsReading = XLSX.utils.json_to_sheet(readingRows);
  attachNativeLinks(wsReading);
  wsReading['!cols'] = [
    { wch: 4 },   // #
    { wch: 32 },  // Job Title
    { wch: 26 },  // Company
    { wch: 20 },  // Location
    { wch: 55 },  // Job Posting URL
    { wch: 45 },  // Summary
    { wch: 40 },  // Core Skills
    { wch: 55 },  // Experience
    { wch: 55 },  // Cover Letter
    { wch: 35 },  // PDF Filename
    { wch: 45 },  // Local PDF Path
  ];
  XLSX.utils.book_append_sheet(workbook, wsReading, 'Resumes & Cover Letters');

  // Tab 3
  const wsJson = XLSX.utils.json_to_sheet(jsonRows);
  attachNativeLinks(wsJson);
  wsJson['!cols'] = [
    { wch: 4 },   // #
    { wch: 32 },  // Job ID
    { wch: 32 },  // Job Title
    { wch: 26 },  // Company
    { wch: 20 },  // Applied Date
    { wch: 55 },  // Job Posting URL
    { wch: 65 },  // Resume JSON
  ];
  XLSX.utils.book_append_sheet(workbook, wsJson, 'Resume JSON Archive');

  // Tab 4
  const wsRecruiters = XLSX.utils.json_to_sheet(recruiterRows);
  attachNativeLinks(wsRecruiters);
  wsRecruiters['!cols'] = [
    { wch: 4 },   // #
    { wch: 26 },  // Company
    { wch: 26 },  // Target Role
    { wch: 24 },  // Contact Name
    { wch: 28 },  // Email Address
    { wch: 38 },  // LinkedIn Profile
    { wch: 22 },  // Discovery Source
    { wch: 55 },  // Job Posting URL
  ];
  XLSX.utils.book_append_sheet(workbook, wsRecruiters, 'Recruiter Outreach');

  // Save to disk in dedicated exports directory
  const todayStr = new Date().toISOString().slice(0, 10);
  const outFileName = `Applied_Jobs_${todayStr}.xlsx`;
  const exportDir = path.join(dataDir, 'exports');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }
  const outFilePath = path.join(exportDir, outFileName);

  let finalOutPath = outFilePath;
  let finalFileName = outFileName;
  try {
    XLSX.writeFile(workbook, outFilePath);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EACCES') {
      const altFileName = `Applied_Jobs_${todayStr}_${Date.now()}.xlsx`;
      finalOutPath = path.join(exportDir, altFileName);
      finalFileName = altFileName;
      console.warn(`⚠️ ${outFileName} is currently locked or open in Excel. Saved updated copy to: ${altFileName}`);
      XLSX.writeFile(workbook, finalOutPath);
    } else {
      throw err;
    }
  }
  console.log(`✅ Multi-tab Excel generated: ${finalOutPath}`);
  console.log(`   - Applications Master: ${masterRows.length} rows`);
  console.log(`   - Resumes & Cover Letters: ${readingRows.length} rows`);
  console.log(`   - Resume JSON Archive: ${jsonRows.length} rows`);
  console.log(`   - Recruiter Outreach: ${recruiterRows.length} rows`);

  // Send to Telegram if requested
  if (targetChatId && botToken) {
    sendToTelegram(finalOutPath, finalFileName, appliedJobs.length);
  }

  return {
    success: true,
    count: appliedJobs.length,
    filePath: finalOutPath,
    fileName: finalFileName
  };
}

// ── Telegram Delivery Helper ────────────────────────────────────────────────
function sendToTelegram(filePath, fileName, jobCount) {
  try {
    const helperPath = fs.existsSync('/scripts/bot/send-telegram-doc.js')
      ? '/scripts/bot/send-telegram-doc.js'
      : (fs.existsSync('/scripts/send-telegram-doc.js')
          ? '/scripts/send-telegram-doc.js'
          : path.join(__dirname, '..', 'bot', 'send-telegram-doc.js'));

    const caption =
      `📊 <b>Applied Jobs Master Workbook</b>\n\n` +
      `📁 <b>File:</b> <code>${fileName}</code>\n` +
      `📈 <b>Applications:</b> ${jobCount}\n` +
      `📅 <b>Exported:</b> ${new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' })}\n\n` +
      `📑 <b>Workbook Tabs:</b>\n` +
      `1️⃣ <b>Applications Master</b> (All metrics, links, skills, cover letters, recruiter contacts & full resume JSON)\n` +
      `2️⃣ <b>Resumes & Cover Letters</b> (Clean formatted text reading view)\n` +
      `3️⃣ <b>Resume JSON Archive</b> (Structured JSON payloads for each role)\n` +
      `4️⃣ <b>Recruiter Outreach</b> (Hiring manager contacts, emails & LinkedIn profiles)`;

    const output = cp.execFileSync('node', [
      helperPath, botToken, String(targetChatId), filePath, fileName, caption,
    ], { timeout: 25000, encoding: 'utf8' });

    console.log('✅ Delivered Excel sheet to Telegram:', output.trim());
  } catch (err) {
    console.error('Error sending Excel to Telegram:', err.message);
  }
}

runExport();
