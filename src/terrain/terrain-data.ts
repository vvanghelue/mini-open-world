// CPU-side terrain data: heightmaps (for collision / queries), normal maps (computed here from the heights, uploaded to
// the GPU) and a min/max height pyramid for the CDLOD quadtree. Height sampling here mirrors the GPU code exactly.
import { downloadSize, fetchData, fetchJson } from '../core/data';

export interface GridInfo {
  res: number;
  size: number;
  spacing: number;
  hMin: number;
  hMax: number;
}

export interface TerrainMeta {
  core: GridInfo & { lv95: { e0: number; n0: number } };
  far: GridInfo;
  center: { e: number; n: number };
  attribution: string;
}

/** Width (m) of the band inside the core edge where core heights blend into far heights. */
export const CORE_BLEND = 400;

export const LEAF_SIZE = 40; // m, finest quadtree node
export const MAX_LEVEL = 11; // root = 40 * 2^11 = 81920 m

function decodeHeights(buf: ArrayBuffer, info: GridInfo): Float32Array {
  const q = new Uint16Array(buf);
  const out = new Float32Array(q.length);
  const k = (info.hMax - info.hMin) / 65535;
  for (let i = 0; i < q.length; i++) out[i] = info.hMin + q[i] * k;
  return out;
}

/** RG8 normal map from central differences: R = n.x, G = n.z mapped from [-1, 1]; n.y is reconstructed (up-facing). */
function normalMapRG8(h: Float32Array, n: number, spacing: number): Uint8Array {
  const out = new Uint8Array(n * n * 2);
  for (let y = 0; y < n; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(n - 1, y + 1);
    const sz = 1 / ((yp - ym) * spacing);
    for (let x = 0; x < n; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(n - 1, x + 1);
      const dx = (h[y * n + xp] - h[y * n + xm]) / ((xp - xm) * spacing);
      const dz = (h[yp * n + x] - h[ym * n + x]) * sz;
      const k = 127.5 / Math.sqrt(dx * dx + 1 + dz * dz);
      out[(y * n + x) * 2] = Math.round(127.5 - dx * k);
      out[(y * n + x) * 2 + 1] = Math.round(127.5 - dz * k);
    }
  }
  return out;
}

