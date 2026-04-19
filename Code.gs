// ============================================================
//  JOB APPLICATION TRACKER — Apps Script Foundation
//  File: Code.gs
// ============================================================

const SHEET_NAME             = 'Applications';
const LOG_SHEET_NAME         = 'Email_Log';
const GEMINI_MODEL           = 'gemini-3.1-flash-lite-preview'; // Used for email parsing (high quota)
const EXTRACTION_MODEL       = 'gemini-2.5-flash-lite'; // Fallback if no model sent by Extension

// Supported models for job extraction tasks.
// Switch via Extension Settings depending on how many apps you're submitting today.
const SUPPORTED_MODELS = {
  'gemini-3.1-flash-lite-preview': '⭐ Gemini 3.1 Flash Lite — 500 RPD, heavy days (20-50 apps)',
  'gemini-2.5-flash-lite':         'Gemini 2.5 Flash Lite  — 20 RPD, light days',
  'gemini-2.5-flash':              'Gemini 2.5 Flash        — 20 RPD, best quality for tricky pages',
};
const AUTO_UPDATE_THRESHOLD  = 0.80;

const STATUS = {
  APPLIED:            'Applied',
  PHONE_SCREEN:       'Phone Screen',
  INTERVIEW:          'Interviewing',
  UPCOMING_INTERVIEW: 'Upcoming Interview',
  OFFER:              'Offer',
  ACCEPTED:           'Accepted',
  REJECTED:           'Rejected',
  DECLINED:           'Declined',
  GHOSTED:            'Ghosted',
  WITHDRAWN:          'Withdrawn',
};

// ── Rule-based email signals (checked BEFORE calling Gemini) ──
// If subject/body matches → status assigned instantly, no AI call.
const EMAIL_RULES = [
  // Rejection MUST come before Applied — rejection emails often start with "thank you for applying"
  { patterns: ['unfortunately', 'we will not be moving forward', 'we have decided not to move forward',
               'not selected', 'decided to move forward with other', 'other qualified candidates',
               'position has been filled', 'not be proceeding', 'decided not to proceed'], status: STATUS.REJECTED },
  { patterns: ['pleased to offer', 'offer of employment', 'formal offer', 'we are pleased to extend'], status: STATUS.OFFER },
  { patterns: ['schedule an interview', 'invite you to interview', 'interview invitation', 'like to invite you for', 'like to schedule'], status: STATUS.UPCOMING_INTERVIEW },
  { patterns: ['phone screen', 'introductory call', 'recruiter screen', 'quick call'], status: STATUS.PHONE_SCREEN },
  // Applied confirmation — only if NO rejection signals present (checked last)
  { patterns: ['we received your application', 'application received', 'successfully submitted', 'application has been received'], status: STATUS.APPLIED },
];


// ─── SHEET HELPERS ───────────────────────────────────────────

function getAppSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found.`);
  return sheet;
}

function getLogSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${LOG_SHEET_NAME}" not found.`);
  return sheet;
}

function getAllApplications() {
  const sheet   = getAppSheet();
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).map((row, i) => {
    const obj = {};
    headers.forEach((h, j) => obj[h] = row[j]);
    obj._rowIndex = i + 2;
    return obj;
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addApplication(data) {
  const sheet = getAppSheet();
  const id    = generateId();
  const now   = new Date();
  // A=id B=date_applied C=role D=company E=job_type F=location
  // G=salary H=application_url I=status J=status_updated_at K=interview_date L=notes M=source
  const urlFormula = data.application_url
    ? `=HYPERLINK("${data.application_url}","Open")`
    : '';

  sheet.appendRow([
    id, now,
    data.role || '', data.company || '', data.job_type || '',
    data.location || '', data.salary || '', urlFormula,
    STATUS.APPLIED, now, '', data.notes || '', data.source || '',
  ]);
  Logger.log(`Added: ${id} — ${data.role} @ ${data.company}`);
  return id;
}

function updateStatus(rowIndex, newStatus, interviewDate) {
  const sheet = getAppSheet();
  sheet.getRange(rowIndex, 9).setValue(newStatus);
  sheet.getRange(rowIndex, 10).setValue(new Date());
  if (interviewDate) sheet.getRange(rowIndex, 11).setValue(new Date(interviewDate));
  Logger.log(`Row ${rowIndex} → "${newStatus}"`);
}

function logEmailAction(subject, from, matchedCompany, detectedStatus, confidence, actionTaken) {
  getLogSheet().appendRow([new Date(), subject, from, matchedCompany || '(no match)', detectedStatus || '(unknown)', confidence || 0, actionTaken || '']);
}


// ─── GEMINI HELPER ───────────────────────────────────────────

function callGemini(prompt, modelOverride) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('GEMINI_KEY not set in Script Properties.');

  const model   = modelOverride || GEMINI_MODEL;
  const url     = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature:      0.1,
      maxOutputTokens:  2048,
    },
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });

  const raw = response.getContentText();
  if (response.getResponseCode() !== 200) {
    Logger.log('Gemini error: ' + raw);
    throw new Error(`Gemini API error ${response.getResponseCode()}: ${raw}`);
  }

  const text = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text. Response: ' + raw);
  // Strip markdown fences and any leading/trailing non-JSON text
  let clean = text.trim();
  // Remove ```json ... ``` or ``` ... ``` wrappers
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // Find the actual JSON object (starts with { ends with })
  const jsonStart = clean.indexOf('{');
  const jsonEnd   = clean.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    clean = clean.slice(jsonStart, jsonEnd + 1);
  }
  return JSON.parse(clean);
}



