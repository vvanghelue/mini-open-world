// @ts-nocheck -- TSL typings incomplete for these patterns
// Buildings (OpenStreetMap footprints, see tools/data/build-buildings.mjs): one merged mesh per 2 km "supertile"
// (2x2 data tiles) to keep draw calls low. Procedural facades: windows by floor (glass, frames, shutters on plaster
// houses), lit windows at night. Far away (6.5-8 km) buildings sink into the terrain instead of popping, so no
// discard is needed (keeps early-Z / hidden-surface removal effective).
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, uniform, mix, clamp, fract, floor, fwidth, smoothstep, step, pow, dot, sin,
  positionLocal, positionWorld, cameraPosition, length, max, min, abs, select,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import type { Terrain } from '../terrain/terrain';
import type { TimeOfDay } from '../sky/time-of-day';
import { settings } from '../core/settings';
import { skyVisAt, terrainHooks } from '../terrain/terrain-material';
import { worldColliders } from './colliders';
import { freezeStatic } from '../core/static';
import { qualityScaled } from '../core/adaptive';
import { fetchData, fetchJson } from '../core/data';

export const buildingSettings = settings.group('buildings', 'Buildings', {
  enabled: { value: true, label: 'Buildings (OpenStreetMap)' },
  distance: { value: 8000, min: 1000, max: 12000, step: 250, label: 'Draw distance (m)' },
  nightLights: { value: 0.45, min: 0, max: 1, step: 0.05, label: 'Lit windows at night' },
});

interface TileInfo { tx: number; tz: number; vOffset: number; vCount: number; iOffset: number; iCount: number; center: number[]; radius: number }

export class Buildings implements System {
  readonly name = 'buildings';
  private engine!: Engine;
  private group = new THREE.Group();
  private meshes: { mesh: THREE.Mesh; center: THREE.Vector3; radius: number }[] = [];
  private readonly uFadeEnd = uniform(8000);
  private readonly uNight = uniform(0);
  private readonly uLit = uniform(0.45);
  stats = { buildings: 0, triangles: 0 };

  constructor(private terrain: Terrain, private time: TimeOfDay) {}

