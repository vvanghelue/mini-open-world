// @ts-nocheck -- TSL typings incomplete for these patterns
// Volumetric cumulus layer (simplified Nubis): 2D coverage (weather) x vertical profile x tiling 3D Worley/value
// noise, ray-marched at reduced resolution with a per-frame jittered start (TAA integrates), lit by the sun
// (Beer + powder, dual-lobe phase, short light march) and the sky. Aerial perspective is applied at the cloud
// depth. The result is composited over the scene (scene * T + L) before the temporal upscaler.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec2, vec3, vec4, float, int, uvec2, uvec3, instanceIndex, textureStore, texture3D, Loop, If, Break, max, min,
  clamp, mix, smoothstep, exp, dot, normalize, length, floor, fract, sin, abs, uv, cameraPosition, cameraProjectionMatrixInverse,
  cameraWorldMatrix, interleavedGradientNoise, screenCoordinate, time, pow, sqrt, texture,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import type { Atmosphere } from './atmosphere';

export const cloudSettings = settings.group('clouds', 'Nuages', {
  enabled: { value: true, label: 'Nuages volumétriques' },
  coverage: { value: 0.42, min: 0, max: 1, step: 0.01, label: 'Couverture' },
  base: { value: 2700, min: 800, max: 6000, step: 50, label: 'Base (m)' },
  thickness: { value: 1500, min: 200, max: 5000, step: 50, label: 'Épaisseur (m)' },
  density: { value: 0.03, min: 0.002, max: 0.15, step: 0.001, label: 'Densité' },
  wind: { value: 9, min: 0, max: 60, step: 0.5, label: 'Vent (m/s)' },
  steps: { value: 22, min: 8, max: 64, step: 1, label: 'Pas de marche' },
  resolution: { value: 0.5, min: 0.25, max: 1, step: 0.05, label: 'Résolution relative' },
  shadows: { value: 0.75, min: 0, max: 1, step: 0.05, label: 'Ombres des nuages' },
});

const N3 = 64;
const WEATHER_TILE = 36000; // metres covered by one tile of the weather map

