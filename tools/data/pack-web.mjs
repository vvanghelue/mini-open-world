#!/usr/bin/env node
// Packs the runtime data of public/data/ for the static build (GitHub Pages demo): only the files the app loads, the
// large binaries as <file>.gz with a byte predictor that makes them compress well (decoded by src/core/data.ts),
// listed in data/web.json. ~580 MB of raw data becomes ~170 MB to download.
//   node tools/data/pack-web.mjs [outDir=dist]   -> <outDir>/data/...
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SRC = path.join(ROOT, 'public/data');
const OUT = path.join(path.resolve(ROOT, process.argv[2] ?? 'dist'), 'data');
const meta = JSON.parse(fs.readFileSync(path.join(SRC, 'terrain/meta.json'), 'utf8'));
const layers = JSON.parse(fs.readFileSync(path.join(SRC, 'textures/terrain_layers.json'), 'utf8'));

// file -> codec (see PackedFile in src/core/data.ts); null = copied as is
const FILES = {
  'terrain/meta.json': null,
  'terrain/core_height.bin': { codec: 'h16', w: meta.core.res },
  'terrain/far_height.bin': { codec: 'h16', w: meta.far.res },
  'terrain/core_albedo.jpg': null,
  'terrain/far_albedo.jpg': null,
  'terrain/core_landcover.bin': { codec: 'gz', w: 4096 },
  'terrain/far_landcover.bin': { codec: 'gz', w: 2048 },
  'textures/terrain_layers.json': null,
  'textures/terrain_albedo.bin': { codec: 'p4d', w: layers.res },
  'textures/terrain_normal.bin': { codec: 'p4d', w: layers.res },
  'trees/twigs.json': null,
  'trees/twig_albedo.png': null,
  'trees/twig_normal.png': null,
  'trees/bark_albedo.jpg': null,
  'trees/bark_normal.jpg': null,
  'buildings/index.json': null,
  'buildings/buildings.bin': { codec: 'gz', w: 0 },
  'buildings/footprints.bin': { codec: 'gz', w: 0 },
  'roads/index.json': null,
  'roads/roads.bin': { codec: 'gz', w: 0 },
};

function encode(codec, w, src) {
  if (codec === 'gz') return src;
  if (codec === 'h16') {
    const q = new Uint16Array(src.buffer, src.byteOffset, src.length / 2);
    const n = q.length;
    const out = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = i % w;
      const up = i >= w ? q[i - w] : 0;
      const pred = x === 0 ? up : i >= w ? q[i - 1] + up - q[i - w - 1] : q[i - 1];
      const d = ((q[i] - pred) << 16) >> 16; // residual wrapped to int16
      const z = ((d << 1) ^ (d >> 31)) & 0xffff; // zigzag
      out[i] = z & 255;
      out[n + i] = z >> 8;
    }
    return out;
  }
  // p4d
  const n = src.length / 4;
  const out = new Uint8Array(src.length);
  for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) out[k * n + i] = (src[i * 4 + k] - (i % w ? src[(i - 1) * 4 + k] : 0)) & 255;
  return out;
}

// same decoder as src/core/data.ts, to verify every packed file round-trips exactly
function decode(codec, w, src) {
  if (codec === 'gz') return src;
  if (codec === 'h16') {
    const n = src.length / 2;
    const q = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const z = src[i] | (src[n + i] << 8);
      const d = (z >>> 1) ^ -(z & 1);
      const x = i % w;
      const up = i >= w ? q[i - w] : 0;
      const pred = x === 0 ? up : i >= w ? q[i - 1] + up - q[i - w - 1] : q[i - 1];
      q[i] = (pred + d) & 0xffff;
    }
    return new Uint8Array(q.buffer);
  }
  const n = src.length / 4;
  const out = new Uint8Array(src.length);
  for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) out[i * 4 + k] = (src[k * n + i] + (i % w ? out[(i - 1) * 4 + k] : 0)) & 255;
  return out;
}

const t0 = Date.now();
const manifest = {};
let raw = 0, total = 0;
for (const [file, pack] of Object.entries(FILES)) {
  const src = fs.readFileSync(path.join(SRC, file));
  const dst = path.join(OUT, file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  raw += src.length;
  if (!pack) {
    fs.copyFileSync(path.join(SRC, file), dst);
    total += src.length;
    continue;
  }
  const enc = encode(pack.codec, pack.w, new Uint8Array(src.buffer, src.byteOffset, src.length));
  if (!Buffer.from(decode(pack.codec, pack.w, enc)).equals(src)) throw new Error(`${file}: round trip failed`);
  const gz = zlib.gzipSync(enc, { level: 9 });
  fs.writeFileSync(dst + '.gz', gz);
  manifest[file] = { ...pack, packed: gz.length };
  total += gz.length;
  console.log(`${file.padEnd(30)} ${(src.length / 1e6).toFixed(1).padStart(6)} MB -> ${(gz.length / 1e6).toFixed(1).padStart(5)} MB (${pack.codec})`);
}
fs.writeFileSync(path.join(OUT, 'web.json'), JSON.stringify(manifest, null, 1));
console.log(`packed ${(raw / 1e6).toFixed(0)} MB -> ${(total / 1e6).toFixed(0)} MB in ${OUT} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