function bilinear(h: Float32Array, info: GridInfo, x: number, z: number): number {
  const n = info.res;
  const fx = Math.min(Math.max((x / info.size + 0.5) * n - 0.5, 0), n - 1);
  const fz = Math.min(Math.max((z / info.size + 0.5) * n - 0.5, 0), n - 1);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, n - 1), z1 = Math.min(z0 + 1, n - 1);
  const ax = fx - x0, az = fz - z0;
  const a = h[z0 * n + x0] + (h[z0 * n + x1] - h[z0 * n + x0]) * ax;
  const b = h[z1 * n + x0] + (h[z1 * n + x1] - h[z1 * n + x0]) * ax;
  return a + (b - a) * az;
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class TerrainData {
  meta!: TerrainMeta;
  coreH!: Float32Array;
  farH!: Float32Array;
  coreN!: Uint8Array;
  farN!: Uint8Array;
  /** Min/max pyramid: levels[0] = leaf grid (2048^2 for 81.92 km), levels[k] = 2^-k resolution. */
  minMax: Array<{ n: number; min: Float32Array; max: Float32Array }> = [];

  static async load(onProgress?: (msg: string, frac: number) => void): Promise<TerrainData> {
    const d = new TerrainData();
    d.meta = await fetchJson('terrain/meta.json');
    const files = ['terrain/core_height.bin', 'terrain/far_height.bin'];
    const sizes = await Promise.all(files.map((f, i) => downloadSize(f, (i ? d.meta.far.res : d.meta.core.res) ** 2 * 2)));
    const total = sizes[0] + sizes[1];
    const loaded = [0, 0];
    const [ch, fh] = await Promise.all(
      files.map((f, i) =>
        fetchData(f, (l) => {
          loaded[i] = l;
          onProgress?.('Terrain: heights', (loaded[0] + loaded[1]) / total);
        }),
      ),
    );
    onProgress?.('Terrain: normals', 1);
    d.coreH = decodeHeights(ch, d.meta.core);
    d.farH = decodeHeights(fh, d.meta.far);
    d.coreN = normalMapRG8(d.coreH, d.meta.core.res, d.meta.core.size / d.meta.core.res);
    d.farN = normalMapRG8(d.farH, d.meta.far.res, d.meta.far.size / d.meta.far.res);
    d.buildMinMax();
    return d;
  }

  /** Terrain height at world (x, z) — identical blend to the GPU sampler. */
  heightAt(x: number, z: number): number {
    const core = this.meta.core;
    const hf = bilinear(this.farH, this.meta.far, x, z);
    const edge = core.size / 2 - Math.max(Math.abs(x), Math.abs(z));
    if (edge <= 0) return hf;
    const w = smoothstep(0, CORE_BLEND, edge);
    const hc = bilinear(this.coreH, core, x, z);
    return hf + (hc - hf) * w;
  }

  /** Approximate world-space normal at (x, z) via central differences. */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }, eps = 3) {
    const dx = (this.heightAt(x + eps, z) - this.heightAt(x - eps, z)) / (2 * eps);
    const dz = (this.heightAt(x, z + eps) - this.heightAt(x, z - eps)) / (2 * eps);
    const inv = 1 / Math.hypot(dx, 1, dz);
    out.x = -dx * inv;
    out.y = inv;
    out.z = -dz * inv;
    return out;
  }

  get worldSize() {
    return this.meta.far.size;
  }

  private buildMinMax() {
    const far = this.meta.far;
    const core = this.meta.core;
    const n = Math.round(far.size / LEAF_SIZE); // 2048
    const min = new Float32Array(n * n).fill(Infinity);
    const max = new Float32Array(n * n).fill(-Infinity);
    const half = far.size / 2;
    // far texels (same 40 m grid as leaves), include neighbours for bilinear support
    const fr = far.res;
    const scale = fr / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let lo = Infinity, hi = -Infinity;
        const fx = Math.floor(x * scale), fy = Math.floor(y * scale);
        for (let dy = -1; dy <= Math.ceil(scale); dy++) {
          for (let dx = -1; dx <= Math.ceil(scale); dx++) {
            const xx = Math.min(fr - 1, Math.max(0, fx + dx));
            const yy = Math.min(fr - 1, Math.max(0, fy + dy));
            const v = this.farH[yy * fr + xx];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        min[y * n + x] = lo;
        max[y * n + x] = hi;
      }
    }
    // core texels
    const cr = core.res;
    for (let y = 0; y < cr; y++) {
      const wz = -core.size / 2 + (y + 0.5) * core.spacing;
      const ly = Math.floor((wz + half) / LEAF_SIZE);
      for (let x = 0; x < cr; x++) {
        const wx = -core.size / 2 + (x + 0.5) * core.spacing;
        const lx = Math.floor((wx + half) / LEAF_SIZE);
        const v = this.coreH[y * cr + x];
        const i = ly * n + lx;
        if (v < min[i]) min[i] = v;
        if (v > max[i]) max[i] = v;
      }
    }
    this.minMax = [{ n, min, max }];
    let cur = this.minMax[0];
    while (cur.n > 1) {
      const m = cur.n / 2;
      const mn = new Float32Array(m * m);
      const mx = new Float32Array(m * m);
      for (let y = 0; y < m; y++) {
        for (let x = 0; x < m; x++) {
          const i0 = 2 * y * cur.n + 2 * x;
          const i1 = i0 + cur.n;
          mn[y * m + x] = Math.min(cur.min[i0], cur.min[i0 + 1], cur.min[i1], cur.min[i1 + 1]);
          mx[y * m + x] = Math.max(cur.max[i0], cur.max[i0 + 1], cur.max[i1], cur.max[i1 + 1]);
        }
      }
      cur = { n: m, min: mn, max: mx };
      this.minMax.push(cur);
    }
  }

  /** Min/max height of quadtree node (level 0 = leaf) with integer coords (ix, iz), written to boundsMin/Max. */
  boundsMin = 0;
  boundsMax = 0;
  nodeBounds(level: number, ix: number, iz: number) {
    const g = this.minMax[level];
    const i = iz * g.n + ix;
    this.boundsMin = g.min[i];
    this.boundsMax = g.max[i];
  }
}
