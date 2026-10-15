// Builds surface data for the core area from SWISSIMAGE 2 m + swissALTI3D 2 m:
//   core_albedo.jpg     4096^2 (6 m) de-lit orthophoto colour (macro albedo, sRGB)
//   core_landcover.png  4096^2 RGBA fractions: R forest, G grass, B rock, A snow
//   core_landcover2.png 4096^2 RGBA fractions: R water, G urban, B gravel/soil, A 255
//   surface.json        de-lighting fit, class statistics
// Usage: node tools/data/build-surface.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fromFile } from 'geotiff';
import sharp from 'sharp';
import { CORE } from './geo.mjs';
import { loadDemMosaic } from './build-terrain.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RAW = path.join(ROOT, 'data-raw');
const OUT = path.join(ROOT, 'public/data/terrain');
const N = CORE.size / 2; // 12288 source pixels (2 m)
const M = 4096; // output (6 m)
const F = N / M; // 3
const FOREST_TEX = Number(process.env.FOREST_TEX || 9); // luminance std threshold separating canopy from fields
// Interlaken airfield (LSMI) runway, measured on SWISSIMAGE: SW threshold -> NE threshold (LV95)
const RUNWAYS = [[2633155, 1169038, 2634385, 1170283, 15, 110]].map(([e0, n0, e1, n1, hw, clear]) => {
  const len = Math.hypot(e1 - e0, n1 - n0);
  return { e0, n0, ue: (e1 - e0) / len, un: (n1 - n0) / len, len, halfWidth: hw, clearHalfWidth: clear };
});

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function loadOrtho() {
  const rgb = new Uint8Array(N * N * 3);
  const tiles = Math.ceil(CORE.size / 1000);
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const file = path.join(RAW, 'swissimage', `${CORE.e0 / 1000 + tx}-${CORE.n0 / 1000 + ty}.tif`);
      if (!fs.existsSync(file)) continue;
      const img = await (await fromFile(file)).getImage();
      const data = await img.readRGB({ interleave: true }); // tiles are JPEG/YCbCr: convert to RGB
      const w = img.getWidth();
      const row0 = (CORE.size - (ty + 1) * 1000) / 2;
      const col0 = (tx * 1000) / 2;
      for (let r = 0; r < 500; r++) {
        const my = row0 + r;
        if (my < 0 || my >= N) continue;
        for (let c = 0; c < 500; c++) {
          const mx = col0 + c;
          if (mx >= N) break;
          const s = (r * w + c) * 3, d = (my * N + mx) * 3;
          rgb[d] = data[s];
          rgb[d + 1] = data[s + 1];
          rgb[d + 2] = data[s + 2];
        }
      }
    }
  }
  return rgb;
}

const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const l2s = (c) => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
const LUT = new Float32Array(256).map((_, i) => s2l(i));

