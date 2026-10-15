// Thermal throttling probe: the same fixed workload (governor off, fixed resolution, flyover path segment) measured
// repeatedly while the GPU is kept busy in between, then during a rest period. Prints elapsed time and frame mean.
//   node tools/dev/thermal.mjs [--load=300] [--rest=240] [--every=30]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import puppeteer from 'puppeteer-core';
const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const LOAD = Number(opts.load || 300), REST = Number(opts.rest || 240), EVERY = Number(opts.every || 30);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-th-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir,
  defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 }, protocolTimeout: 0,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.engine?.frame > 120, { timeout: 120000, polling: 250 });
await page.evaluate(() => window.agent.run('set', { 'render.dynamicResolution': false, 'render.resolutionScale': 0.6 }));
const t0 = Date.now();
const probe = () => page.evaluate(async () => (await window.agent.run('bench', { paths: ['flyover'], range: [0.3, 0.4], seconds: 4, warmup: 1 })).flyover.frameMs.mean);
const log = (phase, v) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s  ${phase.padEnd(5)} ${v.toFixed(2)} ms`);
log('cold', await probe());
// load phase: keep rendering the heavy walk path uncapped, probe every EVERY seconds
while ((Date.now() - t0) / 1000 < LOAD) {
  await page.evaluate((s) => window.agent.run('bench', { paths: ['walk'], seconds: s, warmup: 0.5 }), EVERY - 5);
  log('load', await probe());
}
// rest phase: pause rendering (engine paused + hidden work minimal), probe every EVERY seconds
await page.evaluate(() => window.agent.run('set', { 'render.paused': true }));
const tRest = Date.now();
while ((Date.now() - tRest) / 1000 < REST) {
  await page.evaluate(() => { window.app.engine.renderer.setAnimationLoop(null); });
  await new Promise((r) => setTimeout(r, (EVERY - 5) * 1000));
  await page.evaluate(() => { window.app.engine.start(); window.agent.run('set', { 'render.paused': false }); });
  log('rest', await probe());
  await page.evaluate(() => window.agent.run('set', { 'render.paused': true }));
}
await browser.close();
