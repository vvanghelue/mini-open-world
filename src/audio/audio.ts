// Procedural sound (WebAudio, no sample files): wind (filtered pink noise, gusts, altitude/speed), aircraft engine
// and propeller (firing-frequency sawtooth + blade-pass modulated noise, muffled in the cockpit), footsteps by surface,
// and daytime ambience (cow bells on alpine pastures, birds near forests). The context starts on the first user
// gesture (browser autoplay rule).
import * as THREE from 'three/webgpu';
import type { Engine, System, FrameContext } from '../core/engine';
import { settings } from '../core/settings';
import type { Terrain } from '../terrain/terrain';
import type { TimeOfDay } from '../sky/time-of-day';
import type { Player } from '../player/player';
import { playerSettings } from '../player/player';
import { forestSettings } from '../vegetation/forest';

export const audioSettings = settings.group('audio', 'Son', {
  enabled: { value: true, label: 'Son' },
  volume: { value: 0.7, min: 0, max: 1, step: 0.05, label: 'Volume général' },
  wind: { value: 1, min: 0, max: 2, step: 0.05, label: 'Vent' },
  engine: { value: 1, min: 0, max: 2, step: 0.05, label: 'Moteur' },
  ambience: { value: 1, min: 0, max: 2, step: 0.05, label: 'Ambiance (cloches, oiseaux)' },
  footsteps: { value: 1, min: 0, max: 2, step: 0.05, label: 'Pas' },
});

function pinkNoise(ctx: AudioContext, seconds: number) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    // crossfade the loop seam
    const f = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < f; i++) d[n - f + i] = d[n - f + i] * (1 - i / f) + d[i] * (i / f);
  }
  return buf;
}

export class AudioSystem implements System {
  readonly name = 'audio';
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  // wind
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private whistleGain!: GainNode;
  private whistleFilter!: BiquadFilterNode;
  // engine
  private engGain!: GainNode;
  private engOsc!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private propGain!: GainNode;
  private propLfo!: OscillatorNode;
  private propFilter!: BiquadFilterNode;
  // state
  private gust = 0;
  private gustTarget = 0;
  private stepDist = 0;
  private lastFeet = new THREE.Vector3();
  private nextBell = 2;
  private nextBird = 3;
  private cover = new Array(7);
  private engine!: Engine;

  constructor(private terrain: Terrain, private time: TimeOfDay, private player: Player) {}

  init(engine: Engine) {
    this.engine = engine;
    const start = () => {
      if (!this.ctx) this.create();
      else if (this.ctx.state === 'suspended') this.ctx.resume();
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  private create() {
    const ctx = (this.ctx = new AudioContext());
    this.noise = pinkNoise(ctx, 6);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    const loop = (rate = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = rate;
      src.loopStart = Math.random() * 3;
      src.start(0, Math.random() * 5);
      return src;
    };
    // wind: low roar + airy whistle
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    loop(1).connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.whistleFilter = ctx.createBiquadFilter();
    this.whistleFilter.type = 'bandpass';
    this.whistleFilter.frequency.value = 1800;
    this.whistleFilter.Q.value = 6;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    loop(0.83).connect(this.whistleFilter).connect(this.whistleGain).connect(this.master);
    // engine: firing-frequency sawtooth (4 cylinders, 4 stroke: rpm / 30 Hz) + crank sub-harmonic, saturated
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 1500;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 2.5); }
    shaper.curve = curve;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engOsc = ctx.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    this.engOsc.connect(shaper);
    this.engSub.connect(subGain).connect(shaper);
    shaper.connect(this.engFilter).connect(this.engGain).connect(this.master);
    this.engOsc.start();
    this.engSub.start();
    // propeller: noise amplitude-modulated at the blade-pass frequency
    this.propFilter = ctx.createBiquadFilter();
    this.propFilter.type = 'bandpass';
    this.propFilter.frequency.value = 420;
    this.propFilter.Q.value = 0.8;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    this.propLfo = ctx.createOscillator();
    this.propLfo.type = 'sine';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.5;
    this.propLfo.connect(lfoDepth).connect(am.gain);
    this.propLfo.start();
    this.propGain = ctx.createGain();
    this.propGain.gain.value = 0;
    loop(1.21).connect(this.propFilter).connect(am).connect(this.propGain).connect(this.master);
  }

