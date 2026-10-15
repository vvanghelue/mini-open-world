// @ts-nocheck -- TSL typings incomplete for these patterns
// Water reflections by heightfield ray marching. Instead of screen-space reflections (which only know what is on
// screen and fail for lakes seen at grazing angles), the reflected ray is marched through the terrain heightfield:
// mountains reflect in the lakes even when they are behind the camera or off-screen. The hit is shaded with the
// de-lit orthophoto, sun Lambert x heightfield shadows and sky light, then hazed towards the sky along the path.
// Everything is read with textureLoad (no sampler bindings: the terrain fragment stage is close to the limit).
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, ivec2, clamp, floor, mix, max, dot, exp, If, Loop, Break, smoothstep, texture,
} from 'three/tsl';
import { settings } from '../core/settings';
import type { Terrain } from '../terrain/terrain';
import type { Atmosphere } from '../sky/atmosphere';
import type { TerrainShadows } from './terrain-shadows';

export const waterSettings = settings.group('water', 'Eau', {
  reflections: { value: true, label: 'Reflets du relief' },
  haze: { value: 28, min: 5, max: 120, step: 1, label: 'Brume des reflets (km)' },
});

const STEPS = 16; // geometric steps (x1.6): 4 m near the surface, ~20 km reach

function nearestHeights(src: Float32Array, res: number, step: number) {
  const n = res / step;
  let data = src;
  if (step > 1) {
    data = new Float32Array(n * n);
    const o = step >> 1;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = src[(y * step + o) * res + x * step + o];
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function makeTerrainReflection(terrain: Terrain, atmosphere: Atmosphere, shadows: TerrainShadows) {
  const m = terrain.data.meta;
  const hMax = Math.max(m.core.hMax ?? 4200, m.far.hMax ?? 4200) + 50;
  const grid = (tex: THREE.Texture, res: number, size: number) => ({ node: new THREE.TextureNode(tex), res, size });
  // heights: dedicated nearest-filtered copies (a linear R32F texture would need a sampler binding, and the terrain
  // fragment stage has none left); the core is decimated to 2048^2 (12 m), plenty for reflections
  const hCore = grid(nearestHeights(terrain.data.coreH, m.core.res, 4), m.core.res / 4, m.core.size);
  const hFar = grid(nearestHeights(terrain.data.farH, m.far.res, 1), m.far.res, m.far.size);
  const tx = terrain.textures;
  const load = (g: any, xz: any) => {
    const ij = clamp(floor(xz.div(g.size).add(0.5).mul(g.res)), vec2(0), vec2(g.res - 1));
    return g.node.load(ivec2(ij));
  };
  const bilinear = (g: any, xz: any) => {
    const p = xz.div(g.size).add(0.5).mul(g.res).sub(0.5);
    const i0 = clamp(floor(p), vec2(0), vec2(g.res - 1));
    const f = clamp(p.sub(i0), vec2(0), vec2(1));
    const i1 = clamp(i0.add(1), vec2(0), vec2(g.res - 1));
    const a = g.node.load(ivec2(i0)).r, b = g.node.load(ivec2(vec2(i1.x, i0.y))).r;
    const c = g.node.load(ivec2(vec2(i0.x, i1.y))).r, e = g.node.load(ivec2(i1)).r;
    return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
  };
  const cw = terrain.coreWeightNode;
  // marching: one grid per sample (core inside its square, far ring outside); bilinear for the refinement
  const coreHalf = m.core.size / 2 - 64;
  const height = (xz: any) => {
    const h = float(0).toVar();
    // far ring (40 m texels): bilinear, nearest shows as stair-steps along reflected ridgelines
    If(max(xz.x.abs(), xz.y.abs()).lessThan(coreHalf), () => h.assign(load(hCore, xz).r)).Else(() => h.assign(bilinear(hFar, xz)));
    return h;
  };
  const heightSmooth = (xz: any) => mix(bilinear(hFar, xz), bilinear(hCore, xz), cw(xz));
  // albedo / normals: filtered samples of textures the terrain fragment stage already binds (shared bindings
  // and samplers; also keeps the sRGB decode consistent with the terrain shading)
  const uvCore = (xz: any) => xz.div(m.core.size).add(0.5);
  const uvFar = (xz: any) => xz.div(m.far.size).add(0.5);
  const albedoAt = (xz: any) => mix(texture(tx.farAlbedo, uvFar(xz)).level(0).rgb, texture(tx.macroAlbedo, uvCore(xz)).level(0).rgb, cw(xz));
  const normal = terrain.normalNode;

  const sun = atmosphere.sunLight;
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0)).onFrameUpdate(() => uSunDir.value.copy(sun.position).sub(sun.target.position).normalize());
  const uSunCol = uniform(new THREE.Color()).onFrameUpdate(() => uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity));
  const uOn = uniform(1).onFrameUpdate(() => (waterSettings.reflections ? 1 : 0));
  const uHaze = uniform(1).onFrameUpdate(() => 1 / (waterSettings.haze * 1000));

  /** TSL: reflected radiance (pre-exposed) for a ray from o in direction d (d.y >= 0); `sky` = sky radiance along d. */
  return (o: any, d: any, sky: any) =>
    Fn(() => {
      const out = sky.toVar();
      If(uOn.greaterThan(0.5), () => {
        const t = float(4).toVar();
        const tPrev = float(0).toVar();
        const hit = float(0).toVar();
        Loop({ start: 0, end: STEPS, name: 'wrStep' } as any, () => {
          const p = o.add(d.mul(t));
          If(p.y.greaterThan(hMax), () => Break());
          // hits at the water's own level (ripple-tilted rays grazing the lake) are not reflections of the relief
          const h = height(p.xz);
          If(p.y.lessThan(h).and(h.greaterThan(o.y.add(1.5))), () => {
            hit.assign(1);
            Break();
          });
          tPrev.assign(t);
          t.assign(t.mul(1.6).add(4));
        });
        If(hit.greaterThan(0.5), () => {
          // refine the crossing between the last two samples
          Loop({ start: 0, end: 4, name: 'wrRefine' } as any, () => {
            const mid = tPrev.add(t).mul(0.5);
            const p = o.add(d.mul(mid));
            If(p.y.lessThan(heightSmooth(p.xz)), () => t.assign(mid)).Else(() => tPrev.assign(mid));
          });
          const hp = o.add(d.mul(t)).toVar();
          const n = normal(hp.xz).toVar();
          // the heightfield has no trees: forested ground reflects as canopy
          const albedo = mix(albedoAt(hp.xz), vec3(0.03, 0.045, 0.022), terrain.forestNode(hp.xz).mul(0.85));
          const ndl = max(dot(n, uSunDir), 0);
          const vis = shadows.visibilityAt(hp.add(vec3(0, 1, 0)));
          const irr = uSunCol.mul(ndl.mul(vis)).add(atmosphere.skyIrradiance(n));
          const rad = albedo.mul(irr).mul(1 / Math.PI);
          // haze along the reflected path: towards the sky radiance seen along the same direction
          const T = exp(t.negate().mul(uHaze));
          // fade the hit in over the first metres (avoids self-reflection of the shore texels at the water edge)
          const k = smoothstep(2, 8, t);
          out.assign(mix(sky, mix(sky, rad, T), k));
        });
      });
      return out;
    })();
}
