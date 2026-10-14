// Shared geographic constants and Swiss LV95 <-> WGS84 conversions (swisstopo approximate formulas, ~1 m accuracy).

// Core area: high resolution swissALTI3D (2 m source, resampled to 3 m), 24.576 km square.
export const CORE = {
  e0: 2626000, // LV95 easting of the west edge (m)
  n0: 1150000, // LV95 northing of the south edge (m)
  size: 24576, // metres
  res: 8192, // samples per side -> 3 m spacing
};

// Far ring: Copernicus GLO-30, 81.92 km square centred on the core centre.
export const FAR = {
  size: 81920,
  res: 2048, // 40 m spacing
};

export const CORE_CENTER = { e: CORE.e0 + CORE.size / 2, n: CORE.n0 + CORE.size / 2 };

export function wgs84ToLV95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return { e, n };
}

export function lv95ToWGS84(e, n) {
  const y = (e - 2600000) / 1e6;
  const x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}

// World space (three.js, metres): origin at core centre, +X east, +Y up, -Z north.
export function lv95ToWorld(e, n) {
  return { x: e - CORE_CENTER.e, z: -(n - CORE_CENTER.n) };
}
