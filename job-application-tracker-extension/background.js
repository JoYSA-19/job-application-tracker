// background.js — Job Application Tracker service worker

// Track icon state per tab so popup can query it
const tabStates = {};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab?.id || request.tabId;

  if (request.action === 'setBadge') {
    if (!tabId) return;
    const { state } = request;
    // Icon meanings:
    // default (grey)      — not a job page
    // job_detected (blue) — job page detected, ready to save
    // prefetching (yellow)— extracting job info in background
    // iframe (orange)     — ATS iframe page, paste mode required
    // done (green)        — application saved successfully
    // Icon states:
    // none        = grey  — not a job page
    // job         = blue  — job detected, click to extract
    // prefetching = yellow — extracting in background or popup
    // iframe      = orange — ATS iframe, paste mode required
    // done        = green — extraction complete, ready to save
    const iconMap = {
      none:        'icons/icon_default',
      job:         'icons/icon_job_detected',
      prefetching: 'icons/icon_prefetching',
      iframe:      'icons/icon_iframe',
      done:        'icons/icon_done',
    };
    const base = iconMap[state] || 'icons/icon_default';
    chrome.action.setIcon({ path: { 16: `${base}_16.png`, 32: `${base}_32.png`, 48: `${base}_48.png`, 128: `${base}_128.png` }, tabId });
    if (tabId) tabStates[tabId] = state;
    chrome.action.setBadgeText({ text: '', tabId });
    const titles = {
      none:        'Job Application Tracker',
      job:         'Job detected — click to extract',
      prefetching: 'Extracting job info…',
      iframe:      '📋 Paste mode required for this page',
      done:        '✅ Extraction complete — click to review & save',
    };
    chrome.action.setTitle({ title: titles[state] || 'Job Application Tracker', tabId });
    return;
  }

  if (request.action === 'getTabState') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const id = tabs[0]?.id;
      sendResponse({ state: tabStates[id] || 'none' });
    });
    return true;
  }

  if (request.action === 'shouldPrefetch') {
    chrome.storage.local.get('prefetchEnabled', ({ prefetchEnabled }) => {
      sendResponse({ enabled: !!prefetchEnabled });
    });
    return true;
  }

  if (request.action === 'prefetchExtraction') {
    chrome.storage.local.get(['scriptUrl', 'selectedModel'], async ({ scriptUrl, selectedModel }) => {
      if (!scriptUrl) { sendResponse({ error: 'No script URL' }); return; }
      try {
        const model = selectedModel || 'gemini-2.5-flash-lite';
        const res = await fetch(scriptUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'extract', pageText: request.pageText, pageUrl: request.pageUrl, model }),
        });
        const data = await res.json();
        sendResponse(data.ok ? { result: data.result } : { error: data.error });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }
});
