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
- Dynamic resolution (`post/dynamic-resolution.ts`, on by default): internal scale between `render.minResolutionScale`
  and `render.resolutionScale`, target `render.targetFps` uncapped; vsync-capped it only drops on missed frames.
  `bench` reports the mean/min scale; `ab.mjs` disables it unless `--dyn` (else it absorbs the measured difference).
  Second stage: at the resolution floor, `adaptive.quality` (core/adaptive.ts) shortens forest/grass/rock/building/
  road distances, terrain LOD, cloud and reflection steps, distant forest density (`qualityScaled()`) and alternates
  the shadow cascades. Third (last) stage: output canvas at 80 % then 65 % (`adaptive.outputScale`, each step held
  >= 30 s; at 2560x1440 the output-size passes dominate the floor). Bench column `out80%` = time with reduced output.
  `ab.mjs` alternates the variant order between rounds (heat drift within a round). Urgency mode (p90 > 1.3 x target:
  0.4 s decisions, double detail steps, no effectiveness check) reaches the floor in ~3 s after a load or teleport. Restored in
  reverse order. `render.forceDetail` (hidden) pins the detail level for A/B. HUD shows all three.
  Vsync detection = quantised intervals (multiples of the display period). Validate governor changes in a VISIBLE
  capped Chrome (`run.mjs --headful --capped --width=1470 --height=830`): headless vsync has no display jitter and hid
  a bug that dropped quality to the minimum at a steady 60 fps.
  Each resolution drop is checked with a trimmed mean (no gain -> further drops pause 8 s / 30 s, the drop is kept):
  in geometry-bound views lowering the resolution gains nothing; p90-based checks misjudged real gains as noise.
  Vsync detection also needs p10 >= 0.85 period (uncapped ~8.3 ms streams looked like 120 Hz). Known ambiguity: a
  steady uncapped stream at ~7 ms is indistinguishable from 144 Hz vsync (harmless: the budget is met at that rate).
- Sustained uncapped benches keep the GPU at 100 %: after ~30-60 min the fanless Air throttles ~2x and even the
  governor floor cannot hold 10 ms. Real use is capped at 60 Hz (GPU ~30 % busy): validate the user experience with
  a sustained visible capped run (`run.mjs --headful --capped`, count frames > 25 ms).
- Background system load (Spotlight `mds_stores`, `mediaanalysisd` indexing new screenshots) can double frame times:
  check `node tools/dev/minimal-probe.mjs` (empty page ≈ 0.45 ms, few spikes) before trusting absolute numbers.
  `screenshots` is a symlink to `screenshots.noindex/` (Spotlight skips `.noindex` folders) so test screenshots do
  not trigger indexing.
- The in-app browser pane and normal Chrome are vsync-capped (60 fps max): never use them for perf numbers.
  `npm run uncapped` opens a separate Chrome without the cap (lets the user see real fps).
- GPU timestamp queries are unusable on Apple (`?gpuTiming` gives nonsense). `queue.onSubmittedWorkDone` latency
  is quantized to Chrome's ticks (~1 frame) — not a frame-cost metric either.
- `cpu` in stats includes time blocked in `queue.submit` (GPU backpressure). At the real window size the frame was
  CPU-bound (main thread 100 % busy, ~4.4 ms of three.js JS): two fixes made it GPU-bound again — the shadow-pass
  alphaTest version patch (`core/three-patches.ts`) and `freezeStatic()` (`core/static.ts`) for every static object.
  Profile with `tools/profile.mjs --width=1470 --height=830`; a high `submit` share means GPU-bound (good).
- At the governor floor the frame is CPU-bound: three.js spends ~40 us of JS per render object and per pass
  (node materials force a FULL refresh of every object every frame — `NodeMaterialObserver.hasNode`). Fewer objects
  is the lever: empty forest draws are skipped (async instance-count readback), cascades alternate under load.
  Tried without gain: `BundleGroup` render bundles (no CPU gain, broke near trees) — don't retry.
- Slow frames: `tools/dev/spike-cause.mjs` (Chrome trace: GC vs long main-thread tasks vs GPU wait, frame boundaries
  from native FireAnimationFrame events — performance.measure timestamps are unusable in traces). Found and fixed:
  lazily compiled compute pipelines (85 ms freeze on the GI's first re-bake: now pre-compiled at init) and one
  submit per dispatch (grass/rocks/forest computes now one `renderer.compute([...])` each). Compile every compute
  pipeline at init; batch dispatches of a system into one compute() call.
- Ruled out as slow-frame causes (measured): GC (no overlap), progressive shadow / GI re-bakes (sun frozen: same p95),
  per-frame allocations (154 KB/frame, 87 % inside three.js). Real-window lake p95 is ~7 ms cool, ~10 ms only after
  minutes of continuous uncapped load (heat). `ab.mjs` prints the mean p95 of each variant too.
- Thermal throttling measured with `tools/dev/thermal.mjs`: same workload 4.5 ms cold -> 8.9 ms after 2.5 min of
  uncapped load (x1.95), back to cold speed after ~1 min of rest. Uncapped stress numbers depend on the run order.
- Uncapped Chrome has 1–3 interval spikes > 10 ms per second even on an empty page (`tools/dev/spike-rate.mjs`):
  at ~160 fps that is 1–2 % of frames over 10 ms in any bench, independent of rendering; most p95 excursions are real load at
  specific places: use `bench --timeline` (per-segment mean/p95) and `ab.mjs --range=u0,u1` on the hot segment.

## Run
- `npm run dev` (or preview_start "dev") → http://localhost:5173 (Chrome only, WebGPU).
- `npm run data` rebuilds `public/data/` from `data-raw/` (both git-ignored). Raw download: `node tools/data/fetch.mjs`.
  Terrain: `build-terrain.mjs`; surface/land cover: `build-surface.mjs`, `build-far-surface.mjs`; PBR layers:
  `build-textures.mjs`; twig atlas + tight card polygons: `build-trees.mjs`; OSM buildings: `fetch-osm.mjs` (Overpass)
  then `build-buildings.mjs` (meshes per 1 km tile + collision footprints); roads: `fetch-osm.mjs roads` then
  `build-roads.mjs` (draped ribbons, 16-byte vertices); previews: `preview.mjs` → `screenshots/`.
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
- `node tools/acceptance.mjs [--quick]` → every requirement of the original request as a measured pass/fail check
  (~10 min, opens one visible Chrome for the 60 Hz check), writes `docs/ACCEPTANCE.md` (French). Run it after big changes.
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
  facades, night windows, sink into the terrain far away), roads/trails (blended decal ribbons with markings, ruts),
  `colliders.ts` (static colliders for the walker). `audio/audio.ts` procedural WebAudio (wind, engine, steps, bells).
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
- Inside RTT/quad passes the built-in camera nodes (`cameraPosition`, `cameraWorldMatrix`, projection inverse) are
  NOT the scene camera: use explicit uniforms copied from `engine.camera` (see `makeReflectionPass`). Depth-buffer
  positions are metres off far away (reversed depth): for water, intersect the view ray with the heightfield plane.
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
- `smoothstep(a, b, x)` with a > b is undefined in WGSL/Metal: write `1 - smoothstep(b, a, x)`.
- Generated ribbons/quads must be CCW seen from their front (default FrontSide culls the rest silently).
- Bench paths are splines between keys: check them with `bench-path-check` (they used to go underground).