  async init(engine: Engine) {
    this.engine = engine;
    let index: { tile: number; stride: number; tiles: TileInfo[] };
    let bin: ArrayBuffer;
    try {
      index = await fetchJson('buildings/index.json');
      bin = await fetchData('buildings/buildings.bin');
    } catch {
      console.warn('buildings: no data (run node tools/data/build-buildings.mjs)');
      return;
    }
    const S = index.stride;
    const material = this.makeMaterial();
    // group data tiles into 2x2 supertiles
    const groups = new Map<number, TileInfo[]>();
    for (const t of index.tiles) {
      const k = (t.tz >> 1) * 1000 + (t.tx >> 1);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    const dv = new DataView(bin);
    for (const tiles of groups.values()) {
      const nv = tiles.reduce((s, t) => s + t.vCount, 0);
      const ni = tiles.reduce((s, t) => s + t.iCount, 0);
      const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 4), col = new Uint8Array(nv * 4), wuv = new Float32Array(nv * 2);
      const idx = new Uint32Array(ni);
      let v0 = 0, i0 = 0;
      const box = new THREE.Box3();
      for (const t of tiles) {
        for (let i = 0; i < t.vCount; i++) {
          const o = t.vOffset + i * S, v = v0 + i;
          pos[v * 3] = dv.getFloat32(o, true); pos[v * 3 + 1] = dv.getFloat32(o + 4, true); pos[v * 3 + 2] = dv.getFloat32(o + 8, true);
          for (let k = 0; k < 4; k++) { nrm[v * 4 + k] = dv.getInt8(o + 12 + k); col[v * 4 + k] = dv.getUint8(o + 16 + k); }
          wuv[v * 2] = dv.getInt16(o + 20, true) / 8; wuv[v * 2 + 1] = dv.getInt16(o + 22, true) / 8;
        }
        const src = new Uint32Array(bin, t.iOffset, t.iCount);
        for (let i = 0; i < t.iCount; i++) idx[i0 + i] = src[i] + v0;
        v0 += t.vCount; i0 += t.iCount;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 4, true));
      g.setAttribute('bcolor', new THREE.BufferAttribute(col, 4, true));
      g.setAttribute('wuv', new THREE.BufferAttribute(wuv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      box.setFromBufferAttribute(g.attributes.position as THREE.BufferAttribute);
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'buildings';
      this.group.add(mesh);
      this.meshes.push({ mesh, center: g.boundingSphere!.center.clone(), radius: g.boundingSphere!.radius });
      this.stats.triangles += ni / 3;
    }
    this.group.name = 'buildings';
    engine.scene.add(this.group);
    freezeStatic(this.group);
    await this.loadFootprints('buildings/footprints.bin');
    settings.on('buildings.enabled', (v) => (this.group.visible = v as boolean), true);
  }

  // ---------------------------------------------------------------- collisions (walker)
  private polys: Float32Array[] = []; // x0, z0, x1, z1, ... per building
  private grid = new Map<number, number[]>();
  private static CELL = 32;

  private async loadFootprints(path: string) {
    let buf: ArrayBuffer;
    try {
      buf = await fetchData(path);
    } catch {
      return;
    }
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    let o = 4;
    const C = Buildings.CELL;
    for (let b = 0; b < n; b++) {
      const k = dv.getUint8(o);
      const poly = new Float32Array(k * 2);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < k; i++) {
        poly[i * 2] = dv.getFloat32(o + 4 + i * 8, true);
        poly[i * 2 + 1] = dv.getFloat32(o + 8 + i * 8, true);
        x0 = Math.min(x0, poly[i * 2]); x1 = Math.max(x1, poly[i * 2]);
        z0 = Math.min(z0, poly[i * 2 + 1]); z1 = Math.max(z1, poly[i * 2 + 1]);
      }
      o += 4 + k * 8;
      const id = this.polys.push(poly) - 1;
      for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
        for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) {
          const key = cz * 100000 + cx;
          let l = this.grid.get(key);
          if (!l) this.grid.set(key, (l = []));
          l.push(id);
        }
      }
    }
    this.stats.buildings = n;
    worldColliders.push((p, r) => this.pushOut(p, r));
  }

  /** Pushes a circle out of the building footprints near it. */
  pushOut(p: { x: number; z: number }, r: number) {
    if (!buildingSettings.enabled) return;
    const C = Buildings.CELL;
    const seen = new Set<number>();
    for (let cz = Math.floor((p.z - r) / C); cz <= Math.floor((p.z + r) / C); cz++) {
      for (let cx = Math.floor((p.x - r) / C); cx <= Math.floor((p.x + r) / C); cx++) {
        const l = this.grid.get(cz * 100000 + cx);
        if (!l) continue;
        for (const id of l) {
          if (seen.has(id)) continue;
          seen.add(id);
          this.pushOutOf(this.polys[id], p, r);
        }
      }
    }
  }

  private pushOutOf(poly: Float32Array, p: { x: number; z: number }, r: number) {
    // closest point on the outline + inside test (crossing number)
    const n = poly.length / 2;
    let best = Infinity, bx = 0, bz = 0, inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = poly[j * 2], az = poly[j * 2 + 1], cx = poly[i * 2], cz = poly[i * 2 + 1];
      if ((cz > p.z) !== (az > p.z) && p.x < ((ax - cx) * (p.z - cz)) / (az - cz) + cx) inside = !inside;
      const ex = cx - ax, ez = cz - az;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / (ex * ex + ez * ez || 1)));
      const qx = ax + ex * t, qz = az + ez * t;
      const d = (p.x - qx) ** 2 + (p.z - qz) ** 2;
      if (d < best) { best = d; bx = qx; bz = qz; }
    }
    const d = Math.sqrt(best);
    if (!inside && d >= r) return;
    // direction from the outline to the point (flipped when inside)
    let dx = p.x - bx, dz = p.z - bz;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    if (inside) { dx = -dx; dz = -dz; }
    p.x = bx + dx * r;
    p.z = bz + dz * r;
  }

  private makeMaterial() {
    const m = new THREE.MeshStandardNodeMaterial();
    const bcol = attribute('bcolor', 'vec4');
    const wuv = attribute('wuv', 'vec2');
    const H = this.terrain.heightNode;
    // far buildings sink into the ground (no pop, no discard)
    m.positionNode = Fn(() => {
      const p = positionLocal;
      const d = length(p.xz.sub(cameraPosition.xz));
      const sink = smoothstep(this.uFadeEnd.mul(0.8), this.uFadeEnd, d);
      return vec3(p.x, mix(p.y, H(p.xz).sub(3), sink), p.z);
    })();
    const style = bcol.w.mul(255).add(0.5).floor();
    const albedo = pow(bcol.rgb, vec3(2.2));
    // windows: floors every 2.9 m, 1.15 m wide every 2.8 m, sills at 0.95 m (walls with style 1 = plaster, 2 = chalet)
    const box = (x: any, lo: any, hi: any) => {
      const w = fwidth(x).max(1e-3);
      return clamp(x.sub(lo).div(w).add(0.5), 0, 1).mul(clamp(float(hi).sub(x).div(w).add(0.5), 0, 1));
    };
    const u = wuv.x, v = wuv.y;
    const fu = fract(u.sub(0.6).div(2.8)).mul(2.8), fv = fract(v.div(2.9)).mul(2.9);
    const hasWin = step(0.5, style).mul(step(style, 2.5));
    const inWall = step(0.4, v);
    const winMask = box(fu, 0.2, 1.35).mul(box(fv, 0.95, 2.25)).mul(hasWin).mul(inWall).toVar();
    const frame = box(fu, 0.1, 1.45).mul(box(fv, 0.85, 2.35)).mul(hasWin).mul(inWall).sub(winMask).max(0);
    const shutter = box(fu, -0.45, 0.1).add(box(fu, 1.45, 2.0)).mul(box(fv, 0.95, 2.25)).mul(step(0.5, style)).mul(step(style, 1.5)).mul(inWall);
    // per-window random (lit at night, shutter colour)
    const cell = floor(u.sub(0.6).div(2.8)).add(floor(v.div(2.9)).mul(57)).add(floor(positionWorld.x.mul(0.37)).mul(13.1)).add(floor(positionWorld.z.mul(0.41)).mul(7.7));
    const rnd = fract(sin(cell.mul(12.9898)).mul(43758.5453));
    const shutterCol = mix(vec3(0.05, 0.11, 0.05), vec3(0.16, 0.05, 0.03), step(0.6, fract(rnd.mul(7.3))));
    const frameCol = select(style.lessThan(1.5), vec3(0.75, 0.74, 0.7), vec3(0.6, 0.58, 0.55));
    let col = mix(albedo, shutterCol, shutter.clamp(0, 1));
    col = mix(col, frameCol, frame);
    col = mix(col, vec3(0.02, 0.025, 0.03), winMask);
    m.colorNode = col;
    m.roughnessNode = mix(mix(float(0.85), float(0.7), step(style, 0.5)), float(0.08), winMask);
    m.metalnessNode = float(0);
    m.aoNode = skyVisAt(positionWorld.xz);
    m.emissiveNode = Fn(() => {
      // warm lit windows at night (a fraction of them), plus light bounced by the surrounding relief
      const lit = step(rnd, this.uLit).mul(winMask).mul(this.uNight);
      const glow = vec3(1.0, 0.62, 0.32).mul(lit).mul(mix(float(0.6), float(1.4), fract(rnd.mul(3.7))));
      const bounce = terrainHooks.bounce ? col.mul(terrainHooks.bounce(positionWorld.xz)).mul(1 / Math.PI) : vec3(0);
      return glow.mul(6).add(bounce);
    })();
    void dot; void max; void min; void abs; void vec2; void vec4;
    return m;
  }

  update(_ctx: FrameContext) {
    const s = buildingSettings;
    if (!s.enabled || !this.meshes.length) return;
    const dist = qualityScaled(s.distance, 0.5); // adaptive detail
    this.uFadeEnd.value = dist;
    this.uLit.value = s.nightLights;
    // windows light up when the sun is a few degrees below the horizon
    const e = this.time.sunDir.y;
    this.uNight.value = Math.min(1, Math.max(0, (0.02 - e) / 0.12));
    const cam = this.engine.camera.position;
    for (const t of this.meshes) {
      const d = Math.hypot(t.center.x - cam.x, t.center.z - cam.z) - t.radius;
      t.mesh.visible = d < dist;
    }
  }
}
