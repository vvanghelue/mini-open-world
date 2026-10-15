// Terrain surface shading (fragment stage). Layers (see tools/data/build-textures.mjs):
//   0 meadow, 1 forest floor, 2 scree, 3 cliff (triplanar), 4 snow, 5 path/gravel, 6 alpine grass, 7 urban
// Weights come from the orthophoto land-cover map (core) or altitude/slope rules (far ring), are broken up
// with noise and sharpened with per-texture heights. Detail textures are tinted by the de-lit orthophoto so
// near and far colours match; beyond ~1.5 km only the macro albedo remains.
import * as THREE from 'three/webgpu';
import {
  Fn, texture, uniform, vec2, vec3, vec4, float, If, clamp, mix, smoothstep, max, min, length, normalize, abs, pow,
  dFdx, dFdy, positionWorld, cameraPosition, transformNormalToView, sin, time, property, int, reflect, dot,
} from 'three/tsl';
import type { TerrainTextures } from './terrain-textures';
import { settings } from '../core/settings';

export const terrainMatSettings = settings.group('terrainMat', 'Terrain — matériaux', {
  detailDistance: { value: 1400, min: 200, max: 4000, step: 50, label: 'Distance détail (m)' },
  tintStrength: { value: 0.85, min: 0, max: 1, step: 0.01, label: 'Teinte orthophoto' },
  normalStrength: { value: 1.0, min: 0, max: 3, step: 0.05, label: 'Relief des textures' },
  heightBlend: { value: 3.0, min: 0, max: 8, step: 0.1, label: 'Mélange par hauteur' },
  cliffAngle: { value: 0.42, min: 0.2, max: 0.8, step: 0.01, label: 'Seuil falaise (1-cos)' },
  macroOnly: { value: false, label: 'Orthophoto seule (debug)' },
});

const TILE = [5, 4, 7, 14, 9, 4, 7, 12]; // metres per texture repeat, per layer

/** Late-bound hooks provided by other systems (set before the first render). */
export const terrainHooks: { sky: ((dir: any) => any) | null } = { sky: null };
const ROUGH_BIAS = [0, 0, 0, 0, -0.15, 0, 0, 0];

export interface TerrainMaterialInputs {
  textures: TerrainTextures;
  coreSize: number;
  farSize: number;
  coreWeight: (xz: any) => any;
  macroNormal: (xz: any) => any;
}

