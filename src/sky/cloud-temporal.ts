// @ts-nocheck -- TSL/TempNode typings are incomplete
// Temporal accumulation of the cloud march, at cloud resolution, before the clouds are composited over the scene.
// The march starts each ray at a per-pixel offset that changes every frame. The scene TAA cannot average that noise
// away: one cloud texel covers ~2x2 internal pixels, so its 5-tap neighbourhood clamp sees a single noise value and
// pulls the history back to it (the clouds boiled, "vibrating" at their edges). Here each cloud texel is reprojected
// to the previous frame (view ray hit on the cloud layer), clamped to the 3x3 neighbourhood of the current march
// (which spans several noise offsets, so the mean survives) and blended with a small weight.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec4, uv, uniform, texture, min, max, clamp, mix, normalize, select, passTexture, nodeObject, context,
} from 'three/tsl';
import type { Clouds } from './clouds';
import { cloudSettings } from './clouds';
import { renderSettings } from '../core/engine';
import { unjitteredProjection } from '../post/taau-lite';

const _size = new THREE.Vector2();
const _quad = new THREE.QuadMesh();

export class CloudTemporalNode extends THREE.TempNode {
  static get type() {
    return 'CloudTemporalNode';
  }

  /** Weight of the current march in the blend (0.1: noise averaged over ~10 frames). */
  readonly weight = uniform(0.1);
  private history: [THREE.RenderTarget, THREE.RenderTarget];
  private read = 0;
  private historyTex: any;
  private outputTex: any;
  private resolveMaterial = new THREE.NodeMaterial();
  private uReset = uniform(1);
  private needsReset = true;
  private uCamPos = uniform(new THREE.Vector3());
  private uCamWorld = uniform(new THREE.Matrix4());
  private uProjInv = uniform(new THREE.Matrix4());
  private uPrevViewProj = uniform(new THREE.Matrix4());
  private viewProj = new THREE.Matrix4();
  private havePrev = false;

  constructor(private cloudNode: any, private clouds: Clouds, private camera: THREE.Camera) {
    super('vec4');
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    const mk = () => new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
    this.history = [mk(), mk()];
    this.historyTex = texture(this.history[0].texture);
    this.outputTex = passTexture(this as any, this.history[1].texture);
    this.resolveMaterial.name = 'CloudTemporal.resolve';
  }

  getTextureNode() {
    return this.outputTex;
  }

  updateBefore(frame: any) {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    // the history keeps the largest cloud resolution: dynamic resolution changes of the march need no reset
    const buf = renderer.getDrawingBufferSize(_size);
    const s = renderSettings.resolutionScale * cloudSettings.resolution;
    const w = Math.max(1, Math.floor(buf.width * s)), h = Math.max(1, Math.floor(buf.height * s));
    const [a, b] = this.history;
    if (a.width !== w || a.height !== h) {
      a.setSize(w, h);
      b.setSize(w, h);
      this.needsReset = true;
    }
    // the history lives in unjittered screen space (re-sampling it at the jitter offset every frame would blur it);
    // the jittered march samples fall around their texel centre and average out
    const cam = this.camera as THREE.PerspectiveCamera;
    this.uCamPos.value.copy(cam.position);
    this.uCamWorld.value.copy(cam.matrixWorld);
    this.uProjInv.value.copy(unjitteredProjection).invert();
    this.uPrevViewProj.value.copy(this.havePrev ? this.viewProj : this.viewProj.multiplyMatrices(unjitteredProjection, cam.matrixWorldInverse));
    this.viewProj.multiplyMatrices(unjitteredProjection, cam.matrixWorldInverse);
    this.havePrev = true;
    const src = this.history[this.read];
    const dst = this.history[1 - this.read];
    this.historyTex.value = src.texture;
    this.outputTex.value = dst.texture;
    this.uReset.value = this.needsReset ? 1 : 0;
    this.needsReset = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(dst);
    _quad.material = this.resolveMaterial;
    _quad.render(renderer);
    renderer.setRenderTarget(prev);
    this.read = 1 - this.read;
  }

  setup(builder: any) {
    const cloud = this.cloudNode;
    const hist = this.historyTex;
    const c = this.clouds;
    const resolve = Fn(() => {
      const uvo = uv();
      const px = vec2(1).div(vec2(cloud.size()));
      const cur = cloud.sample(uvo);
      const mn = cur.toVar(), mx = cur.toVar();
      for (const [x, y] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        const n = cloud.sample(uvo.add(px.mul(vec2(x, y))));
        mn.assign(min(mn, n));
        mx.assign(max(mx, n));
      }
      // view ray of this texel -> where it enters the cloud layer (camera rotation reprojects exactly whatever the
      // distance; the entry point keeps the parallax of camera translation close for the visible cloud surface)
      const ndc = vec2(uvo.x.mul(2).sub(1), float(1).sub(uvo.y.mul(2)));
      const vp = this.uProjInv.mul(vec4(ndc, 0.5, 1));
      const dir = normalize(this.uCamWorld.mul(vec4(vp.xyz.div(vp.w), 0)).xyz);
      const ro = this.uCamPos;
      const y0 = c.uBase, y1 = c.uBase.add(c.uThickness);
      const dy = select(dir.y.abs().lessThan(1e-4), float(1e-4), dir.y);
      const tBase = y0.sub(ro.y).div(dy), tTop = y1.sub(ro.y).div(dy);
      const below = ro.y.lessThan(y0), above = ro.y.greaterThan(y1);
      const tEntry = select(below, tBase, select(above, tTop, c.uThickness.mul(0.3)));
      const dist = select(tEntry.greaterThan(0), tEntry, float(40000)).clamp(200, 40000);
      const prev = this.uPrevViewProj.mul(vec4(ro.add(dir.mul(dist)), 1));
      const pndc = prev.xy.div(prev.w);
      const puv = vec2(pndc.x.mul(0.5).add(0.5), float(0.5).sub(pndc.y.mul(0.5)));
      const valid = puv.greaterThanEqual(0).all().and(puv.lessThanEqual(1).all()).and(prev.w.greaterThan(0));
      const h = clamp(hist.sample(puv), mn, mx);
      const wc = select(valid, this.weight, float(1)).max(this.uReset);
      return mix(h, cur, wc);
    });
    this.resolveMaterial.contextNode = context(builder.getSharedContext());
    // fragmentNode, not colorNode: an opaque material forces the colour alpha to 1, and alpha is the transmittance
    this.resolveMaterial.fragmentNode = resolve();
    this.resolveMaterial.needsUpdate = true;
    return this.outputTex;
  }

  dispose() {
    this.history.forEach((h) => h.dispose());
    this.resolveMaterial.dispose();
    super.dispose();
  }
}

/** Temporally filtered clouds: `march` is the cloud march RTT texture node. */
export const cloudTemporal = (march: any, clouds: Clouds, camera: THREE.Camera) => nodeObject(new CloudTemporalNode(march, clouds, camera));
