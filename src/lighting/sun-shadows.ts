// Sun visibility = near cascaded shadow maps (trees, aircraft, props within ~150 m) x heightfield shadows
// (mountains + forest canopy, to the horizon). The terrain itself never renders into the shadow maps.
import * as THREE from 'three/webgpu';
import { Fn, float, uniform, mix } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { settings } from '../core/settings';
import type { TerrainShadows } from './terrain-shadows';

export const sunShadowSettings = settings.group('sunShadows', 'Ombres proches', {
  enabled: { value: true, label: 'Ombres portées proches' },
  distance: { value: 150, min: 40, max: 400, step: 10, label: 'Portée cascades (m)' },
  mapSize: { value: 2048, options: { '1024': 1024, '2048': 2048, '4096': 4096 }, label: 'Résolution' },
});

export function setupSunShadows(renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, terrainShadows: TerrainShadows) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  sun.castShadow = true;
  sun.shadow.mapSize.set(sunShadowSettings.mapSize, sunShadowSettings.mapSize);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 1200;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  const csm = new CSMShadowNode(sun, { cascades: 2, maxFar: sunShadowSettings.distance, mode: 'practical', lightMargin: 200 });
  csm.fade = true;
  const uCSM = uniform(sunShadowSettings.enabled ? 1 : 0);
  const combined = Fn(() => {
    const hf = terrainShadows.shadowNode;
    return mix(float(1), (csm as any).x, uCSM).mul(hf);
  })();
  (sun.shadow as any).shadowNode = combined;
  settings.on('sunShadows.enabled', (v) => {
    uCSM.value = v ? 1 : 0;
    // stop rendering the cascade maps when disabled
    for (const l of (csm as any).lights) l.shadow.autoUpdate = !!v;
  });
  settings.on('sunShadows.distance', (v) => {
    csm.maxFar = v as number;
    csm.updateFrustums();
  });
  return csm;
}
