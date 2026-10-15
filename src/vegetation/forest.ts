// @ts-nocheck -- TSL type definitions are incomplete for the storage/uniformArray patterns used here
// GPU-driven forest. Every frame a compute shader scatters candidate trees on a jittered 4.5 m grid around the
// camera (deterministic hash per cell -> stable, no streaming), keeps them according to the real forest-cover map
// and altitude (treeline), frustum-culls them, picks LOD0 mesh / LOD1 mesh / impostor with dithered cross-fades,
// and appends them to per-LOD instance lists. A second tiny compute writes the indirect draw arguments.
// Nothing is read back to the CPU.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, storage, instanceIndex, vec2, vec3, vec4, float, int, uint, If, Return, select, atomicAdd,
  atomicStore, smoothstep, max, min, sqrt, dot, length, normalize, cross, positionLocal, normalLocal, cameraPosition,
  transformNormalToView, varying, sin, cos, positionWorld, abs, mix, property, texture, Discard,
  interleavedGradientNoise, screenCoordinate, cameraProjectionMatrix, cameraViewMatrix, step, floor, clamp, dFdx, dFdy,
} from 'three/tsl';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import type { Terrain } from '../terrain/terrain';
import type { Atmosphere } from '../sky/atmosphere';
import type { TerrainShadows } from '../lighting/terrain-shadows';
import { loadBitmapTexture } from '../terrain/terrain-textures';
import { generateTree, TREE_PRESETS, GeneratedTree, TwigRect } from './tree-generator';
import { makeFoliageMaterial, makeFoliageDepthMaterial, makeBarkMaterial, InstanceXform, TreeTextures, sunUniforms, windUniforms, fadeVisible } from './tree-materials';
import { bakeImpostors, impostorShaderParts, ImpostorAtlas, IMP_N, IMP_COLS } from './impostors';
import { registerCommand } from '../agent/bridge';
import { qualityScaled, adaptive } from '../core/adaptive';
import { lightingHooks } from '../lighting/vertex-lighting';
import { freezeStatic } from '../core/static';

export const forestSettings = settings.group('forest', 'Forest', {
  enabled: { value: true, label: 'Trees' },
  density: { value: 1.0, min: 0, max: 2, step: 0.05, label: 'Density' },
  lod0Distance: { value: 30, min: 15, max: 200, step: 5, label: 'Distance LOD0 (m)' },
  lod1Distance: { value: 75, min: 50, max: 600, step: 5, label: 'Distance LOD1 (m)' },
  maxDistance: { value: 2000, min: 500, max: 4000, step: 50, label: 'Distance max (m)' },
  treeline: { value: 2050, min: 1500, max: 2600, step: 10, label: 'Treeline (m)' },
  wind: { value: 1.0, min: 0, max: 4, step: 0.05, label: 'Wind' },
  foliagePrepass: { value: true, label: 'Foliage depth pre-pass' },
  impostorPrepass: { value: true, label: 'Impostor depth pre-pass' },
  skipEmptyDraws: { value: true, label: 'Skip empty lists (CPU)', hidden: true },
  debugDraw: { value: 'all', options: { All: 'all', 'Meshes only': 'meshes', 'Impostors only': 'impostors', 'None (compute only)': 'none' }, label: 'Debug draw' },
  debugFlatImpostors: { value: false, label: 'Debug flat impostors', hidden: true },
  debugMeshShading: { value: 'full', options: { full: 'full', noShadow: 'noShadow', noFog: 'noFog', basic: 'basic' }, label: 'Debug mesh shading', hidden: true },
  impostorBlendDistance: { value: 300, min: 0, max: 5000, step: 50, label: 'Impostors: 4-view blend up to (m)' },
  impostorStochastic: { value: true, label: 'Impostors: stochastic view beyond' },
  impostorEarlyDiscard: { value: true, label: 'Impostors: early discard', hidden: true },
});

const GRID = 4.5; // candidate spacing (m)
// Masked depth pre-pass for impostors: measured slower on M4 (the alpha-tested pass itself dominates), kept off.
const NV = TREE_PRESETS.length;
const CAP_LOD0 = 3072, CAP_LOD1 = 8192;
// impostors are split into distance bands drawn near -> far (coarse front-to-back order: depth testing then
// rejects hidden trees before shading, which matters a lot for alpha-tested overdraw on forested slopes)
const IMP_BANDS = [450, 800, 1400]; // band edges (m); last band goes to maxDistance
const CAP_IMP = [32768, 49152, 65536, 98304];
const NB = CAP_IMP.length;
// lists: [0..NV) LOD0 per variant, [NV..2NV) LOD1 per variant, [2NV..2NV+NB) impostor bands
const NLIST = 2 * NV + NB;
const LIST_CAP = [...Array(NV).fill(CAP_LOD0), ...Array(NV).fill(CAP_LOD1), ...CAP_IMP];
const LIST_BASE: number[] = [];
{
  let acc = 0;
  for (const c of LIST_CAP) { LIST_BASE.push(acc); acc += c; }
}
const CAP_TOTAL = LIST_BASE[NLIST - 1] + CAP_IMP[NB - 1];

