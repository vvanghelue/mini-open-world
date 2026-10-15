// Heightfield sun shadows to the horizon ("shadow ceiling" clipmap).
// For every texel we march the heightfield towards the sun and store
//   C = max_t ( H(p + t·d) - t·tanE )   (absolute altitude below which a point at p is in shadow)
// plus the distance of the dominant occluder (for penumbra). Any receiver (terrain, trees, plane...) is lit when
// its height is above C — so mountains shadow valleys tens of km away and forest canopies shade the ground.
// Three nested levels (near / mid / far), finer levels hand off to the coarser one beyond their march range.
// Each level is double-buffered and recomputed progressively (a few rows per frame) when the sun or camera moves.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec2, vec4, float, uvec2, instanceIndex, texture, textureStore, Loop, If, Break, max, min, clamp, smoothstep,
  mix, select, abs, positionWorld, cameraPosition, length, floor, ivec2,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import type { Terrain } from '../terrain/terrain';
import type { TimeOfDay } from '../sky/time-of-day';
import { settings } from '../core/settings';

export const shadowSettings = settings.group('shadows', 'Ombres', {
  terrainShadows: { value: true, label: 'Ombres du relief' },
  canopyHeight: { value: 22, min: 0, max: 40, step: 1, label: 'Hauteur canopée (m)' },
  rowsPerFrame: { value: 64, min: 8, max: 512, step: 8, label: 'Lignes calculées / image' },
  softness: { value: 1.0, min: 0.2, max: 4, step: 0.1, label: 'Douceur pénombre' },
});

interface Level {
  name: string;
  res: number;
  size: number; // metres
  march: number; // max march distance before handing off to the coarser level (m)
  snap: number; // camera-follow snapping (m), 0 = fixed at world origin
  sunTolDeg: number; // recompute when the sun moved more than this
  tex: [THREE.StorageTexture, THREE.StorageTexture];
  front: number;
  // parameters of the front (displayed) buffer
  uOrigin: any; // vec2 world xz of the min corner
  uSize: any;
  // parameters of the job being computed into the back buffer
  job: { origin: THREE.Vector2; sun: THREE.Vector3; row: number; active: boolean };
  frontSun: THREE.Vector3;
  frontCenter: THREE.Vector2;
  computeTo: THREE.ComputeNode[]; // [writes tex[0], writes tex[1]]
  frontNode: any; // texture node bound to the front buffer (value swapped on completion)
  uJobOrigin: any;
  uRowStart: any;
  valid: boolean;
}

const MAX_H = 4400; // highest possible occluder (m)

export class TerrainShadows implements System {
  readonly name = 'terrainShadows';
  levels: Level[] = [];
  private engine!: Engine;
  private uSunDirH = uniform(new THREE.Vector2(1, 0));
  private _center = new THREE.Vector2();
  private uTanE = uniform(1);
  private uSunUp = uniform(1);
  private uCanopy = uniform(22);
  private uSoft = uniform(1);
  private uEnabled = uniform(1);
  /** TSL node: sun visibility (0..1) for the current fragment world position. */
  shadowNode!: any;

  constructor(private terrain: Terrain, private time: TimeOfDay) {}

  init(engine: Engine) {
    this.engine = engine;
    const mk = (name: string, res: number, size: number, march: number, snap: number, sunTolDeg: number): Level => {
      const tex = [0, 1].map(() => {
        const t = new THREE.StorageTexture(res, res);
        t.type = THREE.FloatType;
        t.format = THREE.RGFormat;
        // nearest => three binds no sampler (textureLoad); we filter manually. Saves 3 of the 16 fragment samplers.
        t.minFilter = t.magFilter = THREE.NearestFilter;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.generateMipmaps = false;
        return t;
      }) as [THREE.StorageTexture, THREE.StorageTexture];
      return {
        name, res, size, march, snap, sunTolDeg, tex, front: 0,
        uOrigin: uniform(new THREE.Vector2(-size / 2, -size / 2)), uSize: uniform(size),
        job: { origin: new THREE.Vector2(), sun: new THREE.Vector3(), row: 0, active: false },
        frontSun: new THREE.Vector3(0, -1, 0), frontCenter: new THREE.Vector2(1e9, 1e9),
        computeTo: [], frontNode: texture(tex[0]), uJobOrigin: uniform(new THREE.Vector2()), uRowStart: uniform(0), valid: false,
      };
    };
    // far level fixed on the world, finer levels follow the camera
    this.levels = [
      mk('near', 512, 2048, 600, 256, 0.05),
      mk('mid', 512, 10240, 3000, 1280, 0.1),
      mk('far', 512, 81920, 45000, 0, 0.2),
    ];
    for (let i = 0; i < this.levels.length; i++) this.levels[i].computeTo = [this.buildCompute(i, 0), this.buildCompute(i, 1)];
    this.shadowNode = this.buildSampler();
    settings.on('shadows.terrainShadows', (v) => (this.uEnabled.value = v ? 1 : 0), true);
  }

