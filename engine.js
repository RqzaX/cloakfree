'use strict';
/**
 * cloakfree/engine.js - locate (or fetch) a source-patched Chromium.
 *
 * The heavy parts of a stealth browser live in the binary, not in the driver:
 * canvas / WebGL / audio / font / client-rect noise, GPU strings, screen and
 * hardware concurrency, timezone and locale, all applied to the real renderer.
 * cloakfree uses fingerprint-chromium (ungoogled-chromium + those patches,
 * Apache-2.0/BSD, published free on GitHub) so the same `--fingerprint=<seed>`
 * mechanism is available with no key, no account and no session cap.
 *
 * Resolution order: CLOAKFREE_BINARY_PATH -> any cached build -> download.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Pinned build. 150 exists upstream but its canvas patch crashes the renderer on
// canvas-heavy pages (verified against solfarmer.io/auth); 148 is stable there.
const BUILD = process.env.CLOAKFREE_BUILD || '148.0.7778.215';
const CACHE = process.env.CLOAKFREE_CACHE_DIR || path.join(os.homedir(), '.cloakfree');
const RELEASE = 'https://github.com/adryfish/fingerprint-chromium/releases/download';

/** Release asset for this platform, or null when it needs a manual download. */
function assetFor(version) {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { file: `ungoogled-chromium_${version}-1.1_windows_x64.zip`, exe: 'chrome.exe' };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { file: `ungoogled-chromium-${version}-1-x86_64_linux.tar.xz`, exe: 'chrome' };
  }
  return null;
}

function exeName() {
  if (process.platform === 'darwin') return 'Chromium.app/Contents/MacOS/Chromium';
  return process.platform === 'win32' ? 'chrome.exe' : 'chrome';
}

/** Depth-limited search for the browser executable inside an extracted build. */
function findExe(dir, depth = 3) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const exe = exeName();
  const direct = path.join(dir, exe);
  if (fs.existsSync(direct)) return direct;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findExe(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** Any already-extracted build in the cache, the pinned one first. */
function cachedBuild() {
  if (!fs.existsSync(CACHE)) return null;
  const pinned = path.join(CACHE, `chromium-${BUILD}`);
  const dirs = fs
    .readdirSync(CACHE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
    .map((e) => path.join(CACHE, e.name))
    .sort((a, b) => (a === pinned ? -1 : b === pinned ? 1 : fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs));
  for (const dir of dirs) {
    const exe = findExe(dir);
    if (exe) return exe;
  }
  return null;
}

const log = (msg) => process.stderr.write(`[cloakfree] ${msg}\n`);

async function download(url, dest) {
  log(`downloading ${path.basename(dest)} (~190 MB, once)`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let seen = 0;
  let lastPct = -10;
  for await (const chunk of res.body) {
    seen += chunk.length;
    out.write(chunk);
    if (total) {
      const pct = Math.floor((seen / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log(`  ${pct}% (${Math.round(seen / 1048576)}/${Math.round(total / 1048576)} MB)`);
      }
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const archiveFlag = archive.endsWith('.zip') ? '-xf' : '-xJf';
  try {
    // bsdtar (Windows 10+, macOS) reads .zip as well as .tar.xz.
    execFileSync('tar', [archiveFlag, archive, '-C', dest], { stdio: 'inherit' });
  } catch {
    if (process.platform !== 'win32') throw new Error(`could not extract ${archive}`);
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${dest}" -Force`],
      { stdio: 'inherit' },
    );
  }
}

/**
 * Path to the browser executable, downloading the build on first use.
 * @param {{ version?: string, force?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function ensureBinary(opts = {}) {
  const override = process.env.CLOAKFREE_BINARY_PATH;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`CLOAKFREE_BINARY_PATH does not exist: ${override}`);
    return override;
  }
  if (!opts.force) {
    const hit = cachedBuild();
    if (hit) return hit;
  }

  const version = opts.version || BUILD;
  const asset = assetFor(version);
  if (!asset) {
    throw new Error(
      `no prebuilt fingerprint-chromium for ${process.platform}/${process.arch}.\n` +
        `Download one from https://github.com/adryfish/fingerprint-chromium/releases ` +
        `and point CLOAKFREE_BINARY_PATH at the executable.`,
    );
  }

  const archive = path.join(CACHE, asset.file);
  if (!fs.existsSync(archive)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = `${archive}.part`;
    await download(`${RELEASE}/${version}/${asset.file}`, tmp);
    fs.renameSync(tmp, archive);
  }

  const dest = path.join(CACHE, `chromium-${version}`);
  log(`extracting to ${dest}`);
  extract(archive, dest);
  const exe = findExe(dest);
  if (!exe) throw new Error(`extracted ${asset.file} but found no ${exeName()} in ${dest}`);
  log(`ready: ${exe}`);
  return exe;
}

/** What is cached / in use, without launching anything. */
function binaryInfo() {
  const override = process.env.CLOAKFREE_BINARY_PATH || null;
  return {
    binaryPath: override || cachedBuild(),
    cacheDir: CACHE,
    build: BUILD,
    platform: `${process.platform}-${process.arch}`,
  };
}

module.exports = { ensureBinary, binaryInfo, CACHE, BUILD };
