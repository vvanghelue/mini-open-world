import { Engine } from './core/engine';
import { Input } from './core/input';
import { settings } from './core/settings';
import { Terrain } from './terrain/terrain';
import { Post } from './post/post';
import { FreeCamera } from './player/free-camera';
import { Player } from './player/player';
import { Panel } from './editor/panel';
import { Hud } from './editor/hud';
import { startBridge } from './agent/bridge';
import { registerBuiltinCommands } from './agent/commands';
import { TimeOfDay } from './sky/time-of-day';
import { Atmosphere } from './sky/atmosphere';
import { TerrainShadows } from './lighting/terrain-shadows';
import { Forest } from './vegetation/forest';
import { POIS, lv95ToWorld } from './world/geo';
import type { App } from './app';

const loadingText = document.getElementById('loading-text')!;
const loadingBar = document.getElementById('loading-bar')!;
const progress = (msg: string, frac: number) => {
  loadingText.textContent = msg;
  loadingBar.style.width = `${Math.round(frac * 100)}%`;
};

async function loadWorldSettings() {
  try {
    const res = await fetch('/world/settings.json', { cache: 'no-store' });
    if (res.ok) settings.load(await res.json());
  } catch {
    /* no saved settings */
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  startBridge({ url: location.href, bench: params.has('bench'), ua: navigator.userAgent });
  await loadWorldSettings();

  const engine = await Engine.create(document.getElementById('viewport')!);
  const input = new Input(engine.renderer.domElement);
  const freeCam = new FreeCamera(engine.camera, input);

  const time = engine.add(new TimeOfDay());
  const terrain = engine.add(new Terrain(progress));
  const atmosphere = engine.add(new Atmosphere(time));
  const terrainShadows = engine.add(new TerrainShadows(terrain, time));
  const forest = engine.add(new Forest(terrain, atmosphere, terrainShadows));
  engine.add(new Post());
  const player = engine.add(new Player(terrain, freeCam, input));
  engine.add({ name: 'input-end', afterRender: () => input.endFrame() });

  await engine.initSystems((name, i, n) => progress(`Initialisation : ${name}`, i / n));
  // sun visibility = heightfield shadows (custom shadow node: no shadow map rendering for the terrain)
  engine.renderer.shadowMap.enabled = true;
  atmosphere.sunLight.castShadow = true;
  (atmosphere.sunLight.shadow as any).shadowNode = terrainShadows.shadowNode;
  freeCam.groundHeight = (x, z) => terrain.heightAt(x, z);

  // Initial view: above Wengen, looking at the Jungfrau.
  const w = lv95ToWorld(POIS.wengen.e, POIS.wengen.n);
  freeCam.setPose({ x: w.x, y: terrain.heightAt(w.x, w.z) + 250, z: w.z });
  const j = lv95ToWorld(POIS.jungfrau.e, POIS.jungfrau.n);
  freeCam.lookAt({ x: j.x, y: terrain.heightAt(j.x, j.z), z: j.z });

  const hud = new Hud(engine);
  const panel = new Panel();
  hud.lines.set('player', () => player.hudLine());
  hud.lines.set('time', () => {
    const p = engine.camera.position;
    return `heure ${time.label()}   alt ${p.y.toFixed(0)} m   sol ${(p.y - terrain.heightAt(p.x, p.z)).toFixed(0)} m`;
  });
  engine.add({ name: 'hud', afterRender: () => hud.update(performance.now()) });

  const app: App = { engine, input, terrain, freeCam, panel, hud, time, atmosphere, terrainShadows, forest, player };
  (window as any).app = app;
  registerBuiltinCommands(app);

  // Compile all pipelines before the first visible frame (no shader hitches later).
  progress('Compilation des shaders…', 1);
  await engine.renderer.compileAsync(engine.scene, engine.camera);

  engine.start();
  const loading = document.getElementById('loading')!;
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 500);
}

main().catch((err) => {
  console.error(err);
  loadingText.textContent = `Erreur : ${err.message ?? err}`;
});
