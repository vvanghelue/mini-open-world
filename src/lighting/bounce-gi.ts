// @ts-nocheck -- TSL typings incomplete for these patterns
// One-bounce global illumination from the terrain ("2.5D irradiance field").
// For every cell of a coarse grid (core 48 m, far ring 320 m) a horizon scan in 12 azimuths finds the terrain that
// is visible from the cell; each newly visible slice of relief contributes its outgoing radiance (de-lit ortho
// albedo, darkened under forest, lit by the sun x heightfield shadows + sky light), weighted by the solid angle of
// the slice and the receiver's cosine. Result: light reflected by sunlit valley walls and snowfields onto the slopes
// facing them. Recomputed progressively (a few rows per frame) when the sun moves; stored normalised by the sun
// luminance so exposure changes do not invalidate it. Read with textureLoad + manual bilinear (no sampler).
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, uvec2, ivec2, instanceIndex, textureStore, Loop, If, max, min, clamp, floor,
  mix, dot, normalize, sqrt, cos, sin, texture,
} from 'three/tsl';
import type { Engine, System } from '../core/engine';
import { settings } from '../core/settings';
import { registerCommand } from '../agent/bridge';
import { storage } from 'three/tsl';
import type { Terrain } from '../terrain/terrain';
import type { Atmosphere } from '../sky/atmosphere';
import type { TimeOfDay } from '../sky/time-of-day';
import type { TerrainShadows } from './terrain-shadows';
import type { SkyVisibility } from './sky-visibility';

export const giSettings = settings.group('gi', 'Light bounce (GI)', {
  enabled: { value: true, label: 'Light bounced off the terrain' },
  strength: { value: 1, min: 0, max: 3, step: 0.05, label: 'Bounce strength' },
  rowsPerFrame: { value: 2, min: 1, max: 64, step: 1, label: 'Rows re-baked per frame', help: 'Small slices: a spread-out re-bake causes no slow frame.' },
  sunTolerance: { value: 1.5, min: 0.25, max: 10, step: 0.25, label: 'Re-bake when the sun moves by (°)' },
});

const NDIR = 12;

interface Grid {
  name: string;
  res: number;
  size: number;
  steps: number;
  tex: THREE.StorageTexture[];
  node: any; // TextureNode reading the front buffer
  front: number;
  valid: boolean;
  job: { active: boolean; row: number };
  uRow: any;
  compute: any[]; // one per target buffer
}

export class BounceGI implements System {
  readonly name = 'bounceGI';
  private engine!: Engine;
  private core!: Grid;
  private far!: Grid;
  private readonly uCam = uniform(new THREE.Vector3());
  private readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uSunCol = uniform(new THREE.Color());
  private readonly uInvSunLum = uniform(0);
  private readonly uSunLumNow = uniform(0);
  private readonly uStrength = uniform(1);
  private readonly bakedSun = new THREE.Vector3(0, -1, 0);
  private jobSun = new THREE.Vector3();

  constructor(private terrain: Terrain, private atmosphere: Atmosphere, private time: TimeOfDay, private shadows: TerrainShadows, private skyVis: SkyVisibility) {}

