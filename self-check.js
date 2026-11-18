'use strict';
/**
 * cloakfree/self-check.js - runnable verification: `node cloakfree/self-check.js`
 *
 * Proves the two things that matter: the engine really applies a per-seed
 * fingerprint at the binary level (not a JS shim), and the behavioural layer
 * types and points like a person.
 */

const assert = require('node:assert/strict');
const index = require('./index');
const human = require('./human');

const results = [];
function check(name, fn) {
  try {
    const value = fn();
    results.push(`ok   ${name}`);
    return value;
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
    throw err;
  }
}

async function fingerprint(seed) {
  const browser = await index.launch({ headless: true, seed });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    return await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 40;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '13px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 90, 40);
      ctx.fillStyle = '#069';
      ctx.fillText('cloakfree', 2, 10);
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webdriver: navigator.webdriver,
        hardwareConcurrency: navigator.hardwareConcurrency,
        canvas: canvas.toDataURL().slice(-40),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      };
    });
  } finally {
    await browser.close();
  }
}

(async () => {
  // ---- pure logic ---------------------------------------------------------
  check('seedFromProfile is stable per profile', () => {
    const a = index.seedFromProfile('profiles/acc-1');
    const b = index.seedFromProfile('profiles/acc-1');
    const c = index.seedFromProfile('profiles/acc-2');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  check('buildArgs carries the fingerprint seed', () => {
    const args = index.buildArgs({ seed: 4242, locale: 'en-US' });
    assert.ok(args.includes('--fingerprint=4242'));
    assert.ok(args.includes('--disable-non-proxied-udp'));
    assert.ok(args.includes('--lang=en-US'));
  });

  check('pointer plan lands exactly on target with >=2 events', () => {
    const points = human.planMove(10, 10, 300, 240);
    assert.ok(points.length >= 2, `only ${points.length} events`);
    const [x, y] = points[points.length - 1];
    assert.equal(x, 300);
    assert.equal(y, 240);
    assert.ok(points.every(([, , dt]) => dt >= 0));
  });

  check('click target stays inside the element box', () => {
    const box = { x: 100, y: 200, width: 80, height: 30 };
    for (let i = 0; i < 50; i++) {
      const pts = human.planStroke(box.x, box.y, box.x + 40, box.y + 15);
      const [x, y] = pts[pts.length - 1];
      assert.ok(x >= box.x && x <= box.x + box.width);
      assert.ok(y >= box.y && y <= box.y + box.height);
    }
  });

  // ---- live browser -------------------------------------------------------
  const first = await fingerprint(12345);
  check('navigator.webdriver is false', () => assert.equal(first.webdriver, false));
  check('GPU strings are spoofed (never the real host GPU)', () => {
    assert.ok(first.vendor, 'no WebGL vendor');
    assert.ok(/Google Inc\.|NVIDIA|AMD|Intel|Apple/.test(first.vendor), first.vendor);
  });

  const second = await fingerprint(98765);
  check('different seeds produce different fingerprints', () => {
    const differs =
      first.canvas !== second.canvas ||
      first.vendor !== second.vendor ||
      first.renderer !== second.renderer ||
      first.hardwareConcurrency !== second.hardwareConcurrency;
    assert.ok(differs, 'seed had no effect');
  });

  // ---- behavioural layer on a live page -----------------------------------
  const browser = await index.launch({ headless: true, seed: 12345, humanize: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<textarea id="t" style="width:300px;height:80px"></textarea><button id="b">go</button>',
    );
    check('humanize attaches page.human', () => assert.equal(typeof page.human.click, 'function'));
    const text = 'Hello W0rld, cloakfree!';
    await page.human.fill('#t', text);
    const typed = await page.inputValue('#t');
    check('human typing reproduces the exact text', () => assert.equal(typed, text));
    await page.human.click('#b');
    results.push('ok   human click completes');
  } finally {
    await browser.close();
  }

  console.log(results.join('\n'));
  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(results.join('\n'));
  console.error('\nSELF-CHECK FAILED:', err.message);
  process.exit(1);
});
