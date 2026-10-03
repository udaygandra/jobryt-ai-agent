---
name: coding
description: Senior Software Engineer clean coding standard, DRY principles, removal of AI slop, modular architecture, and deterministic design.
---

# Senior Software Engineering & Clean Code Standard

## Core Philosophy
We write maintainable, production-ready, performant software. Every line of code must have purpose. We eliminate redundancy, avoid over-engineering, and enforce zero-tolerance for AI slop.

---

## 1. Zero AI Slop Mandate
- **No Hallucinated Placeholders:** Never commit code with `// TODO: add other boards here`, pseudo-code, or non-functional stubs unless explicitly requested as a design interface.
- **No Defensive Absurdity:** Do not stack 10 nested empty `try/catch` blocks that swallow errors silently. Catch specific errors where they can be recovered from, or log with contextual metadata.
- **No Redundant Bloat:** Do not generate repetitive 50-line `if/else` ladders or copy-pasted provider handlers. Use lookup tables, declarative mappings, and composition.
- **Surgical Precision:** Implement currently what is required by the specification. Avoid speculative abstractions (YAGNI — You Aren't Gonna Need It).

---

## 2. DRY (Don't Repeat Yourself) & Single Source of Truth (SSOT)
- **Centralize Shared Utilities:** Common functionality (data directory resolution, environment variable access, HTML sanitization, string manipulation, file path normalization, safe JSON parsing) belongs in shared utility modules (e.g., `scripts/common-utils.js`), never duplicated across scripts or workflow nodes.
- **Unified Domain Logic:** Geographies and hierarchical parsing come strictly from `data/geo-hierarchy.json` via `scripts/geo-helper.js`. Candidate profile data comes strictly from `data/master-profile.json`. System settings come from `data/settings.json`.
- **No Forked Script Clones:** Do not maintain parallel identical codebases (e.g., inlining 500 lines of scraping logic into an n8n node string when a central script can be executed).

---

## 2b. Strict Single Source of Truth for Environment Variables (SSOT)
- **One Authoritative File:** The project root `.env` is the single source of truth for all runtime configuration.
- **Zero Fragmented .env Copies:** Never create, maintain, or sync parallel `.env` copies across directories (`data/.env`, `scripts/.env`, etc.). In containerized setups (e.g. Docker / n8n), pass configuration via docker-compose `env_file` or a single read-only volume bind mount (`- ./.env:/data/.env:ro`), guaranteeing zero file divergence.
- **Single Canonical Loader (`scripts/load-env.js`):** All scripts requiring environment configuration must call `require('./load-env').loadEnv()` once at startup.
- **Zero Ad-Hoc Parsers:** Never write inline `fs.readFileSync('.env').split('\n')` blocks in feature scripts or test harnesses.
- **Idempotent & Deterministic:** The loader must check if variables are already populated, locate the canonical file via a deterministic path hierarchy, load values once, and avoid redundant disk reads.
- **Explanatory Block Documentation:** Every script that reads environment variables must have clear block comments explaining what each variable configures, its source, and safe default behavior.

---

## 3. Clean Code & Architecture Standards
- **Single Responsibility Principle (SRP):** Each function, module, and workflow node should do one thing well.
- **Deterministic First, AI Second:** Heavy deterministic pre-filtering (freshness, deduplication, title alignment, keyword matching) must execute before expensive or non-deterministic LLM calls ($0 cost, 0 tokens spent on unqualified jobs).
- **Explicit Contracts & Interfaces:** Functions should accept well-defined options objects or typed arguments, and return predictable data structures.
- **Clean Naming:**
  - Functions: verb-first descriptive names (`fetchAdzunaJobs`, `calculateMatchScore`, `sanitizeFilename`).
  - Booleans: prefixed with `is`, `has`, `should` (`shouldApply`, `isRemote`, `hasPhysicalLocation`).
  - Constants: `UPPER_SNAKE_CASE` for immutable static configs.

---

## 4. Robust Error Handling & Observability
- **Informative Failure Modes:** Log meaningful diagnostic messages with source, operation name, and underlying error message.
- **No Silent Failures:** If an API or file write fails, report it cleanly to the caller or fallback gracefully with a documented fallback path.
- **Resource Cleanup:** Streams, child processes, and temporary file descriptors must be closed/terminated properly, including in error handlers.
- **Resilient Timeouts:** All external HTTP requests and child processes must have explicit timeouts (e.g., 30s-120s maxBuffer limits) to prevent process hangs.

---

## 5. Testing & Verification Checklist
Before declaring any implementation complete:
1. **Lint/Syntax Check:** Ensure all JavaScript files parse without syntax errors (`node -c <file>`).
2. **Deterministic Logic Tests:** Verify pure functions and filtering rules against boundary conditions (null, empty strings, mismatched types).
3. **End-to-End Pipeline Check:** Validate against live or mock data to ensure downstream consumers (n8n, Telegram, PDF generators) receive expected schema fields.
