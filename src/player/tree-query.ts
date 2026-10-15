// CPU replica of the GPU forest scatter (same hash, same keep rule) to find tree trunks near a point, for
// walker collisions. Must stay in sync with src/vegetation/forest.ts (GRID, hash, keep probability, treeline).
import type { TerrainData } from '../terrain/terrain-data';
import { smoothstep } from '../terrain/terrain-data';
import { TREE_PRESETS } from '../vegetation/tree-generator';
import { forestSettings } from '../vegetation/forest';

const GRID = 4.5;

function pcg(v: number) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
const rnd = (h: number) => (h & 0xffffff) / 16777216;

export interface Trunk {
  x: number;
  z: number;
  r: number;
}

export class TreeQuery {
  constructor(private data: TerrainData, private forestAt: (x: number, z: number) => number) {}

  /** Trunks within `radius` of (x, z). */
  near(x: number, z: number, radius: number, out: Trunk[] = []): Trunk[] {
    out.length = 0;
    if (!forestSettings.enabled) return out;
    const ix0 = Math.floor((x - radius) / GRID), ix1 = Math.floor((x + radius) / GRID);
    const iz0 = Math.floor((z - radius) / GRID), iz1 = Math.floor((z + radius) / GRID);
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const h0 = pcg((ix >>> 0) ^ pcg(((iz >>> 0) + 0x9e3779b9) >>> 0));
      const h1 = pcg(h0), h2 = pcg(h1), h3 = pcg(h2);
      const tx = (ix + 0.15 + rnd(h0) * 0.7) * GRID;
      const tz = (iz + 0.15 + rnd(h1) * 0.7) * GRID;
      const keep = this.forestAt(tx, tz) * 0.78 * forestSettings.density;
      if (rnd(h2) > keep) continue;
      const y = this.data.heightAt(tx, tz);
      const tl = forestSettings.treeline + (rnd(h3) - 0.5) * 260;
      if (y > tl) continue;
      const r = rnd(pcg(h3));
      const pLarch = smoothstep(1450, 1950, y) * 0.55;
      const pFir = (1 - smoothstep(900, 1400, y)) * 0.35;
      const variant = r < pLarch ? 3 : r < pLarch + pFir ? 2 : r < pLarch + pFir + 0.25 ? 1 : 0;
      const altScale = 1 + (0.6 - 1) * smoothstep(tl - 300, tl, y);
      const scale = (0.78 + rnd(pcg(h2)) * 0.45) * altScale;
      out.push({ x: tx, z: tz, r: TREE_PRESETS[variant].trunkRadius * scale + 0.15 });
    }
    return out;
  }
}
