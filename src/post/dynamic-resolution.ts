// Dynamic resolution: keeps the frame time under a budget by lowering the internal render resolution in heavy
// scenes and raising it back when there is headroom (TAAU upscaling hides the change). Works in both browser modes:
//  - uncapped (no vsync): the frame interval is the real frame cost -> target = 1000 / targetFps
//  - vsync-capped (normal browser, 60 Hz display): intervals sit at the refresh period whatever the GPU load, so
//    the scale only drops when frames miss vsync and is raised back cautiously after a long clean period.
// Each change reallocates the internal render targets (one slow frame): changes are quantised and rate-limited, and
// every resolution drop is checked: if the next measurement shows no real gain (geometry-bound view, external load),
// further resolution drops pause (8 s, 30 s on repeated strikes) and the detail level is used instead.
// Second stage: once the resolution floor is reached and the budget is still exceeded, the detail level
// (adaptive.quality) is lowered, shortening forest / grass / rock detail distances; it is restored first when there is
// headroom (then the resolution). Detail moves smoothly towards its target (dithered LOD transitions stay invisible).
// Last resort, at minimum resolution and detail: the output (canvas) resolution drops to 80 % then 65 % (output passes —
// upscale, bloom, tone mapping — dominate at 2560x1440). Restored first. Only reachable on very large windows.
import { renderSettings } from '../core/engine';

export interface DynResState {
  scale: number; // current internal resolution scale
  capped: boolean; // vsync-locked frame rate detected
  period: number; // detected refresh period (ms) when capped
  quality: number; // detail level 0..1 (smoothed)
}

const WINDOW = 40;
const TAIL = 120;
/** Output (canvas) size steps of the last-resort stage. */
const OUTPUT_STEPS = [1, 0.8, 0.65];
const STEP = 0.025;

export class DynamicResolution {
  readonly state: DynResState = { scale: renderSettings.resolutionScale, capped: false, period: 16.67, quality: 1 };
  private qTarget = 1;
  private uncappedVotes = 0;
  // large overload (p90 > 1.3 x target, e.g. full quality after a load or a teleport into a heavy view): decide
  // twice as often, take double detail steps and glide faster, so the floor is reached in ~3 s instead of ~12 s
  private urgent = false;
  private probe: { from: number; metric: number } | null = null; // pending check of the last resolution drop
  private resBlockedUntil = -1;
  private probeStrikes = 0; // recent ineffective resolution drops
  private lastStrike = -1e9;
  private samples: number[] = [];
  // longer history for the tail: the p95 over ~1 s, which the frame budget is judged on (the p90 of the 40-frame
  // window can stay under target while GPU / compositor hiccups push the p95 over the budget)
  private tail: number[] = [];
  private sinceChange = 0;
  private cleanTime = 0;
  private lastDrop = -1e9;
  private clock = 0;

  constructor(private apply: (scale: number) => void, private applyOutput: (factor: number) => void = () => {}) {}
  outputScale = 1;
  private outputSince = -1e9;

  /** Resets to the user's maximum scale (settings changed, dynamic resolution toggled). */
  reset() {
    this.samples.length = this.tail.length = 0;
    this.cleanTime = 0;
    this.qTarget = 1;
    if (this.outputScale !== 1) this.applyOutput((this.outputScale = 1));
    this.outputSince = -1e9;
    this.probe = null;
    this.resBlockedUntil = -1;
    this.probeStrikes = 0;
    this.set(renderSettings.resolutionScale);
  }

  private atFloor() {
    const min = Math.min(renderSettings.minResolutionScale, renderSettings.resolutionScale);
    return this.state.scale <= min + 1e-4;
  }

