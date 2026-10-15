#!/usr/bin/env node
// Temporal stability probe: holds the camera still, captures consecutive output frames and measures how much each
// pixel flickers (second temporal difference |L(t) - (L(t-1) + L(t+1)) / 2|, which ignores slow drift such as cloud
// motion or the sun moving). Simulation time advances at a fixed 1/60 s per frame, as on a 60 Hz screen.
//   node tools/dev/flicker.mjs --setup='camera e=2639600 n=1159800 agl=1.7' --setup='camera yaw=1 pitch=-0.2' '' 'time.speed=0'
//   options: --width=1470 --height=830 --frames=48 --warm=90 --name=flicker (heat maps -> screenshots/<name>-<i>.png)
//   a variant is 'settings k=v ...' optionally followed by '| <js>' run in the page after the settings (app in scope)
//            --pan=<rad per frame> (slow camera yaw while capturing: tests shadow stability under camera motion;
//            the second difference then also measures motion judder, compare variants only)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opts = { setup: [] };
const variants = [];
for (const a of args) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m && m[1] === 'setup') opts.setup.push(m[2]);
  else if (m) opts[m[1]] = m[2] ?? true;
  else variants.push(a);
}
if (!variants.length) variants.push('');
const width = Number(opts.width || 1470), height = Number(opts.height || 830);
const frames = Number(opts.frames || 48), warm = Number(opts.warm || 90);
const name = opts.name || 'flicker';
const pan = Number(opts.pan || 0);
const parse = (v) => {
  if (v === 'true' || v === 'false') return v === 'true';
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
};
const kvs = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), parse(p.slice(p.indexOf('=') + 1))]));
const cmdArgs = (c) => {
  const [n, ...rest] = c.split(/\s+/);
  const a = {};
  for (const r of rest) {
    const i = r.indexOf('=');
    if (i > 0) a[r.slice(0, i)] = parse(r.slice(i + 1));
    else (a._ ||= []).push(parse(r));
  }
  return [n, a];
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mow-flicker-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir,
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--enable-dawn-features=allow_unsafe_apis', '--no-first-run'],
});
try {
  const page = await browser.newPage();
  await page.goto(`${opts.url || 'http://localhost:5173'}/?bench`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app?.engine?.frame > 60, { timeout: 90000, polling: 250 });
  const defaults = await page.evaluate(() => window.agent.run('get', {}));
  fs.mkdirSync('screenshots', { recursive: true });
  for (let vi = 0; vi < variants.length; vi++) {
    const [kvPart, js = ''] = variants[vi].split('|');
    const res = await page.evaluate(async (defaults, kv, js, setup, frames, warm, pan) => {
      const app = window.app, eng = app.engine;
      await window.agent.run('set', defaults);
      await window.agent.run('set', { 'render.dynamicResolution': false, 'render.forceDetail': 1 });
      for (const [n, a] of setup) await window.agent.run(n, a);
      await window.agent.run('set', kv);
      if (js.trim()) await new Function('app', `return (async () => { ${js} })()`)(app);
      eng.fixedDt = 1 / 60;
      const frame = () => new Promise((r) => eng.afterNextFrame(r));
      for (let i = 0; i < warm; i++) await frame();
      const c = eng.renderer.domElement;
      const w = c.width, h = c.height, N = w * h;
      const oc = new OffscreenCanvas(w, h);
      const g = oc.getContext('2d', { willReadFrequently: true });
      const acc = new Float32Array(N);
      let l0 = null, l1 = null, last = null;
      for (let f = 0; f < frames; f++) {
        if (pan) app.freeCam.setPose(app.freeCam.position, app.freeCam.yaw + pan, app.freeCam.pitch);
        await new Promise((r) => eng.afterNextFrame(() => { g.drawImage(c, 0, 0); r(); }));
        const d = g.getImageData(0, 0, w, h).data;
        const L = new Float32Array(N);
        for (let i = 0; i < N; i++) L[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
        if (l0 && l1) for (let i = 0; i < N; i++) acc[i] += Math.abs(l1[i] - 0.5 * (l0[i] + L[i]));
        l0 = l1; l1 = L; last = d;
      }
      eng.fixedDt = null;
      const n = frames - 2;
      let sum = 0, over2 = 0, over5 = 0;
      const sorted = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const v = acc[i] / n;
        sorted[i] = v; sum += v;
        if (v > 2) over2++;
        if (v > 5) over5++;
      }
      sorted.sort();
      // heat map: grey frame, flicker in red (x25: 10 levels/frame of second difference = saturated)
      const img = g.createImageData(w, h);
      for (let i = 0; i < N; i++) {
        const v = Math.min(1, (acc[i] / n) / 10);
        const grey = (0.299 * last[4 * i] + 0.587 * last[4 * i + 1] + 0.114 * last[4 * i + 2]) * 0.5;
        img.data[4 * i] = grey * (1 - v) + 255 * v;
        img.data[4 * i + 1] = grey * (1 - v);
        img.data[4 * i + 2] = grey * (1 - v);
        img.data[4 * i + 3] = 255;
      }
      const toB64 = async () => {
        const b = await oc.convertToBlob({ type: 'image/png' });
        const u8 = new Uint8Array(await b.arrayBuffer());
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s);
      };
      g.putImageData(img, 0, 0);
      const heat = await toB64();
      g.putImageData(new ImageData(last, w, h), 0, 0);
      const shot = await toB64();
      return {
        mean: +(sum / N).toFixed(3), p99: +sorted[Math.floor(N * 0.99)].toFixed(2), p999: +sorted[Math.floor(N * 0.999)].toFixed(2),
        over2: +((100 * over2) / N).toFixed(2), over5: +((100 * over5) / N).toFixed(3), heat, shot,
      };
    }, defaults, kvs(kvPart), js, opts.setup.map(cmdArgs), frames, vi === 0 ? warm * 4 : warm, pan); // first variant: the app is still settling (GI, shadows, streaming)
    fs.writeFileSync(`screenshots/${name}-${vi}-heat.png`, Buffer.from(res.heat, 'base64'));
    fs.writeFileSync(`screenshots/${name}-${vi}.png`, Buffer.from(res.shot, 'base64'));
    console.log(`[${vi}] ${variants[vi] || '(baseline)'}: mean ${res.mean}  p99 ${res.p99}  p99.9 ${res.p999}  >2: ${res.over2}%  >5: ${res.over5}%`);
  }
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
