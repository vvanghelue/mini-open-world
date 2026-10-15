// Terrain system: CDLOD instanced patches displaced in the vertex shader from core (3 m) and far (40 m)
// heightmaps, fragment normals from precomputed normal maps, procedural/ortho-based materials.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, positionLocal, uniform, texture, vec3, float, fract, clamp, mix, smoothstep,
  distance, cameraPosition, exp2, max, abs, sqrt, dot, varying, int, If,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import { TerrainData, CORE_BLEND } from './terrain-data';
import { CdlodSelector, PATCH_N, MAX_PATCHES } from './cdlod';
import { loadTerrainTextures, TerrainTextures } from './terrain-textures';
import { applyTerrainMaterial } from './terrain-material';

export const terrainSettings = settings.group('terrain', 'Terrain', {
  lodDistance: { value: 260, min: 150, max: 800, step: 10, label: 'Distance de détail (m)', help: 'Portée du niveau de détail le plus fin ; chaque niveau suivant double.' },
  morphStart: { value: 0.66, min: 0.4, max: 0.9, step: 0.01, label: 'Début du morphing' },
  wireframe: { value: false, label: 'Fil de fer' },
  freezeLod: { value: false, label: 'Figer le LOD' },
  canopyShell: { value: 20, min: 0, max: 35, step: 1, label: 'Coque canopée lointaine (m)', help: 'Au-delà de la distance des arbres, le relief des forêts est rehaussé de la hauteur des arbres.' },
  canopyStart: { value: 2200, min: 300, max: 5000, step: 50, label: 'Début coque canopée (m)' },
  patches: { value: 0, readonly: true, label: 'Patches' },
});

function makeGrid(n: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let p = 0;
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) {
    pos[p++] = x;
    pos[p++] = 0;
    pos[p++] = z;
  }
  const idx = new Uint16Array(n * n * 6);
  let i = 0;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const a = z * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    // alternate diagonals for a more isotropic tessellation
    if ((x + z) & 1) {
      idx[i++] = a; idx[i++] = c; idx[i++] = b;
      idx[i++] = b; idx[i++] = c; idx[i++] = d;
    } else {
      idx[i++] = a; idx[i++] = c; idx[i++] = d;
      idx[i++] = a; idx[i++] = d; idx[i++] = b;
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const patch = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PATCHES * 4), 4);
  patch.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('cdlodPatch', patch);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