  // ---------------------------------------------------------------- compute (one dispatch = rowsPerFrame rows)
  private buildCompute(li: number, target: number) {
    const L = this.levels[li];
    const coarser = this.levels[li + 1];
    const H = this.terrain.heightNode;
    const forest = this.terrain.forestNode;
    const texel = L.size / L.res;
    const maxRows = 512;
    const fn = Fn(() => {
      const x = instanceIndex.mod(L.res);
      const y = instanceIndex.div(L.res).add(L.uRowStart);
      If(y.lessThan(L.res), () => {
        const p = L.uJobOrigin.add(vec2(float(x).add(0.5), float(y).add(0.5)).mul(texel)).toVar();
        const h0 = H(p).toVar();
        const C = h0.sub(1e4).toVar();
        const tOcc = float(0).toVar();
        const t = float(texel * 0.75).toVar();
        const step = float(texel * 0.75).toVar();
        If(this.uSunUp.lessThan(0.5), () => {
          C.assign(1e5);
        }).Else(() => {
          Loop(260, () => {
            const q = p.add(this.uSunDirH.mul(t));
            const canopy = select(t.greaterThan(30), forest(q).mul(this.uCanopy), float(0));
            const v = H(q).add(canopy).sub(t.mul(this.uTanE)).toVar();
            If(v.greaterThan(C), () => {
              C.assign(v);
              tOcc.assign(t);
            });
            // nothing further along the ray can exceed C
            If(float(MAX_H).sub(t.mul(this.uTanE)).lessThan(C), () => {
              Break();
            });
            if (coarser) {
              If(t.greaterThan(L.march), () => {
                // hand off: the coarser level already knows the ceiling from q onwards
                const cuv = q.sub(coarser.uOrigin).div(coarser.uSize);
                const inside = cuv.x.greaterThan(0).and(cuv.y.greaterThan(0)).and(cuv.x.lessThan(1)).and(cuv.y.lessThan(1));
                If(inside, () => {
                  const cs = this.bilinear(coarser, cuv).toVar();
                  const vc = cs.x.sub(t.mul(this.uTanE));
                  If(vc.greaterThan(C), () => {
                    C.assign(vc);
                    tOcc.assign(t.add(cs.y));
                  });
                });
                Break();
              });
            } else {
              If(t.greaterThan(L.march), () => {
                Break();
              });
            }
            t.addAssign(step);
            step.mulAssign(1.03);
          });
        });
        textureStore(L.tex[target], uvec2(x, y), vec4(C, tOcc, 0, 1)).toWriteOnly();
      });
    });
    return fn().compute(L.res * maxRows).setName(`terrainShadow_${L.name}_${target}`);
  }

  // ---------------------------------------------------------------- sampling
  private buildSampler() {
    this.visibilityAt = Fn(([pw]: [any]) => this.visibilityImpl(pw, cameraPosition));
    // compute shaders have no camera: the caller passes the camera position uniform
    this.visibilityFromAt = Fn(([pw, cam]: [any, any]) => this.visibilityImpl(pw, cam));
    return Fn(() => this.visibilityImpl(positionWorld, cameraPosition))();
  }

