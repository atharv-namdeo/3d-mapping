# Namma Space — Round 2 submission links

| Item | Link |
|---|---|
| Code repository (branch with POI + navigation) | https://github.com/atharv-namdeo/3d-mapping/tree/claude/zen-edison-6xp69p |
| Live web app | https://atharv-namdeo.github.io/3d-mapping/app/ *(live once this branch is merged to the branch GitHub Pages deploys)* |
| Direct link: route to the dining table | https://atharv-namdeo.github.io/3d-mapping/app/?scene=home&poi=dining-table |
| Venue-scale benchmark scene | https://atharv-namdeo.github.io/3d-mapping/app/?scene=office |
| Technical notes | `docs/ROUND2.md` in the repository |
| Demonstration video (3–5 min) | *to be recorded — see the shot list below* |

## What to try in the web app

1. Walk with **W A S D**, drag to look. Furniture and walls stop you.
2. Click any label, zone or floor spot to see what it is and how far it is on foot.
3. Press **/** and type `dinning tabel` (typo on purpose), `nearest painting` or `music` — press **Enter** for directions, **Shift+Enter** to jump there.
4. Press **G** to auto-walk the route; step off the route and it re-plans.
5. Press **V** to see the walkable area the planner uses, **B** for the blueprint view, **M** for the map (click it to route anywhere).
6. Add two or three places with **Add stop**, then **Start trip** — stops are visited in the shortest order.
7. Press **E** to tag a new POI or draw a zone, then **Export pois.json**.

## Suggested shot list for the video

| Time | Show |
|---|---|
| 0:00–0:25 | The problem and one sentence on the pipeline: phone video → Gaussian splat → `navkit` → navigable web app. |
| 0:25–1:10 | Free walkthrough of the home scene; collide with the table; click labels and a zone. |
| 1:10–2:10 | Search: typo, alias, "nearest …"; live preview while moving through results; jump vs directions. |
| 2:10–3:10 | Route following with the HUD, auto-walk, deliberate detour and re-route; walkable-area overlay; step-free width toggle. |
| 3:10–3:50 | Office scene: a 24 m multi-room route, multi-stop trip, expanded map. |
| 3:50–4:30 | Editor: tag a POI and a zone, export. Tests and ground-truth numbers from `docs/ROUND2.md`. |
