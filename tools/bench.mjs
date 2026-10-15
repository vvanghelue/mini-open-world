#!/usr/bin/env node
// Performance benchmark in a real Chrome with vsync and frame-rate limit disabled.
//
//   node tools/bench.mjs [--paths=valley,flyover,walk] [--width=2560 --height=1440] [--headful]
//                        [--set=render.resolutionScale=0.6,terrain.lodDistance=300] [--shots]
//
// Requires the dev server (npm run dev). Results are printed and saved to bench-results/.
// Budget: frame p95 <= 10 ms (100 fps). Exit code 2 when over budget.
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
const width = Number(opts.width || 2560);
const height = Number(opts.height || 1440);
const BUDGET_MS = Number(opts.budget || 10);
const showTimeline = !!opts.timeline;
const CHROME = opts.chrome || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  try {
    await fetch(base);
  } catch {
    console.error(`dev server not reachable at ${base} — run "npm run dev" first`);
    process.exit(1);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-bench-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: opts.headful ? false : 'new',
    userDataDir,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    args: [
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=1',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--enable-unsafe-webgpu',
      '--enable-dawn-features=allow_unsafe_apis',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const t0 = Date.now();
  await page.goto(`${base}/?bench`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.app?.engine?.frame > 120, { timeout: 120000, polling: 250 });
  } catch (e) {
    const diag = await page.evaluate(() => ({
      loading: document.getElementById('loading-text')?.textContent,
      frame: window.app?.engine?.frame,
      logs: window.agent?.logs?.(0)?.slice(-8),
    }));
    console.error('app did not start:', JSON.stringify(diag, null, 2), errors.slice(0, 5));
    await browser.close();
    process.exit(1);
  }
  const loadSec = (Date.now() - t0) / 1000;

  if (opts.set) {
    const kv = Object.fromEntries(String(opts.set).split(',').map((s) => s.split('=')));
    await page.evaluate((kv) => window.agent.run('set', kv), kv);
  }
  const info = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return { adapter: a?.info ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null, dpr: devicePixelRatio, w: innerWidth, h: innerHeight };
  });
  const paths = opts.paths ? String(opts.paths).split(',') : undefined;
  const seconds = opts.seconds ? Number(opts.seconds) : undefined;
  const result = await page.evaluate((paths, seconds) => window.agent.run('bench', { paths, seconds }), paths, seconds);

  if (opts.shots) {
    for (const p of paths ?? Object.keys(result)) {
      await page.evaluate((p) => window.agent.run('eval', { code: `return 0` }), p);
    }
  }
  const settingsSnap = await page.evaluate(() => window.agent.run('get', {}));
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = { date: new Date().toISOString(), viewport: { width, height }, loadSec, info, result, errors: errors.slice(0, 20), settings: settingsSnap };
  fs.mkdirSync(path.join(ROOT, 'bench-results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'bench-results', `${stamp}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(ROOT, 'bench-results', `latest.json`), JSON.stringify(out, null, 2));

  let over = false;
  console.log(`viewport ${width}x${height}, load ${loadSec.toFixed(1)} s, GPU ${info.adapter?.description || info.adapter?.architecture || '?'}`);
  console.log('path      frame mean/p50/p95/p99 (ms)        fps  >10ms   cpu(js+wait)  draws   tris   res.dyn (mean/min)  detail');
  for (const [name, r] of Object.entries(result)) {
    const f = r.frameMs, c = r.cpuMs, g = r.gpuMs;
    if (!f) continue;
    if (f.p95 > BUDGET_MS) over = true;
    void g;
    console.log(
      `${name.padEnd(9)} ${f.mean.toFixed(2).padStart(6)} /${f.p50.toFixed(2).padStart(6)} /${f.p95.toFixed(2).padStart(6)} /${f.p99.toFixed(2).padStart(6)}   ${(1000 / f.mean).toFixed(0).padStart(4)}  ${(f.over10 ?? 0).toFixed(1).padStart(4)}%  ${c.mean.toFixed(2).padStart(8)}   ${String(r.drawCalls).padStart(5)}  ${(r.triangles / 1e6).toFixed(2)}M   ${r.scale ? `${r.scale.mean.toFixed(2)}/${r.scale.min.toFixed(2)}` : ''}  ${r.quality ? `     ${r.quality.mean.toFixed(2)}/${r.quality.min.toFixed(2)}` : ''}`,
    );
    if (showTimeline && r.timeline) console.log('   segments mean/p95: ' + r.timeline.map((t) => `${t.mean.toFixed(1)}/${t.p95.toFixed(0)}`).join('  '));
  }
  if (errors.length) console.log(`console errors (${errors.length}):\n  ` + errors.slice(0, 5).join('\n  '));
  console.log(over ? `OVER BUDGET (p95 > ${BUDGET_MS} ms)` : `within budget (p95 <= ${BUDGET_MS} ms)`);
  process.exit(over ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
