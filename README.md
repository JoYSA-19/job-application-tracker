# Job Application Tracker

A Chrome Extension + Google Sheets automation that captures job applications as you browse, auto-extracts job details using AI, and tracks your application status via Gmail.

---

## Features

- **One-click save** — click the extension icon on any job posting to capture role, company, location, salary, and URL automatically
- **AI extraction** — uses Google Gemini to parse job details from the page
- **Paste mode** — for pages that embed job content in iframes (Paycor, Greenhouse, etc.), paste the text manually and still get AI extraction
- **Gmail automation** — Apps Script scans your inbox and auto-updates application status (Interviewing, Rejected, Offer, etc.)
- **Smart caching** — re-opening the popup on the same page is instant
- **Model switching** — choose between Gemini models based on your daily application volume

### Icon meanings

| Icon | Colour | Meaning |
|------|--------|---------|
| 💼 | Grey | Not a job page |
| 💼 | Blue | Job page detected — ready to save |
| ⏳ | Yellow | Extracting job info in background |
| 📋 | Orange | Embedded ATS detected — use Paste mode |
| ✅ | Green | Application saved successfully |

---

## Requirements

- Google Chrome
- A Google account (for Sheets + Apps Script + Gmail)
- A free [Google AI Studio](https://aistudio.google.com) API key (Gemini)

---

## Installation

### Step 1 — Set up Google Sheets

1. Download the TEMPLATE available in the repo.
2. Upload the template to your Google Drive.
3. (Optional) Remove existing rows if needed. Or you can do it after testing. 
   
### Step 2 — Set up Apps Script

1. In your Google Sheet: **Extensions → Apps Script**
2. Delete the default code and paste the contents of `Code.gs`
3. Go to **Project Settings → Script Properties** and add:
   - Key: `GEMINI_KEY` — Value: your Gemini API key
4. Run `testGeminiConnection` to verify the connection
5. Run `testAddApplication` to verify Sheets writing works
6. **Deploy → New Deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the Web App URL

### Step 3 — Install the Chrome Extension

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `job-application-tracker-extension` folder
5. Click the extension icon → **⚙ Settings**
6. Paste your Web App URL and choose your preferred AI model
7. Click **Save Settings**

### Step 4 — Set up Gmail automation (optional)

1. Back in Apps Script editor, click the **Triggers** icon (clock)
2. Add Trigger:
   - Function: `scanRecruitmentEmails`
   - Event source: Time-driven → Hour timer → Every 1 hour
3. Grant Gmail permissions when prompted

---

## Usage

### Saving a job application

1. Navigate to a job posting
2. The extension icon turns **blue** when a job page is detected
3. Click the icon — the form auto-fills with AI-extracted details
4. Review and edit if needed, then click **Save Application**
5. The icon turns **green** ✅ confirming the save

### Pages with embedded ATS (Paycor, Greenhouse via company sites, etc.)

1. The icon turns **orange** 📋
2. Click the icon — Paste mode opens automatically
3. Select all text on the job posting (Ctrl+A or Cmd+A in the content area)
4. Paste into the text box and click **Extract from pasted text**
5. Review and save as normal

### Re-running extraction

If extraction fails or fields are wrong, click **↺ Re-run** — it waits 2 seconds for dynamic pages to fully render before trying again.

### Switching AI models

Open **⚙ Settings** to change the model:

| Model | Daily limit | Best for |
|-------|-------------|----------|
| Gemini 3.1 Flash Lite | 500 req/day | Heavy application days (20–50 apps) |
| Gemini 2.5 Flash Lite | 20 req/day | Light days, good quality |
| Gemini 2.5 Flash | 20 req/day | Tricky pages, highest quality |

---

---

## File structure

```
job-application-tracker/
├── Code.gs                          # Google Apps Script (Sheets + Gmail + Gemini)
├── README.md
└── job-application-tracker-extension/
    ├── manifest.json                # Extension config
    ├── background.js                # Service worker (badge/icon management)
    ├── content.js                   # Page scraper + job detection
    ├── popup.html                   # Extension popup UI
    ├── popup.js                     # Popup logic
    └── icons/
        ├── icon_default_48.png
        ├── icon_job_detected_48.png
        ├── icon_prefetching_48.png
        ├── icon_iframe_48.png
        └── icon_done_48.png
```
