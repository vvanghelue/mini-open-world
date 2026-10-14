#!/usr/bin/env node
// Runs a sequence of agent commands in a dedicated headless Chrome (uncapped, 2560x1440 by default)
// and prints each result. Useful for screenshots and diagnostics without touching the user's browser.
//   node tools/run.mjs 'goto wengen' 'screenshot name=test' 'gpu-passes'
//   options: --width= --height= --wait=<ms before first command>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opts = {};
const cmds = [];
for (const a of args) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) opts[m[1]] = m[2] ?? true;
  else cmds.push(a);
}
const base = opts.url || 'http://localhost:5173';
const width = Number(opts.width || 2560), height = Number(opts.height || 1440);
const parse = (v) => {
  if (v === 'true' || v === 'false') return v === 'true';
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  if (/^[[{]/.test(v)) try { return JSON.parse(v); } catch {}
  return v;
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-run-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: opts.headful ? false : 'new',
  userDataDir,
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--enable-dawn-features=allow_unsafe_apis', '--no-first-run'],
});
try {
  const page = await browser.newPage();
  await page.goto(`${base}/?bench${opts.query ? '&' + opts.query : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app?.engine?.frame > 60, { timeout: 120000, polling: 250 });
  if (opts.wait) await new Promise((r) => setTimeout(r, Number(opts.wait)));
  for (const c of cmds) {
    const [name, ...rest] = c.split(/\s+/);
    let a = {};
    if (name === 'eval') a = { code: c.slice(5) };
    else if (rest.length === 1 && /^[[{]/.test(rest[0])) a = JSON.parse(rest[0]);
    else for (const r of rest) {
      const i = r.indexOf('=');
      if (i > 0) a[r.slice(0, i)] = parse(r.slice(i + 1));
      else (a._ ||= []).push(parse(r));
    }
    try {
      const res = await page.evaluate((n, a) => window.agent.run(n, a), name, a);
      console.log(`> ${c}\n${typeof res === 'string' ? res : JSON.stringify(res, null, 1)}`);
    } catch (e) {
      console.log(`> ${c}\nERROR ${e.message}`);
    }
  }
  const errs = await page.evaluate(() => window.agent.logs(0).filter((l) => l.level === 'error').slice(-5));
  if (errs.length) console.log('app errors:', JSON.stringify(errs, null, 1));
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
