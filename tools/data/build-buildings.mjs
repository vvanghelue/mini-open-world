#!/usr/bin/env node
// Buildings from OpenStreetMap footprints (data-raw/osm/buildings.json, see fetch-osm.mjs) -> merged meshes per
// 1024 m tile: public/data/buildings/buildings.bin + index.json. Data © OpenStreetMap contributors (ODbL).
//
// Near-rectangular footprints become Swiss-style gabled houses (oriented min-area rectangle, ridge along the long
// side, overhanging eaves); other shapes are extruded with a flat roof. Heights from OSM tags when present, else per
// building type. Walls reach below the lowest terrain point (slopes). Roof colour is taken from the de-lit
// orthophoto at the footprint; walls are plaster in the valley towns and wood for chalets, barns and huts.
//
// Vertex (24 bytes): position f32x3 | normal i8x4 | colour u8x4 (sRGB albedo, a = style) | wall uv i16x2 (1/8 m)
// Styles: 0 roof, 1 plaster wall (windows), 2 chalet wood wall (windows), 3 barn wall, 4 plain wall
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ShapeUtils, Vector2 } from 'three';
import { CORE, CORE_CENTER, wgs84ToLV95 } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'public/data/buildings');
const TILE = 1024;
const NT = Math.ceil(CORE.size / TILE);

