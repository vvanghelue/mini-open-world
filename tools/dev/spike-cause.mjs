// Records a Chrome performance trace while the app runs uncapped, marks every frame interval > 10 ms, and reports
// what overlapped each slow frame: V8 garbage collection, long main-thread tasks, or nothing on the main thread
// (then the delay is outside JS: GPU / compositor). Dev diagnostic.
//   node tools/dev/spike-cause.mjs [--path=walk] [--seconds=6] [--set=a=1,b=2]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import puppeteer from 'puppeteer-core';
const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-sc-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir, protocolTimeout: 0,
  defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 1 }, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--no-first-run'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/?bench', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.engine?.frame > 200, { timeout: 120000, polling: 250 });
if (opts.set) await page.evaluate((kv) => window.agent.run('set', kv), Object.fromEntries(String(opts.set).split(',').map((s) => s.split('='))));
const traceFile = path.join(os.tmpdir(), 'mow-spike-trace.json');
await page.tracing.start({ path: traceFile, categories: ['toplevel', 'devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing'] });
await page.evaluate(async (p, s) => {
  const e = window.app.engine; let last = performance.now();
  const stop = performance.now() + s * 1000;
  window.agent.run('bench', { paths: [p], seconds: s + 1, warmup: 0.5 });
  await new Promise((r) => { const tick = () => { const now = performance.now(); if (now - last > 10) performance.measure('slow', { start: last, end: now }); last = now; if (now < stop) e.afterNextFrame(tick); else r(); }; e.afterNextFrame(tick); });
}, opts.path || 'walk', Number(opts.seconds || 6));
await page.tracing.stop();
await browser.close();
const ev = JSON.parse(fs.readFileSync(traceFile, 'utf8')).traceEvents ?? JSON.parse(fs.readFileSync(traceFile, 'utf8'));
// frame boundaries from the trace itself (rAF callbacks on the renderer main thread; same clock as GC events)
const raf = ev.filter((x) => x.name === 'FireAnimationFrame' && x.ph === 'X').sort((a, b) => a.ts - b.ts);
const slow = [];
for (let i = 1; i < raf.length; i++) if (raf[i].ts - raf[i - 1].ts > 10000) slow.push([raf[i - 1].ts, raf[i].ts]);
console.log(`frames in trace: ${raf.length}`);
const gc = ev.filter((x) => /^(MinorGC|MajorGC|V8\.GC_SCAVENGER|V8\.GCScavenger|V8\.GCCompactor|V8\.GCFinalizeMC|V8\.GC_MC)/.test(x.name) && x.ph === 'X');
const mainTid0 = ev.find((x) => x.name === 'FireAnimationFrame')?.tid;
const tasks = ev.filter((x) => x.ph === 'X' && x.tid === mainTid0 && (x.name === 'RunTask' || x.name === 'ThreadControllerImpl::RunTask') && x.dur > 10000);
let withGc = 0, withLong = 0, none = 0, gcMs = 0;
for (const [a, b] of slow) {
  const g = gc.filter((x) => x.ts < b && x.ts + x.dur > a);
  const t = tasks.filter((x) => x.ts < b && x.ts + x.dur > a);
  if (g.length) { withGc++; gcMs += g.reduce((s, x) => s + x.dur, 0) / 1000; } else if (t.length) withLong++; else none++;
}
console.log(`slow frames (>10 ms): ${slow.length} in ${opts.seconds || 6} s | overlapping GC: ${withGc} (GC ${gcMs.toFixed(1)} ms total) | long main-thread task (>10 ms, no GC): ${withLong} | nothing on the main thread: ${none}`);
// main-thread busy share during slow frames vs all frames (RunTask durations clipped to each interval)
const mainTid = raf[0]?.tid;
const allTasks = ev.filter((x) => x.ph === 'X' && x.tid === mainTid && (x.name === 'RunTask' || x.name === 'ThreadControllerImpl::RunTask'));
const busy = (a, b) => allTasks.reduce((s, x) => s + Math.max(0, Math.min(b, x.ts + x.dur) - Math.max(a, x.ts)), 0) / (b - a);
const slowBusy = slow.map(([a, b]) => busy(a, b));
const allBusy = [];
{ const fr = ev.filter((x) => x.tid === mainTid && x.ph === 'X' && (x.name === 'RunTask' || x.name === 'ThreadControllerImpl::RunTask')); void fr; }
console.log(`main-thread task events: ${allTasks.length} | ts ranges: slow ${slow.length ? (slow[0][0] / 1e6).toFixed(2) + '..' + (slow[slow.length - 1][1] / 1e6).toFixed(2) : '-'} s, gc ${gc.length ? (gc[0].ts / 1e6).toFixed(2) + '..' + (gc[gc.length - 1].ts / 1e6).toFixed(2) : '-'} s, slow tid ${mainTid}, gc tids ${[...new Set(gc.map((x) => x.tid))].join(',')}`);
console.log(`main-thread busy during slow frames: mean ${((slowBusy.reduce((s, v) => s + v, 0) / Math.max(1, slowBusy.length)) * 100).toFixed(0)} % (CPU-bound if ~100 %, waiting on GPU/compositor if low)`);
console.log(`all GC in the trace: ${gc.length} events, ${(gc.reduce((s, x) => s + x.dur, 0) / 1000).toFixed(1)} ms, longest ${(Math.max(0, ...gc.map((x) => x.dur)) / 1000).toFixed(1)} ms`);
