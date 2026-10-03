# 📝 AI Prompts & Pipeline Customization Guide

All LLM prompts used by the **Jobryt AI Agent** are externalized in this directory.  
Prompts focus on **evidence extraction, pillar scoring, and factual generation**, while weighted arithmetic, safety gates, and priority classification are executed deterministically in code.

---

## 📂 Prompt Files Overview

| File | Used By | Description & Variables Available |
| :--- | :--- | :--- |
| **`job-scoring.txt`** | n8n Scoring Node & `run-pipeline.js` | Evaluates duty-based title fit, skills overlap, seniority fit, and domain relevance. Wraps job posting in `<job_posting>` data tags to prevent prompt injection. <br>**Variables:** `{{CANDIDATE_NAME}}`, `{{TARGET_ROLES}}`, `{{LOCATIONS}}`, `{{WORK_STATUS}}`, `{{YEARS_EXPERIENCE}}`, `{{SKILLS}}`, `{{SUMMARY}}`, `{{EXPERIENCE_SUMMARY}}`, `{{JOB_TITLE}}`, `{{COMPANY}}`, `{{JOB_DESCRIPTION}}` |
| **`resume-tailoring.txt`** | n8n Generation Node | Tailors professional summary and 3-paragraph cover letter using ONLY verified facts from `<profile>`. <br>**Variables:** `{{PROFILE_JSON}}`, `{{JOB_TITLE}}`, `{{COMPANY}}`, `{{JOB_DESCRIPTION}}` |
| **`resume-parser.txt`** | Resume Parser (`resume-to-profile.js`) | Extracts candidate profile into standard schema. Splits titles and projects, extracts familiar skills, preserves verbatim bullets, and removes formatting artifacts. |
| **`humanize.txt`** | n8n Humanize Node | Aligns cover letter and cold email phrasing with candidate's authentic writing voice sample. Enforces keyword preservation and ±10% length bounds without altering facts. <br>**Variables:** `{{WRITING_SAMPLE}}`, `{{DRAFT_JSON}}` |
| **`cold-email.txt`** | Lead-Gen Outreach Node | Drafts high-conversion, 100-130 word executive cold email using candidate's top matched achievements. Fallback to "Hi there," when contact name is unavailable. <br>**Variables:** `{{JOB_TITLE}}`, `{{COMPANY}}`, `{{CONTACT_NAME}}`, `{{MATCHED_ACHIEVEMENTS}}`, `{{JOB_DESCRIPTION}}`, `{{CANDIDATE_NAME}}`, `{{EMAIL}}` |

---

## ⚙️ Deterministic Scoring Architecture

To eliminate LLM arithmetic inaccuracies and gate hallucination:
1. **The LLM outputs only evidence and pillar scores (0–100):**
   - `title_fit_score` (evaluated on actual responsibilities and function, not literal title strings)
   - `skills_fit_score` (ratio of required skills present in candidate profile)
   - `seniority_fit_score` (experience year delta)
   - `domain_fit_score` (transferable industry alignment)
   - `company_tier` (`FAANG_TOP_PRODUCT | TOP_ENTERPRISE | STRONG_STARTUP | MID_TIER | LOW_QUALITY | UNKNOWN`)
   - `disqualification_reasons` (hard blockers like missing security clearance or non-matching location)

2. **The Code node deterministically computes scores:**
   ```javascript
   const j = $json, b = j.breakdown || {};
   let overall = Math.round(
     (b.title_fit_score || 0) * 0.40 + 
     (b.skills_fit_score || 0) * 0.35 + 
     (b.seniority_fit_score || 0) * 0.15 + 
     (b.domain_fit_score || 0) * 0.10
   );
   
   if ((b.title_fit_score || 0) < 50) overall = Math.min(overall, 45);
   
   const disqs = Array.isArray(j.disqualification_reasons) ? j.disqualification_reasons : [];
   const should_apply = overall >= 65 && (b.title_fit_score || 0) >= 50 && disqs.length === 0;
   const priority_level = overall >= 80 ? "High" : overall >= 65 ? "Medium" : "Low";
   
   return { json: { ...j, overall_score: overall, should_apply, priority_level } };
   ```

---

## 🛡️ Zero-Fabrication & Metric Guard

- Resume tailoring and cold email generation are locked strictly to candidate verified facts.
- The QA engine scans output text to ensure that numbers and metrics (`15%`, `$2M`, `500+`) from the source profile are never altered during humanization.
