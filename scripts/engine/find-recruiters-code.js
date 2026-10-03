/**
 * find-recruiters-code.js — Side-Branch Recruiter & Hiring Team Finder
 *
 * Wire as a SIDE BRANCH off "Parse Updates" in parallel with "LLM Generate".
 * Mode: "Run Once for All Items"
 *
 * BEHAVIOR:
 *   - Acts on: action === 'APPLY' or action === 'RECRUITERS'
 *   - If SERPER_API_KEY or HUNTER_API_KEY is present:
 *       Runs automated discovery via Google Serper & Hunter.io, with 14-day disk caching.
 *   - If NOT subscribed (no Serper / Hunter keys):
 *       Gracefully falls back to 1-Tap Google X-Ray Search & LinkedIn search links.
 *       Never sends missing-key warnings or error spam.
 *   - In all cases:
 *       Generates tailored, zero-fabrication LinkedIn connection note (≤300 chars)
 *       and optional email draft, sending an interactive Telegram card.
 */
const fs = require('fs');
const path = require('path');

let jobsDb = null;
try {
  const candidates = ['/scripts/core/jobs-db.js', path.join((typeof process !== 'undefined' && process.cwd ? process.cwd() : '.'), 'scripts', 'core', 'jobs-db.js')];
  for (const c of candidates) {
    if (fs.existsSync(c)) { jobsDb = require(c); break; }
  }
} catch (e) {
  console.error('[Find Recruiters] Failed to load jobs-db:', (e && e.message) || e);
}

const DATA = ($env.DATA_DIR || '/data').replace(/\\/g, '/');
const CACHE_TTL_MS = 14 * 24 * 3600 * 1000; // 14 days
const MAX_CONTACTS = 5;

const SERPER_KEY = $env.SERPER_API_KEY || '';
const HUNTER_KEY = $env.HUNTER_API_KEY || '';
const BOT = $env.TELEGRAM_BOT_TOKEN || '';
const hasSubscription = Boolean(SERPER_KEY || HUNTER_KEY);

// ── Helpers ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const safeHttps = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : '';

function companyKey(company) {
  const stop = new Set(['inc', 'ltd', 'limited', 'corp', 'corporation', 'llc', 'co', 'company', 'canada', 'the', 'group', 'holdings']);
  const toks = norm(company).split(' ').filter(t => t && !stop.has(t));
  return toks.slice(0, 2).join(' ') || norm(company);
}

function cityOf(job, profile) {
  let loc = job.location;
  if (loc && typeof loc === 'object') loc = loc.display_name || loc.name || '';
  loc = String(loc || '');
  let city = loc.split(',')[0].trim();
  if (!city || /remote|anywhere|canada|united states$/i.test(city)) {
    const pl = (profile.locations && profile.locations[0]) || '';
    city = String(pl).split(',')[0].trim();
  }
  return /remote/i.test(city) ? '' : city;
}

function linkedinPeopleUrl(keywords) {
  const clean = String(keywords || '').replace(/\s+/g, ' ').trim();
  return 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(clean) + '&origin=GLOBAL_SEARCH_HEADER';
}

