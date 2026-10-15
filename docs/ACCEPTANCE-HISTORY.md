# Acceptance test history

One line per full run of `node tools/acceptance.mjs` (failures included). The first lines were reconstructed from the
2026-10-15 session; later ones are appended automatically (times in UTC).

**Stopping criterion**: 3 consecutive full runs at 16 / 16 after the last code change, the last two back to back without
cooldown. **Met on 2026-10-15** (runs 11, 12:46 and 12:53 UTC, commit `cf13609`): max p95 9.0 ms in the real window,
8.7 ms at 2560×1440, worst frame at 60 Hz 18 ms.

| Date (UTC) | Result | Failures | Real window (max p95) | 2560×1440 (max p95) |
|---|---|---|---|---|
| 2026-10-15 (1) | 13 / 15 | vegetation (test error), stress 1440p | 9.7 ms | 10.4 ms |
| 2026-10-15 (2) | 14 / 15 | stress 1440p | 9.8 ms | 10.4 ms |
| 2026-10-15 (3) | 14 / 15 | stress 1440p | 9.3 ms | 10.1 ms |
| 2026-10-15 (4) | 15 / 15 | — | 9.8 ms | 10.0 ms |
| 2026-10-15 (5) | 15 / 15 | — | 10.0 ms | 9.3 ms |
| 2026-10-15 (6) | 15 / 15 | — | 9.9 ms | 8.7 ms |
| 2026-10-15 (7) | 15 / 15 | — | 8.7 ms | 8.9 ms |
| 2026-10-15 (8) | 15 / 16 | 100+ fps (lake 11.2 ms) | 11.2 ms | 7.8 ms |
| 2026-10-15 (9) | 15 / 16 | 100+ fps (lake 11.1 ms) | 11.1 ms | 8.4 ms |
| 2026-10-15 (10) | 15 / 16 | 100+ fps (lake 11.1 ms) | 11.1 ms | 9.0 ms |
| 2026-10-15 (11) | 16 / 16 | — | 8.3 ms | 8.7 ms |
| 2026-10-15 12:46 | 16 / 16 | — | 7.6 ms | 7.5 ms |
| 2026-10-15 12:53 | 16 / 16 | — | 9.0 ms | 8.6 ms |
| 2026-10-15 14:51 | 16 / 16 | — | 8.0 ms | 8.7 ms |