async function main() {
  log('loading DEM + ortho');
  const dem = await loadDemMosaic();
  const rgb = await loadOrtho();

  // ---- 6 m grids: linear colour, height, normal
  log('downsampling');
  const col = new Float32Array(M * M * 3);
  const hgt = new Float32Array(M * M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let r = 0, g = 0, b = 0, h = 0;
    for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
      const i = (y * F + dy) * N + x * F + dx;
      r += LUT[rgb[i * 3]]; g += LUT[rgb[i * 3 + 1]]; b += LUT[rgb[i * 3 + 2]];
      h += dem[i];
    }
    const k = 1 / (F * F), o = y * M + x;
    col[o * 3] = r * k; col[o * 3 + 1] = g * k; col[o * 3 + 2] = b * k;
    hgt[o] = h * k;
  }
  const sp = CORE.size / M;
  const nrm = new Float32Array(M * M * 3);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(M - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(M - 1, y + 1);
    const dx = (hgt[y * M + xp] - hgt[y * M + xm]) / ((xp - xm) * sp);
    const dz = (hgt[yp * M + x] - hgt[ym * M + x]) / ((yp - ym) * sp);
    const inv = 1 / Math.hypot(dx, 1, dz), o = (y * M + x) * 3;
    nrm[o] = -dx * inv; nrm[o + 1] = inv; nrm[o + 2] = -dz * inv;
  }

  // ---- fit the acquisition sun direction: maximise correlation(luminance, N.L) on a subsample
  log('fitting acquisition sun');
  const lumAt = (o) => 0.2126 * col[o * 3] + 0.7152 * col[o * 3 + 1] + 0.0722 * col[o * 3 + 2];
  const sample = [];
  for (let y = 8; y < M - 8; y += 7) for (let x = 8; x < M - 8; x += 7) sample.push(y * M + x);
  let best = { corr: -1, az: 0, el: 0 };
  for (let az = 60; az <= 300; az += 5) for (let el = 20; el <= 70; el += 5) {
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    const L = [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (const o of sample) {
      const nl = Math.max(0, nrm[o * 3] * L[0] + nrm[o * 3 + 1] * L[1] + nrm[o * 3 + 2] * L[2]);
      const lu = lumAt(o);
      sx += nl; sy += lu; sxx += nl * nl; syy += lu * lu; sxy += nl * lu;
    }
    const n = sample.length;
    const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    if (corr > best.corr) best = { corr, az, el };
  }
  log(`sun fit az=${best.az} el=${best.el} corr=${best.corr.toFixed(3)}`);
  const a = (best.az * Math.PI) / 180, e = (best.el * Math.PI) / 180;
  const L = [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];

  // ---- cast shadows for that sun (heightfield march at 6 m)
  log('cast shadows');
  const vis = new Float32Array(M * M);
  const horiz = Math.hypot(L[0], L[2]);
  const stepX = (L[0] / horiz), stepZ = (L[2] / horiz), tanE = L[1] / horiz;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const h0 = hgt[y * M + x] + 1;
    let lit = 1;
    let t = 1.5;
    while (t < 900) {
      const px = Math.round(x + stepX * t), py = Math.round(y + stepZ * t);
      if (px < 0 || py < 0 || px >= M || py >= M) break;
      const ray = h0 + t * sp * tanE;
      const d = hgt[py * M + px] - ray;
      if (d > 0) { lit = 0; break; }
      t += Math.max(1, t * 0.03);
    }
    vis[y * M + x] = lit;
  }
  // soften shadow edges (3x3 box) -> penumbra comparable to the photo blur
  const vis2 = new Float32Array(M * M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= M || yy >= M) continue;
      s += vis[yy * M + xx]; c++;
    }
    vis2[y * M + x] = s / c;
  }

  // ---- regression: lum = A + B * (N.L * vis)
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const o of sample) {
    const nl = Math.max(0, nrm[o * 3] * L[0] + nrm[o * 3 + 1] * L[1] + nrm[o * 3 + 2] * L[2]) * vis2[o];
    const lu = lumAt(o);
    sx += nl; sy += lu; sxx += nl * nl; sxy += nl * lu;
  }
  const n = sample.length;
  const B = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const A = (sy - B * sx) / n;
  const meanNL = sx / n;
  log(`shading model lum = ${A.toFixed(4)} + ${B.toFixed(4)} * NL*vis (mean NL*vis ${meanNL.toFixed(3)})`);

  // ---- de-lit albedo: divide by relative shading, clamp gain to limit noise amplification in deep shadows
  log('de-lighting');
  const ref = A + B * meanNL;
  const albedo = Buffer.alloc(M * M * 3);
  for (let o = 0; o < M * M; o++) {
    const nl = Math.max(0, nrm[o * 3] * L[0] + nrm[o * 3 + 1] * L[1] + nrm[o * 3 + 2] * L[2]) * vis2[o];
    const shade = (A + B * nl) / ref;
    const gain = Math.min(2.5, Math.max(0.6, 1 / Math.max(0.05, shade)));
    for (let c = 0; c < 3; c++) albedo[o * 3 + c] = l2s(col[o * 3 + c] * gain);
  }
  await sharp(albedo, { raw: { width: M, height: M, channels: 3 } }).jpeg({ quality: 90 }).toFile(path.join(OUT, 'core_albedo.jpg'));

  // ---- texture measure: luminance standard deviation of each 6 m block (3x3 source pixels). Forest canopies are
  // rough (crowns + shadows), meadows and fields are smooth: this separates dark-green fields from forest.
  log('texture');
  const blockStd = new Float32Array(M * M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let s1 = 0, s2 = 0;
    for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
      const i = (y * F + dy) * N + x * F + dx;
      const l = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      s1 += l; s2 += l * l;
    }
    const n9 = F * F;
    blockStd[y * M + x] = Math.sqrt(Math.max(0, s2 / n9 - (s1 / n9) ** 2));
  }
  // smooth the texture measure over 3x3 blocks (18 m) so single bushes don't flip the class
  const texStd = new Float32Array(M * M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= M || yy >= M) continue;
      s += blockStd[yy * M + xx]; c++;
    }
    texStd[y * M + x] = s / c;
  }

  // ---- land cover classification at 2 m, accumulated into 6 m fractions
  log('classifying');
  const lc1 = new Float32Array(M * M * 4);
  const lc2 = new Float32Array(M * M * 4);
  const counts = new Array(7).fill(0);
  const slopeM = new Float32Array(M * M); // mean slope (deg) per output cell
  for (let y = 0; y < N; y++) {
    const yu = Math.max(0, y - 1), yd = Math.min(N - 1, y + 1);
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = (mx - mn) / Math.max(mx, 1);
      const exg = (2 * g - r - b) / (r + g + b + 1);
      const h = dem[i];
      const xl = Math.max(0, x - 1), xr = Math.min(N - 1, x + 1);
      const gx = (dem[y * N + xr] - dem[y * N + xl]) / ((xr - xl) * 2);
      const gz = (dem[yd * N + x] - dem[yu * N + x]) / ((yd - yu) * 2);
      const slope = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
      // local flatness (lakes are perfectly flat in the DTM)
      const flat = Math.abs(dem[y * N + xr] - h) + Math.abs(dem[y * N + xl] - h) + Math.abs(dem[yd * N + x] - h) + Math.abs(dem[yu * N + x] - h);
      let cls; // 0 forest 1 grass 2 rock 3 snow 4 water 5 urban 6 gravel
      // water: perfectly flat in the DTM, dark or glacier-milk turquoise (Lake Brienz)
      if (flat < 0.04 && slope < 0.6 && ((lum < 105 && (b >= r - 4 || g > r)) || (lum < 170 && b > r + 10 && g > r + 10))) cls = 4;
      else if ((lum > 175 && sat < 0.2) || (lum > 135 && sat < 0.13 && h > 2200) || (h > 2300 && b > r + 6 && b >= g && sat < 0.35 && lum > 70)) cls = 3;
      // forest: dark green and either rough canopy texture or on a slope (fields are flat valley floors)
      else if (exg > 0.035 && lum < 100 && h < 2250 && slope < 55 && (texStd[(Math.floor(y / F)) * M + Math.floor(x / F)] > FOREST_TEX || slope > 12)) cls = 0;
      // deep shadow on slopes below the treeline: almost always forest in this region
      else if (lum < 55 && h < 2000 && slope < 45 && slope > 6 && g >= r - 3) cls = 0;
      else if ((exg > 0.02 && lum >= 100) || (g > r && g > b && h < 2700 && lum >= 60 && slope < 45)) cls = 1;
      else if (h < 1500 && slope < 15 && ((sat < 0.12 && lum > 80 && lum < 225) || (r > g + 20 && r > b + 25))) cls = 5;
      else if (sat > 0.08 && sat < 0.4 && r > g && g > b && lum > 90 && slope < 35) cls = 6;
      else cls = 2;
      // explicit overrides (world features the classifier cannot see reliably)
      const E = CORE.e0 + (x + 0.5) * 2, Nn = CORE.n0 + CORE.size - (y + 0.5) * 2;
      for (const rw of RUNWAYS) {
        const dx = E - rw.e0, dn = Nn - rw.n0;
        const along = (dx * rw.ue + dn * rw.un), across = Math.abs(-dx * rw.un + dn * rw.ue);
        if (along > -20 && along < rw.len + 20 && across < rw.halfWidth) cls = 5;
        // the airfield's grass areas: no forest (hedges / dark mown grass are misread as canopy)
        else if (cls === 0 && along > -150 && along < rw.len + 150 && across < rw.clearHalfWidth) cls = 1;
      }
      counts[cls]++;
      slopeM[Math.floor(y / F) * M + Math.floor(x / F)] += slope / (F * F);
      const o = (Math.floor(y / F) * M + Math.floor(x / F)) * 4;
      if (cls < 4) lc1[o + cls] += 1 / (F * F);
      else lc2[o + cls - 4] += 1 / (F * F);
    }
  }
  // forest clean-up on flat ground: gardens, hedges, single trees and building shadows read as "forest" and
  // dotted the valley floors and villages with conifers. Keep forest only where its ~65 m neighbourhood is mostly
  // wooded, and not inside built-up areas. Slopes are left alone (sparse larch meadows are real).
  {
    const boxAvg = (src, ch, r) => {
      const sat = new Float64Array((M + 1) * (M + 1));
      for (let y = 0; y < M; y++) {
        let row = 0;
        for (let x = 0; x < M; x++) {
          row += src[(y * M + x) * 4 + ch];
          sat[(y + 1) * (M + 1) + x + 1] = sat[y * (M + 1) + x + 1] + row;
        }
      }
      const out = new Float32Array(M * M);
      for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
        const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(M, x + r + 1), y1 = Math.min(M, y + r + 1);
        const sum = sat[y1 * (M + 1) + x1] - sat[y0 * (M + 1) + x1] - sat[y1 * (M + 1) + x0] + sat[y0 * (M + 1) + x0];
        out[y * M + x] = sum / ((x1 - x0) * (y1 - y0));
      }
      return out;
    };
    const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const forestAvg = boxAvg(lc1, 0, 5);
    const urbanAvg = boxAvg(lc2, 1, 8);
    let removed = 0;
    for (let o = 0; o < M * M; o++) {
      const f = lc1[o * 4];
      if (f <= 0) continue;
      const flat = ss(18, 8, slopeM[o]);
      const keep = ss(0.25, 0.5, forestAvg[o]) * (1 - ss(0.08, 0.25, urbanAvg[o]));
      const nf = f * (1 - flat + flat * keep);
      lc1[o * 4] = nf;
      lc1[o * 4 + 1] += f - nf; // becomes meadow
      removed += f - nf;
    }
    log(`forest clean-up: ${((removed / (M * M)) * 100).toFixed(2)} % of the area turned from forest to meadow`);
  }
  // 3x3 smoothing for soft transitions
  const smooth = (src) => {
    const out = new Uint8Array(M * M * 4);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= M || yy >= M) continue;
          const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          s += src[(yy * M + xx) * 4 + c] * w; k += w;
        }
        out[(y * M + x) * 4 + c] = Math.round(Math.min(1, s / k) * 255);
      }
    }
    return out;
  };
  const lcA = smooth(lc1);
  const lcB = smooth(lc2);
  for (let o = 0; o < M * M; o++) lcB[o * 4 + 3] = 255;
  // raw 2-layer array (layer 0 = lcA, layer 1 = lcB) for the GPU; PNGs kept for previews
  fs.writeFileSync(path.join(OUT, 'core_landcover.bin'), Buffer.concat([Buffer.from(lcA), Buffer.from(lcB)]));
  await sharp(Buffer.from(lcA), { raw: { width: M, height: M, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(OUT, 'core_landcover.png'));
  await sharp(Buffer.from(lcB), { raw: { width: M, height: M, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(OUT, 'core_landcover2.png'));

  const total = counts.reduce((s, v) => s + v, 0);
  const names = ['forest', 'grass', 'rock', 'snow', 'water', 'urban', 'gravel'];
  const stats = Object.fromEntries(names.map((k, i) => [k, +((counts[i] / total) * 100).toFixed(2)]));
  log('class %', stats);
  fs.writeFileSync(path.join(OUT, 'surface.json'), JSON.stringify({ res: M, sunFit: best, shading: { A, B, meanNL }, classPercent: stats }, null, 2));
  log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
