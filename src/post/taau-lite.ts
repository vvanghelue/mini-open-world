// @ts-nocheck -- TSL/TempNode typings are incomplete
// Lightweight temporal anti-aliasing + upscaling (TAAU), tuned for bandwidth on Apple GPUs.
// Compared to three's TAAUNode: one output-resolution resolve pass with 5 cross taps (no 9-tap kernel,
// no depth dilation, no lock buffer), ping-pong history (no full-resolution copies), and sharpening done
// inline by the final output pass (see `sharpened()`), so the whole upscale costs 2 full-screen passes.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec4, ivec2, uv, uniform, texture, exp, max, min, mix, clamp, luminance, OnBeforeRenderPipeline,
  OnAfterRenderPipeline, velocity, nodeObject, convertToTexture, passTexture, context, If,
} from 'three/tsl';

const _size = new THREE.Vector2();
const _quad = new THREE.QuadMesh();

// Halton(2,3) sequence, 16 samples
const HALTON: Array<[number, number]> = [];
{
  const h = (i: number, b: number) => {
    let f = 1, r = 0;
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
    return r;
  };
  for (let i = 1; i <= 16; i++) HALTON.push([h(i, 2), h(i, 3)]);
}

export class TAAULiteNode extends THREE.TempNode {
  static get type() {
    return 'TAAULiteNode';
  }

  beautyNode: any;
  velocityNode: any;
  camera: THREE.Camera;
  currentWeight = uniform(0.06);
  private jitter = uniform(new THREE.Vector2());
  private jitterIndex = 0;
  private history: [THREE.RenderTarget, THREE.RenderTarget];
  private read = 0;
  private historyTex: any;
  private resolveMaterial = new THREE.NodeMaterial();
  private outputTex: any;
  private originalProjection = new THREE.Matrix4();
  private needsReset = true;
  private hooked = false;

  depthNode: any;
  /** maps current (unjittered) NDC of a direction at infinity to previous-frame clip space */
  private uSkyReproj = uniform(new THREE.Matrix4());
  private prevVP = new THREE.Matrix4();
  private curVP = new THREE.Matrix4();
  private havePrev = false;

