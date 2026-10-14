// @ts-nocheck -- TSL type definitions are incomplete for the node patterns used here
// Hemi-octahedral impostors. Each tree variant is rendered from N x N directions over the upper hemisphere
// into an atlas (albedo+coverage, local normal). At runtime a camera-facing quad blends the 4 nearest views,
// reprojecting the quad point into each view's image plane.
//
// Frame basis (shared by bake and runtime): view direction d (from tree centre towards the eye),
//   refUp = |d.y| > 0.999 ? (0,0,-1) : (0,1,0);  right = normalize(cross(refUp, d));  up = cross(d, right)
// Frame image: u = 0.5 + dot(p, right) / (2R), v = 0.5 - dot(p, up) / (2R)   (v = 0 at the top row)
import * as THREE from 'three/webgpu';
import {
  Fn, texture, uniform, vec2, vec3, vec4, float, uv, normalLocal, attribute, abs, normalize, cross, dot, floor, fract,
  clamp, mix, max, select, positionLocal, int, Loop, sRGBTransferOETF, dFdx, dFdy,
} from 'three/tsl';
import type { GeneratedTree } from './tree-generator';
import type { TreeTextures } from './tree-materials';

export const IMP_N = 10; // frames per side
export const IMP_FRAME = 128; // pixels per frame
export const IMP_COLS = 2; // variants per atlas row

export function hemiOctDecode(u: number, v: number, out = new THREE.Vector3()) {
  const ex = u * 2 - 1, ey = v * 2 - 1;
  const tx = (ex + ey) * 0.5, tz = (ex - ey) * 0.5;
  out.set(tx, 1 - Math.abs(tx) - Math.abs(tz), tz);
  return out.normalize();
}

export function frameBasis(d: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3) {
  const refUp = Math.abs(d.y) > 0.999 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  right.crossVectors(refUp, d).normalize();
  up.crossVectors(d, right);
}

export interface ImpostorAtlas {
  albedo: THREE.DataTexture; // rgb albedo (sRGB), a coverage
  normal: THREE.DataTexture; // rgb local normal *0.5+0.5, a coverage
  size: number;
  radius: number[]; // bake radius per variant
  center: number[]; // bake centre height per variant
}

