// Tree materials: alpha-tested foliage cards (with wind, ao, back-lit translucency) and bark.
// `xf` (instance transform) lets the same material read per-instance data from the GPU-culled storage buffer;
// without it the material renders the tree untransformed (impostor baking).
//
// LOD cross-fades: each instance carries a value v in [0, 2):
//   v <  1 : "near" member of a transition, visible where noise >= v   (fading out as v -> 1)
//   v >= 1 : "far"  member, visible where noise <  v - 1               (fading in  as v -> 2)
// Both members use the same screen-space noise, so their coverage is complementary (no holes, no double
// coverage); TAA jitter turns the dither into a smooth blend.
import * as THREE from 'three/webgpu';
import { skyVisAt } from '../terrain/terrain-material';
import { makeVertexLighting } from '../lighting/vertex-lighting';

let matId = 0;
import {
  Fn, texture, uniform, vec3, vec4, float, attribute, positionLocal, normalLocal, sin, time, mix, pow, clamp, dot,
  normalize, positionWorld, cameraPosition, uv, normalMap, transformNormalToView, interleavedGradientNoise,
  screenCoordinate, select,
} from 'three/tsl';

export interface TreeTextures {
  twigAlbedo: THREE.Texture;
  twigNormal: THREE.Texture;
  barkAlbedo: THREE.Texture;
  barkNormal: THREE.Texture;
}

export interface InstanceXform {
  position: (local: any) => any; // world position from local position
  normal: (local: any) => any; // world normal from local normal
  seed: any; // per-instance random 0..1
  fade: any; // cross-fade value v (see header)
  /** Per-instance lighting from the scatter compute: sun visibility at the base / top of the tree, AP, sky. */
  lighting?: { S: any; T: any; sunBase: any; sunTop: any; sky: any };
}

/** Assigns the vertex-lighting varyings from per-instance values (sun visibility interpolated over height). */
function instanceLightingAt(vl: ReturnType<typeof makeVertexLighting>, xf: InstanceXform, world: any, heightRel: any) {
  const l = xf.lighting;
  if (!l) return vl.vertex(world);
  vl.fromInstance({ S: l.S, T: l.T, sun: mix(l.sunBase, l.sunTop, clamp(heightRel, 0, 1)), sky: l.sky });
}

export const windUniforms = {
  strength: uniform(1),
  dir: uniform(new THREE.Vector2(0.8, 0.6)),
};

/** Sun parameters for translucency (pre-exposed colour, world direction), updated by the forest system. */
export const sunUniforms = {
  color: uniform(new THREE.Color(1, 1, 1)),
  dir: uniform(new THREE.Vector3(0, 1, 0)),
};

/** 1 if the fragment is kept for cross-fade value v, else 0. */
export const fadeVisible = Fn(([v]: [any]) => {
  const n = interleavedGradientNoise(screenCoordinate.xy);
  return select(v.lessThan(1), select(n.greaterThanEqual(v), float(1), float(0)), select(n.lessThan(v.sub(1)), float(1), float(0)));
});

/** Wind-displaced foliage position: local (no instance transform) or world (with). Shared by the shaded and
 *  depth pre-pass materials so both produce the same depth (the shaded pass tests with EQUAL). */
function foliagePosition(xf: InstanceXform | null) {
  const p = positionLocal;
  const vdata = attribute('vdata', 'vec4');
  const seed = xf ? xf.seed : float(0.5);
  // wind: whole-tree sway grows with height^2, branch flutter grows with flex
  const h = vdata.w;
  const t = time;
  const sway = sin(t.mul(0.9).add(seed.mul(6.28))).mul(0.06).add(sin(t.mul(2.1).add(seed.mul(17))).mul(0.025)).mul(h.mul(h)).mul(p.y.mul(0.02).add(0.5));
  const flutter = sin(t.mul(4.3).add(vdata.z).add(p.x.mul(0.7))).mul(0.05).mul(vdata.y);
  const d = windUniforms.dir;
  const local = p.add(vec3(d.x.mul(sway.add(flutter)), flutter.mul(0.4), d.y.mul(sway.add(flutter))).mul(windUniforms.strength));
  return xf ? xf.position(local) : local;
}

export interface FoliageOptions {
  /** Drawn after a depth pre-pass (makeFoliageDepthMaterial): EQUAL depth test, no alpha test / discard, so the
   *  GPU's hidden surface removal shades each pixel once instead of once per overlapping card. */
  prepassed?: boolean;
}

