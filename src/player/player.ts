// Player modes: free editor camera (1), walking (2), aircraft (3). Handles input mapping, spawning and cameras.
import * as THREE from 'three/webgpu';
import type { Engine, System, FrameContext } from '../core/engine';
import type { Input } from '../core/input';
import { settings } from '../core/settings';
import type { FreeCamera } from './free-camera';
import { Walker } from './walker';
import { Aircraft } from './aircraft';
import { buildPlane, GEAR_HEIGHT } from './plane-model';
import { TreeQuery } from './tree-query';
import type { Terrain } from '../terrain/terrain';
import { lv95ToWorld } from '../world/geo';
import { registerCommand } from '../agent/bridge';

export const playerSettings = settings.group(
  'player',
  'Joueur',
  {
    mode: { value: 'free', options: { 'Caméra libre (1)': 'free', 'Marche (2)': 'walk', 'Avion (3)': 'plane' }, label: 'Mode' },
    planeCam: { value: 'chase', options: { Poursuite: 'chase', Cockpit: 'cockpit' }, label: 'Caméra avion (V)' },
    chaseDistance: { value: 16, min: 6, max: 60, step: 1, label: 'Distance poursuite (m)' },
    mouseFlight: { value: false, label: 'Pilotage à la souris' },
  },
  true,
);