// ─── JOB INFO EXTRACTION ─────────────────────────────────────

function extractJobInfo(pageText, modelOverride) {
  // pageText already contains [H1 TITLE], [PAGE TITLE], [COMPENSATION] hints
  // prepended by content.js — no further filtering needed here.
  const prompt = `Extract job info from this posting. Return ONLY raw JSON, no markdown, no code fences.

{
  "role": "job title",
  "company": "company name",
  "job_type": "full-time | part-time | intern | co-op | contract | freelance | unknown",
  "location": "city, country or Remote or Hybrid",
  "salary": "pay range as written, or empty string"
}

Rules:
- [H1 TITLE] or [PAGE TITLE] at the top = the role. Use it.
- [COMPENSATION] = the salary. Copy it verbatim.
- Empty string for unknown fields, never null.
- Default job_type to full-time if unspecified.

${pageText}`;

  return callGemini(prompt, modelOverride);
}


// ─── OPTIMISATION #3: Rule-based email pre-filter ────────────

function ruleBasedEmailStatus(subject, body) {
  const text = (subject + ' ' + body).toLowerCase();
  for (const rule of EMAIL_RULES) {
    for (const pattern of rule.patterns) {
      if (new RegExp(pattern, 'i').test(text)) {
        return rule.status;
      }
    }
  }
  return null; // no match → needs AI
}


// ─── OPTIMISATION #2: Combined email parse + company match ───
// Single Gemini call does both jobs at once.

function parseEmailAndMatch(emailBody, emailFrom, subject, applications) {
  const validStatuses = Object.values(STATUS).join(' | ');
  const appList = applications
    .map(a => `row:${a._rowIndex} company:"${a.company}" role:"${a.role}"`)
    .join('\n');

  // Extract sender domain as extra matching signal
  const senderDomain = emailFrom.match(/@([\w.-]+)/)?.[1] || '';

  const prompt = `Analyze this recruitment email. Return JSON only, no markdown.

{
  "status": "one of: ${validStatuses}",
  "confidence": 0.0-1.0,
  "interview_date": "ISO8601 datetime or empty string",
  "company_mentioned": "company name found anywhere in email — check signature, footer, From address domain, subject line",
  "matched_row_index": null or row number from Applications list,
  "match_confidence": 0.0-1.0,
  "notes": "one sentence summary"
}

Status guide:
- Rejected = any decline, even polite ones ("decided to move forward with others", "not a fit", "position filled", "other candidates")
- Applied = ONLY pure auto-confirmation with no other signal
- Upcoming Interview = interview invitation with or without specific date
- Offer = job offer extended

Matching guide:
- sender domain "${senderDomain}" may identify the company even if body is generic
- match company_mentioned OR sender domain to the Applications list
- if unsure, still attempt a match with lower match_confidence

From: ${emailFrom}
Subject: ${subject}
Body: ${emailBody.slice(0, 1500)}

Applications list:
${appList || "(no applications yet)"}`;

  return callGemini(prompt);
}


// ─── MAIN EMAIL SCAN ─────────────────────────────────────────