// ------------------------------------------------------------------ inputs
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
const alb = await sharp(path.join(ROOT, 'public/data/terrain/core_albedo.jpg')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const AW = alb.info.width;
function orthoColour(x, z, r) {
  // mean sRGB over a small square (the roof), skipping very dark texels (shadows)
  let s = [0, 0, 0], n = 0;
  const px = (v) => Math.floor((v / CORE.size + 0.5) * AW);
  const steps = 3;
  for (let i = -steps; i <= steps; i++) for (let j = -steps; j <= steps; j++) {
    const X = px(x + (i / steps) * r), Z = px(z + (j / steps) * r);
    if (X < 0 || Z < 0 || X >= AW || Z >= AW) continue;
    const o = (Z * AW + X) * 3;
    const l = alb.data[o] + alb.data[o + 1] + alb.data[o + 2];
    if (l < 60) continue;
    s[0] += alb.data[o]; s[1] += alb.data[o + 1]; s[2] += alb.data[o + 2]; n++;
  }
  return n ? s.map((v) => v / n) : [90, 80, 75];
}

let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ------------------------------------------------------------------ building rules
const TYPES = {
  residential: { eaves: 6.2, pitch: 24 }, house: { eaves: 5.8, pitch: 26 }, detached: { eaves: 5.8, pitch: 26 },
  yes: { eaves: 6.0, pitch: 24 }, apartments: { eaves: 12, pitch: 20 }, hotel: { eaves: 14, pitch: 22 },
  barn: { eaves: 4.8, pitch: 25, style: 3 }, farm_auxiliary: { eaves: 4.2, pitch: 25, style: 3 }, stable: { eaves: 4.2, pitch: 25, style: 3 },
  farm: { eaves: 6.0, pitch: 25, style: 2 }, cabin: { eaves: 3.2, pitch: 26, style: 2 }, hut: { eaves: 2.8, pitch: 26, style: 2 },
  shed: { eaves: 2.6, pitch: 20, style: 3 }, garage: { eaves: 2.7, pitch: 12, style: 4 }, garages: { eaves: 2.7, pitch: 0, style: 4 },
  carport: { eaves: 2.5, pitch: 0, style: 4 }, service: { eaves: 3.0, pitch: 15, style: 4 },
  commercial: { eaves: 9, pitch: 0, style: 1 }, retail: { eaves: 7, pitch: 0, style: 1 }, industrial: { eaves: 8, pitch: 0, style: 4 },
  warehouse: { eaves: 8, pitch: 0, style: 4 }, church: { eaves: 11, pitch: 38, style: 1 }, chapel: { eaves: 6, pitch: 38, style: 1 },
  school: { eaves: 9, pitch: 18, style: 1 }, public: { eaves: 9, pitch: 18, style: 1 }, train_station: { eaves: 6, pitch: 15, style: 1 },
};
const WOOD = [[118, 78, 48], [104, 68, 42], [132, 90, 56], [92, 62, 40]];
const BARN = [[88, 62, 44], [100, 74, 52], [78, 58, 42], [110, 88, 66]];
const PLASTER = [[204, 197, 182], [194, 187, 173], [210, 204, 193], [202, 186, 162], [186, 181, 174], [212, 200, 178]];
const PLAIN = [[190, 186, 178], [170, 166, 160], [200, 196, 188]];

function parseHeight(tags) {
  const h = parseFloat(tags.height);
  if (h > 2 && h < 80) return h;
  const l = parseFloat(tags['building:levels']);
  if (l > 0 && l < 25) return l * 3 + 0.6;
  return null;
}

// ------------------------------------------------------------------ geometry helpers
const tiles = new Map(); // key -> { v: number[] (floats & ints packed later), idx: number[] }
function tileOf(x, z) {
  const tx = Math.min(NT - 1, Math.max(0, Math.floor((x + CORE.size / 2) / TILE)));
  const tz = Math.min(NT - 1, Math.max(0, Math.floor((z + CORE.size / 2) / TILE)));
  const key = tz * NT + tx;
  if (!tiles.has(key)) tiles.set(key, { tx, tz, verts: [], idx: [] });
  return tiles.get(key);
}
function emitQuad(T, p, n, col, style, uvs) {
  // p: 4 corners [x,y,z] counter-clockwise seen from the normal side
  const base = T.verts.length;
  for (let i = 0; i < 4; i++) T.verts.push({ p: p[i], n, c: col, s: style, uv: uvs ? uvs[i] : [0, 0] });
  T.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function emitTri(T, p, n, col, style, uvs) {
  const base = T.verts.length;
  for (let i = 0; i < 3; i++) T.verts.push({ p: p[i], n, c: col, s: style, uv: uvs ? uvs[i] : [0, 0] });
  T.idx.push(base, base + 1, base + 2);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const faceNormal = (p0, p1, p2) => norm(cross(sub(p1, p0), sub(p2, p0)));

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q2 = pts[(i + 1) % pts.length]; a += p[0] * q2[1] - q2[0] * p[1]; }
  return a / 2; // signed, (x, z) plane
}
function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const v of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop(); lo.push(v); }
  for (let i = p.length - 1; i >= 0; i--) { const v = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], v) <= 0) up.pop(); up.push(v); }
  up.pop(); lo.pop();
  return lo.concat(up);
}
function minAreaRect(pts) {
  const h = convexHull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ez = b[1] - a[1], l = Math.hypot(ex, ez);
    if (l < 1e-6) continue;
    const ux = ex / l, uz = ez / l; // axis u, axis v = (-uz, ux)
    let mnU = Infinity, mxU = -Infinity, mnV = Infinity, mxV = -Infinity;
    for (const p of h) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      mnU = Math.min(mnU, u); mxU = Math.max(mxU, u); mnV = Math.min(mnV, v); mxV = Math.max(mxV, v);
    }
    const area = (mxU - mnU) * (mxV - mnV);
    if (!best || area < best.area) best = { area, ux, uz, mnU, mxU, mnV, mxV };
  }
  const cu = (best.mnU + best.mxU) / 2, cv = (best.mnV + best.mxV) / 2;
  let hu = (best.mxU - best.mnU) / 2, hv = (best.mxV - best.mnV) / 2;
  let ax = [best.ux, best.uz], bx = [-best.uz, best.ux];
  if (hv > hu) { [hu, hv] = [hv, hu]; [ax, bx] = [bx, [-ax[0], -ax[1]]]; }
  const c = [cu * best.ux - cv * best.uz, cu * best.uz + cv * best.ux];
  return { c, ax, bx, hl: hu, hw: hv, area: best.area };
}
function simplify(pts) {
  // drop near-duplicate and near-collinear vertices
  let out = pts.slice();
  for (let pass = 0; pass < 3; pass++) {
    const r = [];
    for (let i = 0; i < out.length; i++) {
      const p = out[(i - 1 + out.length) % out.length], c = out[i], n = out[(i + 1) % out.length];
      const e1 = [c[0] - p[0], c[1] - p[1]], e2 = [n[0] - c[0], n[1] - c[1]];
      const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
      if (l1 < 0.4) continue;
      const cos = (e1[0] * e2[0] + e1[1] * e2[1]) / (l1 * l2 || 1);
      if (cos > 0.99) continue; // < ~8 degrees turn
      r.push(c);
    }
    if (r.length < 3) break;
    out = r;
  }
  return out;
}

