# n8n Job Search Automation (BYOK, Local)

An automated job search engine that fetches jobs, filters duplicates, scores them against your profile using Gemini, drafts a tailored resume/PDF and cold email, and sends it only when you click "Approve" via Telegram.

## 📦 Quick Start Guide

### 1. Prerequisites
- Docker & Docker Compose
- Node.js (for local script testing if desired)

### 2. Required Accounts & API Keys (All Free)
- **Adzuna**: developer.adzuna.com/signup (`app_id` and `app_key`)
- **Google Gemini**: aistudio.google.com -> Get API Key
- **Hunter.io**: hunter.io/api-keys
- **Telegram Bot**: Message `@BotFather` on Telegram and type `/newbot` to get your Bot Token.
- **Gmail**: Turn on 2-step verification and generate a 16-character App Password.

### 3. Setup Configuration
Duplicate the example files to create your active configuration:

```bash
cp .env.example .env
cp data/master-profile.example.json data/master-profile.json
```

1. **Edit `.env`**: Fill in your Adzuna App ID and Key, and set your desired `ADZUNA_SEARCH_ROLE` (e.g. `software engineer`) and `ADZUNA_SEARCH_LOCATION` (e.g. `Toronto`).
2. **Edit `data/master-profile.json`**: Enter your actual skills, experience, and a writing sample. The AI will strictly adhere to the facts in this file.

### 4. Start the Application
Boot up the n8n container:
```bash
docker compose up -d
```
Open **[http://localhost:5678](http://localhost:5678)** in your browser.

### 5. Configure n8n Credentials
In the n8n UI, navigate to **Credentials -> Add Credential** and create the following:
1. **Gemini**: `Header Auth` -> Name: `x-goog-api-key`, Value: `your_gemini_key`
2. **Hunter**: `Header Auth` -> Name: `X-API-KEY`, Value: `your_hunter_key`
3. **Telegram API**: Paste your BotFather token.
4. **SMTP**: Host: `smtp.gmail.com`, Port: `465` (SSL), User: `your_email@gmail.com`, Password: `your_16_char_app_password`.

*(Note: Adzuna does not require a credential here, it securely pulls from your `.env` file!)*

### 6. Import Workflows
In the n8n UI, go to **Workflows -> Add Workflow**, click the `...` menu, select **Import from File**, and load the workflows in order:
1. `workflows/1-fetch-dedup-score.json`
2. `workflows/2-generate-humanize-qa.json`
3. `workflows/3-leadgen-email-approval.json`

Link your credentials to the corresponding nodes, click **Test Workflow** to ensure it runs smoothly, and toggle them to **Active**!
