// Post-processing pipeline: scene pass at reduced internal resolution (MRT: color + velocity)
// -> TAAU (temporal anti-aliasing + upscale to output resolution) -> sharpen -> tone mapping (AgX).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity, uniform, float, vec3, vec4, rtt, uv, Fn } from 'three/tsl';
import type { Clouds } from '../sky/clouds';
import { cloudSettings } from '../sky/clouds';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { taauLite } from './taau-lite';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import type { Engine, System, FrameContext } from '../core/engine';
import { renderSettings } from '../core/engine';
import { settings } from '../core/settings';
import { DynamicResolution } from './dynamic-resolution';
import { adaptive } from '../core/adaptive';

/** Late-bound passes provided by other systems (built at first render, after every system is initialised). */
export const postHooks: { waterReflection: ((depth: any, wmask: any) => any) | null } = { waterReflection: null };

export const postSettings = settings.group('post', 'Post-processing', {
  upscaler: { value: 'lite', options: { 'TAAU lite (fast)': 'lite', 'TAAU three.js': 'taau', 'Bilinear': 'bilinear' }, label: 'Upscaling' },
  sharpen: { value: 0.25, min: 0, max: 1.5, step: 0.05, label: 'Sharpen' },
  exposure: { value: 1, min: 0.05, max: 8, step: 0.01, label: 'Exposure' },
  toneMapping: { value: 'aces', options: { AgX: 'agx', ACES: 'aces', Neutral: 'neutral' }, label: 'Tone mapping' },
  bloom: { value: 0.06, min: 0, max: 0.5, step: 0.005, label: 'Bloom' },
  bloomThreshold: { value: 1.6, min: 0.2, max: 10, step: 0.1, label: 'Bloom threshold' },
  lensflare: { value: 0.3, min: 0, max: 3, step: 0.05, label: 'Lens flare' },
});

const TONE: Record<string, THREE.ToneMapping> = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
};

export class Post implements System {
  readonly name = 'post';
  scenePass!: ReturnType<typeof pass>;
  private engine!: Engine;
  private taauNode: any;
  private sharpenNode: any;
  private liteNode: any;
  private liteOut: any;
  private dyn!: DynamicResolution;
  private resizeClouds: (s: number) => void = () => {};
  /** Cloud march resolution factor under load (two levels: a continuous change would reallocate every frame). */
  private cloudFactor = 1;
  private uSharpen = uniform(0.25);

  constructor(private clouds: Clouds | null = null) {}

