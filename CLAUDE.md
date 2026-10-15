# Mini Open World — notes for Claude

Realistic mountain open world (real Jungfrau/Lauterbrunnen terrain) in three.js r186 `WebGPURenderer` + TSL,
editable by the user (side panel) and by Claude (agent bridge + CLI). Plan & decisions: `docs/PLAN.md`.
User speaks French (UI labels and chat in French, code/comments in English), has no 3D background.

## Hard rule: performance
- Target machine: MacBook Air M4 (10-core GPU, fanless), 60 Hz screen. Stress target = **frame ≤ 10 ms (aim ≤ 8)
  at 2560×1440**, measured uncapped with `npm run bench`. Real use (browser window ~1470×830, pixel ratio 1) is ~3×
  fewer pixels: `node tools/bench.mjs --width=1470 --height=830` (≈ 230–350 fps).
- The Air throttles when hot (up to ~45 % slower): compare variants **interleaved in one session** with
  `tools/ab.mjs`, never two separate bench runs. ABA (`git stash`) for code changes that are not settings.
- The in-app browser pane and normal Chrome are vsync-capped (60 fps max): never use them for perf numbers.
  `npm run uncapped` opens a separate Chrome without the cap (lets the user see real fps).
- GPU timestamp queries are unusable on Apple (`?gpuTiming` gives nonsense). `queue.onSubmittedWorkDone` latency
  is quantized to Chrome's ticks (~1 frame) — not a frame-cost metric either.
- `cpu` in stats includes time blocked in `queue.submit` (GPU backpressure). Real JS cost ≈ 3 ms/frame
  (`tools/profile.mjs`). Below ~0.3 resolution scale the frame becomes CPU-bound: don't diagnose GPU costs there.
- Uncapped Chrome has rare 10–14 ms interval spikes even on an empty page; most p95 excursions are real load at
  specific places: use `bench --timeline` (per-segment mean/p95) and `ab.mjs --range=u0,u1` on the hot segment.

## Run
- `npm run dev` (or preview_start "dev") → http://localhost:5173 (Chrome only, WebGPU).
- `npm run data` rebuilds `public/data/` from `data-raw/` (both git-ignored). Raw download: `node tools/data/fetch.mjs`.
  Terrain: `build-terrain.mjs`; surface/land cover: `build-surface.mjs`, `build-far-surface.mjs`; PBR layers:
  `build-textures.mjs`; twig atlas + tight card polygons: `build-trees.mjs`; OSM buildings: `fetch-osm.mjs` (Overpass)
  then `build-buildings.mjs` (meshes per 1 km tile + collision footprints); previews: `preview.mjs` → `screenshots/`.
- `tree-lab.html` (dev page): procedural tree preview.

## Agent tools (use these to see and edit the world)
- `node tools/agent.mjs <cmd> [k=v ...|json]` → runs a command in the app open in a browser (via Vite WS bridge).
  `help` lists commands. Key ones: `get`/`set`/`describe` (settings by path, e.g. `set terrain.lodDistance=300`),
  `camera {e,n,agl}|{x,y,z,yaw,pitch}|{lookAtPoi}`, `goto <poi> [look]`, `pois`, `stats`, `logs level=error`,
  `eval <js>` (REPL-like: `app` in scope, last statement returned, `await` ok), `screenshot name=x`
  (→ `screenshots/x.png`, then Read it to look), `save-settings` (→ `world/settings.json`), `bench`,
  `bench-path-check <path>` (camera clearance above ground), `forest-stats`, `impostor-atlas`, `mode`, `plane`.
- `node tools/run.mjs 'cmd a=1' 'cmd2' ...` → same commands in a private headless Chrome (2560×1440, uncapped;
  `--capped`, `--width/--height`, `--query=gpuTiming`, `--wait=ms`). Best way to screenshot/diagnose.
  To look at a bench path position: `eval await agent.run("bench",{paths:["walk"],range:[0.75,0.75],seconds:0.5,warmup:1.5}); 1`.
- `node tools/bench.mjs [--paths=valley,flyover,lake,walk] [--seconds=8] [--timeline] [--set=a.b=1]` → report
  (mean/p50/p95/p99, % frames > 10 ms), saves `bench-results/`.
- `node tools/ab.mjs --path=walk [--range=0.7,0.8] --seconds=4 --rounds=2 '' 'a.b=1' 'c.d=false'` → interleaved A/B
  (settings reset to defaults before each variant; '' = baseline).
- `node tools/profile.mjs [--path=valley]` CPU self time; `tools/alloc-profile.mjs` JS allocations;
  `tools/dev/*` low-level probes (minimal WebGPU page, spikes, GC trace).