  /** Over budget: lower the resolution (if that lever works here), else the detail level.
   *  `metric` = what the drop should reduce (trimmed mean uncapped, missed frames capped), checked at the next
   *  evaluation. */
  private degrade(scaleTarget: number, metric: number) {
    if (!this.atFloor() && this.clock >= this.resBlockedUntil) {
      const from = this.state.scale;
      this.set(Math.min(scaleTarget, from - 2 * STEP));
      // the effectiveness check is skipped under a large overload: every lever is taken (a fast-changing view then
      // makes the check unreliable, and being over budget costs more than a possibly useless reallocation)
      if (this.state.scale < from && !this.urgent) this.probe = { from, metric };
    } else if (this.qTarget > 0) {
      this.qTarget = Math.max(0, this.qTarget - (this.urgent ? 0.5 : 0.25));
      this.sinceChange = 0;
      this.samples.length = this.tail.length = 0;
    } else if (this.state.quality < 0.02 && this.outputScale > OUTPUT_STEPS[OUTPUT_STEPS.length - 1] && this.clock - this.outputSince > (this.urgent ? 1.5 : 4)) {
      this.applyOutput((this.outputScale = OUTPUT_STEPS[OUTPUT_STEPS.indexOf(this.outputScale) + 1]));
      this.outputSince = this.clock;
      this.sinceChange = 0;
      this.samples.length = this.tail.length = 0;
    }
    this.lastDrop = this.clock;
    this.cleanTime = 0;
  }

