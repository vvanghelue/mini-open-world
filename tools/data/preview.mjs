// Writes hillshade previews of the built heightmaps to screenshots/ for visual checks.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const T = path.join(ROOT, 'public/data/terrain');
const meta = JSON.parse(fs.readFileSync(path.join(T, 'meta.json')));
async function shade(name, info, out, step) {
  const q = new Uint16Array(fs.readFileSync(path.join(T, name)).buffer.slice(0));
  const N = info.res, n = Math.floor(N / step), k = (info.hMax - info.hMin) / 65535;
  const h = (x, y) => info.hMin + q[Math.min(N - 1, y) * N + Math.min(N - 1, x)] * k;
  const img = Buffer.alloc(n * n * 3);
  const sp = info.spacing * step;
  const L = [-0.5, 0.6, -0.6]; const ll = Math.hypot(...L); L.forEach((v, i) => (L[i] = v / ll));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const X = x * step, Y = y * step;
    const dx = (h(X + step, Y) - h(Math.max(0, X - step), Y)) / (2 * sp);
    const dy = (h(X, Y + step) - h(X, Math.max(0, Y - step))) / (2 * sp);
    const nx = -dx, ny = 1, nz = -dy; const nl = Math.hypot(nx, ny, nz);
    const d = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / nl);
    const e = (h(X, Y) - info.hMin) / (info.hMax - info.hMin);
    const i = (y * n + x) * 3;
    img[i] = Math.min(255, 40 + 200 * d * (0.6 + 0.4 * e));
    img[i + 1] = Math.min(255, 40 + 200 * d * (0.7 + 0.3 * e));
    img[i + 2] = Math.min(255, 50 + 200 * d);
  }
  await sharp(img, { raw: { width: n, height: n, channels: 3 } }).png().toFile(path.join(ROOT, 'screenshots', out));
}
await shade('core_height.bin', meta.core, 'preview_core.png', 8);
await shade('far_height.bin', meta.far, 'preview_far.png', 2);
console.log('ok');
