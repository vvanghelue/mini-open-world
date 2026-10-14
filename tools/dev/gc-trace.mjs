// Correlates frame spikes with V8 GC events (--trace-gc). Dev diagnostic.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import puppeteer from 'puppeteer-core';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-gc-'));
const lines = [];
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir, dumpio: false,
  defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run', '--js-flags=--trace-gc'] });
const proc = browser.process();
proc.stdout.on('data', (d) => lines.push(...String(d).split('\n')));
proc.stderr.on('data', (d) => lines.push(...String(d).split('\n')));
const page = await browser.newPage();
await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.engine?.frame > 200, { timeout: 120000, polling: 250 });
lines.length = 0;
const res = await page.evaluate(async () => {
  const e = window.app.engine; const out = []; let last = performance.now(); const t0 = performance.now();
  await new Promise((r) => { const tick = () => { const now = performance.now(); if (now - last > 8) out.push([+(now - t0).toFixed(1), +(now - last).toFixed(1)]); last = now; if (now - t0 < 3000) e.afterNextFrame(tick); else r(); }; e.afterNextFrame(tick); });
  return out;
});
await browser.close();
console.log('spikes (t ms, interval):', JSON.stringify(res));
console.log(lines.filter((l) => /Scavenge|Mark-Compact|Mark-sweep|MinorMS/.test(l)).slice(0, 30).join('\n'));
