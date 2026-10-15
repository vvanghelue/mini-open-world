// @ts-nocheck -- TSL type definitions are incomplete for the storage/uniformArray patterns used here
// GPU grass near the camera. A compute pass scatters tufts on a 0.25 m jittered grid around the camera, keeps them
// from the meadow land cover (thinning with distance, survivors widened), frustum-culls, takes the ground colour
// from the orthophoto, and appends to an instance buffer drawn with one indirect draw. Blades are opaque geometry
// (no alpha test) so the GPU's hidden-surface removal stays effective.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, storage, instanceIndex, vec2, vec3, vec4, float, int, uint, If, Return, atomicAdd, atomicStore,
  smoothstep, min, max, length, normalize, positionLocal, cameraPosition, sin, cos, time, mix, attribute, varying, texture,
  transformNormalToView, dot, clamp, pow, positionWorld, sqrt,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import type { Terrain } from '../terrain/terrain';
import { windUniforms, sunUniforms } from './tree-materials';
import { makeVertexLighting } from '../lighting/vertex-lighting';
import { qualityScaled } from '../core/adaptive';
import { freezeStatic } from '../core/static';

export const grassSettings = settings.group('grass', 'Herbe', {
  enabled: { value: true, label: 'Herbe 3D' },
  distance: { value: 42, min: 10, max: 90, step: 1, label: 'Distance (m)' },
  density: { value: 1, min: 0.1, max: 2, step: 0.05, label: 'Densité' },
  height: { value: 0.38, min: 0.05, max: 1, step: 0.01, label: 'Hauteur (m)' },
});

const SPACING = 0.25;
const CAP = 160000;

export class Grass implements System {
  readonly name = 'grass';
  private engine!: Engine;
  private inst!: THREE.StorageBufferAttribute;
  private counter!: THREE.StorageBufferAttribute;
  private args!: THREE.IndirectStorageBufferAttribute;
  private reset!: THREE.ComputeNode;
  private scatter!: THREE.ComputeNode;
  private finalize!: THREE.ComputeNode;
  private mesh!: THREE.Mesh;
  private uCam = uniform(new THREE.Vector3());
  private uOrigin = uniform(new THREE.Vector2());
  private uN = uniform(0);
  private uDist = uniform(42);
  private uDensity = uniform(1);
  private uHeight = uniform(0.32);
  private uPlanes = uniformArray([0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()));
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private gridN = 0;

  constructor(private terrain: Terrain) {}

