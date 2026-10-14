// Counts frame-time spikes (>8 ms) over 3 s for a list of setting variants. Dev diagnostic.
//   node tools/dev/spikes.mjs 'time.speed=0' 'time.speed=0,shadows.terrainShadows=false'
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import puppeteer from 'puppeteer-core';
const variants = process.argv.slice(2);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-sp-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir,
  defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.engine?.frame > 200, { timeout: 120000, polling: 250 });
for (const v of variants.length ? variants : ['']) {
  const kv = v ? Object.fromEntries(v.split(',').map((s) => s.split('='))) : {};
  const res = await page.evaluate(async (kv) => {
    if (kv.__panel) { window.app.panel.element.style.display = kv.__panel === 'off' ? 'none' : ''; delete kv.__panel; }
    if (kv.__hud) { window.app.hud.element.style.display = kv.__hud === 'off' ? 'none' : ''; delete kv.__hud; }
    if (Object.keys(kv).length) await window.agent.run('set', kv);
    await new Promise((r) => setTimeout(r, 1500));
    const e = window.app.engine; const sp = []; let n = 0, sum = 0; let last = performance.now(); const t0 = performance.now();
    await new Promise((r) => { const tick = () => { const now = performance.now(); const d = now - last; n++; sum += d; if (d > 8) sp.push(+d.toFixed(1)); last = now; if (now - t0 < 3000) e.afterNextFrame(tick); else r(); }; e.afterNextFrame(tick); });
    return { frames: n, meanMs: +(sum / n).toFixed(2), spikes: sp.length, worst: Math.max(0, ...sp) };
  }, kv);
  console.log((v || '(default)').padEnd(60), JSON.stringify(res));
}
await browser.close();
