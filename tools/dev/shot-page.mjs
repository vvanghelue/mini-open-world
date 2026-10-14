// Screenshot an arbitrary dev page: node tools/dev/shot-page.mjs /tree-lab.html out.png [w h]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import puppeteer from 'puppeteer-core';
const [url, out, w = '1600', h = '900'] = process.argv.slice(2);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-shot-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir,
  defaultViewport: { width: +w, height: +h, deviceScaleFactor: 1 }, args: ['--enable-unsafe-webgpu', '--no-first-run'] });
const page = await browser.newPage();
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5173' + url);
await page.waitForFunction(() => window.treeLab?.ready, { timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
console.log(JSON.stringify(await page.evaluate(() => window.treeLab?.info)), errs.slice(0, 3));
await page.screenshot({ path: out });
await browser.close();
