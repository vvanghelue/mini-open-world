// Builds runtime terrain data from data-raw/ into public/data/terrain/.
//   core_height.bin   u16 [CORE.res^2]  heights, row 0 = north edge, col 0 = west edge
//   far_height.bin    u16 [FAR.res^2]   heights of the 81.92 km horizon square (core area included, box-filtered)
//   meta.json         sizes, height ranges, georeferencing
// Usage: node tools/data/build-terrain.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fromFile } from 'geotiff';
import { CORE, FAR, CORE_CENTER, lv95ToWGS84 } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RAW = path.join(ROOT, 'data-raw');
const OUT = path.join(ROOT, 'public/data/terrain');
fs.mkdirSync(OUT, { recursive: true });

const SRC_RES = 2; // swissALTI3D / SWISSIMAGE pixel size (m)
const SRC_N = CORE.size / SRC_RES; // 12288 source pixels per side

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- DEM mosaic (2 m)
export async function loadDemMosaic() {
  const dem = new Float32Array(SRC_N * SRC_N).fill(NaN);
  const tilesPerSide = Math.ceil(CORE.size / 1000);
  for (let ty = 0; ty < tilesPerSide; ty++) {
    for (let tx = 0; tx < tilesPerSide; tx++) {
      const ekm = CORE.e0 / 1000 + tx;
      const nkm = CORE.n0 / 1000 + ty;
      const file = path.join(RAW, 'swissalti3d', `${ekm}-${nkm}.tif`);
      if (!fs.existsSync(file)) continue;
      const img = await (await fromFile(file)).getImage();
      const [data] = await img.readRasters();
      const w = img.getWidth();
      // tile row 0 is its north edge; mosaic row 0 is the core north edge (tiles may overhang the core)
      const row0 = (CORE.size - (ty + 1) * 1000) / SRC_RES;
      const col0 = (tx * 1000) / SRC_RES;
      for (let r = 0; r < 500; r++) {
        const my = row0 + r;
        if (my < 0 || my >= SRC_N) continue;
        for (let c = 0; c < 500; c++) {
          const mx = col0 + c;
          if (mx >= SRC_N) break;
          const v = data[r * w + c];
          dem[my * SRC_N + mx] = v > -1000 ? v : NaN;
        }
      }
    }
  }
  // fill rare holes with nearest valid neighbour along rows, then columns
  let holes = 0;
  for (let i = 0; i < dem.length; i++) if (Number.isNaN(dem[i])) holes++;
  if (holes) {
    log(`filling ${holes} DEM holes`);
    for (let pass = 0; pass < 64 && holes; pass++) {
      holes = 0;
      for (let y = 0; y < SRC_N; y++) {
        for (let x = 0; x < SRC_N; x++) {
          const i = y * SRC_N + x;
          if (!Number.isNaN(dem[i])) continue;
          let s = 0, n = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= SRC_N || yy >= SRC_N) continue;
            const v = dem[yy * SRC_N + xx];
            if (!Number.isNaN(v)) { s += v; n++; }
          }
          if (n) dem[i] = s / n; else holes++;
        }
      }
    }
  }
  return dem;
}

// Exact box filter weights for resampling n_in -> n_out along one axis.
function boxWeights(nIn, nOut) {
  const ratio = nIn / nOut;
  const out = [];
  for (let i = 0; i < nOut; i++) {
    const a = i * ratio, b = (i + 1) * ratio;
    const taps = [];
    for (let j = Math.floor(a); j < Math.ceil(b); j++) {
      const w = Math.min(b, j + 1) - Math.max(a, j);
      if (w > 1e-6) taps.push([j, w / ratio]);
    }
    out.push(taps);
  }
  return out;
}

export function resampleBox(src, nIn, nOut, channels = 1) {
  const wts = boxWeights(nIn, nOut);
  const tmp = new Float32Array(nIn * nOut * channels); // horizontal pass: nIn rows x nOut cols
  for (let y = 0; y < nIn; y++) {
    for (let x = 0; x < nOut; x++) {
      for (let ch = 0; ch < channels; ch++) {
        let s = 0;
        for (const [j, w] of wts[x]) s += src[(y * nIn + j) * channels + ch] * w;
        tmp[(y * nOut + x) * channels + ch] = s;
      }
    }
  }
  const out = new Float32Array(nOut * nOut * channels);
  for (let y = 0; y < nOut; y++) {
    for (let x = 0; x < nOut; x++) {
      for (let ch = 0; ch < channels; ch++) {
        let s = 0;
        for (const [j, w] of wts[y]) s += tmp[(j * nOut + x) * channels + ch] * w;
        out[(y * nOut + x) * channels + ch] = s;
      }
    }
  }
  return out;
}

function encodeU16(heights) {
  let lo = Infinity, hi = -Infinity;
  for (const v of heights) { if (v < lo) lo = v; if (v > hi) hi = v; }
  lo = Math.floor(lo) - 1;
  hi = Math.ceil(hi) + 1;
  const q = new Uint16Array(heights.length);
  const k = 65535 / (hi - lo);
  for (let i = 0; i < heights.length; i++) q[i] = Math.round((heights[i] - lo) * k);
  return { q, min: lo, max: hi };
}