function scanRecruitmentEmails() {
  // Time-based filter: scan emails from the last 2 hours, exclude already processed
  const twoHoursAgo = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
  const query = `category:primary after:${twoHoursAgo} -label:JobTrackerProcessed subject:(application OR interview OR offer OR "thank you for applying" OR "your application" OR "next steps" OR "moving forward" OR "unfortunately")`;
  const threads = GmailApp.search(query, 0, 20);
  const apps    = getAllApplications();

  Logger.log(`Found ${threads.length} threads`);

  threads.forEach(thread => {
    const message = thread.getMessages().slice(-1)[0];
    const subject = message.getSubject();
    const from    = message.getFrom();
    const body    = message.getPlainBody();

    try {
      // Optimisation #3: try rules first
      const ruleStatus = ruleBasedEmailStatus(subject, body);

      let parsed;
      if (ruleStatus) {
        // High-confidence rule match — still need company matching but skip status AI
        Logger.log(`Rule match: "${subject}" → ${ruleStatus}`);
        parsed = { status: ruleStatus, confidence: 0.95, interview_date: '', company_mentioned: '', matched_row_index: null, match_confidence: 0, notes: 'Rule-based match' };

        // Still run a lightweight company match if we have apps
        if (apps.length) {
          const matchResult = callGemini(`Match this email sender to an application. Return JSON only.
{"matched_row_index":number_or_null,"confidence":0.0-1.0}
From: ${from} Subject: ${subject}
Applications:\n${apps.map(a => `row:${a._rowIndex} company:"${a.company}"`).join('\n')}`);
          parsed.matched_row_index = matchResult.matched_row_index;
          parsed.match_confidence  = matchResult.confidence || 0;
        }
      } else {
        // Optimisation #2: single combined AI call
        parsed = parseEmailAndMatch(body, from, subject, apps);
        Logger.log(`AI parse: "${subject}" → ${parsed.status} (${parsed.confidence})`);
      }

      const rowIdx          = (parsed.match_confidence >= 0.65) ? parsed.matched_row_index : null;
      let   actionTaken     = '';

      if (!rowIdx) {
        actionTaken = 'No matching application — skipped';
      } else if (parsed.status === STATUS.APPLIED) {
        actionTaken = 'Confirmation email — no change';
      } else if (parsed.confidence >= AUTO_UPDATE_THRESHOLD) {
        updateStatus(rowIdx, parsed.status, parsed.interview_date || null);
        actionTaken = `Auto-updated row ${rowIdx} → "${parsed.status}"`;
      } else {
        getAppSheet().getRange(rowIdx, 1, 1, 13).setBackground('#FFF9C4');
        actionTaken = `Flagged row ${rowIdx} for review (confidence: ${parsed.confidence.toFixed(2)})`;
      }

      logEmailAction(subject, from, parsed.company_mentioned, parsed.status, parsed.confidence, actionTaken);
      Logger.log(actionTaken);
      message.markRead();

    } catch (e) {
      Logger.log(`Error on "${subject}": ${e.message}`);
      logEmailAction(subject, from, '', '', 0, `ERROR: ${e.message}`);
    }
  });

  Logger.log('Email scan complete.');
}


// ─── WEB APP ENDPOINT ────────────────────────────────────────

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.action === 'models') {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, models: SUPPORTED_MODELS })).setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'extract') {
      const result = extractJobInfo(body.pageText || '', body.model || null);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, result })).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === 'add') {
      const id = addApplication(body);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, id })).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === 'list') {
      const apps = getAllApplications();
      return ContentService.createTextOutput(JSON.stringify({ ok: true, data: apps })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unknown action' })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Job Application Tracker API is running.' })).setMimeType(ContentService.MimeType.JSON);
}


// ─── TEST FUNCTIONS ──────────────────────────────────────────

function testGeminiConnection() {
  const result = callGemini('Return this JSON exactly: {"status":"ok","message":"Gemini is connected"}');
  Logger.log('Result: ' + JSON.stringify(result));
}

function testAddApplication() {
  const id = addApplication({
    role: 'Software Engineer', company: 'Acme Corp', job_type: 'full-time',
    location: 'Vancouver, BC', salary: '$120,000–$140,000',
    application_url: 'https://jobs.acmecorp.com/se-123',
    source: 'LinkedIn', notes: 'Test entry — delete me',
  });
  Logger.log('Added id: ' + id);
}

function testEmailParsing() {
  const sampleEmail = `Hi, we'd love to invite you for a technical interview on April 22, 2026 at 2:00 PM PST for the Software Engineer role. Please confirm your availability. — Acme Corp Recruiting`;
  const result = parseEmailAndMatch(sampleEmail, 'recruiting@acmecorp.com', 'Interview Invitation — Software Engineer', getAllApplications());
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

function testRuleBasedFilter() {
  const cases = [
    { s: 'Thank you for applying', b: 'We received your application' },
    { s: 'Interview Invitation', b: 'We would like to schedule an interview with you' },
    { s: 'Application Update', b: 'Unfortunately we will not be moving forward with your application' },
    { s: 'Exciting opportunity', b: 'Your profile looks interesting' },
  ];
  cases.forEach(c => Logger.log(`"${c.s}" → ${ruleBasedEmailStatus(c.s, c.b) || '(needs AI)'}`));
}