function googleXrayUrl(company, city) {
  const cleanComp = String(company || '').replace(/["']/g, '').trim();
  const cleanCity = String(city || '').replace(/["']/g, '').trim();
  const q = `site:linkedin.com/in ("talent acquisition" OR recruiter OR "technical recruiter" OR "human resources") "${cleanComp}"${cleanCity ? ' "' + cleanCity + '"' : ''}`;
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

// ── Subscription Data Sources (With Bulletproof Fallback to Google Search) ───
async function serperSearch(q, helpers) {
  if (!SERPER_KEY) return [];
  try {
    const res = await helpers.httpRequest({
      method: 'POST',
      url: 'https://google.serper.dev/search',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: { q, gl: 'ca', hl: 'en', num: 10 },
      json: true,
      timeout: 12000
    });
    return Array.isArray(res && res.organic) ? res.organic : [];
  } catch (err) {
    // If user skipped, key is stale/invalid, bad request, or rate limit: fallback to Google search
    console.warn('[Recruiter Finder] Serper API error or stale key (' + (err.message || err) + '). Falling back to Google search.');
    return [];
  }
}

function isForeignDomain(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  const foreignTlds = ['.com.au', '.co.uk', '.in', '.co.in', '.de', '.fr', '.co.za', '.com.br', '.com.mx', '.es', '.it', '.nl', '.jp'];
  return foreignTlds.some(tld => d.endsWith(tld));
}

function parseLinkedInResult(r, ckey, city) {
  const link = String(r.link || '');
  if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(link)) return null;
  const rawTitle = String(r.title || '').replace(/\s*[|·]\s*LinkedIn.*$/i, '');
  const snippet = String(r.snippet || '');
  const blob = norm(rawTitle + ' ' + snippet);
  if (!blob.includes(ckey)) return null;
  if (/\b(former|formerly|ex)\b/i.test(rawTitle + ' ' + snippet)) return null;

  const parts = rawTitle.split(/\s+[-–—]\s+/);
  // Strip trailing credentials (e.g. ', MHRM', ', MBA', ', CHRP', ', RPR', ', CPA', ', PMP')
  const name = (parts[0] || '').replace(/,.*$/, '').trim();
  if (!/^[A-Za-z'’.\-]+(\s+[A-Za-z'’.\-]+){1,3}$/.test(name)) return null;

  const headline = parts.slice(1).join(' - ').trim();
  const hl = norm(headline);
  const snippetNorm = norm(snippet);

  // Must currently work at the target company (in headline, current role, or title)
  if (!hl.includes(ckey) && !norm(rawTitle).includes(ckey)) return null;

  // Must be in recruitment / talent / HR
  if (!/(recruit|talent|sourc|human resources|\bhr\b|people (ops|operations|partner|team)|staffing)/.test(hl + ' ' + snippetNorm)) return null;
  if (/\bintern\b|\bstudent\b/.test(hl)) return null;

  let score = 0;
  // Role precision scoring
  if (/(talent acquisition (specialist|manager|partner|lead)|senior recruiter|corporate recruiter)/.test(hl)) score += 5;
  else if (/(talent acquisition|recruit)/.test(hl)) score += 3;
  else if (/(human resources|\bhr\b|people)/.test(hl)) score += 1;

  // Office location match boost
  const isCityMatch = city && (blob.includes(norm(city)) || snippetNorm.includes(norm(city)));
  if (isCityMatch) score += 5;

  // Department alignment (Tech / Data / Analytics / IT)
  if (/(data|analytics|technology|tech|it )\s*(recruit|talent)|technical recruiter/.test(hl + ' ' + snippetNorm)) score += 3;

  return {
    name,
    headline,
    linkedin: link,
    source: 'serper',
    score,
    email: '',
    emailSource: '',
    isLocalOffice: Boolean(isCityMatch)
  };
}

async function hunterDomain(company, helpers) {
  if (!HUNTER_KEY) return { domain: '', contacts: [] };

  async function queryHunter(cName) {
    try {
      const url = 'https://api.hunter.io/v2/domain-search?company=' + encodeURIComponent(cName) + '&department=hr&limit=10';
      const res = await helpers.httpRequest({
        method: 'GET',
        url,
        headers: { 'X-API-KEY': HUNTER_KEY },
        json: true,
        timeout: 12000
      });
      const d = (res && res.data) || {};
      const emails = (d.emails || [])
        .filter(e => e && e.type === 'personal' && e.first_name && e.last_name && (e.confidence || 0) >= 70)
        .map(e => ({
          name: `${e.first_name} ${e.last_name}`.trim(),
          headline: e.position || '',
          linkedin: safeHttps(e.linkedin ? (String(e.linkedin).startsWith('http') ? e.linkedin : 'https://' + e.linkedin) : ''),
          source: 'hunter',
          score: 2 + ((e.confidence || 0) >= 90 ? 1 : 0),
          email: e.value || '',
          emailSource: safeHttps(e.sources && e.sources[0] && e.sources[0].uri) || '',
          isLocalOffice: false
        }));
      return { domain: d.domain || '', contacts: emails };
    } catch (err) {
      return { domain: '', contacts: [] };
    }
  }

  let result = await queryHunter(company);
  if (!result.domain || result.contacts.length === 0) {
    const stripped = company.replace(/\b(canada|canadian|usa|us|inc|ltd|limited|corp|corporation|llc)\b/gi, '').trim();
    if (stripped && stripped.toLowerCase() !== company.toLowerCase()) {
      const retry = await queryHunter(stripped);
      if (retry.contacts.length > 0 || retry.domain) {
        result = retry;
      }
    }
  }

  // Reject foreign domains (e.g. definity.com.au when candidate is in Canada)
  if (result.domain && isForeignDomain(result.domain)) {
    console.warn(`[Recruiter Finder] Discarding foreign ccTLD domain ${result.domain} for North American search.`);
    return { domain: '', contacts: [] };
  }

  return result;
}

function mergeContacts(list) {
  const byName = new Map();
  for (const c of list) {
    const k = norm(c.name);
    if (!k) continue;
    const prev = byName.get(k);
    if (!prev) { byName.set(k, { ...c }); continue; }
    prev.score = Math.max(prev.score, c.score) + 2;
    prev.linkedin = prev.linkedin || c.linkedin;
    prev.headline = prev.headline || c.headline;
    prev.email = prev.email || c.email;
    prev.emailSource = prev.emailSource || c.emailSource;
    prev.isLocalOffice = prev.isLocalOffice || c.isLocalOffice;
    prev.source = 'serper+hunter';
  }
  return [...byName.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CONTACTS);
}

// ── Outreach Drafts (100% Deterministic — Zero Hallucination) ────────────────
function matchedSkills(job, profile) {
  const jd = norm((job.title || '') + ' ' + (job.description || ''));
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const hit = skills.filter(s => s && jd.includes(norm(s))).slice(0, 3);
  return (hit.length ? hit : skills.slice(0, 3));
}

function draftNote(first, job, profile, company) {
  const role = (profile.target_titles && profile.target_titles[0]) || (profile.experience && profile.experience[0] && profile.experience[0].role) || 'Professional';
  const sk = matchedSkills(job, profile).join(', ');
  let note = `Hi ${first}, I just applied for the ${job.title || 'open'} role at ${company}. I'm a ${role} (${sk}). If you're not the right contact, I'd really appreciate a pointer. Thanks, ${(profile.name || '').split(' ')[0]}`;
  return note.length > 300 ? note.slice(0, 297) + '...' : note;
}

function draftEmail(first, job, profile, company) {
  const role = (profile.target_titles && profile.target_titles[0]) || (profile.experience && profile.experience[0] && profile.experience[0].role) || 'Professional';
  const sk = matchedSkills(job, profile).join(', ');
  const email = (profile.contact && profile.contact.email) || '';
  const phone = (profile.contact && profile.contact.phone) || '';
  return {
    subject: `${job.title || 'Role'} application – ${profile.name || ''}`.trim(),
    body: `Hi ${first},\n\nI applied for the ${job.title || 'open'} position at ${company} and wanted to introduce myself directly. I currently work as a ${role}, with hands-on experience in ${sk}. My tailored resume is attached.\n\nIf you're not the right person for this role, could you point me to who is? Happy to share anything else that helps.\n\nIf you'd rather not hear from me, just say so and I won't follow up.\n\nThank you,\n${profile.name || ''}\n${[email, phone].filter(Boolean).join(' | ')}`
  };
}

// ── Telegram Dispatcher ──────────────────────────────────────────────────────
async function sendTelegram(chatId, text, helpers, replyMarkup = null) {
  if (!BOT || !chatId) return;
  const payload = {
    chat_id: chatId,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    text
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  // Attempt 1: via n8n httpRequest with explicit application/json header
  try {
    return await helpers.httpRequest({
      method: 'POST',
      url: `https://api.telegram.org/bot${BOT}/sendMessage`,
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      json: true,
      timeout: 12000
    });
  } catch (e) {
    console.warn('[Recruiter Finder] n8n httpRequest failed (' + (e.message || e) + '). Attempting direct https fallback...');
  }

  // Attempt 2: Bulletproof Node.js native https fallback
  try {
    const https = require('https');
    const dataStr = JSON.stringify(payload);
    return await new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr)
        },
        timeout: 12000
      }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf);
            if (parsed.ok) resolve(parsed);
            else {
              console.error('[Recruiter Finder] Telegram API error:', parsed.description || buf);
              resolve(parsed);
            }
          } catch (pe) {
            resolve(buf);
          }
        });
      });
      req.on('error', err => {
        console.error('[Recruiter Finder] Native https request error:', err.message);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        console.error('[Recruiter Finder] Native https request timed out');
        resolve(null);
      });
      req.write(dataStr);
      req.end();
    });
  } catch (nativeErr) {
    console.error('[Recruiter Finder] Native https send failed:', nativeErr.message);
  }
}

