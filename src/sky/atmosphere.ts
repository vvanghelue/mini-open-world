// Physically based atmosphere (Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique").
//  - transmittance LUT (256x64) and multiple-scattering LUT (32x32): computed when atmosphere parameters change
//  - sky-view LUT (256x128, absolute azimuth, sun + moon) and aerial-perspective froxels (32^3): every frame
//  - sky background (LUT + sun/moon disks + stars), aerial perspective applied to all lit materials via scene.fogNode
//  - analytic auto-exposure with pre-exposed lighting (keeps fp16 render targets in range from noon to night)
//  - sets the main directional light (sun, or moon at night) and a sky-irradiance LightProbe (SH9 via async readback)
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec2, vec3, vec4, float, int, uvec2, uvec3, instanceIndex, texture, texture3D, textureStore, Loop, If,
  exp, sqrt, max, min, dot, length, normalize, clamp, mix, cos, acos, atan, abs, select, positionLocal, positionWorld,
  cameraPosition, screenUV, output, smoothstep, pow, fract, sin, floor, storage, time,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import type { TimeOfDay } from './time-of-day';
import { SkyLight, registerSkyLight } from './sky-light';
import {
  R_GROUND, R_TOP, RAYLEIGH_SCATTERING, RAYLEIGH_SCALE_HEIGHT, MIE_SCATTERING, MIE_EXTINCTION, MIE_SCALE_HEIGHT,
  OZONE_ABSORPTION, SUN_ILLUMINANCE, SUN_ANGULAR_RADIUS, MOON_ANGULAR_RADIUS, MOON_ILLUMINANCE, transmittanceCPU,
  skyIlluminanceLux,
} from './atmosphere-model';

export const atmoSettings = settings.group('atmo', 'Atmosphère & lumière', {
  haze: { value: 1.0, min: 0, max: 8, step: 0.05, label: 'Brume (aérosols)' },
  rayleigh: { value: 1.0, min: 0.2, max: 3, step: 0.05, label: 'Diffusion Rayleigh' },
  mieG: { value: 0.8, min: 0.5, max: 0.95, step: 0.01, label: 'Anisotropie brume' },
  ozone: { value: 1.0, min: 0, max: 3, step: 0.05, label: 'Ozone' },
  groundAlbedo: { value: 0.2, min: 0, max: 0.6, step: 0.01, label: 'Albédo sol' },
  exposureEV: { value: 0, min: -4, max: 4, step: 0.1, label: 'Exposition (EV)' },
  nightAdaptation: { value: 0.25, min: 0.01, max: 50, step: 0.01, label: 'Adaptation nuit (lux)', help: 'Plus bas = nuits plus lumineuses (œil adapté).' },
  adaptSpeed: { value: 1.5, min: 0.1, max: 10, step: 0.1, label: 'Vitesse adaptation' },
  stars: { value: 1.0, min: 0, max: 5, step: 0.05, label: 'Étoiles' },
  aerialPerspective: { value: 1.0, min: 0, max: 3, step: 0.05, label: 'Perspective aérienne' },
  sunIntensity: { value: 1.0, min: 0, max: 3, step: 0.05, label: 'Intensité soleil' },
  ambient: { value: 1.0, min: 0, max: 3, step: 0.05, label: 'Lumière du ciel' },
});

const TRANS_W = 256, TRANS_H = 64;
const MS_RES = 32;
const SKY_W = 256, SKY_H = 128;
const AP_RES = 32, AP_SLICES = 32;
export const AP_MAX_KM = 120;
const SH_W = 32, SH_H = 16;
/** Night-sky floor (airglow + starlight + a bit of artistic light pollution), lux. */
const AIRGLOW_LUX = 0.004;
const AIRGLOW_RADIANCE = AIRGLOW_LUX / Math.PI;

