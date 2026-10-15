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

export const buildingSettings = settings.group('buildings', 'Bâtiments', {
  enabled: { value: true, label: 'Bâtiments (OpenStreetMap)' },
  distance: { value: 8000, min: 1000, max: 12000, step: 250, label: 'Distance d\'affichage (m)' },
  nightLights: { value: 0.45, min: 0, max: 1, step: 0.05, label: 'Fenêtres allumées la nuit' },
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
    const base = '/data/buildings/';
    let index: { tile: number; stride: number; tiles: TileInfo[] };
    let bin: ArrayBuffer;
    try {
      index = await (await fetch(base + 'index.json')).json();
      bin = await (await fetch(base + 'buildings.bin')).arrayBuffer();
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
    settings.on('buildings.enabled', (v) => (this.group.visible = v as boolean), true);
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
    this.uFadeEnd.value = s.distance;
    this.uLit.value = s.nightLights;
    // windows light up when the sun is a few degrees below the horizon
    const e = this.time.sunDir.y;
    this.uNight.value = Math.min(1, Math.max(0, (0.02 - e) / 0.12));
    const cam = this.engine.camera.position;
    for (const t of this.meshes) {
      const d = Math.hypot(t.center.x - cam.x, t.center.z - cam.z) - t.radius;
      t.mesh.visible = d < s.distance;
    }
  }
}
