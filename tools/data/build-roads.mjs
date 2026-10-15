#!/usr/bin/env node
// Roads, tracks and hiking trails from OpenStreetMap (data-raw/osm/roads.json, see fetch-osm.mjs roads) -> ribbons
// draped on the DEM, per 1024 m tile: public/data/roads/roads.bin + index.json. Data © OpenStreetMap contributors.
//
// Polylines are resampled every 5 m; left/right edges get mitred offsets; heights from the DEM (+ a few cm), bridges
// as straight decks between their end heights, tunnels skipped. Width and surface from tags or per road type.
//
// Vertex (16 bytes): x, z i16 (1/32 m, relative to the tile centre) | y u16 (1/16 m) | normal x, z i8 |
//                    u u16 (distance along, 1/8 m, wraps) | v i8 (-127 left .. 127 right) | surface u8 | width u8 (dm) | flags u8
// Surfaces: 0 asphalt, 1 paved (stones/concrete), 2 gravel, 3 dirt trail. Flags: 1 = lane markings.
import fs from 'node:fs';
import path from 'node:path';
import { CORE, CORE_CENTER, wgs84ToLV95 } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'public/data/roads');
const TILE = 1024;
const NT = Math.ceil(CORE.size / TILE);
const STEP = 5;

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/terrain/meta.json'), 'utf8'));
const core = meta.core;
const hb = fs.readFileSync(path.join(ROOT, 'public/data/terrain/core_height.bin'));
const q = new Uint16Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const kH = (core.hMax - core.hMin) / 65535;
function heightAt(x, z) {
  const n = core.res;
  const fx = Math.min(Math.max((x / core.size + 0.5) * n - 0.5, 0), n - 1);
  const fz = Math.min(Math.max((z / core.size + 0.5) * n - 0.5, 0), n - 1);
  const x0 = Math.floor(fx), z0 = Math.floor(fz), x1 = Math.min(x0 + 1, n - 1), z1 = Math.min(z0 + 1, n - 1);
  const ax = fx - x0, az = fz - z0;
  const h = (i) => core.hMin + q[i] * kH;
  const a = h(z0 * n + x0) + (h(z0 * n + x1) - h(z0 * n + x0)) * ax;
  const b = h(z1 * n + x0) + (h(z1 * n + x1) - h(z1 * n + x0)) * ax;
  return a + (b - a) * az;
}

const WIDTH = {
  motorway: 11, trunk: 9, primary: 7.5, secondary: 6.5, tertiary: 6, motorway_link: 6, trunk_link: 6, primary_link: 6,
  secondary_link: 5.5, tertiary_link: 5, unclassified: 4.5, residential: 5, living_street: 4, service: 3.2,
  pedestrian: 4, track: 3, cycleway: 2, footway: 1.6, path: 1.1, bridleway: 1.4, steps: 1.6,
};
const MARKED = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link']);
const SURFACE = {
  asphalt: 0, paved: 0, concrete: 1, paving_stones: 1, sett: 1, cobblestone: 1, wood: 1, metal: 1,
  gravel: 2, fine_gravel: 2, compacted: 2, unpaved: 2, pebblestone: 2, rock: 3, ground: 3, dirt: 3, grass: 3, earth: 3, mud: 3,
};

const tiles = new Map();
function tileOf(x, z) {
  const tx = Math.min(NT - 1, Math.max(0, Math.floor((x + CORE.size / 2) / TILE)));
  const tz = Math.min(NT - 1, Math.max(0, Math.floor((z + CORE.size / 2) / TILE)));
  const key = tz * NT + tx;
  if (!tiles.has(key)) tiles.set(key, { tx, tz, v: [], idx: [] });
  return tiles.get(key);
}

