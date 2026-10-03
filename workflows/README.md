# JobRyt AI Agent — Workflows Directory

This directory contains the core n8n workflow definitions in JSON format.

---

## Workflows

### 1. `0-resume-to-profile.json` — Resume Ingestion & Parsing
* **ID:** `wf0`
* **Trigger:** Webhook (`/webhook/upload-resume`) or Manual Trigger
* **Purpose:** Ingests a raw candidate resume (PDF binary, DOCX, or text payload), executes pre-parse text normalization, invokes Gemini with structured JSON schema (`prompts/schemas/resume-parser.schema.json`), computes deterministic years of experience, and saves the verified candidate facts into `data/profiles/master-profile.json`.
* **Nodes:**
  - `Webhook: Upload Resume`: Inbound HTTP endpoint for file uploads
  - `Manual Trigger`: UI test trigger
  - `Prepare Resume Payload`: Cleans DOCX/PDF artifacts (zero-width chars, broken asterisks, spaces)
  - `LLM Extract Master Profile`: Gemini extraction with zero-fabrication prompt
  - `Save & Validate Master Profile`: Validates bullets, calculates years of experience, backs up existing profile, and saves
  - `Respond to Webhook`: Returns JSON summary to caller

---

### 2. `master-workflow.json` — Fetch, Dedup, Score, Generate & Deliver
* **ID:** `master-bot`
* **Trigger:** Schedule Trigger (Runs 5 times daily: `30 8,11,14,17,20 * * *`) and Webhook Callback
* **Purpose:** Fully automated job search and interactive application lifecycle:
  1. **Ingest:** Multi-board scraper fetches live postings in parallel ($0 tokens).
  2. **Filter:** Deterministic freshness, country scope, and composite deduplication.
  3. **Score:** Duty-based qualitative LLM evaluation.
  4. **Gate:** Code node computes weighted math ($0.40/0.35/0.15/0.10$), applies hard title cap ($<50 \implies \le 45$), checks blockers, and gates at Score $\ge 70$.
  5. **Tailor & Humanize:** Bounded resume summary and cover letter generation from verified facts with multiset numeric token integrity checking.
  6. **PDF & Telegram:** Compiles full-depth ATS PDF and delivers interactive card with `[Apply]` / `[Reject]` inline buttons to Telegram.

---

## Deployment & Database Synchronization

Workflows are executed by the n8n container, which reads from its internal SQLite database at `/home/node/.n8n/database.sqlite`.

To synchronize changes from these JSON files into the running database:
```bash
npm run republish:restart
```
This updates both `master-bot` and `wf0` in the database, registers webhook endpoints, and restarts the containers.
