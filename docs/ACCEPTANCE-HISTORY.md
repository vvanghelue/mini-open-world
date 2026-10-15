# Historique des tests d'acceptation

Une ligne par exécution complète de `node tools/acceptance.mjs` (échecs compris). Les premières lignes ont été
reconstituées depuis la session du 2026-10-15 ; les suivantes sont ajoutées automatiquement (heures en UTC).

**Critère d'arrêt retenu** : 3 exécutions complètes consécutives à 16 / 16 après la dernière modification du code, les
deux dernières enchaînées sans refroidissement. **Atteint le 2026-10-15** (exécutions 11, 12:46 et 12:53 UTC, commit
`cf13609`) : p95 max 9,0 ms dans la fenêtre réelle, 8,7 ms à 2560×1440, pire image à 60 Hz 18 ms.

| Date (UTC) | Résultat | Échecs | Fenêtre réelle (p95 max) | 2560×1440 (p95 max) |
|---|---|---|---|---|
| 2026-10-15 (1) | 13 / 15 | végétation (erreur du test), stress 1440p | 9.7 ms | 10.4 ms |
| 2026-10-15 (2) | 14 / 15 | stress 1440p | 9.8 ms | 10.4 ms |
| 2026-10-15 (3) | 14 / 15 | stress 1440p | 9.3 ms | 10.1 ms |
| 2026-10-15 (4) | 15 / 15 | — | 9.8 ms | 10.0 ms |
| 2026-10-15 (5) | 15 / 15 | — | 10.0 ms | 9.3 ms |
| 2026-10-15 (6) | 15 / 15 | — | 9.9 ms | 8.7 ms |
| 2026-10-15 (7) | 15 / 15 | — | 8.7 ms | 8.9 ms |
| 2026-10-15 (8) | 15 / 16 | 100+ fps (lac 11.2 ms) | 11.2 ms | 7.8 ms |
| 2026-10-15 (9) | 15 / 16 | 100+ fps (lac 11.1 ms) | 11.1 ms | 8.4 ms |
| 2026-10-15 (10) | 15 / 16 | 100+ fps (lac 11.1 ms) | 11.1 ms | 9.0 ms |
| 2026-10-15 (11) | 16 / 16 | — | 8.3 ms | 8.7 ms |
| 2026-10-15 12:46 | 16 / 16 | — | 7.6 ms | 7.5 ms |
| 2026-10-15 12:53 | 16 / 16 | — | 9.0 ms | 8.6 ms |
