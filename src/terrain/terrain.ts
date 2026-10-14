// Terrain system: CDLOD instanced patches displaced in the vertex shader from core (3 m) and far (40 m)
// heightmaps, fragment normals from precomputed normal maps, procedural/ortho-based materials.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, positionLocal, positionWorld, uniform, texture, vec2, vec3, float, fract, clamp, mix, smoothstep,
  distance, cameraPosition, exp2, max, abs, sqrt, dot, transformNormalToView, varying,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import { TerrainData, CORE_BLEND } from './terrain-data';
import { CdlodSelector, PATCH_N, MAX_PATCHES } from './cdlod';

export const terrainSettings = settings.group('terrain', 'Terrain', {
  lodDistance: { value: 260, min: 150, max: 800, step: 10, label: 'Distance de détail (m)', help: 'Portée du niveau de détail le plus fin ; chaque niveau suivant double.' },
  morphStart: { value: 0.66, min: 0.4, max: 0.9, step: 0.01, label: 'Début du morphing' },
  wireframe: { value: false, label: 'Fil de fer' },
  freezeLod: { value: false, label: 'Figer le LOD' },
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

  // Exposed TSL helpers for other systems (vegetation, water, shadows)
  heightNode!: (xz: any) => any;
  normalNode!: (xz: any) => any;
  coreHeightTex!: THREE.DataTexture;
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
      return vec3(w.x, sampleHeight(w), w.y);
    })();

    const mat = new THREE.MeshStandardNodeMaterial();
    mat.positionNode = positionNode;
    const nWorld = sampleNormal(positionWorld.xz);
    mat.normalNode = transformNormalToView(nWorld);

    // Placeholder procedural albedo (replaced by ortho/land-cover materials).
    const h = positionWorld.y;
    const slope = float(1).sub(nWorld.y);
    const grass = vec3(0.16, 0.24, 0.07);
    const forest = vec3(0.05, 0.09, 0.04);
    const rock = vec3(0.32, 0.3, 0.27);
    const snow = vec3(0.85, 0.87, 0.9);
    const lowland = mix(grass, forest, smoothstep(900, 1300, h).mul(float(1).sub(smoothstep(1700, 2000, h))));
    let col = mix(lowland, rock, smoothstep(0.25, 0.45, slope));
    col = mix(col, rock, smoothstep(2100, 2500, h).mul(0.8));
    col = mix(col, snow, smoothstep(2600, 3000, h).mul(float(1).sub(smoothstep(0.35, 0.55, slope))));
    mat.colorNode = col;
    mat.roughnessNode = float(0.92);
    mat.metalnessNode = float(0);
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
    settings.on('terrain.wireframe', (v) => {
      mat.wireframe = v as boolean;
      mat.needsUpdate = true;
    });
  }

  heightAt(x: number, z: number) {
    return this.data.heightAt(x, z);
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
