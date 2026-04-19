// content.js — Job Application Tracker

const JOB_PAGE_SIGNALS = [
  { type: 'url',   pattern: /\/(jobs|careers|job|position|opening|apply|requisition|posting)\b/i },
  { type: 'url',   pattern: /greenhouse\.io|lever\.co|workday\.com|myworkdayjobs|taleo|icims|jobvite|smartrecruiters|ashbyhq|rippling|breezy\.hr|bamboohr|paycor|recruitingbypaycor/i },
  { type: 'title', pattern: /jobs? at |careers? at |apply (for|now)|job opening|job posting/i },
  { type: 'dom',   selector: 'button, a, input[type="submit"]', pattern: /^(apply now|apply for this job|apply to this job|submit application|easy apply)$/i },
  { type: 'dom',   selector: 'h1, h2', pattern: /job description|about (the|this) (role|position|job)|responsibilities|qualifications|requirements/i },
];

function isJobPage() {
  const url = window.location.href;
  const title = document.title;
  for (const signal of JOB_PAGE_SIGNALS) {
    if (signal.type === 'url'   && signal.pattern.test(url))   return true;
    if (signal.type === 'title' && signal.pattern.test(title)) return true;
    if (signal.type === 'dom') {
      for (const el of document.querySelectorAll(signal.selector)) {
        if (signal.pattern.test(el.innerText?.trim())) return true;
      }
    }
  }
  return false;
}

const IFRAME_ATS = /recruitingbypaycor|greenhouse\.io|myworkdayjobs|lever\.co|taleo|icims|jobvite|smartrecruiters|ashbyhq/i;
function hasUnscrapeableIframe() {
  for (const iframe of document.querySelectorAll('iframe')) {
    if (IFRAME_ATS.test(iframe.src || '')) return true;
  }
  return false;
}

// Detect source platform from URL
function detectSource(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes('linkedin'))    return 'LinkedIn';
    if (h.includes('indeed'))      return 'Indeed';
    if (h.includes('glassdoor'))   return 'Glassdoor';
    if (h.includes('handshake'))   return 'Handshake';
    return 'Company Website';
  } catch { return 'Company Website'; }
}

// ── Safe runtime wrapper (handles invalidated context after reload) ──
function safeSendMessage(msg, cb) {
  try {
    chrome.runtime.sendMessage(msg, cb);
  } catch (e) {
    // Extension was reloaded — silently ignore
  }
}

function updateBadge(state) {
  safeSendMessage({ action: 'setBadge', state });
}

async function onPageReady() {
  if (!isJobPage()) { updateBadge('none'); return; }

  const cacheKey  = 'cache__' + window.location.href;
  const needsPaste = hasUnscrapeableIframe();

  if (needsPaste) {
    updateBadge('iframe');
    // Cache the paste-mode flag so popup doesn't re-detect
    chrome.storage.local.get(cacheKey, result => {
      if (!result || !result[cacheKey]) {
        chrome.storage.local.set({
          [cacheKey]: { needsPasteMode: true, application_url: window.location.href, _cachedAt: Date.now() }
        });
      }
    });
    return;
  }

  updateBadge('job');

  safeSendMessage({ action: 'shouldPrefetch' }, (response) => {
    if (!response?.enabled) return;

    chrome.storage.local.get(cacheKey, async (result) => {
      if (result && result[cacheKey]) return;

      updateBadge('prefetching');
      await new Promise(r => setTimeout(r, 1500));

      safeSendMessage({
        action:   'prefetchExtraction',
        pageText: scrapePageText().text,
        pageUrl:  window.location.href,
      }, (res) => {
        if (res?.result) {
          chrome.storage.local.set({
            [cacheKey]: { ...res.result, application_url: window.location.href, _cachedAt: Date.now() }
          });
        }
        updateBadge('done'); // prefetch complete — green icon
      });
    });
  });
}

onPageReady();

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(onPageReady, 1000);
  }
}).observe(document.body, { childList: true, subtree: true });


function scrapePageText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());

  const rawText = clone.innerText
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const genericTitles = /^(job posting|careers|jobs|open positions|apply( now)?|about us|home|login|news)$/i;
  const titleCandidates = [];
  document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="job-name"], [class*="position-name"]').forEach(el => {
    const t = el.innerText?.trim();
    if (!t || t.length > 120 || genericTitles.test(t)) return;
    titleCandidates.push({ tag: el.tagName, text: t });
  });

  const bestTitle =
    titleCandidates.find(c => /h[23]/i.test(c.tag) && c.text.length > 4) ||
    titleCandidates.find(c => /h1/i.test(c.tag) && !genericTitles.test(c.text)) ||
    titleCandidates[0];

  const salaryLines = rawText.split('\n')
    .filter(l => /compensation|salary|pay range|per hour|per year|\$[\d,]+/i.test(l))
    .map(l => l.trim());

  const locationEl = document.querySelector(
    '[class*="location"], [class*="city"], [itemprop="jobLocation"], [itemprop="addressLocality"]'
  );

  const hints = [];
  if (bestTitle)          hints.push(`[JOB ROLE]: ${bestTitle.text}`);
  if (salaryLines.length) hints.push(`[COMPENSATION]: ${salaryLines.join(' | ')}`);
  if (locationEl)         hints.push(`[LOCATION]: ${locationEl.innerText.trim()}`);

  return {
    text:           (hints.join('\n') + '\n\n' + rawText).slice(0, 6000),
    url:            window.location.href,
    title:          document.title,
    source:         detectSource(window.location.href),
    needsPasteMode: hasUnscrapeableIframe(),
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'getPageText') return;
  setTimeout(() => sendResponse(scrapePageText()), request.delay || 0);
  return true;
});
