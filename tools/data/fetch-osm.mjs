#!/usr/bin/env node
// Downloads OpenStreetMap data over the core square (Overpass API):
//   node tools/data/fetch-osm.mjs [buildings|roads]  -> data-raw/osm/<what>.json
// Data © OpenStreetMap contributors, ODbL (attribution shown in the app).
import fs from 'node:fs';
import path from 'node:path';
import { CORE, lv95ToWGS84 } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const what = process.argv[2] || 'buildings';
const OUT = path.join(ROOT, `data-raw/osm/${what}.json`);
const a = lv95ToWGS84(CORE.e0, CORE.n0), b = lv95ToWGS84(CORE.e0 + CORE.size, CORE.n0 + CORE.size);
const bbox = [a.lat, a.lon, b.lat, b.lon].map((v) => v.toFixed(5)).join(',');
const filter = what === 'roads' ? 'way["highway"]' : 'way["building"]';
const query = `[out:json][timeout:300];${filter}(${bbox});out tags geom;`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
console.log('overpass', bbox);
const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'User-Agent': 'mini-open-world-data-build/0.1', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(query),
});
if (!res.ok) throw new Error(`overpass ${res.status} ${await res.text()}`);
const text = await res.text();
fs.writeFileSync(OUT, text);
const j = JSON.parse(text);
console.log(`${j.elements.length} ${what}, ${(text.length / 1e6).toFixed(1)} MB -> ${OUT}`);
