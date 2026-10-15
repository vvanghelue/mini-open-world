#!/usr/bin/env node
// Robust A/B performance comparison: one Chrome session, settings variants interleaved (A B C A B C ...) on the
// same camera path, so thermal throttling and background noise affect all variants equally.
//   node tools/ab.mjs --path=valley --seconds=4 --rounds=3 'forest.enabled=false' 'forest.enabled=true'
// Dynamic resolution is disabled unless --dyn (it would otherwise absorb the differences being measured).
// Each variant is a comma-separated list of settings (applied before its run). Reports mean frame ms per variant.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opts = {};
const variants = [];
for (const a of args) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) opts[m[1]] = m[2] ?? true;
  else variants.push(a);
}
if (variants.length < 1) {
  console.error("usage: node tools/ab.mjs [--path=valley] [--seconds=4] [--rounds=3] 'a.b=1' 'a.b=2'");
  process.exit(1);
}
const seconds = Number(opts.seconds || 4), rounds = Number(opts.rounds || 3), pathName = opts.path || 'valley';
const range = opts.range ? String(opts.range).split(',').map(Number) : undefined;
const width = Number(opts.width || 2560), height = Number(opts.height || 1440);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-ab-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir,
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'],
});
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app?.engine?.frame > 120, { timeout: 120000, polling: 250 });
  const parse = (v) => Object.fromEntries(v.split(',').filter(Boolean).map((s) => s.split('=')));
  const defaults = await page.evaluate(() => window.agent.run('get', {}));
  // warm-up run (shader compilation, JIT, GPU clocks)
  await page.evaluate((p, range) => window.agent.run('bench', { paths: [p], seconds: 3, warmup: 1, range }), pathName, range);
  const results = variants.map(() => []);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < variants.length; i++) {
      const res = await page.evaluate(async (defaults, kv, p, s, range, dyn) => {
        await window.agent.run('set', defaults); // reset every setting, then apply this variant
        if (!dyn) await window.agent.run('set', { 'render.dynamicResolution': false }); // fixed resolution: fair comparison
        await window.agent.run('set', kv);
        const out = await window.agent.run('bench', { paths: [p], seconds: s, warmup: 1, range });
        return out[p].frameMs;
      }, defaults, parse(variants[i]), pathName, seconds, range, !!opts.dyn);
      results[i].push(res.mean);
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
  const base = mean(results[0]);
  console.log(`path=${pathName} ${width}x${height} rounds=${rounds} seconds=${seconds}`);
  variants.forEach((v, i) => {
    const m = mean(results[i]);
    console.log(`${m.toFixed(2).padStart(6)} ms ±${sd(results[i]).toFixed(2)}  ${i ? ((m - base >= 0 ? '+' : '') + (m - base).toFixed(2)).padStart(6) : '  base'}  ${v}  [${results[i].map((x) => x.toFixed(2)).join(' ')}]`);
  });
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
