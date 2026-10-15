// Semi-realistic light-aircraft flight model (Cessna 172-like) with ground handling.
// Body frame: +X right wing, +Y up, -Z forward. SI units.
import * as THREE from 'three/webgpu';
import { GEAR_POINTS, GEAR_HEIGHT } from './plane-model';

export interface AircraftControls {
  pitch: number; // -1..1 (positive = nose up)
  roll: number; // -1..1 (positive = right wing down)
  yaw: number; // -1..1 (positive = nose right)
  throttle: number; // 0..1
  brake: number; // 0..1
  flaps: number; // 0..1
}

const MASS = 1050;
const WING_AREA = 16.2;
const MAX_THRUST = 3600;
const V_MAX_THRUST = 82;
const CL0 = 0.32, CLA = 5.1, CL_MAX = 1.55, STALL = THREE.MathUtils.degToRad(15);
const CD0 = 0.031, K_INDUCED = 0.056;
const G = 9.81;

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _f = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _p = new THREE.Vector3();

export class Aircraft {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly angVel = new THREE.Vector3(); // body frame (rad/s): x pitch, y yaw, z roll
  readonly controls: AircraftControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, flaps: 0 };
  onGround = false;
  airspeed = 0;
  aoa = 0;
  stalled = false;
  propAngle = 0;
  crashed = false;

  constructor(private groundHeight: (x: number, z: number) => number) {}

  /** Place on the ground at (x, z) heading (rad, 0 = north, clockwise). */
  spawnOnGround(x: number, z: number, heading: number) {
    this.position.set(x, this.groundHeight(x, z) + GEAR_HEIGHT + 0.02, z);
    this.velocity.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.quaternion.setFromEuler(new THREE.Euler(0, -heading, 0, 'YXZ'));
    this.controls.throttle = 0;
    this.crashed = false;
  }

  /** Place in flight at position with heading and speed. */
  spawnInAir(pos: THREE.Vector3, heading: number, speed = 50) {
    this.position.copy(pos);
    this.quaternion.setFromEuler(new THREE.Euler(0, -heading, 0, 'YXZ'));
    this.velocity.set(0, 0, -speed).applyQuaternion(this.quaternion);
    this.angVel.set(0, 0, 0);
    this.controls.throttle = 0.65;
    this.crashed = false;
  }

  step(dt: number) {
    const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.integrate(h);
    const rpm = 600 + 2100 * this.controls.throttle;
    this.propAngle = (this.propAngle + (rpm / 60) * 2 * Math.PI * dt) % (Math.PI * 2);
  }

  private integrate(dt: number) {
    const c = this.controls;
    const q = this.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    _right.set(1, 0, 0).applyQuaternion(q);
    const alt = this.position.y;
    const rho = 1.225 * Math.exp(-alt / 8500);
    const V = this.velocity.length();
    this.airspeed = V;
    _q.copy(q).invert();
    _vb.copy(this.velocity).applyQuaternion(_q); // body-frame velocity
    const u = -_vb.z;
    const alpha = V > 1 ? Math.atan2(-_vb.y, Math.max(0.1, u)) : 0;
    const beta = V > 1 ? Math.atan2(_vb.x, Math.max(0.1, u)) : 0;
    this.aoa = alpha;
    const qbar = 0.5 * rho * V * V;

    // lift coefficient with stall
    const flapCL = 0.45 * c.flaps;
    let CL: number;
    const aAbs = Math.abs(alpha);
    if (aAbs < STALL) CL = CL0 + CLA * alpha + flapCL;
    else {
      const over = aAbs - STALL;
      CL = Math.sign(alpha) * Math.max(0.35, CL_MAX - over * 3.2) + flapCL * 0.5;
    }
    CL = THREE.MathUtils.clamp(CL, -1.2, CL_MAX + flapCL);
    this.stalled = aAbs > STALL;
    const CD = CD0 + K_INDUCED * CL * CL + 0.035 * c.flaps + (this.stalled ? 0.15 : 0);

    _f.set(0, -MASS * G, 0);
    if (V > 0.5) {
      const vdir = _v.copy(this.velocity).divideScalar(V);
      // lift perpendicular to velocity, in the plane spanned by velocity and body-up
      const liftDir = _tmp.crossVectors(_right, vdir).normalize(); // right x forward = up
      _f.addScaledVector(liftDir, qbar * WING_AREA * CL);
      _f.addScaledVector(vdir, -qbar * WING_AREA * CD);
      // side force from sideslip
      _f.addScaledVector(_right, -qbar * WING_AREA * 0.9 * beta);
    }
    const thrust = c.throttle * MAX_THRUST * Math.max(0, 1 - Math.max(0, u) / V_MAX_THRUST) * Math.min(1, rho / 1.0 + 0.1);
    _f.addScaledVector(_fwd, thrust);

    // ---- rotational dynamics (semi-arcade: control authority ~ dynamic pressure, aerodynamic damping/stability)
    const auth = THREE.MathUtils.clamp(qbar / 1400, 0, 2.2);
    const av = this.angVel;
    // elevator effectively commands angle of attack: full deflection ~ 0.3 rad (near stall), strong damping
    const pitchAcc = auth * (6.0 * c.pitch - 22 * (alpha - 0.035)) - 6 * av.x * Math.max(0.3, auth);
    // signs (body frame, right-hand): +av.x nose up, +av.y nose left, +av.z right wing up (roll left).
    // beta > 0 = relative wind from the right: weathervane yaws right (-y), dihedral rolls left (+z).
    const rollAcc = auth * 3.0 * -c.roll - 3.5 * av.z * Math.max(0.3, auth) + auth * 2.0 * beta;
    const yawAcc = auth * (1.4 * -c.yaw - 3.0 * beta) - 1.8 * av.y * Math.max(0.3, auth);
    av.x += pitchAcc * dt;
    av.y += yawAcc * dt;
    av.z += rollAcc * dt;
    // adverse/coordinated turn: bank induces yaw so turns feel natural
    const bank = Math.asin(THREE.MathUtils.clamp(_right.y, -1, 1));
    // banked left (right wing up, bank > 0) turns left (+av.y)
    if (!this.onGround) av.y += bank * 0.45 * dt * auth;

    // ---- ground contact (3 gear points: spring-damper + friction)
    this.onGround = false;
    const torque = _p.set(0, 0, 0);
    for (let gi = 0; gi < GEAR_POINTS.length; gi++) {
      const local = GEAR_POINTS[gi];
      const wp = _tmp.copy(local).applyQuaternion(q).add(this.position);
      const gh = this.groundHeight(wp.x, wp.z);
      const pen = gh - wp.y;
      if (pen <= 0) continue;
      this.onGround = true;
      // contact point velocity
      const rWorld = _v.copy(local).applyQuaternion(q);
      const wWorld = new THREE.Vector3(av.x, av.y, av.z).applyQuaternion(q);
      const pv = new THREE.Vector3().crossVectors(wWorld, rWorld).add(this.velocity);
      const k = 60000, d = 9000;
      const fn = Math.max(0, k * pen - d * pv.y);
      const force = new THREE.Vector3(0, fn, 0);
      // friction: rolling along heading, strong laterally; brakes on main gear
      const fwdFlat = new THREE.Vector3(_fwd.x, 0, _fwd.z).normalize();
      const sideFlat = new THREE.Vector3(-fwdFlat.z, 0, fwdFlat.x);
      const vLong = pv.dot(fwdFlat), vLat = pv.dot(sideFlat);
      const muRoll = gi === 0 ? 0.02 : 0.02 + 0.55 * c.brake;
      force.addScaledVector(fwdFlat, -Math.sign(vLong) * Math.min(Math.abs(vLong) * MASS, muRoll * fn));
      force.addScaledVector(sideFlat, -Math.sign(vLat) * Math.min(Math.abs(vLat) * MASS * 2, 0.8 * fn));
      // nose-wheel steering with rudder
      if (gi === 0) force.addScaledVector(sideFlat, -c.yaw * 0.25 * fn * Math.min(1, Math.abs(vLong) / 5) * Math.sign(vLong || 1));
      _f.add(force);
      const tq = new THREE.Vector3().crossVectors(rWorld, force).applyQuaternion(_q); // body-frame torque
      torque.add(tq);
      if (pv.y < -7) this.crashed = true;
    }
    if (this.onGround) {
      // gear torques act on roll/yaw only; pitch on the ground comes from aerodynamics, with a restoring term
      // towards the three-wheel attitude at low speed and hard stops (nose wheel / tail strike)
      av.y += (torque.y / 2600) * dt;
      av.z += (torque.z / 1300) * dt;
      av.y *= Math.exp(-5 * dt);
      av.z *= Math.exp(-5 * dt);
      const theta = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1));
      const slow = 1 - Math.min(1, auth / 0.45);
      av.x += (-10 * theta - 4 * av.x) * slow * dt;
      if (theta < -0.015 && av.x < 0) av.x = 0;
      if (theta > 0.22 && av.x > 0) av.x = 0;
    }

    // ---- integrate
    this.velocity.addScaledVector(_f, dt / MASS);
    this.position.addScaledVector(this.velocity, dt);
    const dq = new THREE.Quaternion(av.x * dt * 0.5, av.y * dt * 0.5, av.z * dt * 0.5, 1);
    q.multiply(dq).normalize();
    // never sink into the terrain (fuselage contact)
    const gh = this.groundHeight(this.position.x, this.position.z);
    if (this.position.y < gh + 0.4) {
      this.position.y = gh + 0.4;
      if (this.velocity.y < -6) this.crashed = true;
      this.velocity.y = Math.max(0, this.velocity.y);
    }
  }
}
