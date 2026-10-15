// @ts-nocheck -- TSL typings incomplete for these patterns
// Baked sky visibility (horizon-based ambient occlusion) of the terrain, computed on the GPU at startup.
// For every texel we find the horizon elevation in 12 azimuths (geometric march up to ~4 km) and integrate the
// cosine-weighted visible sky: V = mean(cos^2(h)). Valleys, gorges and couloirs receive less skylight.
// Stored in nearest-filtered float textures (read with manual bilinear: no sampler binding needed).
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec2, vec4, float, uvec2, instanceIndex, textureStore, Loop, If, max, min, clamp, floor, ivec2, mix,
  cos, sin, atan, sqrt,
} from 'three/tsl';
import type { Engine, System } from '../core/engine';
import type { Terrain } from '../terrain/terrain';
import { settings } from '../core/settings';

export const skyVisSettings = settings.group('skyVis', 'Sky light (GI)', {
  strength: { value: 1.0, min: 0, max: 1, step: 0.05, label: 'Sky occlusion (terrain)' },
});

interface Grid {
  res: number;
  size: number;
  tex: THREE.StorageTexture;
  node: any;
}

export class SkyVisibility implements System {
  readonly name = 'skyVisibility';
  private core!: Grid;
  private far!: Grid;
  readonly uStrength = uniform(1);

  constructor(private terrain: Terrain) {}

  init(engine: Engine) {
    const m = this.terrain.data.meta;
    const mk = (res: number, size: number): Grid => {
      const t = new THREE.StorageTexture(res, res);
      t.type = THREE.FloatType;
      t.format = THREE.RedFormat;
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return { res, size, tex: t, node: null };
    };
    this.core = mk(2048, m.core.size);
    this.far = mk(1024, m.far.size);
    const t0 = performance.now();
    for (const g of [this.far, this.core]) {
      const rowsPerDispatch = 256;
      const uRow = uniform(0);
      const comp = this.buildCompute(g, uRow, rowsPerDispatch);
      for (let r = 0; r < g.res; r += rowsPerDispatch) {
        uRow.value = r;
        engine.renderer.compute(comp);
      }
      g.node = new THREE.TextureNode(g.tex);
    }
    console.info(`sky visibility baked (submitted in ${(performance.now() - t0).toFixed(0)} ms)`);
    settings.on('skyVis.strength', (v) => (this.uStrength.value = v as number), true);
  }

  private buildCompute(g: Grid, uRow: any, rows: number) {
    const H = this.terrain.heightNode;
    const texel = g.size / g.res;
    const NDIR = 12;
    return Fn(() => {
      const x = instanceIndex.mod(g.res);
      const y = instanceIndex.div(g.res).add(uRow);
      If(y.lessThan(g.res), () => {
        const p = vec2(float(x).add(0.5), float(y).add(0.5)).mul(texel).sub(g.size / 2).toVar();
        const h0 = H(p).add(2).toVar();
        const acc = float(0).toVar();
        Loop({ start: 0, end: NDIR, name: 'dir' } as any, ({ dir }) => {
          const a = float(dir).add(0.37).mul((2 * Math.PI) / NDIR);
          const d = vec2(cos(a), sin(a));
          const maxTan = float(0).toVar();
          const t = float(texel).toVar();
          Loop({ start: 0, end: 26, name: 'st' } as any, () => {
            const h = H(p.add(d.mul(t)));
            maxTan.assign(max(maxTan, h.sub(h0).div(t)));
            t.mulAssign(1.28);
          });
          // cos^2(atan(x)) = 1 / (1 + x^2)
          acc.addAssign(float(1).div(maxTan.mul(maxTan).add(1)));
        });
        textureStore(g.tex, uvec2(x, y), vec4(acc.div(NDIR), 0, 0, 1)).toWriteOnly();
      });
    })().compute(g.res * rows).setName(`skyVisibility_${g.res}`);
  }

  private bilinear(g: Grid, xz: any) {
    const uv = xz.div(g.size).add(0.5);
    const p = uv.mul(g.res).sub(0.5);
    const i0 = clamp(floor(p), vec2(0), vec2(g.res - 1));
    const f = clamp(p.sub(i0), vec2(0), vec2(1));
    const i1 = min(i0.add(1), vec2(g.res - 1));
    const a = g.node.load(ivec2(i0)).x, b = g.node.load(ivec2(vec2(i1.x, i0.y))).x;
    const c = g.node.load(ivec2(vec2(i0.x, i1.y))).x, d = g.node.load(ivec2(i1)).x;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /** TSL: sky visibility (0..1) at world xz, core/far blended; strength-scaled. */
  visibility(xz: any) {
    const v = mix(this.bilinear(this.far, xz), this.bilinear(this.core, xz), this.terrain.coreWeightNode(xz));
    return mix(float(1), v, this.uStrength);
  }
}
void atan; void sqrt;