// instance record: 4 x vec4 = (x, y, z, scale), (rotation, fade, seed, variant), (AP S.rgb, sky visibility),
// (AP T.rgb, packed sun visibility base/top), (bounce irradiance rgb, unused)
const INST_STRIDE = 5;
/** Two visibilities in [0,1] in one float: base in the integer part (1/1000 steps), top in the fraction. */
const packSun = (base: any, top: any) => floor(clamp(base, 0, 1).mul(1000)).add(clamp(top, 0, 1).mul(0.999));
const instanceLighting = (d2: any, d3: any, d4: any) => ({
  bounce: d4.xyz,
  S: d2.xyz,
  sky: d2.w,
  T: d3.xyz,
  sunBase: floor(d3.w).div(1000),
  sunTop: d3.w.sub(floor(d3.w)).div(0.999),
});

interface DrawEntry {
  list: number;
  mesh: THREE.Mesh;
}

export class Forest implements System {
  readonly name = 'forest';
  private engine!: Engine;
  private instBuf!: THREE.StorageBufferAttribute;
  private counters!: THREE.StorageBufferAttribute;
  private drawArgs!: THREE.IndirectStorageBufferAttribute;
  private scatter!: THREE.ComputeNode;
  private finalize!: THREE.ComputeNode;
  private draws: DrawEntry[] = [];
  private trees0: GeneratedTree[] = [];
  private atlas!: ImpostorAtlas;
  private group = new THREE.Group();
  private gridN = 0;

  private uCam = uniform(new THREE.Vector3());
  private uViewProj = uniform(new THREE.Matrix4());
  private uThin = uniform(new THREE.Vector3(600, 1500, 0.42));
  private uGridOrigin = uniform(new THREE.Vector2());
  private uGridN = uniform(0);
  private uPlanes = uniformArray([0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()));
  private uDensity = uniform(1);
  private uD0 = uniform(60);
  private uD1 = uniform(170);
  private uD2 = uniform(2400);
  private uTreeline = uniform(2050);
  private uBlendDist = uniform(300);
  private uShadowOffset = uniform(new THREE.Vector2());
  private uStochastic = uniform(1);
  private uEarlyDiscard = uniform(0.5);
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();

  constructor(private terrain: Terrain, private atmosphere: Atmosphere, private terrainShadows: TerrainShadows) {}