  init(engine: Engine) {
    this.engine = engine;
    this.inst = new THREE.StorageBufferAttribute(new Float32Array(CAP * 8), 4);
    this.counter = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
    const geo = this.makeTuft();
    this.args = new THREE.IndirectStorageBufferAttribute(new Uint32Array([geo.index!.count, 0, 0, 0, 0]), 5);
    geo.setIndirect(this.args);
    this.mesh = new THREE.Mesh(geo, this.makeMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'grass';
    engine.scene.add(this.mesh);
    freezeStatic(this.mesh);
    this.buildComputes();
    settings.on('grass.enabled', (v) => (this.mesh.visible = v as boolean), true);
  }

  /** 5 thin blades (2 segments each) of varied height and lean; attribute `blade` = (side, height01, lean). */
  private makeTuft() {
    const pos: number[] = [], blade: number[] = [], idx: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let b = 0; b < 5; b++) {
      const a = rnd() * Math.PI;
      const ox = (rnd() - 0.5) * 0.14, oz = (rnd() - 0.5) * 0.14;
      const hgt = 0.55 + rnd() * 0.65;
      const lean = (rnd() - 0.5) * 0.5;
      const half = 0.009 + rnd() * 0.006;
      const lx = Math.cos(a + 1.57) * lean, lz = Math.sin(a + 1.57) * lean;
      const base = pos.length / 3;
      const rows = [[0, 1], [0.55, 0.65], [1, 0]];
      rows.forEach(([h, w], r) => {
        const cx = ox + lx * h * h, cz = oz + lz * h * h;
        if (r < 2) {
          for (const side of [-1, 1]) {
            pos.push(cx + Math.cos(a) * side * half * w, h * hgt, cz + Math.sin(a) * side * half * w);
            blade.push(side, h, lean);
          }
        } else {
          pos.push(cx, hgt, cz);
          blade.push(0, 1, lean);
        }
      });
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('blade', new THREE.Float32BufferAttribute(blade, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    return g;
  }

  private makeMaterial() {
    const m = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
    const inst = storage(this.inst, 'vec4', CAP * 2).toReadOnly();
    const d0 = inst.element(int(instanceIndex).mul(2));
    const d1 = inst.element(int(instanceIndex).mul(2).add(1));
    const b = attribute('blade', 'vec3');
    const vColor = varying(vec3(0), 'grassColor');
    const vH = varying(float(0), 'grassH');
    const vl = makeVertexLighting('grass');
    m.userData.vertexLighting = true;
    m.positionNode = Fn(() => {
      const scale = d0.w; // height scale (0 = hidden)
      const rot = d1.x;
      const widthMul = d1.z;
      const h = b.y;
      const p = positionLocal.toVar();
      // widen far tufts (fewer survivors), bend forward with height
      p.x.mulAssign(widthMul);
      p.z.mulAssign(widthMul);
      const bend = h.mul(h).mul(0.12).mul(scale);
      const c = cos(rot), s = sin(rot);
      const local = vec3(c.mul(p.x).add(s.mul(p.z)), p.y.mul(this.uHeight).mul(scale), s.negate().mul(p.x).add(c.mul(p.z)).add(bend));
      // wind: gusts travelling across the field
      const w = d0.xz;
      const gust = sin(time.mul(1.7).add(w.x.mul(0.35)).add(w.y.mul(0.27))).mul(0.5).add(0.5);
      const sway = sin(time.mul(3.1).add(d1.y.mul(6.28))).mul(0.25).add(gust.mul(0.75)).mul(h.mul(h)).mul(0.13).mul(windUniforms.strength).mul(scale);
      const offs = vec3(windUniforms.dir.x.mul(sway), sway.mul(-0.3), windUniforms.dir.y.mul(sway));
      vColor.assign(vec3(fractUnpack(d1.w, 0), fractUnpack(d1.w, 1), fractUnpack(d1.w, 2)));
      vH.assign(h);
      const world = local.add(offs).add(d0.xyz).toVar();
      vl.vertex(world);
      return world;
    })();
    // soft lighting: mostly up-facing normals (grass reads like a lit carpet), slight blade normal
    m.normalNode = transformNormalToView(normalize(vec3(0, 1, 0)));
    m.aoNode = vl.skyVis;
    m.colorNode = Fn(() => {
      vl.fragment();
      const root = mix(float(0.45), float(1.0), pow(vH, 0.8));
      return vec4(vColor.mul(root), 1);
    })();
    // back-lit translucency
    (m as any).emissiveNode = Fn(() => {
      const v = normalize(positionWorld.sub(cameraPosition));
      const back = pow(clamp(dot(v, sunUniforms.dir), 0, 1), 4);
      return vColor.mul(sunUniforms.color).mul(back).mul(vH).mul(0.15);
    })();
    return m;
  }

  private buildComputes() {
    const t = this.terrain;
    const tx = t.textures;
    const H = t.heightNode;
    const inst = storage(this.inst, 'vec4', CAP * 2);
    const counter = storage(this.counter, 'uint', 4).toAtomic();
    const args = storage(this.args, 'uint', 5);
    const m = t.data.meta;
    const coreSize = m.core.size, farSize = m.far.size;
    const pcg = Fn(([v]) => {
      const state = v.mul(uint(747796405)).add(uint(2891336453));
      const word = state.shiftRight(state.shiftRight(uint(28)).add(uint(4))).bitXor(state).mul(uint(277803737));
      return word.shiftRight(uint(22)).bitXor(word);
    });
    const rnd = (h) => float(h.bitAnd(uint(0xffffff))).div(16777216);

    this.reset = Fn(() => {
      atomicStore(counter.element(0), uint(0));
    })().compute(1).setName('grassReset');

    this.scatter = Fn(() => {
      const n = int(this.uN);
      const idx = int(instanceIndex);
      If(idx.greaterThanEqual(n.mul(n)), () => Return());
      const ix = int(this.uOrigin.x).add(idx.mod(n));
      const iz = int(this.uOrigin.y).add(idx.div(n));
      const h0 = pcg(uint(ix).bitXor(pcg(uint(iz).add(uint(0x51ed270b))))).toVar();
      const h1 = pcg(h0).toVar();
      const h2 = pcg(h1).toVar();
      const x = float(ix).add(rnd(h0)).mul(SPACING);
      const z = float(iz).add(rnd(h1)).mul(SPACING);
      const dx = x.sub(this.uCam.x), dz = z.sub(this.uCam.z);
      const d = sqrt(dx.mul(dx).add(dz.mul(dz)));
      If(d.greaterThan(this.uDist), () => Return());
      // distance thinning: full density near, ~12% at the far edge; survivors get wider
      const keepD = mix(float(1), float(0.12), smoothstep(6, this.uDist, d));
      If(rnd(h2).greaterThan(keepD.mul(this.uDensity)), () => Return());
      const xz = vec2(x, z);
      // meadow cover (core land cover, far fallback)
      const cuv = xz.div(coreSize).add(0.5);
      const fuv = xz.div(farSize).add(0.5);
      const cw = t.coreWeightNode(xz);
      const A = mix(texture(tx.farLandcover, fuv).depth(int(0)).level(float(0)), texture(tx.landcover, cuv).depth(int(0)).level(float(0)), cw);
      const B = mix(texture(tx.farLandcover, fuv).depth(int(1)).level(float(0)), texture(tx.landcover, cuv).depth(int(1)).level(float(0)), cw);
      const meadow = A.g.mul(float(1).sub(A.r.mul(0.7))).mul(float(1).sub(B.r)).mul(float(1).sub(B.g)).mul(float(1).sub(A.a));
      const h3 = pcg(h2).toVar();
      If(rnd(h3).greaterThan(meadow.mul(1.4)), () => Return());
      const y = H(xz).toVar();
      // slope (finite differences): no grass on steep rock
      const gx = H(xz.add(vec2(1.5, 0))).sub(y), gz = H(xz.add(vec2(0, 1.5))).sub(y);
      If(gx.mul(gx).add(gz.mul(gz)).greaterThan(2.0), () => Return()); // > ~43 deg
      // frustum (sphere radius 0.6 m)
      const inside = float(1).toVar();
      for (let p = 0; p < 6; p++) {
        const pl = this.uPlanes.element(p);
        If(pl.x.mul(x).add(pl.y.mul(y)).add(pl.z.mul(z)).add(pl.w).lessThan(-0.6), () => inside.assign(0));
      }
      If(inside.lessThan(0.5), () => Return());
      // fade height to zero at the far edge (no popping), altitude makes grass shorter
      const fadeOut = float(1).sub(smoothstep(this.uDist.mul(0.75), this.uDist, d));
      const alt = float(1).sub(smoothstep(1600, 2500, y).mul(0.5));
      const scale = fadeOut.mul(alt).mul(rnd(pcg(h3)).mul(0.6).add(0.7));
      const widthMul = float(1).div(sqrt(max(keepD, 0.12))).min(2.8);
      // colour from the orthophoto (matches the ground), slight random variation; packed into one float
      const macro = mix(texture(tx.farAlbedo, fuv).level(float(0)).rgb, texture(tx.macroAlbedo, cuv).level(float(0)).rgb, cw);
      const variation = rnd(pcg(h0.add(uint(7)))).mul(0.35).add(0.8);
      const col = clamp(macro.mul(variation).mul(vec3(0.95, 1.1, 0.85)), 0, 0.999);
      const packed = floorPack(col);
      const slot = atomicAdd(counter.element(0), uint(1));
      If(slot.lessThan(uint(CAP)), () => {
        const i = int(slot).mul(2);
        inst.element(i).assign(vec4(x, y, z, scale));
        inst.element(i.add(1)).assign(vec4(rnd(h1.add(uint(3))).mul(6.2831), rnd(h2.add(uint(5))), widthMul, packed));
      });
    })().compute(1).setName('grassScatter');

    this.finalize = Fn(() => {
      const c = atomicAdd(counter.element(0), uint(0));
      args.element(1).assign(min(c, uint(CAP)));
    })().compute(1).setName('grassFinalize');
  }

  update(_ctx: FrameContext) {
    const s = grassSettings;
    if (!s.enabled) return;
    const cam = this.engine.camera;
    // skip when the camera is far above the ground (aircraft): nothing visible
    const agl = cam.position.y - this.terrain.heightAt(cam.position.x, cam.position.z);
    this.mesh.visible = agl < s.distance * 1.5;
    if (!this.mesh.visible) return;
    this.uCam.value.copy(cam.position);
    const dist = qualityScaled(s.distance, 0.6); // adaptive detail
    this.uDist.value = dist;
    this.uDensity.value = s.density;
    this.uHeight.value = s.height;
    const D = dist;
    this.gridN = Math.ceil((2 * D) / SPACING) + 1;
    this.uOrigin.value.set(Math.floor((cam.position.x - D) / SPACING), Math.floor((cam.position.z - D) / SPACING));
    this.uN.value = this.gridN;
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, THREE.WebGPUCoordinateSystem, (cam as any).reversedDepth === true);
    for (let i = 0; i < 6; i++) {
      const p = this.frustum.planes[i];
      this.uPlanes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    }
    const r = this.engine.renderer;
    r.compute(this.reset);
    (this.scatter as any).count = this.gridN * this.gridN;
    r.compute(this.scatter);
    r.compute(this.finalize);
  }
}

// pack an rgb colour (each in [0,1)) into one float with 8 bits per channel and unpack it in the vertex shader
function floorPack(c) {
  const r = c.x.mul(255).floor(), g = c.y.mul(255).floor(), b = c.z.mul(255).floor();
  return r.mul(65536).add(g.mul(256)).add(b).div(16777216);
}
function fractUnpack(v, ch) {
  const n = v.mul(16777216).add(0.5).floor();
  if (ch === 1) return n.div(256).floor().mod(256).div(255);
  if (ch === 2) return n.mod(256).div(255);
  return n.div(65536).floor().div(255);
}
