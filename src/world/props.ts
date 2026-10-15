// World editor: objects placed by the user (mouse, editor mode) or by the agent (commands), saved to
// world/props.json and reloaded at startup. One InstancedMesh per object type (procedural, vertex-coloured geometry,
// standard lighting, near shadows), so hundreds of objects cost a handful of draws. Placed objects block the walker.
import * as THREE from 'three/webgpu';
import type { Engine, System } from '../core/engine';
import { settings } from '../core/settings';
import type { Terrain } from '../terrain/terrain';
import type { Input } from '../core/input';
import { registerCommand, writeProjectFile } from '../agent/bridge';
import { worldColliders } from './colliders';
import { lv95ToWorld, worldToLV95 } from './geo';
import { makeRockGeometry } from '../vegetation/rocks';
import { playerSettings } from '../player/player';
import { BASE_URL } from '../core/data';

export interface Prop {
  id: number;
  type: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

const FILE = 'world/props.json';
const CAP = 1024;

// ---------------------------------------------------------------- procedural geometries (vertex colours, base at y=0)
function coloured(g: THREE.BufferGeometry, rgb: [number, number, number]) {
  const g2 = g.index ? g.toNonIndexed() : g;
  const n = g2.attributes.position.count;
  const c = new Float32Array(n * 3);
  // colours are given in sRGB (as picked by eye); vertex colours are linear
  const lin = rgb.map((v) => Math.pow(v, 2.2));
  for (let i = 0; i < n; i++) c.set(lin, i * 3);
  g2.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g2.deleteAttribute('uv');
  return g2;
}
function merge(parts: THREE.BufferGeometry[]) {
  const total = parts.reduce((s, p) => s + p.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    p.computeVertexNormals();
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nrm.set(p.attributes.normal.array as Float32Array, o * 3);
    col.set(p.attributes.color.array as Float32Array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => g.rotateY(ry).translate(x, y, z);

function chalet() {
  const walls = coloured(new THREE.BoxGeometry(8, 5, 6).translate(0, 2.5, 0), [0.42, 0.27, 0.15]);
  const base = coloured(new THREE.BoxGeometry(8.3, 1, 6.3).translate(0, 0.5, 0), [0.55, 0.53, 0.5]);
  // gabled roof: triangular prism along x, overhanging
  const roof = new THREE.BufferGeometry();
  const L = 5, W = 4.2, y0 = 5, y1 = 7.6;
  const v = [
    [-L, y0, -W], [L, y0, -W], [L, y1, 0], [-L, y0, -W], [L, y1, 0], [-L, y1, 0],
    [-L, y1, 0], [L, y1, 0], [L, y0, W], [-L, y1, 0], [L, y0, W], [-L, y0, W],
    [-L, y0, W], [L, y0, W], [L, y0, -W], [-L, y0, W], [L, y0, -W], [-L, y0, -W],
  ].flat();
  roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const roofC = coloured(roof, [0.32, 0.14, 0.1]);
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([-4, 5, -3, -4, 5, 3, -4, 7.4, 0, 4, 5, 3, 4, 5, -3, 4, 7.4, 0], 3));
  const gableC = coloured(gable, [0.42, 0.27, 0.15]);
  const windows = [-2.5, 2.5].map((x) => coloured(new THREE.BoxGeometry(1.4, 1.3, 6.1).translate(x, 3, 0), [0.06, 0.07, 0.08]));
  return merge([base, walls, roofC, gableC, ...windows]);
}
function fir() {
  const trunk = coloured(new THREE.CylinderGeometry(0.18, 0.28, 3, 7).translate(0, 1.5, 0), [0.36, 0.26, 0.18]);
  const tiers = [[0, 3.2, 1.0], [2.6, 2.6, 0.93], [4.8, 2.0, 0.86], [6.6, 1.3, 0.8]].map(([y, r, k]) =>
    coloured(new THREE.ConeGeometry(r, 3.4, 9).translate(0, y + 1.7 + 1.2, 0), [0.2 * k, 0.34 * k, 0.17 * k]));
  return merge([trunk, ...tiers]);
}
function rock() {
  const g = makeRockGeometry(0).scale(1.6, 1.4, 1.6).translate(0, 0.3, 0);
  return merge([coloured(g, [0.45, 0.43, 0.4])]);
}
function signpost() {
  // Swiss hiking signpost: grey post, yellow arrow signs
  const post = coloured(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6).translate(0, 1.2, 0), [0.5, 0.5, 0.5]);
  const s1 = coloured(new THREE.BoxGeometry(0.9, 0.18, 0.03).translate(0.45, 2.15, 0), [0.95, 0.75, 0.05]);
  const s2 = coloured(at(new THREE.BoxGeometry(0.9, 0.18, 0.03), -0.45, 1.9, 0, 0.6), [0.95, 0.75, 0.05]);
  return merge([post, s1, s2]);
}
function bench() {
  const seat = coloured(new THREE.BoxGeometry(1.8, 0.06, 0.45).translate(0, 0.45, 0), [0.45, 0.3, 0.16]);
  const back = coloured(new THREE.BoxGeometry(1.8, 0.4, 0.05).translate(0, 0.75, -0.2), [0.45, 0.3, 0.16]);
  const legs = [-0.75, 0.75].map((x) => coloured(new THREE.BoxGeometry(0.08, 0.45, 0.4).translate(x, 0.22, 0), [0.2, 0.2, 0.2]));
  return merge([seat, back, ...legs]);
}

/** Object types: label (UI), geometry builder, collision radius (m, at scale 1; 0 = none). */
export const PROP_TYPES: Record<string, { label: string; build: () => THREE.BufferGeometry; radius: number }> = {
  chalet: { label: 'Chalet', build: chalet, radius: 4.6 },
  fir: { label: 'Fir tree', build: fir, radius: 0.5 },
  rock: { label: 'Rock', build: rock, radius: 1.6 },
  signpost: { label: 'Trail signpost', build: signpost, radius: 0.15 },
  bench: { label: 'Bench', build: bench, radius: 0 },
};

export const editorSettings = settings.group('editor', 'World editor', {
  mode: { value: 'off', options: { Off: 'off', 'Place (left click)': 'place', 'Remove (left click)': 'remove' }, label: 'Mode (free camera)' },
  type: { value: 'chalet', options: Object.fromEntries(Object.entries(PROP_TYPES).map(([k, t]) => [t.label, k])), label: 'Object' },
  randomYaw: { value: true, label: 'Random orientation' },
  scale: { value: 1, min: 0.3, max: 3, step: 0.05, label: 'Scale' },
  count: { value: 0, readonly: true, label: 'Placed objects' },
});

export class Props implements System {
  readonly name = 'props';
  private engine!: Engine;
  private list: Prop[] = [];
  private nextId = 1;
  private meshes = new Map<string, THREE.InstancedMesh>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3();
  private _p = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);

  constructor(private terrain: Terrain, private input: Input) {}

  async init(engine: Engine) {
    this.engine = engine;
    // double-sided: the hand-built roofs and gables need no winding care
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    for (const [type, def] of Object.entries(PROP_TYPES)) {
      const mesh = new THREE.InstancedMesh(def.build(), material, CAP);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // instances are spread over the whole world
      mesh.name = `props:${type}`;
      engine.scene.add(mesh);
      this.meshes.set(type, mesh);
    }
    try {
      const res = await fetch(`${BASE_URL}${FILE}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        for (const p of data.props ?? []) this.add(p.type, p.x, p.z, p.yaw, p.scale, false);
      }
    } catch {
      /* no saved world yet */
    }
    this.rebuild();
    worldColliders.push((p, r) => this.collide(p, r));
    engine.renderer.domElement.addEventListener('mousedown', (e) => this.onClick(e));
    this.registerCommands();
  }

  // ---------------------------------------------------------------- data
  add(type: string, x: number, z: number, yaw = 0, scale = 1, save = true): Prop {
    if (!PROP_TYPES[type]) throw new Error(`unknown type "${type}" (${Object.keys(PROP_TYPES).join(', ')})`);
    if (this.list.filter((p) => p.type === type).length >= CAP) throw new Error(`too many "${type}" (max ${CAP})`);
    const p: Prop = { id: this.nextId++, type, x, z, yaw, scale };
    this.list.push(p);
    if (save) this.changed();
    return p;
  }
  remove(id: number) {
    const i = this.list.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.list.splice(i, 1);
    this.changed();
    return true;
  }
  nearest(x: number, z: number, maxDist: number) {
    let best: Prop | null = null, bd = maxDist;
    for (const p of this.list) {
      const d = Math.hypot(p.x - x, p.z - z) - PROP_TYPES[p.type].radius * p.scale;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  private changed() {
    this.rebuild();
    if (!import.meta.env.DEV) return; // static demo: no file writes, edits last for the session
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 600);
  }
  async save() {
    const data = { version: 1, props: this.list.map(({ type, x, z, yaw, scale }) => ({ type, x: +x.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(3), scale })) };
    await writeProjectFile(FILE, JSON.stringify(data, null, 1));
  }
  private rebuild() {
    for (const [type, mesh] of this.meshes) {
      let n = 0;
      for (const p of this.list) {
        if (p.type !== type) continue;
        this._p.set(p.x, this.terrain.heightAt(p.x, p.z) - 0.05, p.z);
        this._q.setFromAxisAngle(this._up, p.yaw);
        this._s.setScalar(p.scale);
        mesh.setMatrixAt(n++, this._m.compose(this._p, this._q, this._s));
      }
      mesh.count = n;
      // an empty type is hidden: three would otherwise prepare it every frame in the main and shadow passes
      mesh.visible = n > 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    editorSettings.count = this.list.length;
  }

  // ---------------------------------------------------------------- walker collisions
  private collide(p: { x: number; z: number }, r: number) {
    for (const o of this.list) {
      const rad = PROP_TYPES[o.type].radius * o.scale;
      if (rad <= 0) continue;
      const dx = p.x - o.x, dz = p.z - o.z, d = Math.sqrt(dx * dx + dz * dz), m = rad + r;
      if (d < m && d > 1e-4) {
        p.x = o.x + (dx / d) * m;
        p.z = o.z + (dz / d) * m;
      }
    }
  }

  // ---------------------------------------------------------------- mouse editing (free camera only)
  private pickTerrain(clientX: number, clientY: number) {
    const el = this.engine.renderer.domElement;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.engine.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    // march the heightfield (geometric steps), then bisect the crossing
    let t0 = 0, t = 1;
    for (let i = 0; i < 400 && t < 30000; i++) {
      const y = o.y + d.y * t;
      if (y < this.terrain.heightAt(o.x + d.x * t, o.z + d.z * t)) {
        for (let k = 0; k < 24; k++) {
          const m = (t0 + t) / 2;
          if (o.y + d.y * m < this.terrain.heightAt(o.x + d.x * m, o.z + d.z * m)) t = m;
          else t0 = m;
        }
        return { x: o.x + d.x * t, z: o.z + d.z * t };
      }
      t0 = t;
      t = t * 1.02 + 0.5;
    }
    return null;
  }
  private onClick(e: MouseEvent) {
    const mode = editorSettings.mode;
    if (mode === 'off' || e.button !== 0 || playerSettings.mode !== 'free') return;
    const hit = this.pickTerrain(e.clientX, e.clientY);
    if (!hit) return;
    if (mode === 'place') {
      const yaw = editorSettings.randomYaw ? Math.random() * Math.PI * 2 : 0;
      this.add(editorSettings.type, hit.x, hit.z, yaw, editorSettings.scale);
    } else if (mode === 'remove') {
      const p = this.nearest(hit.x, hit.z, 6);
      if (p) this.remove(p.id);
    }
    void this.input;
  }

  // ---------------------------------------------------------------- agent commands
  private registerCommands() {
    registerCommand('props', 'List placed objects (world editor)', () => ({
      types: Object.keys(PROP_TYPES),
      props: this.list.map((p) => ({ ...p, lv95: (({ e, n }) => [Math.round(e), Math.round(n)])(worldToLV95(p.x, p.z)) })),
    }));
    registerCommand('prop-add', 'Place an object: {type, e,n (LV95) | x,z (world) | at:"camera", yaw?, scale?}', (a) => {
      let x: number, z: number;
      if (a.e !== undefined && a.n !== undefined) ({ x, z } = lv95ToWorld(a.e, a.n));
      else if (a.x !== undefined && a.z !== undefined) ({ x, z } = a);
      else {
        const c = this.engine.camera.position;
        const f = new THREE.Vector3();
        this.engine.camera.getWorldDirection(f);
        x = c.x + f.x * 15;
        z = c.z + f.z * 15;
      }
      return this.add(a.type ?? a._?.[0] ?? 'chalet', x, z, a.yaw ?? Math.random() * Math.PI * 2, a.scale ?? 1);
    });
    registerCommand('prop-remove', 'Remove a placed object: {id}', ({ id, _ }) => ({ removed: this.remove(Number(id ?? _?.[0])) }));
    registerCommand('props-save', 'Save placed objects now (world/props.json)', async () => {
      await this.save();
      return { saved: this.list.length, file: FILE };
    });
  }
}
