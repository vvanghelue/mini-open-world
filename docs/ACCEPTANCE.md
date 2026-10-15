# Test d'acceptation — Mini Open World

Généré automatiquement par `node tools/acceptance.mjs` le 2026-10-15 11:10 (MacBook Air M4, Chrome).
Chaque exigence de la demande initiale est vérifiée par une mesure ; relancer la commande pour revérifier.

**Résultat : 15 / 15 exigences validées.**

| Exigence | Résultat | Mesure |
|---|---|---|
| Scène de montagne de plusieurs km | ✅ | relief réel 24.576 km (détail 3 m) + horizon 81.92 km, 23435 bâtiments |
| Arbres et végétation | ✅ | 10930 arbres affichés depuis un sentier en forêt ; 9593 touffes d'herbe et 61 rochers sur l'alpage de la Kleine Scheidegg |
| Décoller en avion | ✅ | décollage depuis la piste d'Interlaken : 138 km/h, 24 m au-dessus du sol |
| Se promener à pied | ✅ | 4.1 m parcourus en 2,5 s au sol ; les murs des bâtiments bloquent le marcheur |
| Cycle jour/nuit réaliste | ✅ | luminance moyenne jour 103 > crépuscule 60 > nuit 5 (nuit visible, pas noire) |
| Illumination globale (GI) | ✅ | lumière réfléchie par le relief au fond de la vallée : 0.033 / 0.034 / 0.026 (RGB), plus occlusion du ciel précalculée |
| Ombres lointaines (relief à l'horizon) | ✅ | ombres portées des montagnes sur des dizaines de km : écart d'image 13.4 avec/sans |
| Reflets (SSR optimisé) | ✅ | les montagnes se reflètent dans le lac de Brienz : écart d'image 6.4 avec/sans |
| Lens flare | ✅ | face au soleil : écart d'image 3.51 avec/sans lens flare |
| Panneau latéral de réglages | ✅ | 22 sections, 112 réglages (touche F1) |
| Outils pour éditer en autonomie | ✅ | 21 commandes agent (réglages, caméra, captures, bench, avion…) + CLI tools/*.mjs + scripts de données |
| 100+ fps sur le MacBook Air (fenêtre 1470×830) | ✅ | valley 149 fps (p95 8.7 ms), flyover 186 fps (p95 6.8 ms), lake 145 fps (p95 10 ms), walk 162 fps (p95 8.2 ms) |
| Aucune erreur | ✅ | aucune erreur dans la console pendant tout le test |
| Pas de saut d'images, transitions fluides (Chrome normal, 60 Hz) | ✅ | 4796 images à 60 Hz sur 4 parcours, p99 ≤ 25 ms partout, pire image 19 ms, qualité maximale conservée (100 %) |
| Marge (au-delà de la demande) : 2560×1440 sans plafond, p95 ≤ 10 ms | ✅ | valley p95 8.7 ms, flyover p95 9.3 ms, lake p95 8.4 ms, walk p95 7.8 ms (gouverneur de qualité actif ; Chrome seul produisait 3.0 pics > 10 ms/s sur une page vide, soit ~1.9 % des images) |

Captures produites par le test : `screenshots/acc_*.png`.
