import * as THREE from 'three/webgpu';
import { FrameStats } from './stats';
import { settings } from './settings';
import { adaptive } from './adaptive';

export interface FrameContext {
  dt: number; // seconds, clamped
  time: number; // seconds since start (simulation clock)
  frame: number;
  /** Measured wall-clock interval since the previous frame (ms). */
  intervalMs: number;
}

export interface System {
  readonly name: string;
  /** Called once, in registration order, before the first frame. */
  init?(engine: Engine): Promise<void> | void;
  /** Called every frame before rendering, in registration order. */
  update?(ctx: FrameContext): void;
  /** Called every frame after the render pipeline was submitted. */
  afterRender?(ctx: FrameContext): void;
}

export const renderSettings = settings.group(
  'render',
  'Rendering',
  {
    resolutionScale: { value: 0.6, min: 0.3, max: 1, step: 0.05, label: 'Internal resolution (max)', help: 'Fraction of the output resolution actually rendered (TAAU upscaling). Upper bound of the dynamic resolution.' },
    dynamicResolution: { value: true, label: 'Dynamic resolution', help: 'Lowers the internal resolution in heavy scenes to hold the target (and raises it again afterwards).' },
    targetFps: { value: 100, min: 30, max: 240, step: 5, label: 'Target (fps, without vsync)' },
    minResolutionScale: { value: 0.4, min: 0.25, max: 1, step: 0.05, label: 'Internal resolution (min)' },
    forceDetail: { value: -1, min: -1, max: 1, step: 0.05, label: 'Force detail level (debug, -1 = auto)', hidden: true },
    outputPixelRatio: { value: 1, min: 0.5, max: 2, step: 0.25, label: 'Output density', help: 'Canvas pixel ratio (1 = 1 pixel per CSS point).' },
    fov: { value: 60, min: 30, max: 100, step: 1, label: 'Field of view' },
    paused: { value: false, label: 'Pause' },
  },
  true,
);

export class Engine {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly stats = new FrameStats();
  readonly systems: System[] = [];
  pipeline!: THREE.RenderPipeline;
  readonly container: HTMLElement;

  frame = 0;
  time = 0;
  /** Optional per-frame hook used by the benchmark / agent to drive the camera deterministically. */
  driver: ((ctx: FrameContext) => void) | null = null;
  /** Fixed timestep override (seconds); used by the benchmark for reproducible paths. */
  fixedDt: number | null = null;

  private lastTs = -1;
  private gpuPending = false;
  private afterFrameCallbacks: Array<() => void> = [];

  private constructor(container: HTMLElement, requiredLimits: Record<string, number>) {
    this.container = container;
    this.renderer = new THREE.WebGPURenderer({
      antialias: false,
      reversedDepthBuffer: true,
      requiredLimits,
      // GPU timestamp queries are unreliable on Apple GPUs (overlapping passes); opt-in with ?gpuTiming
      trackTimestamp: new URLSearchParams(location.search).has('gpuTiming'),
      powerPreference: 'high-performance',
    });
    this.camera = new THREE.PerspectiveCamera(renderSettings.fov, 1, 0.2, 400000);
    this.scene.add(this.camera);
  }

  static async create(container: HTMLElement): Promise<Engine> {
    // raise the limits we rely on (terrain shaders sample many textures, vegetation uses large buffers)
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU unavailable: this project needs Chrome with WebGPU.');
    const want: Record<string, number> = {
      maxSampledTexturesPerShaderStage: 32,
      maxStorageTexturesPerShaderStage: 8,
      maxStorageBuffersPerShaderStage: 10,
      maxStorageBufferBindingSize: 512 * 1024 * 1024,
      maxBufferSize: 1024 * 1024 * 1024,
      maxTextureDimension2D: 16384,
      maxTextureArrayLayers: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
    };
    const requiredLimits: Record<string, number> = {};
    for (const [k, v] of Object.entries(want)) {
      const max = (adapter.limits as any)[k];
      if (typeof max === 'number') requiredLimits[k] = Math.min(v, max);
    }
    const engine = new Engine(container, requiredLimits);
    await engine.renderer.init();
    if (!(engine.renderer.backend as any).isWebGPUBackend) {
      throw new Error('WebGPU unavailable: this project needs Chrome with WebGPU.');
    }
    container.appendChild(engine.renderer.domElement);
    engine.stats.gpuSupported = !!(engine.renderer.backend as any).trackTimestamp;
    engine.resize();
    window.addEventListener('resize', () => engine.resize());
    settings.on('render.outputPixelRatio', () => engine.resize());
    settings.on('render.fov', (v) => {
      engine.camera.fov = v as number;
      engine.camera.updateProjectionMatrix();
    });
    return engine;
  }

  get device(): GPUDevice {
    return (this.renderer.backend as any).device;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    // adaptive.outputScale: last-resort stage of the load governor (post/dynamic-resolution.ts)
    this.renderer.setPixelRatio(renderSettings.outputPixelRatio * adaptive.outputScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  add<T extends System>(system: T): T {
    this.systems.push(system);
    return system;
  }

  get<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  async initSystems(onProgress?: (name: string, i: number, n: number) => void) {
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      onProgress?.(s.name, i, this.systems.length);
      await s.init?.(this);
    }
  }

  /** Run a callback once after the next frame was submitted (e.g. screenshots). */
  afterNextFrame(fn: () => void) {
    this.afterFrameCallbacks.push(fn);
  }

  start() {
    this.renderer.setAnimationLoop((ts: number) => this.tick(ts));
  }

  private tick(ts: number) {
    const cpu0 = performance.now();
    const interval = this.lastTs < 0 ? 16.7 : ts - this.lastTs;
    this.lastTs = ts;

    const paused = renderSettings.paused;
    const dt = this.fixedDt ?? Math.min(0.1, interval / 1000);
    if (!paused) this.time += dt;
    const ctx: FrameContext = { dt: paused ? 0 : dt, time: this.time, frame: this.frame, intervalMs: interval };

    this.driver?.(ctx);
    for (const s of this.systems) s.update?.(ctx);

    this.pipeline.render();

    for (const s of this.systems) s.afterRender?.(ctx);
    if (this.afterFrameCallbacks.length) {
      const cbs = this.afterFrameCallbacks;
      this.afterFrameCallbacks = [];
      for (const cb of cbs) cb();
    }

    const info = this.renderer.info;
    this.stats.drawCalls = info.render.drawCalls;
    this.stats.triangles = info.render.triangles;
    this.stats.computeCalls = info.compute.frameCalls;
    this.frame++;
    this.stats.record(interval, performance.now() - cpu0);
    this.resolveGpuTime();
  }

  private resolveGpuTime() {
    if (!this.stats.gpuSupported || this.gpuPending) return;
    this.gpuPending = true;
    // three returns the summed duration of the most recent complete frame
    Promise.all([this.renderer.resolveTimestampsAsync('render'), this.renderer.resolveTimestampsAsync('compute')])
      .then(([r, c]) => {
        const total = (r || 0) + (c || 0);
        if (total > 0) this.stats.recordGpu(total);
      })
      .catch(() => {})
      .finally(() => {
        this.gpuPending = false;
      });
  }
}
