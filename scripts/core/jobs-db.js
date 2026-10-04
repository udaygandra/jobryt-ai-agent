/**
 * jobs-db.js — Universal SQLite Database Manager for Jobryt AI Agent
 *
 * PURPOSE:
 *   Persists applied jobs, tailored summaries, cover letters, generated PDFs,
 *   seen jobs (deduplication), pending approval jobs, rejected jobs, and recruiter cache
 *   in a local SQLite database (data/tracking/jobs.db) with WAL mode.
 *
 * BENEFITS:
 *   - Minimal RAM footprint: queries rows on demand instead of loading giant JSON arrays
 *   - ACID compliant: zero risk of file corruption during concurrent workflow writes
 *   - Fast exports: instant SQL queries for /export and /applied commands
 *   - Fast deduplication: O(1) indexed lookups for seen jobs
 *   - Full compatibility: syncs lightweight indexes to JSON files for backward compatibility
 */

const fs = require('fs');
const path = require('path');
let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (err) {
  throw new Error(
    `node:sqlite is unavailable in Node ${process.version}. ` +
    'Jobryt requires Node.js >= 22.13 (use the pinned n8nio/n8n image in docker-compose.yml).'
  );
}
const { getDataDir, readJsonFile, writeJsonFile } = require('./common-utils');

let dbInstance = null;

/**
 * Resolves the path to the jobs.db SQLite file.
 */
function getDbPath() {
  const dataDir = getDataDir();
  const trackingDir = path.join(dataDir, 'tracking');
  if (!fs.existsSync(trackingDir)) {
    fs.mkdirSync(trackingDir, { recursive: true });
  }
  return path.join(trackingDir, 'jobs.db');
}

/**
 * Opens or initializes the SQLite database and creates the required schema.
 */