/** Bakes all variants. Uses plain unlit materials and reads the result back into mip-mapped textures. */
export async function bakeImpostors(renderer: THREE.WebGPURenderer, trees: GeneratedTree[], tx: TreeTextures, tints: THREE.Color[]): Promise<ImpostorAtlas> {
  const size = IMP_N * IMP_FRAME * IMP_COLS;
  const rows = Math.ceil(trees.length / IMP_COLS);
  const height = IMP_N * IMP_FRAME * rows;
  const mkRT = () => {
    const rt = new THREE.RenderTarget(size, height, { samples: 4, depthBuffer: true, type: THREE.UnsignedByteType });
    rt.texture.generateMipmaps = false;
    return rt;
  };
  const rtA = mkRT();
  const rtN = mkRT();

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const vdata = attribute('vdata', 'vec4');
  const twig = texture(tx.twigAlbedo, uv());

  // unlit bake materials
  const mkFoliage = (tint: THREE.Color, mode: 'albedo' | 'normal') => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const ao = mix(float(0.55), float(1), vdata.x);
    // render targets store linear values: encode albedo to sRGB bytes ourselves (decoded by the sampler later)
    m.colorNode = mode === 'albedo' ? vec4(sRGBTransferOETF(twig.rgb.mul(uniform(tint)).mul(ao)), 1) : vec4(normalize(normalLocal).mul(0.5).add(0.5), 1);
    m.opacityNode = twig.a;
    m.alphaTest = 0.45;
    return m;
  };
  const mkBark = (mode: 'albedo' | 'normal') => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = mode === 'albedo' ? vec4(sRGBTransferOETF(texture(tx.barkAlbedo, uv()).rgb.mul(0.85)), 1) : vec4(normalize(normalLocal).mul(0.5).add(0.5), 1);
    return m;
  };

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);

  const radius: number[] = [];
  const centerH: number[] = [];
  const d = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();

  for (const mode of ['albedo', 'normal'] as const) {
    const rt = mode === 'albedo' ? rtA : rtN;
    renderer.setRenderTarget(rt);
    renderer.autoClear = false;
    renderer.clear();
    for (let v = 0; v < trees.length; v++) {
      const t = trees[v];
      scene.clear();
      const fol = new THREE.Mesh(t.foliage, mkFoliage(tints[v], mode));
      const bark = new THREE.Mesh(t.bark, mkBark(mode));
      scene.add(fol, bark);
      const R = Math.max(t.radius, t.height / 2) * 1.04;
      const C = new THREE.Vector3(0, t.height / 2, 0);
      radius[v] = R;
      centerH[v] = t.height / 2;
      cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
      cam.near = 0.1; cam.far = R * 4;
      cam.updateProjectionMatrix();
      const ox = (v % IMP_COLS) * IMP_N * IMP_FRAME, oy = Math.floor(v / IMP_COLS) * IMP_N * IMP_FRAME;
      for (let j = 0; j < IMP_N; j++) for (let i = 0; i < IMP_N; i++) {
        hemiOctDecode((i + 0.5) / IMP_N, (j + 0.5) / IMP_N, d);
        frameBasis(d, right, up);
        cam.position.copy(C).addScaledVector(d, R * 2);
        cam.up.copy(up);
        cam.lookAt(C);
        cam.updateMatrixWorld();
        rt.viewport.set(ox + i * IMP_FRAME, oy + j * IMP_FRAME, IMP_FRAME, IMP_FRAME);
        rt.scissor.set(ox + i * IMP_FRAME, oy + j * IMP_FRAME, IMP_FRAME, IMP_FRAME);
        rt.scissorTest = true;
        renderer.render(scene, cam);
      }
      (fol.material as THREE.Material).dispose();
      (bark.material as THREE.Material).dispose();
    }
    rt.scissorTest = false;
    rt.viewport.set(0, 0, size, height);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAutoClear;
  renderer.toneMapping = prevToneMapping;

  const read = async (rt: THREE.RenderTarget, srgb: boolean) => {
    const px = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, height)) as Uint8Array;
    const data = new Uint8Array(px.buffer.slice(0));
    // dilate colour into empty texels so mips don't pull in black
    dilate(data, size, height, 6);
    const tex = new THREE.DataTexture(data, size, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };
  const albedo = await read(rtA, true);
  const normal = await read(rtN, false);
  rtA.dispose();
  rtN.dispose();
  return { albedo, normal, size, radius, center: centerH };
}

function dilate(px: Uint8Array, w: number, h: number, passes: number) {
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = px[i * 4 + 3] > 8 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = known.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      if (x > 0 && known[i - 1]) { r += px[(i - 1) * 4]; g += px[(i - 1) * 4 + 1]; b += px[(i - 1) * 4 + 2]; n++; }
      if (x < w - 1 && known[i + 1]) { r += px[(i + 1) * 4]; g += px[(i + 1) * 4 + 1]; b += px[(i + 1) * 4 + 2]; n++; }
      if (y > 0 && known[i - w]) { r += px[(i - w) * 4]; g += px[(i - w) * 4 + 1]; b += px[(i - w) * 4 + 2]; n++; }
      if (y < h - 1 && known[i + w]) { r += px[(i + w) * 4]; g += px[(i + w) * 4 + 1]; b += px[(i + w) * 4 + 2]; n++; }
      if (n) { px[i * 4] = r / n; px[i * 4 + 1] = g / n; px[i * 4 + 2] = b / n; next[i] = 1; }
    }
    known.set(next);
  }
}

