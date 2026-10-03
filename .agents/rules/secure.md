# Secure Coding Practices & Threat Mitigation Rules

## 1. Zero Hardcoded Secrets
- Never hardcode API keys, bot tokens, or credentials in any file.
- Access secrets exclusively via environment variables.
- Redact secrets from log outputs and Telegram messages.

## 2. Injection & XSS Prevention
- Command execution: NEVER use string concatenation with shell `exec()`. ALWAYS use `execFileSync` or `execFile` with array arguments.
- HTML interpolation: ALWAYS escape text interpolated into Telegram HTML messages using `escapeHtml()`.
- No dynamic code execution (`eval()` or `new Function()`).

## 3. Filesystem Boundaries & Path Traversal
- Sanitize candidate names, company names, and IDs before using them in file paths (PDFs, export files, logs).
- Always verify paths stay within authorized project directories (`data/`, `artifacts/`).
- Prevent path traversal sequences (`../`, `..\\`).

## 4. Input & Schema Validation
- Safe JSON deserialization with prototype pollution protection.
- Enforce HTTP request timeouts (15s–60s) and buffer size caps to prevent DoS.

## 5. Factual Fidelity & Safety Gates
- 100% factual fidelity: resumes, cover letters, and communications must only use facts present in `master-profile.json`. Never hallucinate metrics, dates, or employers.
- Human-in-the-loop: external applications or emails must require explicit user approval.
