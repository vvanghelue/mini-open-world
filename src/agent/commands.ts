// Built-in agent commands. Systems may register more with registerCommand().
import { Vector3 } from 'three/webgpu';
import { registerCommand, listCommands, getLogs, writeProjectFile } from './bridge';
import { settings, SettingValue } from '../core/settings';
import { summarize, timeline } from '../core/stats';
import { POIS, lv95ToWorld, worldToLV95 } from '../world/geo';
import { resolvePath, BENCH_PATHS } from './bench-paths';
import type { App } from '../app';

const _v = new Vector3();

function waitFrames(app: App, n: number) {
  return new Promise<void>((resolve) => {
    let k = 0;
    const tick = () => {
      if (++k >= n) resolve();
      else app.engine.afterNextFrame(tick);
    };
    app.engine.afterNextFrame(tick);
  });
}

export function registerBuiltinCommands(app: App) {
  const { engine } = app;

  registerCommand('help', 'List available commands', () => listCommands());
  registerCommand('ping', 'Check the app is alive', () => ({ pong: true, frame: engine.frame }));

  registerCommand('get', 'Get settings: {path?} (prefix match, no path = all)', ({ path, _ }) => {
    const p = path ?? _?.[0];
    const snap = settings.snapshot();
    if (!p) return snap;
    return Object.fromEntries(Object.entries(snap).filter(([k]) => k === p || k.startsWith(p + '.')));
  });
  registerCommand('set', 'Set settings: {"group.key": value, ...} or path=value', (args) => {
    const out: Record<string, SettingValue | undefined> = {};
    const entries = Object.entries(args).filter(([k]) => k !== '_');
    if (args._?.length === 2) entries.push([args._[0], args._[1]]);
    for (const [k, v] of entries) {
      if (!settings.has(k)) throw new Error(`unknown setting "${k}"`);
      settings.set(k, v as SettingValue);
      out[k] = settings.get(k);
    }
    return out;
  });
  registerCommand('describe', 'Describe all settings (ranges, defaults, labels)', () => settings.describe());
  registerCommand('save-settings', 'Save non-default settings to world/settings.json', async () => {
    const data = settings.snapshot(false);
    await writeProjectFile('world/settings.json', JSON.stringify(data, null, 2));
    return { saved: Object.keys(data).length };
  });

  registerCommand('camera', 'Get camera pose, or set it: {x,y,z,yaw,pitch} | {lookAt:[x,y,z]} | {e,n,agl}', (a) => {
    const cam = app.freeCam;
    if (a.e !== undefined && a.n !== undefined) {
      const w = lv95ToWorld(a.e, a.n);
      const y = a.y ?? app.terrain.heightAt(w.x, w.z) + (a.agl ?? 2);
      cam.setPose({ x: w.x, y, z: w.z });
    } else if (a.x !== undefined) {
      cam.setPose({ x: a.x, y: a.y ?? cam.position.y, z: a.z ?? cam.position.z }, a.yaw ?? cam.yaw, a.pitch ?? cam.pitch);
    } else if (a.yaw !== undefined || a.pitch !== undefined) {
      cam.setPose(cam.position, a.yaw ?? cam.yaw, a.pitch ?? cam.pitch);
    }
    if (a.lookAt) cam.lookAt({ x: a.lookAt[0], y: a.lookAt[1], z: a.lookAt[2] });
    if (a.lookAtPoi) {
      const p = POIS[a.lookAtPoi];
      const w = lv95ToWorld(p.e, p.n);
      cam.lookAt({ x: w.x, y: app.terrain.heightAt(w.x, w.z), z: w.z });
    }
    const p = cam.position;
    const lv = worldToLV95(p.x, p.z);
    return {
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +cam.yaw.toFixed(4), pitch: +cam.pitch.toFixed(4),
      ground: +app.terrain.heightAt(p.x, p.z).toFixed(2), lv95: [Math.round(lv.e), Math.round(lv.n)],
    };
  });

  registerCommand('goto', 'Teleport to a POI: {poi, agl=300, look=poi2}', ({ poi, agl, look, _ }) => {
    const name = poi ?? _?.[0];
    const p = POIS[name];
    if (!p) throw new Error(`unknown POI "${name}" (${Object.keys(POIS).join(', ')})`);
    const w = lv95ToWorld(p.e, p.n);
    app.freeCam.setPose({ x: w.x, y: app.terrain.heightAt(w.x, w.z) + (agl ?? 300), z: w.z });
    const t = POIS[look ?? _?.[1] ?? 'jungfrau'];
    if (t && t !== p) {
      const tw = lv95ToWorld(t.e, t.n);
      app.freeCam.lookAt({ x: tw.x, y: app.terrain.heightAt(tw.x, tw.z), z: tw.z });
    }
    return { ok: true, at: name };
  });
  registerCommand('pois', 'List points of interest', () =>
    Object.fromEntries(Object.entries(POIS).map(([k, p]) => [k, { ...p, world: lv95ToWorld(p.e, p.n) }])),
  );

  registerCommand('stats', 'Current frame statistics (averaged over last 240 frames)', () => engine.stats.summary());

  // GPU time per render/compute pass of the last resolved frame. Labels come from the render target / compute node names.
  const backend = engine.renderer.backend as any;
  const labels = new Map<string, string>();
  const origUpdate = backend.updateTimeStampUID.bind(backend);
  backend.updateTimeStampUID = (ctx: any) => {
    origUpdate(ctx);
    const uid: string = backend.get(ctx).timestampUID;
    const key = uid.replace(/:f\d+$/, '');
    if (!labels.has(key)) {
      let label = 'canvas';
      if (Array.isArray(ctx)) label = 'compute[' + ctx.map((c: any) => c.name || c.id).join(',') + ']';
      else if (ctx.isComputeNode) label = 'compute:' + (ctx.name || ctx.id);
      else if (ctx.renderTarget) label = ctx.renderTarget.texture?.name || ctx.renderTarget.textures?.[0]?.name || 'rt#' + ctx.renderTarget.id;
      else if (ctx.depthTexture) label = 'depth';
      labels.set(key, label);
    }
  };
  registerCommand('gpu-passes', 'GPU ms per pass for the last resolved frame (needs timestamp-query)', () => {
    const out: Array<{ pass: string; ms: number }> = [];
    for (const type of ['render', 'compute']) {
      const pool = backend.timestampQueryPool?.[type];
      if (!pool) continue;
      for (const [uid, ms] of pool.timestamps as Map<string, number>) {
        const key = uid.replace(/:f\d+$/, '');
        out.push({ pass: `${key.split(':').slice(0, 2).join(':')} ${labels.get(key) ?? '?'}`, ms: Math.round(ms * 1000) / 1000 });
      }
    }
    const total = out.reduce((s, p) => s + p.ms, 0);
    return { totalMs: Math.round(total * 1000) / 1000, passes: out };
  });
  registerCommand('logs', 'Recent console messages: {since=0, level}', ({ since, level }) =>
    getLogs(since ?? 0).filter((l) => !level || l.level === level),
  );
  registerCommand('eval', 'Evaluate JS in the app (window.app available): {code}', async ({ code, _ }) => {
    const src: string = (code ?? _?.join(' ')).trim().replace(/;$/, '');
    // REPL-like: without an explicit return, the last statement's value is returned
    const cut = src.lastIndexOf(';');
    const body = src.includes('return') ? src : cut >= 0 ? `${src.slice(0, cut + 1)} return ${src.slice(cut + 1)}` : `return ${src}`;
    // eslint-disable-next-line no-new-func
    const fn = new Function('app', `return (async () => { ${body} })()`);
    const r = await fn(app);
    try {
      return JSON.parse(JSON.stringify(r ?? null));
    } catch {
      return String(r);
    }
  });

  registerCommand('screenshot', 'Capture the canvas to screenshots/<name>.png: {name, wait=30 frames}', async ({ name, wait, _ }) => {
    const file = `screenshots/${name ?? _?.[0] ?? 'shot-' + Date.now()}.png`;
    await waitFrames(app, wait ?? 30);
    const blob = await new Promise<Blob>((resolve, reject) => {
      engine.afterNextFrame(() => {
        (engine.renderer.domElement as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      });
    });
    await writeProjectFile(file, blob);
    return { path: file, bytes: blob.size };
  });

  registerCommand('bench-path-check', 'Camera height above ground along a bench path: {path, samples=40} -> min AGL and per-sample AGL', ({ path, samples, _ }) => {
    const name = path ?? _?.[0];
    const { pos } = resolvePath(name, (x, z) => app.terrain.heightAt(x, z));
    const n = samples ?? 40;
    const agl: number[] = [];
    for (let i = 0; i <= n; i++) {
      pos.getPointAt(i / n, _v);
      agl.push(Math.round(_v.y - app.terrain.heightAt(_v.x, _v.z)));
    }
    const min = Math.min(...agl);
    return { min, atU: agl.indexOf(min) / n, agl: agl.join(' ') };
  });

  registerCommand('bench', 'Run benchmark camera paths: {paths=[valley,flyover,walk], warmup=3, seconds, range=[u0,u1] (sub-section of the path)}', async ({ paths, warmup, seconds, range }) => {
    const [u0, u1]: [number, number] = range ?? [0, 1];
    const names: string[] = paths ?? Object.keys(BENCH_PATHS);
    const results: Record<string, unknown> = {};
    const prevEnabled = app.freeCam.enabled;
    app.freeCam.enabled = false;
    try {
      for (const name of names) {
        const resolved = resolvePath(name, (x, z) => app.terrain.heightAt(x, z));
        const { pos, look } = resolved;
        const def = { ...resolved.def, seconds: seconds ?? resolved.def.seconds };
        const total = def.seconds + (warmup ?? 3);
        let t0 = -1;
        const rec = { interval: [] as number[], cpu: [] as number[], gpu: [] as number[] };
        await new Promise<void>((resolve) => {
          engine.driver = () => {
            const now = performance.now() / 1000;
            if (t0 < 0) t0 = now;
            const el = now - t0;
            if (el >= (warmup ?? 3) && !engine.stats.recorder) engine.stats.recorder = rec;
            const u = u0 + (u1 - u0) * Math.min(1, Math.max(0, (el - (warmup ?? 3)) / def.seconds));
            pos.getPointAt(u, engine.camera.position);
            look.getPointAt(u, _v);
            app.freeCam.setPose(engine.camera.position);
            app.freeCam.lookAt(_v);
            if (el >= total) {
              engine.driver = null;
              engine.stats.recorder = null;
              resolve();
            }
          };
        });
        results[name] = {
          label: def.label,
          frameMs: summarize(rec.interval),
          timeline: timeline(rec.interval),
          cpuMs: summarize(rec.cpu),
          gpuMs: summarize(rec.gpu),
          drawCalls: engine.stats.drawCalls,
          triangles: engine.stats.triangles,
        };
      }
    } finally {
      app.freeCam.enabled = prevEnabled;
      engine.driver = null;
      engine.stats.recorder = null;
    }
    return results;
  });
}
