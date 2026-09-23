---
trigger: always_on
---

# n8n Job Automation Project — Agent Development Rules

## Project Objective

Build and maintain a local, low-cost, BYOK n8n job-search automation system for Canadian jobs.

The system consists of three chained workflows:

1. Fetch → Dedup → Score
2. Generate → Humanize → QA
3. Lead-gen → Cold Email → Approval

The detailed functional specification is in:

`@docs/build-guide.md`

Treat that file as the primary project specification.

Do not silently change the architecture or requirements from the specification.

---

## Agent Operating Mode

You are the primary implementation agent for this project.

Your responsibility is to:

* inspect the existing repository before changing anything
* understand the current implementation
* create missing files and directories
* implement the requested functionality
* run tests and validation
* diagnose failures
* fix issues
* re-run validation
* keep documentation synchronized with implementation

Do not merely explain how to implement something when you can implement it directly.

When the user asks you to build something, make the code/configuration changes yourself.

---

## Development Process

For every substantial task, follow this sequence:

### 1. Inspect

First inspect:

* repository structure
* existing source files
* n8n workflow files
* configuration
* tests
* scripts
* documentation

Do not overwrite existing work without understanding it.

### 2. Plan

Before making substantial changes, briefly identify:

* files that need to be created
* files that need to be modified
* dependencies required
* tests/validation required

Avoid unnecessary architecture changes.

### 3. Implement

Implement the smallest complete solution that satisfies the requirement.

Prefer:

* simple architecture
* local execution
* BYOK APIs
* environment variables
* reusable scripts
* deterministic processing where possible
* clear error handling
* testable components

Do not introduce unnecessary frameworks or services.

### 4. Verify

After implementation:

* run relevant tests
* run linting/formatting where available
* validate JSON/YAML
* validate n8n workflow structure where possible
* execute scripts against safe test data
* verify error handling

If something fails, diagnose and fix it rather than stopping at the first error.

### 5. Report

At the end, report:

* what was implemented
* files created/modified
* tests executed
* test results
* remaining issues
* next recommended implementation step

---

# Source-of-Truth Rules

The following files are authoritative:

1. `docs/build-guide.md`
2. `master-profile.json`
3. existing project configuration
4. tests

Never invent candidate information.

The LLM must never invent:

* employers
* job titles
* skills
* certifications
* education
* achievements
* metrics
* technologies
* dates
* responsibilities

All resume and cover-letter generation must use facts available in `master-profile.json`.

If information is missing, explicitly mark it as missing rather than fabricating it.

---

# Credential and Secret Security

NEVER hardcode:

* API keys
* passwords
* access tokens
* Telegram bot tokens
* Gmail credentials
* Adzuna credentials
* Hunter credentials
* Gemini credentials

Use:

* n8n Credentials
* environment variables
* `.env` files excluded from Git

Never print secrets into logs.

Never commit secrets.

Before creating a commit, inspect changed files for accidentally exposed credentials.

---

# n8n Architecture

The project must preserve the three-stage architecture from the build guide.

## Workflow 1 — Fetch → Dedup → Score

Expected logical flow:

Schedule Trigger
→ Adzuna Fetch
→ Split Out
→ Freshness Filter
→ Read Seen Jobs
→ Dedup Filter
→ Gemini Match Score
→ Parse Score
→ Score Gate
→ Update Seen Jobs

Important behavior:

* jobs must be deduplicated
* already-seen jobs must not be rescored
* freshness filtering must occur before expensive LLM calls
* every processed job should be recorded
* only jobs meeting the configured score threshold proceed downstream

Default score gate:

`score >= 70`

Do not lower the threshold unless explicitly requested.

---

# Workflow 2 — Generate → Humanize → QA

Expected logical flow:

Gemini Generate
→ Gemini Humanize
→ Cliché Scanner
→ Cliché Gate
→ ATS Keyword Coverage
→ Resume/Document Generation

Generation must use ONLY verified candidate facts.

The humanization stage must preserve factual content.

The QA stage must detect:

* fabricated information
* excessive clichés
* missing important job-description keywords
* malformed output
* incomplete generated content

---

# Workflow 3 — Lead-gen → Cold Email → Approval

Expected logical flow:

Hunter Domain Search
→ Contact Discovery
→ Cold Email Draft
→ Human Approval
→ Send Email
→ Logging

Sending an email must NEVER happen without explicit approval.

Approval is a hard safety gate.

Rejected or edited emails must not be sent automatically.

Every outcome should be logged.

---

# LLM Rules

LLMs are used for:

* job matching
* resume tailoring
* cover-letter generation
* humanization
* email drafting

LLMs must NOT be treated as authoritative sources of candidate facts.

Whenever structured JSON is requested from an LLM:

1. validate the response
2. parse it safely
3. handle malformed responses
4. retry where appropriate
5. never blindly execute model-generated code

Prefer schema-constrained output where supported.

---

# Error Handling

External APIs can fail.

Handle:

* HTTP errors
* rate limits
* timeouts
* malformed JSON
* missing fields
* empty API responses
* authentication failures
* duplicate jobs
* unavailable services

Do not silently swallow errors.

Use retries with reasonable limits.

Avoid infinite retry loops.

Log enough information to diagnose the problem without logging secrets.

---

# Testing Requirements

Every major component should have a verification path.

At minimum test:

### Job ingestion

* valid Adzuna response
* empty response
* malformed response
* missing job ID
* duplicate job

### Freshness

* fresh job accepted
* old job rejected

### Deduplication

* unseen job accepted
* previously seen job rejected

### Scoring

* valid JSON
* malformed LLM response
* score >= 70
* score < 70

### Generation

* generated content uses only profile facts
* no fabricated employer
* no fabricated skill
* no fabricated metric

### Approval

* approved email can proceed
* rejected email cannot proceed
* edited email requires approval before sending

---

# Cost Control

Prefer inexpensive operations before expensive LLM operations.

For example:

1. fetch
2. freshness filter
3. deduplication
4. deterministic filtering
5. LLM scoring
6. score gate
7. expensive generation only for qualified jobs

Do not call an expensive model for jobs that can be eliminated earlier.

Keep the system compatible with low-volume/free-tier personal usage where practical.

---

# File Organization

Keep responsibilities separated.

Prefer:

```text
workflows/
scripts/
tests/
docs/
config/
```

Do not put large amounts of unrelated logic into a single n8n Code node when a reusable script or clear workflow component is more appropriate.

Use descriptive names.

---

# Change Management

Before modifying existing functionality:

* inspect the current implementation
* identify dependencies
* preserve working behavior
* make incremental changes

Do not rewrite the entire project simply because a smaller change would work.

If a requirement conflicts with existing code, explain the conflict and choose the least disruptive solution.

---

# Agent Autonomy

You are encouraged to perform implementation work autonomously.

If the task is sufficiently clear:

* do not ask unnecessary questions
* inspect the project
* implement the change
* test it
* fix failures
* report the result

Ask the user only when a decision genuinely cannot be inferred safely from the specification or existing project.

Never fabricate missing credentials or personal information.

---

# Definition of Done

A task is not complete merely because files were created.

A task is complete when:

* implementation exists
* configuration is valid
* tests/validation have been executed
* obvious errors have been fixed
* documentation is updated when necessary
* the final state is usable by the next development step

When possible, leave the repository in a runnable state.
