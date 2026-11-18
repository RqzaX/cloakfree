'use strict';
/**
 * cloakfree - stealth browser launcher, free of keys, accounts and session caps.
 *
 * Same shape as CloakBrowser's JS API (`launch`, `launchPersistentContext`), but
 * the fingerprint is produced by the open-source fingerprint-chromium binary
 * (source-level canvas/WebGL/audio/font/GPU/screen patches) driven by patchright
 * (Playwright with the CDP/runtime automation leaks patched out). No license
 * server is contacted by this package; the only network call is the one-time
 * browser download.
 *
 *   const { launchPersistentContext } = require('./cloakfree');
 *   const ctx = await launchPersistentContext({ userDataDir: 'profiles/a1', humanize: true });
 *   const page = ctx.pages()[0] || (await ctx.newPage());
 *   await page.human.click('#submit');
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { chromium } = require('patchright');

const engine = require('./engine');
const human = require('./human');

// Playwright's defaults that are automation tells: --enable-automation exposes
// navigator.webdriver, --enable-unsafe-swiftshader forces a software renderer
// string no real user machine has.
const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];

const PLATFORM_TAG = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform] || 'linux';

/** Stable 32-bit fingerprint seed for a profile dir, so a profile keeps one identity. */
function seedFromProfile(userDataDir) {
  if (!userDataDir) return randomSeed();
  const hex = crypto.createHash('sha256').update(path.resolve(userDataDir)).digest('hex');
  return (parseInt(hex.slice(0, 8), 16) % 90000) + 10000;
}

function randomSeed() {
  return Math.floor(Math.random() * 90000) + 10000;
}

/** Split a proxy url into Chromium flags, or Playwright credentials when it has auth. */
function resolveProxy(proxy) {
  if (!proxy) return { args: [], option: null };
  const url = typeof proxy === 'string' ? proxy : proxy.server;
  if (!url) return { args: [], option: null };
  const withScheme = /^[a-z0-9]+:\/\//i.test(url) ? url : `http://${url}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { args: [`--proxy-server=${url}`], option: null };
  }
  if (!parsed.username) return { args: [`--proxy-server=${parsed.origin}`], option: null };
  // Chromium cannot take proxy credentials on the command line; this path goes
  // through CDP, which is one more automation surface but the only way to auth.
  return {
    args: [],
    option: {
      server: parsed.origin,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    },
  };
}

/**
 * Chromium flags: the fingerprint seed, a coherent locale/UA, WebRTC leak
 * protection, and a window that fills the (spoofed) screen.
 */
function buildArgs(options = {}) {
  const seed = options.seed || randomSeed();
  const locale = options.locale || 'en-US';
  const args = [
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${PLATFORM_TAG}`,
    '--fingerprint-brand=Chrome',
    '--disable-non-proxied-udp',
    '--disable-blink-features=AutomationControlled',
    '--lang=' + locale,
    '--accept-lang=' + locale,
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-gpu-blocklist',
    '--disable-features=TranslateUI',
  ];
  // The canvas patch is off by default: its noise makes the canvas fingerprint
  // unique per seed but unlike any real GPU, and Cloudflare Turnstile scores
  // that as tampering (measured: ~1/4 pass rate with it, 4/4 without). Set
  // canvasSpoof: true when cross-site canvas linkability matters more than CF.
  if (options.canvasSpoof !== true) args.push('--disable-spoofing=canvas');
  if (options.timezone) args.push(`--timezone=${options.timezone}`);
  const windowFilled = (options.args || []).some((a) =>
    /^--(start-maximized|window-size|window-position)/.test(a),
  );
  if (!options.viewport && !windowFilled && options.headless === false) args.push('--start-maximized');
  // Later flags win, so caller args come last.
  return args.concat(options.args || []);
}

/** The full Playwright launch options (exposed for callers that launch themselves). */
async function buildLaunchOptions(options = {}) {
  const executablePath = options.executablePath || (await engine.ensureBinary({ version: options.build }));
  const proxy = resolveProxy(options.proxy);
  return {
    executablePath,
    headless: options.headless ?? true,
    args: buildArgs(options).concat(proxy.args),
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
    ...(proxy.option ? { proxy: proxy.option } : {}),
    ...(options.launchOptions || {}),
  };
}

function contextOptions(options = {}) {
  return {
    viewport: options.viewport === undefined ? null : options.viewport,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.contextOptions || {}),
  };
}

/** Attach `page.human` to the context's pages, now and for pages opened later. */
function humanizeContext(context) {
  for (const page of context.pages()) human.humanize(page);
  context.on('page', (page) => human.humanize(page));
  return context;
}

/**
 * Launch a stealth browser. Caller closes it.
 * @param {object} [options] headless, humanize, seed, locale, timezone, proxy, viewport, args
 */
async function launch(options = {}) {
  const browser = await chromium.launch(await buildLaunchOptions(options));
  if (options.humanize) {
    const origNewContext = browser.newContext.bind(browser);
    browser.newContext = async (opts) => humanizeContext(await origNewContext(opts));
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async (opts) => {
      const page = await origNewPage(opts);
      human.humanize(page);
      return page;
    };
  }
  return browser;
}

/**
 * Launch with a persistent profile - cookies, localStorage and IndexedDB survive,
 * and the fingerprint seed is derived from the profile path so the identity is
 * stable across runs (a rotating fingerprint on one profile is itself a signal).
 * @param {object} options userDataDir (required), plus the launch() options
 * @returns {Promise<import('patchright').BrowserContext>}
 */
async function launchPersistentContext(options = {}) {
  if (!options.userDataDir) throw new Error('launchPersistentContext: userDataDir is required');
  const seed = options.seed || seedFromProfile(options.userDataDir);
  const launchOptions = await buildLaunchOptions({ ...options, seed });
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    ...contextOptions(options),
    ...launchOptions,
  });
  if (options.humanize) humanizeContext(context);
  return context;
}

module.exports = {
  launch,
  launchPersistentContext,
  buildArgs,
  buildLaunchOptions,
  humanize: human.humanize,
  humanizeContext,
  human,
  engine,
  randomSeed,
  seedFromProfile,
};
