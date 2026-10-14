// Procedural conifer generator (Norway spruce / silver fir / European larch).
// Produces two geometries per tree: bark (tapered trunk) and foliage (alpha-tested twig cards along branch whorls).
// Foliage vertices carry vdata = (ao, flex, phase, heightRel) for shading and wind.
import * as THREE from 'three/webgpu';

export interface TwigRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface TreeParams {
  name: string;
  height: number;
  crownBase: number; // fraction of the height where branches start
  crownRadius: number; // max crown radius (m)
  whorlSpacing: number; // m
  branchesPerWhorl: number;
  droop: number; // lower branches droop (0..1)
  upturn: number; // tip upturn
  cardSize: number; // m
  cardSpacing: number; // m along branches
  density: number; // 0..1 probability to keep a card
  trunkRadius: number;
  tint: [number, number, number]; // foliage albedo multiplier
  topShape: number; // 1 = pointed cone, <1 = rounded/flat top (fir)
  seed: number;
}

export const TREE_PRESETS: TreeParams[] = [
  { name: 'spruce_tall', height: 29, crownBase: 0.22, crownRadius: 4.0, whorlSpacing: 0.5, branchesPerWhorl: 5, droop: 0.6, upturn: 0.45, cardSize: 1.9, cardSpacing: 0.62, density: 0.95, trunkRadius: 0.38, tint: [0.9, 0.95, 0.88], topShape: 1, seed: 11 },
  { name: 'spruce_young', height: 15, crownBase: 0.06, crownRadius: 2.8, whorlSpacing: 0.42, branchesPerWhorl: 5, droop: 0.35, upturn: 0.4, cardSize: 1.5, cardSpacing: 0.5, density: 0.97, trunkRadius: 0.2, tint: [0.98, 1.0, 0.95], topShape: 1, seed: 23 },
  { name: 'fir', height: 25, crownBase: 0.2, crownRadius: 3.8, whorlSpacing: 0.55, branchesPerWhorl: 5, droop: 0.18, upturn: 0.15, cardSize: 1.9, cardSpacing: 0.6, density: 0.95, trunkRadius: 0.36, tint: [0.82, 0.9, 0.86], topShape: 0.7, seed: 37 },
  { name: 'larch', height: 23, crownBase: 0.28, crownRadius: 3.2, whorlSpacing: 0.6, branchesPerWhorl: 4, droop: 0.3, upturn: 0.6, cardSize: 1.6, cardSpacing: 0.6, density: 0.8, trunkRadius: 0.32, tint: [1.25, 1.35, 0.95], topShape: 0.9, seed: 51 },
];

class Rng {
  constructor(private s: number) {}
  next() {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
}

export interface GeneratedTree {
  params: TreeParams;
  bark: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
  radius: number;
  height: number;
}

const _v = new THREE.Vector3();

export function generateTree(p: TreeParams, twigs: TwigRect[], lod: 0 | 1): GeneratedTree {
  const rng = new Rng(p.seed * 7919 + lod);
  const H = p.height;

  // ---------------------------------------------------------------- trunk
  const radial = lod === 0 ? 10 : 6;
  const rings = lod === 0 ? 14 : 6;
  const bPos: number[] = [], bNrm: number[] = [], bUv: number[] = [], bIdx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = t * H;
    const rad = Math.max(0.02, p.trunkRadius * Math.pow(1 - t, 0.9) * (1 + 0.25 * Math.max(0, 0.06 - t) / 0.06));
    for (let a = 0; a <= radial; a++) {
      const ang = (a / radial) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      bPos.push(c * rad, y, s * rad);
      bNrm.push(c, 0.15, s);
      bUv.push((a / radial) * 2, y / 2.2);
    }
  }
  for (let r = 0; r < rings; r++) for (let a = 0; a < radial; a++) {
    const i0 = r * (radial + 1) + a, i1 = i0 + 1, i2 = i0 + radial + 1, i3 = i2 + 1;
    bIdx.push(i0, i2, i1, i1, i2, i3);
  }
  const bark = new THREE.BufferGeometry();
  bark.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bark.setAttribute('normal', new THREE.Float32BufferAttribute(bNrm, 3));
  bark.setAttribute('uv', new THREE.Float32BufferAttribute(bUv, 2));
  bark.setIndex(bIdx);

  // ---------------------------------------------------------------- foliage cards
  const fPos: number[] = [], fNrm: number[] = [], fUv: number[] = [], fData: number[] = [], fIdx: number[] = [];
  const spacingMul = lod === 0 ? 1 : 2.1;
  const sizeMul = lod === 0 ? 1 : 1.75;
  const crownStart = H * p.crownBase;
  const crownLen = H - crownStart;
  let maxR = 0;

