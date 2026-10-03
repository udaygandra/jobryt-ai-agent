# N8N Job Search Automation — Architecture & Build Guide

This project is a localized, low-cost (BYOK), highly modular AI job-search automation system for Canadian and US roles. It fetches jobs from multiple boards, deterministically filters them, uses LLMs to score them against your resume, and auto-generates perfectly tailored ATS-compliant PDF resumes.

---

## 🏗️ Current System Architecture (What is Built)

The system has evolved from a simple n8n JSON file into a robust, script-driven automation engine separated into logical subfolders.

### 1. Data Layer (`data/`)
*   **`config/`**: Contains the canonical `.env` for infrastructure secrets, `settings.json` for dynamic user preferences (toggles, scoring thresholds), and `geo-hierarchy.json` for mapping target locations.
*   **`profiles/`**: Holds `master-profile.json` (the exact facts of your career, strictly enforced to prevent AI hallucinations).
*   **`tracking/`**: Maintains JSON arrays (`seen_jobs.json`, `pending_approval.json`, `logged_jobs.json`) to guarantee 100% deduplication across runs.
*   **`uploads/` & `templates/`**: Storage for PDF/DOCX templates and candidate resume inputs.

### 2. Node.js Engine (`scripts/`)
Instead of burying massive logic blocks inside n8n Code Nodes, everything is modular:
*   **`core/`**: Shared utilities like `load-env.js` (a single-source-of-truth loader for the root `.env`) and `geo-helper.js`.
*   **`engine/`**: The brain of the operation. Contains `fetch-all-boards.js` for multi-source scraping (Adzuna, JobBank, etc.), `node-logic.js` for fast CPU-based dedup/freshness filtering, `llm-provider.js` for routing scoring prompts to Gemini/OpenAI/Anthropic, and `generate-resume-pdf.js` for converting JSON to perfectly formatted ATS PDFs using `pdfkit`.
*   **`bot/`**: A long-polling `telegram-bridge.js` daemon running in its own container. It allows interactive onboarding (uploading a resume to parse into `master-profile.json`) and inline-button setting controls without needing a web domain or webhooks.
*   **`admin/`**: Utilities like `optimize-master-workflow.js`, which takes the pure JavaScript from the `scripts/` directory and safely injects it into the n8n `master-workflow.json` database.

### 3. n8n Master Workflow (Stages 1 & 2 Completed)
Currently, `workflows/master-workflow.json` seamlessly executes:
1.  **Fetch**: Pulls from enabled boards based on `settings.json`.
2.  **Filter**: Runs deterministic freshness and dedup filters via injected Node.js scripts to save API tokens.
3.  **Score**: Prompts the preferred LLM to rate the job against `master-profile.json` and gate it (e.g., Score > 80).
4.  **Tailor**: Generates a zero-fabrication resume and cover letter mapping to the ATS keywords.
5.  **Deliver**: Generates the PDF and dispatches it directly to the user via Telegram.

---

## 🚀 What is Required to Finish the App (Stage 3 & Enhancements)

While ingestion, scoring, and PDF generation are fully operational, the final "Lead-Gen & Application" loop needs to be completed.

### 1. Workflow 3: Lead-Gen & Automated Outreach
*   **Hunter.io Integration**: Add nodes to take the `companyDomain` from qualified jobs and query the Hunter.io API to find the name and email of the hiring manager or department head.
*   **Cold Email Drafting**: A specific LLM step to draft a 150-word outreach email referencing the candidate's tailored summary, the company name, and the specific open role.
*   **Telegram Approval Gate**: Before sending, the bot must send an `[Approve]` or `[Reject]` button via Telegram. The email must **never** be sent automatically without human interaction.
*   **SMTP Dispatch**: Implement the n8n Gmail/SMTP node to actually dispatch the approved email payload and update `logged_jobs.json`.

### 2. Analytics & Reporting
*   **Daily Recap**: Build a scheduled script (perhaps via cron in the `bot/` directory) to read `tracking/logged_jobs.json` and `tracking/rejected_jobs.json` and send a daily summary to Telegram: "Analyzed 400 jobs, 12 passed the gate, 3 applications sent."
*   **Dashboard Generation**: Expand `export-applied-jobs.js` to automatically generate Excel/CSV files and deliver them weekly to track application volume.

### 3. True Auto-Apply Modules (Optional)
*   For jobs that do not accept cold emails and require portal submissions (like Workday or Greenhouse), the project can utilize a local browser automation script (e.g. Playwright/Puppeteer) triggered by n8n to navigate the form using the `master-profile.json` data. Currently, the bot provides the user with the direct `apply_url`.

---

## 🛠️ Deployment Instructions

1. Ensure the `.env` file exists at the **root** of the repository (`jobryt-ai-agent/.env`).
2. Run `npm install` inside the project to install `pdfkit`, `telegraf`, etc.
3. Use the provided Docker configuration to spin up the architecture:
   ```bash
   docker compose up -d
   ```
4. This will boot both the **n8n orchestration container** and the **Telegram bot daemon**. 
5. To update n8n workflow logic after modifying any `.js` file in `scripts/`, run:
   ```bash
   node scripts/admin/optimize-master-workflow.js
   ```