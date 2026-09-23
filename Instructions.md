# N8N Job Search Automation — Full Build Guide (Canada, BYOK, Local, Low-Cost)

This guide builds three chained n8n workflows:
1. **Fetch → Dedup → Score** (runs every 15–30 min, finds and scores fresh Canadian jobs)
2. **Generate → Humanize → QA** (tailors resume/cover letter for jobs that pass the score gate)
3. **Lead-gen → Cold Email → Approval** (finds a contact, drafts outreach, waits for your go-ahead)

Build and test each one independently before chaining them together.

---

## Step 0 — Install n8n locally (5 min)

**Option A — fastest (good for today):**
```bash
npx n8n
```
Opens at `http://localhost:5678`. Data is stored in SQLite under `~/.n8n`.

**Option B — Docker (better for something you'll keep running):**
```yaml
# docker-compose.yml
services:
  n8n:
    image: n8nio/n8n
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      - GENERIC_TIMEZONE=America/Toronto
      - N8N_DEFAULT_BINARY_DATA_MODE=filesystem
    volumes:
      - n8n_data:/home/node/.n8n
volumes:
  n8n_data:
```
```bash
docker compose up -d
```
Open `http://localhost:5678`, create your owner account (stays local, no cloud signup).

---

## Step 1 — Get your free API keys

| Service | Where | Cost | Used for |
|---|---|---|---|
| Gemini API key | aistudio.google.com → "Get API key" | Free tier | Scoring, generation, humanizing |
| Adzuna `app_id` + `app_key` | developer.adzuna.com/signup | Free | Job fetching |
| Hunter.io API key | hunter.io/users/sign_up | Free (25 searches/mo) | Finding contact emails |
| Telegram bot token | Message `@BotFather` → `/newbot` | Free | Approve/reject notifications |
| Gmail App Password | myaccount.google.com/apppasswords | Free | Sending the actual email |

In n8n: **Settings → Credentials → Add Credential** for each one (HTTP Header Auth for Gemini/Adzuna/Hunter, Telegram API, Gmail/SMTP). Never paste keys directly into node parameters — always use the Credentials panel so they don't end up in exported JSON.

---

## Step 2 — Build your Master Profile (once, outside n8n)

Create `master-profile.json` on disk (e.g. `~/n8n-job-bot/master-profile.json`):
```json
{
  "name": "Your Name",
  "target_titles": ["Data Analyst", "Business Intelligence Analyst"],
  "locations": ["Toronto, ON", "Remote Canada"],
  "skills": ["SQL", "Power BI", "Python/pandas", "PowerShell", "GCP"],
  "experience": [
    {
      "role": "Data Analyst",
      "company": "...",
      "dates": "2023–present",
      "bullets": [
        "Real achievement with a real metric",
        "Another real achievement with a real metric"
      ]
    }
  ],
  "writing_sample": "Paste one real email or message you've written, so the humanize step can match your voice."
}
```
This is the single source of truth. Every prompt downstream references it — the LLM never invents facts not in this file.

---

## Workflow 1 — Fetch → Dedup → Score

**Node-by-node:**

1. **Schedule Trigger**
   - Interval: every 20 minutes.

2. **HTTP Request** — `Adzuna Fetch`
   - Method: GET
   - URL: `https://api.adzuna.com/v1/api/jobs/ca/search/1`
   - Query params: `app_id`, `app_key` (from credential), `what=data analyst`, `where=Toronto`, `sort_by=date`, `max_days_old=1`
   - This returns a `results` array with `created`, `title`, `company`, `redirect_url`, `description`, `id`.

3. **Split Out**
   - Field to split out: `results`
   - Now each item downstream = one job.

4. **Code node** — `Freshness Filter`
   ```javascript
   const now = DateTime.now();
   return items.filter(item => {
     const posted = DateTime.fromISO(item.json.created);
     return now.diff(posted, 'hours').hours < 2;   // change threshold here
   });
   ```

5. **Read/Write Files from Disk** — `Read Seen Jobs`
   - Operation: Read
   - File path: `~/n8n-job-bot/seen_jobs.json` (a simple `["id1","id2",...]` array; create it empty the first time: `echo "[]" > seen_jobs.json`)

6. **Code node** — `Dedup Filter`
   ```javascript
   const seen = JSON.parse($('Read Seen Jobs').first().binary.data.toString());
   return items.filter(item => !seen.includes(item.json.id));
   ```

7. **HTTP Request** — `Gemini Match Score`
   - Method: POST
   - URL: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
   - Header: `x-goog-api-key` (from credential)
   - Body (JSON):
     ```json
     {
       "contents": [{
         "parts": [{
           "text": "Score this job 0-100 against this candidate profile. Profile: {{ $json.masterProfile }}. Job title: {{ $json.title }}. Job description: {{ $json.description }}. Respond ONLY with JSON: {\"score\": number, \"missing_skills\": [string], \"reasoning\": string}"
         }]
       }]
     }
     ```

8. **Code node** — `Parse Score`
   - Extract the JSON text from Gemini's response and turn it into real fields (`score`, `missing_skills`, `reasoning`) on the item.

9. **IF node** — `Score Gate`
   - Condition: `{{$json.score}} >= 90`
   - **True branch** → continue to Workflow 2 (see below).
   - **False branch** → append to a `logged_jobs.json` file for your own records, then stop.

10. **Read/Write Files from Disk** — `Update Seen Jobs`
    - Operation: Write
    - Append this job's `id` to `seen_jobs.json` (do this for *every* job that passes step 6, regardless of score, so you never re-score it).

**Test it now**: run the workflow manually once, confirm you get real Adzuna results, confirm dedup correctly skips a job on the second run, confirm the Gemini call returns a parseable score. Get this rock-solid before building anything downstream.

---

## Workflow 2 — Generate → Humanize → QA

Trigger this from Workflow 1's true branch (use an **Execute Workflow** node, or just continue in the same workflow — simpler while you're building).

