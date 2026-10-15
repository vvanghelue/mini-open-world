// @ts-nocheck -- TSL type definitions are incomplete for the storage/uniformArray patterns used here
// Rocks and boulders near the camera. A compute pass scatters candidates on a 2.5 m jittered grid, keeps them from
// the land cover (scree and rock areas, a few on alpine pastures and in forests), draws sizes from a power law
// (many stones, rare 2-3 m boulders) and sinks each rock into the ground at its own visibility distance (larger
// rocks are seen from further away). Two faceted procedural meshes (rounded boulder, angular slab) with per-instance
// non-uniform scale, triplanar rock texture tinted by the orthophoto. Large rocks collide with the walker through a
// CPU replica of the same scatter (RockQuery) — keep both in sync.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, storage, instanceIndex, vec2, vec3, vec4, float, int, uint, If, Return, atomicAdd, atomicStore,
  smoothstep, min, max, sqrt, positionLocal, normalLocal, sin, cos, mix, texture, transformNormalToView, normalize, abs,
  positionWorld, varying, clamp, pow, step,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import type { Terrain } from '../terrain/terrain';
import { skyVisAt, terrainHooks } from '../terrain/terrain-material';
import { worldColliders } from '../world/colliders';
import { qualityScaled } from '../core/adaptive';
import { freezeStatic } from '../core/static';

export const rockSettings = settings.group('rocks', 'Rochers', {
  enabled: { value: true, label: 'Rochers et blocs' },
  density: { value: 1, min: 0, max: 3, step: 0.05, label: 'Densité' },
  distance: { value: 1, min: 0.3, max: 2, step: 0.05, label: 'Distance (x)' },
});

const GRID = 2.5;
const CAP = 12000; // per variant
const NV = 2;
const SMAX = 2.8;
// visibility distance of a rock of size s (metres) at distance factor 1
const visDist = (s: number) => 30 + 90 * s;

// ---------------------------------------------------------------- shared rules (GPU scatter and CPU replica)
function pcgJS(v: number) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
const rndJS = (h: number) => (h & 0xffffff) / 16777216;
const SEED = 0x68bc21eb;
/** keep probability from land cover [forest, grass, rock, snow, water, urban, gravel] and altitude */
function keepJS(c: number[], y: number) {
  const alpine = Math.min(1, Math.max(0, (y - 1500) / 400));
  const a = alpine * alpine * (3 - 2 * alpine);
  return (c[2] * 0.5 + c[6] * 0.3 + c[1] * (0.008 + a * 0.05) + c[0] * 0.025) * (1 - c[3]) * (1 - c[4]) * (1 - c[5]);
}

export interface RockCollider { x: number; z: number; r: number }

/** CPU replica of the scatter: rocks big enough to block the walker near (x, z). */
export class RockQuery {
  private cover = new Array(7);
  constructor(private terrain: Terrain) {}
  near(x: number, z: number, radius: number, out: RockCollider[] = []) {
    out.length = 0;
    if (!rockSettings.enabled) return out;
    const ix0 = Math.floor((x - radius) / GRID), ix1 = Math.floor((x + radius) / GRID);
    const iz0 = Math.floor((z - radius) / GRID), iz1 = Math.floor((z + radius) / GRID);
    const t = this.terrain;
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const h0 = pcgJS((ix >>> 0) ^ pcgJS(((iz >>> 0) + SEED) >>> 0));
      const h1 = pcgJS(h0), h2 = pcgJS(h1), h3 = pcgJS(h2), h4 = pcgJS(h3);
      const s = 0.2 + (SMAX - 0.2) * Math.pow(rndJS(h3), 5);
      if (s < 0.55) continue; // small stones: step over them
      const rx = (ix + 0.1 + rndJS(h0) * 0.8) * GRID, rz = (iz + 0.1 + rndJS(h1) * 0.8) * GRID;
      const y = t.heightAt(rx, rz);
      const gx = t.heightAt(rx + 1.5, rz) - y, gz = t.heightAt(rx, rz + 1.5) - y;
      if (gx * gx + gz * gz > 3.2) continue;
      if (rndJS(h2) > keepJS(t.coverAt(rx, rz, this.cover), y) * rockSettings.density) continue;
      const sx = 0.7 + 0.6 * rndJS(pcgJS(h1)), sz = 0.7 + 0.6 * rndJS(pcgJS(h2));
      void h4;
      out.push({ x: rx, z: rz, r: s * Math.max(sx, sz) * 0.8 });
    }
    return out;
  }
}

