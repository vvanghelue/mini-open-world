// Astronomical sun & moon directions for the Bernese Oberland (NOAA-style approximations, ~0.1° for the sun,
// ~1° for the moon — plenty for rendering). World convention: +X east, +Y up, -Z north.
import { Vector3 } from 'three/webgpu';

const DEG = Math.PI / 180;
export const SITE = { lat: 46.6, lon: 7.95, utcOffset: 2 }; // CEST (summer time)

function julianDay(year: number, dayOfYear: number, utcHours: number) {
  // Julian day of Jan 1st 0h UT of `year`, plus offset
  const a = Math.floor((14 - 1) / 12);
  const y = year + 4800 - a;
  const m = 1 + 12 * a - 3;
  const jdn = 1 + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  return jdn - 0.5 + (dayOfYear - 1) + utcHours / 24;
}

/** Converts equatorial coordinates to a world-space direction for the site at the given sidereal time. */
function equatorialToWorld(ra: number, dec: number, jd: number, out: Vector3) {
  const d = jd - 2451545.0;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  const lst = (gmst + SITE.lon) * DEG;
  const ha = lst - ra;
  const lat = SITE.lat * DEG;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const alt = Math.asin(sinAlt);
  // azimuth from north, clockwise (east = 90°)
  const az = Math.atan2(-Math.sin(ha) * Math.cos(dec), Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(ha));
  const ca = Math.cos(alt);
  out.set(Math.sin(az) * ca, Math.sin(alt), -Math.cos(az) * ca);
  return out;
}

export function sunDirection(year: number, dayOfYear: number, localHours: number, out: Vector3) {
  const jd = julianDay(year, dayOfYear, localHours - SITE.utcOffset);
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  return equatorialToWorld(ra, dec, jd, out);
}

/** Moon direction and phase (0 = new, 0.5 = full). */
export function moonDirection(year: number, dayOfYear: number, localHours: number, out: Vector3) {
  const jd = julianDay(year, dayOfYear, localHours - SITE.utcOffset);
  const d = jd - 2451545.0;
  const L = (218.316 + 13.176396 * d) * DEG;
  const M = (134.963 + 13.064993 * d) * DEG;
  const F = (93.272 + 13.22935 * d) * DEG;
  const lon = L + 6.289 * DEG * Math.sin(M);
  const lat = 5.128 * DEG * Math.sin(F);
  const eps = 23.439 * DEG;
  const ra = Math.atan2(Math.sin(lon) * Math.cos(eps) - Math.tan(lat) * Math.sin(eps), Math.cos(lon));
  const dec = Math.asin(Math.sin(lat) * Math.cos(eps) + Math.cos(lat) * Math.sin(eps) * Math.sin(lon));
  equatorialToWorld(ra, dec, jd, out);
  // phase from elongation
  const sunL = (280.46 + 0.9856474 * d) * DEG;
  const phase = (((lon - sunL) / (2 * Math.PI)) % 1 + 1) % 1;
  return phase;
}