export function applyTerrainMaterial(mat: THREE.MeshStandardNodeMaterial, inp: TerrainMaterialInputs) {
  const tx = inp.textures;
  const uDetailDist = uniform(terrainMatSettings.detailDistance);
  const uTint = uniform(terrainMatSettings.tintStrength);
  const uNormalStr = uniform(terrainMatSettings.normalStrength);
  const uHeightBlend = uniform(terrainMatSettings.heightBlend);
  const uCliff = uniform(terrainMatSettings.cliffAngle);
  const uMacroOnly = uniform(terrainMatSettings.macroOnly ? 1 : 0);
  settings.on('terrainMat.detailDistance', (v) => (uDetailDist.value = v as number));
  settings.on('terrainMat.tintStrength', (v) => (uTint.value = v as number));
  settings.on('terrainMat.normalStrength', (v) => (uNormalStr.value = v as number));
  settings.on('terrainMat.heightBlend', (v) => (uHeightBlend.value = v as number));
  settings.on('terrainMat.cliffAngle', (v) => (uCliff.value = v as number));
  settings.on('terrainMat.macroOnly', (v) => (uMacroOnly.value = v ? 1 : 0));

  const means = tx.layers.map((l) => vec3(...l.meanAlbedo));
  const coreSize = inp.coreSize;
  const farSize = inp.farSize;

  // Per-fragment surface values are computed once in the colour node and shared with the normal / roughness / ao
  // slots through shader-scope properties (three evaluates the colour node before lighting).
  const pNormal = property('vec3', 'terrainNormalW');
  const pRough = property('float', 'terrainRough');
  const pAO = property('float', 'terrainAO');
  const pWater = property('float', 'terrainWater');
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const xz = p.xz;
    const dist = length(cameraPosition.sub(p));
    const nM = inp.macroNormal(xz).toVar();
    const slope = float(1).sub(nM.y);
    const alt = p.y;
    const cw = inp.coreWeight(xz);

    // noise (tiling, several scales)
    const n1 = texture(tx.noise, xz.div(97)).toVar(); // ~6 m to 50 m features
    const n2 = texture(tx.noise, xz.div(11.3)).toVar(); // ~0.7 m to 6 m features

    // land cover: warp lookup to hide the 6 m texel grid
    const warp = vec2(n2.r, n2.g).sub(0.5).mul(7).add(vec2(n1.b, n1.a).sub(0.5).mul(10));
    const lcUV = xz.add(warp).div(coreSize).add(0.5);
    const farUV = xz.add(warp.mul(3)).div(farSize).add(0.5);
    const A = mix(texture(tx.farLandcover, farUV).depth(int(0) as any), texture(tx.landcover, lcUV).depth(int(0) as any), cw);
    const B = mix(texture(tx.farLandcover, farUV).depth(int(1) as any), texture(tx.landcover, lcUV).depth(int(1) as any), cw);
    // fall back to procedural rules where no land-cover data exists (outside Switzerland)
    const hasLC = smoothstep(0.2, 0.6, A.r.add(A.g).add(A.b).add(A.a).add(B.r).add(B.g).add(B.b));

    // procedural land cover for the far ring
    const nAlt = n1.r.sub(0.5).mul(300);
    const pSnow = smoothstep(2650, 3050, alt.add(nAlt)).mul(float(1).sub(smoothstep(0.45, 0.7, slope)));
    const pRock = max(smoothstep(0.35, 0.55, slope), smoothstep(2200, 2600, alt.add(nAlt))).mul(float(1).sub(pSnow));
    const pForest = smoothstep(650, 750, alt).mul(float(1).sub(smoothstep(1650, 1950, alt.add(nAlt)))).mul(smoothstep(0.35, 0.6, n1.g)).mul(float(1).sub(pRock)).mul(float(1).sub(pSnow));
    const pGrass = max(float(0), float(1).sub(pSnow).sub(pRock).sub(pForest));

    const forest = mix(pForest, A.r, hasLC);
    const grass = mix(pGrass, A.g, hasLC);
    const rock = mix(pRock, A.b, hasLC);
    const snow = mix(pSnow, A.a, hasLC);
    const water = B.r.mul(hasLC);
    const urban = B.g.mul(hasLC);
    const gravel = B.b.mul(hasLC);

    const alpine = smoothstep(1450, 1950, alt.add(n1.g.sub(0.5).mul(250)));
    const cliffF = smoothstep(uCliff, uCliff.add(0.15), slope.add(n2.b.sub(0.5).mul(0.08)));
    const notCliff = float(1).sub(cliffF);
    const snowSteep = float(1).sub(smoothstep(0.55, 0.75, slope));

    const w = [
      grass.mul(float(1).sub(alpine)).mul(notCliff), // meadow
      forest.mul(notCliff), // forest floor
      rock.mul(notCliff), // scree
      rock.add(grass).add(forest).add(gravel).add(urban).mul(cliffF).add(snow.mul(float(1).sub(snowSteep))), // cliff
      snow.mul(snowSteep), // snow
      gravel.mul(notCliff), // path
      grass.mul(alpine).mul(notCliff), // alpine
      urban.mul(notCliff), // urban
    ].map((x) => x.toVar());

    // derivatives once, outside of non-uniform control flow (sampling uses explicit gradients)
    const dx = dFdx(p).toVar();
    const dy = dFdy(p).toVar();
    const nearW = float(1).sub(smoothstep(uDetailDist.mul(0.6), uDetailDist, dist)).mul(float(1).sub(uMacroOnly));

    const accA = vec3(0).toVar();
    const accN = vec3(0).toVar(); // world-space normal accumulation
    const accR = float(0).toVar();
    const accAO = float(0).toVar();
    const accMean = vec3(0).toVar();
    const accW = float(0).toVar();

    // triplanar blend for the cliff layer
    const tb = pow(abs(nM), vec3(4)).toVar();
    tb.divAssign(tb.x.add(tb.y).add(tb.z));

    for (let i = 0; i < 8; i++) {
      If((w[i].greaterThan(0.004) as any).and(nearW.greaterThan(0.001)), () => {
        const inv = 1 / TILE[i];
        const sampleA = (uv: any, gx: any, gy: any) => texture(tx.albedoArray, uv).depth(int(i) as any).grad(gx, gy);
        const sampleN = (uv: any, gx: any, gy: any) => texture(tx.normalArray, uv).depth(int(i) as any).grad(gx, gy);
        const a = vec4(0).toVar();
        const nr = vec4(0).toVar();
        const nW = vec3(0).toVar();
        if (i === 3) {
          // triplanar (UDN blend, Golus 2017)
          const uvX = p.zy.mul(inv), uvY = p.xz.mul(inv), uvZ = p.xy.mul(inv);
          const aX = sampleA(uvX, dx.zy.mul(inv), dy.zy.mul(inv));
          const aY = sampleA(uvY, dx.xz.mul(inv), dy.xz.mul(inv));
          const aZ = sampleA(uvZ, dx.xy.mul(inv), dy.xy.mul(inv));
          a.assign(aX.mul(tb.x).add(aY.mul(tb.y)).add(aZ.mul(tb.z)));
          const tX = sampleN(uvX, dx.zy.mul(inv), dy.zy.mul(inv));
          const tY = sampleN(uvY, dx.xz.mul(inv), dy.xz.mul(inv));
          const tZ = sampleN(uvZ, dx.xy.mul(inv), dy.xy.mul(inv));
          nr.assign(tX.mul(tb.x).add(tY.mul(tb.y)).add(tZ.mul(tb.z)));
          const s = uNormalStr.mul(nearW);
          const nX = vec3(nM.x, tX.y.mul(2).sub(1).mul(s).add(nM.y), tX.x.mul(2).sub(1).mul(s).add(nM.z));
          const nY = vec3(tY.x.mul(2).sub(1).mul(s).add(nM.x), nM.y, tY.y.mul(2).sub(1).negate().mul(s).add(nM.z));
          const nZ = vec3(tZ.x.mul(2).sub(1).mul(s).add(nM.x), tZ.y.mul(2).sub(1).mul(s).add(nM.y), nM.z);
          nW.assign(nX.mul(tb.x).add(nY.mul(tb.y)).add(nZ.mul(tb.z)));
        } else {
          const uv = p.xz.mul(inv);
          a.assign(sampleA(uv, dx.xz.mul(inv), dy.xz.mul(inv)));
          nr.assign(sampleN(uv, dx.xz.mul(inv), dy.xz.mul(inv)));
          const s = uNormalStr.mul(nearW);
          nW.assign(vec3(nr.x.mul(2).sub(1).mul(s).add(nM.x), nM.y, nr.y.mul(2).sub(1).negate().mul(s).add(nM.z)));
        }
        // height-based blending: higher texels of a layer win at transitions
        const wh = w[i].mul(pow(a.a.add(0.25), uHeightBlend)).toVar();
        accA.addAssign(a.rgb.mul(wh));
        accN.addAssign(nW.mul(wh));
        accR.addAssign(clamp(nr.z.add(ROUGH_BIAS[i]), 0.05, 1).mul(wh));
        accAO.addAssign(nr.w.mul(wh));
        accMean.addAssign(means[i].mul(wh));
        accW.addAssign(wh);
      });
    }

    const has = accW.greaterThan(1e-5);
    const invW = float(1).div(max(accW, 1e-5));
    const detailA = accA.mul(invW);
    const detailMean = accMean.mul(invW);

    // macro albedo: de-lit orthophoto in the core; procedural colours outside
    const macroCore = texture(tx.macroAlbedo, xz.div(coreSize).add(0.5)).rgb;
    const macroFar = texture(tx.farAlbedo, xz.div(farSize).add(0.5)).rgb;
    const wSum = max(w[0].add(w[1]).add(w[2]).add(w[3]).add(w[4]).add(w[5]).add(w[6]).add(w[7]), 1e-4);
    // procedural fallback colours (forest = canopy seen from above, not forest floor)
    const macroProc = means[0].mul(w[0]).add(vec3(0.035, 0.055, 0.025).mul(w[1])).add(means[2].mul(w[2])).add(means[3].mul(w[3])).add(vec3(0.75, 0.77, 0.8).mul(w[4]))
      .add(means[5].mul(w[5])).add(means[6].mul(w[6])).add(means[7].mul(w[7])).div(wSum).mul(n1.a.mul(0.4).add(0.8));
    const macro = mix(mix(macroProc, macroFar, hasLC), macroCore, cw).toVar();

    // distant cliffs: the top-down photo is stretched on steep faces -> large-scale triplanar rock, photo-tinted
    const farCliff = smoothstep(uCliff.add(0.05), uCliff.add(0.2), slope).mul(float(1).sub(nearW)).toVar();
    If(farCliff.greaterThan(0.01), () => {
      const inv = 1 / 45;
      const sA = (uv: any, gx: any, gy: any) => texture(tx.albedoArray, uv).depth(int(3) as any).grad(gx, gy).rgb;
      const c = sA(p.zy.mul(inv), dx.zy.mul(inv), dy.zy.mul(inv)).mul(tb.x)
        .add(sA(p.xz.mul(inv), dx.xz.mul(inv), dy.xz.mul(inv)).mul(tb.y))
        .add(sA(p.xy.mul(inv), dx.xy.mul(inv), dy.xy.mul(inv)).mul(tb.z));
      const macroLum = macro.dot(vec3(0.2126, 0.7152, 0.0722));
      const cliffLum = means[3].dot(vec3(0.2126, 0.7152, 0.0722));
      const rockCol = c.mul(macroLum.div(cliffLum)).mul(0.9);
      macro.assign(mix(macro, rockCol, farCliff.mul(0.85)));
    });

    const tint = clamp(macro.div(max(detailMean, vec3(0.01))), 0.2, 5);
    const near = detailA.mul(mix(vec3(1), tint, uTint));
    const albedo = mix(macro, near, nearW.mul(has.select(float(1), float(0)))).toVar();

    const nWorld = normalize(has.select(mix(nM, accN.mul(invW), nearW), nM)).toVar();
    const rough = has.select(accR.mul(invW), float(0.9)).toVar();
    const ao = has.select(mix(float(1), accAO.mul(invW), nearW), float(1)).toVar();

    // water: dark body colour, glossy, two scrolling ripple layers; sky reflection added as emissive (Fresnel)
    const waterW = smoothstep(0.2, 0.8, water).toVar();
    If(waterW.greaterThan(0.001), () => {
      const r1 = texture(tx.noise, p.xz.div(23).add(vec2(time.mul(0.011), time.mul(0.007)))).rg;
      const r2 = texture(tx.noise, p.xz.div(7.1).sub(vec2(time.mul(0.019), time.mul(-0.013)))).ba;
      const fadeRip = float(1).sub(smoothstep(200, 3000, dist));
      const rip = r1.add(r2).sub(1).mul(0.09).mul(fadeRip);
      albedo.assign(mix(albedo, macro.mul(0.35), waterW));
      nWorld.assign(normalize(mix(nWorld, normalize(vec3(rip.x, 1, rip.y)), waterW)));
      rough.assign(mix(rough, float(0.05), waterW));
      ao.assign(mix(ao, float(1), waterW));
    });
    pWater.assign(waterW);

    pNormal.assign(nWorld);
    pRough.assign(rough);
    pAO.assign(ao);
    return vec4(albedo, 1);
  })();
  mat.normalNode = transformNormalToView(pNormal);
  // sky reflection on water (late-bound: the atmosphere is initialised after the terrain)
  (mat as any).emissiveNode = Fn(() => {
    const out = vec3(0).toVar();
    If(pWater.greaterThan(0.001), () => {
      if (!terrainHooks.sky) return;
      const v = normalize(positionWorld.sub(cameraPosition));
      const r = reflect(v, pNormal);
      const rr = vec3(r.x, max(r.y, 0.01), r.z).normalize();
      const cosT = clamp(dot(v.negate(), pNormal), 0, 1);
      const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), 5)));
      out.assign(terrainHooks.sky(rr).mul(F).mul(pWater));
    });
    return out;
  })();
  mat.roughnessNode = pRough;
  mat.aoNode = pAO;
  mat.metalnessNode = float(0);
}