// ------------------------------------------------------------------ build
const osm = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-raw/osm/buildings.json'), 'utf8'));
let nGable = 0, nFlat = 0, nSkip = 0;
const footprints = []; // collision outlines (x, z) for the walker
for (const el of osm.elements) {
  const tags = el.tags || {};
  const type = tags.building;
  if (!el.geometry || el.geometry.length < 4 || type === 'roof' || type === 'construction' || type === 'ruins') { nSkip++; continue; }
  let pts = el.geometry.map((g) => {
    const { e, n } = wgs84ToLV95(g.lat, g.lon);
    return [e - CORE_CENTER.e, -(n - CORE_CENTER.n)];
  });
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.01) pts.pop();
  pts = simplify(pts);
  if (pts.length < 3) { nSkip++; continue; }
  if (polyArea(pts) < 0) pts.reverse(); // CCW in (x, z)
  const area = Math.abs(polyArea(pts));
  if (area < 6 || area > 40000) { nSkip++; continue; }
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  if (Math.max(Math.abs(cx), Math.abs(cz)) > CORE.size / 2 - 50) { nSkip++; continue; }

  const def = TYPES[type] || TYPES.yes;
  const hs = pts.map((p) => heightAt(p[0], p[1]));
  const hMin = Math.min(...hs, heightAt(cx, cz)), hMax = Math.max(...hs), hAvg = hs.reduce((a, b) => a + b, 0) / hs.length;
  let eaves = parseHeight(tags) ?? def.eaves * (0.9 + rnd() * 0.25);
  if (!parseHeight(tags) && (type === 'yes' || type === 'residential') && area > 450) eaves += area > 1200 ? 6 : 3;
  const eaveY = Math.max(hAvg + eaves, hMax + 2.3);
  const baseY = hMin - 1.5;

  // style & colours
  let style = def.style ?? 1;
  if (style === 1 && (type === 'yes' || type === 'residential' || type === 'house' || type === 'detached') && (hAvg > 950 ? rnd() < 0.75 : rnd() < 0.08)) style = 2;
  const pal = style === 2 ? WOOD : style === 3 ? BARN : style === 4 ? PLAIN : PLASTER;
  const wall = pal[Math.floor(rnd() * pal.length)];
  const T = tileOf(cx, cz);

  const rect = minAreaRect(pts);
  const rectness = area / (4 * rect.hl * rect.hw);
  const roofShape = tags['roof:shape'];
  const pitchDeg = roofShape === 'flat' ? 0 : def.pitch;
  const gable = pitchDeg > 0 && rectness > 0.82 && rect.hw > 1.5 && rect.hw < 22 && roofShape !== 'flat';
  const roofR = Math.min(rect.hw, rect.hl) * 0.6;
  let rc = orthoColour(rect.c[0], rect.c[1], roofR);
  // ortho roof colours are hazy: darken / desaturate slightly towards typical roof tones
  const rl = (rc[0] + rc[1] + rc[2]) / 3;
  rc = rc.map((v) => Math.max(20, Math.min(200, (v * 0.75 + rl * 0.25) * 0.85)));

  if (gable) {
    nGable++;
    const { c, ax, bx, hl, hw } = rect;
    footprints.push([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => [c[0] + ax[0] * hl * su + bx[0] * hw * sv, c[1] + ax[1] * hl * su + bx[1] * hw * sv]));
    const tanP = Math.tan((pitchDeg * Math.PI) / 180);
    const ridgeY = eaveY + hw * tanP;
    const o = Math.min(1.1, 0.35 + hw * 0.08); // eave overhang
    const P = (u, v, y) => [c[0] + ax[0] * u + bx[0] * v, y, c[1] + ax[1] * u + bx[1] * v];
    // wall faces must point away from the house centre (front side, the only one drawn): reverse when they do not
    const outward = (pts, uvs) => {
      const m = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[2] / pts.length], [0, 0]);
      const n = faceNormal(pts[0], pts[1], pts[2]);
      if (n[0] * (m[0] - c[0]) + n[2] * (m[1] - c[1]) >= 0) return [pts, n, uvs];
      return [pts.slice().reverse(), [-n[0], -n[1], -n[2]], uvs.slice().reverse()];
    };
    // walls (long sides at v = +-hw, ends at u = +-hl); wall uv: u along the wall, v = height above eave base
    const wallQuad = (u0, v0, u1, v1) => {
      const a = P(u0, v0, baseY), b = P(u1, v1, baseY), d = P(u1, v1, eaveY), e = P(u0, v0, eaveY);
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const [quad, n, uv] = outward([a, b, d, e], [[0, baseY - hAvg], [len, baseY - hAvg], [len, eaveY - hAvg], [0, eaveY - hAvg]]);
      emitQuad(T, quad, n, wall, style, uv);
    };
    wallQuad(-hl, -hw, hl, -hw);
    wallQuad(hl, -hw, hl, hw);
    wallQuad(hl, hw, -hl, hw);
    wallQuad(-hl, hw, -hl, -hw);
    // gable triangles at both ends
    for (const s of [1, -1]) {
      const a = P(s * hl, -s * hw, eaveY), b = P(s * hl, s * hw, eaveY), d = P(s * hl, 0, ridgeY);
      const [tri, n, uv] = outward([a, b, d], [[0, eaveY - hAvg], [2 * hw, eaveY - hAvg], [hw, ridgeY - hAvg]]);
      emitTri(T, tri, n, wall, style, uv);
    }
    // roof slopes with overhang (+ dark undersides)
    const lu = hl + o, ev = hw + o, ey = eaveY - o * tanP;
    for (const s of [1, -1]) {
      const r0 = P(-lu * s, 0, ridgeY), r1 = P(lu * s, 0, ridgeY), e1 = P(lu * s, ev * s, ey), e0 = P(-lu * s, ev * s, ey);
      // CCW seen from above-outside
      const quad = s > 0 ? [e0, e1, r1, r0] : [e0, e1, r1, r0];
      let n = faceNormal(quad[0], quad[1], quad[2]);
      if (n[1] < 0) { quad.reverse(); n = faceNormal(quad[0], quad[1], quad[2]); }
      emitQuad(T, quad, n, rc, 0);
      const under = quad.slice().reverse();
      emitQuad(T, under, [-n[0], -n[1], -n[2]], [40, 34, 30], 4);
    }
  } else {
    nFlat++;
    footprints.push(pts);
    const roofY = eaveY;
    // walls
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
      const a = [p0[0], baseY, p0[1]], b = [p1[0], baseY, p1[1]], d = [p1[0], roofY, p1[1]], e = [p0[0], roofY, p0[1]];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      // CCW footprint in (x, z) with +z south: outward normal = (dz, -dx) -> wind so the face normal points out
      const n = norm([p1[1] - p0[1], 0, -(p1[0] - p0[0])]);
      const fn = faceNormal(a, b, d);
      const quad = fn[0] * n[0] + fn[2] * n[2] > 0 ? [a, b, d, e] : [b, a, e, d];
      const uv = fn[0] * n[0] + fn[2] * n[2] > 0 ? [[u, baseY - hAvg], [u + len, baseY - hAvg], [u + len, roofY - hAvg], [u, roofY - hAvg]] : [[u + len, baseY - hAvg], [u, baseY - hAvg], [u, roofY - hAvg], [u + len, roofY - hAvg]];
      emitQuad(T, quad, n, wall, style, uv);
      u += len;
    }
    // flat roof
    const tris = ShapeUtils.triangulateShape(pts.map((p) => new Vector2(p[0], p[1])), []);
    const flatCol = rc.map((v) => v * 0.9);
    for (const [i0, i1, i2] of tris) {
      let tri = [[pts[i0][0], roofY, pts[i0][1]], [pts[i1][0], roofY, pts[i1][1]], [pts[i2][0], roofY, pts[i2][1]]];
      if (faceNormal(...tri)[1] < 0) tri = [tri[0], tri[2], tri[1]];
      emitTri(T, tri, [0, 1, 0], flatCol, 0);
    }
  }
}

