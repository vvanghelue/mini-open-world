// Downloads CC0 PBR textures (Poly Haven, ambientCG) and packs the terrain material layers into two
// texture arrays (raw RGBA8, RES x RES x LAYERS):
//   terrain_albedo.bin : RGB = albedo (sRGB), A = height (displacement)
//   terrain_normal.bin : RG = normal XY (OpenGL convention), B = roughness, A = ambient occlusion
//   terrain_layers.json: layer names, mean albedo (linear) per layer
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RAW = path.join(ROOT, 'data-raw/textures');
const OUT = path.join(ROOT, 'public/data/textures');
const RES = 1024;

// Order matters: shader layer indices (see src/terrain/terrain-material.ts)
export const LAYERS = [
  { name: 'meadow', src: 'acg:Grass004' },
  { name: 'forest', src: 'ph:forest_ground_04' },
  { name: 'scree', src: 'ph:aerial_rocks_02' },
  { name: 'cliff', src: 'ph:rock_wall_02' },
  { name: 'snow', src: 'ph:snow_02' },
  { name: 'path', src: 'ph:grass_path_2' },
  { name: 'alpine', src: 'ph:rocky_terrain_02' },
  { name: 'urban', src: 'ph:aerial_asphalt_01' },
];

async function dl(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function fetchLayer(src) {
  const [kind, id] = src.split(':');
  const dir = path.join(RAW, id);
  fs.mkdirSync(dir, { recursive: true });
  if (kind === 'ph') {
    const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
    const pick = (key, fmt = 'jpg') => files[key]?.['1k']?.[fmt]?.url;
    const maps = { color: pick('Diffuse'), normal: pick('nor_gl'), rough: pick('Rough'), disp: pick('Displacement', 'png') || pick('Displacement'), ao: pick('AO') };
    const out = {};
    for (const [k, url] of Object.entries(maps)) {
      if (!url) continue;
      const dest = path.join(dir, `${k}${path.extname(url)}`);
      await dl(url, dest);
      out[k] = dest;
    }
    return out;
  }
  // ambientCG zip
  const zip = path.join(dir, `${id}.zip`);
  await dl(`https://ambientcg.com/get?file=${id}_1K-JPG.zip`, zip);
  execFileSync('unzip', ['-qo', zip, '-d', dir]);
  const find = (suffix) => {
    const f = fs.readdirSync(dir).find((n) => n.endsWith(suffix));
    return f ? path.join(dir, f) : undefined;
  };
  return { color: find('_Color.jpg'), normal: find('_NormalGL.jpg'), rough: find('_Roughness.jpg'), disp: find('_Displacement.jpg'), ao: find('_AmbientOcclusion.jpg') };
}

async function channel(file, fallback) {
  if (!file) return Buffer.alloc(RES * RES, fallback);
  return sharp(file).resize(RES, RES).toColourspace('b-w').raw().toBuffer();
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const n = LAYERS.length;
  const albedo = Buffer.alloc(RES * RES * 4 * n);
  const normal = Buffer.alloc(RES * RES * 4 * n);
  const meta = { res: RES, layers: [] };
  for (let l = 0; l < n; l++) {
    const L = LAYERS[l];
    const maps = await fetchLayer(L.src);
    const color = await sharp(maps.color).resize(RES, RES).removeAlpha().raw().toBuffer();
    const nrm = await sharp(maps.normal).resize(RES, RES).removeAlpha().raw().toBuffer();
    const rough = await channel(maps.rough, 200);
    const disp = await channel(maps.disp, 128);
    const ao = await channel(maps.ao, 255);
    const o = l * RES * RES * 4;
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < RES * RES; i++) {
      albedo[o + i * 4] = color[i * 3];
      albedo[o + i * 4 + 1] = color[i * 3 + 1];
      albedo[o + i * 4 + 2] = color[i * 3 + 2];
      albedo[o + i * 4 + 3] = disp[i];
      normal[o + i * 4] = nrm[i * 3];
      normal[o + i * 4 + 1] = nrm[i * 3 + 1];
      normal[o + i * 4 + 2] = rough[i];
      normal[o + i * 4 + 3] = ao[i];
      sr += srgbToLinear(color[i * 3] / 255);
      sg += srgbToLinear(color[i * 3 + 1] / 255);
      sb += srgbToLinear(color[i * 3 + 2] / 255);
    }
    const k = 1 / (RES * RES);
    meta.layers.push({ name: L.name, src: L.src, meanAlbedo: [sr * k, sg * k, sb * k].map((v) => +v.toFixed(4)) });
    console.log(`layer ${l} ${L.name} <- ${L.src}`, meta.layers[l].meanAlbedo);
  }
  fs.writeFileSync(path.join(OUT, 'terrain_albedo.bin'), albedo);
  fs.writeFileSync(path.join(OUT, 'terrain_normal.bin'), normal);
  fs.writeFileSync(path.join(OUT, 'terrain_layers.json'), JSON.stringify(meta, null, 2));
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
