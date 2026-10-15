// Dynamic resolution: keeps the frame time under a budget by lowering the internal render resolution in heavy
// scenes and raising it back when there is headroom (TAAU upscaling hides the change). Works in both browser modes:
//  - uncapped (no vsync): the frame interval is the real frame cost -> target = 1000 / targetFps
//  - vsync-capped (normal browser, 60 Hz display): intervals sit at the refresh period whatever the GPU load, so
//    the scale only drops when frames miss vsync and is raised back cautiously after a long clean period.
// Each change reallocates the internal render targets (~1 ms once): changes are quantised and rate-limited.
// Second stage: once the resolution floor is reached and the budget is still exceeded, the detail level
// (adaptive.quality) is lowered, shortening forest / grass / rock detail distances; it is restored first when there is
// headroom (then the resolution). Detail moves smoothly towards its target (dithered LOD transitions stay invisible).
import { renderSettings } from '../core/engine';

export interface DynResState {
  scale: number; // current internal resolution scale
  capped: boolean; // vsync-locked frame rate detected
  period: number; // detected refresh period (ms) when capped
  quality: number; // detail level 0..1 (smoothed)
}

const WINDOW = 40;
const STEP = 0.025;

export class DynamicResolution {
  readonly state: DynResState = { scale: renderSettings.resolutionScale, capped: false, period: 16.67, quality: 1 };
  private qTarget = 1;
  private samples: number[] = [];
  private sinceChange = 0;
  private cleanTime = 0;
  private lastDrop = -1e9;
  private clock = 0;

  constructor(private apply: (scale: number) => void) {}

  /** Resets to the user's maximum scale (settings changed, dynamic resolution toggled). */
  reset() {
    this.samples.length = 0;
    this.cleanTime = 0;
    this.qTarget = 1;
    this.set(renderSettings.resolutionScale);
  }

  private atFloor() {
    const min = Math.min(renderSettings.minResolutionScale, renderSettings.resolutionScale);
    return this.state.scale <= min + 1e-4;
  }

  /** Over budget: lower the resolution, or the detail level once the resolution floor is reached. */
  private degrade(scaleTarget: number) {
    if (!this.atFloor()) this.set(scaleTarget);
    else if (this.qTarget > 0) {
      this.qTarget = Math.max(0, this.qTarget - 0.25);
      this.sinceChange = 0;
      this.samples.length = 0;
    }
    this.lastDrop = this.clock;
    this.cleanTime = 0;
  }

  /** Headroom: restore the detail level first, then the resolution. */
  private improve() {
    if (this.qTarget < 1) {
      this.qTarget = Math.min(1, this.qTarget + 0.25);
      this.sinceChange = 0;
      this.samples.length = 0;
    } else this.set(this.state.scale + STEP);
    this.cleanTime = 0;
  }

  private set(s: number) {
    const max = renderSettings.resolutionScale;
    const min = Math.min(renderSettings.minResolutionScale, max);
    const q = Math.min(max, Math.max(min, Math.round(s / STEP) * STEP));
    if (Math.abs(q - this.state.scale) < 1e-4) return;
    this.state.scale = q;
    this.apply(q);
    this.sinceChange = 0;
    this.samples.length = 0;
  }

  /** Call once per frame with the measured frame interval (ms). */
  update(intervalMs: number) {
    if (!renderSettings.dynamicResolution) {
      if (this.state.scale !== renderSettings.resolutionScale) this.set(renderSettings.resolutionScale);
      this.qTarget = 1;
      this.state.quality = 1;
      return;
    }
    if (!(intervalMs > 0) || intervalMs > 250) return; // tab switches, debugger pauses
    // detail level glides towards its target (full range in ~3 s)
    const dq = this.qTarget - this.state.quality;
    this.state.quality += Math.sign(dq) * Math.min(Math.abs(dq), (intervalMs / 1000) * 0.35);
    this.clock += intervalMs / 1000;
    this.sinceChange += intervalMs / 1000;
    if (this.clock < 4) return; // loading / shader warm-up hitches are not a load signal
    this.samples.push(intervalMs);
    if (this.samples.length > WINDOW) this.samples.shift();
    if (this.samples.length < WINDOW || this.sinceChange < 0.4) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const med = sorted[WINDOW >> 1];
    const p10 = sorted[Math.floor(WINDOW * 0.1)], p90 = sorted[Math.floor(WINDOW * 0.9)];
    // vsync lock: tight cluster around a common display period (60/72/90/120/144 Hz)
    const periods = [16.667, 13.889, 11.111, 8.333, 6.944];
    const near = periods.find((p) => Math.abs(med - p) < Math.max(0.25, p * 0.02));
    const capped = near !== undefined && p90 - p10 < Math.max(0.8, near * 0.06);
    this.state.capped = capped || (this.state.capped && near !== undefined && misses(this.samples, near) > 0);
    if (near !== undefined) this.state.period = near;
    const s = this.state.scale;
    const max = renderSettings.resolutionScale;

    if (this.state.capped) {
      // frames that missed vsync (> 1.5 periods): the GPU cannot keep the display rate at this scale. Isolated
      // spikes (GC, system activity) are not a load signal: require a sustained share of missed frames.
      const missed = misses(this.samples, this.state.period);
      if (missed >= WINDOW * 0.15) {
        this.degrade(s - 2 * STEP);
      } else if (missed <= 1) {
        this.cleanTime += this.sinceChange;
        this.sinceChange = 0;
        // raise slowly; wait longer after a recent drop (avoid oscillating around the limit)
        const wait = this.clock - this.lastDrop < 20 ? 8 : 3;
        if ((s < max || this.qTarget < 1) && this.cleanTime > wait) this.improve();
      }
      return;
    }

    // uncapped: frame interval = frame cost
    const target = 1000 / renderSettings.targetFps;
    if (p90 > target * 1.02) {
      // proportional step (pixel cost ~ scale^2), at least one step
      const k = Math.sqrt(target / p90);
      // while the detail level is still gliding down, give it time before another step
      if (Math.abs(this.state.quality - this.qTarget) < 0.05) this.degrade(Math.min(s - STEP, s * (0.15 + 0.85 * k)));
    } else if (p90 < target * 0.82 && (s < max || this.qTarget < 1)) {
      this.cleanTime += this.sinceChange;
      this.sinceChange = 0;
      if (this.cleanTime > (this.clock - this.lastDrop < 10 ? 2.5 : 1)) this.improve();
    } else {
      this.cleanTime = 0;
    }
  }
}

function misses(samples: number[], period: number) {
  let n = 0;
  for (const v of samples) if (v > period * 1.5) n++;
  return n;
}