  init(engine: Engine) {
    this.engine = engine;
    const r = engine.renderer;
    r.toneMapping = TONE[postSettings.toneMapping] ?? THREE.AgXToneMapping;
    r.toneMappingExposure = postSettings.exposure;

    const pipeline = new THREE.RenderPipeline(r);
    const scenePass = pass(engine.scene, engine.camera);
    scenePass.setResolutionScale(renderSettings.resolutionScale);
    // wmask: water reflection weight + calm normal written by the terrain material (rgba8)
    scenePass.setMRT(mrt({ output, velocity, wmask: vec4(0) }));
    (scenePass as any).getTexture('wmask').type = THREE.UnsignedByteType;
    this.scenePass = scenePass;

    const sceneColor = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');
    // volumetric clouds at reduced resolution, composited over the scene at internal resolution
    let color: any = sceneColor;
    if (this.clouds) {
      const cloudTex: any = rtt(this.clouds.marchNode(depth, engine.camera), null, null, { type: THREE.HalfFloatType, depthBuffer: false });
      cloudTex.setResolutionScale(renderSettings.resolutionScale * cloudSettings.resolution);
      // water reflections at half internal resolution (lighting/water-reflection.ts), weighted at full resolution
      const wmask = scenePass.getTextureNode('wmask');
      const reflTex: any = rtt(Fn(() => (postHooks.waterReflection ? postHooks.waterReflection(depth, wmask) : vec4(0)))(), null, null, { type: THREE.HalfFloatType, depthBuffer: false });
      reflTex.setResolutionScale(renderSettings.resolutionScale * 0.5);
      const comp: any = rtt(Fn(() => {
        const c = sceneColor.sample(uv());
        const cl = cloudTex.sample(uv());
        const w = wmask.sample(uv()).r;
        const surface = c.rgb.add(reflTex.sample(uv()).rgb.mul(w));
        return vec4(surface.mul(cl.a).add(cl.rgb), 1);
      })(), null, null, { type: THREE.UnsignedInt101111Type, format: THREE.RGBFormat, depthBuffer: false });
      comp.setResolutionScale(renderSettings.resolutionScale);
      color = comp;
      const resize = () => {
        cloudTex.setResolutionScale(renderSettings.resolutionScale * cloudSettings.resolution);
        comp.setResolutionScale(renderSettings.resolutionScale);
      };
      this.resizeClouds = (s: number) => {
        cloudTex.setResolutionScale(s * cloudSettings.resolution * this.cloudFactor);
        reflTex.setResolutionScale(s * 0.5);
        comp.setResolutionScale(s);
      };
      settings.on('clouds.resolution', () => this.resizeClouds(this.dyn.state.scale));
      void resize;
    }
    this.taauNode = taau(color, depth, vel, engine.camera);
    this.sharpenNode = sharpen(this.taauNode.getTextureNode(), postSettings.sharpen);
    this.liteNode = taauLite(color, vel, engine.camera, depth);
    this.uSharpen.value = postSettings.sharpen;
    // bloom + lens flare computed at internal resolution from the scene colour, added in the final pass
    const bloomNode: any = bloom(color, postSettings.bloom, 0.5, postSettings.bloomThreshold);
    bloomNode.setResolutionScale(0.25); // relative to the output: a soft glow does not need more
    const uFlare = uniform(postSettings.lensflare);
    const flareNode: any = lensflare(bloomNode, { threshold: uniform(0.35), ghostAttenuationFactor: uniform(28), ghostSpacing: uniform(0.22), ghostTint: vec3(0.55, 0.75, 1.0), downSampleRatio: 6 });
    this.liteOut = this.liteNode.sharpened(this.uSharpen).add(bloomNode).add(flareNode.mul(uFlare));
    settings.on('post.bloom', (v) => (bloomNode.strength.value = v));
    settings.on('post.bloomThreshold', (v) => (bloomNode.threshold.value = v));
    settings.on('post.lensflare', (v) => (uFlare.value = v as number));
    void float;

    engine.pipeline = pipeline;
    this.rebuild();

    // dynamic resolution drives the internal scale (renderSettings.resolutionScale is its maximum)
    this.dyn = new DynamicResolution(
      (s) => {
        scenePass.setResolutionScale(s);
        this.resizeClouds(s);
      },
      (f) => {
        adaptive.outputScale = f;
        engine.resize();
      },
    );
    settings.on('render.resolutionScale', () => this.dyn.reset());
    settings.on('render.dynamicResolution', () => this.dyn.reset());
    settings.on('render.minResolutionScale', () => this.dyn.reset());
    settings.on('post.sharpen', (v) => {
      this.sharpenNode.sharpness.value = v;
      this.uSharpen.value = v as number;
      this.rebuild();
    });
    settings.on('post.upscaler', () => this.rebuild());
    settings.on('post.exposure', (v) => (r.toneMappingExposure = v as number));
    settings.on('post.toneMapping', (v) => {
      r.toneMapping = TONE[v as string] ?? THREE.AgXToneMapping;
      this.engine.pipeline.needsUpdate = true;
    });
  }

  update(ctx: FrameContext) {
    this.dyn.update(ctx.intervalMs);
    adaptive.scale = this.dyn.state.scale;
    adaptive.capped = this.dyn.state.capped;
    adaptive.quality = renderSettings.forceDetail >= 0 ? renderSettings.forceDetail : this.dyn.state.quality;
    const cf = adaptive.quality < 0.5 ? 0.75 : 1;
    if (cf !== this.cloudFactor) {
      this.cloudFactor = cf;
      this.resizeClouds(this.dyn.state.scale);
    }
  }

  private rebuild() {
    const p = this.engine.pipeline;
    if (postSettings.upscaler === 'lite') p.outputNode = this.liteOut;
    else if (postSettings.upscaler === 'taau') p.outputNode = postSettings.sharpen > 0 ? this.sharpenNode : this.taauNode;
    else p.outputNode = this.scenePass;
    p.needsUpdate = true;
  }
}