// Interlaken airfield (LSMI), runway 04/22 axis measured on the orthophoto
const RUNWAY_SW = lv95ToWorld(2633155, 1169038);
const RUNWAY_NE = lv95ToWorld(2634385, 1170283);

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class Player implements System {
  readonly name = 'player';
  private engine!: Engine;
  walker!: Walker;
  aircraft!: Aircraft;
  private plane!: ReturnType<typeof buildPlane>;
  private mode = '';
  private chasePos = new THREE.Vector3();
  private chaseInit = false;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private trees!: TreeQuery;

  constructor(private terrain: Terrain, private freeCam: FreeCamera, private input: Input) {}

  init(engine: Engine) {
    this.engine = engine;
    const t = this.terrain;
    this.trees = new TreeQuery(t.data, (x, z) => t.forestAt(x, z));
    this.walker = new Walker(engine.camera, this.input, (x, z) => t.heightAt(x, z), (x, z, o) => t.data.normalAt(x, z, o), this.trees);
    this.aircraft = new Aircraft((x, z) => t.heightAt(x, z));
    this.plane = buildPlane();
    this.plane.group.visible = false;
    engine.scene.add(this.plane.group);

    this.input.onKey('Digit1', () => (playerSettings.mode = 'free'));
    this.input.onKey('Digit2', () => (playerSettings.mode = 'walk'));
    this.input.onKey('Digit3', () => (playerSettings.mode = 'plane'));
    this.input.onKey('KeyV', () => {
      if (this.mode === 'plane') playerSettings.planeCam = playerSettings.planeCam === 'chase' ? 'cockpit' : 'chase';
    });
    this.input.onKey('KeyT', () => {
      if (this.mode === 'plane') this.spawnOnRunway();
    });
    this.input.onKey('KeyG', () => {
      if (this.mode === 'plane') {
        const c = this.aircraft.controls;
        c.flaps = c.flaps >= 1 ? 0 : c.flaps + 0.5;
      }
    });
    engine.renderer.domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0 && (this.mode === 'walk' || (this.mode === 'plane' && (playerSettings.mouseFlight || playerSettings.planeCam === 'cockpit')))) this.input.requestPointerLock();
    });

    registerCommand('mode', 'Switch player mode: {mode: free|walk|plane}', ({ mode, _ }) => {
      playerSettings.mode = mode ?? _?.[0];
      return { mode: playerSettings.mode };
    });
    registerCommand('plane', 'Aircraft state, or set controls: {throttle, pitch, roll, yaw, flaps, brake, spawn: runway|air}', (a) => {
      const ac = this.aircraft;
      if (a.spawn === 'runway') this.spawnOnRunway();
      if (a.spawn === 'air') ac.spawnInAir(this.engine.camera.position.clone(), this.freeCam.yaw * -1, 55);
      for (const k of ['throttle', 'pitch', 'roll', 'yaw', 'flaps', 'brake'] as const) if (a[k] !== undefined) (ac.controls as any)[k] = a[k];
      if (a.hold !== undefined) this.holdControls = !!a.hold;
      return {
        pos: ac.position.toArray().map((v) => +v.toFixed(1)),
        airspeedKmh: +(ac.airspeed * 3.6).toFixed(1),
        agl: +(ac.position.y - this.terrain.heightAt(ac.position.x, ac.position.z) - GEAR_HEIGHT).toFixed(1),
        aoaDeg: +((ac.aoa * 180) / Math.PI).toFixed(1),
        onGround: ac.onGround,
        stalled: ac.stalled,
        controls: ac.controls,
      };
    });
  }

  /** When true (agent tests), keyboard input does not override aircraft controls. */
  private holdControls = false;

  private spawnOnRunway() {
    const dx = RUNWAY_NE.x - RUNWAY_SW.x, dz = RUNWAY_NE.z - RUNWAY_SW.z;
    const len = Math.hypot(dx, dz);
    const heading = Math.atan2(dx, -dz); // 0 = north, clockwise
    const x = RUNWAY_SW.x + (dx / len) * 120, z = RUNWAY_SW.z + (dz / len) * 120;
    this.aircraft.spawnOnGround(x, z, heading);
    this.chaseInit = false;
  }

  private enterMode(mode: string) {
    const cam = this.engine.camera;
    this.freeCam.enabled = mode === 'free';
    this.plane.group.visible = mode === 'plane';
    this.input.dragLook = mode === 'free' || mode === 'plane';
    if (mode !== 'walk' && mode !== 'plane') this.input.exitPointerLock();
    if (mode === 'free') {
      this.freeCam.setPose(cam.position, this.freeCam.yaw, this.freeCam.pitch);
      const e = _e.setFromQuaternion(cam.quaternion, 'YXZ');
      this.freeCam.setPose(cam.position, e.y, e.x);
    } else if (mode === 'walk') {
      const e = _e.setFromQuaternion(cam.quaternion, 'YXZ');
      this.walker.place(cam.position.x, cam.position.z, e.y);
    } else if (mode === 'plane') {
      const agl = cam.position.y - this.terrain.heightAt(cam.position.x, cam.position.z);
      const e = _e.setFromQuaternion(cam.quaternion, 'YXZ');
      if (agl < 150) this.spawnOnRunway();
      else this.aircraft.spawnInAir(cam.position.clone(), -e.y, 55);
      this.chaseInit = false;
    }
    this.mode = mode;
  }

  update(ctx: FrameContext) {
    if (playerSettings.mode !== this.mode) this.enterMode(playerSettings.mode);
    const dt = ctx.dt;
    if (this.mode === 'free') this.freeCam.update(dt);
    else if (this.mode === 'walk') this.walker.update(dt);
    else if (this.mode === 'plane') this.updatePlane(dt);
  }

  private updatePlane(dt: number) {
    const ac = this.aircraft;
    const c = ac.controls;
    const inp = this.input;
    if (!this.holdControls) {
      const ramp = (cur: number, target: number, rate: number) => cur + THREE.MathUtils.clamp(target - cur, -rate * dt, rate * dt);
      let tp = (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0) - (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0);
      let tr = (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) - (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0);
      const ty = (inp.down('KeyE') ? 1 : 0) - (inp.down('KeyQ') ? 1 : 0);
      if (playerSettings.mouseFlight && inp.pointerLocked) {
        this.mouseStick.x = THREE.MathUtils.clamp(this.mouseStick.x + inp.mouseDX * 0.004, -1, 1);
        this.mouseStick.y = THREE.MathUtils.clamp(this.mouseStick.y + inp.mouseDY * 0.004, -1, 1);
        tr = tp === 0 && tr === 0 ? this.mouseStick.x : tr;
        tp = tp === 0 ? this.mouseStick.y : tp;
        this.mouseStick.multiplyScalar(Math.exp(-dt * 0.8));
      }
      c.pitch = ramp(c.pitch, tp, 3);
      c.roll = ramp(c.roll, tr, 4);
      c.yaw = ramp(c.yaw, ty, 3);
      if (inp.down('ShiftLeft') || inp.down('KeyR')) c.throttle = Math.min(1, c.throttle + 0.45 * dt);
      if (inp.down('ControlLeft') || inp.down('KeyF')) c.throttle = Math.max(0, c.throttle - 0.45 * dt);
      c.brake = inp.down('KeyB') || inp.down('Space') ? 1 : 0;
    }
    ac.step(dt);
    if (ac.crashed) {
      // simple respawn on a crash
      this.spawnOnRunway();
    }

    // model transform
    const g = this.plane.group;
    g.position.copy(ac.position);
    g.quaternion.copy(ac.quaternion);
    this.plane.prop.rotation.z = ac.propAngle;
    const fast = c.throttle > 0.25;
    this.plane.prop.visible = !fast;
    this.plane.discMat.opacity = fast ? 0.22 : 0;
    g.updateMatrixWorld();

    // camera
    const cam = this.engine.camera;
    const inCockpit = playerSettings.planeCam === 'cockpit';
    this.plane.cockpit.visible = inCockpit;
    for (const m of this.plane.exterior) m.visible = !inCockpit;
    if (inCockpit) {
      if (inp.buttons & 2 || inp.pointerLocked) {
        this.orbitYaw -= inp.mouseDX * 0.003;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch - inp.mouseDY * 0.003, -1.2, 1.2);
      }
      _v.set(-0.3, 0.74, -0.7).applyQuaternion(ac.quaternion).add(ac.position);
      cam.position.copy(_v);
      _q.setFromEuler(_e.set(this.orbitPitch - 0.06, this.orbitYaw, 0, 'YXZ'));
      cam.quaternion.copy(ac.quaternion).multiply(_q);
    } else {
      if (inp.buttons & 2) {
        this.orbitYaw -= inp.mouseDX * 0.004;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch - inp.mouseDY * 0.004, -0.6, 1.2);
      } else {
        this.orbitYaw *= Math.exp(-dt * 0.8);
      }
      if (inp.wheel) playerSettings.chaseDistance = THREE.MathUtils.clamp(playerSettings.chaseDistance * Math.pow(1.15, inp.wheel), 6, 60);
      // follow the flight direction (heading + flight path), not the roll
      _fwd.set(0, 0, -1).applyQuaternion(ac.quaternion);
      const heading = Math.atan2(_fwd.x, -_fwd.z) + this.orbitYaw;
      const D = playerSettings.chaseDistance;
      const elev = 0.18 + this.orbitPitch;
      const target = _v.set(-Math.sin(heading) * Math.cos(elev), Math.sin(elev), Math.cos(heading) * Math.cos(elev)).multiplyScalar(D).add(ac.position);
      const minY = this.terrain.heightAt(target.x, target.z) + 1.5;
      if (target.y < minY) target.y = minY;
      if (!this.chaseInit) {
        this.chasePos.copy(target);
        this.chaseInit = true;
      }
      this.chasePos.lerp(target, 1 - Math.exp(-dt * 6));
      cam.position.copy(this.chasePos);
      cam.up.set(0, 1, 0);
      cam.lookAt(_fwd.multiplyScalar(6).add(ac.position));
    }
    cam.updateMatrixWorld();
  }
  private mouseStick = new THREE.Vector2();

  hudLine(): string {
    if (this.mode === 'plane') {
      const ac = this.aircraft;
      const agl = ac.position.y - this.terrain.heightAt(ac.position.x, ac.position.z) - GEAR_HEIGHT;
      const c = ac.controls;
      return `AVION  ${(ac.airspeed * 3.6).toFixed(0)} km/h  alt ${ac.position.y.toFixed(0)} m  sol ${agl.toFixed(0)} m  moteur ${(c.throttle * 100).toFixed(0)}%  volets ${c.flaps * 100}%${ac.stalled ? '  DÉCROCHAGE' : ''}${c.brake ? '  FREINS' : ''}\n  W/S tangage  A/D roulis  Q/E palonnier  Shift/Ctrl (R/F) gaz  G volets  B freins  V caméra  T piste`;
    }
    if (this.mode === 'walk') return `MARCHE  ZQSD/WASD  Shift courir  Espace sauter  clic: verrouiller la souris`;
    return `CAMÉRA LIBRE  WASD/ZQSD  E/Q haut/bas  clic droit: regarder  molette: vitesse   1 libre · 2 marche · 3 avion`;
  }
}