function getDb() {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  dbInstance = new DatabaseSync(dbPath);

  // Use DELETE mode for universal compatibility across host and Docker container bind mounts
  try {
    // Wait up to 10s for locks held by other processes (n8n, bridge, pipeline share this file).
    // Without this, concurrent writes fail instantly with "database is locked".
    dbInstance.exec('PRAGMA busy_timeout = 10000;');
    dbInstance.exec('PRAGMA journal_mode = DELETE;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
  } catch (_) { }

  // Create tables if they do not exist
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS applied_jobs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      job_url TEXT,
      source TEXT,
      match_score INTEGER DEFAULT 80,
      ats_keyword_fit INTEGER DEFAULT 90,
      tailored_summary TEXT,
      tailored_experience TEXT,
      cover_letter TEXT,
      pdf_path TEXT,
      pdf_filename TEXT,
      recruiter_name TEXT,
      recruiter_email TEXT,
      recruiter_linkedin TEXT,
      applied_at TEXT NOT NULL,
      status TEXT DEFAULT 'Applied'
    );

    CREATE INDEX IF NOT EXISTS idx_applied_jobs_applied_at ON applied_jobs(applied_at DESC);
    CREATE INDEX IF NOT EXISTS idx_applied_jobs_job_id ON applied_jobs(job_id);

    CREATE TABLE IF NOT EXISTS pending_jobs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      job_url TEXT,
      match_score INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejected_jobs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      match_score INTEGER,
      payload_json TEXT,
      rejected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seen_jobs (
      id TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recruiter_cache (
      cache_key TEXT PRIMARY KEY,
      domain TEXT,
      contacts_json TEXT,
      cached_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recruiter_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      company TEXT NOT NULL,
      city TEXT,
      contacts_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tailored_resumes (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      tailored_summary TEXT,
      categorized_skills_json TEXT,
      tailored_experience_json TEXT,
      cover_letter TEXT,
      resume_json TEXT,
      pdf_path TEXT,
      pdf_filename TEXT,
      pdf_base64 TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tailored_resumes_job_id ON tailored_resumes(job_id);
    CREATE INDEX IF NOT EXISTS idx_tailored_resumes_created_at ON tailored_resumes(created_at DESC);
  `);

  try { dbInstance.exec('ALTER TABLE pending_jobs ADD COLUMN job_id TEXT;'); } catch (_) { }
  try { dbInstance.exec('ALTER TABLE rejected_jobs ADD COLUMN job_id TEXT;'); } catch (_) { }
  try { dbInstance.exec('ALTER TABLE applied_jobs ADD COLUMN categorized_skills TEXT;'); } catch (_) { }
  try { dbInstance.exec('ALTER TABLE applied_jobs ADD COLUMN tailored_resume_json TEXT;'); } catch (_) { }
  try { dbInstance.exec('ALTER TABLE applied_jobs ADD COLUMN pdf_base64 TEXT;'); } catch (_) { }

  // Migrate existing seen_jobs.json if seen_jobs table is empty
  try {
    const rowCount = dbInstance.prepare('SELECT count(*) as count FROM seen_jobs').get();
    if (rowCount && rowCount.count === 0) {
      const dataDir = getDataDir();
      const seenJsonPath = path.join(dataDir, 'tracking', 'seen_jobs.json');
      if (fs.existsSync(seenJsonPath)) {
        const seenList = readJsonFile(seenJsonPath, []);
        if (Array.isArray(seenList) && seenList.length > 0) {
          const insertStmt = dbInstance.prepare('INSERT OR IGNORE INTO seen_jobs (id, seen_at) VALUES (?, ?)');
          const now = new Date().toISOString();
          for (const item of seenList) {
            if (item) insertStmt.run(String(item).toLowerCase(), now);
          }
        }
      }
    }
  } catch (_) { }

  return dbInstance;
}

// ── Applied Jobs & Tailored Resumes ──────────────────────────────────────────

function saveTailoredResume(data) {
  if (!data) return null;
  const db = getDb();
  const id = String(data.id || data.jobId || data.job_id || `res_${Date.now()}`);
  const jobId = String(data.jobId || data.job_id || id);
  const title = String(data.tailored_title || data.title || 'Target Role');
  const company = String(data.company_name || data.company || 'Target Company');
  const location = String(data.location || '');
  const summary = String(data.tailored_summary || data.humanized_summary || data.summary || '');
  const skillsJson = typeof data.categorized_skills === 'object'
    ? JSON.stringify(data.categorized_skills)
    : String(data.categorized_skills || '');
  const expJson = typeof data.tailored_experience === 'object'
    ? JSON.stringify(data.tailored_experience)
    : (typeof data.experience === 'object' ? JSON.stringify(data.experience) : String(data.tailored_experience || ''));
  const coverLetter = String(data.cover_letter || data.humanized_cover_letter || '');
  const resumeJson = typeof data.tailored_resume_json === 'object'
    ? JSON.stringify(data.tailored_resume_json)
    : (typeof data.resume_json === 'object' ? JSON.stringify(data.resume_json) : String(data.tailored_resume_json || data.resume_json || ''));
  const pdfPath = String(data.pdf_path || '');
  const pdfFilename = String(data.pdf_filename || (pdfPath ? path.basename(pdfPath) : ''));
  let pdfBase64 = String(data.pdf_base64 || '');
  if (!pdfBase64 && pdfPath && fs.existsSync(pdfPath)) {
    try {
      pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
    } catch (_) { }
  }
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO tailored_resumes (
      id, job_id, title, company, location, tailored_summary, categorized_skills_json,
      tailored_experience_json, cover_letter, resume_json, pdf_path, pdf_filename, pdf_base64, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      tailored_summary = excluded.tailored_summary,
      categorized_skills_json = excluded.categorized_skills_json,
      tailored_experience_json = excluded.tailored_experience_json,
      cover_letter = excluded.cover_letter,
      resume_json = excluded.resume_json,
      pdf_path = excluded.pdf_path,
      pdf_filename = excluded.pdf_filename,
      pdf_base64 = excluded.pdf_base64,
      created_at = excluded.created_at
  `);

  stmt.run(id, jobId, title, company, location, summary, skillsJson, expJson, coverLetter, resumeJson, pdfPath, pdfFilename, pdfBase64, now);
  return { id, jobId, title, company, pdfFilename };
}

function getTailoredResume(jobId) {
  if (!jobId) return null;
  const cleanId = String(jobId).trim();
  try {
    const db = getDb();
    let row = db.prepare('SELECT * FROM tailored_resumes WHERE id = ? OR job_id = ?').get(cleanId, cleanId);
    if (!row) {
      row = db.prepare('SELECT * FROM tailored_resumes WHERE id LIKE ? OR job_id LIKE ?').get(`%${cleanId}%`, `%${cleanId}%`);
    }
    if (row) {
      return {
        ...row,
        categorized_skills: row.categorized_skills_json ? JSON.parse(row.categorized_skills_json) : null,
        tailored_experience: row.tailored_experience_json ? JSON.parse(row.tailored_experience_json) : null,
        resume_data: row.resume_json ? JSON.parse(row.resume_json) : null
      };
    }
  } catch (e) {
    console.error('getTailoredResume error:', e.message);
  }
  return null;
}

function getTailoredResumes(limit = 100) {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM tailored_resumes ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(r => ({
      ...r,
      categorized_skills: r.categorized_skills_json ? JSON.parse(r.categorized_skills_json) : null,
      tailored_experience: r.tailored_experience_json ? JSON.parse(r.tailored_experience_json) : null,
      resume_data: r.resume_json ? JSON.parse(r.resume_json) : null
    }));
  } catch (_) {
    return [];
  }
}

function saveAppliedJob(job) {
  if (!job) return null;
  const db = getDb();

  const id = String(job.id || job.jobId || job.job_id || `app_${Date.now()}`);
  const jobId = String(job.jobId || job.job_id || id);
  const title = String(job.tailored_title || job.title || 'Target Role');
  const company = String(job.company_name || job.company || 'Target Company');
  const location = String(job.location || '');
  const jobUrl = String(job.job_url || job.redirect_url || job.apply_url || job.url || '');
  const source = String(job.source || 'Direct');
  const matchScore = parseInt(job.match_score || job.score || job.overall_score || 85, 10);
  const atsKeywordFit = parseInt(job.ats_keyword_fit || job.ats_coverage_pct || 90, 10);
  const tailoredSummary = String(job.tailored_summary || job.humanized_summary || '');
  const categorizedSkills = typeof job.categorized_skills === 'object'
    ? JSON.stringify(job.categorized_skills)
    : String(job.categorized_skills || '');
  const tailoredExperience = typeof job.tailored_experience === 'string'
    ? job.tailored_experience
    : JSON.stringify(job.tailored_experience || []);
  const coverLetter = String(job.cover_letter || job.humanized_cover_letter || '');
  const tailoredResumeJson = typeof job.tailored_resume_json === 'object'
    ? JSON.stringify(job.tailored_resume_json)
    : String(job.tailored_resume_json || '');
  const pdfPath = String(job.pdf_path || '');
  const pdfFilename = String(job.pdf_filename || path.basename(pdfPath) || '');
  let pdfBase64 = String(job.pdf_base64 || '');
  if (!pdfBase64 && pdfPath && fs.existsSync(pdfPath)) {
    try {
      pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
    } catch (_) { }
  }
  const recruiterName = String(job.recruiter_name || '');
  const recruiterEmail = String(job.recruiter_email || '');
  const recruiterLinkedin = String(job.recruiter_linkedin || '');
  const appliedAt = job.appliedAt || job.applied_at || new Date().toISOString();
  const status = String(job.status || 'Applied');

  const stmt = db.prepare(`
    INSERT INTO applied_jobs (
      id, job_id, title, company, location, job_url, source,
      match_score, ats_keyword_fit, tailored_summary, tailored_experience,
      cover_letter, pdf_path, pdf_filename, recruiter_name, recruiter_email,
      recruiter_linkedin, applied_at, status, categorized_skills, tailored_resume_json, pdf_base64
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      job_url = excluded.job_url,
      source = excluded.source,
      match_score = excluded.match_score,
      ats_keyword_fit = excluded.ats_keyword_fit,
      tailored_summary = excluded.tailored_summary,
      tailored_experience = excluded.tailored_experience,
      cover_letter = excluded.cover_letter,
      pdf_path = excluded.pdf_path,
      pdf_filename = excluded.pdf_filename,
      recruiter_name = excluded.recruiter_name,
      recruiter_email = excluded.recruiter_email,
      recruiter_linkedin = excluded.recruiter_linkedin,
      applied_at = excluded.applied_at,
      status = excluded.status,
      categorized_skills = excluded.categorized_skills,
      tailored_resume_json = excluded.tailored_resume_json,
      pdf_base64 = excluded.pdf_base64
  `);

  stmt.run(
    id, jobId, title, company, location, jobUrl, source,
    matchScore, atsKeywordFit, tailoredSummary, tailoredExperience,
    coverLetter, pdfPath, pdfFilename, recruiterName, recruiterEmail,
    recruiterLinkedin, appliedAt, status, categorizedSkills, tailoredResumeJson, pdfBase64
  );

  // Also save to dedicated tailored_resumes table
  saveTailoredResume({
    id, jobId, title, company, location,
    tailored_summary: tailoredSummary,
    categorized_skills: job.categorized_skills,
    tailored_experience: job.tailored_experience,
    cover_letter: coverLetter,
    tailored_resume_json: job.tailored_resume_json,
    pdf_path: pdfPath,
    pdf_filename: pdfFilename,
    pdf_base64: pdfBase64
  });

  // Remove from pending_jobs table
  removePendingJob(jobId);

  return { id, title, company, status, appliedAt, pdfPath };
}

function getAppliedJobs(limit = 1000) {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM applied_jobs
      ORDER BY applied_at DESC
      LIMIT ?
    `).all(limit);
    return rows;
  } catch (err) {
    console.error('Error querying applied_jobs from SQLite:', err.message);
    return [];
  }
}

// ── Seen Jobs (Deduplication) ────────────────────────────────────────────────

function markJobSeen(id) {
  if (!id) return;
  try {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO seen_jobs (id, seen_at) VALUES (?, ?)').run(
      String(id).toLowerCase(),
      new Date().toISOString()
    );
  } catch (_) { }
}

function markJobsSeen(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  try {
    const db = getDb();
    const stmt = db.prepare('INSERT OR IGNORE INTO seen_jobs (id, seen_at) VALUES (?, ?)');
    const now = new Date().toISOString();
    for (const id of ids) {
      if (id) stmt.run(String(id).toLowerCase(), now);
    }
  } catch (_) { }
}

function isJobSeen(id) {
  if (!id) return false;
  try {
    const db = getDb();
    const row = db.prepare('SELECT 1 FROM seen_jobs WHERE id = ?').get(String(id).toLowerCase());
    return Boolean(row);
  } catch (_) {
    return false;
  }
}

function getSeenJobsCount() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT count(*) as count FROM seen_jobs').get();
    return row ? row.count : 0;
  } catch (_) {
    return 0;
  }
}

// ── Pending Approval Jobs ────────────────────────────────────────────────────

function savePendingJob(job) {
  if (!job) return;
  try {
    const db = getDb();
    const id = String(job.id || job.jobId || job.job_id || `pend_${Date.now()}`);
    const jobId = String(job.jobId || job.job_id || id);
    const title = String(job.title || '');
    const company = String(job.company || job.company_name || '');
    const location = String(job.location || '');
    const jobUrl = String(job.job_url || job.redirect_url || '');
    const score = parseInt(job.match_score || job.score || 0, 10);
    const payload = JSON.stringify(job);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO pending_jobs (id, job_id, title, company, location, job_url, match_score, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        company = excluded.company,
        match_score = excluded.match_score,
        payload_json = excluded.payload_json
    `).run(id, jobId, title, company, location, jobUrl, score, payload, now);
    return true;
  } catch (err) {
    console.error('savePendingJob error:', err.message);
    return false;
  }
}