/** TSL helpers for the runtime impostor shader. */
export function impostorShaderParts(atlas: ImpostorAtlas, variantCount: number) {
  const rows = Math.ceil(variantCount / IMP_COLS);
  const N = IMP_N;
  const decode = Fn(([u, v]: [any, any]) => {
    const e = vec2(u, v).mul(2).sub(1);
    const t = vec2(e.x.add(e.y), e.x.sub(e.y)).mul(0.5);
    return normalize(vec3(t.x, float(1).sub(abs(t.x)).sub(abs(t.y)), t.y));
  });
  const encode = Fn(([d]: [any]) => {
    const dd = vec3(d.x, max(d.y, 0.0), d.z).toVar();
    const s = abs(dd.x).add(abs(dd.y)).add(abs(dd.z));
    const p = vec2(dd.x, dd.z).div(s);
    return vec2(p.x.add(p.y), p.x.sub(p.y)).mul(0.5).add(0.5);
  });
  const basis = (d: any) => {
    const refUp = select(abs(d.y).greaterThan(0.999), vec3(0, 0, -1), vec3(0, 1, 0));
    const right = normalize(cross(refUp, d));
    const up = cross(d, right);
    return { right, up };
  };
  /** sample albedo+normal for local point p (relative to bake centre) seen from local view direction vd */
  const sample = (variant: any, vd: any, p: any, R: any) => {
    const g = encode(vd).mul(N).sub(0.5);
    const i0 = clamp(floor(g), vec2(0), vec2(N - 1)).toVar();
    const f = clamp(g.sub(i0), vec2(0), vec2(1)).toVar();
    const vx = variant.mod(IMP_COLS), vy = floor(variant.div(IMP_COLS));
    const albedo = vec4(0).toVar();
    const nrm = vec4(0).toVar();
    for (let k = 0; k < 4; k++) {
      const ox = k & 1, oy = k >> 1;
      const cell = clamp(i0.add(vec2(ox, oy)), vec2(0), vec2(N - 1));
      const w = mix(float(1).sub(f.x), f.x, float(ox)).mul(mix(float(1).sub(f.y), f.y, float(oy)));
      const dk = decode(cell.x.add(0.5).div(N), cell.y.add(0.5).div(N));
      const b = basis(dk);
      const fu = clamp(dot(p, b.right).div(R.mul(2)).add(0.5), 0.002, 0.998);
      const fv = clamp(float(0.5).sub(dot(p, b.up).div(R.mul(2))), 0.002, 0.998);
      const auv = vec2(vx.mul(N).add(cell.x).add(fu).div(N * IMP_COLS), vy.mul(N).add(cell.y).add(fv).div(N * rows));
      albedo.addAssign(texture(atlas.albedo, auv).mul(w));
      nrm.addAssign(texture(atlas.normal, auv).mul(w));
    }
    return { albedo, normal: normalize(nrm.xyz.mul(2).sub(1)) };
  };
  /** single frame chosen stochastically by bilinear weight (noise in [0,1)); TAA integrates the blend */
  const sampleStochastic = (variant: any, vd: any, p: any, R: any, noise: any) => {
    const g = encode(vd).mul(N).sub(0.5);
    const i0 = clamp(floor(g), vec2(0), vec2(N - 1));
    const f = clamp(g.sub(i0), vec2(0), vec2(1));
    // pick x then y offset with independent thresholds derived from one noise value
    const n2 = fract(noise.mul(7.31).add(0.37));
    const ox = select(noise.lessThan(f.x), float(1), float(0));
    const oy = select(n2.lessThan(f.y), float(1), float(0));
    const cell = clamp(i0.add(vec2(ox, oy)), vec2(0), vec2(N - 1));
    const vx = variant.mod(IMP_COLS), vy = floor(variant.div(IMP_COLS));
    const dk = decode(cell.x.add(0.5).div(N), cell.y.add(0.5).div(N));
    const b = basis(dk);
    const fu = clamp(dot(p, b.right).div(R.mul(2)).add(0.5), 0.002, 0.998);
    const fv = clamp(float(0.5).sub(dot(p, b.up).div(R.mul(2))), 0.002, 0.998);
    const auv = vec2(vx.mul(N).add(cell.x).add(fu).div(N * IMP_COLS), vy.mul(N).add(cell.y).add(fv).div(N * rows));
    // gradients from the continuous (non-stochastic) frame coordinates: the chosen cell differs between
    // neighbouring pixels, so implicit derivatives would explode and select the 1x1 mip
    const fu0 = dot(p, basis(decode(i0.x.add(0.5).div(N), i0.y.add(0.5).div(N))).right).div(R.mul(2));
    const fv0 = dot(p, basis(decode(i0.x.add(0.5).div(N), i0.y.add(0.5).div(N))).up).div(R.mul(2)).negate();
    const scale = vec2(1 / (N * IMP_COLS), 1 / (N * rows));
    const gx = vec2(dFdx(fu0), dFdx(fv0)).mul(scale);
    const gy = vec2(dFdy(fu0), dFdy(fv0)).mul(scale);
    return { auv, gx, gy };
  };
  void int; void Loop; void positionLocal;
  return { encode, decode, basis, sample, sampleStochastic, rows };
}