// ---------------------------------------------------------------- Copernicus sampler (WGS84 grid)
async function loadCopernicus() {
  const dir = path.join(RAW, 'copernicus');
  const tiles = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.tif'))) {
    const img = await (await fromFile(path.join(dir, f))).getImage();
    const [data] = await img.readRasters();
    const [lon0, lat0] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    tiles.push({ data, w: img.getWidth(), h: img.getHeight(), lon0, lat0, rx, ry });
  }
  return (lat, lon) => {
    for (const t of tiles) {
      const fx = (lon - t.lon0) / t.rx - 0.5;
      const fy = (lat - t.lat0) / t.ry - 0.5;
      if (fx < -0.5 || fy < -0.5 || fx > t.w - 0.5 || fy > t.h - 0.5) continue;
      const cx = Math.min(Math.max(fx, 0), t.w - 1), cy = Math.min(Math.max(fy, 0), t.h - 1);
      const x0 = Math.floor(cx), y0 = Math.floor(cy);
      const x1 = Math.min(x0 + 1, t.w - 1), y1 = Math.min(y0 + 1, t.h - 1);
      const ax = cx - x0, ay = cy - y0;
      const d = t.data;
      const top = d[y0 * t.w + x0] * (1 - ax) + d[y0 * t.w + x1] * ax;
      const bot = d[y1 * t.w + x0] * (1 - ax) + d[y1 * t.w + x1] * ax;
      return top * (1 - ay) + bot * ay;
    }
    return NaN;
  };
}

async function main() {
  log('loading DEM mosaic');
  const dem = await loadDemMosaic();

  log(`resampling core heights ${SRC_N} -> ${CORE.res}`);
  const core = resampleBox(dem, SRC_N, CORE.res);
  const coreEnc = encodeU16(core);
  fs.writeFileSync(path.join(OUT, 'core_height.bin'), Buffer.from(coreEnc.q.buffer));
  log(`core heights ${coreEnc.min}..${coreEnc.max} m`);

  // Far ring: Copernicus everywhere, core data box-filtered inside the core footprint,
  // with a smooth blend band so the far DSM meets the core DTM without a step.
  log('building far heightmap');
  const sample = await loadCopernicus();
  const farSpacing = FAR.size / FAR.res;
  const coreInFar = CORE.size / farSpacing; // 614.4 far texels
  const coreLow = resampleBox(dem, SRC_N, Math.round(coreInFar)); // ~40 m
  const nLow = Math.round(coreInFar);
  const far = new Float32Array(FAR.res * FAR.res);
  const half = FAR.size / 2;
  const blendBand = 1500; // metres outside the core edge where Copernicus is offset towards the core
  // Offset between core DTM and Copernicus DSM along the core border, to remove the seam.
  for (let y = 0; y < FAR.res; y++) {
    for (let x = 0; x < FAR.res; x++) {
      const e = CORE_CENTER.e - half + (x + 0.5) * farSpacing;
      const n = CORE_CENTER.n + half - (y + 0.5) * farSpacing;
      const { lat, lon } = lv95ToWGS84(e, n);
      let h = sample(lat, lon);
      if (Number.isNaN(h)) h = 500;
      // core contribution
      const cu = (e - CORE.e0) / CORE.size; // 0..1 west->east
      const cv = (CORE.n0 + CORE.size - n) / CORE.size; // 0..1 north->south
      if (cu > 0 && cu < 1 && cv > 0 && cv < 1) {
        const lx = Math.min(nLow - 1, Math.floor(cu * nLow));
        const ly = Math.min(nLow - 1, Math.floor(cv * nLow));
        h = coreLow[ly * nLow + lx];
      } else {
        // distance outside the core box (m)
        const dx = Math.max(CORE.e0 - e, 0, e - (CORE.e0 + CORE.size));
        const dy = Math.max(CORE.n0 - n, 0, n - (CORE.n0 + CORE.size));
        const d = Math.hypot(dx, dy);
        if (d < blendBand) {
          // nearest core border sample
          const ce = Math.min(Math.max(e, CORE.e0 + 1), CORE.e0 + CORE.size - 1);
          const cn = Math.min(Math.max(n, CORE.n0 + 1), CORE.n0 + CORE.size - 1);
          const lx = Math.min(nLow - 1, Math.floor(((ce - CORE.e0) / CORE.size) * nLow));
          const ly = Math.min(nLow - 1, Math.floor(((CORE.n0 + CORE.size - cn) / CORE.size) * nLow));
          const cb = coreLow[ly * nLow + lx];
          const { lat: la, lon: lo } = lv95ToWGS84(ce, cn);
          const offset = cb - sample(la, lo);
          const t = d / blendBand;
          const s = 1 - t * t * (3 - 2 * t);
          h += offset * s;
        }
      }
      far[y * FAR.res + x] = h;
    }
  }
  const farEnc = encodeU16(far);
  fs.writeFileSync(path.join(OUT, 'far_height.bin'), Buffer.from(farEnc.q.buffer));
  log(`far heights ${farEnc.min}..${farEnc.max} m`);

  const meta = {
    version: 1,
    core: { res: CORE.res, size: CORE.size, spacing: CORE.size / CORE.res, hMin: coreEnc.min, hMax: coreEnc.max, lv95: { e0: CORE.e0, n0: CORE.n0 } },
    far: { res: FAR.res, size: FAR.size, spacing: farSpacing, hMin: farEnc.min, hMax: farEnc.max },
    center: CORE_CENTER,
    convention: 'world x = E - center.e, world z = -(N - center.n); texel row 0 = north edge; u16 height = hMin + v/65535*(hMax-hMin)',
    attribution: '© swisstopo (swissALTI3D, SWISSIMAGE); Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA',
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  log('done');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
