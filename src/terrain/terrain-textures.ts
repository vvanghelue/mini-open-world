// Loads the terrain surface textures: macro albedo (de-lit orthophoto), land-cover fractions, PBR layer arrays.
import * as THREE from 'three/webgpu';
import { dataUrl, fetchData, fetchJson } from '../core/data';

export interface LayerInfo {
  name: string;
  meanAlbedo: [number, number, number];
}

export interface TerrainTextures {
  macroAlbedo: THREE.Texture;
  /** 2 layers: [0] forest, grass, rock, snow  [1] water, urban, gravel, 1 */
  landcover: THREE.DataArrayTexture;
  farAlbedo: THREE.Texture; // 20 m orthophoto over the 81.92 km square
  farLandcover: THREE.DataArrayTexture;
  albedoArray: THREE.DataArrayTexture; // rgb albedo + a height
  normalArray: THREE.DataArrayTexture; // rg normal, b roughness, a ao
  noise: THREE.DataTexture; // tiling value noise, 4 octaves in rgba
  layers: LayerInfo[];
}

export async function loadBitmapTexture(url: string, srgb: boolean) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (run "npm run data")`);
  const blob = await res.blob();
  // data textures must not be premultiplied nor colour-converted
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' } as any);
  const t = new THREE.Texture(bmp as any);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

async function loadArray(path: string, res: number, layers: number, srgb: boolean, repeat = true) {
  const data = new Uint8Array(await fetchData(path));
  const t = new THREE.DataArrayTexture(data, res, res, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Tiling value noise (256^2): r,g,b,a = octaves with periods 64, 32, 16, 8 texels. */
function makeNoise(): THREE.DataTexture {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let c = 0; c < 4; c++) {
    const period = 64 >> c;
    const cells = S / period;
    const grid = new Float32Array(cells * cells).map(rnd);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / period, fy = y / period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (ix: number, iy: number) => grid[(iy % cells) * cells + (ix % cells)];
      const v = (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
      data[(y * S + x) * 4 + c] = Math.round(v * 255);
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export async function loadTerrainTextures(): Promise<TerrainTextures> {
  const meta = await fetchJson('textures/terrain_layers.json');
  const [macroAlbedo, landcover, farAlbedo, farLandcover, albedoArray, normalArray] = await Promise.all([
    loadBitmapTexture(dataUrl('terrain/core_albedo.jpg'), true),
    loadArray('terrain/core_landcover.bin', 4096, 2, false, false),
    loadBitmapTexture(dataUrl('terrain/far_albedo.jpg'), true),
    loadArray('terrain/far_landcover.bin', 2048, 2, false, false),
    loadArray('textures/terrain_albedo.bin', meta.res, meta.layers.length, true),
    loadArray('textures/terrain_normal.bin', meta.res, meta.layers.length, false),
  ]);
  return { macroAlbedo, landcover, farAlbedo, farLandcover, albedoArray, normalArray, noise: makeNoise(), layers: meta.layers };
}
