# JobRyt AI Agent — Test Harness & Verification Suite

This directory contains automated unit, integration, and logic regression test suites. Every pull request or major workflow change should pass all tests.

---

## Running Tests

```bash
# Run all tests (Comprehensive Suite)
npm run test:all

# Run fast onboarding and rate-limit regression tests
npm test

# Validate syntax across all workflow code nodes
npm run validate
```

---

## Test Suites Overview

### 1. `tests/test-all-nodes.js` — Master Workflow Verification
Tests each logical node and gate in `workflows/master-workflow.json`:
1. **Profile Formatter**: Verifies candidate profile formatting and skill extraction.
2. **Ingestion Normalization**: Tests standardizing raw job objects.
3. **Freshness Filter**: Ensures jobs older than `max_age_days` are dropped while fresh jobs pass.
4. **Dedup Filter**: Tests rejection of previously seen job IDs, URLs, and content hashes.
5. **Scoring Heuristics**: Tests CPU fallback scoring when LLM is offline.
6. **Score Gate**: Validates passing threshold ($Score \ge 70$) and rejection below threshold.
7. **Dynamic Prompt Builders**: Ensures XML bounding tags (`<job_posting>`, `<candidate>`, `<profile>`) are present.
8. **Deterministic Code Node Scoring & Metric Guard**:
   - Tests arithmetic weights ($0.40/0.35/0.15/0.10$).
   - Tests hard title cap ($<50 \implies \le 45$ and `should_apply = false`).
   - Tests hard blockers in `disqualification_reasons`.
   - Tests multiset numeric token verification against prompt tampering.
9. **LLM Waterfall State Manager**: Tests initial model selection and rate-limit detection.
10. **PDF Generator Engine**: Tests compilation of valid binary PDF buffers.

---

### 2. `tests/test-telegram-onboarding.js` — Bot Onboarding & Geography
Tests the interactive Telegram onboarding state machine:
- **Geographic Hierarchy Extraction**: Validates options generated from `data/config/geo-hierarchy.json`.
- **Country Scope Routing**: Enforces strict destination boundaries (CA candidates never receive US-only jobs; US candidates never receive Canada Job Bank jobs).
- **Role Generation & Experience Heuristics**: Validates title variants across career stages.
- **Workplace Harmonization**: Validates Remote / Hybrid / Onsite preference mapping.
- **State Machine Transitions**: Verifies candidate progression from step 1 to completion.
- **LinkedIn Model Ingestion Filter Compatibility**: Tests live compatibility against Models A, B, and C.

---

### 3. `tests/test-llm-state.js` — 10-Model Waterfall & Quota Tracker
Tests LLM resilience and rate-limit handling:
- **Waterfall Configuration**: Verifies 10 models in priority order.
- **Per-Minute Rollover (RPM)**: Simulates hitting 5 RPM and rolling over to the next model.
- **Daily Quota Exhaustion (RPD)**: Simulates HTTP 429 and rolls over to the next tier.
- **404 Blacklisting**: Simulates deprecated model endpoints and permanent blacklisting.