  init(engine: Engine) {
    this.engine = engine;
    const m = this.terrain.data.meta;
    const mk = (name: string, res: number, size: number, steps: number): Grid => {
      const tex = [0, 1].map(() => {
        const t = new THREE.StorageTexture(res, res);
        t.type = THREE.HalfFloatType;
        t.format = THREE.RGBAFormat;
        t.minFilter = t.magFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        return t;
      });
      const g: Grid = { name, res, size, steps, tex, node: new THREE.TextureNode(tex[0]), front: 0, valid: false, job: { active: false, row: 0 }, uRow: uniform(0), compute: [] };
      g.compute = [0, 1].map((target) => this.buildCompute(g, target));
      return g;
    };
    this.far = mk('far', 256, m.far.size, 14);
    this.core = mk('core', 512, m.core.size, 20);
    // compile all four bake pipelines now: compiled lazily, the second buffer's first use (first re-bake, mid-game)
    // froze one frame for ~85 ms. One row each with a zero sun scale (writes zeros into not-yet-valid grids).
    for (const g of [this.far, this.core]) {
      for (const c of g.compute) {
        g.uRow.value = 0;
        c.count = g.res;
        engine.renderer.compute(c);
      }
    }
    settings.on('gi.strength', (v) => (this.uStrength.value = v as number), true);

    // diagnostics: bounce vs sky irradiance (upward normal, pre-exposed) at a world point
    const probeBuf = new THREE.StorageBufferAttribute(new Float32Array(8), 4);
    const uProbe = uniform(new THREE.Vector2());
    const probe = Fn(() => {
      const out = storage(probeBuf, 'vec4', 2);
      out.element(0).assign(vec4(this.irradiance(uProbe), this.uSunLumNow));
      out.element(1).assign(vec4(this.atmosphere.skyIrradiance(vec3(0, 1, 0)), this.core.valid ? 1 : 0));
    })().compute(1);
    registerCommand('gi-probe', 'Bounce irradiance vs sky irradiance at {x,z} (default: camera)', async ({ x, z }) => {
      const c = engine.camera.position;
      uProbe.value.set(x ?? c.x, z ?? c.z);
      engine.renderer.compute(probe);
      const a = new Float32Array(await engine.renderer.getArrayBufferAsync(probeBuf));
      const r = (v: number) => +v.toPrecision(3);
      return { bounce: [r(a[0]), r(a[1]), r(a[2])], sunLum: r(a[3]), skyUp: [r(a[4]), r(a[5]), r(a[6])], coreValid: this.core.valid, farValid: this.far.valid };
    });
  }

  // ---------------------------------------------------------------- bake (one dispatch = some rows of one grid)
  private buildCompute(g: Grid, target: number) {
    const H = this.terrain.heightNode;
    const forest = this.terrain.forestNode;
    const cw = this.terrain.coreWeightNode;
    const m = this.terrain.data.meta;
    const tx = this.terrain.textures;
    const cell = g.size / g.res;
    const maxRows = 64;
    const normalAt = (xz: any, e: any) =>
      normalize(vec3(H(xz.sub(vec2(e, 0))).sub(H(xz.add(vec2(e, 0)))), e.mul(2), H(xz.sub(vec2(0, e))).sub(H(xz.add(vec2(0, e))))));
    const albedoAt = (xz: any) => {
      const a = mix(texture(tx.farAlbedo, xz.div(m.far.size).add(0.5)).level(float(0)).rgb, texture(tx.macroAlbedo, xz.div(m.core.size).add(0.5)).level(float(0)).rgb, cw(xz));
      // canopies are darker than the de-lit ortho suggests (see terrain-material.ts)
      return a.mul(mix(vec3(1), vec3(0.42, 0.46, 0.4), forest(xz)));
    };
    return Fn(() => {
      const x = instanceIndex.mod(g.res);
      const y = instanceIndex.div(g.res).add(g.uRow);
      If(y.lessThan(g.res), () => {
        const p = vec2(float(x).add(0.5), float(y).add(0.5)).mul(cell).sub(g.size / 2).toVar();
        const h0 = H(p).add(1).toVar();
        const n0 = normalAt(p, float(cell * 0.5)).toVar();
        const E = vec3(0).toVar();
        If(this.uInvSunLum.greaterThan(0), () => {
          Loop({ start: 0, end: NDIR, name: 'gd' } as any, ({ gd }) => {
            const a = float(gd).add(0.5).mul((2 * Math.PI) / NDIR);
            const d = vec2(cos(a), sin(a)).toVar();
            const t = float(cell * 0.5).toVar();
            // the first sample is the receiver's own slope: it only sets the starting horizon
            const maxTan = H(p.add(d.mul(t))).sub(h0).div(t).toVar();
            Loop({ start: 0, end: g.steps, name: 'gs' } as any, () => {
              t.assign(t.mul(1.3).add(cell * 0.5));
              const q = p.add(d.mul(t)).toVar();
              const h = H(q).toVar();
              const tanE = h.sub(h0).div(t).toVar();
              If(tanE.greaterThan(maxTan), () => {
                // slice of sky hidden by this piece of relief: elevations atan(maxTan) .. atan(tanE)
                const i1 = float(1).div(sqrt(maxTan.mul(maxTan).add(1)));
                const i2 = float(1).div(sqrt(tanE.mul(tanE).add(1)));
                const s1 = maxTan.mul(i1), s2 = tanE.mul(i2);
                const dir1 = vec3(d.x.mul(i1), s1, d.y.mul(i1));
                const dir2 = vec3(d.x.mul(i2), s2, d.y.mul(i2));
                const dm = normalize(dir1.add(dir2));
                const dOmega = s2.sub(s1).mul((2 * Math.PI) / NDIR);
                const cosR = max(dot(n0, dm), 0);
                // outgoing radiance of the visible terrain
                const nq = normalAt(q, max(t.mul(0.04), float(cell * 0.5))).toVar();
                const vis = this.shadows.visibilityFromAt(vec3(q.x, h.add(2), q.y), this.uCam);
                const Eq = this.uSunCol.mul(max(dot(nq, this.uSunDir), 0).mul(vis)).add(this.atmosphere.skyIrradiance(nq).mul(this.skyVis.visibility(q)));
                E.addAssign(albedoAt(q).mul(Eq).mul(cosR.mul(dOmega).mul(1 / Math.PI)));
                maxTan.assign(tanE);
              });
            });
          });
        });
        textureStore(g.tex[target], uvec2(x, y), vec4(E.mul(this.uInvSunLum), 1)).toWriteOnly();
      });
    })().compute(g.res * maxRows).setName(`bounceGI_${g.name}_${target}`);
  }