  /** Headroom: restore the output size first, then the detail level, then the resolution.
   *  `load` = p90 / target (0 when unknown). The output stage changes the canvas size (one slow frame) and nearly
   *  halves the output cost, so it is held for 30 s and restored only with a large margin (no oscillation). */
  private improve(load = 0) {
    if (this.outputScale !== 1) {
      if (this.clock - this.outputSince < 30 || load > 0.62) return;
      this.applyOutput((this.outputScale = OUTPUT_STEPS[OUTPUT_STEPS.indexOf(this.outputScale) - 1]));
      this.outputSince = this.clock;
      this.sinceChange = 0;
      this.samples.length = this.tail.length = 0;
    } else if (this.qTarget < 1) {
      this.qTarget = Math.min(1, this.qTarget + 0.25);
      this.sinceChange = 0;
      this.samples.length = this.tail.length = 0;
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
    this.samples.length = this.tail.length = 0;
  }

  /** Call once per frame with the measured frame interval (ms). */
  update(intervalMs: number) {
    if (!renderSettings.dynamicResolution) {
      if (this.state.scale !== renderSettings.resolutionScale) this.set(renderSettings.resolutionScale);
      this.qTarget = 1;
      this.state.quality = 1;
      if (this.outputScale !== 1) this.applyOutput((this.outputScale = 1));
      return;
    }
    if (!(intervalMs > 0) || intervalMs > 250) return; // tab switches, debugger pauses
    // detail level glides towards its target (full range in ~3 s)
    const dq = this.qTarget - this.state.quality;
    this.state.quality += Math.sign(dq) * Math.min(Math.abs(dq), (intervalMs / 1000) * (this.urgent && dq < 0 ? 1 : 0.35));
    this.clock += intervalMs / 1000;
    this.sinceChange += intervalMs / 1000;
    if (this.clock < 1.5) return; // loading / shader warm-up hitches are not a load signal
    this.samples.push(intervalMs);
    this.tail.push(intervalMs);
    if (this.tail.length > TAIL) this.tail.shift();
    if (this.samples.length > WINDOW) this.samples.shift();
    if (this.samples.length < WINDOW || this.sinceChange < (this.urgent ? 0.4 : 0.8)) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const med = sorted[WINDOW >> 1];
    const p10 = sorted[Math.floor(WINDOW * 0.1)], p90 = sorted[Math.floor(WINDOW * 0.9)];
    // trimmed mean (slowest 10 % excluded): stable from window to window, and ignores the one slow frame that a
    // resolution change itself causes (render target reallocation)
    let tm = 0;
    const keep = Math.floor(WINDOW * 0.9);
    for (let i = 0; i < keep; i++) tm += sorted[i];
    tm /= keep;
    // vsync lock: frame intervals are quantised to multiples of the display period (60/72/90/120/144 Hz), with
    // 1-2 ms of jitter on real displays; uncapped intervals are continuous. Enter when the median sits on a period
    // and nearly all intervals are quantised; leave after repeated evidence of continuous intervals. Frames that
    // miss vsync (2 periods) stay quantised, so the capped logic handles them (and lowers the scale).
    const periods = [16.667, 13.889, 11.111, 8.333, 6.944];
    const near = periods.find((p) => Math.abs(med - p) < Math.max(0.35, p * 0.03));
    if (!this.state.capped) {
      // vsync is also a floor: no frame comes clearly faster than the period (an uncapped stream that happens to
      // average ~8.3 ms would otherwise look like 120 Hz)
      if (near !== undefined && quantisedShare(this.samples, near) >= 0.85 && p10 >= near * 0.85) {
        this.state.capped = true;
        this.state.period = near;
        this.uncappedVotes = 0;
      }
    } else if (quantisedShare(this.samples, this.state.period) < 0.6 || p10 < this.state.period * 0.75) {
      if (++this.uncappedVotes >= 3) this.state.capped = false;
    } else this.uncappedVotes = 0;
    // did the last resolution drop pay off?
    if (this.probe) {
      const pr = this.probe;
      this.probe = null;
      const ineffective = this.state.capped
        ? misses(this.samples, this.state.period) >= pr.metric * 0.7
        : pr.metric - tm < Math.max(0.12, pr.metric * 0.02);
      if (ineffective) {
        // the drop is kept (reverting costs another reallocation, and in a fast-changing view the "no gain" may be
        // scene variation): further drops pause 8 s, or 30 s on repeated strikes (view not pixel-bound: the
        // detail level takes over). Strikes expire after 45 s.
        if (this.clock - this.lastStrike > 45) this.probeStrikes = 0;
        this.probeStrikes++;
        this.lastStrike = this.clock;
        this.resBlockedUntil = this.clock + (this.probeStrikes >= 2 ? 30 : 8);
      } else this.probeStrikes = 0;
    }
    const s = this.state.scale;
    const max = renderSettings.resolutionScale;

    if (this.state.capped) {
      // frames that missed vsync (> 1.5 periods): the GPU cannot keep the display rate at this scale. Isolated
      // spikes (GC, system activity) are not a load signal: require a sustained share of missed frames.
      const missed = misses(this.samples, this.state.period);
      if (missed >= WINDOW * 0.15) {
        this.degrade(s - 2 * STEP, missed);
      } else if (missed <= 1) {
        this.cleanTime += this.sinceChange;
        this.sinceChange = 0;
        // raise slowly; wait longer after a recent drop (avoid oscillating around the limit)
        const wait = this.clock - this.lastDrop < 20 ? 6 : 2;
        if ((s < max || this.qTarget < 1 || this.outputScale !== 1) && this.cleanTime > wait) this.improve();
      }
      return;
    }

    // uncapped: frame interval = frame cost
    // aim below the budget: p90 at 85 % of it keeps the tail (p95: GPU / compositor hiccups outside our JS) under it
    const target = (1000 / renderSettings.targetFps) * 0.85;
    this.urgent = p90 > target * 1.3;
    const budget = 1000 / renderSettings.targetFps;
    let p95t = 0;
    if (this.tail.length >= TAIL) {
      const st = [...this.tail].sort((a, b) => a - b);
      p95t = st[Math.floor(TAIL * 0.95)];
    }
    if (p90 > target * 1.02 || p95t > budget * 0.95) {
      // proportional step (pixel cost ~ scale^2), at least one step
      const k = Math.sqrt(target / p90);
      // while the detail level is still gliding down, give it time before another step
      if (Math.abs(this.state.quality - this.qTarget) < 0.05) this.degrade(s * (0.15 + 0.85 * k), tm);
    } else if (p90 < target * 0.8 && p95t < budget * 0.8 && (s < max || this.qTarget < 1 || this.outputScale !== 1)) {
      this.cleanTime += this.sinceChange;
      this.sinceChange = 0;
      if (this.cleanTime > (this.clock - this.lastDrop < 10 ? 2.5 : 1)) this.improve(p90 / target);
    } else {
      this.cleanTime = 0;
    }
  }
}

/** Share of intervals within +-12 % of a whole number (>= 1) of display periods. */
function quantisedShare(samples: number[], period: number) {
  let n = 0;
  for (const v of samples) {
    const k = Math.round(v / period);
    if (k >= 1 && Math.abs(v / period - k) < 0.12) n++;
  }
  return n / samples.length;
}

function misses(samples: number[], period: number) {
  let n = 0;
  for (const v of samples) if (v > period * 1.5) n++;
  return n;
}
