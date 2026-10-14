// Sky & sun lighting. (Phase 1: simple analytic placeholder; replaced by the Hillaire atmosphere.)
import * as THREE from 'three/webgpu';
import type { Engine, System, FrameContext } from '../core/engine';
import type { TimeOfDay } from './time-of-day';

export class Sky implements System {
  readonly name = 'sky';
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0x9ec4ff, 0x4a4030, 0.6);
  private engine!: Engine;

  constructor(private time: TimeOfDay) {}

  init(engine: Engine) {
    this.engine = engine;
    engine.scene.add(this.sun, this.sun.target, this.hemi);
    engine.scene.background = new THREE.Color(0x87a8d0);
  }

  update(_ctx: FrameContext) {
    const d = this.time.sunDir;
    const cam = this.engine.camera.position;
    this.sun.position.copy(cam).addScaledVector(d, 1000);
    this.sun.target.position.copy(cam);
    this.sun.target.updateMatrixWorld();
    const day = THREE.MathUtils.smoothstep(d.y, -0.05, 0.15);
    this.sun.intensity = 3.5 * day;
    this.hemi.intensity = 0.05 + 0.7 * day;
  }
}