// ---------------------------------------------------------------- meshes
export function makeRockGeometry(variant: number) {
  // faceted: non-indexed icosphere, displaced by a hash of the (rounded) vertex position so shared corners match
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const hash = (x: number, y: number, z: number) => {
    const k = Math.round(x * 1000) * 73856093 ^ Math.round(y * 1000) * 19349663 ^ Math.round(z * 1000) * 83492791;
    return rndJS(pcgJS(k + variant * 977));
  };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = variant === 0 ? 0.22 : 0.38;
    const r = 1 + (hash(x, y, z) - 0.5) * 2 * k;
    x *= r; y *= r; z *= r;
    if (variant === 1) { y *= 0.55; x *= 1.15; } // slab: flat and wide
    y = Math.max(y, -0.35); // flat base, buried
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

export class Rocks implements System {
  readonly name = 'rocks';
  private engine!: Engine;
  private inst!: THREE.StorageBufferAttribute;
  private counters!: THREE.StorageBufferAttribute;
  private args!: THREE.IndirectStorageBufferAttribute;
  private meshes: THREE.Mesh[] = [];
  private reset!: any;
  private scatter!: any;
  private finalize!: any;
  private uCam = uniform(new THREE.Vector3());
  private uOrigin = uniform(new THREE.Vector2());
  private uN = uniform(0);
  private uDensity = uniform(1);
  private uDistMul = uniform(1);
  private uPlanes = uniformArray([0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()));
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private query!: RockQuery;
  private near: RockCollider[] = [];
  private nearAt = new THREE.Vector2(1e9, 1e9);

  constructor(private terrain: Terrain) {}

  init(engine: Engine) {
    this.engine = engine;
    this.inst = new THREE.StorageBufferAttribute(new Float32Array(CAP * NV * 12), 4);
    this.counters = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
    const geos = [0, 1].map((v) => makeRockGeometry(v));
    this.args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(NV * 5), 5);
    const argsInit = this.args.array as Uint32Array;
    for (let v = 0; v < NV; v++) {
      const g = geos[v];
      argsInit[v * 5] = g.attributes.position.count; // non-indexed draw: vertexCount
      g.setIndirect(this.args, v * 5 * 4);
      const mesh = new THREE.Mesh(g, this.makeMaterial(v));
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `rocks${v}`;
      engine.scene.add(mesh);
      freezeStatic(mesh);
      this.meshes.push(mesh);
    }
    this.buildComputes();
    settings.on('rocks.enabled', (v) => this.meshes.forEach((m) => (m.visible = v as boolean)), true);
    // walker collisions with large rocks
    this.query = new RockQuery(this.terrain);
    worldColliders.push((p, r) => {
      if (Math.hypot(p.x - this.nearAt.x, p.z - this.nearAt.y) > 4) {
        this.query.near(p.x, p.z, 10, this.near);
        this.nearAt.set(p.x, p.z);
      }
      for (const c of this.near) {
        const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), m = c.r + r;
        if (d < m && d > 1e-4) { p.x = c.x + (dx / d) * m; p.z = c.z + (dz / d) * m; }
      }
    });
  }

  private makeMaterial(variant: number) {
    const tx = this.terrain.textures;
    const m = new THREE.MeshStandardNodeMaterial();
    const inst = storage(this.inst, 'vec4', CAP * NV * 3).toReadOnly();
    const i3 = int(instanceIndex).add(variant * CAP).mul(3);
    const d0 = inst.element(i3), d1 = inst.element(i3.add(1)), d2 = inst.element(i3.add(2));
    const vN = varying(vec3(0, 1, 0), `rockN${variant}`);
    const vTint = varying(vec3(1), `rockTint${variant}`);
    const vBottom = varying(float(1), `rockBottom${variant}`);
    m.positionNode = Fn(() => {
      const s = d0.w, yaw = d1.x;
      const sc = vec3(d1.y, d1.z, d1.w).mul(s);
      const c = cos(yaw), sn = sin(yaw);
      const rot = (v: any) => vec3(c.mul(v.x).add(sn.mul(v.z)), v.y, sn.negate().mul(v.x).add(c.mul(v.z)));
      vN.assign(normalize(rot(normalLocal.div(vec3(d1.y, d1.z, d1.w)))));
      vTint.assign(d2.xyz);
      vBottom.assign(smoothstep(-0.35, 0.15, positionLocal.y));
      // d2.w = sink depth (fade into the ground at the visibility distance)
      return rot(positionLocal.mul(sc)).add(d0.xyz).sub(vec3(0, d2.w, 0));
    })();
    m.normalNode = transformNormalToView(vN);
    // triplanar rock texture (scree layer), tinted by the orthophoto colour under the rock
    const mean = vec3(...tx.layers[2].meanAlbedo);
    m.colorNode = Fn(() => {
      const n = abs(vN);
      const w = pow(n, vec3(4));
      const ws = w.x.add(w.y).add(w.z);
      const p = positionWorld.mul(1 / 1.6);
      const sA = (uv: any) => texture(tx.albedoArray, uv).depth(int(2) as any).rgb;
      const a = sA(p.zy).mul(w.x).add(sA(p.xz).mul(w.y)).add(sA(p.xy).mul(w.z)).div(ws);
      const tint = clamp(vTint.div(mean), 0.35, 2.5);
      return a.mul(mix(vec3(1), tint, 0.6)).mul(1.15);
    })();
    m.roughnessNode = float(0.88);
    m.metalnessNode = float(0);
    m.aoNode = Fn(() => skyVisAt(positionWorld.xz).mul(mix(float(0.65), float(1), vBottom)))();
    // light bounced by the relief
    m.emissiveNode = Fn(() => (terrainHooks.bounce ? vTint.mul(terrainHooks.bounce(positionWorld.xz)).mul(0.6 / Math.PI) : vec3(0)))();
    return m;
  }

  private buildComputes() {
    const t = this.terrain;
    const tx = t.textures;
    const H = t.heightNode;
    const inst = storage(this.inst, 'vec4', CAP * NV * 3);
    const counters = storage(this.counters, 'uint', 4).toAtomic();
    const args = storage(this.args, 'uint', NV * 5);
    const m = t.data.meta;
    const pcg = Fn(([v]) => {
      const state = v.mul(uint(747796405)).add(uint(2891336453));
      const word = state.shiftRight(state.shiftRight(uint(28)).add(uint(4))).bitXor(state).mul(uint(277803737));
      return word.shiftRight(uint(22)).bitXor(word);
    });
    const rnd = (h) => float(h.bitAnd(uint(0xffffff))).div(16777216);

    this.reset = Fn(() => {
      atomicStore(counters.element(0), uint(0));
      atomicStore(counters.element(1), uint(0));
    })().compute(1).setName('rocksReset');

    this.scatter = Fn(() => {
      const n = int(this.uN);
      const idx = int(instanceIndex);
      If(idx.greaterThanEqual(n.mul(n)), () => Return());
      const ix = int(this.uOrigin.x).add(idx.mod(n));
      const iz = int(this.uOrigin.y).add(idx.div(n));
      const h0 = pcg(uint(ix).bitXor(pcg(uint(iz).add(uint(SEED))))).toVar();
      const h1 = pcg(h0).toVar();
      const h2 = pcg(h1).toVar();
      const h3 = pcg(h2).toVar();
      const h4 = pcg(h3).toVar();
      const s = float(0.2).add(pow(rnd(h3), 5).mul(SMAX - 0.2)).toVar();
      const x = float(ix).add(0.1).add(rnd(h0).mul(0.8)).mul(GRID);
      const z = float(iz).add(0.1).add(rnd(h1).mul(0.8)).mul(GRID);
      const dx = x.sub(this.uCam.x), dz = z.sub(this.uCam.z);
      const d = sqrt(dx.mul(dx).add(dz.mul(dz)));
      const vis = s.mul(90).add(30).mul(this.uDistMul);
      If(d.greaterThan(vis), () => Return());
      const xz = vec2(x, z);
      const y = H(xz).toVar();
      const gx = H(xz.add(vec2(1.5, 0))).sub(y), gz = H(xz.add(vec2(0, 1.5))).sub(y);
      If(gx.mul(gx).add(gz.mul(gz)).greaterThan(3.2), () => Return()); // > ~50 deg
      // land cover (same rule as keepJS)
      const cuv = xz.div(m.core.size).add(0.5), fuv = xz.div(m.far.size).add(0.5);
      const cw = t.coreWeightNode(xz);
      const A = mix(texture(tx.farLandcover, fuv).depth(int(0)).level(float(0)), texture(tx.landcover, cuv).depth(int(0)).level(float(0)), cw);
      const B = mix(texture(tx.farLandcover, fuv).depth(int(1)).level(float(0)), texture(tx.landcover, cuv).depth(int(1)).level(float(0)), cw);
      const alpine = smoothstep(1500, 1900, y);
      const keep = A.b.mul(0.5).add(B.b.mul(0.3)).add(A.g.mul(alpine.mul(0.05).add(0.008))).add(A.r.mul(0.025))
        .mul(float(1).sub(A.a)).mul(float(1).sub(B.r)).mul(float(1).sub(B.g));
      If(rnd(h2).greaterThan(keep.mul(this.uDensity)), () => Return());
      const sx = rnd(pcg(h1)).mul(0.6).add(0.7), sz = rnd(pcg(h2)).mul(0.6).add(0.7), sy = rnd(pcg(h4)).mul(0.4).add(0.6);
      // frustum (sphere)
      const inside = float(1).toVar();
      const R = s.mul(1.4);
      for (let p = 0; p < 6; p++) {
        const pl = this.uPlanes.element(p);
        If(pl.x.mul(x).add(pl.y.mul(y)).add(pl.z.mul(z)).add(pl.w).lessThan(R.negate()), () => inside.assign(0));
      }
      If(inside.lessThan(0.5), () => Return());
      // sink into the ground over the last 25 % of the visibility distance (no pop)
      const sink = smoothstep(vis.mul(0.75), vis, d).mul(s.mul(sy).add(0.2));
      // variant as float math (select() + int() loses the cast in compute here), converted once
      const variantF = step(0.55, rnd(pcg(h3)));
      const macro = mix(texture(tx.farAlbedo, fuv).level(float(0)).rgb, texture(tx.macroAlbedo, cuv).level(float(0)).rgb, cw);
      const slot = atomicAdd(counters.element(uint(variantF)), uint(1)).toVar();
      If(slot.lessThan(uint(CAP)), () => {
        const i = int(float(slot).add(variantF.mul(CAP))).mul(3);
        inst.element(i).assign(vec4(x, y, z, s));
        inst.element(i.add(1)).assign(vec4(rnd(pcg(h0)).mul(6.2832), sx, sy, sz));
        inst.element(i.add(2)).assign(vec4(macro, sink));
      });
    })().compute(1).setName('rocksScatter');

    this.finalize = Fn(() => {
      for (let v = 0; v < NV; v++) {
        const c = atomicAdd(counters.element(v), uint(0));
        args.element(v * 5 + 1).assign(min(c, uint(CAP)));
      }
    })().compute(1).setName('rocksFinalize');
  }

  update(_ctx: FrameContext) {
    const s = rockSettings;
    if (!s.enabled) return;
    const cam = this.engine.camera;
    const distMul = qualityScaled(s.distance, 0.6); // adaptive detail
    const D = visDist(SMAX) * distMul;
    const agl = cam.position.y - this.terrain.heightAt(cam.position.x, cam.position.z);
    const show = agl < D;
    for (const m of this.meshes) m.visible = show;
    if (!show) return;
    this.uCam.value.copy(cam.position);
    this.uDensity.value = s.density;
    this.uDistMul.value = distMul;
    const n = Math.ceil((2 * D) / GRID) + 1;
    this.uOrigin.value.set(Math.floor((cam.position.x - D) / GRID), Math.floor((cam.position.z - D) / GRID));
    this.uN.value = n;
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, THREE.WebGPUCoordinateSystem, (cam as any).reversedDepth === true);
    for (let i = 0; i < 6; i++) {
      const p = this.frustum.planes[i];
      this.uPlanes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    }
    const r = this.engine.renderer;
    this.scatter.count = n * n;
    // one encoder / one submission for the three passes (each submit can block on a busy GPU queue)
    r.compute([this.reset, this.scatter, this.finalize]);
  }
}