  /** Manual bilinear fetch of a level's front texture at uv (0..1). */
  private bilinear(L: Level, uv: any): any {
    const res = L.res;
    const p = uv.mul(res).sub(0.5);
    const i0 = clamp(floor(p), vec2(0), vec2(res - 1));
    const f = clamp(p.sub(i0), vec2(0), vec2(1));
    const i1 = min(i0.add(1), vec2(res - 1));
    const t00 = L.frontNode.load(ivec2(i0)).xy;
    const t10 = L.frontNode.load(ivec2(vec2(i1.x, i0.y))).xy;
    const t01 = L.frontNode.load(ivec2(vec2(i0.x, i1.y))).xy;
    const t11 = L.frontNode.load(ivec2(i1)).xy;
    return mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y);
  }

  /** TSL: sun visibility at an arbitrary world position (usable in vertex shaders). */
  visibilityAt!: (p: any) => any;
  /** Same with an explicit camera position (compute shaders). */
  visibilityFromAt!: (p: any, cam: any) => any;

  private visibilityImpl(pw: any, cam: any) {
    // pick the finest level containing the point; blend with the next level only inside the border band
    return Fn(() => {
      const p = pw;
      const dist = length(cam.sub(p));
      const bias = max(float(0.6), dist.mul(0.003));
      const vis = float(1).toVar();
      const evalLevel = (L: Level) => {
        const uv = p.xz.sub(L.uOrigin).div(L.uSize);
        const cs = this.bilinear(L, uv);
        const texel = L.uSize.div(L.res);
        const w = max(texel.mul(0.6), cs.y.mul(0.0047).mul(this.uSoft)).add(0.3);
        return smoothstep(w.negate(), w, p.y.add(bias).sub(cs.x));
      };
      const edgeOf = (L: Level) => {
        const uv = p.xz.sub(L.uOrigin).div(L.uSize);
        return min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)));
      };
      const [n, m, f] = this.levels;
      const eN = edgeOf(n).toVar();
      const eM = edgeOf(m).toVar();
      If(eN.greaterThan(0.08), () => {
        vis.assign(evalLevel(n));
      }).ElseIf(eN.greaterThan(0), () => {
        vis.assign(mix(evalLevel(m), evalLevel(n), smoothstep(0, 0.08, eN)));
      }).ElseIf(eM.greaterThan(0.08), () => {
        vis.assign(evalLevel(m));
      }).ElseIf(eM.greaterThan(0), () => {
        vis.assign(mix(evalLevel(f), evalLevel(m), smoothstep(0, 0.08, eM)));
      }).Else(() => {
        vis.assign(evalLevel(f));
      });
      return mix(float(1), vis, this.uEnabled);
    })();
  }

  // ---------------------------------------------------------------- scheduling
  update(_ctx: FrameContext) {
    const s = shadowSettings;
    this.uCanopy.value = s.canopyHeight;
    this.uSoft.value = s.softness;
    if (!s.terrainShadows) return;
    const cam = this.engine.camera.position;
    const sun = this.time.sunDir;
    // process the coarsest pending job first (finer levels read it)
    let budget = s.rowsPerFrame;
    for (let i = this.levels.length - 1; i >= 0 && budget > 0; i--) {
      const L = this.levels[i];
      if (!L.job.active) {
        const center = this._center.set(L.snap ? Math.round(cam.x / L.snap) * L.snap : 0, L.snap ? Math.round(cam.z / L.snap) * L.snap : 0);
        const moved = L.snap && (Math.abs(center.x - L.frontCenter.x) > 0 || Math.abs(center.y - L.frontCenter.y) > 0);
        const sunMoved = sun.angleTo(L.frontSun) > (L.sunTolDeg * Math.PI) / 180;
        // a finer level must not start before its coarser level is valid
        const coarserReady = i === this.levels.length - 1 || this.levels[i + 1].valid;
        if ((moved || sunMoved || !L.valid) && coarserReady) {
          L.job.active = true;
          L.job.row = 0;
          L.job.sun.copy(sun);
          L.job.origin.set(center.x - L.size / 2, center.y - L.size / 2);
          ((L as any).jobCenter ??= new THREE.Vector2()).copy(center);
        }
      }
      if (!L.job.active) continue;
      // sun parameters for this job
      const js = L.job.sun;
      const horiz = Math.hypot(js.x, js.z);
      this.uSunUp.value = js.y > 0.002 ? 1 : 0;
      if (horiz > 1e-4) this.uSunDirH.value.set(js.x / horiz, js.z / horiz);
      this.uTanE.value = Math.min(1e3, js.y / Math.max(horiz, 1e-4));
      L.uJobOrigin.value.copy(L.job.origin);
      const rows = Math.min(budget, L.res - L.job.row, 512);
      L.uRowStart.value = L.job.row;
      const cn = L.computeTo[1 - L.front];
      (cn as any).count = rows * L.res;
      this.engine.renderer.compute(cn);
      L.job.row += rows;
      budget -= rows;
      if (L.job.row >= L.res) {
        // swap: back buffer becomes front
        L.front = 1 - L.front;
        L.frontNode.value = L.tex[L.front];
        L.uOrigin.value.copy(L.job.origin);
        L.frontSun.copy(L.job.sun);
        L.frontCenter.copy((L as any).jobCenter);
        L.job.active = false;
        L.valid = true;
      }
    }
  }
}
