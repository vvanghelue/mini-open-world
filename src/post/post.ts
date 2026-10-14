// Post-processing pipeline: scene pass at reduced internal resolution (MRT: color + velocity)
// -> TAAU (temporal anti-aliasing + upscale to output resolution) -> sharpen -> tone mapping (AgX).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity, uniform } from 'three/tsl';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { taauLite } from './taau-lite';
import type { Engine, System } from '../core/engine';
import { renderSettings } from '../core/engine';
import { settings } from '../core/settings';

export const postSettings = settings.group('post', 'Post-traitement', {
  upscaler: { value: 'lite', options: { 'TAAU léger (rapide)': 'lite', 'TAAU three.js': 'taau', 'Bilinéaire': 'bilinear' }, label: 'Upscaling' },
  sharpen: { value: 0.25, min: 0, max: 1.5, step: 0.05, label: 'Netteté' },
  exposure: { value: 1, min: 0.05, max: 8, step: 0.01, label: 'Exposition' },
  toneMapping: { value: 'aces', options: { AgX: 'agx', ACES: 'aces', Neutral: 'neutral' }, label: 'Tone mapping' },
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

    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');
    this.taauNode = taau(color, depth, vel, engine.camera);
    this.sharpenNode = sharpen(this.taauNode.getTextureNode(), postSettings.sharpen);
    this.liteNode = taauLite(color, vel, engine.camera);
    this.uSharpen.value = postSettings.sharpen;
    this.liteOut = this.liteNode.sharpened(this.uSharpen);

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