1. **HTTP Request** — `Gemini Generate` (model: `gemini-2.5-pro`)
   - Prompt: *"Using ONLY the facts in this profile: {{ masterProfile }}. Do not invent skills, employers, or metrics that are not present. Write: (1) three tailored resume bullets for the 'most relevant role' emphasizing overlap with this job description: {{ description }}. (2) a cover letter, 250 words, specific to this company and role. Return JSON: {resume_bullets: [...], cover_letter: string}"*

2. **HTTP Request** — `Gemini Humanize` (model: `gemini-2.5-flash`)
   - Prompt: *"Rewrite the following text so it matches the voice, rhythm and phrasing patterns of this writing sample: {{ writing_sample }}. Vary sentence length naturally. Text to rewrite: {{ draft }}"*

3. **Code node** — `Cliché Scanner`
   ```javascript
   const clicheRegex = /\b(delve|moreover|furthermore|leverage|seamless|testament to|unlock|robust|tapestry|elevate|boast)\b/gi;
   const hits = (text.match(clicheRegex) || []).length;
   return [{ json: { ...item.json, cliche_hits: hits, needs_rewrite: hits > 2 } }];
   ```

4. **IF node** — `Cliché Gate`
   - `needs_rewrite == true` → loop back to step 2 with feedback ("avoid these words: ...").
   - Else → continue.

5. **Code node** — `ATS Keyword Coverage`
   ```javascript
   const jdKeywords = extractKeywords(jobDescription); // simple split + stopword removal, or a prior Gemini call
   const resumeText = resumeBullets.join(' ').toLowerCase();
   const covered = jdKeywords.filter(k => resumeText.includes(k.toLowerCase()));
   return [{ json: { ...item.json, ats_coverage_pct: Math.round(100 * covered.length / jdKeywords.length) } }];
   ```

6. **HTML node + Convert to PDF** (or `.docx` via a template)
   - Simplest self-hosted route: build an HTML resume template with placeholders, fill it with a Code node (string templating), then use an HTML-to-PDF conversion — either a community node or a small headless-Chrome call via `Execute Command` (`node your-html-to-pdf-script.js`) if you enable `NODE_FUNCTION_ALLOW_EXTERNAL` for self-hosted n8n.

---

## Workflow 3 — Lead-gen → Cold Email → Approval

1. **HTTP Request** — `Hunter Domain Search`
   - URL: `https://api.hunter.io/v2/domain-search?domain={{companyDomain}}&api_key=...`
   - Returns likely email pattern + sometimes named contacts.

2. **HTTP Request** — `Gemini Cold Email Draft`
   - Prompt referencing the tailored resume summary + company name + contact name if found.

3. **Telegram node** — `Send for Approval`
   - Message includes job title, company, match %, ATS coverage %, and the drafted email text.
   - Use Telegram's inline keyboard buttons: "Approve" / "Edit" / "Reject" (each button carries a callback_data value).

4. **Webhook node** — `Telegram Callback Listener`
   - Catches the button press. Route with an **IF/Switch** node on the callback value.

5. **Gmail/Send Email node** — fires only on "Approve".

6. **Google Sheets "Append Row"** — log everything regardless of outcome: job title, company, match %, ATS %, cliché hits, approval status, timestamp. This becomes your dashboard.

---

## Step 3 — Deploy for 24/7 (once Workflows 1–3 work locally)

1. Spin up an **Oracle Cloud Always Free** VM (Ampere/ARM, 2 core/12GB tier).
2. Install Docker on it, copy your `docker-compose.yml` and the `.n8n` data volume (or start fresh and re-enter credentials).
3. Open port 5678 (or put it behind a reverse proxy with HTTPS if you want the Telegram webhook to work reliably — Telegram requires HTTPS for webhooks, so either use n8n's built-in tunnel for testing or set up Caddy/Nginx with a free Let's Encrypt cert for production).
4. `docker compose up -d`, re-activate your workflows (n8n workflows are paused by default after import — toggle "Active").

---

## Testing checklist before you trust it unattended

- [ ] Workflow 1 runs on schedule and produces at least one real job on a broad keyword search
- [ ] Dedup correctly skips an already-seen job on the second run
- [ ] The freshness filter correctly excludes a job older than 2 hours (test by temporarily loosening the threshold to see raw results, then tightening back)
- [ ] Gemini scoring returns valid, parseable JSON every time (add a fallback/retry for malformed responses)
- [ ] The score gate only lets ≥90 jobs through
- [ ] Generation never introduces a skill/employer not in your master profile (spot-check a few outputs manually)
- [ ] Cliché scanner correctly flags an intentionally bad AI-sounding draft
- [ ] Telegram approval buttons actually gate the send (test rejecting one)
- [ ] Nothing sends without your approval

---

## Notes on cost

Running every 15–20 minutes, all day, against Gemini's free tier (Flash for scoring/humanizing, Pro for generation on only the jobs that pass the gate) should stay at **$0/month** in normal personal-use volume. Adzuna and Hunter's free tiers cover the rest. The only real cost is your own time building and, if you want true 24/7 uptime, the Oracle VM — which is also free.