function getPendingJobs(limit = 100) {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM pending_jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map(r => {
      try { return JSON.parse(r.payload_json); } catch (_) { return r; }
    });
  } catch (_) {
    return [];
  }
}

function removePendingJob(jobId) {
  if (!jobId) return;
  try {
    const db = getDb();
    db.prepare(`DELETE FROM pending_jobs WHERE id = ? OR job_id = ?`).run(String(jobId), String(jobId));
  } catch (_) { }
}

function findJobRecord(jId) {
  if (!jId) return null;
  const cleanId = String(jId).trim();
  const strippedId = cleanId.replace(/^(linkedin_jobs_|linkedin_|canada_job_bank_|adzuna_|indeed_|jobicy_|remotive_|usajobs_)/i, '');

  try {
    const db = getDb();
    
    // 1. Check pending_jobs
    let row = db.prepare('SELECT payload_json FROM pending_jobs WHERE id = ? OR job_id = ? OR id = ? OR job_id = ? OR id LIKE ? OR job_id LIKE ?').get(cleanId, cleanId, strippedId, strippedId, cleanId + '%', cleanId + '%');
    if (row && row.payload_json) {
      try { return JSON.parse(row.payload_json); } catch (_) {}
    }

    row = db.prepare('SELECT payload_json FROM pending_jobs WHERE ? LIKE \'%\' || id || \'%\' OR ? LIKE \'%\' || job_id || \'%\' OR id LIKE ? OR job_id LIKE ?').get(cleanId, cleanId, `%${strippedId}%`, `%${strippedId}%`);
    if (row && row.payload_json) {
      try { return JSON.parse(row.payload_json); } catch (_) {}
    }

    // 2. Check applied_jobs
    let aRow = db.prepare('SELECT * FROM applied_jobs WHERE id = ? OR job_id = ? OR id = ? OR job_id = ? OR id LIKE ? OR job_id LIKE ? OR ? LIKE \'%\' || id || \'%\' OR ? LIKE \'%\' || job_id || \'%\' OR id LIKE ? OR job_id LIKE ?').get(cleanId, cleanId, strippedId, strippedId, cleanId + '%', cleanId + '%', cleanId, cleanId, `%${strippedId}%`, `%${strippedId}%`);
    if (aRow) return aRow;

    // 3. Check rejected_jobs
    let rRow = db.prepare('SELECT payload_json FROM rejected_jobs WHERE id = ? OR job_id = ? OR id = ? OR job_id = ? OR id LIKE ? OR job_id LIKE ? OR ? LIKE \'%\' || id || \'%\' OR ? LIKE \'%\' || job_id || \'%\' OR id LIKE ? OR job_id LIKE ?').get(cleanId, cleanId, strippedId, strippedId, cleanId + '%', cleanId + '%', cleanId, cleanId, `%${strippedId}%`, `%${strippedId}%`);
    if (rRow && rRow.payload_json) {
      try { return JSON.parse(rRow.payload_json); } catch (_) {}
    }
  } catch (e) {
    console.error('findJobRecord error:', e.message);
  }
  return null;
}

