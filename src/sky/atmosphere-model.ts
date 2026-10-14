// Physical atmosphere constants (Earth, Hillaire 2020 / Bruneton) and CPU-side helpers.
// Distances in km. Scattering coefficients in 1/km.

export const R_GROUND = 6360;
export const R_TOP = 6460;

export const RAYLEIGH_SCATTERING = [5.802e-3, 13.558e-3, 33.1e-3];
export const RAYLEIGH_SCALE_HEIGHT = 8;
export const MIE_SCATTERING = 3.996e-3;
export const MIE_EXTINCTION = 4.4e-3;
export const MIE_SCALE_HEIGHT = 1.2;
export const OZONE_ABSORPTION = [0.65e-3, 1.881e-3, 0.085e-3];

/** Sun illuminance at the top of the atmosphere (lux) and angular radius (rad). */
export const SUN_ILLUMINANCE = 120000;
export const SUN_ANGULAR_RADIUS = 0.004675;
export const MOON_ANGULAR_RADIUS = 0.0045;
/** Full-moon illuminance at the top of the atmosphere (lux). */
export const MOON_ILLUMINANCE = 0.32;

export interface AtmoParams {
  rayleigh: number; // multiplier
  mie: number; // haze density multiplier
  ozone: number;
}

/** Transmittance from altitude h (km above sea level) towards direction with zenith cosine mu (CPU, RGB). */
export function transmittanceCPU(hKm: number, mu: number, p: AtmoParams, out: number[] = [0, 0, 0]) {
  const r = R_GROUND + Math.max(0.01, hKm);
  // ground hit -> no light (soft below horizon handled by caller)
  const disc = r * r * (mu * mu - 1) + R_GROUND * R_GROUND;
  if (mu < 0 && disc >= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const dTop = -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + R_TOP * R_TOP));
  const steps = 48;
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * dTop;
    const x = t * Math.sqrt(1 - mu * mu);
    const y = r + t * mu;
    const h = Math.hypot(x, y) - R_GROUND;
    const dt = dTop / steps;
    odR += Math.exp(-h / RAYLEIGH_SCALE_HEIGHT) * dt;
    odM += Math.exp(-h / MIE_SCALE_HEIGHT) * dt;
    odO += Math.max(0, 1 - Math.abs(h - 25) / 15) * dt;
  }
  for (let c = 0; c < 3; c++) {
    const tau = RAYLEIGH_SCATTERING[c] * p.rayleigh * odR + MIE_EXTINCTION * p.mie * odM + OZONE_ABSORPTION[c] * p.ozone * odO;
    out[c] = Math.exp(-tau);
  }
  return out;
}

// Diffuse sky irradiance on a horizontal plane (lux) vs sun elevation (deg), excluding direct sun.
// Calibrated against this atmosphere model (Atmosphere.measureSkyIrradiance, haze = 1).
const SKY_TABLE: Array<[number, number]> = [
  [-90, 0.0001], [-14.3, 0.001], [-12.8, 0.006], [-11.15, 0.032], [-9.4, 0.14], [-7.56, 1.74], [-5.63, 10.7],
  [-3.61, 102], [-1.52, 463], [0.64, 1260], [2.87, 2100], [5.15, 2810], [7.5, 3360], [9.9, 3780], [14.8, 4390],
  [19.8, 4830], [24.9, 5170], [30, 5450], [40, 5890], [50, 6210], [58.5, 6430], [90, 6800],
];

export function skyIlluminanceLux(sunElevDeg: number) {
  for (let i = 1; i < SKY_TABLE.length; i++) {
    const [e1, l1] = SKY_TABLE[i];
    if (sunElevDeg <= e1) {
      const [e0, l0] = SKY_TABLE[i - 1];
      const t = (sunElevDeg - e0) / (e1 - e0);
      return Math.exp(Math.log(l0) + (Math.log(l1) - Math.log(l0)) * t);
    }
  }
  return SKY_TABLE[SKY_TABLE.length - 1][1];
}
