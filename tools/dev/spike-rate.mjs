// Frame-interval spikes of uncapped Chrome on an EMPTY WebGPU page (tools/dev/minimal.html), per second over 10 s.
// These spikes are independent of our rendering: at N fps they add (rate / N) of frames over 10 ms to any bench.
//   node tools/dev/spike-rate.mjs
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import puppeteer from 'puppeteer-core';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-er-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir,
  defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 }, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/tools/dev/minimal.html');
await new Promise((r) => setTimeout(r, 1500));
const res = await page.evaluate(async () => {
  // reuse the page's loop: sample intervals for 10 s via rAF timestamps
  const iv = []; let last = performance.now(); const t0 = last;
  await new Promise((r) => { const f = () => { const t = performance.now(); iv.push(t - last); last = t; if (t - t0 < 10000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
  const over = (x) => iv.filter((v) => v > x).length;
  return { seconds: 10, frames: iv.length, over8: over(8), over10: over(10), over12: over(12) };
});
console.log(JSON.stringify(res), `-> >10 ms spikes per second: ${(res.over10 / 10).toFixed(1)}; at 160 fps that is ${((res.over10 / 10 / 160) * 100).toFixed(1)} % of frames`);
await browser.close();