## Architecture (src/)
- `core/engine.ts` Engine + System interface (init/update/afterRender), loop, stats. `core/settings.ts` schema-driven
  settings store: systems declare `settings.group(id, frenchTitle, defs)`; panel + agent use it automatically.
  `core/three-patches.ts` runtime patches of three internals (imported first).
- `terrain/` CDLOD quadtree (`cdlod.ts`, 32² full + 16² quarter patches, geomorphing), data (`terrain-data.ts`,
  CPU `heightAt()` mirrors GPU sampling), material (`terrain-material.ts`: 8 PBR layers from ortho land cover,
  macro de-lit ortho, cliffs, water, far canopy darkening).
- `sky/` time of day, atmosphere (Hillaire LUTs, aerial perspective volume, GPU SH sky light), clouds (baked
  Perlin-Worley + weather map, half-res march). `post/` TAAU-lite upscale (rg11b10 history), bloom, lens flare, ACES.
- `lighting/` heightfield shadow clipmap (`terrain-shadows.ts`, mountains + canopy to the horizon), near CSM
  (`sun-shadows.ts`), baked sky visibility (`sky-visibility.ts`), per-vertex/per-instance lighting for vegetation
  (`vertex-lighting.ts`), water reflections by heightfield ray march (`water-reflection.ts`), one-bounce terrain GI
  (`bounce-gi.ts`, 2.5D irradiance grid re-baked progressively when the sun moves; `gi-probe` command).
- `vegetation/` procedural conifers (`tree-generator.ts`), materials, octahedral impostors, GPU-scattered forest
  (`forest.ts`: compute scatter → indirect draws, LOD0/LOD1/4 impostor bands, dithered cross-fades), grass tufts.
  Rocks (`rocks.ts`: land-cover scatter, power-law sizes, sink fade; `RockQuery` CPU replica for collisions).
- `world/` airfield (runway strip with procedural markings), buildings (OSM, 2 km merged supertiles, procedural
  facades, night windows, sink into the terrain far away), `colliders.ts` (static colliders for the walker).
- `player/` free camera, walker (trunks via CPU replica of the scatter + world colliders), aircraft (flight model, gear).
- `agent/` bridge client, commands, benchmark camera paths. `editor/` Tweakpane panel (F1) and HUD.
- World coords: metres, origin = core centre (LV95 2638288/1162288), +X east, +Y up, −Z north. `world/geo.ts` POIs.

## Rendering patterns that matter here
- **Apple: max 16 samplers per fragment stage.** Three dedupes texture bindings by texture (same texture = one
  binding) but every linear-filtered texture costs a sampler. Nearest-filtered textures (min+mag `NearestFilter`)
  get no sampler → read them with `.load(ivec2)` (+ manual bilinear). Requested `maxSampledTexturesPerShaderStage` 32.
- Vegetation lighting terms (heightfield + cloud sun visibility, aerial perspective, sky visibility) are computed
  **per tree in the scatter compute** and stored in the instance record (4 × vec4); shaders interpolate base/top.
  Global shadow/fog nodes read them when `material.userData.vertexLighting` is set (see `vertex-lighting.ts`).
- Foliage depth pre-pass: masked depth-only pass, then shading with EQUAL depth and no discard. Requires
  `material.userData.invariantPosition = true` (@invariant patch) and, under reversed depth, `NotEqualDepth`
  (three r186 maps EqualDepth→NotEqual by mistake).
- Compute shaders have no camera: pass camera position / matrices as uniforms (`visibilityFromAt(p, cam)`,
  `aerialPerspective(p, uv, cam)`).

## Data
- Core 24.576 km square, 8192² heights (3 m, swissALTI3D 2 m source), far ring 81.92 km at 40 m (Copernicus GLO-30).
- Buildings: OpenStreetMap footprints (~24k in the core), heights from tags or per type.
- Attribution required (shown bottom-right, `#credits` in index.html): © swisstopo; Copernicus DEM © DLR/Airbus
  (EU/ESA); © OpenStreetMap contributors (ODbL); CC0 textures (Poly Haven, ambientCG).

## Gotchas
- `patch` is a reserved WGSL word (don't use it as attribute name). `window.app` collided with `<div id="app">`.
- Use `float(x)` for numeric args where TSL types require Nodes (e.g. `.level(float(0))`).
- TSL expressions are lazy: `.toVar()` any value read before a variable it depends on is mutated (loop accumulators!).
- Nested `Loop`s: give explicit names `Loop({start,end,name:'j'} as any, ({j}) => …)` or inner `i` shadows outer.
- Avoid `select(cond, int(a), int(b))` chains in compute (wrong result observed): compute indices with float math (`step`) then `int()`.
- Reversed depth buffer is on: build frustums with `camera.reversedDepth`.
- Bench paths are splines between keys: check them with `bench-path-check` (they used to go underground).
