# Acceptance test — Mini Open World

Generated automatically by `node tools/acceptance.mjs` on 2026-10-15 14:51 UTC (MacBook Air M4, Chrome).
Each requirement of the original request is checked by a measurement; run the command again to re-check.

**Result: 16 / 16 requirements met.**

| Requirement | Result | Measurement |
|---|---|---|
| Mountain scene several km wide | ✅ | real terrain 24.576 km (3 m detail) + horizon 81.92 km, 23435 buildings |
| Trees and vegetation | ✅ | 10930 trees drawn from a forest trail; 9595 grass tufts and 61 rocks on the Kleine Scheidegg pasture |
| Take off in a plane | ✅ | takeoff from the Interlaken runway: 138 km/h, 24 m above the ground |
| Walk around on foot | ✅ | 4.1 m walked in 2.5 s on the ground; building walls block the walker |
| Editable world (editor) | ✅ | chalet placed, the walker stops 4.9 m from its centre (wall at 4.6 m); saved to world/props.json then removed; mouse place/remove in free camera ("World editor" section) |
| Realistic day/night cycle | ✅ | mean luminance day 101 > dusk 60 > night 4 (night visible, not black) |
| Global illumination (GI) | ✅ | light bounced off the terrain at the valley floor: 0.033 / 0.034 / 0.026 (RGB), plus baked sky occlusion |
| Far shadows (terrain to the horizon) | ✅ | mountains cast shadows over tens of km: image difference 12.8 with/without |
| Reflections (optimised SSR) | ✅ | the mountains reflect in Lake Brienz: image difference 5.6 with/without |
| Lens flare | ✅ | facing the sun: image difference 2.82 with/without lens flare |
| Side settings panel | ✅ | 23 sections, 117 settings (F1 key) |
| Tools to edit autonomously | ✅ | 25 agent commands (settings, camera, screenshots, bench, plane…) + CLI tools/*.mjs + data scripts |
| 100+ fps on the MacBook Air (1470×830 window) | ✅ | valley 178 fps (p95 7.7 ms), flyover 196 fps (p95 6.7 ms), lake 189 fps (p95 7.4 ms), walk 156 fps (p95 8 ms) |
| No errors | ✅ | no console error during the whole test |
| No dropped frames, smooth transitions (normal Chrome, 60 Hz) | ✅ | 4796 frames at 60 Hz over 4 paths, p99 ≤ 25 ms everywhere, worst frame 18 ms, full quality kept (100 %) |
| Headroom (beyond the request): 2560×1440 uncapped, p95 ≤ 10 ms | ✅ | valley p95 8.4 ms, flyover p95 7.8 ms, lake p95 6.9 ms, walk p95 8.7 ms (quality governor active; Chrome alone produced 0.2 spikes > 10 ms/s on an empty page, ~0.1 % of frames) |

Screenshots taken by the test: `screenshots/acc_*.png`. History of every run: `docs/ACCEPTANCE-HISTORY.md`.
