#!/usr/bin/env node
'use strict';
/**
 * cloakfree CLI
 *
 *   node cli.js info                                  cached engine + paths
 *   node cli.js fetch [--force] [--build <ver>]       download the engine now
 *   node cli.js test                                  resolve engine, print a seed
 *   node cli.js token --url <page> [flags]            solve a Turnstile widget
 *
 * token flags: --sitekey <key>  --proxy <url>  --profile <dir>  --seed <n>
 *              --headless  --timeout <sec>
 */

const engine = require('./engine');

const argv = process.argv.slice(2);
const command = argv[0] || 'info';

function flag(name, fallback) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

(async () => {
  if (command === 'info') {
    console.log(JSON.stringify(engine.binaryInfo(), null, 2));
    return;
  }

  if (command === 'fetch') {
    console.log(await engine.ensureBinary({ force: flag('force', false) === true, version: flag('build') || undefined }));
    return;
  }

  if (command === 'test') {
    const index = require('./index');
    console.log(JSON.stringify({ executablePath: await engine.ensureBinary(), seed: index.randomSeed() }, null, 2));
    return;
  }

  if (command === 'token') {
    const url = flag('url');
    if (!url) throw new Error('token needs --url <page that hosts the widget>');
    const seed = flag('seed');
    const token = await require('./turnstile').solveTurnstile({
      pageUrl: url,
      siteKey: flag('sitekey'),
      proxy: flag('proxy'),
      userDataDir: flag('profile'),
      headless: flag('headless', false) === true,
      timeoutMs: Number(flag('timeout', 75)) * 1000,
      ...(seed ? { launchOptions: { seed: Number(seed) } } : {}),
    });
    console.log(token);
    return;
  }

  throw new Error(`unknown command: ${command}\ncommands: info, fetch, test, token`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
