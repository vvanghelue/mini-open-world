// Sun visibility = near cascaded shadow maps (trees, aircraft, props within ~150 m) x heightfield shadows
// (mountains + forest canopy, to the horizon). The terrain itself never renders into the shadow maps.
import * as THREE from 'three/webgpu';
import { Fn, float, uniform, mix, positionWorld } from 'three/tsl';
import type { Clouds } from '../sky/clouds';
import { usesVertexLighting, vlSunVis } from './vertex-lighting';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { CSMFrustum } from 'three/addons/csm/CSMFrustum.js';
import { settings } from '../core/settings';
import { adaptive } from '../core/adaptive';
import type { TerrainShadows } from './terrain-shadows';

export const sunShadowSettings = settings.group('sunShadows', 'Near shadows', {
  enabled: { value: true, label: 'Near cast shadows' },
  distance: { value: 150, min: 40, max: 400, step: 10, label: 'Cascade range (m)' },
  mapSize: { value: 2048, options: { '1024': 1024, '2048': 2048, '4096': 4096 }, label: 'Resolution' },
  alternateUnderLoad: { value: true, label: 'Alternate cascades under load', hidden: true },
});

/** Sun rotation (degrees) that triggers a re-orientation of the cascades. */
const DIRECTION_STEP_DEG = 0.12;

const _dir = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _rotInv = new THREE.Matrix4();
const _toLight = new THREE.Matrix4();
const _translate = new THREE.Matrix4();
const _center = new THREE.Vector3();
const _box = new THREE.Box3();
const _lsFrustum = new CSMFrustum();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * CSM with shadow maps that stay fixed in world space while the sun moves. three's CSMShadowNode snaps each cascade
 * to its texel grid in a light frame centred on the world origin, re-oriented to the exact sun direction every frame:
 * with the clock running (time.speed 30) that frame turns by ~0.002 deg per frame, which slides the texel grid by
 * several centimetres (> 1 texel) at a few km from the origin, so every caster was re-rasterised at a new sub-texel
 * offset each frame and foliage / object shadows shimmered. Here the light frame keeps its orientation until the sun
 * has turned by DIRECTION_STEP_DEG (~1 s at the default clock speed) and is then rebuilt around the camera, so camera
 * motion only moves the cascades by whole texels and the sun only causes a small step now and then (the real
 * shadow displacement over one step is below one texel near the camera; the TAA blends the step).
 */
class StableCSMShadowNode extends (CSMShadowNode as unknown as new (light: THREE.DirectionalLight, data: object) => any) {
  private shadowDir = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private oriented = false;

  updateBefore() {
    const self = this as any;
    const light = self.light as THREE.DirectionalLight;
    const camera = self.camera as THREE.Camera;
    for (const lw of self.lights) {
      if (lw.parent === null) {
        light.parent!.add(lw.target);
        light.parent!.add(lw);
      }
    }
    _dir.subVectors(light.target.position, light.position).normalize();
    if (!this.oriented || _dir.dot(this.shadowDir) < Math.cos(THREE.MathUtils.degToRad(DIRECTION_STEP_DEG))) {
      this.oriented = true;
      this.shadowDir.copy(_dir);
      this.pivot.setFromMatrixPosition(camera.matrixWorld).round();
      _rot.lookAt(_origin, this.shadowDir, _up);
      _rotInv.copy(_rot).invert();
    }
    // light frame: fixed rotation around a fixed pivot (world -> light: R^-1 * (p - pivot))
    _toLight.copy(_rotInv).multiply(_translate.makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z)).multiply(camera.matrixWorld);
    for (let i = 0; i < self.frustums.length; i++) {
      const lw = self.lights[i];
      const shadow = lw.shadow;
      const cam = shadow.camera;
      const texelW = (cam.right - cam.left) / shadow.mapSize.width;
      const texelH = (cam.top - cam.bottom) / shadow.mapSize.height;
      self.frustums[i].toSpace(_toLight, _lsFrustum);
      _box.makeEmpty();
      for (let j = 0; j < 4; j++) {
        _box.expandByPoint(_lsFrustum.vertices.near[j]);
        _box.expandByPoint(_lsFrustum.vertices.far[j]);
      }
      _box.getCenter(_center);
      _center.z = _box.max.z + self.lightMargin;
      _center.x = Math.floor(_center.x / texelW) * texelW;
      _center.y = Math.floor(_center.y / texelH) * texelH;
      _center.applyMatrix4(_rot).add(this.pivot);
      lw.position.copy(_center);
      lw.target.position.copy(_center).add(this.shadowDir);
      lw.updateMatrixWorld();
      lw.target.updateMatrixWorld();
    }
  }
}

export function setupSunShadows(renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, terrainShadows: TerrainShadows, clouds: Clouds | null = null) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  sun.castShadow = true;
  sun.shadow.mapSize.set(sunShadowSettings.mapSize, sunShadowSettings.mapSize);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 1200;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  // shadow cameras see layer 1 too (shadow-only proxy meshes, e.g. LOD1 stand-ins for LOD0 trees)
  sun.shadow.camera.layers.enable(1);
  const csm = new StableCSMShadowNode(sun, { cascades: 2, maxFar: sunShadowSettings.distance, mode: 'practical', lightMargin: 200 });
  csm.fade = true;
  const uCSM = uniform(sunShadowSettings.enabled ? 1 : 0);
  const combined = Fn((builder: any) => {
    const near = mix(float(1), (csm as any).x, uCSM);
    // vegetation evaluates heightfield + cloud visibility per vertex (see lighting/vertex-lighting.ts)
    if (usesVertexLighting(builder)) return near.mul(vlSunVis());
    const hf = terrainShadows.shadowNode;
    const cl = clouds ? clouds.shadowAt(positionWorld) : float(1);
    return near.mul(hf).mul(cl);
  })();
  (sun.shadow as any).shadowNode = combined;
  settings.on('sunShadows.enabled', (v) => {
    uCSM.value = v ? 1 : 0;
  });
  settings.on('sunShadows.distance', (v) => {
    csm.maxFar = v as number;
    csm.updateFrustums();
  });
  return csm;
}

/**
 * Per-frame cascade update schedule. Every cascade re-renders all casters (~20 objects, ~40 us of three.js JS each),
 * so under load (adaptive detail < 0.5) the cascades are refreshed on alternate frames. A cascade that is not
 * refreshed keeps both its map and its matrix (three updates the shadow matrix only when rendering), so its shadows
 * stay consistent in world space, one frame old.
 */
export function scheduleSunShadows(csm: any, frame: number) {
  const lights = csm.lights as any[];
  if (!lights?.length) return;
  const on = sunShadowSettings.enabled;
  const alternate = on && sunShadowSettings.alternateUnderLoad && adaptive.quality < 0.5;
  for (let i = 0; i < lights.length; i++) {
    const sh = lights[i].shadow;
    sh.autoUpdate = on && !alternate;
    if (alternate && frame % lights.length === i) sh.needsUpdate = true;
  }
}
