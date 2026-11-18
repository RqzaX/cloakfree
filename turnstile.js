'use strict';
/**
 * cloakfree/turnstile.js - get a Cloudflare Turnstile token from a real,
 * source-patched browser instead of a paid solver API.
 *
 * A Turnstile widget passes on a human-looking browser with the interactive
 * checkbox alone: move the pointer like a person, click the box, read the token
 * back. Headless is the loudest automation signal there is, so this runs headed
 * by default; keep it headed unless the machine has no display.
 */

const index = require('./index');
const human = require('./human');

const CF_FRAME = 'iframe[src*="challenges.cloudflare.com"]';
const WIDGET = `${CF_FRAME}, [data-sitekey], .cf-turnstile`;
const TOKEN_SELECTORS = [
  'input[name="cf-turnstile-response"]',
  'textarea[name="cf-turnstile-response"]',
  'input[name="g-recaptcha-response"]',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/** Capture tokens handed to explicit-render callbacks, which never hit the DOM. */
const CAPTURE_SCRIPT = () => {
  window.__cloakfreeTokens = [];
  const wrap = () => {
    const api = window.turnstile;
    if (!api || api.__cloakfreeWrapped || typeof api.render !== 'function') return;
    const render = api.render.bind(api);
    api.render = (el, params) => {
      const callback = params && params.callback;
      return render(el, {
        ...params,
        callback: (token) => {
          try {
            window.__cloakfreeTokens.push(token);
          } catch {
            /* frozen */
          }
          if (callback) callback(token);
        },
      });
    };
    api.__cloakfreeWrapped = true;
  };
  wrap();
  const timer = setInterval(wrap, 100);
  setTimeout(() => clearInterval(timer), 60000);
};

/** Any token already on the page: hidden input, callback capture, or API. */
async function readToken(page) {
  return page
    .evaluate((selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const value = el && (el.value || el.getAttribute('value') || '');
        if (value && value.length > 20) return value;
      }
      const grabbed = window.__cloakfreeTokens;
      if (grabbed && grabbed.length) return grabbed[grabbed.length - 1];
      try {
        const api = window.turnstile;
        if (api && typeof api.getResponse === 'function') {
          const value = api.getResponse();
          if (value && value.length > 20) return value;
        }
      } catch {
        /* not rendered yet */
      }
      return null;
    }, TOKEN_SELECTORS)
    .catch(() => null);
}

async function waitForToken(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await readToken(page);
    if (token) return token;
    await page.waitForTimeout(250);
  }
  return null;
}

/**
 * The on-screen widget. Pages often mount several Turnstile iframes; the 0x0
 * ones are invisible-mode widgets no one can click, so pick the biggest
 * visible one.
 */
async function findWidget(page, siteKey, waitMs = 15000) {
  const scope = siteKey ? `${CF_FRAME}, [data-sitekey="${siteKey}"] iframe, [data-sitekey="${siteKey}"]` : WIDGET;
  const deadline = Date.now() + waitMs;
  let best = null;
  while (Date.now() < deadline) {
    const candidates = page.locator(scope);
    const count = await candidates.count().catch(() => 0);
    best = null;
    for (let i = 0; i < count; i++) {
      const locator = candidates.nth(i);
      const box = await locator.boundingBox().catch(() => null);
      if (!box || box.width < 60 || box.height < 30) continue;
      if (!best || box.width * box.height > best.box.width * best.box.height) best = { box, locator };
    }
    if (best) return best;
    await sleep(400);
  }
  return null;
}

/** Click the widget's checkbox with a human approach and hold. */
async function clickWidget(page, box) {
  const x = Math.round(box.x + rand(26, 34));
  const y = Math.round(box.y + box.height / 2 + rand(-3, 3));
  await human.move(page, Math.round(box.x - rand(80, 220)), Math.round(box.y + box.height + rand(60, 160)));
  await sleep(rand(120, 380));
  await human.clickAt(page, x, y);
  return { x, y };
}