/** Depth-only pre-pass for alpha-tested foliage (cheap: one texture fetch). */
export function makeFoliageDepthMaterial(tx: TreeTextures, xf: InstanceXform) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.colorWrite = false;
  m.fog = false;
  m.userData.invariantPosition = true;
  m.positionNode = Fn(() => foliagePosition(xf))();
  const tex = texture(tx.twigAlbedo, uv());
  m.colorNode = vec4(0, 0, 0, 1);
  m.opacityNode = tex.a.mul(fadeVisible(xf.fade));
  m.alphaTest = 0.45;
  (m as any).maskShadowNode = tex.a.greaterThan(0.45);
  return m;
}

export function makeFoliageMaterial(tx: TreeTextures, xf: InstanceXform | null, tint: THREE.Color, opts: FoliageOptions = {}) {
  // Lambert: foliage has no meaningful specular, diffuse-only lighting is markedly cheaper
  const m = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  const vdata = attribute('vdata', 'vec4');
  const uTint = uniform(tint);
  const seed = xf ? xf.seed : float(0.5);
  const vl = xf ? makeVertexLighting(`fol${matId++}`) : null;
  if (vl) m.userData.vertexLighting = true;

  m.positionNode = Fn(() => {
    if (!xf) return foliagePosition(null);
    const world = foliagePosition(xf).toVar();
    instanceLightingAt(vl!, xf, world, vdata.w);
    return world;
  })();
  if (xf) m.normalNode = transformNormalToView(normalize(xf.normal(normalLocal)));

  const tex = texture(tx.twigAlbedo, uv());
  const ao = vdata.x;
  m.colorNode = Fn(() => {
    vl?.fragment();
    const variation = mix(float(0.88), float(1.12), seed);
    return vec4(tex.rgb.mul(uTint).mul(variation).mul(mix(float(0.55), float(1), ao)), 1);
  })();
  if (opts.prepassed) {
    m.userData.invariantPosition = true;
    // three r186 maps EqualDepth to NotEqual under a reversed depth buffer (equality does not flip): asking for
    // NotEqualDepth yields the EQUAL test we need (the engine always uses reversed depth)
    m.depthFunc = THREE.NotEqualDepth;
    m.depthWrite = false;
  } else {
    m.opacityNode = xf ? tex.a.mul(fadeVisible(xf.fade)) : tex.a;
    m.alphaTest = 0.45;
  }
  // the shadow pass ignores opacityNode: cut the cards out explicitly
  (m as any).maskShadowNode = tex.a.greaterThan(0.45);
  m.aoNode = Fn(() => mix(float(0.5), float(1), ao).mul(vl ? vl.skyVis : skyVisAt(positionWorld.xz)))();

  // back-lit translucency (light through needles when looking towards the sun)
  if (xf) {
    (m as any).emissiveNode = Fn(() => {
      const v = normalize(positionWorld.sub(cameraPosition));
      const back = pow(clamp(dot(v, sunUniforms.dir), 0, 1), 6);
      return tex.rgb.mul(uTint).mul(sunUniforms.color).mul(back).mul(0.12).mul(mix(float(0.4), float(1), ao));
    })();
  }
  return m;
}

export function makeBarkMaterial(tx: TreeTextures, xf: InstanceXform | null, treeHeight = 25) {
  const m = new THREE.MeshStandardNodeMaterial();
  const vl = xf ? makeVertexLighting(`bark${matId++}`) : null;
  if (xf) {
    m.userData.vertexLighting = true;
    m.positionNode = Fn(() => {
      const world = xf.position(positionLocal).toVar();
      instanceLightingAt(vl!, xf, world, positionLocal.y.div(treeHeight));
      return world;
    })();
    m.normalNode = transformNormalToView(normalize(xf.normal(normalLocal)));
    m.opacityNode = fadeVisible(xf.fade);
    m.alphaTest = 0.5;
    m.aoNode = vl!.skyVis;
  } else {
    m.normalNode = normalMap(texture(tx.barkNormal, uv()));
  }
  m.colorNode = Fn(() => {
    vl?.fragment();
    return texture(tx.barkAlbedo, uv()).rgb.mul(0.85);
  })();
  m.roughnessNode = float(0.9);
  m.metalnessNode = float(0);
  return m;
}