function floatTexture(data: Float32Array, res: number) {
  const t = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function normalTexture(data: Uint8Array, res: number) {
  const t = new THREE.DataTexture(data, res, res, THREE.RGFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export class Terrain implements System {
  readonly name = 'terrain';
  data!: TerrainData;
  selector!: CdlodSelector;
  material!: THREE.MeshStandardNodeMaterial;
  private fullMesh!: THREE.Mesh;
  private quarterMesh!: THREE.Mesh;
  private engine!: Engine;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private uLodDistance = uniform(terrainSettings.lodDistance);
  private uMorphStart = uniform(terrainSettings.morphStart);
  private uCanopyShell = uniform(terrainSettings.canopyShell);
  private uCanopyStart = uniform(terrainSettings.canopyStart);

  // Exposed TSL helpers for other systems (vegetation, water, shadows)
  heightNode!: (xz: any) => any;
  /** TSL: 1 inside the core data area, blending to 0 at its border. */
  coreWeightNode!: (xz: any) => any;
  /** TSL: forest cover fraction (0..1) at world xz. */
  forestNode!: (xz: any) => any;
  normalNode!: (xz: any) => any;
  coreHeightTex!: THREE.DataTexture;
  textures!: TerrainTextures;
  farHeightTex!: THREE.DataTexture;

  constructor(private onProgress?: (msg: string, frac: number) => void) {}

  async init(engine: Engine) {
    this.engine = engine;
    this.data = await TerrainData.load(this.onProgress);
    this.selector = new CdlodSelector(this.data);
    const m = this.data.meta;

    this.coreHeightTex = floatTexture(this.data.coreH, m.core.res);
    this.farHeightTex = floatTexture(this.data.farH, m.far.res);
    const coreNormalTex = normalTexture(this.data.coreN, m.core.res);
    const farNormalTex = normalTexture(this.data.farN, m.far.res);

    const uCoreSize = uniform(m.core.size);
    const uFarSize = uniform(m.far.size);
    const uBlend = uniform(CORE_BLEND);

    const coreWeight = Fn(([xz]: [any]) => {
      const edge = uCoreSize.mul(0.5).sub(max(abs(xz.x), abs(xz.y)));
      return smoothstep(0, uBlend, edge);
    });

    const sampleHeight = Fn(([xz]: [any]) => {
      const hc = texture(this.coreHeightTex, xz.div(uCoreSize).add(0.5)).level(float(0)).r;
      const hf = texture(this.farHeightTex, xz.div(uFarSize).add(0.5)).level(float(0)).r;
      return mix(hf, hc, coreWeight(xz));
    });
    this.heightNode = sampleHeight;
    this.coreWeightNode = coreWeight;

    const sampleNormal = Fn(([xz]: [any]) => {
      const nc = texture(coreNormalTex, xz.div(uCoreSize).add(0.5)).rg;
      const nf = texture(farNormalTex, xz.div(uFarSize).add(0.5)).rg;
      const n2 = mix(nf, nc, coreWeight(xz)).mul(2).sub(1);
      return vec3(n2.x, sqrt(max(float(0), float(1).sub(dot(n2, n2)))), n2.y).normalize();
    });
    this.normalNode = sampleNormal;

    const patch = attribute('cdlodPatch', 'vec4');
    const vMorph = varying(float(0), 'vMorph');
    const positionNode = Fn(() => {
      const grid = positionLocal.xz;
      const spacing = patch.z;
      const level = patch.w;
      const w0 = patch.xy.add(grid.mul(spacing));
      const h0 = sampleHeight(w0);
      const d = distance(cameraPosition, vec3(w0.x, h0, w0.y));
      const range = this.uLodDistance.mul(exp2(level));
      const mStart = range.mul(this.uMorphStart);
      const morph = clamp(d.sub(mStart).div(range.sub(mStart)), 0, 1);
      vMorph.assign(morph);
      const g = grid.sub(fract(grid.mul(0.5)).mul(2.0).mul(morph));
      const w = patch.xy.add(g.mul(spacing));
      const h = sampleHeight(w).toVar();
      // far canopy shell: forests beyond the tree-rendering distance are raised by the canopy height
      const shell = smoothstep(this.uCanopyStart, this.uCanopyStart.add(220), d).mul(this.uCanopyShell);
      If(shell.greaterThan(0.01), () => {
        h.addAssign(this.forestNode(w).mul(shell));
      });
      return vec3(w.x, h, w.y);
    })();

    this.onProgress?.('Terrain : textures', 1);
    this.textures = await loadTerrainTextures();
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.positionNode = positionNode;
    applyTerrainMaterial(mat, { textures: this.textures, coreSize: m.core.size, farSize: m.far.size, coreWeight, macroNormal: sampleNormal });
    const tx = this.textures;
    this.forestNode = Fn(([xz]: [any]) => {
      const c = texture(tx.landcover, xz.div(uCoreSize).add(0.5)).depth(int(0) as any).level(float(0)).r;
      const f = texture(tx.farLandcover, xz.div(uFarSize).add(0.5)).depth(int(0) as any).level(float(0)).r;
      return mix(f, c, coreWeight(xz));
    });
    this.material = mat;

    this.fullMesh = new THREE.Mesh(makeGrid(PATCH_N), mat);
    this.quarterMesh = new THREE.Mesh(makeGrid(PATCH_N / 2), mat);
    for (const mesh of [this.fullMesh, this.quarterMesh]) {
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = 'terrain';
      engine.scene.add(mesh);
    }

    settings.on('terrain.lodDistance', (v) => (this.uLodDistance.value = v as number));
    settings.on('terrain.morphStart', (v) => (this.uMorphStart.value = v as number));
    settings.on('terrain.canopyShell', (v) => (this.uCanopyShell.value = v as number));
    settings.on('terrain.canopyStart', (v) => (this.uCanopyStart.value = v as number));
    settings.on('terrain.wireframe', (v) => {
      mat.wireframe = v as boolean;
      mat.needsUpdate = true;
    });
  }

  heightAt(x: number, z: number) {
    return this.data.heightAt(x, z);
  }

  /** CPU forest-cover fraction at (x, z), mirroring the GPU forestNode (core/far blend). */
  forestAt(x: number, z: number): number {
    const m = this.data.meta;
    const sample = (data: Uint8Array, res: number, size: number) => {
      const fx = Math.min(Math.max((x / size + 0.5) * res - 0.5, 0), res - 1);
      const fz = Math.min(Math.max((z / size + 0.5) * res - 0.5, 0), res - 1);
      const x0 = Math.floor(fx), z0 = Math.floor(fz);
      const x1 = Math.min(x0 + 1, res - 1), z1 = Math.min(z0 + 1, res - 1);
      const ax = fx - x0, az = fz - z0;
      const v = (xx: number, zz: number) => data[(zz * res + xx) * 4] / 255; // layer 0, channel R
      return (v(x0, z0) * (1 - ax) + v(x1, z0) * ax) * (1 - az) + (v(x0, z1) * (1 - ax) + v(x1, z1) * ax) * az;
    };
    const far = sample(this.textures.farLandcover.image.data as Uint8Array, 2048, m.far.size);
    const edge = m.core.size / 2 - Math.max(Math.abs(x), Math.abs(z));
    if (edge <= 0) return far;
    const w = Math.min(1, Math.max(0, edge / CORE_BLEND));
    const ws = w * w * (3 - 2 * w);
    const core = sample(this.textures.landcover.image.data as Uint8Array, 4096, m.core.size);
    return far + (core - far) * ws;
  }

  update(_ctx: FrameContext) {
    if (terrainSettings.freezeLod) return;
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, THREE.WebGPUCoordinateSystem, (cam as any).reversedDepth === true);
    this.selector.select(cam.position, this.frustum, terrainSettings.lodDistance);
    this.upload(this.fullMesh, this.selector.full, this.selector.fullCount);
    this.upload(this.quarterMesh, this.selector.quarter, this.selector.quarterCount);
    terrainSettings.patches = this.selector.fullCount + this.selector.quarterCount;
  }

  private upload(mesh: THREE.Mesh, arr: Float32Array, count: number) {
    const n = Math.min(count, MAX_PATCHES);
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    const attr = geo.getAttribute('cdlodPatch') as THREE.InstancedBufferAttribute;
    (attr.array as Float32Array).set(arr.subarray(0, n * 4));
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(4, n * 4));
    attr.needsUpdate = true;
    geo.instanceCount = n;
    mesh.visible = n > 0;
  }
}
