// popup.js — Job Application Tracker

const statusBar  = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const saveBtn    = document.getElementById('save-btn');
const form       = document.getElementById('job-form');

const MODEL_QUOTA = {
  'gemini-3.1-flash-lite-preview': '500 req/day — recommended for heavy application days',
  'gemini-2.5-flash-lite':         '20 req/day — good quality for light days',
  'gemini-2.5-flash':              '20 req/day — highest quality, use for tricky pages',
};

// ─── Helpers ─────────────────────────────────────────────────

function setStatus(msg, type = 'loading') {
  statusText.textContent = msg;
  statusBar.className    = type === 'loading' ? '' : type;
  const spinner = statusBar.querySelector('.spinner');
  if (spinner) spinner.style.display = type === 'loading' ? 'block' : 'none';
}

function fillField(id, value) {
  const el = document.getElementById(id);
  if (!el || value === undefined || value === null) return;
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find(o => o.value === String(value).toLowerCase().replace(/\s/g, '-'));
    if (opt) el.value = opt.value;
  } else {
    el.value = value;
  }
}

function getFormData() {
  return {
    role:            document.getElementById('role').value.trim(),
    company:         document.getElementById('company').value.trim(),
    job_type:        document.getElementById('job_type').value,
    location:        document.getElementById('location').value.trim(),
    salary:          document.getElementById('salary').value.trim(),
    application_url: document.getElementById('application_url').value.trim(),
    source:          document.getElementById('source').value,
    notes:           document.getElementById('notes').value.trim(),
  };
}

function fillForm(data) {
  Object.keys(data).forEach(k => fillField(k, data[k]));
}

function updateHeaderModel(model) {
  const el = document.getElementById('header-model');
  if (el) el.textContent = `Model: ${model}`;
}

// ─── Storage helpers ─────────────────────────────────────────

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['scriptUrl', 'selectedModel', 'prefetchEnabled'], resolve);
  });
}

async function getTabState() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getTabState' }, res => {
      resolve(res?.state || 'none');
    });
  });
}

async function getSelectedModel() {
  const { selectedModel } = await getSettings();
  return selectedModel || 'gemini-2.5-flash-lite';
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_PREFIX = 'cache__';

async function getCached(url) {
  return new Promise(resolve => {
    const key = CACHE_PREFIX + url;
    chrome.storage.local.get(key, result => {
      if (!result || result[key] === undefined) { resolve(null); return; }
      const entry = result[key];
      const cachedAt = entry._cachedAt;
      // If _cachedAt missing or expired, clear and return null
      if (!cachedAt || (Date.now() - cachedAt) > CACHE_TTL_MS) {
        chrome.storage.local.remove(key);
        resolve(null);
        return;
      }
      resolve(entry);
    });
  });
}

async function setCached(url, data) {
  return new Promise(resolve => {
    const key = CACHE_PREFIX + url;
    chrome.storage.local.set({ [key]: { ...data, _cachedAt: Date.now() } }, resolve);
  });
}

function clearCached(url) {
  chrome.storage.local.remove(CACHE_PREFIX + url);
}

// ─── API calls ───────────────────────────────────────────────

async function getPageText(delay = 0) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action: 'getPageText', delay }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function extractJobInfo(pageText, pageUrl, model) {
  const { scriptUrl } = await getSettings();
  if (!scriptUrl) throw new Error('Apps Script URL not set. Click ⚙ Settings below.');

  const response = await fetch(scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'extract', pageText, pageUrl, model }),
  });

  if (!response.ok) throw new Error(`Server error: ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Extraction failed');
  return data.result;
}

async function saveApplication(payload) {
  const { scriptUrl } = await getSettings();
  if (!scriptUrl) throw new Error('Apps Script URL not set.');

  const response = await fetch(scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'add', ...payload }),
  });

  if (!response.ok) throw new Error(`Server error: ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Save failed');
  return data.id;
}

// ─── Core extraction (shared by init + re-run) ───────────────

