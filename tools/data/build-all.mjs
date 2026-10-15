#!/usr/bin/env node
// Full data pipeline: downloads the raw sources (skipped when already in data-raw/) and builds public/data/.
// Both folders are git-ignored (~1.1 GB raw, ~0.6 GB built). Total: a few minutes once downloaded.
//   npm run data
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const steps = [
  ['fetch.mjs'], // swissALTI3D + SWISSIMAGE (core) + Copernicus DEM (far ring)
  ['fetch-osm.mjs', 'buildings'],
  ['fetch-osm.mjs', 'roads'],
  ['fetch-trees.mjs'], // Poly Haven conifer textures
  ['build-terrain.mjs'],
  ['build-surface.mjs'], // de-lit orthophoto + land cover (core)
  ['build-far-surface.mjs'], // swisstopo WMTS mosaic (far ring), downloads its tiles
  ['build-textures.mjs'], // Poly Haven / ambientCG terrain layers, downloads them
  ['build-trees.mjs'],
  ['build-buildings.mjs'],
  ['build-roads.mjs'],
];
const t0 = Date.now();
for (const [script, ...args] of steps) {
  console.log(`\n=== ${script} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [path.join(DIR, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${script} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\ndata ready in public/data (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
