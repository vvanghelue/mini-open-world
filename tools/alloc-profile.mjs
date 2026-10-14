#!/usr/bin/env node
// Allocation sampling profile (which functions allocate garbage every frame).
//   node tools/alloc-profile.mjs [--seconds=4] [--top=30]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const seconds = Number(opts.seconds || 4), top = Number(opts.top || 30);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-alloc-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir,
  defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.engine?.frame > 200, { timeout: 120000, polling: 250 });
const client = await page.createCDPSession();
await client.send('HeapProfiler.enable');
const f0 = await page.evaluate(() => window.app.engine.frame);
await client.send('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await client.send('HeapProfiler.stopSampling');
const frames = (await page.evaluate(() => window.app.engine.frame)) - f0;
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
const self = new Map();
let total = 0;
const walk = (n, stack) => {
  const cf = n.callFrame;
  const url = cf.url.replace(/^.*\/(node_modules\/|src\/)/, '$1').replace(/\?.*$/, '');
  const key = `${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + n.selfSize);
  total += n.selfSize;
  for (const c of n.children) walk(c, stack);
};
walk(profile.head, []);
console.log(`frames ${frames}, sampled ${(total / 1024 / 1024).toFixed(1)} MB → ${(total / frames / 1024).toFixed(1)} KB/frame`);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / frames / 1024).toFixed(2).padStart(7)} KB/f  ${k}`);