  async init(engine: Engine) {
    this.engine = engine;
    const base = '/data/trees/';
    const meta = await (await fetch(base + 'twigs.json')).json();
    const twigs: TwigRect[] = meta.twigs;
    const [twigAlbedo, twigNormal, barkAlbedo, barkNormal] = await Promise.all([
      loadBitmapTexture(base + 'twig_albedo.png', true),
      loadBitmapTexture(base + 'twig_normal.png', false),
      loadBitmapTexture(base + 'bark_albedo.jpg', true),
      loadBitmapTexture(base + 'bark_normal.jpg', false),
    ]);
    for (const t of [barkAlbedo, barkNormal]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const tx: TreeTextures = { twigAlbedo, twigNormal, barkAlbedo, barkNormal };

    const tints = TREE_PRESETS.map((p) => new THREE.Color(...p.tint));
    this.trees0 = TREE_PRESETS.map((p) => generateTree(p, twigs, 0));
    const trees1 = TREE_PRESETS.map((p) => generateTree(p, twigs, 1));
    this.atlas = await bakeImpostors(engine.renderer, this.trees0, tx, tints);

    // ---------------------------------------------------------------- buffers
    this.instBuf = new THREE.StorageBufferAttribute(new Float32Array(CAP_TOTAL * 4 * INST_STRIDE), 4);
    this.counters = new THREE.StorageBufferAttribute(new Uint32Array(16), 1);
    const nEntries = NV * 8 + NB * 2;
    this.drawArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array(nEntries * 5), 5);

    // ---------------------------------------------------------------- instance transform (shared by all LOD meshes)
    const inst = storage(this.instBuf, 'vec4', CAP_TOTAL * INST_STRIDE).toReadOnly();
    const makeXform = (): { xf: InstanceXform; baseUniform: any } => {
      const baseU = uniform(0).onObjectUpdate(({ object }: any) => object.userData.instBase);
      const i2 = int(baseU).add(int(instanceIndex)).mul(INST_STRIDE);
      const d0 = inst.element(i2);
      const d1 = inst.element(i2.add(1));
      const lit = instanceLighting(inst.element(i2.add(2)), inst.element(i2.add(3)), inst.element(i2.add(4)));
      const c = cos(d1.x), s = sin(d1.x);
      const rot = (v: any) => vec3(c.mul(v.x).add(s.mul(v.z)), v.y, s.negate().mul(v.x).add(c.mul(v.z)));
      return {
        baseUniform: baseU,
        xf: {
          position: (local: any) => rot(local.mul(d0.w)).add(d0.xyz),
          normal: (local: any) => rot(local),
          seed: d1.z,
          fade: d1.y,
          lighting: lit,
        },
      };
    };

    // ---------------------------------------------------------------- meshes (indirect)
    const argsInit = this.drawArgs.array as Uint32Array;
    let entry = 0;
    const addDraw = (geo: THREE.BufferGeometry, mat: THREE.Material, list: number, pass = 'color') => {
      const g = geo.clone();
      g.setIndirect(this.drawArgs, entry * 5 * 4);
      argsInit[entry * 5] = g.index!.count;
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      // only the mesh LODs cast cascaded shadows (impostors are covered by the heightfield canopy shadows)
      mesh.castShadow = list < 2 * NV;
      mesh.userData.instBase = LIST_BASE[list];
      mesh.userData.drawEntry = entry;
      mesh.userData.pass = pass;
      this.group.add(mesh);
      this.draws.push({ list, mesh });
      entry++;
    };
    for (let v = 0; v < NV; v++) {
      for (const [lod, tree] of [[0, this.trees0[v]], [1, trees1[v]]] as const) {
        const list = lod === 0 ? v : NV + v;
        const { xf } = makeXform();
        const fm = makeFoliageMaterial(tx, xf, tints[v]);
        // optional depth pre-pass (forest.foliagePrepass): masked depth first, then shading with EQUAL depth
        addDraw(tree.foliage, makeFoliageDepthMaterial(tx, xf), list, 'depth');
        addDraw(tree.foliage, fm, list);
        this.draws[this.draws.length - 1].mesh.userData.alt = { normal: fm, prepassed: makeFoliageMaterial(tx, xf, tints[v], { prepassed: true }) };
        const { xf: xfb } = makeXform();
        const bm = makeBarkMaterial(tx, xfb, tree.height);
        addDraw(tree.bark, bm, list);
        if (lod === 0) {
          // LOD0 trees cast their shadow with the light LOD1 geometry: shadow-only proxies on layer 1
          // (the main camera renders layer 0 only, the sun's shadow cameras render layers 0 + 1)
          const nShadowOnly = this.draws.length;
          addDraw(trees1[v].foliage, fm, list, 'shadow');
          addDraw(trees1[v].bark, bm, list, 'shadow');
          for (const d of this.draws.slice(nShadowOnly)) d.mesh.layers.set(1);
          for (const d of this.draws.slice(nShadowOnly - 3, nShadowOnly)) d.mesh.castShadow = false;
        }
      }
    }
    const impGeo = this.makeImpostorGeometry();
    const impMat = this.makeImpostorMaterial(inst);
    // masked depth pre-pass (cheap alpha test only), then the shaded pass with an EQUAL depth test and no
    // discard: only the visible impostor fragment of each pixel gets lit (alpha-test overdraw defeats the GPU's
    // hidden surface removal otherwise)
    for (let b = 0; b < NB; b++) addDraw(impGeo, this.impostorDepthMaterial, 2 * NV + b, 'depth');
    for (let b = 0; b < NB; b++) addDraw(impGeo, impMat, 2 * NV + b, 'color');
    // draw order: near meshes, impostor depth bands (near -> far), impostor colour bands
    for (const d of this.draws) {
      const band = d.list - 2 * NV;
      const depth = d.mesh.userData.pass === 'depth';
      d.mesh.renderOrder = d.list < 2 * NV ? (depth ? -2 : d.list < NV ? 1 : 2) : depth ? -1 : 10 + band;
      d.mesh.userData.casts = d.mesh.castShadow;
    }
    // a mesh depth pass casts the shadow in place of its colour pass when the pre-pass is on
    for (const d of this.draws) {
      if (d.list < 2 * NV && d.mesh.userData.pass === 'depth') d.mesh.userData.castsPre = this.draws.some((o) => o.mesh.userData.alt && o.list === d.list && o.mesh.userData.casts);
    }
    this.group.name = 'forest';
    engine.scene.add(this.group);
    freezeStatic(this.group);

    this.buildComputes();
    settings.on('forest.enabled', (v) => (this.group.visible = v as boolean), true);

    registerCommand('forest-stats', 'Visible tree counts per list (GPU readback)', async () => {
      const buf = new Uint32Array(await engine.renderer.getArrayBufferAsync(this.drawArgs));
      const out: Record<string, number> = {};
      for (const d of this.draws) out[`list${d.list}_${(d.mesh.material as any).name || d.mesh.userData.drawEntry}`] = buf[d.mesh.userData.drawEntry * 5 + 1];
      return out;
    });
    registerCommand('impostor-atlas', 'Save the impostor atlas to screenshots/impostor_*.png', async () => {
      const { writeProjectFile } = await import('../agent/bridge');
      for (const [name, tex] of [['albedo', this.atlas.albedo], ['normal', this.atlas.normal]] as const) {
        const c = new OffscreenCanvas(tex.image.width, tex.image.height);
        const ctx = c.getContext('2d')!;
        const img = ctx.createImageData(tex.image.width, tex.image.height);
        img.data.set(tex.image.data as Uint8Array);
        ctx.putImageData(img, 0, 0);
        await writeProjectFile(`screenshots/impostor_${name}.png`, await c.convertToBlob({ type: 'image/png' }));
      }
      return { ok: true, size: this.atlas.size };
    });
  }

