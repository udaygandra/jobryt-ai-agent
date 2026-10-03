# JobRyt AI Agent — Developer & Contributor Guide

Welcome to the **JobRyt AI Agent** codebase! This guide is written for engineers of any experience level to quickly understand how to build, test, extend, and deploy changes.

---

## 1. Prerequisites & Setup

### Requirements
- **Node.js 18+** installed locally
- **Docker & Docker Compose** installed and running
- **Git**

### Installation
```bash
# 1. Clone repository
git clone https://github.com/udaygandra/jobryt-ai-agent.git
cd jobryt-ai-agent

# 2. Install local dependencies
npm install

# 3. Create .env from example template
cp .env.example .env
```

Open `.env` and fill in:
- `TELEGRAM_BOT_TOKEN`: From Telegram `@BotFather`
- `TELEGRAM_CHAT_ID`: Your chat ID from `@userinfobot`
- `GEMINI_API_KEY`: Free key from [Google AI Studio](https://aistudio.google.com/)

---

## 2. Useful NPM Commands

| Command | Action |
| :--- | :--- |
| `npm run test:all` | Runs the full verification suite (All 10 workflow nodes, Telegram onboarding FSM, 10-model waterfall). |
| `npm test` | Runs the fast onboarding and rate-limit regression tests. |
| `npm run validate` | Tests all JavaScript inside `0-resume-to-profile.json` and `master-workflow.json` for syntax errors. |
| `npm run republish:restart` | Injects latest scripts into n8n workflows, syncs n8n SQLite DB, and restarts containers. |
| `npm run reset` | Soft-resets job tracking data (`seen_jobs.json`, `pending_approval.json`) for a clean fresh run. |
| `npm run audit:security` | Runs automated security checks for leaked secrets, permissions, and network bindings. |
| `npm run parse-resume` | Parses a resume PDF/DOCX into `data/profiles/master-profile.json`. |

---

## 3. Directory Layout Cheat Sheet

```text
jobryt-ai-agent/
├── data/               # Persistent candidate data, tracking JSONs, configuration, and templates
│   ├── config/         # geo-hierarchy.json, settings.json
│   ├── profiles/       # master-profile.json (verified career facts)
│   └── tracking/       # seen_jobs.json, pending_approval.json, logged_jobs.json
├── docs/               # Technical specs, architecture diagrams, and developer guides
├── prompts/            # Markdown prompts & JSON response schemas for Gemini/LLMs
│   └── schemas/        # JSON schemas enforcing strict structured model outputs
├── scripts/            # Modular Node.js code nodes and engines
│   ├── admin/          # DevOps, SQLite synchronization, workflow optimizer, data reset
│   ├── bot/            # Telegram bridge daemon, onboarding state machine, document sender
│   ├── core/           # Foundational utilities: load-env.js, geo-helper.js, settings-helper.js
│   ├── engine/         # Multi-board fetcher, node-logic.js, llm-provider.js, PDF compiler
│   └── scratch/        # Experimental playground scripts
├── tests/              # Verification test harnesses
└── workflows/          # JSON workflows (0-resume-to-profile.json, master-workflow.json)
```

---

## 4. How to Add a New Job Board

All job boards are aggregated in `scripts/engine/fetch-all-boards.js`. To add a new source:

1. **Create the Fetch Function in `scripts/engine/fetch-all-boards.js`:**
   ```javascript
   async function fetchFromMyNewBoard(keyword, location, countryScope) {
     // Fetch data via HTTP request (zero tokens, free public endpoint)
     const rawJobs = await makeHttpRequest(...);
     return rawJobs.map(raw => normalizeJob({
       id: `myboard_${raw.id}`,
       title: raw.title,
       company: raw.companyName,
       location: raw.cityLocation,
       created: raw.postedDate,
       description: raw.jobDescriptionText,
       redirect_url: raw.applyUrl,
       source: 'My New Board'
     }));
   }
   ```
2. **Standardize with `normalizeJob`:**
   Always wrap the returned job in `normalizeJob(job)` (from `scripts/engine/node-logic.js`). This ensures fields like `id`, `title`, `company`, `location`, `description`, `created`, `redirect_url`, and `source` are consistently formatted.
3. **Add to Parallel Sweep in `fetchAllJobs`:**
   Add `fetchFromMyNewBoard` to the `Promise.allSettled` block in `fetchAllJobs()`.
4. **Update `data/config/settings.json`:**
   Add a toggle `enable_my_new_board: true` so users can enable/disable it in their settings.

---

## 5. How to Modify n8n Workflows

1. **Edit the Code Node in `scripts/engine/` or `scripts/admin/optimize-master-workflow.js`:**
   Never write complex raw JavaScript directly in the n8n UI, because manual edits will be overwritten on deployment.
2. **Validate Syntax:**
   Run:
   ```bash
   npm run validate
   ```
   This executes `scripts/admin/validate-workflows.js` to ensure there are no missing backticks, unescaped brackets, or syntax errors.
3. **Re-publish and Restart:**
   Run:
   ```bash
   npm run republish:restart
   ```
   This automatically injects your updated script into `master-workflow.json`, updates the n8n SQLite database, and restarts the containers.
4. **Run Verification Tests:**
   ```bash
   npm run test:all
   ```

---

## 6. Troubleshooting & Gotchas

* **"await is only valid in async functions":** n8n code nodes run inside an `async` context. If testing standalone code in Node.js, wrap top-level `await` in an async IIFE: `(async () => { ... })()`.
* **Port 5678 already in use:** Check if another local n8n instance is running with `docker ps`. Stop it with `docker stop <id>`.
* **Candidate Profile overwritten:** The candidate profile at `data/profiles/master-profile.json` is protected. Never commit dummy data to that path. If you need to test resume parsing without modifying the candidate's real profile, run `npm run test-resume`.
* **Telegram Bot Not Responding:** Ensure `docker compose ps` shows `jobryt-ai-agent-telegram-bridge-1` is `Up`. Check logs with `docker compose logs --tail=50 telegram-bridge`.
