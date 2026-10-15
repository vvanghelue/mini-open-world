// @ts-nocheck -- TSL typings incomplete for these patterns
// Interlaken airfield (LSMI) runway: a dedicated asphalt strip laid on the terrain with procedural ICAO-style
// markings (threshold "piano keys", aiming points, dashed centreline, edge lines). The land-cover map (6 m, warped)
// cannot draw crisp edges; the strip can. Raised a few cm and depth-biased towards the camera (reversed depth:
// positive bias = closer).
import * as THREE from 'three/webgpu';
import { Fn, uv, float, vec3, abs, fwidth, clamp, mix, smoothstep, texture, positionWorld, step, fract, min, max } from 'three/tsl';
import type { Engine, System } from '../core/engine';
import type { Terrain } from '../terrain/terrain';
import { lv95ToWorld } from './geo';
import { skyVisAt } from '../terrain/terrain-material';
import { freezeStatic } from '../core/static';

// SW threshold -> NE threshold (LV95, measured on SWISSIMAGE), width in metres
const RUNWAY = { e0: 2633155, n0: 1169038, e1: 2634385, n1: 1170283, width: 30 };

export class Airfield implements System {
  readonly name = 'airfield';
  constructor(private terrain: Terrain) {}

  init(engine: Engine) {
    const a = lv95ToWorld(RUNWAY.e0, RUNWAY.n0), b = lv95ToWorld(RUNWAY.e1, RUNWAY.n1);
    const dir = new THREE.Vector2(b.x - a.x, b.z - a.z);
    const len = dir.length();
    dir.normalize();
    const side = new THREE.Vector2(-dir.y, dir.x);
    const W = RUNWAY.width;
    // strip: vertices every 10 m along, 5 across, draped on the terrain
    const nu = Math.ceil(len / 10), nv = 4;
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        const u = (i / nu) * len, v = (j / nv - 0.5) * W;
        const x = a.x + dir.x * u + side.x * v, z = a.z + dir.y * u + side.y * v;
        pos.push(x, this.terrain.heightAt(x, z) + 0.04, z);
        uvs.push(u, v); // metres along / across
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const k = i * (nv + 1) + j;
        idx.push(k, k + 1, k + nv + 1, k + 1, k + nv + 2, k + nv + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);

    const m = new THREE.MeshStandardNodeMaterial();
    m.polygonOffset = true;
    m.polygonOffsetFactor = 2;
    m.polygonOffsetUnits = 2;
    const noise = this.terrain.textures.noise;
    const paint = Fn(() => {
      const u = uv().x, v = uv().y;
      // antialiased box: 1 inside [lo, hi] (metres)
      const box = (x: any, lo: number | any, hi: number | any) => {
        const w = fwidth(x).max(1e-4);
        return clamp(x.sub(lo).div(w).add(0.5), 0, 1).mul(clamp(float(hi).sub(x).div(w).add(0.5), 0, 1));
      };
      const av = abs(v);
      const dEnd = min(u, float(len).sub(u)); // distance from the nearest threshold
      // edge lines
      const edge = box(av, W / 2 - 1.4, W / 2 - 0.5);
      // threshold piano keys: 4 stripes each side, 1.8 m wide, 1.8 m apart, 30 m long, 6 m from the end
      const keyIdx = av.sub(1.8).div(3.6);
      const keys = box(dEnd, 6, 36).mul(box(fract(keyIdx).mul(3.6), 0, 1.8)).mul(step(0, keyIdx)).mul(step(keyIdx, 4));
      // aiming points: two 45 m x 6 m blocks, 300 m from each threshold
      const aim = box(dEnd, 300, 345).mul(box(av, 4.5, 10.5));
      // centreline: 30 m dashes, 20 m gaps, 0.9 m wide, outside the threshold zones
      const dash = box(fract(u.div(50)).mul(50), 0, 30).mul(box(av, 0, 0.45)).mul(step(60, dEnd));
      return clamp(edge.add(keys).add(aim).add(dash), 0, 1);
    })();
    const variation = texture(noise, positionWorld.xz.div(41)).r.mul(0.5).add(texture(noise, positionWorld.xz.div(7.3)).g.mul(0.5));
    // tyre marks darken the touchdown zones along the centre
    // (no reversed-edge smoothstep: undefined in WGSL/Metal)
    const tyre = float(1).sub(smoothstep(40, 120, abs(min(uv().x, float(len).sub(uv().x)).sub(450)))).mul(float(1).sub(smoothstep(1, 6, abs(uv().y)))).mul(0.35);
    const asphalt = vec3(0.075, 0.074, 0.07).mul(mix(float(0.8), float(1.2), variation)).mul(float(1).sub(tyre));
    m.colorNode = mix(asphalt, vec3(0.62, 0.62, 0.6), paint.mul(0.92));
    m.roughnessNode = mix(float(0.88), float(0.62), paint);
    m.metalnessNode = float(0);
    m.aoNode = skyVisAt(positionWorld.xz);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'runway';
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.renderOrder = 1;
    g.computeBoundingSphere();
    engine.scene.add(mesh);
    freezeStatic(mesh);
    void max;
  }
}
