// @ts-nocheck -- TSL typings incomplete for these patterns
// Roads, tracks and hiking trails (OpenStreetMap, see tools/data/build-roads.mjs): ribbons draped on the terrain,
// drawn as a blended decal (no depth write, depth-biased towards the camera) up to ~2.5 km; further away the
// orthophoto shows them. Surfaces: asphalt (edge lines + dashed centre on main roads), paved, gravel tracks (wheel ruts
// and a grass strip), dirt trails (soft ragged edges). 2 km merged supertiles.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, uniform, mix, clamp, fract, fwidth, smoothstep, step, abs, texture,
  positionWorld, cameraPosition, length, max, min, transformNormalToView, normalize,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import type { Terrain } from '../terrain/terrain';
import { settings } from '../core/settings';
import { skyVisAt } from '../terrain/terrain-material';
import { freezeStatic } from '../core/static';
import { qualityScaled } from '../core/adaptive';
import { fetchData, fetchJson } from '../core/data';

export const roadSettings = settings.group('roads', 'Roads and trails', {
  enabled: { value: true, label: 'Roads and trails (OSM)' },
  distance: { value: 2500, min: 500, max: 6000, step: 100, label: 'Distance (m)' },
  trails: { value: true, label: 'Hiking trails' },
});

interface TileInfo { tx: number; tz: number; cx: number; cz: number; vOffset: number; vCount: number; iOffset: number; iCount: number; minY: number; maxY: number }

export class Roads implements System {
  readonly name = 'roads';
  private engine!: Engine;
  private group = new THREE.Group();
  private meshes: { mesh: THREE.Mesh; center: THREE.Vector3; radius: number }[] = [];
  private uDist = uniform(2500);
  private uTrails = uniform(1);

  constructor(private terrain: Terrain) {}