async function runExtraction(tabUrl, model, delayMs = 800) {
  setStatus(`Extracting with ${model}…`, 'loading');
  saveBtn.disabled = true;
  document.getElementById('rerun-btn').disabled = true;

  try {
    const page = await getPageText(delayMs);

    if (page.source) fillField('source', page.source);

    if (page.needsPasteMode) {
      // Cache the paste-mode flag so re-opening popup is instant
      await setCached(tabUrl, { needsPasteMode: true, application_url: tabUrl });
      setStatus('📋 This page uses an embedded ATS — paste the job text below', 'error');
      document.getElementById('paste-panel').classList.add('open');
      saveBtn.disabled = false;
      document.getElementById('rerun-btn').disabled = false;
      return;
    }

    const extracted = await extractJobInfo(page.text, tabUrl, model);

    const formData = {
      role:            extracted.role     || '',
      company:         extracted.company  || '',
      job_type:        extracted.job_type || 'full-time',
      location:        extracted.location || '',
      salary:          extracted.salary   || '',
      application_url: tabUrl,
      source:          page.source || document.getElementById('source').value,
      notes:           '',
    };

    fillForm(formData);
    await setCached(tabUrl, formData);
    setStatus('Review and save ✓', 'success');
    saveBtn.disabled = false;
    // Switch icon to green — extraction complete, ready to save
    const [_tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.runtime.sendMessage({ action: 'setBadge', state: 'done' });
  } catch (err) {
    // Cache the error so re-opening popup doesn't re-run automatically
    // User must click Re-run manually
    await setCached(tabUrl, { _extractionError: err.message, application_url: tabUrl });
    setStatus(`${err.message} — click ↺ Re-run to try again`, 'error');
    saveBtn.disabled = false;
  } finally {
    document.getElementById('rerun-btn').disabled = false;
  }
}

// ─── Boot ────────────────────────────────────────────────────

async function init() {
  setStatus('Loading…', 'loading');
  saveBtn.disabled = true;

  // Load model and show in header immediately
  const model = await getSelectedModel();
  updateHeaderModel(model);

  try {
    const [tab]  = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tab.url;

    // Auto-detect source platform
    try {
      const host = new URL(tabUrl).hostname;
      if (host.includes('linkedin'))       fillField('source', 'LinkedIn');
      else if (host.includes('indeed'))    fillField('source', 'Indeed');
      else if (host.includes('glassdoor')) fillField('source', 'Glassdoor');
      else if (host.includes('handshake')) fillField('source', 'Handshake');
      else                                 fillField('source', 'Company Website');
    } catch (_) {}

    fillField('application_url', tabUrl);

    // Check cache — may have been pre-populated by background pre-fetch
    const cached = await getCached(tabUrl);
    if (cached) {
      if (cached.needsPasteMode) {
        setStatus('📋 Paste mode required — job content is in an embedded frame', 'error');
        document.getElementById('paste-panel').classList.add('open');
        saveBtn.disabled = false;
        return;
      }
      if (cached._extractionError) {
        setStatus(`${cached._extractionError} — click ↺ Re-run to try again`, 'error');
        saveBtn.disabled = false;
        return;
      }
      fillForm(cached);
      setStatus('Loaded instantly ⚡', 'success');
      saveBtn.disabled = false;
      return;
    }

    await runExtraction(tabUrl, model);

  } catch (err) {
    setStatus(err.message, 'error');
    saveBtn.disabled = false;
  }
}

// ─── Form submit ─────────────────────────────────────────────

form.addEventListener('submit', async e => {
  e.preventDefault();
  saveBtn.disabled = true;
  setStatus('Saving…', 'loading');

  const payload = getFormData();
  if (!payload.role || !payload.company) {
    setStatus('Role and Company are required.', 'error');
    saveBtn.disabled = false;
    return;
  }

  try {
    await setCached(payload.application_url, payload);
    await saveApplication(payload);

    setStatus('Saved ✓', 'success');
    saveBtn.textContent = '✓ Saved';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    clearCached(tab.url);
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    setStatus(err.message, 'error');
    saveBtn.disabled = false;
  }
});

// Keep cache in sync with manual edits
form.addEventListener('input', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await setCached(tab.url, getFormData());
});

// ─── Settings panel ──────────────────────────────────────────

// ─── Re-run button ───────────────────────────────────────────

document.getElementById('rerun-btn').addEventListener('click', async () => {
  const [tab]  = await chrome.tabs.query({ active: true, currentWindow: true });
  const model  = await getSelectedModel();
  clearCached(tab.url); // Clear error or stale cache
  await runExtraction(tab.url, model, 2000);
});

document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
  document.getElementById('paste-panel').classList.remove('open');
});

// On settings open: sync stored values into the form fields
document.getElementById('settings-toggle').addEventListener('click', async () => {
  const { scriptUrl, selectedModel, prefetchEnabled } = await getSettings();
  if (scriptUrl) document.getElementById('script-url').value = scriptUrl;

  const modelSelect = document.getElementById('model-select');
  const activeModel = selectedModel || 'gemini-3.1-flash-lite-preview';
  modelSelect.value = activeModel;
  updateModelHint(activeModel);

  document.getElementById('prefetch-toggle').checked = !!prefetchEnabled;
});

// Update quota hint when model dropdown changes
document.getElementById('model-select').addEventListener('change', function() {
  updateModelHint(this.value);
});

function updateModelHint(model) {
  const hint = document.getElementById('model-quota-hint');
  if (hint) hint.textContent = MODEL_QUOTA[model] || '';
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const url   = document.getElementById('script-url').value.trim();
  const model = document.getElementById('model-select').value;
  if (!url) { alert('Please enter the Apps Script URL.'); return; }

  const prefetchEnabled = document.getElementById('prefetch-toggle').checked;
  await chrome.storage.local.set({ scriptUrl: url, selectedModel: model, prefetchEnabled });
  document.getElementById('settings-panel').classList.remove('open');
  updateHeaderModel(model);
  setStatus(`Settings saved — using ${model} ✓`, 'success');
});

// ─── Paste mode ──────────────────────────────────────────────

document.getElementById('paste-toggle').addEventListener('click', () => {
  document.getElementById('paste-panel').classList.toggle('open');
  document.getElementById('settings-panel').classList.remove('open');
});

document.getElementById('paste-extract-btn').addEventListener('click', async () => {
  const pastedText = document.getElementById('paste-text').value.trim();
  if (!pastedText) { setStatus('Paste some text first.', 'error'); return; }

  setStatus('Extracting from pasted text…', 'loading');
  saveBtn.disabled = true;

  try {
    const [tab]     = await chrome.tabs.query({ active: true, currentWindow: true });
    const model     = await getSelectedModel();
    const extracted = await extractJobInfo(pastedText, tab.url, model);

    const formData = {
      role:            extracted.role     || '',
      company:         extracted.company  || '',
      job_type:        extracted.job_type || 'full-time',
      location:        extracted.location || '',
      salary:          extracted.salary   || '',
      application_url: tab.url,
      source:          document.getElementById('source').value,
      notes:           '',
    };

    fillForm(formData);
    await setCached(tab.url, formData);
    document.getElementById('paste-panel').classList.remove('open');
    setStatus('Extracted from paste ✓', 'success');
    saveBtn.disabled = false;
  } catch (err) {
    setStatus(err.message, 'error');
    saveBtn.disabled = false;
  }
});

// ─── Start ───────────────────────────────────────────────────
init();
