// Deterministic camera paths for benchmarks and reproducible screenshots.
// Each key: LV95 position (or POI name) + height mode, look target; positions are resolved at runtime.
import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { POIS, lv95ToWorld } from '../world/geo';

interface Key {
  at: string | [number, number]; // POI name or LV95 [e, n]
  h: number; // metres
  agl?: boolean; // h above ground level (default) or absolute
}

interface PathDef {
  label: string;
  seconds: number;
  keys: Key[];
  look: Key[]; // look-at targets (same count as keys)
}

export const BENCH_PATHS: Record<string, PathDef> = {
  valley: {
    label: 'Vol bas dans la vallée de Lauterbrunnen',
    seconds: 30,
    keys: [
      { at: 'interlaken', h: 250 },
      { at: [2634700, 1166000], h: 150 },
      { at: 'lauterbrunnen', h: 120 },
      { at: [2636300, 1157000], h: 150 },
      { at: [2637300, 1153600], h: 250 },
    ],
    look: [
      { at: 'lauterbrunnen', h: 300 },
      { at: 'lauterbrunnen', h: 200 },
      { at: [2636300, 1157000], h: 200 },
      { at: 'jungfrau', h: 0 },
      { at: 'jungfrau', h: 0 },
    ],
  },
  flyover: {
    label: 'Survol haute altitude Eiger / Mönch / Jungfrau',
    seconds: 30,
    keys: [
      { at: 'grindelwald', h: 4300, agl: false },
      { at: 'eiger', h: 4600, agl: false },
      { at: 'monch', h: 4700, agl: false },
      { at: 'jungfrau', h: 4800, agl: false },
      { at: 'murren', h: 4200, agl: false },
    ],
    look: [
      { at: 'eiger', h: 0 },
      { at: 'monch', h: 0 },
      { at: 'jungfrau', h: 0 },
      { at: 'lauterbrunnen', h: 0 },
      { at: 'interlaken', h: 0 },
    ],
  },
  lake: {
    label: 'Vol bas le long du lac de Brienz (reflets)',
    seconds: 30,
    keys: [
      { at: [2635800, 1171200], h: 60 },
      { at: [2638500, 1172300], h: 50 },
      { at: [2641000, 1174500], h: 50 },
      { at: [2643500, 1175600], h: 50 },
      { at: [2646000, 1176800], h: 70 },
    ],
    look: [
      { at: [2641000, 1174500], h: 200 },
      { at: [2643500, 1175600], h: 150 },
      { at: [2646000, 1176800], h: 150 },
      { at: [2648500, 1178000], h: 200 },
      { at: [2651000, 1179000], h: 300 },
    ],
  },
  walk: {
    label: 'Marche près de Kleine Scheidegg',
    seconds: 30,
    keys: [
      { at: [2639600, 1159800], h: 1.7 },
      { at: [2639800, 1159650], h: 1.7 },
      { at: [2640043, 1159470], h: 1.7 },
      { at: [2640250, 1159300], h: 1.7 },
      { at: [2640400, 1159150], h: 1.7 },
    ],
    look: [
      { at: 'eiger', h: 0 },
      { at: 'monch', h: 0 },
      { at: 'jungfrau', h: 0 },
      { at: 'lauterbrunnen', h: 0 },
      { at: 'eiger', h: 0 },
    ],
  },
};

export function resolvePath(name: string, heightAt: (x: number, z: number) => number) {
  const def = BENCH_PATHS[name];
  if (!def) throw new Error(`unknown path "${name}" (${Object.keys(BENCH_PATHS).join(', ')})`);
  const toWorld = (k: Key) => {
    const [e, n] = typeof k.at === 'string' ? [POIS[k.at].e, POIS[k.at].n] : k.at;
    const w = lv95ToWorld(e, n);
    const y = k.agl === false ? k.h : heightAt(w.x, w.z) + k.h;
    return new Vector3(w.x, y, w.z);
  };
  const curve = new CatmullRomCurve3(def.keys.map(toWorld), false, 'centripetal');
  const look = new CatmullRomCurve3(def.look.map(toWorld), false, 'centripetal');
  // the spline ignores the relief between keys: ground-relative paths are kept at least at their lowest key
  // height above the terrain (a walk stays exactly at eye height)
  const rel = def.keys.filter((k) => k.agl !== false);
  const minAgl = rel.length ? Math.min(...rel.map((k) => k.h)) : -Infinity;
  const walk = rel.length === def.keys.length && def.keys.every((k) => k.h < 3);
  const pos = {
    getPointAt(u: number, target: Vector3) {
      curve.getPointAt(u, target);
      const g = heightAt(target.x, target.z);
      target.y = walk ? g + minAgl : Math.max(target.y, g + minAgl);
      return target;
    },
  };
  return { def, pos, look };
}
