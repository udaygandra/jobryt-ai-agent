# JobRyt AI Agent — Scripts Architecture & Directory Guide

This directory houses the JavaScript engines, foundational utilities, Telegram bot handlers, and administrative maintenance scripts powering the JobRyt AI Agent.

To keep the architecture modular, DRY, and immediately clear to any developer, scripts are strictly organized into 4 core functional domains:

```text
scripts/
├── core/       # Shared foundations: SSOT environment loader, geo hierarchy, settings, common utilities
├── engine/     # Execution engine: multi-board ingestion, scoring heuristics, LLM bridge, ATS PDF compiler
├── bot/        # Telegram interface: long-polling bridge, onboarding FSM, document delivery
└── admin/      # Operations & DevOps: workflow optimizer, n8n SQLite sync, syntax validator, data reset
```

---

## 1. ⚙️ `scripts/core/` — Foundational Utilities & Single Source of Truth (SSOT)

These modules provide centralized, configuration-driven helpers used across all other scripts and workflows:

| Script | Purpose |
| :--- | :--- |
| **`load-env.js`** | **Single Source of Truth (SSOT) Environment Loader.** Deterministically loads the root `.env` into `process.env`. Idempotent with multi-location discovery. |
| **`common-utils.js`** | Core utilities for dynamic directory resolution (`/data`), safe JSON reading/writing, and HTML escaping for Telegram messages. |
| **`settings-helper.js`** | Manages runtime candidate preferences (`data/config/settings.json`) including freshness age, score thresholds, enabled boards, and cron rules. |
| **`geo-helper.js`** | Universal location resolution using `data/config/geo-hierarchy.json`. Enforces country-scope routing (`CA`, `US`, `GLOBAL`) with zero hardcoded geography. |
| **`profile-validator.js`** | Validates `data/profiles/master-profile.json` structure, target roles, and locations before pipeline execution. |
| **`prompt-loader.js`** | Safely reads markdown prompt templates from `prompts/` with variable substitution and built-in fallbacks. |

---

## 2. 🚀 `scripts/engine/` — Pipeline Orchestration & AI Tailoring Engine

The core execution engine that finds, scores, tailors, and compiles job applications:

| Script | Purpose |
| :--- | :--- |
| **`fetch-all-boards.js`** | High-speed multi-board fetcher. Ingests in parallel from LinkedIn, Adzuna API, Canada Job Bank, USAJOBS, Remotive, and Jobicy ($0 cost, 0 LLM tokens). |
| **`node-logic.js`** | Pure deterministic business logic: freshness checking, composite deduplication (ID + URL + content hash), mathematical scoring weights (`0.40/0.35/0.15/0.10`), hard title cap ($<50 \implies \le 45$), hard blockers, and multiset metric integrity checks. |
| **`llm-provider.js`** | Unified multi-model LLM client with 10-model waterfall rate-limit fallback (Gemini, Ollama, etc.) and prompt builders. |
| **`llm-state-manager.js`** | State tracker managing RPM / RPD quotas, minute rollovers, and automatic model switching across the 10-model waterfall. |
| **`resume-to-profile.js`** | AI-assisted resume parser converting PDF/DOCX/TXT into `data/profiles/master-profile.json`. Normalizes text, strips artifacts, and computes deterministic years of experience. |
| **`generate-resume-pdf.js`** | High-precision ATS PDF generator using `pdfkit`. Generates clean, multi-page, executive resumes preserving full career depth and all verified metrics. |
| **`run-pipeline.js`** | CLI pipeline runner. Orchestrates end-to-end ingestion, filtering, scoring, logging, and Telegram card delivery. |
| **`multi-board-ingestion-code.js`**| Self-contained script embedded into the n8n **Multi-Board Ingestion** code node. |

---

## 3. 💬 `scripts/bot/` — Telegram Cockpit & Interactive Bridge

Manages interactive candidate communication, on-demand commands, and real-time document delivery:

| Script | Purpose |
| :--- | :--- |
| **`telegram-bridge.js`** | Long-polling Telegram bridge daemon. Runs 24/7 inside its own Docker container; handles inline button callbacks (`Apply`, `Reject`, `Cover Letter`, `Settings`) and forwards webhook payloads to n8n without requiring public inbound ports. |
| **`onboarding-handler.js`** | Finite state machine guiding new candidates through interactive resume onboarding, location selection, and work preference setup. |
| **`send-telegram-doc.js`** | Multipart HTTP client delivering compiled ATS PDF resumes and cover letters directly into the user's Telegram chat. |
| **`import-resume-telegram.js`** | Handles candidate resume files uploaded via Telegram chat and initiates the extraction pipeline. |
| **`start-bot.js`** | Master CLI launcher (`npm start`). Verifies environment variables, provisions data folders, and starts services. |

---

## 4. 🛠️ `scripts/admin/` — Operations, Sync & Maintenance

DevOps and administrative scripts for keeping n8n in sync with disk code:

| Script | Purpose |
| :--- | :--- |
| **`setup-wizard.js`** | Interactive 60-second configuration wizard (`npm run setup`). Guides users through environment setup. |
| **`optimize-master-workflow.js`** | Workflow compiler (`npm run republish`). Reads pure JavaScript modules and updates `workflows/master-workflow.json`. |
| **`sync-n8n-db.js`** | Synchronizes workflow JSON files directly into n8n's SQLite database (`/home/node/.n8n/database.sqlite`). |
| **`validate-workflows.js`** | Verifies 100% valid JavaScript syntax across all n8n Code nodes in both workflows using `AsyncFunction`. |
| **`reset-data.js`** | Soft-reset script (`npm run reset`). Clears tracking tables while preserving candidate profile and settings. |
| **`security-audit.js`** | Security scanner (`npm run audit:security`). Checks for exposed API keys, filesystem traversal risks, and network bindings. |
| **`export-applied-jobs.js`** | Exports logged job applications into formatted multi-tab Excel spreadsheets. |