/**
 * Open `pageUrl`, pass the widget, return the token.
 *
 * @param {object} opts
 * @param {string} opts.pageUrl        page that hosts the widget
 * @param {string} [opts.siteKey]      sitekey, if known (targets the right widget)
 * @param {boolean} [opts.headless]    default false - headed passes, headless often does not
 * @param {string} [opts.proxy]        http(s)://user:pass@host:port
 * @param {string} [opts.userDataDir]  persistent profile (keeps cookies + clearance)
 * @param {number} [opts.timeoutMs]    total budget, default 75000
 * @param {object} [opts.launchOptions] passed through to launch()
 * @returns {Promise<string>} the cf-turnstile-response token
 */
async function solveTurnstile(opts = {}) {
  const {
    pageUrl,
    siteKey,
    headless = false,
    proxy,
    userDataDir,
    timeoutMs = 75000,
    locale = 'en-US',
    timezone,
    launchOptions = {},
  } = opts;
  if (!pageUrl) throw new Error('solveTurnstile: pageUrl is required');

  const options = {
    headless,
    humanize: true,
    proxy,
    locale,
    timezone,
    userDataDir,
    args: ['--window-size=1366,900'],
    viewport: null,
    ...launchOptions,
  };

  const browser = userDataDir ? null : await index.launch(options);
  const context = userDataDir
    ? await index.launchPersistentContext(options)
    : await browser.newContext({ viewport: null });
  const page = context.pages()[0] || (await context.newPage());
  const closeTarget = browser || context.browser();

  try {
    await context.addInitScript(CAPTURE_SCRIPT);
    human.humanize(page);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let token = await waitForToken(page, 3500);
    if (token) return token;

    // The widget's script has to be up before any click means anything: on a
    // cold load it renders the checkbox while still bootstrapping.
    await page
      .waitForFunction(() => typeof window.turnstile !== 'undefined' || !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'), null, { timeout: 20000 })
      .catch(() => {});
    await page.waitForLoadState('load').catch(() => {});

    const widget = await findWidget(page, siteKey);
    if (!widget) throw new Error(`turnstile: no visible widget on ${pageUrl}`);

    await widget.locator.scrollIntoViewIfNeeded().catch(() => {});
    // The widget renders its checkbox before its challenge code is wired up;
    // a click in that window does nothing at all.
    await sleep(rand(1200, 2400));

    const deadline = Date.now() + timeoutMs;
    // Click, watch for ~3 s, click again: a missed or too-early click is far
    // more likely than a refused challenge, and waiting out the whole budget
    // before the second attempt just wastes the challenge's freshness.
    for (let attempt = 1; attempt <= 4 && Date.now() < deadline; attempt++) {
      const current = await findWidget(page, siteKey, 4000);
      if (current) {
        await current.locator.scrollIntoViewIfNeeded().catch(() => {});
        const box = (await current.locator.boundingBox().catch(() => null)) || current.box;
        await clickWidget(page, box);
        if (attempt >= 3) {
          // Pointer clicks ignored twice: the widget also accepts a focused
          // keyboard activation, which is what a keyboard user would do.
          await current.locator.focus().catch(() => {});
          await page.keyboard.press('Space').catch(() => {});
        }
      }
      for (let i = 0; i < 5; i++) {
        await sleep(600);
        token = await readToken(page);
        if (token) return token;
      }
      await sleep(rand(400, 1000));
    }

    token = await waitForToken(page, Math.max(3000, deadline - Date.now()));
    if (!token) {
      if (process.env.CLOAKFREE_DEBUG) {
        await page.screenshot({ path: 'cloakfree-turnstile-fail.png' }).catch(() => {});
        const frames = page.frames().map((f) => f.url().slice(0, 120));
        console.error('[cloakfree] no token. frames:', JSON.stringify(frames, null, 1));
      }
      throw new Error('turnstile: no token within timeout (challenge refused or interactive)');
    }
    return token;
  } finally {
    if (closeTarget) await closeTarget.close().catch(() => {});
  }
}

module.exports = { solveTurnstile, readToken, findWidget, CAPTURE_SCRIPT };
