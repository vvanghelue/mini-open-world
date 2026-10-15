# Mini Open World — Plan

## Vision
A realistic, editable mountain open world in the browser (three.js `WebGPURenderer` + TSL),
built on real Swiss terrain (Jungfrau / Lauterbrunnen / Grindelwald / Interlaken), where you can
take off in a small plane from Interlaken airfield, fly over the Eiger/Mönch/Jungfrau, land and walk.

The world is editable both by the user (side panel + editor) and by Claude as an autonomous agent
(CLI ↔ running app bridge, JSON world files, Blender headless for assets).

## Hard performance contract
- Machine: MacBook Air M4 (10-core GPU, 24 GB, fanless). Both displays are 60 Hz.
- "100+ fps" ⇒ **frame time ≤ 10 ms** (aim ≤ 8 ms for thermal margin), measured by `npm run bench`
  in Chrome with vsync and frame-rate limit disabled, on fixed camera paths (walk, low flight, high flight).
- Report p50 / p95 / p99 frame time. p99 matters: **no hitches** (no shader compiles, GC spikes,
  big uploads, or LOD pops at runtime).
- Internal render resolution decoupled from canvas (default ~60 % of a 2560×1440 window) + TAA upscale.
- Every feature merges only if the benchmark stays within budget. Budget sketch (GPU, ms):
  shadows 1.0 · terrain 1.0 · vegetation 2.0 · sky/atmo/clouds 1.0 · water 0.5 · post 1.0 · margin 1.5.

## Accepted scoping defaults (user said "fait au mieux")
| Topic | Decision |
|---|---|
| Terrain | Real DEM: swissALTI3D 2 m (core 20×20 km) + Copernicus GLO-30 (horizon ring ~80×80 km) |
| Land cover | Derived from SWISSIMAGE 2 m orthophoto (forest / meadow / rock / snow / water / urban) + slope/altitude rules |
| Landscape | Lakes (Brienz/Thun ends), snow & glaciers, light volumetric clouds, wind; no dynamic weather in v1 |
| Plane | Small propeller plane (Cessna-like), semi-arcade flight model, take-off from Interlaken airfield, chase + cockpit cam |
| On foot | First-person in v1 (third-person later) |
| Agent tools | CLI (`tools/agent.mjs`) ↔ WebSocket bridge in the Vite dev server ↔ running app; Blender headless for assets |
| User editor | Side panel (Tweakpane) + free camera + simple object placement; sculpt/paint brushes later |
| Assets | CC0 only (Poly Haven, ambientCG) + procedurally generated trees baked to impostors |
| VCS | Local git; raw downloads and generated data are git-ignored and reproducible by scripts |
| Browser | Chrome only (WebGPU) |
| Language | Code/comments in English, conversation in French |
| Audio | Minimal, later |

## Rendering techniques (planned)
- **Terrain**: CDLOD quadtree, one instanced draw, vertex-texture heightmap, geomorphing (no popping),
  procedural detail displacement near camera; materials by slope/altitude/land-cover with triplanar on cliffs,
  ortho-derived macro color far away. Horizon ring as a second, coarser CDLOD.
- **Atmosphere**: Hillaire 2020 (transmittance LUT, multi-scattering LUT, sky-view LUT, aerial-perspective volume).
  Sun + moon + stars, physically based day/night cycle.
- **Shadows**: stable cascaded shadow maps (near cascades every frame, far ones staggered) +
  **terrain-space shadow mask** ray-marched in the heightfield (includes canopy height) for shadows to the horizon,
  recomputed progressively when the sun moves.
- **GI**: baked sky-visibility + bent normals (heightfield horizon scan); runtime 2.5D irradiance probe field
  (one-bounce heightfield GI, amortized when sun moves); sky SH from the sky-view LUT.
- **Vegetation**: deterministic placement from land-cover density maps; GPU compute culling + indirect draws;
  mesh LODs near, octahedral impostors mid, canopy texture far; dithered cross-fades; wind in vertex shader;
  GPU grass near camera.
- **Post**: TAA/upscale, bloom, physically-motivated lens flare (occlusion-tested), exposure, AgX tone mapping,
  half-res SSR restricted to water with sky fallback.
- **Clouds**: low-res raymarched volumetric layer with temporal reprojection.

## Milestones
0. Foundations: Vite+TS app, renderer, loop, settings store, side panel, HUD, agent bridge, bench harness.
1. Data: DEM + ortho download & processing → heightmaps, normal maps, land-cover, macro color.
2. Terrain rendering (CDLOD + materials + horizon ring).
3. Atmosphere + day/night + CSM + terrain shadow mask + aerial perspective.
4. Vegetation (trees + impostors + grass + rocks).
5. GI (sky visibility, probe field), post stack (TAA, bloom, lens flare, SSR water).
6. Plane + walker controllers, airfield.
7. Clouds, water polish, final optimisation pass, docs.

## Status (2026-10-15)
Done: foundations + agent tools, data pipeline (DEM, ortho, land cover, PBR layers, OSM buildings), CDLOD terrain,
Hillaire atmosphere + day/night + stars/moon + perceptual night exposure, heightfield shadows to the horizon + near
CSM + cloud shadows, baked sky visibility + one-bounce terrain GI, GPU forest (mesh LODs, octahedral impostors,
per-tree lighting, depth pre-pass), grass, volumetric clouds, water with heightfield-raymarched reflections (replaces
SSR), TAAU-lite + bloom + lens flare, aircraft + walker + free camera, Interlaken runway, ~24k buildings.
Perf (MacBook Air M4, uncapped, idle system, 2026-10-15 final run): stress 2560×1440: mean 4.5–6.7 ms, p95
5.7–9.7 ms on all four paths (governor at 0.54–0.60 scale, full detail); real window 1470×830: 221–348 fps mean,
p95 3.8–7.2 ms at full resolution and detail. Background indexing (Spotlight/mediaanalysisd) can double these.
Real-use validation (visible Chrome window 1470×830): capped at 60 Hz, 4 paths × 40 s on a hot machine -> 1 missed
frame out of 9,591, full resolution and detail throughout; uncapped visible window ≈ 220 fps (4.5 ms). Sustained
uncapped stress at 2560×1440 throttles the fanless Air ~2x within 2-3 minutes (measured: tools/dev/thermal.mjs);
cold, every path is within budget at both resolutions; hot, the two heaviest paths exceed 10 ms p95 at 2560×1440
even at the governor floor. CPU fixes (shadow-pass material versions, frozen static matrices): real window
209–313 fps cold (221–348 before roads, rocks and buildings were added; the fixes recovered most of that cost).
Also: rocks/boulders (scatter + walker collisions), walker collides with buildings.
Also: OSM roads and hiking trails, procedural audio, impostor depth pre-pass.
Adaptive governor: dynamic internal resolution (0.40–0.60) then detail level, targeting 100 fps uncapped and
no missed vsync when capped; visually near-identical at minimum detail.
Ideas next: buildings LOD/roof detail, cloud temporal reprojection, bridges as 3D decks, rivers flow.

