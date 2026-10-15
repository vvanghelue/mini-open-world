// Geographic helpers (runtime). World space: metres, origin at the core centre, +X east, +Y up, -Z north.
// Must match tools/data/geo.mjs.

export const CORE_CENTER = { e: 2638288, n: 1162288 }; // LV95 of world origin

export function lv95ToWorld(e: number, n: number) {
  return { x: e - CORE_CENTER.e, z: -(n - CORE_CENTER.n) };
}

export function worldToLV95(x: number, z: number) {
  return { e: x + CORE_CENTER.e, n: CORE_CENTER.n - z };
}

export function lv95ToWGS84(e: number, n: number) {
  const y = (e - 2600000) / 1e6;
  const x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}

/** Points of interest (LV95). Names in French for the UI. */
export const POIS: Record<string, { e: number; n: number; label: string }> = {
  jungfrau: { e: 2640187, n: 1154068, label: 'Jungfrau' },
  eiger: { e: 2643437, n: 1158637, label: 'Eiger' },
  monch: { e: 2642847, n: 1156521, label: 'Mönch' },
  lauterbrunnen: { e: 2636053, n: 1160356, label: 'Lauterbrunnen' },
  wengen: { e: 2637000, n: 1162007, label: 'Wengen' },
  murren: { e: 2634803, n: 1156513, label: 'Mürren' },
  grindelwald: { e: 2646165, n: 1163838, label: 'Grindelwald' },
  interlaken: { e: 2632479, n: 1170652, label: 'Interlaken' },
  airfield: { e: 2633710, n: 1169580, label: 'Aérodrome d\'Interlaken' },
  kleinescheidegg: { e: 2640043, n: 1159470, label: 'Kleine Scheidegg' },
  schilthorn: { e: 2630409, n: 1156367, label: 'Schilthorn' },
  brienzersee: { e: 2641000, n: 1174500, label: 'Lac de Brienz' },
  thunersee: { e: 2624500, n: 1170200, label: 'Lac de Thoune' },
};
