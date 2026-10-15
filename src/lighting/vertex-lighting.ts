// @ts-nocheck -- TSL typings incomplete
// Per-vertex lighting terms for vegetation. Slowly varying terms (heightfield + cloud sun visibility, aerial
// perspective, sky visibility) are evaluated in the vertex shader and handed to the global shadow / fog nodes
// through shader properties. Materials opt in with `material.userData.vertexLighting = true`; the global nodes
// check the material being built and read the properties instead of evaluating per fragment.
import { property, varying, float, vec2, vec3, vec4, cameraProjectionMatrix, cameraViewMatrix } from 'three/tsl';

export const lightingHooks: {
  sunVisibilityAt: ((p: any) => any) | null; // heightfield x clouds
  apAt: ((p: any, suv: any) => { S: any; T: any }) | null;
  skyVisAt: ((xz: any) => any) | null;
} = { sunVisibilityAt: null, apAt: null, skyVisAt: null };

export const vlSunVis = () => property('float', 'vlSunVis');
export const vlApS = () => property('vec3', 'vlApS');
export const vlApT = () => property('vec3', 'vlApT');

export function usesVertexLighting(builder: any) {
  return builder?.material?.userData?.vertexLighting === true;
}

/** Creates the varyings for one material. Call `vertex(world)` inside positionNode, `fragment()` inside colorNode. */
export function makeVertexLighting(tag: string) {
  const vSun = varying(float(1), `vlSun_${tag}`);
  const vS = varying(vec3(0), `vlS_${tag}`);
  const vT = varying(vec3(1), `vlT_${tag}`);
  const vSky = varying(float(1), `vlSky_${tag}`);
  return {
    vertex(world: any) {
      const h = lightingHooks;
      vSun.assign(h.sunVisibilityAt ? h.sunVisibilityAt(world) : float(1));
      if (h.apAt) {
        const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1));
        const ndc = clip.xy.div(clip.w);
        const ap = h.apAt(world, vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))));
        vS.assign(ap.S);
        vT.assign(ap.T);
      }
      vSky.assign(h.skyVisAt ? h.skyVisAt(world.xz) : float(1));
    },
    fragment() {
      vlSunVis().assign(vSun);
      vlApS().assign(vS);
      vlApT().assign(vT);
    },
    skyVis: vSky,
  };
}
