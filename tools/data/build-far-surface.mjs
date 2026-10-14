// Far-ring surface from the swisstopo SWISSIMAGE WMTS (20 m/px, LV95 tile matrix set):
//   far_albedo.jpg      4096^2 (20 m) de-lit colour over the 81.92 km far square
//   far_landcover.png   2048^2 (40 m) RGBA fractions: forest, grass, rock, snow
//   far_landcover2.png  2048^2 (40 m) RGBA fractions: water, urban, gravel, 255
// © swisstopo. Usage: node tools/data/build-far-surface.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FAR, CORE_CENTER } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RAW = path.join(ROOT, 'data-raw/wmts19');
const OUT = path.join(ROOT, 'public/data/terrain');
const Z = 19, RES = 20, TILE = 256, TILE_M = RES * TILE; // 5120 m
const ORIGIN_E = 2420000, ORIGIN_N = 1350000;
const M = 4096; // output colour size (20 m)
const L = 2048; // land cover size (40 m)

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const l2s = (c) => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
const LUT = new Float32Array(256).map((_, i) => s2l(i));

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const half = FAR.size / 2;
  const e0 = CORE_CENTER.e - half, n1 = CORE_CENTER.n + half; // top-left of far square
  const tx0 = Math.floor((e0 - ORIGIN_E) / TILE_M), tx1 = Math.floor((e0 + FAR.size - 1 - ORIGIN_E) / TILE_M);
  const ty0 = Math.floor((ORIGIN_N - n1) / TILE_M), ty1 = Math.floor((ORIGIN_N - (n1 - FAR.size) - 1) / TILE_M);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  log(`${jobs.length} WMTS tiles`);
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < jobs.length) {
      const [tx, ty] = jobs[i++];
      const f = path.join(RAW, `${tx}_${ty}.jpg`);
      if (fs.existsSync(f) && fs.statSync(f).size > 0) continue;
      const res = await fetch(`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/2056/${Z}/${tx}/${ty}.jpeg`);
      fs.writeFileSync(f, res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0));
    }
  }));

  // mosaic (20 m) aligned with the far square
  log('mosaic');
  const col = new Float32Array(M * M * 3);
  for (const [tx, ty] of jobs) {
    const f = path.join(RAW, `${tx}_${ty}.jpg`);
    if (!fs.existsSync(f) || fs.statSync(f).size === 0) continue;
    const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const te = ORIGIN_E + tx * TILE_M, tn = ORIGIN_N - ty * TILE_M;
    for (let r = 0; r < info.height; r++) {
      const y = Math.round((n1 - (tn - (r + 0.5) * RES)) / RES - 0.5);
      if (y < 0 || y >= M) continue;
      for (let c = 0; c < info.width; c++) {
        const x = Math.round((te + (c + 0.5) * RES - e0) / RES - 0.5);
        if (x < 0 || x >= M) continue;
        const s = (r * info.width + c) * 3, d = (y * M + x) * 3;
        col[d] = LUT[data[s]]; col[d + 1] = LUT[data[s + 1]]; col[d + 2] = LUT[data[s + 2]];
      }
    }
  }

  // heights from the far heightmap (40 m) for normals / de-lighting / classification
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json')));
  const q = new Uint16Array(fs.readFileSync(path.join(OUT, 'far_height.bin')).buffer.slice(0));
  const fr = meta.far.res, k = (meta.far.hMax - meta.far.hMin) / 65535;
  const H = (x, y) => meta.far.hMin + q[Math.min(fr - 1, Math.max(0, y)) * fr + Math.min(fr - 1, Math.max(0, x))] * k;
  const surface = JSON.parse(fs.readFileSync(path.join(OUT, 'surface.json')));
  const az = (surface.sunFit.az * Math.PI) / 180, el = (surface.sunFit.el * Math.PI) / 180;
  const Ls = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const { A, B, meanNL } = surface.shading;
  const ref = A + B * meanNL;
  const sp = meta.far.spacing;

  log('de-lighting');
  const albedo = Buffer.alloc(M * M * 3);
  const lc1 = new Float32Array(L * L * 4), lc2 = new Float32Array(L * L * 4);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const hx = x >> 1, hy = y >> 1;
    const dx = (H(hx + 1, hy) - H(hx - 1, hy)) / (2 * sp), dz = (H(hx, hy + 1) - H(hx, hy - 1)) / (2 * sp);
    const inv = 1 / Math.hypot(dx, 1, dz);
    const nl = Math.max(0, (-dx * Ls[0] + Ls[1] - dz * Ls[2]) * inv);
    const shade = (A + B * nl) / ref;
    const gain = Math.min(2.2, Math.max(0.6, 1 / Math.max(0.05, shade)));
    const o = (y * M + x) * 3;
    for (let c = 0; c < 3; c++) albedo[o + c] = l2s(col[o + c] * gain);
    // classification on the (raw) colour
    const r = albedo[o] , g = albedo[o + 1], b = albedo[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = (mx - mn) / Math.max(mx, 1);
    const exg = (2 * g - r - b) / (r + g + b + 1);
    const h = H(hx, hy), slope = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
    const flat = Math.abs(H(hx + 1, hy) - h) + Math.abs(H(hx - 1, hy) - h) + Math.abs(H(hx, hy + 1) - h) + Math.abs(H(hx, hy - 1) - h);
    let cls;
    if (lum < 3) cls = 1; // no data (outside Switzerland): grass, shader falls back to procedural colour
    else if (flat < 0.6 && slope < 1 && h < 2500 && (b >= r - 4 || g > r) && lum < 170) cls = 4;
    else if ((lum > 175 && sat < 0.2) || (h > 2300 && lum > 130 && sat < 0.16)) cls = 3;
    else if (exg > 0.03 && lum < 100 && h < 2250) cls = 0;
    else if (lum < 55 && h < 2000 && g >= r - 3) cls = 0;
    else if ((exg > 0.02 && lum >= 100) || (g > r && g > b && h < 2700 && lum >= 60)) cls = 1;
    else if (h < 1500 && slope < 12 && sat < 0.14 && lum > 90) cls = 5;
    else cls = 2;
    const lo = ((y >> 1) * L + (x >> 1)) * 4;
    if (cls < 4) lc1[lo + cls] += 0.25; else lc2[lo + cls - 4] += 0.25;
  }
  await sharp(albedo, { raw: { width: M, height: M, channels: 3 } }).jpeg({ quality: 88 }).toFile(path.join(OUT, 'far_albedo.jpg'));
  const toBytes = (src, alpha255) => {
    const out = Buffer.alloc(L * L * 4);
    for (let i2 = 0; i2 < L * L * 4; i2++) out[i2] = Math.round(Math.min(1, src[i2]) * 255);
    if (alpha255) for (let i2 = 0; i2 < L * L; i2++) out[i2 * 4 + 3] = 255;
    return out;
  };
  const b1 = toBytes(lc1, false), b2 = toBytes(lc2, true);
  fs.writeFileSync(path.join(OUT, 'far_landcover.bin'), Buffer.concat([b1, b2]));
  await sharp(b1, { raw: { width: L, height: L, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(OUT, 'far_landcover.png'));
  log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