  // ---------------------------------------------------------------- one-shot sounds
  private burst(duration: number, filter: BiquadFilterType, freq: number, q: number, gain: number, pan = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 5, duration + 0.05);
  }

  /** Cow bell: inharmonic FM partials with a long metallic decay. */
  private bell(gain: number, pan: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const base = 520 + Math.random() * 380;
    const out = ctx.createGain();
    out.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400 - Math.abs(pan) * 900;
    out.connect(lp).connect(p).connect(this.master);
    for (const [ratio, amp, dec] of [[1, 1, 1.1], [2.41, 0.5, 0.7], [3.87, 0.3, 0.45], [5.3, 0.15, 0.3]]) {
      const o = ctx.createOscillator();
      o.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.01);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dec + 0.05);
    }
  }

  /** Bird: a few fast frequency sweeps. */
  private bird(gain: number, pan: number) {
    const ctx = this.ctx!;
    let t = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master);
    const n = 2 + Math.floor(Math.random() * 4);
    const f0 = 2600 + Math.random() * 2400;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const g = ctx.createGain();
      const d = 0.05 + Math.random() * 0.08;
      o.frequency.setValueAtTime(f0 * (0.9 + Math.random() * 0.2), t);
      o.frequency.exponentialRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.5 : 0.7), t + d);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(p);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d + 0.03 + Math.random() * 0.06;
    }
  }

  update(ctxF: FrameContext) {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = audioSettings;
    const now = ctx.currentTime;
    const smooth = (param: AudioParam, v: number, tc = 0.08) => param.setTargetAtTime(v, now, tc);
    smooth(this.master.gain, s.enabled ? s.volume : 0, 0.1);
    if (!s.enabled) return;
    const dt = ctxF.dt;
    const cam = this.engine.camera.position;
    const mode = playerSettings.mode;
    const ac = this.player.aircraft;
    const inPlane = mode === 'plane';
    const cockpit = inPlane && playerSettings.planeCam === 'cockpit';
    const agl = cam.y - this.terrain.heightAt(cam.x, cam.z);

    // wind: gusts (random walk), stronger with altitude above ground, wind setting and airspeed
    if (Math.random() < dt * 0.4) this.gustTarget = Math.random();
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8);
    const speed = inPlane ? ac.airspeed : 0;
    const windStrength = forestSettings.wind * (0.35 + 0.45 * Math.min(1, agl / 300) + 0.4 * this.gust);
    const airflow = Math.min(1, speed / 70);
    const windLevel = (0.05 + 0.12 * windStrength + (cockpit ? 0.05 : 0.35) * airflow) * s.wind;
    smooth(this.windGain.gain, windLevel);
    smooth(this.windFilter.frequency, 280 + 500 * this.gust + 1400 * airflow, 0.2);
    smooth(this.whistleGain.gain, (0.012 * windStrength * this.gust + 0.05 * airflow * (cockpit ? 0.3 : 1)) * s.wind);
    smooth(this.whistleFilter.frequency, 1300 + 900 * this.gust + 1200 * airflow, 0.3);

    // engine
    if (inPlane) {
      const rpm = 600 + 2100 * ac.controls.throttle;
      const fire = rpm / 30;
      smooth(this.engOsc.frequency, fire, 0.15);
      smooth(this.engSub.frequency, fire / 2, 0.15);
      smooth(this.propLfo.frequency, (rpm / 60) * 2, 0.15);
      // chase camera: further away, more air; cockpit: muffled, louder low end
      const dist = cockpit ? 0 : this.engine.camera.position.distanceTo(ac.position);
      const att = cockpit ? 1 : 1 / (1 + dist / 18);
      const level = (0.12 + 0.22 * ac.controls.throttle) * att * s.engine;
      smooth(this.engGain.gain, level);
      smooth(this.engFilter.frequency, cockpit ? 650 : 1600 + 1200 * ac.controls.throttle);
      smooth(this.propGain.gain, (0.05 + 0.25 * ac.controls.throttle) * att * s.engine * (cockpit ? 0.5 : 1));
      smooth(this.propFilter.frequency, 300 + 500 * ac.controls.throttle);
    } else {
      smooth(this.engGain.gain, 0, 0.3);
      smooth(this.propGain.gain, 0, 0.3);
    }

    // footsteps (walk mode): one step every ~0.75 m on the ground
    if (mode === 'walk') {
      const w = this.player.walker;
      const moved = Math.hypot(w.feet.x - this.lastFeet.x, w.feet.z - this.lastFeet.z);
      this.lastFeet.copy(w.feet);
      if (w.onGround && moved < 2) this.stepDist += moved;
      if (this.stepDist > 0.78) {
        this.stepDist = 0;
        const c = this.terrain.coverAt(w.feet.x, w.feet.z, this.cover);
        const hard = c[2] + c[6] + c[5]; // rock, gravel, urban
        const snow = c[3];
        const g = 0.2 * s.footsteps;
        if (snow > 0.5) this.burst(0.16, 'lowpass', 1400, 0.7, g * 0.9, (Math.random() - 0.5) * 0.2);
        else if (hard > 0.4) this.burst(0.09, 'bandpass', 2600, 1.2, g, (Math.random() - 0.5) * 0.2);
        else this.burst(0.12, 'lowpass', 750 + c[0] * -200, 0.8, g * 0.8, (Math.random() - 0.5) * 0.2);
      }
    } else {
      this.lastFeet.set(cam.x, cam.y, cam.z);
    }

    // ambience: daytime only, near the ground
    const day = this.time.sunDir.y > 0.05;
    if (day && agl < 400 && s.ambience > 0) {
      const c = this.terrain.coverAt(cam.x, cam.z, this.cover);
      const near = 1 - Math.min(1, agl / 400);
      this.nextBell -= dt;
      const pasture = c[1] * (cam.y > 1000 && cam.y < 2300 ? 1 : 0.2);
      if (this.nextBell <= 0) {
        this.nextBell = 0.4 + Math.random() * 3.5;
        if (Math.random() < pasture) this.bell(0.05 * near * s.ambience * (0.3 + Math.random() * 0.7), (Math.random() - 0.5) * 1.6);
      }
      this.nextBird -= dt;
      if (this.nextBird <= 0) {
        this.nextBird = 1 + Math.random() * 5;
        if (Math.random() < 0.25 + c[0] * 0.7) this.bird(0.025 * near * s.ambience, (Math.random() - 0.5) * 1.8);
      }
    }
  }
}
