// Downloads raw geodata into data-raw/ (git-ignored). Idempotent: existing files are skipped.
//   - swissALTI3D 2 m DTM tiles (1 km) covering the core
//   - SWISSIMAGE 2 m orthophoto tiles (1 km) covering the core
//   - Copernicus GLO-30 DEM 1°x1° tiles covering the far ring
// Data: © swisstopo (OGD), Copernicus DEM © DLR e.V. / Airbus, provided under COPERNICUS by the EU and ESA.
import fs from 'node:fs';
import path from 'node:path';
import { CORE, FAR, CORE_CENTER, lv95ToWGS84 } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RAW = path.join(ROOT, 'data-raw');

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return 'skip';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      return 'ok';
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function pool(items, concurrency, fn) {
  let i = 0;
  let done = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      done++;
      if (done % 25 === 0 || done === items.length) console.log(`  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

// Lists STAC items intersecting the core, keeping the most recent item per 1 km tile.
async function stacTiles(collection, gsd) {
  const sw = lv95ToWGS84(CORE.e0 - 500, CORE.n0 - 500);
  const ne = lv95ToWGS84(CORE.e0 + CORE.size + 500, CORE.n0 + CORE.size + 500);
  const nw = lv95ToWGS84(CORE.e0 - 500, CORE.n0 + CORE.size + 500);
  const se = lv95ToWGS84(CORE.e0 + CORE.size + 500, CORE.n0 - 500);
  const bbox = [
    Math.min(sw.lon, nw.lon), Math.min(sw.lat, se.lat),
    Math.max(ne.lon, se.lon), Math.max(ne.lat, nw.lat),
  ].join(',');
  let url = `https://data.geo.admin.ch/api/stac/v0.9/collections/${collection}/items?bbox=${bbox}&limit=100`;
  const best = new Map();
  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    for (const f of json.features) {
      const m = f.id.match(/_(\d{4})_(\d{4})-(\d{4})$/);
      if (!m) continue;
      const [, year, ekm, nkm] = m.map(Number);
      const e = ekm * 1000;
      const n = nkm * 1000;
      if (e < CORE.e0 || e >= CORE.e0 + CORE.size || n < CORE.n0 || n >= CORE.n0 + CORE.size) continue;
      const asset = Object.values(f.assets).find((a) => a.href.endsWith(`_${gsd}_2056.tif`) || a.href.endsWith(`_${gsd}_2056_5728.tif`));
      if (!asset) continue;
      const key = `${ekm}-${nkm}`;
      const prev = best.get(key);
      if (!prev || prev.year < year) best.set(key, { year, ekm, nkm, href: asset.href });
    }
    const next = json.links?.find((l) => l.rel === 'next');
    url = next ? next.href : null;
  }
  return [...best.values()];
}

async function main() {
  const which = process.argv[2] || 'all';

  if (which === 'all' || which === 'dem') {
    const tiles = await stacTiles('ch.swisstopo.swissalti3d', 2);
    console.log(`swissALTI3D: ${tiles.length} tiles`);
    await pool(tiles, 8, (t) => download(t.href, path.join(RAW, 'swissalti3d', `${t.ekm}-${t.nkm}.tif`)));
  }

  if (which === 'all' || which === 'ortho') {
    const tiles = await stacTiles('ch.swisstopo.swissimage-dop10', 2);
    console.log(`SWISSIMAGE: ${tiles.length} tiles`);
    await pool(tiles, 8, (t) => download(t.href, path.join(RAW, 'swissimage', `${t.ekm}-${t.nkm}.tif`)));
  }

  if (which === 'all' || which === 'far') {
    const half = FAR.size / 2;
    const corners = [
      lv95ToWGS84(CORE_CENTER.e - half, CORE_CENTER.n - half),
      lv95ToWGS84(CORE_CENTER.e + half, CORE_CENTER.n + half),
      lv95ToWGS84(CORE_CENTER.e - half, CORE_CENTER.n + half),
      lv95ToWGS84(CORE_CENTER.e + half, CORE_CENTER.n - half),
    ];
    const lats = corners.map((c) => c.lat);
    const lons = corners.map((c) => c.lon);
    const tiles = [];
    for (let lat = Math.floor(Math.min(...lats)); lat <= Math.floor(Math.max(...lats)); lat++) {
      for (let lon = Math.floor(Math.min(...lons)); lon <= Math.floor(Math.max(...lons)); lon++) {
        const name = `Copernicus_DSM_COG_10_N${String(lat).padStart(2, '0')}_00_E${String(lon).padStart(3, '0')}_00_DEM`;
        tiles.push({ name, href: `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif` });
      }
    }
    console.log(`Copernicus GLO-30: ${tiles.length} tiles`);
    await pool(tiles, 4, (t) => download(t.href, path.join(RAW, 'copernicus', `${t.name}.tif`)));
  }
  console.log('fetch done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