  constructor(beautyNode: any, velocityNode: any, camera: THREE.Camera, depthNode: any = null) {
    super('vec4');
    this.beautyNode = beautyNode;
    this.velocityNode = velocityNode;
    this.depthNode = depthNode;
    this.camera = camera;
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    // packed HDR history (rg11b10ufloat, 4 bytes/pixel): halves the bandwidth of the full-resolution passes
    const mk = () => new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.UnsignedInt101111Type, format: THREE.RGBFormat });
    this.history = [mk(), mk()];
    this.historyTex = texture(this.history[0].texture);
    this.outputTex = passTexture(this as any, this.history[1].texture);
    this.resolveMaterial.name = 'TAAULite.resolve';
  }

  getTextureNode() {
    return this.outputTex;
  }

  /** History colour with a 5-tap contrast-adaptive sharpen (evaluate in the final output pass). */
  sharpened(amount: any) {
    const tex = this.outputTex;
    return Fn(() => {
      const c = tex.sample(uv());
      const size = vec2(tex.size(0));
      const px = vec2(1).div(size);
      const n = tex.sample(uv().add(vec2(0, px.y.negate()))).rgb;
      const s = tex.sample(uv().add(vec2(0, px.y))).rgb;
      const e = tex.sample(uv().add(vec2(px.x, 0))).rgb;
      const w = tex.sample(uv().add(vec2(px.x.negate(), 0))).rgb;
      const mn = min(min(min(n, s), min(e, w)), c.rgb);
      const mx = max(max(max(n, s), max(e, w)), c.rgb);
      // RCAS-like adaptive weight: less sharpening where local contrast is already high
      const peak = float(1).div(max(mx.g, 1e-4));
      const amp = clamp(min(mn.g, float(1).sub(mx.g).max(0)).mul(peak), 0, 1).sqrt();
      const wgt = amp.mul(float(-0.125).mul(amount));
      const outc = c.rgb.add(n.add(s).add(e).add(w).mul(wgt)).div(wgt.mul(4).add(1));
      return vec4(max(outc, 0), c.a);
    })();
  }

  private setViewOffset(inW: number, inH: number) {
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.updateProjectionMatrix();
    this.originalProjection.copy(cam.projectionMatrix);
    // sky reprojection: rotation-only view-projection (directions at infinity ignore translation)
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorldInverse);
    this.curVP.multiplyMatrices(this.originalProjection, rot);
    if (!this.havePrev) this.prevVP.copy(this.curVP);
    this.uSkyReproj.value.multiplyMatrices(this.prevVP, new THREE.Matrix4().copy(this.curVP).invert());
    this.prevVP.copy(this.curVP);
    this.havePrev = true;
    (velocity as any).setProjectionMatrix(this.originalProjection);
    const [hx, hy] = HALTON[this.jitterIndex];
    const jx = hx - 0.5, jy = hy - 0.5;
    this.jitter.value.set(jx, jy);
    cam.setViewOffset(inW, inH, jx, jy, inW, inH);
  }

  private clearViewOffset() {
    (this.camera as THREE.PerspectiveCamera).clearViewOffset();
    (velocity as any).setProjectionMatrix(null);
    this.jitterIndex = (this.jitterIndex + 1) % HALTON.length;
  }

  private inputRT() {
    return this.beautyNode.isRTTNode ? this.beautyNode.renderTarget : this.beautyNode.passNode.renderTarget;
  }

  updateBefore(frame: any) {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const size = renderer.getDrawingBufferSize(_size);
    const [a, b] = this.history;
    if (a.width !== size.width || a.height !== size.height) {
      a.setSize(size.width, size.height);
      b.setSize(size.width, size.height);
      this.needsReset = true;
    }
    // ping-pong: read history[read], write history[1 - read]
    const src = this.history[this.read];
    const dst = this.history[1 - this.read];
    this.historyTex.value = src.texture;
    this.outputTex.value = dst.texture;
    this.currentWeightReset = this.needsReset ? 1 : 0;
    this.uReset.value = this.needsReset ? 1 : 0;
    this.needsReset = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(dst);
    _quad.material = this.resolveMaterial;
    _quad.render(renderer);
    renderer.setRenderTarget(prev);
    this.read = 1 - this.read;
  }
  private uReset = uniform(1);
  private currentWeightReset = 1;

  setup(builder: any) {
    if (!this.hooked && builder.renderPipeline) {
      this.hooked = true;
      OnBeforeRenderPipeline(() => {
        const rt = this.inputRT();
        this.setViewOffset(rt.texture.width, rt.texture.height);
      });
      OnAfterRenderPipeline(() => this.clearViewOffset());
    }
    const beauty = this.beautyNode;
    const vel = this.velocityNode;
    const hist = this.historyTex;
    const resolve = Fn(() => {
      const uvo = uv();
      const inSize = vec2(beauty.size());
      const pIn = uvo.mul(inSize);
      const tapF = pIn.sub(vec2(0.5).add(this.jitter)).round();
      const tap = ivec2(tapF);
      const sum = vec4(0).toVar();
      const wsum = float(0).toVar();
      const mn = vec4(1e5).toVar();
      const mx = vec4(-1e5).toVar();
      for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = tap.add(ivec2(x, y));
        const center = vec2(t).add(vec2(0.5).add(this.jitter));
        const d = pIn.sub(center);
        const w = exp(d.dot(d).mul(-2.29));
        const c = beauty.load(t).max(0);
        // Karis weighting: tame HDR fireflies before accumulation
        const kw = w.div(luminance(c.rgb).add(1));
        sum.addAssign(c.mul(kw));
        wsum.addAssign(kw);
        mn.assign(min(mn, c));
        mx.assign(max(mx, c));
      }
      const current = sum.div(wsum.max(1e-6));
      const v = vel.load(tap).xy.mul(vec2(0.5, -0.5)).toVar();
      if (this.depthNode) {
        // sky pixels have no motion vectors: reproject the view direction with the camera rotation
        const dsky = this.depthNode.load(tap).r;
        If(dsky.lessThanEqual(0.0000001), () => {
          const ndc = vec2(uvo.x.mul(2).sub(1), float(1).sub(uvo.y.mul(2)));
          const prev = this.uSkyReproj.mul(vec4(ndc, 0.0, 1));
          const pndc = prev.xy.div(prev.w);
          const puv = vec2(pndc.x.mul(0.5).add(0.5), float(0.5).sub(pndc.y.mul(0.5)));
          v.assign(uvo.sub(puv));
        });
      }
      const huv = uvo.sub(v);
      const valid = huv.greaterThanEqual(0).all().and(huv.lessThanEqual(1).all());
      const h = hist.sample(huv);
      const hc = clamp(h, mn, mx);
      const motion = v.mul(inSize).length().div(64).saturate();
      const wc = valid.select(this.currentWeight.add(motion.mul(0.5)).saturate(), float(1)).max(this.uReset);
      // blend in a tone-mapped space to reduce flicker, then return to linear
      const lc = luminance(current.rgb), lh = luminance(hc.rgb);
      const a = wc.div(lc.add(1)), b2 = float(1).sub(wc).div(lh.add(1));
      return hc.mul(b2).add(current.mul(a)).div(a.add(b2));
    });
    this.resolveMaterial.contextNode = context(builder.getSharedContext());
    this.resolveMaterial.colorNode = resolve();
    this.resolveMaterial.needsUpdate = true;
    return this.outputTex;
  }

  dispose() {
    this.history.forEach((h) => h.dispose());
    this.resolveMaterial.dispose();
    super.dispose();
  }
}

export const taauLite = (beauty: any, vel: any, camera: THREE.Camera, depth: any = null) => nodeObject(new TAAULiteNode(convertToTexture(beauty), vel, camera, depth));
