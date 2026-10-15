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
import type { Engine, System } from '../core/engine';
import { renderSettings } from '../core/engine';
import { settings } from '../core/settings';

export const postSettings = settings.group('post', 'Post-traitement', {
  upscaler: { value: 'lite', options: { 'TAAU léger (rapide)': 'lite', 'TAAU three.js': 'taau', 'Bilinéaire': 'bilinear' }, label: 'Upscaling' },
  sharpen: { value: 0.25, min: 0, max: 1.5, step: 0.05, label: 'Netteté' },
  exposure: { value: 1, min: 0.05, max: 8, step: 0.01, label: 'Exposition' },
  toneMapping: { value: 'aces', options: { AgX: 'agx', ACES: 'aces', Neutral: 'neutral' }, label: 'Tone mapping' },
  bloom: { value: 0.06, min: 0, max: 0.5, step: 0.005, label: 'Bloom' },
  bloomThreshold: { value: 1.6, min: 0.2, max: 10, step: 0.1, label: 'Seuil bloom' },
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
    scenePass.setMRT(mrt({ output, velocity }));
    this.scenePass = scenePass;

    const sceneColor = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');
    // volumetric clouds at reduced resolution, composited over the scene at internal resolution
    let color: any = sceneColor;
    if (this.clouds) {
      const cloudTex: any = rtt(this.clouds.marchNode(depth), null, null, { type: THREE.HalfFloatType, depthBuffer: false });
      cloudTex.setResolutionScale(renderSettings.resolutionScale * cloudSettings.resolution);
      const comp: any = rtt(Fn(() => {
        const c = sceneColor.sample(uv());
        const cl = cloudTex.sample(uv());
        return vec4(c.rgb.mul(cl.a).add(cl.rgb), 1);
      })(), null, null, { type: THREE.UnsignedInt101111Type, format: THREE.RGBFormat, depthBuffer: false });
      comp.setResolutionScale(renderSettings.resolutionScale);
      color = comp;
      const resize = () => {
        cloudTex.setResolutionScale(renderSettings.resolutionScale * cloudSettings.resolution);
        comp.setResolutionScale(renderSettings.resolutionScale);
      };
      settings.on('render.resolutionScale', resize);
      settings.on('clouds.resolution', resize);
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

    settings.on('render.resolutionScale', (v) => scenePass.setResolutionScale(v as number));
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

  private rebuild() {
    const p = this.engine.pipeline;
    if (postSettings.upscaler === 'lite') p.outputNode = this.liteOut;
    else if (postSettings.upscaler === 'taau') p.outputNode = postSettings.sharpen > 0 ? this.sharpenNode : this.taauNode;
    else p.outputNode = this.scenePass;
    p.needsUpdate = true;
  }
}
