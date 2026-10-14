# Mini Open World — notes for Claude

Realistic mountain open world (real Jungfrau/Lauterbrunnen terrain) in three.js r186 `WebGPURenderer` + TSL,
editable by the user (side panel) and by Claude (agent bridge + CLI). Plan & decisions: `docs/PLAN.md`.
User speaks French (UI labels and chat in French, code/comments in English), has no 3D background.

## Hard rule: performance
- Target machine: MacBook Air M4 (10-core GPU), 60 Hz screens. Target = **frame ≤ 10 ms (aim ≤ 8) in 2560×1440**,
  measured uncapped with `npm run bench`. Check p95/p99 too: no hitches.
- The in-app browser pane is vsync-capped and throttled in background: never use it for perf numbers.
- GPU timestamp queries are unreliable on Apple (passes overlap) → measure by A/B: `node tools/bench.mjs --set=key=value`.
  Bench runs are noisy (±0.5 ms): repeat before concluding.
- `cpu` in stats includes time blocked in `queue.submit` (GPU backpressure). Use `tools/profile.mjs` to see real JS cost.
- Uncapped Chrome shows periodic 10–14 ms interval spikes (~4/s) even on an empty WebGPU page
  (`tools/dev/minimal-probe.mjs`): uncapped p99 is NOT a hitch metric. Judge hitches by JS allocations
  (`tools/alloc-profile.mjs`, keep garbage/frame low) and by vsync smoothness.
- `tools/dev/spikes.mjs 'a.b=1,...'` counts >8 ms frames per settings variant (diagnostics).

## Run
- `npm run dev` (or preview_start "dev") → http://localhost:5173 (Chrome only, WebGPU).
- `npm run data` rebuilds `public/data/` from `data-raw/` (both git-ignored). Raw download: `node tools/data/fetch.mjs`.
  Terrain build: `node tools/data/build-terrain.mjs`; previews: `node tools/data/preview.mjs` → `screenshots/`.

## Agent tools (use these to see and edit the world)
- `node tools/agent.mjs <cmd> [k=v ...|json]` → runs a command in the app open in a browser (via Vite WS bridge).
  `help` lists commands. Key ones: `get`/`set`/`describe` (settings by path, e.g. `set terrain.lodDistance=300`),
  `camera`, `goto <poi> [look]`, `pois`, `stats`, `logs level=error`, `eval code="..."` (JS with `app`),
  `screenshot name=x` (→ `screenshots/x.png`, then Read it to look), `save-settings` (→ `world/settings.json`), `bench`.
- `node tools/run.mjs 'cmd a=1' 'cmd2' ...` → same commands in a private headless Chrome (2560×1440, uncapped).
  Best way to take screenshots/diagnose without touching the user's browser.
- `node tools/bench.mjs [--paths=valley,flyover,walk] [--seconds=8] [--set=a.b=1,c.d=2]` → perf report, saves `bench-results/`.
- `node tools/profile.mjs [--path=valley]` → top CPU self-time functions.

## Architecture (src/)
- `core/engine.ts` Engine + System interface (init/update/afterRender), loop, stats. `core/settings.ts` schema-driven
  settings store: systems declare `settings.group(id, frenchTitle, defs)`; panel + agent use it automatically.
- `terrain/` CDLOD quadtree (`cdlod.ts`, 2 instanced draws: 32² full and 16² quarter patches), height/normal data
  (`terrain-data.ts`, CPU `heightAt()` mirrors GPU sampling), material (`terrain.ts`).
- `sky/` time of day (astronomical sun/moon), sky & sun light. `post/` render pipeline (TAAU upscale, sharpen, AgX).
- `agent/` bridge client, commands, benchmark camera paths. `editor/` Tweakpane panel (F1) and HUD.
- World coords: metres, origin = core centre (LV95 2638288/1162288), +X east, +Y up, −Z north. `world/geo.ts` POIs.

## Data
- Core 24.576 km square, 8192² heights (3 m, swissALTI3D 2 m source), far ring 81.92 km at 40 m (Copernicus GLO-30).
- Attribution required: © swisstopo; Copernicus DEM © DLR/Airbus (EU/ESA).

## Gotchas
- `patch` is a reserved WGSL word (don't use it as attribute name). `window.app` collided with `<div id="app">`.
- Use `float(x)` for numeric args where TSL types require Nodes (e.g. `.level(float(0))`).
- TSL expressions are lazy: `.toVar()` any value read before a variable it depends on is mutated (loop accumulators!).
- Nested `Loop`s: give explicit names `Loop({start,end,name:'j'} as any, ({j}) => …)` or inner `i` shadows outer.
- Vite ignores files created in `public/data/` after it started (watch exclusion): restart the dev server after `npm run data`.
- Reversed depth buffer is on: build frustums with `camera.reversedDepth`.