  private makeImpostorGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  private makeImpostorMaterial(inst: any) {
    // All view-dependent work happens per vertex: frame selection (4 nearest hemi-octahedral views + bilinear
    // weights) and the projection of the quad point into each frame. Frame coordinates are affine in world
    // position, so they interpolate exactly across the quad; the fragment shader only samples textures.
    // Lighting is custom (unlit material): sun Lambert x heightfield shadow + sky SH, aerial perspective per tree.
    const atlas = this.atlas;
    const parts = impostorShaderParts(atlas, NV);
    const N = IMP_N, rows = parts.rows;
    const radius = uniformArray(atlas.radius.slice());
    const centerH = uniformArray(atlas.center.slice());
    const crownR = uniformArray(this.trees0.map((t) => t.radius * 1.08));
    const m = new THREE.MeshBasicNodeMaterial();
    m.fog = false;
    const baseU = uniform(0).onObjectUpdate(({ object }: any) => object.userData.instBase);
    const i2 = int(baseU).add(int(instanceIndex)).mul(INST_STRIDE);
    const d0 = inst.element(i2);
    const d1 = inst.element(i2.add(1));
    const lit = instanceLighting(inst.element(i2.add(2)), inst.element(i2.add(3)), inst.element(i2.add(4)));
    const vBounce = varying(vec3(0), 'impBounce');
    const vFrame = [0, 1, 2, 3].map((k) => varying(vec4(0), `impF${k}`)); // xy frame-local uv, zw atlas cell offset
    const vW = varying(vec4(1, 0, 0, 0), 'impW');
    const vFrameN = varying(vec4(0), 'impFN'); // dominant frame (coverage of the depth pre-pass)
    const vRotCS = varying(vec2(1, 0), 'impRot');
    const vMisc = varying(vec4(0), 'impMisc'); // x fade, y seed, z distance, w shadow
    const vApS = varying(vec3(0), 'impApS');
    const vApT = varying(vec3(1), 'impApT');
    const vSkyVis = varying(float(1), 'impSkyVis');
    const atmo = this.atmosphere;
    const cellSize = vec2(1 / (N * IMP_COLS), 1 / (N * rows));

    m.positionNode = Fn(() => {
      const variant = d1.w;
      const scale = d0.w;
      const R0 = radius.element(int(variant));
      const R = R0.mul(scale);
      const C = d0.xyz.add(vec3(0, centerH.element(int(variant)).mul(scale), 0)).toVar();
      const toCam = normalize(cameraPosition.sub(C)).toVar();
      const refUp = select(abs(toCam.y).greaterThan(0.999), vec3(0, 0, -1), vec3(0, 1, 0));
      const right = normalize(cross(refUp, toCam));
      const up = cross(toCam, right);
      // tight quad around the projected silhouette (crown width x view-dependent height)
      const cr = crownR.element(int(variant)).mul(scale);
      const halfH = centerH.element(int(variant)).mul(scale);
      const sy = abs(toCam.y);
      const hx = min(cr, R);
      const hy = min(halfH.mul(sqrt(max(float(1).sub(sy.mul(sy)), 0))).add(cr.mul(sy)), R);
      const world = C.add(right.mul(positionLocal.x.mul(hx))).add(up.mul(positionLocal.y.mul(hy))).toVar();
      // tree-local view direction and point
      const c = cos(d1.x), s = sin(d1.x);
      const rotInv = (v: any) => vec3(c.mul(v.x).sub(s.mul(v.z)), v.y, s.mul(v.x).add(c.mul(v.z)));
      const vd = normalize(rotInv(toCam));
      const lp = rotInv(world.sub(C)).div(scale);
      // 4 nearest frames + bilinear weights
      const g = parts.encode(vd).mul(N).sub(0.5);
      const i0 = clamp(floor(g), vec2(0), vec2(N - 1)).toVar();
      const f = clamp(g.sub(i0), vec2(0), vec2(1)).toVar();
      const vx = variant.mod(IMP_COLS), vy = floor(variant.div(IMP_COLS));
      for (let k = 0; k < 4; k++) {
        const ox = k & 1, oy = k >> 1;
        const cell = clamp(i0.add(vec2(ox, oy)), vec2(0), vec2(N - 1));
        const dk = parts.decode(cell.x.add(0.5).div(N), cell.y.add(0.5).div(N));
        const b = parts.basis(dk);
        const fu = dot(lp, b.right).div(R0.mul(2)).add(0.5);
        const fv = float(0.5).sub(dot(lp, b.up).div(R0.mul(2)));
        vFrame[k].assign(vec4(fu, fv, vx.mul(N).add(cell.x), vy.mul(N).add(cell.y)));
      }
      vW.assign(vec4(float(1).sub(f.x).mul(float(1).sub(f.y)), f.x.mul(float(1).sub(f.y)), float(1).sub(f.x).mul(f.y), f.x.mul(f.y)));
      {
        // nearest frame: the cell the view direction falls in (rounded g)
        const cn = clamp(floor(g.add(0.5)), vec2(0), vec2(N - 1));
        const dk = parts.decode(cn.x.add(0.5).div(N), cn.y.add(0.5).div(N));
        const b = parts.basis(dk);
        vFrameN.assign(vec4(dot(lp, b.right).div(R0.mul(2)).add(0.5), float(0.5).sub(dot(lp, b.up).div(R0.mul(2))), vx.mul(N).add(cn.x), vy.mul(N).add(cn.y)));
      }
      vRotCS.assign(vec2(c, s));
      // lighting terms come from the scatter compute (per tree); sun visibility interpolated over the quad height
      vMisc.assign(vec4(d1.y, d1.z, length(cameraPosition.sub(C)), mix(lit.sunBase, lit.sunTop, positionLocal.y.mul(0.5).add(0.5))));
      vApS.assign(lit.S);
      vApT.assign(lit.T);
      vSkyVis.assign(lit.sky);
      vBounce.assign(lit.bounce);
      return world;
    })();

    const atlasUV = (fr: any) => clamp(fr.xy, 0.002, 0.998).add(fr.zw).mul(cellSize);
    const impAlpha = property('float', 'impCoverage');
    const colorFn = (allowDiscard: boolean) => Fn(() => {
      const albedo = vec4(0).toVar();
      const nrm = vec3(0).toVar();
      // gradients from frame 0 (continuous), valid for all frames (same scale)
      const gx = dFdx(vFrame[0].xy).mul(cellSize);
      const gy = dFdy(vFrame[0].xy).mul(cellSize);
      If(vMisc.z.lessThan(this.uBlendDist), () => {
        for (let k = 0; k < 4; k++) {
          const w = vW.element(k);
          const uvk = atlasUV(vFrame[k]);
          albedo.addAssign(texture(atlas.albedo, uvk).grad(gx, gy).mul(w));
          nrm.addAssign(texture(atlas.normal, uvk).grad(gx, gy).xyz.mul(w));
        }
      }).Else(() => {
        // stochastic frame by weight: TAA integrates the blend; one texture pair per fragment
        const noise = mix(float(0.5), interleavedGradientNoise(screenCoordinate.xy.add(vec2(vMisc.y.mul(37.0), vMisc.y.mul(11.0)))), this.uStochastic);
        const c1 = vW.x, c2 = c1.add(vW.y), c3 = c2.add(vW.z);
        const fr = select(noise.lessThan(c1), vFrame[0], select(noise.lessThan(c2), vFrame[1], select(noise.lessThan(c3), vFrame[2], vFrame[3])));
        const uvk = atlasUV(fr);
        albedo.assign(texture(atlas.albedo, uvk).grad(gx, gy));
        // most fragments of a quad are transparent: reject before the normal fetch
        if (allowDiscard) If(albedo.a.lessThan(this.uEarlyDiscard), () => Discard());
        nrm.assign(texture(atlas.normal, uvk).grad(gx, gy).xyz);
      });
      impAlpha.assign(albedo.a);
      const cs = vRotCS;
      const nl = normalize(nrm.mul(2).sub(1));
      const n = vec3(cs.x.mul(nl.x).add(cs.y.mul(nl.z)), nl.y, cs.y.negate().mul(nl.x).add(cs.x.mul(nl.z)));
      const variation = mix(float(0.88), float(1.12), vMisc.y);
      const a = albedo.rgb.mul(variation);
      const wrap = max(dot(n, sunUniforms.dir).add(0.25).div(1.25), 0);
      const irr = sunUniforms.color.mul(wrap).mul(vMisc.w).add(atmo.skyIrradiance(n).mul(0.85).mul(vSkyVis)).add(vBounce);
      return vec4(a.mul(irr).mul(1 / Math.PI).mul(vApT).add(vApS), 1);
    })();
    m.colorNode = colorFn(true);
    m.opacityNode = impAlpha.mul(fadeVisible(vMisc.x));
    m.alphaTest = 0.5;

    // depth pre-pass (forest.impostorPrepass): alpha-tested depth from the dominant frame, drawn before the terrain,
    // then shading with EQUAL depth and no discard -> the GPU's hidden-surface removal works for the impostors and
    // for the terrain hidden behind the forest
    const dm = new THREE.MeshBasicNodeMaterial();
    dm.fog = false;
    dm.colorWrite = false;
    dm.userData.invariantPosition = true;
    dm.positionNode = m.positionNode;
    dm.colorNode = vec4(0, 0, 0, 1);
    dm.opacityNode = texture(atlas.albedo, atlasUV(vFrameN)).a.mul(fadeVisible(vMisc.x));
    dm.alphaTest = 0.5;
    this.impostorDepthMaterial = dm;
    const meq = new THREE.MeshBasicNodeMaterial();
    meq.fog = false;
    meq.userData.invariantPosition = true;
    meq.positionNode = m.positionNode;
    meq.colorNode = colorFn(false);
    meq.depthFunc = THREE.NotEqualDepth; // = EQUAL under reversed depth (three r186 mapping, see tree-materials.ts)
    meq.depthWrite = false;
    this.impostorEqualMaterial = meq;

    // debug: same geometry, trivial fragment (measures vertex + raster cost)
    const flat = new THREE.MeshBasicNodeMaterial();
    flat.fog = false;
    flat.positionNode = m.positionNode;
    flat.colorNode = vec4(0.1, 0.3, 0.1, 1);
    this.impostorFlatMaterial = flat;
    this.impostorMaterial = m;
    return m;
  }
  impostorFlatMaterial!: THREE.Material;
  impostorDepthMaterial!: THREE.Material;
  impostorEqualMaterial!: THREE.Material;
  impostorMaterial!: THREE.Material;

