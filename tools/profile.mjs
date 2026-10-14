#!/usr/bin/env node
// CPU profile of the running app in headless Chrome (uncapped frame rate) while following a bench path.
//   node tools/profile.mjs [--path=valley] [--seconds=6] [--top=40] [--width=2560 --height=1440]
// Prints the functions with the highest self time and writes bench-results/profile.cpuprofile
// (open it in Chrome DevTools > Performance to inspect).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const opts = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const base = opts.url || 'http://localhost:5173';
const width = Number(opts.width || 2560), height = Number(opts.height || 1440);
const seconds = Number(opts.seconds || 6);
const top = Number(opts.top || 40);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-prof-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir,
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--enable-dawn-features=allow_unsafe_apis', '--no-first-run'],
});
const page = await browser.newPage();
await page.goto(`${base}/?bench`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.engine?.frame > 200, { timeout: 120000, polling: 250 });
if (opts.set) {
  const kv = Object.fromEntries(String(opts.set).split(',').map((s) => s.split('=')));
  await page.evaluate((kv) => window.agent.run('set', kv), kv);
}
const client = await page.createCDPSession();
await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 100 });
const benchPromise = page.evaluate((p) => window.agent.run('bench', { paths: [p], warmup: 1 }), opts.path || 'valley');
await new Promise((r) => setTimeout(r, 1500));
await client.send('Profiler.start');
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await client.send('Profiler.stop');
const bench = await benchPromise;
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });

fs.mkdirSync(path.join(ROOT, 'bench-results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'bench-results', 'profile.cpuprofile'), JSON.stringify(profile));

// self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
const counts = new Map();
for (let i = 0; i < profile.samples.length; i++) counts.set(profile.samples[i], (counts.get(profile.samples[i]) || 0) + (dt[i] || 0));
let total = 0;
for (const [id, us] of counts) {
  const n = byId.get(id);
  const cf = n.callFrame;
  const url = cf.url.replace(/^.*\/(node_modules\/|src\/)/, '$1').replace(/\?.*$/, '');
  const key = `${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + us);
  total += us;
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
const frames = Object.values(bench)[0]?.frameMs?.n || 0;
console.log(`profile ${seconds}s, sampled ${(total / 1e6).toFixed(2)} s; frames in bench ${frames}`);
for (const [k, us] of rows) console.log(`${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`);
console.log(JSON.stringify(Object.values(bench)[0]?.frameMs), JSON.stringify(Object.values(bench)[0]?.cpuMs));