// ── Rejected Jobs ────────────────────────────────────────────────────────────

function saveRejectedJob(job) {
  if (!job) return;
  try {
    const db = getDb();
    const id = String(job.id || job.jobId || job.job_id || `rej_${Date.now()}`);
    const jobId = String(job.jobId || job.job_id || id);
    const title = String(job.title || '');
    const company = String(job.company || job.company_name || '');
    const location = String(job.location || '');
    const score = parseInt(job.match_score || job.score || 0, 10);
    const payload = JSON.stringify(job);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO rejected_jobs (id, job_id, title, company, location, match_score, payload_json, rejected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        match_score = excluded.match_score,
        payload_json = excluded.payload_json
    `).run(id, jobId, title, company, location, score, payload, now);
  } catch (_) { }
}

function getRejectedJobs(limit = 100) {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM rejected_jobs ORDER BY rejected_at DESC LIMIT ?`).all(limit);
    return rows.map(r => {
      try { return JSON.parse(r.payload_json); } catch (_) { return r; }
    });
  } catch (_) {
    return [];
  }
}

// ── Recruiter Cache & Logs ───────────────────────────────────────────────────

function getCachedRecruiters(cacheKey, ttlMs = 14 * 24 * 3600 * 1000) {
  if (!cacheKey) return null;
  try {
    const db = getDb();
    const row = db.prepare('SELECT domain, contacts_json, cached_at FROM recruiter_cache WHERE cache_key = ?').get(String(cacheKey));
    if (!row) return null;
    if (Date.now() - row.cached_at > ttlMs) {
      db.prepare('DELETE FROM recruiter_cache WHERE cache_key = ?').run(String(cacheKey));
      return null;
    }
    return {
      domain: row.domain || '',
      contacts: JSON.parse(row.contacts_json || '[]')
    };
  } catch (_) {
    return null;
  }
}

