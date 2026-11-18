'use strict';
/**
 * Minimal end-to-end example: launch, read the fingerprint, drive the page like
 * a person, close.
 *
 *   node examples/basic.js            headless
 *   node examples/basic.js --headed   visible window
 */

const { launch } = require('..');

(async () => {
  const headless = !process.argv.includes('--headed');
  const browser = await launch({ headless, humanize: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    const fingerprint = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webdriver: navigator.webdriver,
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        memory: navigator.deviceMemory,
        screen: `${screen.width}x${screen.height}`,
        gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    });
    console.log('fingerprint:', fingerprint);

    await page.human.idle(1);
    await page.human.scroll(300);
    console.log('title:', await page.title());
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