// ── Main Pipeline ────────────────────────────────────────────────────────────
const helpers = this.helpers;
const items = $input.all();

for (const item of items) {
  const job = item.json || {};
  const action = String(job.action || '').toUpperCase();
  if (action !== 'APPLY' && action !== 'RECRUITERS') continue;

  let profile = job.masterProfileObj;
  if (!profile || typeof profile !== 'object') {
    try {
      const pPath = path.join(DATA, 'profiles', 'master-profile.json');
      if (fs.existsSync(pPath)) {
        profile = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      }
    } catch (_) {}
  }
  profile = profile || {};
  const company = String(job.company_name || job.company || '').trim().replace(/[.,\s]+$/, '');
  if (!company || /^(target company|hiring company|company)$/i.test(company)) continue;

  const city = cityOf(job, profile);
  const ckey = companyKey(company);
  const cacheKey = norm(company) + '|' + norm(city);

  let contacts = [];
  let domain = '';

  if (hasSubscription) {
    // ── Mode A: Subscribed (Serper / Hunter automated discovery) ─────────────
    let hit = null;
    if (jobsDb && typeof jobsDb.getCachedRecruiters === 'function') {
      hit = jobsDb.getCachedRecruiters(cacheKey, CACHE_TTL_MS);
    }

    if (hit && Array.isArray(hit.contacts) && hit.contacts.length > 0) {
      contacts = hit.contacts;
      domain = hit.domain || '';
    } else {
      const found = [];
      if (SERPER_KEY) {
        try {
          const q = `site:linkedin.com/in ("talent acquisition" OR recruiter OR "technical recruiter") "${company}"${city ? ' "' + city + '"' : ''}`;
          for (const r of await serperSearch(q, helpers)) {
            const c = parseLinkedInResult(r, ckey, city);
            if (c) found.push(c);
          }
        } catch (e) {}
      }
      if (HUNTER_KEY) {
        try {
          const h = await hunterDomain(company, helpers);
          domain = h.domain;
          found.push(...h.contacts);
        } catch (e) {}
      }
      contacts = mergeContacts(found);
      if (contacts.length) {
        if (jobsDb && typeof jobsDb.setCachedRecruiters === 'function') {
          jobsDb.setCachedRecruiters(cacheKey, contacts, domain);
        }
      }
    }
  }

  // ── Build Telegram Card with Mandatory User Validation Warning ────────────
  const lines = [];
  lines.push(`🤝 <b>RECRUITER & HIRING OUTREACH</b>`);
  lines.push(`<b>${esc(job.title || 'Role')}</b> @ ${esc(company)}${city ? ' — ' + esc(city) : ''}`);
  lines.push('');
  lines.push('⚠️ <b>SAFETY DOUBLE-CHECK REQUIRED:</b>');
  lines.push(`<i>Web scrapers and directories can be outdated. <b>Always verify the person currently works at ${esc(company)} and recruits for this team</b> before sending your resume or outreach!</i>`);
  lines.push('');

  const inlineButtons = [];

  if (contacts.length > 0) {
    lines.push('🎯 <b>Verified Contacts Found:</b>');
    contacts.forEach((c, i) => {
      const locBadge = c.isLocalOffice && city ? ` <i>(📍 ${esc(city)} Office)</i>` : '';
      lines.push(`${i + 1}. <b>${esc(c.name)}</b>${c.headline ? ' — ' + esc(c.headline) : ''}${locBadge}`);
      if (c.linkedin) lines.push(`   🔗 <a href="${esc(c.linkedin)}">Inspect & Verify Profile on LinkedIn ↗</a>`);
      if (c.email) lines.push(`   ✉️ <code>${esc(c.email)}</code> <i>(Verify address before sending)</i>`);
    });
    lines.push('');
    lines.push('🔎 <b>Instant 1-Tap Searches:</b>');

    // Add quick-verification button for top contact
    if (contacts[0].linkedin) {
      const topFirstName = contacts[0].name.split(' ')[0];
      inlineButtons.push([{ text: `🔍 Verify ${topFirstName} on LinkedIn`, url: contacts[0].linkedin }]);
    }
  } else {
    // Seamless fallback to 1-Tap Google Search when keys are skipped, bad, or stale
    lines.push('🔍 <b>1-Tap Google Search (Zero-Cost Recruiter Finder):</b>');
    lines.push('<i>(Direct Google X-Ray & LinkedIn queries — $0 cost and zero API keys needed)</i>');
  }

  lines.push(`• <a href="${esc(googleXrayUrl(company, city))}">🔍 <b>Google X-Ray Search</b> (Recruiters at ${esc(company)})</a>`);
  lines.push(`• <a href="${esc(linkedinPeopleUrl('talent acquisition ' + company + (city ? ' ' + city : '')))}">💼 <b>LinkedIn Recruiter Search</b></a>`);
  lines.push(`• <a href="${esc(linkedinPeopleUrl('hiring manager ' + company))}">👔 <b>Hiring Managers at ${esc(company)}</b></a>`);

  // ── Draft Outreach (Zero Autonomous Sending — 100% Staged for User) ───────
  const first = contacts.length ? contacts[0].name.split(' ')[0] : 'there';
  lines.push('');
  lines.push('💬 <b>LinkedIn Connection Note</b> (≤300 chars, ready to copy):');
  lines.push(`<code>${esc(draftNote(first, job, profile, company))}</code>`);

  const emailContact = contacts.find(c => c.email && !isForeignDomain(c.email.split('@')[1]));
  if (emailContact) {
    const em = draftEmail(first, job, profile, company);
    lines.push('');
    lines.push('📧 <b>Draft Email</b> (Staged — Requires Human Validation):');
    lines.push(`🛑 <i>Review carefully. Never send unverified emails to avoid misdelivery or spam filters.</i>`);
    lines.push(`<b>To:</b> <code>${esc(emailContact.email)}</code>`);
    lines.push(`<b>Subject:</b> ${esc(em.subject)}`);
    lines.push(`<pre>${esc(em.body)}</pre>`);
    lines.push(`👉 <i>Tip: Tap "Review & Send via Gmail" below to open pre-filled in your mail client, attach your resume PDF, and inspect before sending.</i>`);

    // 1-Tap Gmail composer link: safely opens native/web mail composer with pre-filled fields
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(emailContact.email)}&su=${encodeURIComponent(em.subject)}&body=${encodeURIComponent(em.body)}`;
    if (gmailUrl.length <= 1800) {
      inlineButtons.push([{ text: `✉️ Review & Send via Gmail (Pre-filled)`, url: gmailUrl }]);
    }
  }

  // Row with instant Google X-Ray & LinkedIn search buttons
  const shortComp = company.length > 15 ? company.slice(0, 14) + '…' : company;
  inlineButtons.push([
    { text: `🔎 Google Search (${shortComp})`, url: googleXrayUrl(company, city) },
    { text: '💼 LinkedIn Recruiters', url: linkedinPeopleUrl('talent acquisition ' + company + (city ? ' ' + city : '')) }
  ]);

  const replyMarkup = inlineButtons.length > 0 ? { inline_keyboard: inlineButtons } : null;

  await sendTelegram(job.chat_id || $env.TELEGRAM_CHAT_ID, lines.join('\n'), helpers, replyMarkup);

  // Log to SQLite database
  const contactSummary = contacts.map(c => ({ name: c.name, linkedin: c.linkedin, email: c.email, source: c.source }));
  if (jobsDb && typeof jobsDb.saveRecruiterLog === 'function') {
    jobsDb.saveRecruiterLog(job.jobId || job.id || '', company, city, contactSummary);
  }

  item.json.recruiters = contacts;
}

return items;
