// CPU-side terrain data: heightmaps (for collision / queries), normal maps (uploaded to GPU) and a
// min/max height pyramid for the CDLOD quadtree. Height sampling here mirrors the GPU code exactly.

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

async function fetchBin(url: string, onProgress?: (loaded: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (run "npm run data")`);
  if (!res.body || !onProgress) return res.arrayBuffer();
  const total = Number(res.headers.get('content-length')) || 0;
  const out = total ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out) out.set(value, loaded);
    else chunks.push(value);
    loaded += value.length;
    onProgress(loaded);
  }
  if (out) return out.buffer;
  const merged = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  return merged.buffer;
}

function decodeHeights(buf: ArrayBuffer, info: GridInfo): Float32Array {
  const q = new Uint16Array(buf);
  const out = new Float32Array(q.length);
  const k = (info.hMax - info.hMin) / 65535;
  for (let i = 0; i < q.length; i++) out[i] = info.hMin + q[i] * k;
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
    const base = '/data/terrain/';
    d.meta = await (await fetch(base + 'meta.json')).json();
    const total = 2 * (d.meta.core.res ** 2 * 2) + 2 * (d.meta.far.res ** 2 * 2);
    let done = 0;
    const prog = (label: string) => {
      let last = 0;
      return (l: number) => {
        done += l - last;
        last = l;
        onProgress?.(`Terrain : ${label}`, done / total);
      };
    };
    const [ch, cn, fh, fn] = await Promise.all([
      fetchBin(base + 'core_height.bin', prog('altitudes')),
      fetchBin(base + 'core_normal.bin', prog('normales')),
      fetchBin(base + 'far_height.bin', prog('horizon')),
      fetchBin(base + 'far_normal.bin', prog('horizon')),
    ]);
    d.coreH = decodeHeights(ch, d.meta.core);
    d.farH = decodeHeights(fh, d.meta.far);
    d.coreN = new Uint8Array(cn);
    d.farN = new Uint8Array(fn);
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

  /** Min/max height of quadtree node (level 0 = leaf) with integer coords (ix, iz) at that level. */
  nodeBounds(level: number, ix: number, iz: number): [number, number] {
    const g = this.minMax[level];
    const i = iz * g.n + ix;
    return [g.min[i], g.max[i]];
  }
}
