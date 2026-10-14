// Editor fly camera: WASD (ZQSD on AZERTY) + E/Space up, Q/Ctrl down, right-drag to look,
// wheel = speed, Shift = x8, Alt = /8. Smoothed for comfortable flight over large distances.
import { Euler, PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { Input } from '../core/input';
import { settings } from '../core/settings';

export const freeCamSettings = settings.group('freecam', 'Caméra libre', {
  speed: { value: 60, min: 1, max: 3000, step: 1, label: 'Vitesse (m/s)' },
  sensitivity: { value: 0.0022, min: 0.0005, max: 0.008, step: 0.0001, label: 'Sensibilité souris' },
  smoothing: { value: 0.12, min: 0, max: 0.5, step: 0.01, label: 'Lissage' },
});

const _fwd = new Vector3();
const _right = new Vector3();
const _move = new Vector3();
const _euler = new Euler(0, 0, 0, 'YXZ');

export class FreeCamera {
  yaw = 0;
  pitch = 0;
  readonly position = new Vector3();
  private velocity = new Vector3();
  enabled = true;
  /** Ground height query (world x,z -> y); the camera never goes below ground + minClearance. */
  groundHeight: ((x: number, z: number) => number) | null = null;
  minClearance = 1.7;

  constructor(private camera: PerspectiveCamera, private input: Input) {}

  setPose(pos: { x: number; y: number; z: number }, yaw = this.yaw, pitch = this.pitch) {
    this.position.set(pos.x, pos.y, pos.z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.velocity.set(0, 0, 0);
    this.apply();
  }

  lookAt(target: { x: number; y: number; z: number }) {
    const dx = target.x - this.position.x;
    const dy = target.y - this.position.y;
    const dz = target.z - this.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.apply();
  }

  update(dt: number) {
    if (!this.enabled) return;
    const inp = this.input;
    if (inp.wheel) freeCamSettings.speed = Math.min(3000, Math.max(1, freeCamSettings.speed * Math.pow(1.25, -inp.wheel)));
    this.yaw -= inp.mouseDX * freeCamSettings.sensitivity;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - inp.mouseDY * freeCamSettings.sensitivity));

    _euler.set(this.pitch, this.yaw, 0);
    _fwd.set(0, 0, -1).applyEuler(_euler);
    _right.set(1, 0, 0).applyEuler(_euler);
    _move.set(0, 0, 0);
    if (inp.down('KeyW') || inp.down('ArrowUp')) _move.add(_fwd);
    if (inp.down('KeyS') || inp.down('ArrowDown')) _move.sub(_fwd);
    if (inp.down('KeyD') || inp.down('ArrowRight')) _move.add(_right);
    if (inp.down('KeyA') || inp.down('ArrowLeft')) _move.sub(_right);
    if (inp.down('KeyE') || inp.down('Space')) _move.y += 1;
    if (inp.down('KeyQ') || inp.down('ControlLeft')) _move.y -= 1;
    let speed = freeCamSettings.speed;
    if (inp.down('ShiftLeft') || inp.down('ShiftRight')) speed *= 8;
    if (inp.down('AltLeft') || inp.down('AltRight')) speed /= 8;
    if (_move.lengthSq() > 0) _move.normalize().multiplyScalar(speed);

    const k = freeCamSettings.smoothing > 0 ? 1 - Math.exp(-dt / freeCamSettings.smoothing) : 1;
    this.velocity.lerp(_move, k);
    this.position.addScaledVector(this.velocity, dt);
    if (this.groundHeight) {
      const g = this.groundHeight(this.position.x, this.position.z) + this.minClearance;
      if (this.position.y < g) this.position.y = g;
    }
    this.apply();
  }

  apply() {
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }
}
