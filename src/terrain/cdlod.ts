// CDLOD quadtree selection (Strugar 2010). Produces two instance lists per frame:
//  - full patches   : a node drawn with a 32x32 grid at its own level
//  - quarter patches: a child-sized quadrant drawn with a 16x16 grid at the parent's level
//    (used when a node is subdivided but one of its children is out of the finer range)
// Instance layout: vec4(originX, originZ, spacing, level). Morphing in the vertex shader guarantees
// crack-free, pop-free transitions between levels.
import { Box3, Frustum, Vector3 } from 'three/webgpu';
import { TerrainData, LEAF_SIZE, MAX_LEVEL } from './terrain-data';

export const PATCH_N = 32;
export const MAX_PATCHES = 4096;

const _box = new Box3();

export class CdlodSelector {
  readonly full = new Float32Array(MAX_PATCHES * 4);
  readonly quarter = new Float32Array(MAX_PATCHES * 4);
  fullCount = 0;
  quarterCount = 0;
  private ranges: number[] = [];
  private half: number;
  private cam = new Vector3();
  private frustum!: Frustum;
  /** Vertical margin (m) added to node bounds for procedural displacement. */
  margin = 25; // procedural detail + far canopy shell

  constructor(private data: TerrainData) {
    this.half = data.worldSize / 2;
  }

  select(camPos: Vector3, frustum: Frustum, r0: number) {
    this.cam.copy(camPos);
    this.frustum = frustum;
    for (let l = 0; l <= MAX_LEVEL; l++) this.ranges[l] = r0 * Math.pow(2, l);
    this.fullCount = 0;
    this.quarterCount = 0;
    this.selectNode(MAX_LEVEL, 0, 0);
  }

  private nodeBox(level: number, ix: number, iz: number) {
    const size = LEAF_SIZE * (1 << level);
    this.data.nodeBounds(level, ix, iz);
    _box.min.set(-this.half + ix * size, this.data.boundsMin - this.margin, -this.half + iz * size);
    _box.max.set(_box.min.x + size, this.data.boundsMax + this.margin, _box.min.z + size);
    return _box;
  }

  private distSq(box: Box3) {
    const c = this.cam;
    const dx = Math.max(box.min.x - c.x, 0, c.x - box.max.x);
    const dy = Math.max(box.min.y - c.y, 0, c.y - box.max.y);
    const dz = Math.max(box.min.z - c.z, 0, c.z - box.max.z);
    return dx * dx + dy * dy + dz * dz;
  }

  private selectNode(level: number, ix: number, iz: number): boolean {
    const box = this.nodeBox(level, ix, iz);
    const d2 = this.distSq(box);
    const r = this.ranges[level];
    if (level < MAX_LEVEL && d2 > r * r) return false;
    if (!this.frustum.intersectsBox(box)) return true;
    const size = LEAF_SIZE * (1 << level);
    if (level === 0) {
      this.push(this.full, this.fullCount++, box.min.x, box.min.z, size / PATCH_N, 0);
      return true;
    }
    const rc = this.ranges[level - 1];
    if (d2 > rc * rc) {
      this.push(this.full, this.fullCount++, box.min.x, box.min.z, size / PATCH_N, level);
      return true;
    }
    for (let c = 0; c < 4; c++) {
      const cx = 2 * ix + (c & 1);
      const cz = 2 * iz + (c >> 1);
      if (!this.selectNode(level - 1, cx, cz)) {
        const cb = this.nodeBox(level - 1, cx, cz);
        if (this.frustum.intersectsBox(cb)) {
          this.push(this.quarter, this.quarterCount++, cb.min.x, cb.min.z, size / PATCH_N, level);
        }
      }
    }
    return true;
  }

  private push(arr: Float32Array, i: number, x: number, z: number, spacing: number, level: number) {
    if (i >= MAX_PATCHES) return;
    const o = i * 4;
    arr[o] = x;
    arr[o + 1] = z;
    arr[o + 2] = spacing;
    arr[o + 3] = level;
  }
}
