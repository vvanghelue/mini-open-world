// First-person walker: gravity, slope limit, jump, sprint, collisions with tree trunks and buildings.
import * as THREE from 'three/webgpu';
import type { Input } from '../core/input';
import { settings } from '../core/settings';
import type { TreeQuery, Trunk } from './tree-query';
import { worldColliders } from '../world/colliders';

export const walkSettings = settings.group('walk', 'Marche', {
  walkSpeed: { value: 1.6, min: 0.5, max: 4, step: 0.1, label: 'Vitesse marche (m/s)' },
  runSpeed: { value: 5.5, min: 2, max: 15, step: 0.5, label: 'Vitesse course (m/s)' },
  eyeHeight: { value: 1.7, min: 1.2, max: 2.2, step: 0.05, label: 'Hauteur des yeux (m)' },
  jump: { value: 4.2, min: 0, max: 10, step: 0.1, label: 'Saut (m/s)' },
  maxSlope: { value: 42, min: 20, max: 70, step: 1, label: 'Pente max (°)' },
  headBob: { value: 0.5, min: 0, max: 1, step: 0.05, label: 'Balancement' },
});

const _n = { x: 0, y: 1, z: 0 };
const _move = new THREE.Vector3();

export class Walker {
  readonly feet = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  private bob = 0;
  private trunks: Trunk[] = [];
  private trunkTimer = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private heightAt: (x: number, z: number) => number,
    private normalAt: (x: number, z: number, out: { x: number; y: number; z: number }) => void,
    private trees: TreeQuery,
  ) {}

  place(x: number, z: number, yaw: number) {
    this.feet.set(x, this.heightAt(x, z), z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.trunkTimer = 0;
  }

  update(dt: number) {
    const inp = this.input;
    const sens = 0.0022;
    this.yaw -= inp.mouseDX * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - inp.mouseDY * sens, -1.5, 1.5);
    const s = walkSettings;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    _move.set(0, 0, 0);
    if (inp.down('KeyW') || inp.down('ArrowUp')) _move.add(fwd);
    if (inp.down('KeyS') || inp.down('ArrowDown')) _move.sub(fwd);
    if (inp.down('KeyD') || inp.down('ArrowRight')) _move.add(right);
    if (inp.down('KeyA') || inp.down('ArrowLeft')) _move.sub(right);
    const running = inp.down('ShiftLeft') || inp.down('ShiftRight');
    const speed = running ? s.runSpeed : s.walkSpeed;
    if (_move.lengthSq() > 0) _move.normalize().multiplyScalar(speed);

    // ground: slope limit -> slide down steep terrain
    this.normalAt(this.feet.x, this.feet.z, _n);
    const slopeDeg = (Math.acos(THREE.MathUtils.clamp(_n.y, -1, 1)) * 180) / Math.PI;
    const tooSteep = slopeDeg > s.maxSlope;
    if (this.onGround) {
      const k = 1 - Math.exp(-dt * 12);
      this.velocity.x += (_move.x - this.velocity.x) * k;
      this.velocity.z += (_move.z - this.velocity.z) * k;
      if (tooSteep) {
        // can't walk uphill on steep slopes: remove the uphill component, add a gentle slide
        const down = new THREE.Vector3(_n.x, 0, _n.z).normalize();
        const up = this.velocity.dot(down);
        if (up < 0) this.velocity.addScaledVector(down, -up);
        this.velocity.addScaledVector(down, 3 * dt);
      }
      if (inp.justPressed('Space')) {
        this.velocity.y = s.jump;
        this.onGround = false;
      }
    } else {
      // limited air control
      this.velocity.x += (_move.x - this.velocity.x) * (1 - Math.exp(-dt * 1.5));
      this.velocity.z += (_move.z - this.velocity.z) * (1 - Math.exp(-dt * 1.5));
    }
    this.velocity.y -= 9.81 * dt;
    this.feet.addScaledVector(this.velocity, dt);

    // trunks (refresh the nearby list a few times per second)
    this.trunkTimer -= dt;
    if (this.trunkTimer <= 0) {
      this.trees.near(this.feet.x, this.feet.z, 12, this.trunks);
      this.trunkTimer = 0.25;
    }
    for (const t of this.trunks) {
      const dx = this.feet.x - t.x, dz = this.feet.z - t.z;
      const d = Math.hypot(dx, dz);
      const minD = t.r + 0.3;
      if (d < minD && d > 1e-4) {
        this.feet.x = t.x + (dx / d) * minD;
        this.feet.z = t.z + (dz / d) * minD;
      }
    }

    // static obstacles (buildings)
    for (const c of worldColliders) c(this.feet, 0.35);

    const g = this.heightAt(this.feet.x, this.feet.z);
    if (this.feet.y <= g) {
      this.feet.y = g;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    } else if (this.feet.y > g + 0.3) {
      this.onGround = false;
    } else if (this.velocity.y <= 0) {
      // stick to the ground when walking downhill
      this.feet.y = g;
      this.onGround = true;
    }

    // camera
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.bob += dt * horizSpeed * 1.9;
    const bobY = this.onGround ? Math.sin(this.bob * 2) * 0.035 * s.headBob * Math.min(1, horizSpeed / 2) : 0;
    this.camera.position.set(this.feet.x, this.feet.y + s.eyeHeight + bobY, this.feet.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }
}