  update() {
    const s = giSettings;
    const sun = this.atmosphere.sunLight;
    const sunCol = this.uSunCol.value;
    const lum = (c: THREE.Color, k: number) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * k;
    const sunUp = this.time.sunDir.y > -0.02;
    this.uSunLumNow.value = s.enabled && sunUp ? lum(sun.color, sun.intensity) * s.strength : 0;
    this.uCam.value.copy(this.engine.camera.position);
    if (!s.enabled) return;
    // start a new bake (far first, the core right after) when the sun moved enough
    const active = this.far.job.active || this.core.job.active;
    if (!active && (this.time.sunDir.angleTo(this.bakedSun) > (s.sunTolerance * Math.PI) / 180 || !this.core.valid)) {
      this.jobSun.copy(this.time.sunDir);
      this.uSunDir.value.copy(this.jobSun);
      sunCol.copy(sun.color).multiplyScalar(sun.intensity);
      const l = lum(sun.color, sun.intensity);
      this.uInvSunLum.value = sunUp && l > 1e-6 ? 1 / l : 0;
      this.far.job = { active: true, row: 0 };
      this.core.job = { active: true, row: 0 };
    }
    let budget = s.rowsPerFrame;
    for (const g of [this.far, this.core]) {
      if (!g.job.active || budget <= 0) continue;
      // the far grid has 4x fewer cells per row: give it proportionally more rows
      const rows = Math.min(g === this.far ? budget * 2 : budget, g.res - g.job.row, 64);
      g.uRow.value = g.job.row;
      const c = g.compute[1 - g.front];
      c.count = rows * g.res;
      this.engine.renderer.compute(c);
      g.job.row += rows;
      budget -= g === this.far ? Math.ceil(rows / 2) : rows;
      if (g.job.row >= g.res) {
        g.front = 1 - g.front;
        g.node.value = g.tex[g.front];
        g.job.active = false;
        g.valid = true;
        if (g === this.core) this.bakedSun.copy(this.jobSun);
      }
    }
  }

  private bilinear(g: Grid, xz: any) {
    const p = xz.div(g.size).add(0.5).mul(g.res).sub(0.5);
    const i0 = clamp(floor(p), vec2(0), vec2(g.res - 1));
    const f = clamp(p.sub(i0), vec2(0), vec2(1));
    const i1 = min(i0.add(1), vec2(g.res - 1));
    const a = g.node.load(ivec2(i0)).rgb, b = g.node.load(ivec2(vec2(i1.x, i0.y))).rgb;
    const c = g.node.load(ivec2(vec2(i0.x, i1.y))).rgb, d = g.node.load(ivec2(i1)).rgb;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /** TSL: bounce irradiance (pre-exposed, current sun) at world xz. Multiply by albedo / PI for radiance. */
  irradiance(xz: any) {
    return mix(this.bilinear(this.far, xz), this.bilinear(this.core, xz), this.terrain.coreWeightNode(xz)).mul(this.uSunLumNow);
  }
}