/** Cheap periodic 2D value noise (ALU only, no texture): usable in any shader without a sampler. */
export const valueNoise2 = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const h = (q) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453));
  const a = h(i), b = h(i.add(vec2(1, 0))), c = h(i.add(vec2(0, 1))), d = h(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

export class Clouds implements System {
  readonly name = 'clouds';
  private engine!: Engine;
  noise!: THREE.Storage3DTexture;
  readonly uWind = uniform(new THREE.Vector2());
  readonly uCoverage = uniform(0.42);
  readonly uBase = uniform(2700);
  readonly uThickness = uniform(1500);
  readonly uDensity = uniform(0.03);
  readonly uSteps = uniform(22);
  readonly uShadow = uniform(0.75);
  readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  readonly uSunColor = uniform(new THREE.Color());
  readonly uEnabled = uniform(1);
  private windOffset = new THREE.Vector2();

  constructor(private atmosphere: Atmosphere) {}

  /** Tileable 2D weather map (fbm, 512^2 covering WEATHER_TILE metres), baked once; coverage threshold at runtime. */
  weather!: THREE.StorageTexture;

  init(engine: Engine) {
    this.engine = engine;
    this.weather = new THREE.StorageTexture(512, 512);
    this.weather.type = THREE.HalfFloatType;
    this.weather.format = THREE.RGBAFormat;
    this.weather.wrapS = this.weather.wrapT = THREE.RepeatWrapping;
    this.weather.minFilter = this.weather.magFilter = THREE.LinearFilter;
    this.weather.generateMipmaps = false;
    engine.renderer.compute(this.buildWeather());
    this.noise = new THREE.Storage3DTexture(N3, N3, N3);
    this.noise.format = THREE.RGBAFormat;
    this.noise.type = THREE.UnsignedByteType;
    this.noise.wrapS = this.noise.wrapT = this.noise.wrapR = THREE.RepeatWrapping;
    this.noise.minFilter = this.noise.magFilter = THREE.LinearFilter;
    this.noise.generateMipmaps = false;
    engine.renderer.compute(this.buildNoise());
  }

  // ---------------------------------------------------------------- tiling 3D noise: r = Perlin-Worley shape, g/b = Worley octaves
  private buildNoise() {
    const hash3 = (c) => fract(sin(vec3(dot(c, vec3(127.1, 311.7, 74.7)), dot(c, vec3(269.5, 183.3, 246.1)), dot(c, vec3(113.5, 271.9, 124.6)))).mul(43758.5453));
    const worley = (p, cells: number) => {
      // periodic Worley: p in [0,1)^3, `cells` cells per side, wraps
      const q = p.mul(cells);
      const i = floor(q);
      const f = fract(q);
      const md = float(10).toVar();
      for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const o = vec3(x, y, z);
        const cell = i.add(o).add(cells).mod(cells);
        const fp = o.add(hash3(cell)).sub(f);
        md.assign(min(md, dot(fp, fp)));
      }
      return float(1).sub(sqrt(md).min(1));
    };
    const vnoise = (p, cells: number) => {
      const q = p.mul(cells);
      const i = floor(q);
      const f = fract(q);
      const u = f.mul(f).mul(float(3).sub(f.mul(2)));
      const h = (c) => hash3(c.add(cells).mod(cells)).x;
      const l = (dz) => mix(mix(h(i.add(vec3(0, 0, dz))), h(i.add(vec3(1, 0, dz))), u.x), mix(h(i.add(vec3(0, 1, dz))), h(i.add(vec3(1, 1, dz))), u.x), u.y);
      return mix(l(0), l(1), u.z);
    };
    return Fn(() => {
      const x = instanceIndex.mod(N3);
      const y = instanceIndex.div(N3).mod(N3);
      const z = instanceIndex.div(N3 * N3);
      const p = vec3(float(x), float(y), float(z)).add(0.5).div(N3);
      const perlin = vnoise(p, 4).mul(0.5).add(vnoise(p, 8).mul(0.3)).add(vnoise(p, 16).mul(0.2));
      const w1 = worley(p, 4), w2 = worley(p, 8), w3 = worley(p, 16);
      const wf = w1.mul(0.625).add(w2.mul(0.25)).add(w3.mul(0.125));
      // Perlin-Worley: perlin remapped by worley
      const pw = clamp(perlin.sub(float(1).sub(wf)).div(wf.max(0.001)).mul(0.5).add(wf.mul(0.5)), 0, 1);
      textureStore(this.noise, uvec3(x, y, z), vec4(pw, w2, w3, 1)).toWriteOnly();
    })().compute(N3 * N3 * N3).setName('cloudNoise');
  }

  private buildWeather() {
    // periodic value-noise fbm: cells wrap at the tile size so the texture tiles seamlessly
    const hash2 = (c) => fract(sin(dot(c, vec2(127.1, 311.7))).mul(43758.5453));
    const pnoise = (p, cells: number) => {
      const q = p.mul(cells);
      const i = floor(q);
      const f = fract(q);
      const u = f.mul(f).mul(float(3).sub(f.mul(2)));
      const h = (o) => hash2(i.add(o).add(cells).mod(cells));
      return mix(mix(h(vec2(0, 0)), h(vec2(1, 0)), u.x), mix(h(vec2(0, 1)), h(vec2(1, 1)), u.x), u.y);
    };
    return Fn(() => {
      const x = instanceIndex.mod(512);
      const y = instanceIndex.div(512);
      const p = vec2(float(x), float(y)).add(0.5).div(512);
      const n = pnoise(p, 4).mul(0.5).add(pnoise(p, 9).mul(0.28)).add(pnoise(p, 21).mul(0.15)).add(pnoise(p, 47).mul(0.07));
      textureStore(this.weather, uvec2(x, y), vec4(n, 0, 0, 1)).toWriteOnly();
    })().compute(512 * 512).setName('cloudWeather');
  }

  /** TSL: coverage (weather map) at world xz — one texture sample. */
  coverage(xz) {
    const n = texture(this.weather, xz.add(this.uWind).div(WEATHER_TILE)).level(float(0)).r;
    return smoothstep(float(1).sub(this.uCoverage), float(1).sub(this.uCoverage).add(0.25), n);
  }

  private density(p) {
    const hf = clamp(p.y.sub(this.uBase).div(this.uThickness), 0, 1);
    const cov = this.coverage(p.xz);
    // cumulus profile: flat base, rounded towers; taller where coverage is high
    const top = mix(float(0.45), float(1), cov);
    const profile = smoothstep(0, 0.08, hf).mul(float(1).sub(smoothstep(top.mul(0.55), top, hf)));
    const q = vec3(p.x.add(this.uWind.x), p.y, p.z.add(this.uWind.y));
    const n = texture3D(this.noise, q.div(2600), float(0));
    const shape = clamp(n.r.sub(float(1).sub(cov.mul(profile))).div(cov.mul(profile).max(0.02)), 0, 1);
    const detail = texture3D(this.noise, q.div(600).add(vec3(0.3, time.mul(0.002), 0.7)), float(0)).g;
    const d = clamp(shape.sub(float(1).sub(detail).mul(0.35).mul(float(1).sub(shape))), 0, 1);
    return d.mul(this.uDensity);
  }

  /** cheaper density for light marching: coverage x profile x shape, no detail erosion */
  private densityCoarse(p) {
    const hf = clamp(p.y.sub(this.uBase).div(this.uThickness), 0, 1);
    const cov = this.coverage(p.xz);
    const top = mix(float(0.45), float(1), cov);
    const profile = smoothstep(0, 0.08, hf).mul(float(1).sub(smoothstep(top.mul(0.55), top, hf)));
    const q = vec3(p.x.add(this.uWind.x), p.y, p.z.add(this.uWind.y));
    const n = texture3D(this.noise, q.div(2600), float(0)).r;
    return clamp(n.sub(float(1).sub(cov.mul(profile))).div(cov.mul(profile).max(0.02)), 0, 1).mul(this.uDensity);
  }

  /** TSL: sun transmittance through the cloud layer for a world position (cheap, for the shadow node). */
  shadowAt(pw) {
    const mid = this.uBase.add(this.uThickness.mul(0.4));
    const t = mid.sub(pw.y).div(max(this.uSunDir.y, 0.05));
    const q = pw.xz.add(this.uSunDir.xz.mul(t));
    const cov = this.coverage(q);
    const sh = exp(cov.mul(cov).mul(-4.0));
    return mix(float(1), sh, this.uShadow.mul(this.uEnabled).mul(smoothstep(-0.02, 0.05, this.uSunDir.y)));
  }

  /** TSL: ray-march node for an RTT pass. depthNode: scene depth texture node (same resolution or larger). */
  marchNode(depthNode) {
    const atmo = this.atmosphere;
    return Fn(() => {
      const suv = uv();
      const ndc = vec2(suv.x.mul(2).sub(1), float(1).sub(suv.y.mul(2)));
      const d = depthNode.sample(suv).r;
      const vp = cameraProjectionMatrixInverse.mul(vec4(ndc, d, 1));
      const viewPos = vp.xyz.div(vp.w);
      const sceneDist = length(viewPos);
      const isSky = d.lessThanEqual(0.0000001);
      const dir = normalize(cameraWorldMatrix.mul(vec4(viewPos, 0)).xyz);
      const ro = cameraPosition;
      const out = vec4(0, 0, 0, 1).toVar();
      If(this.uEnabled.greaterThan(0.5), () => {
        // intersect the slab
        const y0 = this.uBase, y1 = this.uBase.add(this.uThickness);
        const ta = y0.sub(ro.y).div(dir.y), tb = y1.sub(ro.y).div(dir.y);
        const tIn = max(min(ta, tb), 0);
        const tOut = select3(abs(dir.y).lessThan(1e-4), float(60000), max(ta, tb));
        const inside = ro.y.greaterThan(y0).and(ro.y.lessThan(y1));
        const t0 = select3(inside, float(0), tIn).toVar();
        const t1 = min(min(select3(inside, select3(abs(dir.y).lessThan(1e-4), float(60000), max(ta, tb)), tOut), select3(isSky, float(80000), sceneDist)), 80000).toVar();
        // grazing rays cross tens of km of the layer: cap the crossing, and give long crossings more steps
        // (a few km-long steps turn each cumulus into a single saturated sample: flat strips at the horizon)
        t1.assign(min(t1, t0.add(40000)));
        If(t1.greaterThan(t0), () => {
          const len = t1.sub(t0);
          // integer step count and a step length that covers the crossing exactly (a fractional count leaves a
          // partial last step that jumps between pixels: banding)
          const steps = clamp(len.div(500).ceil(), this.uSteps, 56);
          const dt = len.div(steps).max(30);
          const jitter = interleavedGradientNoise(screenCoordinate.xy.add(fract(time.mul(7.13)).mul(64)));
          const t = t0.add(dt.mul(jitter)).toVar();
          const T = float(1).toVar();
          const L = vec3(0).toVar();
          const firstHit = float(-1).toVar();
          const mu = dot(dir, this.uSunDir);
          const hg = (g) => float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(2).mul(mu)).max(1e-4), 1.5)).mul(1 / (4 * Math.PI));
          const phase = mix(hg(float(-0.25)), hg(float(0.7)), 0.7);
          const ambientTop = atmo.skyIrradiance(vec3(0, 1, 0)).mul(1 / Math.PI);
          Loop({ start: 0, end: 64, name: 'ci' } as any, ({ ci }) => {
            If(float(ci).greaterThanEqual(steps).or(t.greaterThan(t1)).or(T.lessThan(0.02)), () => Break());
            const p = ro.add(dir.mul(t));
            const dens = float(0).toVar();
            If(this.coverage(p.xz).greaterThan(0.001), () => {
              dens.assign(this.density(p));
            });
            If(dens.greaterThan(0.0001), () => {
              If(firstHit.lessThan(0), () => firstHit.assign(t));
              // short light march towards the sun
              const od = float(0).toVar();
              const ls = float(90).toVar();
              const lp = p.toVar();
              Loop({ start: 0, end: 3, name: 'li' } as any, () => {
                lp.addAssign(this.uSunDir.mul(ls));
                od.addAssign(this.densityCoarse(lp).mul(ls));
                ls.mulAssign(2.2);
              });
              const Tl = exp(od.negate());
              const powder = float(1).sub(exp(od.mul(-2).sub(dens.mul(dt))));
              const hf = clamp(p.y.sub(this.uBase).div(this.uThickness), 0, 1);
              const sunL = this.uSunColor.mul(phase).mul(Tl.add(pow(Tl, 0.25).mul(0.25)).mul(mix(float(1), powder, 0.5)));
              const ambL = ambientTop.mul(mix(float(0.35), float(1), hf));
              const S = sunL.add(ambL).mul(dens);
              const Ts = exp(dens.mul(dt).negate());
              L.addAssign(T.mul(S.sub(S.mul(Ts)).div(dens.max(1e-6))));
              T.mulAssign(Ts);
            });
            t.addAssign(dt);
          });
          // aerial perspective at the first cloud hit; very distant clouds dissolve into the haze
          If(firstHit.greaterThan(0), () => {
            const hp = ro.add(dir.mul(firstHit));
            const ap = atmo.aerialPerspective(hp, suv);
            const fade = float(1).sub(smoothstep(30000, 60000, firstHit));
            L.assign(L.mul(ap.T).add(ap.S.mul(float(1).sub(T))).mul(fade));
            T.assign(mix(float(1), T, fade));
          });
          out.assign(vec4(L, T));
        });
      });
      return out;
    })();
  }

  update(ctx: FrameContext) {
    const s = cloudSettings;
    this.uEnabled.value = s.enabled ? 1 : 0;
    this.uCoverage.value = s.coverage;
    this.uBase.value = s.base;
    this.uThickness.value = s.thickness;
    this.uDensity.value = s.density;
    this.uSteps.value = s.steps;
    this.uShadow.value = s.shadows;
    this.windOffset.x += ctx.dt * s.wind * 0.8;
    this.windOffset.y += ctx.dt * s.wind * 0.6;
    this.uWind.value.copy(this.windOffset);
    const sun = this.atmosphere.mainIsMoon ? null : this.atmosphere.sunLight;
    this.uSunDir.value.copy(this.atmosphere.sunLight.position).sub(this.atmosphere.sunLight.target.position).normalize();
    this.uSunColor.value.copy(this.atmosphere.sunLight.color).multiplyScalar(this.atmosphere.sunLight.intensity);
    void sun;
  }
}

// select helper (TSL select with node args)
import { select } from 'three/tsl';
function select3(c, a, b) {
  return select(c, a, b);
}