function setCachedRecruiters(cacheKey, contacts, domain = '') {
  if (!cacheKey) return;
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO recruiter_cache (cache_key, domain, contacts_json, cached_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        domain = excluded.domain,
        contacts_json = excluded.contacts_json,
        cached_at = excluded.cached_at
    `).run(String(cacheKey), String(domain || ''), JSON.stringify(contacts || []), Date.now());
  } catch (_) { }
}

function saveRecruiterLog(jobId, company, city, contacts) {
  if (!company) return;
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO recruiter_logs (job_id, company, city, contacts_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(jobId || ''),
      String(company),
      String(city || ''),
      JSON.stringify(contacts || []),
      new Date().toISOString()
    );
  } catch (_) { }
}

function getRecruiterLogs(limit = 100) {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM recruiter_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map(r => ({
      id: r.id,
      jobId: r.job_id,
      company: r.company,
      city: r.city,
      contacts: JSON.parse(r.contacts_json || '[]'),
      at: r.created_at
    }));
  } catch (_) {
    return [];
  }
}

function clearPipelineData() {
  try {
    const db = getDb();
    db.prepare('DELETE FROM seen_jobs').run();
    db.prepare('DELETE FROM pending_jobs').run();
    db.prepare('DELETE FROM rejected_jobs').run();
    return true;
  } catch (err) {
    console.error('Error clearing pipeline data in SQLite:', err.message);
    return false;
  }
}

function clearAllTrackingData() {
  try {
    const db = getDb();
    db.prepare('DELETE FROM seen_jobs').run();
    db.prepare('DELETE FROM pending_jobs').run();
    db.prepare('DELETE FROM rejected_jobs').run();
    db.prepare('DELETE FROM applied_jobs').run();
    db.prepare('DELETE FROM tailored_resumes').run();
    db.prepare('DELETE FROM recruiter_logs').run();
    db.prepare('DELETE FROM recruiter_cache').run();
    return true;
  } catch (err) {
    console.error('Error clearing all tracking data in SQLite:', err.message);
    return false;
  }
}

module.exports = {
  getDb,
  getDbPath,
  saveAppliedJob,
  getAppliedJobs,
  markJobSeen,
  markJobsSeen,
  isJobSeen,
  getSeenJobsCount,
  savePendingJob,
  getPendingJobs,
  removePendingJob,
  findJobRecord,
  saveRejectedJob,
  getRejectedJobs,
  getCachedRecruiters,
  setCachedRecruiters,
  saveRecruiterLog,
  getRecruiterLogs,
  saveTailoredResume,
  getTailoredResume,
  getTailoredResumes,
  clearPipelineData,
  clearAllTrackingData
};