  private buildComputes() {
    const H = this.terrain.heightNode;
    const forest = this.terrain.forestNode;
    const inst = storage(this.instBuf, 'vec4', CAP_TOTAL * INST_STRIDE);
    const counters = storage(this.counters, 'uint', 16).toAtomic();
    const args = storage(this.drawArgs, 'uint', this.drawArgs.count * 5);
    const heights = uniformArray(this.trees0.map((t) => t.height));
    const radii = uniformArray(this.trees0.map((t) => Math.max(t.radius, t.height / 2)));
    const listBase = uniformArray(LIST_BASE.slice());
    const listCap = uniformArray(LIST_CAP.slice());

    const pcg = Fn(([v]: [any]) => {
      const state = v.mul(uint(747796405)).add(uint(2891336453));
      const word = state.shiftRight(state.shiftRight(uint(28)).add(uint(4))).bitXor(state).mul(uint(277803737));
      return word.shiftRight(uint(22)).bitXor(word);
    });
    const rnd = (h: any) => float(h.bitAnd(uint(0xffffff))).div(16777216);

    let light: { d2: any; d3: any; d4: any } = null!;
    const emit = (list: any, x: any, y: any, z: any, scale: any, rotv: any, fade: any, seed: any, variant: any) => {
      const slot = atomicAdd(counters.element(list), uint(1)).toVar();
      If(slot.lessThan(uint(listCap.element(list))), () => {
        const i = int(listBase.element(list)).add(int(slot)).mul(INST_STRIDE);
        inst.element(i).assign(vec4(x, y, z, scale));
        inst.element(i.add(1)).assign(vec4(rotv, fade, seed, variant));
        inst.element(i.add(2)).assign(light.d2);
        inst.element(i.add(3)).assign(light.d3);
        inst.element(i.add(4)).assign(light.d4);
      });
    };

    this.scatter = Fn(() => {
      const n = int(this.uGridN);
      const idx = int(instanceIndex);
      If(idx.greaterThanEqual(n.mul(n)), () => Return());
      const ix = int(this.uGridOrigin.x).add(idx.mod(n));
      const iz = int(this.uGridOrigin.y).add(idx.div(n));
      const h0 = pcg(uint(ix).bitXor(pcg(uint(iz).add(uint(0x9e3779b9))))).toVar();
      const h1 = pcg(h0).toVar();
      const h2 = pcg(h1).toVar();
      const h3 = pcg(h2).toVar();
      const x = float(ix).add(float(0.15).add(rnd(h0).mul(0.7))).mul(GRID);
      const z = float(iz).add(float(0.15).add(rnd(h1).mul(0.7))).mul(GRID);
      const dx = x.sub(this.uCam.x), dz = z.sub(this.uCam.z);
      const d2 = dx.mul(dx).add(dz.mul(dz));
      If(d2.greaterThan(this.uD2.mul(this.uD2)), () => Return());
      // keep probability from the forest-cover map (cheap reject before height sampling)
      const xz = vec2(x, z);
      const keep = forest(xz).mul(0.78).mul(this.uDensity);
      If(rnd(h2).greaterThan(keep), () => Return());
      const y = H(xz).toVar();
      // treeline (with noise so it is not a contour line)
      const tl = this.uTreeline.add(rnd(h3).sub(0.5).mul(260));
      If(y.greaterThan(tl), () => Return());
      // variant by altitude
      const r = rnd(pcg(h3));
      const pLarch = smoothstep(1450, 1950, y).mul(0.55);
      const pFir = float(1).sub(smoothstep(900, 1400, y)).mul(0.35);
      const variant = select(r.lessThan(pLarch), float(3), select(r.lessThan(pLarch.add(pFir)), float(2), select(r.lessThan(pLarch.add(pFir).add(0.25)), float(1), float(0)))).toVar();
      // smaller trees near the treeline
      const altScale = mix(float(1), float(0.6), smoothstep(tl.sub(300), tl, y));
      const scale = float(0.78).add(rnd(pcg(h2)).mul(0.45)).mul(altScale).toVar();
      const Ht = heights.element(int(variant)).mul(scale);
      const Rt = radii.element(int(variant)).mul(scale);
      const cx = x, cy = y.add(Ht.mul(0.5)), cz = z;
      // frustum test (sphere); near trees are also kept when their shadow (offset towards the shadow
      // direction) falls into the view, so off-screen trees still cast shadows into the image
      const inside = float(1).toVar();
      const insideShadow = float(1).toVar();
      const sx = cx.add(this.uShadowOffset.x), sz = cz.add(this.uShadowOffset.y), sy = cy.sub(Ht.mul(0.5));
      for (let p = 0; p < 6; p++) {
        const pl = this.uPlanes.element(p);
        If(pl.x.mul(cx).add(pl.y.mul(cy)).add(pl.z.mul(cz)).add(pl.w).lessThan(Rt.negate()), () => inside.assign(0));
        If(pl.x.mul(sx).add(pl.y.mul(sy)).add(pl.z.mul(sz)).add(pl.w).lessThan(Rt.negate()), () => insideShadow.assign(0));
      }
      const camD2 = dx.mul(dx).add(dz.mul(dz));
      const nearCaster = camD2.lessThan(this.uD1.mul(this.uD1)).and(insideShadow.greaterThan(0.5));
      If(inside.lessThan(0.5).and(nearCaster.not()), () => Return());
      const dist = length(vec3(cx, cy, cz).sub(this.uCam));
      const rotv = rnd(pcg(h1)).mul(6.2831853);
      const seed = rnd(pcg(h0));
      const vi = int(variant);
      // distance thinning: far away keep ~half of the trees and enlarge the survivors (same visual coverage,
      // much less overdraw); removal is dithered per tree so nothing pops
      // adaptive detail: thinning starts closer under load (uThin: start, end, kept fraction)
      const keepP = mix(float(1), this.uThin.z, smoothstep(this.uThin.x, this.uThin.y, dist));
      const rThin = rnd(pcg(h3.add(uint(77))));
      const thinFade = smoothstep(keepP.sub(0.05), keepP.add(0.05), rThin);
      If(thinFade.greaterThan(0.999), () => Return());
      // enlarge survivors so the canopy coverage stays the same (area ~ 1/keepP)
      scale.mulAssign(float(1).div(sqrt(keepP)).mul(0.92).max(1));
      // per-tree lighting (replaces per-vertex evaluation in the foliage / bark / impostor shaders):
      // sun visibility (heightfield incl. forest canopy, clouds) near the base and at the top, aerial perspective
      // and sky visibility at the crown centre
      {
        const hk = lightingHooks;
        const Hs = heights.element(vi).mul(scale);
        const sunBase = hk.sunVisibilityAt ? hk.sunVisibilityAt(vec3(x, y.add(Hs.mul(0.15)), z), this.uCam) : float(1);
        const sunTop = hk.sunVisibilityAt ? hk.sunVisibilityAt(vec3(x, y.add(Hs), z), this.uCam) : float(1);
        const C = vec3(x, y.add(Hs.mul(0.5)), z);
        const clip = this.uViewProj.mul(vec4(C, 1));
        const ndc = clip.xy.div(max(abs(clip.w), 1e-3));
        const suv = clamp(vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))), vec2(0), vec2(1));
        const ap = this.atmosphere.aerialPerspective(C, suv, this.uCam);
        const sky = hk.skyVisAt ? hk.skyVisAt(vec2(x, z)) : float(1);
        const gi = hk.bounceAt ? hk.bounceAt(vec2(x, z)) : vec3(0);
        light = { d2: vec4(ap.S, sky).toVar(), d3: vec4(ap.T, packSun(sunBase, sunTop)).toVar(), d4: vec4(gi, 0).toVar() };
      }
      const L0 = vi, L1 = vi.add(NV);
      // band index as float math (select() on int nodes mis-typed here), then converted once
      const band = step(IMP_BANDS[0], dist).add(step(IMP_BANDS[1], dist)).add(step(IMP_BANDS[2], dist));
      const LI = int(float(2 * NV).add(band)).toVar();
      const w0 = this.uD0.mul(0.12), w1 = this.uD1.mul(0.12), w2 = this.uD2.mul(0.1);
      If(dist.lessThan(this.uD0.sub(w0)), () => {
        emit(L0, x, y, z, scale, rotv, float(0), seed, variant);
      }).ElseIf(dist.lessThan(this.uD0.add(w0)), () => {
        const k = dist.sub(this.uD0.sub(w0)).div(w0.mul(2));
        emit(L0, x, y, z, scale, rotv, k, seed, variant);
        emit(L1, x, y, z, scale, rotv, k.add(1), seed, variant);
      }).ElseIf(dist.lessThan(this.uD1.sub(w1)), () => {
        emit(L1, x, y, z, scale, rotv, float(0), seed, variant);
      }).ElseIf(dist.lessThan(this.uD1.add(w1)), () => {
        const k = dist.sub(this.uD1.sub(w1)).div(w1.mul(2));
        emit(L1, x, y, z, scale, rotv, k, seed, variant);
        emit(LI, x, y, z, scale, rotv, k.add(1), seed, variant);
      }).ElseIf(dist.lessThan(this.uD2.sub(w2)), () => {
        emit(LI, x, y, z, scale, rotv, min(thinFade, 0.999), seed, variant);
      }).Else(() => {
        const k = dist.sub(this.uD2.sub(w2)).div(w2);
        emit(LI, x, y, z, scale, rotv, min(max(k, thinFade), 0.999), seed, variant);
      });
    })().compute(1).setName('forestScatter');

    // write instance counts into every draw entry, then reset the counters for the next frame
    const entryList = uniformArray(this.draws.map((d) => d.list));
    const nEntries = this.draws.length;
    this.finalize = Fn(() => {
      const e = int(instanceIndex);
      If(e.lessThan(nEntries), () => {
        const list = int(entryList.element(e));
        const c = atomicAdd(counters.element(list), uint(0));
        args.element(e.mul(5).add(1)).assign(min(c, uint(listCap.element(list))));
      });
      // barrier-free reset: only after all entries were written in this dispatch -> done by a second dispatch
    })().compute(nEntries).setName('forestFinalize');
    this.reset = Fn(() => {
      If(int(instanceIndex).lessThan(NLIST), () => {
        atomicStore(counters.element(instanceIndex), uint(0));
      });
    })().compute(NLIST).setName('forestReset');
  }
  private reset!: THREE.ComputeNode;
  // CPU cost: three spends ~40 us of JS per draw and per pass, and many indirect draws are empty (variant absent
  // here, impostor band out of view). Instance counts are read back asynchronously; a list empty in the last two
  // readbacks is not submitted (its trees enter through dithered cross-fades, so a 1-2 frame delay is invisible).
  private readback = new THREE.ReadbackBuffer(1024);
  private readPending = false;
  private emptyStreak = new Uint8Array(64);
  forestCulledDraws = 0;
  private lastMeshShading = 'full';

  update(_ctx: FrameContext) {
    const s = forestSettings;
    windUniforms.strength.value = s.wind;
    sunUniforms.dir.value.copy(this.atmosphere.sunLight.position).sub(this.atmosphere.sunLight.target.position).normalize();
    sunUniforms.color.value.copy(this.atmosphere.sunLight.color).multiplyScalar(this.atmosphere.sunLight.intensity);
    if (!s.enabled) return;
    if (this.lastMeshShading !== s.debugMeshShading) {
      this.lastMeshShading = s.debugMeshShading;
      for (const d of this.draws) {
        if (d.list >= 2 * NV || d.mesh.userData.pass !== 'color') continue;
        d.mesh.receiveShadow = s.debugMeshShading !== 'noShadow' && s.debugMeshShading !== 'basic';
        (d.mesh.material as any).fog = s.debugMeshShading !== 'noFog' && s.debugMeshShading !== 'basic';
        (d.mesh.material as THREE.Material).needsUpdate = true;
      }
    }
    const pre = s.foliagePrepass;
    for (const d of this.draws) {
      const isImp = d.list >= 2 * NV;
      const u = d.mesh.userData;
      let on = true;
      if (isImp && u.pass === 'color') d.mesh.material = s.debugFlatImpostors ? this.impostorFlatMaterial : s.impostorPrepass ? this.impostorEqualMaterial : this.impostorMaterial;
      if (isImp && u.pass === 'depth') on = s.impostorPrepass && !s.debugFlatImpostors;
      if (u.alt) {
        // foliage colour pass: EQUAL-depth variant after the pre-pass; the depth pass then casts the shadow
        d.mesh.material = pre ? u.alt.prepassed : u.alt.normal;
        d.mesh.castShadow = u.casts && !pre;
      } else if (!isImp && u.pass === 'depth') {
        on = pre;
        d.mesh.castShadow = pre && u.castsPre;
      }
      if (forestSettings.skipEmptyDraws && this.emptyStreak[d.list] >= 2) on = false;
      d.mesh.visible = on && (s.debugDraw === 'all' || (s.debugDraw === 'impostors' && isImp) || (s.debugDraw === 'meshes' && !isImp));
    }
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this.uCam.value.copy(cam.position);
    this.uDensity.value = s.density;
    // adaptive detail (core/adaptive.ts) shortens the mesh LOD distances under load
    const d0 = qualityScaled(s.lod0Distance, 0.75), d1 = qualityScaled(s.lod1Distance, 0.65);
    this.uThin.value.set(qualityScaled(600, 0.5), qualityScaled(1500, 0.65), 0.3 + 0.12 * adaptive.quality);
    this.uD0.value = d0;
    this.uD1.value = Math.max(d1, d0 * 1.3);
    this.uD2.value = s.maxDistance;
    this.uTreeline.value = s.treeline;
    // horizontal offset of a tree's shadow (towards -sun), capped
    {
      const sd = sunUniforms.dir.value;
      const horiz = Math.hypot(sd.x, sd.z);
      const len = Math.min(45, 25 / Math.max(sd.y / Math.max(horiz, 1e-3), 0.3));
      this.uShadowOffset.value.set(horiz > 1e-3 ? (-sd.x / horiz) * len : 0, horiz > 1e-3 ? (-sd.z / horiz) * len : 0);
    }
    this.uBlendDist.value = s.impostorBlendDistance;
    this.uStochastic.value = s.impostorStochastic ? 1 : 0;
    this.uEarlyDiscard.value = s.impostorEarlyDiscard ? 0.5 : -1;
    const D = s.maxDistance;
    const gx0 = Math.floor((cam.position.x - D) / GRID);
    const gz0 = Math.floor((cam.position.z - D) / GRID);
    this.gridN = Math.ceil((2 * D) / GRID) + 1;
    this.uGridOrigin.value.set(gx0, gz0);
    this.uGridN.value = this.gridN;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.uViewProj.value.copy(this.projView);
    this.frustum.setFromProjectionMatrix(this.projView, THREE.WebGPUCoordinateSystem, (cam as any).reversedDepth === true);
    for (let i = 0; i < 6; i++) {
      const p = this.frustum.planes[i];
      this.uPlanes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    }
    const r = this.engine.renderer;
    (this.scatter as any).count = this.gridN * this.gridN;
    // one encoder / one submission for the three passes (each submit can block on a busy GPU queue)
    r.compute([this.reset, this.scatter, this.finalize] as any);
    if (!this.readPending && forestSettings.skipEmptyDraws) {
      this.readPending = true;
      r.getArrayBufferAsync(this.drawArgs, this.readback as any)
        .then((rb: any) => {
          const a = new Uint32Array(rb.buffer);
          const count = new Uint32Array(64);
          for (const d of this.draws) count[d.list] = Math.max(count[d.list], a[d.mesh.userData.drawEntry * 5 + 1]);
          for (let l = 0; l < 64; l++) this.emptyStreak[l] = count[l] === 0 ? Math.min(255, this.emptyStreak[l] + 1) : 0;
          this.readback.release();
        })
        .catch(() => {})
        .finally(() => (this.readPending = false));
    }
  }
}

void dot; void sqrt; void max; void atomicStore;
