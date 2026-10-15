// Sun visibility = near cascaded shadow maps (trees, aircraft, props within ~150 m) x heightfield shadows
// (mountains + forest canopy, to the horizon). The terrain itself never renders into the shadow maps.
import * as THREE from 'three/webgpu';
import { Fn, float, uniform, mix, positionWorld } from 'three/tsl';
import type { Clouds } from '../sky/clouds';
import { usesVertexLighting, vlSunVis } from './vertex-lighting';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { settings } from '../core/settings';
import { adaptive } from '../core/adaptive';
import type { TerrainShadows } from './terrain-shadows';

export const sunShadowSettings = settings.group('sunShadows', 'Near shadows', {
  enabled: { value: true, label: 'Near cast shadows' },
  distance: { value: 150, min: 40, max: 400, step: 10, label: 'Cascade range (m)' },
  mapSize: { value: 2048, options: { '1024': 1024, '2048': 2048, '4096': 4096 }, label: 'Resolution' },
  alternateUnderLoad: { value: true, label: 'Alternate cascades under load', hidden: true },
});

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
  const csm = new CSMShadowNode(sun, { cascades: 2, maxFar: sunShadowSettings.distance, mode: 'practical', lightMargin: 200 });
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
