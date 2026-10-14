// Frame timing statistics: wall-clock frame interval, CPU time spent in our frame, GPU time (timestamp queries).
// Fixed-size ring buffers, no per-frame allocation.

export class Ring {
  private buf: Float32Array;
  private i = 0;
  count = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  push(v: number) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }
  mean(): number {
    if (!this.count) return 0;
    let s = 0;
    for (let k = 0; k < this.count; k++) s += this.buf[k];
    return s / this.count;
  }
  max(): number {
    let m = 0;
    for (let k = 0; k < this.count; k++) m = Math.max(m, this.buf[k]);
    return m;
  }
  percentile(p: number): number {
    if (!this.count) return 0;
    const a = Array.from(this.buf.subarray(0, this.count)).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  }
  values(): number[] {
    const out: number[] = [];
    const n = this.buf.length;
    const start = this.count < n ? 0 : this.i;
    for (let k = 0; k < this.count; k++) out.push(this.buf[(start + k) % n]);
    return out;
  }
  clear() {
    this.i = 0;
    this.count = 0;
  }
}

export class FrameStats {
  interval = new Ring(240); // ms between frames (what the user experiences)
  cpu = new Ring(240); // ms of JS work per frame (update + render submission)
  gpu = new Ring(240); // ms of GPU work per frame (render + compute passes)
  drawCalls = 0;
  triangles = 0;
  computeCalls = 0;
  gpuSupported = false;

  /** Optional recorder used by the benchmark. */
  recorder: { interval: number[]; cpu: number[]; gpu: number[] } | null = null;

  record(interval: number, cpu: number) {
    this.interval.push(interval);
    this.cpu.push(cpu);
    if (this.recorder) {
      this.recorder.interval.push(interval);
      this.recorder.cpu.push(cpu);
    }
  }

  recordGpu(ms: number) {
    this.gpu.push(ms);
    if (this.recorder) this.recorder.gpu.push(ms);
  }

  summary() {
    const r = (x: number) => Math.round(x * 100) / 100;
    return {
      fps: r(1000 / Math.max(0.001, this.interval.mean())),
      intervalMs: { mean: r(this.interval.mean()), p95: r(this.interval.percentile(95)), p99: r(this.interval.percentile(99)), max: r(this.interval.max()) },
      cpuMs: { mean: r(this.cpu.mean()), p95: r(this.cpu.percentile(95)) },
      gpuMs: this.gpuSupported ? { mean: r(this.gpu.mean()), p95: r(this.gpu.percentile(95)), p99: r(this.gpu.percentile(99)) } : null,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      computeCalls: this.computeCalls,
    };
  }
}

export function summarize(values: number[]) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const pick = (p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: a.length, mean: r(mean), p50: r(pick(50)), p95: r(pick(95)), p99: r(pick(99)), max: r(a[a.length - 1]) };
}