// ------------------------------------------------------------------ write
fs.mkdirSync(OUT, { recursive: true });
const STRIDE = 24;
const chunks = [];
const index = { tile: TILE, stride: STRIDE, attribution: '© OpenStreetMap contributors (ODbL)', tiles: [] };
let offset = 0, totalV = 0, totalT = 0;
for (const T of [...tiles.values()].sort((a, b) => a.tz * NT + a.tx - (b.tz * NT + b.tx))) {
  const nv = T.verts.length;
  const vb = Buffer.alloc(nv * STRIDE);
  let minY = Infinity, maxY = -Infinity;
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < nv; i++) {
    const v = T.verts[i], o = i * STRIDE;
    vb.writeFloatLE(v.p[0], o); vb.writeFloatLE(v.p[1], o + 4); vb.writeFloatLE(v.p[2], o + 8);
    for (let k = 0; k < 3; k++) vb.writeInt8(Math.round(v.n[k] * 127), o + 12 + k);
    vb.writeInt8(0, o + 15);
    for (let k = 0; k < 3; k++) vb.writeUInt8(Math.max(0, Math.min(255, Math.round(v.c[k]))), o + 16 + k);
    vb.writeUInt8(v.s, o + 19);
    vb.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v.uv[0] * 8))), o + 20);
    vb.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v.uv[1] * 8))), o + 22);
    minY = Math.min(minY, v.p[1]); maxY = Math.max(maxY, v.p[1]);
    sx += v.p[0]; sy += v.p[1]; sz += v.p[2];
  }
  const ib = Buffer.from(new Uint32Array(T.idx).buffer);
  const cx = -CORE.size / 2 + (T.tx + 0.5) * TILE, cz = -CORE.size / 2 + (T.tz + 0.5) * TILE;
  index.tiles.push({
    tx: T.tx, tz: T.tz, vOffset: offset, vCount: nv, iOffset: offset + vb.length, iCount: T.idx.length,
    center: [cx, (minY + maxY) / 2, cz], radius: Math.hypot(TILE * 0.75, TILE * 0.75, (maxY - minY) / 2 + 20),
  });
  chunks.push(vb, ib);
  offset += vb.length + ib.length;
  totalV += nv; totalT += T.idx.length / 3;
}
fs.writeFileSync(path.join(OUT, 'buildings.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
// footprints: u16 count, then per building u8 vertex count + f32 (x, z) pairs
{
  const parts = [Buffer.from(new Uint16Array([0, 0]).buffer)];
  let n = 0;
  for (const f of footprints) {
    if (f.length > 255) continue;
    const b = Buffer.alloc(4 + f.length * 8);
    b.writeUInt8(f.length, 0);
    for (let i = 0; i < f.length; i++) { b.writeFloatLE(f[i][0], 4 + i * 8); b.writeFloatLE(f[i][1], 8 + i * 8); }
    parts.push(b);
    n++;
  }
  parts[0].writeUInt32LE(n, 0);
  fs.writeFileSync(path.join(OUT, 'footprints.bin'), Buffer.concat(parts));
}
console.log(`buildings: ${nGable} gabled, ${nFlat} flat, ${nSkip} skipped; ${index.tiles.length} tiles, ${totalV} vertices, ${totalT} triangles, ${(offset / 1e6).toFixed(1)} MB`);
