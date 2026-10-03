/**
 * profile-validator.js — Candidate Profile Schema Validator
 *
 * PURPOSE:
 *   Validates a master-profile.json object to ensure all required fields exist
 *   and have the correct format. Used when a user uploads a new resume/profile
 *   via Telegram or when the system ingests a profile.
 *
 * REQUIRED FIELDS:
 *   - name: Candidate's full name (string)
 *   - contact.email: Valid email address
 *   - target_titles: Array of job titles to search for
 *   - locations: Array of search locations
 *   - skills: Array of technical/professional skills
 *   - experience: Array of work history objects (role, company, dates, bullets)
 *
 * USAGE:
 *   const { validateProfileJson } = require('./profile-validator');
 *   const result = validateProfileJson(jsonString);
 *   if (result.valid) { ... use result.profile ... }
 *   else { ... show result.errors to user ... }
 */

function validateProfileJson(rawInput) {
  // ── Guard: Empty input ──────────────────────────────────────────────────
  if (!rawInput || typeof rawInput !== 'string' || !rawInput.trim()) {
    return {
      valid: false,
      errorType: 'EMPTY',
      errors: ['Input is empty. Please provide a valid JSON object.'],
    };
  }

  // ── Step 1: Clean up markdown code fences ───────────────────────────────
  // Users sometimes paste JSON wrapped in ```json ... ``` blocks
  const cleanInput = rawInput.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // ── Step 2: Parse JSON ──────────────────────────────────────────────────
  let parsed = null;
  try {
    parsed = JSON.parse(cleanInput);
  } catch (err) {
    const msg = err.message || 'Malformed JSON syntax';
    const hints = [];

    // Show the area around the error position
    const posMatch = msg.match(/position\s+(\d+)/i);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const snippet = cleanInput.slice(Math.max(0, pos - 25), Math.min(cleanInput.length, pos + 25));
      hints.push(`Near: "...${snippet}..."`);
    }

    // Common fix suggestions
    if (msg.includes('token') || msg.includes('Expected') || msg.includes('Unexpected')) {
      hints.push('Check for missing/extra commas, unquoted keys, or unmatched braces { } / brackets [ ].');
    }

    return {
      valid: false,
      errorType: 'SYNTAX_ERROR',
      errors: [`JSON Syntax Error: ${msg}`, ...hints],
    };
  }

  // Must be a plain object (not an array or null)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      errorType: 'SCHEMA_ERROR',
      errors: ['Profile must be a top-level JSON Object { ... } (not an array or primitive).'],
    };
  }

  // ── Step 3: Validate required fields ────────────────────────────────────
  const errors = [];
  const warnings = [];

  // Field 1: name
  if (!parsed.name || typeof parsed.name !== 'string' || !parsed.name.trim()) {
    errors.push('Missing required field "name" (must be a non-empty string, e.g. "Full Name").');
  }

  // Field 2: email (check contact.email, then top-level email)
  const contact = parsed.contact || {};
  const email = (typeof contact === 'object' && contact.email) || parsed.email || '';
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    errors.push('Missing or invalid email in "contact.email" (e.g. "candidate@example.com").');
  }

  // Field 3: target_titles (accept "role" or "title" as fallback)
  let targetTitles = [];
  if (Array.isArray(parsed.target_titles) && parsed.target_titles.length > 0) {
    targetTitles = parsed.target_titles.map(s => String(s).trim()).filter(Boolean);
  } else if (parsed.role && typeof parsed.role === 'string' && parsed.role.trim()) {
    targetTitles = [parsed.role.trim()];
  } else if (parsed.title && typeof parsed.title === 'string' && parsed.title.trim()) {
    targetTitles = [parsed.title.trim()];
  }
  if (targetTitles.length === 0) {
    errors.push('Missing required field "target_titles" (e.g. ["Data Analyst", "Senior Data Analyst"]).');
  }

  // Field 4: locations (accept "location" or contact.location as fallback)
  let locations = [];
  if (Array.isArray(parsed.locations) && parsed.locations.length > 0) {
    locations = parsed.locations.map(s => String(s).trim()).filter(Boolean);
  } else if (parsed.location && typeof parsed.location === 'string' && parsed.location.trim()) {
    locations = [parsed.location.trim()];
  } else if (contact.location && typeof contact.location === 'string' && contact.location.trim()) {
    locations = [contact.location.trim()];
  }
  if (locations.length === 0) {
    errors.push('Missing required field "locations" (e.g. ["Toronto, ON", "Canada"]).');
  }

  // Field 5: skills
  if (!Array.isArray(parsed.skills) || parsed.skills.length === 0) {
    errors.push('Missing required field "skills" (e.g. ["SQL", "Python", "Power BI"]).');
  } else {
    const invalidSkills = parsed.skills.filter(s => typeof s !== 'string' || !s.trim());
    if (invalidSkills.length > 0) {
      warnings.push('Some items in "skills" array were not valid strings and were filtered out.');
    }
  }

  // Field 6: experience (array of work history objects)
  if (!Array.isArray(parsed.experience) || parsed.experience.length === 0) {
    errors.push('Missing required field "experience" (array of job history objects).');
  } else {
    parsed.experience.forEach((exp, idx) => {
      const num = idx + 1;
      if (typeof exp !== 'object' || exp === null) {
        errors.push(`Experience #${num} must be an object { role, company, dates, bullets }.`);
        return;
      }
      if (!exp.role || typeof exp.role !== 'string' || !exp.role.trim()) {
        errors.push(`Experience #${num} is missing "role" (job title).`);
      }
      if (!exp.company || typeof exp.company !== 'string' || !exp.company.trim()) {
        errors.push(`Experience #${num} is missing "company".`);
      }
      if (!exp.dates || typeof exp.dates !== 'string' || !exp.dates.trim()) {
        errors.push(`Experience #${num} is missing "dates" (e.g. "Sep 2023 – Present").`);
      }
      if (!Array.isArray(exp.bullets) || exp.bullets.length === 0) {
        errors.push(`Experience #${num} is missing "bullets" array of achievements.`);
      }
    });
  }

  // ── Validation failed → return errors ─────────────────────────────────
  if (errors.length > 0) {
    return { valid: false, errorType: 'VALIDATION_ERROR', errors, warnings };
  }

  // ── Step 4: Build a clean, normalized profile ─────────────────────────
  // Trims all strings and fills optional fields with safe defaults.
  const cleanProfile = {
    name: parsed.name.trim(),
    target_titles: targetTitles,
    locations,
    work_type: parsed.work_type || 'Open to All (Remote, Hybrid, Onsite)',
    contact: {
      email: email.trim(),
      phone: (contact.phone || parsed.phone || '').trim(),
      location: (locations[0] || '').trim(),
      linkedin: (contact.linkedin || parsed.linkedin || '').trim(),
      github: (contact.github || parsed.github || '').trim(),
      status: (contact.status || parsed.status || 'Work Authorized').trim(),
    },
    summary: (parsed.summary || '').trim(),
    skills: parsed.skills.map(s => String(s).trim()).filter(Boolean),
    experience: parsed.experience.map(exp => ({
      role: String(exp.role || '').trim(),
      company: String(exp.company || '').trim(),
      dates: String(exp.dates || '').trim(),
      bullets: Array.isArray(exp.bullets) ? exp.bullets.map(b => String(b).trim()).filter(Boolean) : [],
    })),
    education: Array.isArray(parsed.education)
      ? parsed.education.map(edu => ({
          degree: String(edu.degree || '').trim(),
          institution: String(edu.institution || '').trim(),
          dates: String(edu.dates || '').trim(),
        }))
      : [],
    certifications: Array.isArray(parsed.certifications)
      ? parsed.certifications.map(c => String(c).trim()).filter(Boolean)
      : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    writing_sample: (parsed.writing_sample || parsed.summary || '').trim(),
  };

  return { valid: true, profile: cleanProfile, warnings };
}

module.exports = { validateProfileJson };
