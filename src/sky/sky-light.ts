// Sky ambient light whose SH9 irradiance coefficients live in a GPU storage buffer (computed every frame from the
// sky-view LUT by a compute shader). No CPU readback: ambient follows the sky instantly, even on time jumps.
import * as THREE from 'three/webgpu';
import { normalWorld, uniform } from 'three/tsl';

export class SkyLight extends THREE.Light {
  readonly isSkyLight = true;
  /** storage node: 9 x vec4 SH coefficients (pre-exposed radiance) */
  shNode: any = null;
  constructor() {
    super(0xffffff, 1);
    (this as any).type = 'SkyLight';
  }
}

export class SkyLightNode extends (THREE.AnalyticLightNode as any) {
  static get type() {
    return 'SkyLightNode';
  }
  private uIntensity = uniform(1);

  update(frame: any) {
    super.update(frame);
    this.uIntensity.value = (this.light as SkyLight).intensity;
  }

  setup(builder: any) {
    const sh = (this.light as SkyLight).shNode;
    if (!sh) return;
    const n = normalWorld;
    const x = n.x, y = n.y, z = n.z;
    const c = (i: number) => sh.element(i).xyz;
    let r = c(0).mul(0.886227);
    r = r.add(c(1).mul(2.0 * 0.511664).mul(y));
    r = r.add(c(2).mul(2.0 * 0.511664).mul(z));
    r = r.add(c(3).mul(2.0 * 0.511664).mul(x));
    r = r.add(c(4).mul(2.0 * 0.429043).mul(x).mul(y));
    r = r.add(c(5).mul(2.0 * 0.429043).mul(y).mul(z));
    r = r.add(c(6).mul(z.mul(z).mul(0.743125).sub(0.247708)));
    r = r.add(c(7).mul(2.0 * 0.429043).mul(x).mul(z));
    r = r.add(c(8).mul(0.429043).mul(x.mul(x).sub(y.mul(y))));
    builder.context.irradiance.addAssign(r.max(0).mul(this.uIntensity));
  }
}

export function registerSkyLight(renderer: THREE.WebGPURenderer) {
  (renderer as any).library.addLight(SkyLightNode, SkyLight);
}