  const addCard = (center: THREE.Vector3, fwd: THREE.Vector3, side: THREE.Vector3, len: number, wid: number, twig: TwigRect, ao: number, flex: number, phase: number, outward: THREE.Vector3) => {
    const n = new THREE.Vector3().crossVectors(side, fwd).normalize();
    if (n.y < 0) n.negate();
    // blend card normal with a spherical (outward) normal for volumetric shading
    const sph = outward.clone().multiplyScalar(0.8).add(n.clone().multiplyScalar(0.2)).normalize();
    const base = fPos.length / 3;
    const corners = [
      [-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1],
    ];
    for (const [sx, fy] of corners) {
      _v.copy(center).addScaledVector(side, sx * wid).addScaledVector(fwd, (fy - 0.15) * len);
      fPos.push(_v.x, _v.y, _v.z);
      fNrm.push(sph.x, sph.y, sph.z);
      // sprite: twig stem at the bottom of the rect (v1), tip at the top (v0)
      fUv.push(twig.u0 + (sx + 0.5) * (twig.u1 - twig.u0), twig.v1 - fy * (twig.v1 - twig.v0));
      const h = Math.max(0, _v.y / H);
      fData.push(ao, flex * (0.6 + fy * 0.4), phase, h);
    }
    fIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // whorls of main branches plus smaller inter-whorl branches
  const branchesAt: Array<{ y: number; scale: number; count: number }> = [];
  for (let y = crownStart; y < H - 0.3; y += p.whorlSpacing * (lod === 0 ? 1 : 1.5)) {
    branchesAt.push({ y, scale: 1, count: p.branchesPerWhorl + (rng.next() < 0.3 ? 1 : 0) });
    if (lod === 0) branchesAt.push({ y: y + p.whorlSpacing * 0.5, scale: 0.55, count: 3 });
  }
  for (const wb of branchesAt) {
    const y = wb.y;
    if (y >= H - 0.3) continue;
    const t = (y - crownStart) / crownLen; // 0 at crown base, 1 at top
    // conical envelope; topShape < 1 flattens/rounds the top (fir)
    const env = Math.pow(1 - t, p.topShape) * (t < 0.06 ? 0.7 + 5 * t : 1);
    const branchLen = Math.max(0.35, p.crownRadius * env * rng.range(0.85, 1.12) * wb.scale);
    const whorlRot = rng.next() * Math.PI * 2;
    for (let b = 0; b < wb.count; b++) {
      const phi = whorlRot + (b / wb.count) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const dir = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
      // upper branches rise, lower branches droop then turn up at the tip
      const rise = 0.35 * t - p.droop * 0.35 * (1 - t);
      const steps = Math.max(1, Math.round(branchLen / (p.cardSpacing * spacingMul)));
      const origin = new THREE.Vector3(0, y, 0);
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      for (let k = 0; k < steps; k++) {
        const s = ((k + 0.55) / steps) * branchLen;
        const u = s / branchLen;
        const droopY = -p.droop * 0.5 * branchLen * u * u * (1 - t) + p.upturn * 0.25 * Math.pow(u, 3) * branchLen;
        const center = origin.clone().addScaledVector(dir, s);
        center.y += rise * s + droopY;
        if (rng.next() > p.density) continue;
        const tangent = dir.clone().add(new THREE.Vector3(0, rise + (-p.droop * (1 - t) * u + p.upturn * 0.75 * u * u) * 0.5, 0)).normalize();
        const sz = p.cardSize * sizeMul * rng.range(0.85, 1.15) * (0.8 + 0.3 * (1 - u)) * (0.75 + 0.25 * wb.scale) * Math.min(1, 0.45 + env);
        const ao = 0.3 + 0.7 * Math.min(1, u * 0.75 + t * 0.45 + 0.1);
        const phase = rng.next() * 6.283;
        const outward = new THREE.Vector3(dir.x, 0.25 + 0.5 * t, dir.z).normalize();
        const pick = () => twigs[Math.floor(rng.next() * Math.min(4, twigs.length))];
        // 1) spray along the branch, rolled a little around it
        const sideR = side.clone().applyAxisAngle(tangent, rng.range(-0.4, 0.4));
        addCard(center.clone().addScaledVector(tangent, -sz * 0.2), tangent, sideR, sz, sz * 0.8, pick(), ao, u, phase, outward);
        // 2) hanging "comb" curtain under the branch (spruce), more pronounced in the lower crown
        const comb = p.droop * (1 - t) * (0.4 + 0.6 * u);
        if (comb > 0.08 && rng.next() < 0.85) {
          const down = new THREE.Vector3(0, -1, 0).addScaledVector(dir, 0.25).normalize();
          const hang = sz * (0.7 + comb) * rng.range(0.8, 1.1);
          addCard(center.clone().addScaledVector(down, -0.1), down, tangent.clone().applyAxisAngle(down, rng.range(-0.4, 0.4)), hang, sz * 0.75, pick(), ao * 0.85, u, phase, outward);
        }
        // 3) steep card for volume from side views
        if (lod === 0 || rng.next() < 0.5) {
          const side2 = side.clone().applyAxisAngle(tangent, 1.1 + rng.range(-0.35, 0.35));
          addCard(center, tangent, side2, sz * 0.9, sz * 0.7, pick(), ao * 0.95, u, phase, outward);
        }
        maxR = Math.max(maxR, Math.hypot(center.x, center.z) + sz);
      }
    }
  }
  // leader (top shoot)
  const top = new THREE.Vector3(0, H - 0.6, 0);
  const lead = twigs[0];
  addCard(top, new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), 1.0 * sizeMul, 0.55, lead, 1, 0.3, 0, new THREE.Vector3(0, 1, 0));
  addCard(top, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), 1.0 * sizeMul, 0.55, lead, 1, 0.3, 0, new THREE.Vector3(0, 1, 0));

  const foliage = new THREE.BufferGeometry();
  foliage.setAttribute('position', new THREE.Float32BufferAttribute(fPos, 3));
  foliage.setAttribute('normal', new THREE.Float32BufferAttribute(fNrm, 3));
  foliage.setAttribute('uv', new THREE.Float32BufferAttribute(fUv, 2));
  foliage.setAttribute('vdata', new THREE.Float32BufferAttribute(fData, 4));
  foliage.setIndex(fIdx);
  return { params: p, bark, foliage, radius: maxR, height: H };
}
