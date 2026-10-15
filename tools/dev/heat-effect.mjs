// Isolates the effect of heat on a measurement: the same bench (path, window size, settings) measured cool, right
// after a heat soak (uncapped 2560x1440 rendering), and after a rest. Dev diagnostic.
//   node tools/dev/heat-effect.mjs [--path=lake] [--width=1470 --height=830] [--soak=180] [--rest=120]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import puppeteer from 'puppeteer-core';
const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const P = opts.path || 'lake', W = Number(opts.width || 1470), H = Number(opts.height || 830);
const SOAK = Number(opts.soak || 180), REST = Number(opts.rest || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(w, h) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-he-'));
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir, protocolTimeout: 0,
    defaultViewport: { width: w, height: h, deviceScaleFactor: 1 }, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app?.engine?.frame > 120, { timeout: 120000, polling: 250 });
  return { browser, page };
}
async function measure(label) {
  const { browser, page } = await open(W, H);
  const r = await page.evaluate((p) => window.agent.run('bench', { paths: [p], seconds: 20, warmup: 2 }), P);
  await browser.close();
  const f = r[P].frameMs;
  console.log(`${label.padEnd(22)} ${P} ${W}x${H}: mean ${f.mean} ms, p95 ${f.p95} ms, >10 ms ${f.over10} %, res ${r[P].scale.mean} detail ${r[P].quality.mean}`);
}
await measure('cool');
{ // heat soak: continuous uncapped 2560x1440 walk
  const { browser, page } = await open(2560, 1440);
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < SOAK) await page.evaluate(() => window.agent.run('bench', { paths: ['walk'], seconds: 20, warmup: 0.5 }));
  await browser.close();
}
await measure(`after ${SOAK} s soak`);
await sleep(REST * 1000);
await measure(`after ${REST} s rest`);
