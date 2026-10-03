---
name: secure
description: Secure coding practices, credential protection, injection prevention, filesystem boundaries, and factual privacy defense.
---

# Secure Coding Practices & Threat Mitigation Standard

## Core Philosophy
Security is an architectural foundation, not an afterthought. In a system handling candidate credentials, private career records, external API tokens, automated bot triggers, and file generation, every input is untrusted and every external interaction must be hardened.

---

## 1. Credential & Secret Management
- **Zero Hardcoded Secrets:** Never hardcode API keys, passwords, bearer tokens, Telegram bot tokens, database credentials, or private webhook URLs in source code, workflows, or git histories.
- **Environment & Secret Stores:** Access secrets exclusively via `process.env`, `.env` files (strictly ignored by `.gitignore`), or n8n encrypted credential stores.
- **Leak Prevention in Logs & Errors:**
  - Never dump entire request configs containing `Authorization` or `x-api-key` headers into log files or Telegram messages.
  - Redact tokens before printing URLs (e.g., query params like `?token=...` or `?key=...`).
- **Secret Hygiene Verification:** Run regular audits (e.g., `scripts/security-audit.js`) to guarantee no credential patterns exist in tracked files.

---

## 2. Injection Prevention (Command, Code & Markup)
- **Command Injection:**
  - NEVER execute shell strings via `child_process.exec()` with concatenated user input or unvalidated variables.
  - ALWAYS use `child_process.execFile()` or `child_process.execFileSync()` with parameterized argument arrays (`[scriptPath, arg1, arg2]`).
- **HTML / Markdown / XSS Injection:**
  - Any variable interpolated into Telegram HTML messages (`<b>${title}</b>`) must be escaped via `escapeHtml()` (`&`, `<`, `>`, `"`, `'`).
  - Telegram MarkdownV2 requires escaping of markdown control characters to avoid message failure or spoofing.
- **No `eval()` or Dynamic Code Execution:** Never evaluate untrusted strings using `eval()` or `new Function()`.

---

## 3. Filesystem & Path Traversal Defense
- **Path Traversal Mitigation:**
  - Never construct file paths using raw user input without validation.
  - Use `path.resolve()` / `path.normalize()` and verify the target path resides strictly inside authorized base directories (`data/`, `artifacts/`, temp dirs).
  - Strip directory traversal sequences (`../`, `..\\`) and illegal characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) when creating files (such as candidate resumes or logs):
    ```javascript
    const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
    ```
- **Safe File Deserialization:**
  - Always wrap `JSON.parse()` in safe boundary handlers. Reject prototype pollution payloads (e.g., keys named `__proto__`, `constructor`, `prototype`).
  - Use atomic file writes or proper exception boundaries when updating JSON state databases (`settings.json`, `pending_approval.json`, `seen_jobs.json`).

---

## 4. Network, API & Rate-Limiting Defenses
- **Strict Request Timeouts:** Every HTTP request must have an explicit timeout (e.g. 15,000ms–60,000ms) to prevent Denial of Service (DoS) from unresponsive external endpoints.
- **Exponential Backoff & Rate-Limit Handling:** Honor HTTP 429 status codes and Retry-After headers. Implement pacing delays (e.g., 300ms–500ms) between batch calls to external job boards or LLM APIs.
- **Payload Size Guards:** Enforce buffer size limits (`maxBuffer` on child processes, content-length checks on downloads) to prevent memory exhaustion attacks.

---

## 5. Candidate Data Privacy & Factual Fidelity
- **Zero Fabrication:** Generated resumes, cover letters, and email outreach must strictly derive from verified facts in `data/master-profile.json`. Never invent employers, dates, metrics, degrees, or certifications.
- **Human-in-the-Loop Gate:** Sending cold emails or submitting external applications must NEVER occur automatically without explicit, interactive human confirmation.