  async init(engine: Engine) {
    this.engine = engine;
    let index: { stride: number; tiles: TileInfo[] };
    let bin: ArrayBuffer;
    try {
      index = await fetchJson('roads/index.json');
      bin = await fetchData('roads/roads.bin');
    } catch {
      console.warn('roads: no data (run node tools/data/build-roads.mjs)');
      return;
    }
    const S = index.stride;
    const dv = new DataView(bin);
    const material = this.makeMaterial();
    const groups = new Map<number, TileInfo[]>();
    for (const t of index.tiles) {
      const k = (t.tz >> 1) * 1000 + (t.tx >> 1);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    for (const tiles of groups.values()) {
      const nv = tiles.reduce((s, t) => s + t.vCount, 0), ni = tiles.reduce((s, t) => s + t.iCount, 0);
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), ruv = new Float32Array(nv * 2), misc = new Float32Array(nv * 3);
      const idx = new Uint32Array(ni);
      let v0 = 0, i0 = 0;
      for (const t of tiles) {
        for (let i = 0; i < t.vCount; i++) {
          const o = t.vOffset + i * S, v = v0 + i;
          pos[v * 3] = t.cx + dv.getInt16(o, true) / 32;
          pos[v * 3 + 1] = dv.getUint16(o + 4, true) / 16;
          pos[v * 3 + 2] = t.cz + dv.getInt16(o + 2, true) / 32;
          const nx = dv.getInt8(o + 6) / 127, nz = dv.getInt8(o + 7) / 127;
          nrm[v * 3] = nx; nrm[v * 3 + 1] = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)); nrm[v * 3 + 2] = nz;
          ruv[v * 2] = dv.getUint16(o + 8, true) / 8;
          ruv[v * 2 + 1] = dv.getInt8(o + 10) / 127;
          misc[v * 3] = dv.getUint8(o + 11); // surface
          misc[v * 3 + 1] = dv.getUint8(o + 12) / 10; // width (m)
          misc[v * 3 + 2] = dv.getUint8(o + 13); // flags
        }
        const src = new Uint32Array(bin, t.iOffset, t.iCount);
        for (let i = 0; i < t.iCount; i++) idx[i0 + i] = src[i] + v0;
        v0 += t.vCount; i0 += t.iCount;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('ruv', new THREE.BufferAttribute(ruv, 2));
      g.setAttribute('rmisc', new THREE.BufferAttribute(misc, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      mesh.renderOrder = 5;
      mesh.name = 'roads';
      this.group.add(mesh);
      this.meshes.push({ mesh, center: g.boundingSphere!.center.clone(), radius: g.boundingSphere!.radius });
    }
    this.group.name = 'roads';
    engine.scene.add(this.group);
    freezeStatic(this.group);
    settings.on('roads.enabled', (v) => (this.group.visible = v as boolean), true);
  }

  private makeMaterial() {
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
    m.polygonOffset = true;
    m.polygonOffsetFactor = 2; // reversed depth: positive bias = towards the camera
    m.polygonOffsetUnits = 4;
    const ruv = attribute('ruv', 'vec2');
    const misc = attribute('rmisc', 'vec3');
    const noise = this.terrain.textures.noise;
    const surface = misc.x.add(0.5).floor();
    const width = misc.y;
    const marked = misc.z;
    const u = ruv.x, v = ruv.y; // metres along, -1..1 across
    const across = v.mul(width).mul(0.5); // metres from the centre line
    const n1 = texture(noise, positionWorld.xz.div(9.7)).r;
    const n2 = texture(noise, positionWorld.xz.div(1.9)).g;
    const box = (x: any, lo: any, hi: any) => {
      const w = fwidth(x).max(1e-3);
      return clamp(x.sub(lo).div(w).add(0.5), 0, 1).mul(clamp(float(hi).sub(x).div(w).add(0.5), 0, 1));
    };
    const isS = (k: number) => step(k - 0.5, surface).mul(step(surface, k + 0.5));
    const asphalt = isS(0), paved = isS(1), gravel = isS(2), dirt = isS(3);
    // markings on main asphalt roads: edge lines and a dashed centre line (3 m dash, 6 m gap)
    const hw = width.mul(0.5);
    const edgeLine = box(abs(across), hw.sub(0.45), hw.sub(0.3));
    const centre = box(across, -0.07, 0.07).mul(box(fract(u.div(9)).mul(9), 0, 3)).mul(step(5.4, width));
    const paint = edgeLine.add(centre).mul(marked).mul(asphalt).clamp(0, 1);
    // gravel tracks: two wheel ruts, grass strip in the middle
    const rut = box(abs(across), 0.45, 0.85).mul(gravel);
    const grassStrip = box(abs(across), 0, 0.3).mul(gravel).mul(step(0.45, n2));
    const colAsphalt = vec3(0.055, 0.055, 0.053).mul(mix(float(0.75), float(1.2), n1));
    const colPaved = vec3(0.2, 0.19, 0.17).mul(mix(float(0.8), float(1.15), n2));
    const colGravel = mix(vec3(0.3, 0.27, 0.22).mul(mix(float(0.85), float(1.1), n2)), vec3(0.19, 0.17, 0.14), rut);
    const colDirt = vec3(0.19, 0.145, 0.1).mul(mix(float(0.8), float(1.15), n2));
    let col = colAsphalt.mul(asphalt).add(colPaved.mul(paved)).add(colGravel.mul(gravel)).add(colDirt.mul(dirt));
    col = mix(col, vec3(0.06, 0.09, 0.03), grassStrip);
    col = mix(col, vec3(0.62, 0.62, 0.6), paint);
    m.colorNode = col;
    m.roughnessNode = mix(float(0.92), float(0.6), paint);
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(normalize(attribute('normal', 'vec3')));
    m.aoNode = skyVisAt(positionWorld.xz);
    m.opacityNode = Fn(() => {
      // soft edges: sharp for asphalt, ragged for trails; fade out with distance
      const av = abs(v);
      const soft = mix(mix(float(0.9), float(0.82), paved), float(0.55), gravel.add(dirt).clamp(0, 1)).sub(dirt.mul(0.2));
      // (smoothstep with reversed edges is undefined in WGSL: use 1 - smoothstep(soft, 1, x))
      const edge = float(1).sub(smoothstep(soft, 1.0, av.add(dirt.mul(n2.sub(0.5).mul(0.5)))));
      const d = length(positionWorld.sub(cameraPosition));
      const fade = float(1).sub(smoothstep(this.uDist.mul(0.7), this.uDist, d));
      const trails = mix(this.uTrails, float(1), step(surface, 2.5)); // dirt trails can be hidden
      const a = mix(float(0.92), float(0.8), dirt);
      return edge.mul(fade).mul(trails).mul(a);
    })();
    void vec2; void vec4; void max; void min;
    return m;
  }

  update(_ctx: FrameContext) {
    const s = roadSettings;
    if (!s.enabled || !this.meshes.length) return;
    const dist = qualityScaled(s.distance, 0.6); // adaptive detail
    this.uDist.value = dist;
    this.uTrails.value = s.trails ? 1 : 0;
    const cam = this.engine.camera.position;
    for (const t of this.meshes) {
      const d = Math.hypot(t.center.x - cam.x, t.center.z - cam.z) - t.radius;
      t.mesh.visible = d < dist;
    }
  }
}