function storageTex(w: number, h: number, repeatU = false) {
  const t = new THREE.StorageTexture(w, h);
  t.type = THREE.HalfFloatType;
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = repeatU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

function storage3D(w: number, h: number, d: number) {
  const t = new THREE.Storage3DTexture(w, h, d);
  t.type = THREE.HalfFloatType;
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

export class Atmosphere implements System {
  readonly name = 'atmosphere';
  readonly sunLight = new THREE.DirectionalLight(0xffffff, 1);
  readonly skyLight = new SkyLight();
  /** Current pre-exposure (scene radiance multiplier). */
  preExposure = 5e-5;
  /** Linear RGB irradiance (lux, unexposed) of the main light at the camera, for other systems. */
  readonly mainLightColor = new THREE.Color();
  mainIsMoon = false;

  // LUTs
  readonly transLUT = storageTex(TRANS_W, TRANS_H);
  readonly msLUT = storageTex(MS_RES, MS_RES);
  readonly skyLUT = storageTex(SKY_W, SKY_H, true);
  readonly apScatter = storage3D(AP_RES, AP_RES, AP_SLICES);
  readonly apTrans = storage3D(AP_RES, AP_RES, AP_SLICES);

  // uniforms
  private uRayleigh = uniform(new THREE.Vector3());
  private uMieScat = uniform(MIE_SCATTERING);
  private uMieExt = uniform(MIE_EXTINCTION);
  private uOzone = uniform(new THREE.Vector3());
  private uMieG = uniform(0.8);
  private uGroundAlbedo = uniform(0.2);
  private uCamR = uniform(R_GROUND + 1); // camera distance to planet centre (km)
  private uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  private uMoonDir = uniform(new THREE.Vector3(0, -1, 0));
  private uSunE = uniform(1); // pre-exposed illuminance (TOA)
  private uMoonE = uniform(0);
  private uPreExp = uniform(1);
  private uStars = uniform(1);
  private uAP = uniform(1);
  private uMoonPhaseVec = uniform(new THREE.Vector3()); // sun direction for moon shading
  private uCorners = [0, 1, 2, 3].map(() => uniform(new THREE.Vector3()));

  private computeTrans!: THREE.ComputeNode;
  private computeMS!: THREE.ComputeNode;
  private computeSky!: THREE.ComputeNode;
  private computeAP!: THREE.ComputeNode;
  private computeSH!: THREE.ComputeNode;
  private shBuffer!: THREE.StorageBufferAttribute;
  private shNode: any;
  private sunTransLum = 1;
  private lutDirty = true;
  private engine!: Engine;
  private _v = new THREE.Vector3();
  private _t = [0, 0, 0];

  /** TSL: sky radiance (pre-exposed) for a world direction, without sun/moon disks. */
  skyNode!: (dir: any) => any;
  /** TSL: transmittance (rgb) from the camera towards a world direction (to space). */
  transmittanceToSpace!: (dir: any) => any;

  constructor(private time: TimeOfDay) {}

  init(engine: Engine) {
    this.engine = engine;
    registerSkyLight(engine.renderer);
    this.buildShaders();
    this.skyLight.shNode = this.shNode;
    const scene = engine.scene;
    this.sunLight.castShadow = false;
    scene.add(this.sunLight, this.sunLight.target, this.skyLight);
    scene.background = null;
    scene.backgroundNode = this.backgroundNode();
    scene.fogNode = this.fogNode();

    for (const k of ['atmo.haze', 'atmo.rayleigh', 'atmo.ozone', 'atmo.groundAlbedo']) settings.on(k, () => (this.lutDirty = true));
    this.updateParams();
  }

  private updateParams() {
    const s = atmoSettings;
    this.uRayleigh.value.set(RAYLEIGH_SCATTERING[0], RAYLEIGH_SCATTERING[1], RAYLEIGH_SCATTERING[2]).multiplyScalar(s.rayleigh);
    this.uMieScat.value = MIE_SCATTERING * s.haze;
    this.uMieExt.value = MIE_EXTINCTION * s.haze;
    this.uOzone.value.set(OZONE_ABSORPTION[0], OZONE_ABSORPTION[1], OZONE_ABSORPTION[2]).multiplyScalar(s.ozone);
    this.uGroundAlbedo.value = s.groundAlbedo;
  }

  // ------------------------------------------------------------------ shaders
  private buildShaders() {
    const uR = this.uRayleigh, uMs = this.uMieScat, uMe = this.uMieExt, uO = this.uOzone;
    const Rg = float(R_GROUND), Rt = float(R_TOP);
    const H = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);

    // medium at altitude h (km above ground radius): returns scattering R (vec3), scattering M (float), extinction (vec3)
    const medium = (h: any) => {
      const dR = exp(h.negate().div(RAYLEIGH_SCALE_HEIGHT));
      const dM = exp(h.negate().div(MIE_SCALE_HEIGHT));
      const dO = max(float(0), float(1).sub(abs(h.sub(25)).div(15)));
      const scatR = uR.mul(dR);
      const scatM = uMs.mul(dM);
      const ext = scatR.add(uMe.mul(dM)).add(uO.mul(dO));
      return { scatR, scatM, ext };
    };

    // nearest positive intersection of ray with sphere centred at origin, -1 if none
    const raySphere = Fn(([ro, rd, radius]: [any, any, any]) => {
      const b = dot(ro, rd);
      const c = dot(ro, ro).sub(radius.mul(radius));
      const disc = b.mul(b).sub(c);
      const s = sqrt(max(disc, 0));
      const t0 = b.negate().sub(s);
      const t1 = b.negate().add(s);
      return select(disc.lessThan(0), float(-1), select(t0.greaterThan(0), t0, select(t1.greaterThan(0), t1, float(-1))));
    });

    const transUV = Fn(([r, mu]: [any, any]) => {
      const rho = sqrt(max(r.mul(r).sub(R_GROUND * R_GROUND), 0));
      const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(R_TOP * R_TOP);
      const d = max(float(0), r.negate().mul(mu).add(sqrt(max(disc, 0))));
      const dMin = Rt.sub(r);
      const dMax = rho.add(H);
      const xMu = d.sub(dMin).div(dMax.sub(dMin));
      const xR = rho.div(H);
      return vec2(xMu, xR);
    });
    const sampleTrans = (r: any, mu: any) => texture(this.transLUT, transUV(r, mu)).level(float(0)).rgb;
    const sampleMS = (r: any, mu: any) => {
      const u = clamp(mu.mul(0.5).add(0.5), 0, 1);
      const v = clamp(r.sub(R_GROUND).div(R_TOP - R_GROUND), 0, 1);
      // keep samples inside texel centres
      const uv = vec2(u, v).mul((MS_RES - 1) / MS_RES).add(0.5 / MS_RES);
      return texture(this.msLUT, uv).level(float(0)).rgb;
    };

    const phaseR = (c: any) => float(3 / (16 * Math.PI)).mul(c.mul(c).add(1));
    const phaseM = (c: any) => {
      const g = this.uMieG;
      const g2 = g.mul(g);
      const k = float(3 / (8 * Math.PI)).mul(float(1).sub(g2)).div(g2.add(2));
      return k.mul(c.mul(c).add(1)).div(pow(max(g2.add(1).sub(g.mul(2).mul(c)), 1e-4), 1.5));
    };

    // ---------- transmittance LUT
    this.computeTrans = Fn(() => {
      const x = instanceIndex.mod(TRANS_W);
      const y = instanceIndex.div(TRANS_W);
      const uv = vec2(float(x).add(0.5).div(TRANS_W), float(y).add(0.5).div(TRANS_H));
      const rho = uv.y.mul(H);
      const r = sqrt(rho.mul(rho).add(R_GROUND * R_GROUND));
      const dMin = Rt.sub(r);
      const dMax = rho.add(H);
      const d = dMin.add(uv.x.mul(dMax.sub(dMin)));
      const mu = select(d.lessThan(1e-4), float(1), float(H * H).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(2).mul(d)));
      const ro = vec3(0, r, 0);
      const rd = vec3(sqrt(max(float(1).sub(mu.mul(mu)), 0)), mu, 0);
      const tMax = raySphere(ro, rd, Rt);
      const od = vec3(0).toVar();
      const N = 40;
      Loop(N, ({ i }: any) => {
        const t = float(i).add(0.5).div(N).mul(tMax);
        const h = length(ro.add(rd.mul(t))).sub(R_GROUND);
        od.addAssign(medium(h).ext.mul(tMax.div(N)));
      });
      textureStore(this.transLUT, uvec2(x, y), vec4(exp(od.negate()), 1)).toWriteOnly();
    })().compute(TRANS_W * TRANS_H).setName('atmoTransmittance');

    // ---------- multiple scattering LUT (Hillaire 2020, sec. 5.5)
    this.computeMS = Fn(() => {
      const x = instanceIndex.mod(MS_RES);
      const y = instanceIndex.div(MS_RES);
      const cosSun = float(x).add(0.5).div(MS_RES).mul(2).sub(1);
      const r = Rg.add(float(y).add(0.5).div(MS_RES).mul(R_TOP - R_GROUND)).add(0.001);
      const sunDir = vec3(sqrt(max(float(1).sub(cosSun.mul(cosSun)), 0)), cosSun, 0);
      const ro = vec3(0, r, 0);
      const Lsum = vec3(0).toVar();
      const Fsum = vec3(0).toVar();
      const ND = 8;
      Loop({ start: 0, end: ND, name: 'di' } as any, ({ di: i }: any) => {
        Loop({ start: 0, end: ND, name: 'dj' } as any, ({ dj: j }: any) => {
          const ct = float(1).sub(float(i).add(0.5).div(ND).mul(2));
          const st = sqrt(max(float(1).sub(ct.mul(ct)), 0));
          const ph = float(j).add(0.5).div(ND).mul(2 * Math.PI);
          const rd = vec3(st.mul(cos(ph)), ct, st.mul(sin(ph)));
          const tGround = raySphere(ro, rd, Rg);
          const tTop = raySphere(ro, rd, Rt);
          const hitsGround = tGround.greaterThan(0);
          const tMax = select(hitsGround, tGround, tTop);
          const L = vec3(0).toVar();
          const F = vec3(0).toVar();
          const thr = vec3(1).toVar();
          const NS = 20;
          Loop({ start: 0, end: NS, name: 'sk' } as any, ({ sk: k }: any) => {
            const dt = tMax.div(NS);
            const t = float(k).add(0.5).mul(dt);
            const P = ro.add(rd.mul(t));
            const pr = length(P);
            const m = medium(pr.sub(R_GROUND));
            const sampleT = exp(m.ext.negate().mul(dt));
            const up = P.div(pr);
            const mu = dot(up, sunDir);
            const shadow = select(raySphere(P, sunDir, Rg).greaterThan(0), float(0), float(1));
            const Tsun = sampleTrans(pr, mu);
            const scat = m.scatR.add(m.scatM);
            const S = Tsun.mul(shadow).mul(scat).mul(1 / (4 * Math.PI));
            const Sint = S.sub(S.mul(sampleT)).div(m.ext);
            const Fint = scat.sub(scat.mul(sampleT)).div(m.ext);
            L.addAssign(thr.mul(Sint));
            F.addAssign(thr.mul(Fint));
            thr.mulAssign(sampleT);
          });
          If(hitsGround, () => {
            const P = ro.add(rd.mul(tGround));
            const up = normalize(P);
            const mu = dot(up, sunDir);
            const Tsun = sampleTrans(length(P), mu);
            L.addAssign(thr.mul(Tsun).mul(max(mu, 0)).mul(this.uGroundAlbedo).mul(1 / Math.PI));
          });
          Lsum.addAssign(L);
          Fsum.addAssign(F);
        });
      });
      const n = ND * ND;
      const L2 = Lsum.div(n);
      const fms = Fsum.div(n);
      const psi = L2.div(float(1).sub(fms));
      textureStore(this.msLUT, uvec2(x, y), vec4(psi, 1)).toWriteOnly();
    })().compute(MS_RES * MS_RES).setName('atmoMultiScattering');

    // ---------- shared single+multi scattering integrator (sun + moon), returns { L, T } (pre-exposed L)
    const integrate = (ro: any, rd: any, tMax: any, N: number) => {
      const L = vec3(0).toVar();
      const thr = vec3(1).toVar();
      const tPrev = float(0).toVar();
      const cS = dot(rd, this.uSunDir);
      const cM = dot(rd, this.uMoonDir);
      const pRS = phaseR(cS), pMS = phaseM(cS), pRM = phaseR(cM), pMM = phaseM(cM);
      Loop(N, ({ i }: any) => {
        const f = float(i).add(1).div(N);
        // TSL expressions are lazy: freeze values before mutating tPrev
        const tNew = tMax.mul(f.mul(f)).toVar();
        const dt = tNew.sub(tPrev).toVar();
        const t = tPrev.add(dt.mul(0.3)).toVar();
        tPrev.assign(tNew);
        const P = ro.add(rd.mul(t));
        const pr = length(P);
        const m = medium(pr.sub(R_GROUND));
        const sampleT = exp(m.ext.negate().mul(dt));
        const up = P.div(pr);
        const muS = dot(up, this.uSunDir);
        const muM = dot(up, this.uMoonDir);
        const shS = select(raySphere(P, this.uSunDir, Rg).greaterThan(0), float(0), float(1));
        const shM = select(raySphere(P, this.uMoonDir, Rg).greaterThan(0), float(0), float(1));
        const scat = m.scatR.add(m.scatM);
        const sSun = sampleTrans(pr, muS).mul(shS).mul(m.scatR.mul(pRS).add(m.scatM.mul(pMS))).add(sampleMS(pr, muS).mul(scat)).mul(this.uSunE);
        const sMoon = sampleTrans(pr, muM).mul(shM).mul(m.scatR.mul(pRM).add(m.scatM.mul(pMM))).add(sampleMS(pr, muM).mul(scat)).mul(this.uMoonE);
        const S = sSun.add(sMoon);
        L.addAssign(thr.mul(S.sub(S.mul(sampleT)).div(m.ext)));
        thr.mulAssign(sampleT);
      });
      return { L, T: thr };
    };

    // sky-view LUT parametrisation (absolute azimuth, horizon-concentrated zenith)
    const skyHorizon = () => {
      const r = this.uCamR;
      const vH = sqrt(max(r.mul(r).sub(R_GROUND * R_GROUND), 0));
      const beta = acos(clamp(vH.div(r), -1, 1));
      return { beta, zha: float(Math.PI).sub(beta) };
    };

    this.computeSky = Fn(() => {
      const x = instanceIndex.mod(SKY_W);
      const y = instanceIndex.div(SKY_W);
      const u = float(x).add(0.5).div(SKY_W);
      const v = float(y).add(0.5).div(SKY_H);
      const { beta, zha } = skyHorizon();
      const za = float(0).toVar();
      If(v.lessThan(0.5), () => {
        const c = float(1).sub(v.mul(2));
        za.assign(zha.mul(float(1).sub(c.mul(c))));
      }).Else(() => {
        const c = v.mul(2).sub(1);
        za.assign(zha.add(beta.mul(c.mul(c))));
      });
      const az = u.mul(2 * Math.PI);
      const sz = sin(za);
      const rd = vec3(sz.mul(sin(az)), cos(za), sz.mul(cos(az)).negate());
      const ro = vec3(0, this.uCamR, 0);
      const tG = raySphere(ro, rd, Rg);
      const tT = raySphere(ro, rd, Rt);
      const tMax = select(tG.greaterThan(0), tG, tT);
      const { L } = integrate(ro, rd, max(tMax, 0), 32);
      textureStore(this.skyLUT, uvec2(x, y), vec4(L, 1)).toWriteOnly();
    })().compute(SKY_W * SKY_H).setName('atmoSkyView');

    // aerial perspective froxels (screen-aligned, quadratic depth slices up to AP_MAX_KM)
    const corners = this.uCorners;
    this.computeAP = Fn(() => {
      const x = instanceIndex.mod(AP_RES);
      const y = instanceIndex.div(AP_RES).mod(AP_RES);
      const z = instanceIndex.div(AP_RES * AP_RES);
      const u = float(x).add(0.5).div(AP_RES);
      const v = float(y).add(0.5).div(AP_RES);
      const rd = normalize(mix(mix(corners[0], corners[1], u), mix(corners[2], corners[3], u), v));
      const w = float(z).add(0.5).div(AP_SLICES);
      const dist = w.mul(w).mul(AP_MAX_KM);
      const ro = vec3(0, this.uCamR, 0);
      const tG = raySphere(ro, rd, Rg);
      const tMax = select(tG.greaterThan(0), min(tG, dist), dist);
      const { L, T } = integrate(ro, rd, tMax, 12);
      textureStore(this.apScatter, uvec3(x, y, z), vec4(L, 1)).toWriteOnly();
      textureStore(this.apTrans, uvec3(x, y, z), vec4(T, 1)).toWriteOnly();
    })().compute(AP_RES * AP_RES * AP_SLICES).setName('atmoAerialPerspective');

    // sky LUT lookup for a direction (pre-exposed)
    const sampleSky = Fn(([dir]: [any]) => {
      const { beta, zha } = skyHorizon();
      const za = acos(clamp(dir.y, -1, 1));
      const below = za.greaterThan(zha);
      const vAbove = float(1).sub(sqrt(max(float(1).sub(za.div(zha)), 0))).mul(0.5);
      const vBelow = sqrt(clamp(za.sub(zha).div(beta), 0, 1)).mul(0.5).add(0.5);
      const v = select(below, vBelow, vAbove);
      const u = fract(atan(dir.x, dir.z.negate()).div(2 * Math.PI).add(1));
      return texture(this.skyLUT, vec2(u, clamp(v, 0.5 / SKY_H, 1 - 0.5 / SKY_H))).rgb;
    });
    this.skyNode = sampleSky;
    this.transmittanceToSpace = (dir: any) => sampleTrans(this.uCamR, dir.y);

    // Sky irradiance SH9: thread k integrates coefficient k over SH_W x SH_H directions (k = 9: horizontal irradiance).
    this.shBuffer = new THREE.StorageBufferAttribute(new Float32Array(10 * 4), 4);
    const shStore = storage(this.shBuffer, 'vec4', 10);
    this.shNode = storage(this.shBuffer, 'vec4', 10).toReadOnly();
    const skyRadianceAt = (dir: any) => {
      const c = sampleSky(dir).toVar();
      c.addAssign(vec3(0.6, 0.75, 1.0).mul(this.uPreExp).mul(AIRGLOW_RADIANCE).mul(smoothstep(-0.05, 0.3, dir.y)));
      // ground below horizon: diffuse reflection of sun + moon light (rough one-bounce)
      If(dir.y.lessThan(0), () => {
        const sunT = sampleTrans(this.uCamR, this.uSunDir.y).mul(max(this.uSunDir.y, 0)).mul(this.uSunE);
        const moonT = sampleTrans(this.uCamR, this.uMoonDir.y).mul(max(this.uMoonDir.y, 0)).mul(this.uMoonE);
        c.addAssign(sunT.add(moonT).mul(this.uGroundAlbedo).mul(1 / Math.PI).mul(0.6));
      });
      return c;
    };
    this.computeSH = Fn(() => {
      const k = instanceIndex;
      const acc = vec3(0).toVar();
      const wsum = float(0).toVar();
      Loop({ start: 0, end: SH_H, name: 'sy' } as any, ({ sy }: any) => {
        Loop({ start: 0, end: SH_W, name: 'sx' } as any, ({ sx }: any) => {
          const az = float(sx).add(0.5).div(SH_W).mul(2 * Math.PI);
          const za = float(sy).add(0.5).div(SH_H).mul(Math.PI);
          const sz = sin(za);
          const x = sz.mul(sin(az)), y = cos(za), z = sz.mul(cos(az)).negate();
          const dir = vec3(x, y, z);
          const L = skyRadianceAt(dir);
          const w = sz;
          // real SH basis (three.js convention) selected by k; k = 9 -> cosine lobe around +Y
          const b = select(k.equal(0), float(0.282095),
            select(k.equal(1), y.mul(0.488603),
            select(k.equal(2), z.mul(0.488603),
            select(k.equal(3), x.mul(0.488603),
            select(k.equal(4), x.mul(y).mul(1.092548),
            select(k.equal(5), y.mul(z).mul(1.092548),
            select(k.equal(6), z.mul(z).mul(3).sub(1).mul(0.315392),
            select(k.equal(7), x.mul(z).mul(1.092548),
            select(k.equal(8), x.mul(x).sub(y.mul(y)).mul(0.546274),
            max(y, 0))))))))));
          acc.addAssign(L.mul(b).mul(w));
          wsum.addAssign(w);
        });
      });
      shStore.element(k).assign(vec4(acc.mul(float(4 * Math.PI).div(wsum)), 1));
    })().compute(10).setName('atmoSkySH');
  }

  /** Background: sky LUT + sun & moon disks + stars. */
  private backgroundNode() {
    return Fn(() => {
      const dir = normalize(positionLocal);
      const col = this.skyNode(dir).toVar();
      const T = this.transmittanceToSpace(dir);
      // sun disk with limb darkening
      const cSun = dot(dir, this.uSunDir);
      const ang = acos(clamp(cSun, -1, 1));
      const rS = float(SUN_ANGULAR_RADIUS);
      const inSun = float(1).sub(smoothstep(rS.mul(0.92), rS.mul(1.04), ang));
      const mu = sqrt(max(float(1).sub(ang.div(rS).pow(2)), 0));
      const limb = float(1).sub(float(0.6).mul(float(1).sub(mu)));
      const sunRad = this.uSunE.div(Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS);
      col.addAssign(min(T.mul(sunRad).mul(inSun).mul(limb), vec3(30000)));
      // moon disk, lit fraction from the sun direction
      const cMoon = dot(dir, this.uMoonDir);
      const angM = acos(clamp(cMoon, -1, 1));
      const rM = float(MOON_ANGULAR_RADIUS);
      const inMoon = float(1).sub(smoothstep(rM.mul(0.9), rM.mul(1.05), angM));
      // reconstruct moon sphere normal at this pixel
      const toCenter = this.uMoonDir;
      const offs = dir.sub(toCenter.mul(cMoon)).div(rM);
      const nz = sqrt(max(float(1).sub(dot(offs, offs)), 0));
      const nrm = normalize(offs.add(toCenter.mul(nz).negate()));
      const lit = clamp(dot(nrm, this.uMoonPhaseVec).mul(4).add(0.1), 0, 1);
      const maria = float(0.75).add(float(0.25).mul(sin(offs.x.mul(9).add(offs.y.mul(5))).mul(sin(offs.y.mul(7).sub(offs.x.mul(3))))));
      const moonRad = this.uPreExp.mul(MOON_ILLUMINANCE / (Math.PI * MOON_ANGULAR_RADIUS * MOON_ANGULAR_RADIUS) * 0.15);
      col.addAssign(T.mul(moonRad).mul(inMoon).mul(lit).mul(maria));
      // stars (procedural, cube-face cells), dimmed by transmittance; faint airglow
      col.addAssign(this.starsNode(dir).mul(T).mul(this.uPreExp).mul(this.uStars));
      col.addAssign(vec3(0.6, 0.75, 1.0).mul(this.uPreExp).mul(AIRGLOW_RADIANCE).mul(smoothstep(-0.05, 0.3, dir.y)));
      return vec4(col, 1);
    })();
  }

  private starsNode(dir: any) {
    // project to the dominant cube face, 2D cells; one star candidate per cell
    const a = abs(dir) as any;
    const face = select(a.x.greaterThan(max(a.y, a.z)), vec3(dir.y, dir.z, 1), select(a.y.greaterThan(a.z), vec3(dir.x, dir.z, 2), vec3(dir.x, dir.y, 3)));
    const m = max(a.x, max(a.y, a.z));
    const st = face.xy.div(m).mul(0.5).add(0.5).mul(380);
    const cell = floor(st);
    const hash = (p: any, s: number) => fract(sin(dot(p.add(face.z.mul(17.3).add(s)), vec2(127.1, 311.7))).mul(43758.5453));
    const h1 = hash(cell, 0.0);
    const h2 = hash(cell, 3.1);
    const h3 = hash(cell, 7.7);
    const pos = vec2(h2, h3).mul(0.7).add(0.15);
    const d = length(fract(st).sub(pos));
    const present = smoothstep(0.988, 0.992, h1);
    const mag = pow(hash(cell, 11.3), 8.0).mul(3.0).add(0.03);
    const tint = mix(vec3(1.0, 0.75, 0.55), vec3(0.7, 0.8, 1.0), hash(cell, 5.5));
    const twinkle = float(0.8).add(float(0.2).mul(sin(time.mul(3).add(h1.mul(100)))));
    const g = exp(d.mul(d).mul(-90));
    return tint.mul(present.mul(mag).mul(g).mul(twinkle).mul(60));
  }

  /** Fog node: applies aerial perspective (in-scattering + extinction) to every lit material. */
  private fogNode() {
    return Fn(() => {
      const dKm = length(positionWorld.sub(cameraPosition)).div(1000);
      const w = sqrt(clamp(dKm.div(AP_MAX_KM), 0, 1));
      const uvw = vec3(screenUV.x, screenUV.y, w);
      const S = texture3D(this.apScatter, uvw, float(0)).rgb;
      const T = texture3D(this.apTrans, uvw, float(0)).rgb;
      // fade in over the first slice to avoid a constant offset very close to the camera
      const k = clamp(w.mul(AP_SLICES * 2), 0, 1).mul(this.uAP);
      const Tk = mix(vec3(1), T, k);
      return vec4(output.rgb.mul(Tk).add(S.mul(k)), output.a);
    })();
  }

  // ------------------------------------------------------------------ per frame
  update(ctx: FrameContext) {
    const r = this.engine.renderer;
    const cam = this.engine.camera;
    const s = atmoSettings;
    if (this.lutDirty) {
      this.updateParams();
      r.compute(this.computeTrans);
      r.compute(this.computeMS);
      this.lutDirty = false;
    }
    this.uMieG.value = s.mieG;
    this.uStars.value = s.stars;
    this.uAP.value = s.aerialPerspective;

    const sun = this.time.sunDir;
    const moon = this.time.moonDir;
    this.uSunDir.value.copy(sun);
    this.uMoonDir.value.copy(moon);
    const camKm = Math.max(0.01, cam.position.y / 1000);
    this.uCamR.value = R_GROUND + camKm;

    // --- exposure (analytic estimate of horizontal illuminance)
    const sunElev = (Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1)) * 180) / Math.PI;
    const phase = this.time.moonPhase;
    const moonFrac = Math.pow((1 - Math.cos(2 * Math.PI * phase)) / 2, 1.5);
    const moonLux = MOON_ILLUMINANCE * moonFrac * Math.max(0, moon.y) * 0.8;
    transmittanceCPU(camKm, sun.y, { rayleigh: s.rayleigh, mie: s.haze, ozone: s.ozone }, this._t);
    this.sunTransLum = (0.2126 * this._t[0] + 0.7152 * this._t[1] + 0.0722 * this._t[2]) * THREE.MathUtils.smoothstep(sun.y, -0.01, 0.02);
    // horizontal illuminance: measured sky irradiance (from the SH capture) when available, else a clear-sky table
    const sunHoriz = SUN_ILLUMINANCE * s.sunIntensity * Math.max(0, sun.y);
    const lux = skyIlluminanceLux(sunElev) + sunHoriz * this.sunTransLum + moonLux + AIRGLOW_LUX;
    // sun-facing slopes receive the direct normal illuminance: expose for the brighter of both estimates
    const directNormal = SUN_ILLUMINANCE * s.sunIntensity * this.sunTransLum;
    const sceneLux = Math.max(lux, directNormal * 0.45);
    // photographic bias: keep twilight moody instead of fully adapted
    const twilight = THREE.MathUtils.smoothstep(sunElev, -13, -6) * (1 - THREE.MathUtils.smoothstep(sunElev, -1, 4));
    const target = (5 / (sceneLux + s.nightAdaptation)) * Math.pow(2, s.exposureEV - 1.2 * twilight);
    const k = ctx.dt > 0 ? 1 - Math.exp(-ctx.dt * s.adaptSpeed) : 1;
    // time jumps (slider, agent) snap the exposure instead of adapting slowly
    const jumped = Math.abs(this.time.hourDelta) > 0.2;
    if (ctx.frame < 2 || jumped) this.preExposure = target;
    else this.preExposure = Math.exp(Math.log(this.preExposure) + (Math.log(target) - Math.log(this.preExposure)) * k);
    const pe = this.preExposure;
    this.uPreExp.value = pe;
    this.uSunE.value = SUN_ILLUMINANCE * pe * s.sunIntensity;
    this.uMoonE.value = MOON_ILLUMINANCE * moonFrac * pe;
    // moon shading: direction of the sun as seen from the moon surface (approx: sun direction)
    this.uMoonPhaseVec.value.copy(sun);

    // --- frustum corner directions for the AP froxels (screen-space convention: v=0 at top)
    cam.updateMatrixWorld();
    const inv = cam.projectionMatrixInverse;
    const ndc = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
    for (let i = 0; i < 4; i++) {
      this._v.set(ndc[i][0], ndc[i][1], 0.5).applyMatrix4(inv).normalize();
      this._v.transformDirection(cam.matrixWorld);
      this.uCorners[i].value.copy(this._v);
    }

    r.compute(this.computeSky);
    r.compute(this.computeAP);

    // --- main directional light: sun by day, moon by night
    const params = { rayleigh: s.rayleigh, mie: s.haze, ozone: s.ozone };
    this.mainIsMoon = sunElev < -4 && moon.y > 0;
    const dir = this.mainIsMoon ? moon : sun;
    transmittanceCPU(camKm, dir.y, params, this._t);
    const horizonFade = THREE.MathUtils.smoothstep(dir.y, -0.01, 0.02);
    const E = (this.mainIsMoon ? MOON_ILLUMINANCE * moonFrac : SUN_ILLUMINANCE * s.sunIntensity) * horizonFade;
    this.mainLightColor.setRGB(this._t[0] * E, this._t[1] * E, this._t[2] * E);
    const maxC = Math.max(1e-9, this.mainLightColor.r, this.mainLightColor.g, this.mainLightColor.b);
    this.sunLight.color.setRGB(this.mainLightColor.r / maxC, this.mainLightColor.g / maxC, this.mainLightColor.b / maxC);
    this.sunLight.intensity = maxC * pe;
    this.sunLight.position.copy(cam.position).addScaledVector(dir, 5000);
    this.sunLight.target.position.copy(cam.position);
    this.sunLight.target.updateMatrixWorld();

    // --- sky irradiance SH (GPU, consumed directly by SkyLightNode)
    r.compute(this.computeSH);
    this.skyLight.intensity = s.ambient;
  }

  /** Debug/calibration: reads back the measured horizontal sky irradiance (absolute lux). Slow (async map). */
  async measureSkyIrradiance(): Promise<number> {
    const pe = this.preExposure;
    const buf = new Float32Array(await this.engine.renderer.getArrayBufferAsync(this.shBuffer));
    const i = 9 * 4;
    return (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / pe;
  }
}