const osm = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-raw/osm/roads.json'), 'utf8'));
let nWays = 0, nSkip = 0, totalLen = 0;
for (const el of osm.elements) {
  const t = el.tags || {};
  const hw = t.highway;
  if (!el.geometry || el.geometry.length < 2 || !(hw in WIDTH) || t.area === 'yes' || (t.tunnel && t.tunnel !== 'no')) { nSkip++; continue; }
  let pts = el.geometry.map((g) => {
    const { e, n } = wgs84ToLV95(g.lat, g.lon);
    return [e - CORE_CENTER.e, -(n - CORE_CENTER.n)];
  });
  if (pts.some((p) => Math.max(Math.abs(p[0]), Math.abs(p[1])) > CORE.size / 2 - 20)) { nSkip++; continue; }
  const wTag = parseFloat(t.width);
  const width = wTag > 0.5 && wTag < 30 ? wTag : WIDTH[hw];
  let surface = t.surface in SURFACE ? SURFACE[t.surface] : null;
  if (surface === null) {
    if (hw === 'track') surface = t.tracktype === 'grade1' ? 0 : 2;
    else if (hw === 'path' || hw === 'bridleway') surface = 3;
    else if (hw === 'footway' || hw === 'steps' || hw === 'cycleway') surface = heightAt(pts[0][0], pts[0][1]) < 900 ? 1 : 3;
    else surface = 0;
  }
  const marked = MARKED.has(hw) && surface === 0 ? 1 : 0;
  const bridge = t.bridge && t.bridge !== 'no';
  // resample
  const rs = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 1; k <= n; k++) rs.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  pts = rs.filter((p, i) => i === 0 || Math.hypot(p[0] - rs[i - 1][0], p[1] - rs[i - 1][1]) > 0.05);
  if (pts.length < 2) { nSkip++; continue; }
  // cumulative distance, heights
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = dist[dist.length - 1];
  totalLen += L;
  const h0 = heightAt(pts[0][0], pts[0][1]), h1 = heightAt(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  const lift = 0.06 + width * 0.01;
  nWays++;
  // emit quads per segment into the tile of the segment midpoint (consecutive vertices duplicated at tile changes)
  let prevTile = null, prevBase = -1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(pts.length - 1, i + 1)];
    let tx = pb[0] - pa[0], tz = pb[1] - pa[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // mitre: scale the offset by 1 / cos(half turn angle), capped
    let miter = 1;
    if (i > 0 && i < pts.length - 1) {
      const d1 = [p[0] - pa[0], p[1] - pa[1]], d2 = [pb[0] - p[0], pb[1] - p[1]];
      const l1 = Math.hypot(...d1) || 1, l2 = Math.hypot(...d2) || 1;
      const c = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2);
      miter = Math.min(1.6, 1 / Math.max(0.6, Math.sqrt((1 + c) / 2)));
    }
    const nx = -tz, nz = tx; // left normal (x, z)
    const hw2 = (width / 2) * miter;
    const T = tileOf(p[0], p[1]);
    const side = [];
    for (const sgn of [-1, 1]) {
      const x = p[0] + nx * hw2 * sgn, z = p[1] + nz * hw2 * sgn;
      const y = bridge ? h0 + ((h1 - h0) * dist[i]) / L + 0.6 : heightAt(x, z) + lift;
      const e = 1.5;
      const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const inv = 1 / Math.hypot(gx, 1, gz);
      side.push({ x, y, z, nx: bridge ? 0 : -gx * inv, nz: bridge ? 0 : -gz * inv, u: dist[i], v: sgn, surface, width, flags: marked });
    }
    if (T !== prevTile) {
      // start (or continue across a tile border with duplicated vertices)
      if (prevTile && prevBase >= 0) {
        // duplicate previous pair into the new tile so the segment is continuous
        const prevPair = prevTile.v.slice(prevTile.v.length - 2);
        T.v.push(...prevPair);
        prevBase = T.v.length - 2;
      } else prevBase = -1;
      prevTile = T;
    }
    const base = T.v.length;
    T.v.push(side[0], side[1]);
    // counter-clockwise seen from above (front faces up)
    if (prevBase >= 0) T.idx.push(prevBase, prevBase + 1, base, prevBase + 1, base + 1, base);
    prevBase = base;
  }
}

// ---------------------------------------------------------------- write
fs.mkdirSync(OUT, { recursive: true });
const STRIDE = 16;
const chunks = [];
const index = { tile: TILE, stride: STRIDE, attribution: '© OpenStreetMap contributors (ODbL)', tiles: [] };
let offset = 0, totalV = 0, totalT = 0;
for (const T of [...tiles.values()].sort((a, b) => a.tz * NT + a.tx - (b.tz * NT + b.tx))) {
  if (!T.idx.length) continue;
  const cx = -CORE.size / 2 + (T.tx + 0.5) * TILE, cz = -CORE.size / 2 + (T.tz + 0.5) * TILE;
  const vb = Buffer.alloc(T.v.length * STRIDE);
  let minY = Infinity, maxY = -Infinity;
  T.v.forEach((v, i) => {
    const o = i * STRIDE;
    vb.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v.x - cx) * 32))), o);
    vb.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v.z - cz) * 32))), o + 2);
    vb.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(v.y * 16))), o + 4);
    vb.writeInt8(Math.round(v.nx * 127), o + 6);
    vb.writeInt8(Math.round(v.nz * 127), o + 7);
    vb.writeUInt16LE(Math.round(v.u * 8) % 65536, o + 8);
    vb.writeInt8(v.v * 127, o + 10);
    vb.writeUInt8(v.surface, o + 11);
    vb.writeUInt8(Math.min(255, Math.round(v.width * 10)), o + 12);
    vb.writeUInt8(v.flags, o + 13);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  });
  const ib = Buffer.from(new Uint32Array(T.idx).buffer);
  index.tiles.push({ tx: T.tx, tz: T.tz, cx, cz, vOffset: offset, vCount: T.v.length, iOffset: offset + vb.length, iCount: T.idx.length, minY, maxY });
  chunks.push(vb, ib);
  offset += vb.length + ib.length;
  totalV += T.v.length; totalT += T.idx.length / 3;
}
fs.writeFileSync(path.join(OUT, 'roads.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
console.log(`roads: ${nWays} ways (${(totalLen / 1000).toFixed(0)} km), ${nSkip} skipped; ${index.tiles.length} tiles, ${totalV} vertices, ${totalT} triangles, ${(offset / 1e6).toFixed(1)} MB`);
