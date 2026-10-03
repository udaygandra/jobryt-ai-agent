# Clean Coding & Anti-Slop Engineering Rules

## 1. Zero AI Slop Mandate
- No hallucinated placeholders, no pseudo-code, no dummy functions.
- No redundant copy-pasting of multi-provider blocks or scraping logic across multiple files.
- No empty catch blocks swallowing errors silently (`catch (e) {}` with no logging or handling).
- Implement strictly what is required. Avoid speculative abstractions (YAGNI).

## 2. DRY & Single Source of Truth
- Centralize repeated helpers (directory discovery, HTML escaping, env parsing, path sanitization, safe JSON parsing) into `scripts/common-utils.js`.
- Always import shared utilities instead of re-implementing them in every script or inlining them into n8n code nodes.
- Maintain single sources of truth: `data/geo-hierarchy.json` for locations, `data/master-profile.json` for candidate facts, `data/settings.json` for system preferences.

## 3. Clean Code Standards
- Single Responsibility Principle (SRP): keep functions focused and concise.
- Deterministic-first architecture: deterministic filters ($0, 0 tokens) run before LLMs.
- Explicit contracts: predictable options, typed inputs, consistent return shapes.
- Proper resource cleanup: close streams and processes in finally/error handlers.
