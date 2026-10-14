// Prepares tree textures from Poly Haven fir_tree_01 (CC0):
//   public/data/trees/twig_albedo.png  RGBA (rgb diffuse, a = alpha cut-out)
//   public/data/trees/twig_normal.png  RGBA (rgb normal GL, a = ambient occlusion)
//   public/data/trees/bark_albedo.jpg, bark_normal.jpg
//   public/data/trees/twigs.json       sprite rectangles in the atlas (auto-detected from the alpha)
// The atlas alpha is dilated into the colour so mipmaps don't bleed black fringes.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SRC = path.join(ROOT, 'data-raw/trees/fir');
const OUT = path.join(ROOT, 'public/data/trees');
const RES = 2048;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const diff = await sharp(path.join(SRC, 'twig_diff.jpg')).resize(RES, RES).removeAlpha().raw().toBuffer();
  const alpha = await sharp(path.join(SRC, 'twig_alpha.png')).resize(RES, RES).toColourspace('b-w').raw().toBuffer();
  const nrm = await sharp(path.join(SRC, 'twig_nor_gl.jpg')).resize(RES, RES).removeAlpha().raw().toBuffer();
  const arm = await sharp(path.join(SRC, 'twig_arm.jpg')).resize(RES, RES).removeAlpha().raw().toBuffer();

  // --- sprite detection: connected components on a 256^2 dilated mask, ignoring the trunk strips on the borders
  const S = 256, k = RES / S;
  const mask = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let m = 0;
    for (let dy = 0; dy < k; dy += 2) for (let dx = 0; dx < k; dx += 2) m = Math.max(m, alpha[(y * k + dy) * RES + x * k + dx]);
    mask[y * S + x] = m > 128 ? 1 : 0;
  }
  // dilate 2 px to connect needles of the same twig
  const dil = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let m = 0;
    for (let dy = -2; dy <= 2 && !m; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < S && yy < S && mask[yy * S + xx]) { m = 1; break; }
    }
    dil[y * S + x] = m;
  }
  const label = new Int32Array(S * S).fill(-1);
  const comps = [];
  for (let i = 0; i < S * S; i++) {
    if (!dil[i] || label[i] >= 0) continue;
    const c = { x0: S, y0: S, x1: 0, y1: 0, n: 0 };
    const stack = [i];
    label[i] = comps.length;
    while (stack.length) {
      const j = stack.pop();
      const x = j % S, y = (j / S) | 0;
      c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y); c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y); c.n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
        const q = yy * S + xx;
        if (dil[q] && label[q] < 0) { label[q] = comps.length; stack.push(q); }
      }
    }
    comps.push(c);
  }
  // keep compact twig-like components away from the left/bottom trunk strips
  const twigs = comps
    .filter((c) => c.n > 120 && c.x0 > S * 0.12 && c.y1 < S * 0.86 && (c.x1 - c.x0) < S * 0.5)
    .map((c) => ({ u0: (c.x0 - 1) / S, v0: (c.y0 - 1) / S, u1: (c.x1 + 2) / S, v1: (c.y1 + 2) / S, area: c.n }))
    .sort((a, b) => b.area - a.area);
  console.log(`twig sprites: ${twigs.length}`, twigs.map((t) => `${((t.u1 - t.u0) * RES) | 0}x${((t.v1 - t.v0) * RES) | 0}`).join(' '));

  // --- RGBA atlases; dilate colour into transparent texels (8 passes) to avoid dark mip fringes
  const rgba = Buffer.alloc(RES * RES * 4);
  const known = new Uint8Array(RES * RES);
  for (let i = 0; i < RES * RES; i++) {
    rgba[i * 4] = diff[i * 3]; rgba[i * 4 + 1] = diff[i * 3 + 1]; rgba[i * 4 + 2] = diff[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i];
    known[i] = alpha[i] > 100 ? 1 : 0;
  }
  for (let pass = 0; pass < 8; pass++) {
    const next = known.slice();
    for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      if (known[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= RES || yy >= RES) continue;
        const q = yy * RES + xx;
        if (known[q]) { r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n++; }
      }
      if (n) { rgba[i * 4] = r / n; rgba[i * 4 + 1] = g / n; rgba[i * 4 + 2] = b / n; next[i] = 1; }
    }
    known.set(next);
  }
  await sharp(rgba, { raw: { width: RES, height: RES, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(OUT, 'twig_albedo.png'));
  const nrmA = Buffer.alloc(RES * RES * 4);
  for (let i = 0; i < RES * RES; i++) {
    nrmA[i * 4] = nrm[i * 3]; nrmA[i * 4 + 1] = nrm[i * 3 + 1]; nrmA[i * 4 + 2] = nrm[i * 3 + 2]; nrmA[i * 4 + 3] = arm[i * 3];
  }
  await sharp(nrmA, { raw: { width: RES, height: RES, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(OUT, 'twig_normal.png'));
  await sharp(path.join(SRC, 'bark_diff.jpg')).resize(1024, 1024).jpeg({ quality: 88 }).toFile(path.join(OUT, 'bark_albedo.jpg'));
  await sharp(path.join(SRC, 'bark_nor_gl.jpg')).resize(1024, 1024).jpeg({ quality: 92 }).toFile(path.join(OUT, 'bark_normal.jpg'));

  // mean twig colour (linear) for impostor/far tinting
  let sr = 0, sg = 0, sb = 0, n = 0;
  const l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  for (let i = 0; i < RES * RES; i += 7) if (alpha[i] > 200) { sr += l(diff[i * 3]); sg += l(diff[i * 3 + 1]); sb += l(diff[i * 3 + 2]); n++; }
  fs.writeFileSync(path.join(OUT, 'twigs.json'), JSON.stringify({ res: RES, twigs, meanAlbedo: [sr / n, sg / n, sb / n] }, null, 2));
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
