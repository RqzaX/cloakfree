# cloakfree

Stealth browser for automation, usable as a plain dependency in any Node project.

- **Fingerprint at the binary level** — canvas / WebGL / audio / font / client
  rects / GPU / screen / locale patches compiled into a real Chromium, switched
  by a seed, not injected with JS.
- **No key, no account, no seat cap, no license server call.**
- **Human input** — pointer strokes, typing and scrolling with human timing.
- **Local Turnstile tokens** — replace a paid captcha API with a real click.
- **One shared engine** — the ~500 MB browser lives in `~/.cloakfree`, so every
  project on the machine reuses it.

Drop-in shape of the CloakBrowser wrapper API (`launch`,
`launchPersistentContext`), rebuilt on a fully open engine.

## Why this is free

CloakBrowser's stealth does not live in its wrapper (that part is MIT and
public). It lives in the browser binary — C++ patches switched by
`--fingerprint=<seed>` — and that binary is license-gated: the wrapper downloads
it with `Authorization: Bearer <key>` and the binary re-checks the key at
startup (exit codes 76–79).

The same patch set is published as
[fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)
(ungoogled-chromium + the fingerprint patches, Apache-2.0/BSD, free GitHub
releases). `cloakfree` points that `--fingerprint=<seed>` mechanism at the
public build, drives it with `patchright` (Playwright with the CDP/runtime
automation leaks patched out), and adds what the wrapper contributed:

| CloakBrowser | cloakfree |
| --- | --- |
| license key, email claim, seat cap | none |
| `--fingerprint=<seed>` binary patches | same flags, same engine family |
| `humanize=True` behaviour model | `human.js` (Fitts + bezier strokes, 136M-Keystrokes timing) |
| profile-seeded stable fingerprint | `seedFromProfile()` — sha256 of the profile path |
| patched Playwright driver | `patchright` |

## Install

```bash
# from another local project
npm install file:../cloakfree

# or from a packed tarball (no paths involved)
npm pack                       # in this folder -> cloakfree-1.1.0.tgz
npm install ../cloakfree-1.1.0.tgz
```

One-time engine download (once per machine, shared by all projects):

```bash
npx cloakfree fetch            # or: node node_modules/cloakfree/cli.js fetch
npm test                       # in this folder: 10 checks, launches real browsers
```

## Use

```js
const { launch, launchPersistentContext } = require('cloakfree');

// Ephemeral browser
const browser = await launch({ headless: false, humanize: true, proxy: 'http://user:pass@host:port' });
const page = await browser.newPage();
await page.goto('https://example.com');
await page.human.idle();                       // pointer drift while "reading"
await page.human.fill('#email', 'a@b.co');     // click, then type like a person
await page.human.click('#submit');
await browser.close();

// Persistent profile: cookies survive, fingerprint stays the same
const ctx = await launchPersistentContext({ userDataDir: 'profiles/acc-1', humanize: true });
const page2 = ctx.pages()[0] || (await ctx.newPage());
```

### launch options

| option | default | meaning |
| --- | --- | --- |
| `headless` | `true` | headed passes bot checks far more often |
| `humanize` | `false` | attach `page.human` |
| `seed` | random / from profile | fingerprint seed (32-bit int) |
| `locale` | `en-US` | `--lang` / `--accept-lang` |
| `timezone` | real host zone | set only when you need it to match a proxy's country |
| `proxy` | — | `http(s)://user:pass@host:port`; credentials route through CDP |
| `viewport` | `null` | `null` = real window size (coherent `outerWidth`) |
| `canvasSpoof` | `false` | turn the canvas patch on (see tuning) |
| `args` | `[]` | extra Chromium flags, applied last |
| `executablePath` | auto | use your own build |
| `build` | `148.0.7778.215` | engine version to download |

### `page.human`

`move(x, y)`, `click(selector)`, `clickAt(x, y)`, `clickBox(box)`, `fill(selector, text)`,
`type(text)`, `idle(seconds?)`, `scroll(px)`, `scrollTo(selector)`.

The same functions are exported from `cloakfree/human` for use on pages you did
not launch through `launch({ humanize: true })`.

### Turnstile without a solver service

```js
const { solveTurnstile } = require('cloakfree/turnstile');

const token = await solveTurnstile({
  pageUrl: 'https://target.example/login',
  siteKey: '0x4AAAAAAA...',        // optional, targets the right widget
  proxy: 'http://user:pass@host:port',
  userDataDir: 'profiles/acc-1',  // optional: keep cookie/clearance state
});
```

Opens the page in a real headed browser, clicks the widget like a person, and
returns the `cf-turnstile-response` token (hidden input, `turnstile.render`
callback, or `turnstile.getResponse()`).

```bash
npx cloakfree token --url https://target.example/login --sitekey 0x4AAA... [--profile dir] [--proxy url] [--headless] [--timeout 90]
```

Headed is the default on purpose: headless Chromium is the loudest automation
signal. On a display-less server run it under `xvfb-run` and expect a lower pass
rate. Cloudflare can refuse an IP regardless of the fingerprint.

## Tuning

Measured against a Cloudflare-protected sign-in page, home connection, no proxy,
10 runs:

| canvas spoofing | tokens | time per token |
| --- | --- | --- |
| on (`canvasSpoof: true`) | 1/4 | 4–97 s |
| off (default) | 4/4 | 4–11 s |

The canvas patch emits per-seed noise, which is exactly what Turnstile's
integrity check looks for. The other patches (WebGL, GPU, audio, fonts, client
rects, screen) cost nothing measurable and stay on. Enable `canvasSpoof` only if
canvas linkability across sites matters more than passing Cloudflare.

Engine: pinned to Chromium **148**. Build 150's canvas patch crashes the
renderer on canvas-heavy pages under automation (verified on the same site).

## Reuse notes

- Engine cache is global (`~/.cloakfree`); a second project downloads nothing.
- Give each account its own `userDataDir`. The seed is derived from that path, so
  one profile keeps one identity across runs, while separate profiles look like
  separate machines.
- Environment: `CLOAKFREE_BINARY_PATH` (own build), `CLOAKFREE_CACHE_DIR`,
  `CLOAKFREE_BUILD` (engine version), `CLOAKFREE_HEADLESS=1` (force headless in
  callers that default to headed), `CLOAKFREE_DEBUG=1` (screenshot + frame dump
  when a Turnstile solve fails).
- Limits: no prebuilt macOS engine (point `CLOAKFREE_BINARY_PATH` at your own
  fingerprint-chromium build); proxy credentials go through CDP, one extra
  automation surface; fingerprint patches do nothing against a proxy IP with bad
  reputation.
