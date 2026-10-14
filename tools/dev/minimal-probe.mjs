import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import puppeteer from 'puppeteer-core';
const headless = process.argv[2] === 'headful' ? false : 'new';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-min-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless, userDataDir, defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run', '--window-size=2560,1440'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/tools/dev/minimal.html');
await new Promise(r => setTimeout(r, 1500));
console.log(headless ? 'headless' : 'headful', JSON.stringify(await page.evaluate(() => window.measure())));
await browser.close();
