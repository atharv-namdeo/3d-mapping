# Round 2 — POIs, spatial search and obstacle-aware navigation

How the navigable layer works, what was measured, and what is still open.

## 1. From reconstruction to something you can route on

A Gaussian splat is a cloud of fuzzy ellipsoids: beautiful to look at, but with no floor,
walls or scale. `navkit` (Python, numpy + scipy only) derives the navigation data from it:

| Stage | Module | What it does |
|---|---|---|
| Read | `navkit/io_ply.py` | Reads 3DGS `.ply` (Nerfstudio / INRIA / Brush) or a colour point cloud. |
| Align | `navkit/align.py` | RANSAC finds the floor plane (largest near-horizontal plane with nothing beneath it) and makes it `y = 0`; a histogram-entropy search squares the walls to the axes; a calibration factor converts to metres. |
| Rasterise | `navkit/grid.py` | 5 cm grid. A cell is walkable only if floor was **observed** there and nothing occupies the 0.12–1.8 m band above it. Unseen space is never assumed free. Thresholds adapt to the capture's point density. |
| Clean | `navkit/grid.py` | Hysteresis thresholding rejects floaters, closing bridges tile-grout gaps, and only the connected region is kept. |
| Describe | `navkit/suggest.py` | Proposes furniture-sized blobs and open areas as *unnamed* POIs for a human to label. |
| Publish | `navkit/build.py` | Writes `nav.json` (1 bit/cell walkable + 8-bit obstacle heightfield), an automatic floor-plan image, and the aligned splat sorted by importance (`scene.splat`, plus a 160k-splat prefix `scene.lite.splat` for phones). |

The whole step takes about 3 s for the 1 M-splat home capture, so it fits inside the
Round 3 on-site turnaround.

### PoseCam captures (the hostel scene)

`navkit posecam` turns a raw PoseCam session into the same kind of input without a GPU:
per-frame metric depth (Depth Anything V2) placed with ARCore's poses. Monocular depth gets
absolute scale wrong for an unfamiliar camera — on the hostel capture it overestimated by
1.75× — so the scale is **measured**: ORB features are triangulated between frames using ARCore's
metric camera motion and compared with the predicted depth (154 frame pairs, median 0.572).
A second, independent check agrees: with that scale the phone sits 1.33 m above the floor and
the per-frame floor correction averages 1.03. Frames are fused into 4 cm voxels kept only when
seen from at least two frames. The walked path is passed to the grid as observed free floor —
a person demonstrably stood there — which bridges gaps where depth was noisy.

## 2. In the browser (`app/`, no build step)

```
core/   pure logic, runs in Node for tests          view/   three.js            ui/   DOM
navgrid      clearance (exact EDT), LOS, ray picking  viewer     splat + blueprint   search-ui
pathfinder   A*, string pulling, corner rounding      player     WASD / touch        panels (card, HUD)
spatial-index  hash grid + point-in-polygon           director   fly-to, auto-walk   editor
search       fuzzy text + walking-distance ranking    path-visual, markers, minimap
guidance     turn-by-turn, progress, stop ordering
navigator    session: route, re-route, arrival, trips
poi-store    POIs, drafts, export
```

**Spatial indexing & POI tagging.** POIs are points or floor polygons (zones). A uniform hash
grid answers radius / nearest queries; zones are bucketed by bounding box and confirmed with an
exact point-in-polygon test. A click is resolved by marching the camera ray through the obstacle
heightfield (no mesh needed), then picking the POI anchored there, else the smallest zone
containing the point. The in-browser editor adds, edits, deletes and outlines zones, keeps a
local draft, and exports `pois.json`.

**Pathfinding.** A* on the 8-connected grid over cells whose clearance fits the walker
(0.22 m radius; 0.38 m for the step-free profile), with no corner cutting. Cost is distance
× (1 + a penalty near obstacles), so routes keep to the middle of a passage. The grid path is
then reduced by any-angle string pulling and corner rounding, each accepted only if the whole
body stays clear. A destination inside furniture resolves to the nearest standing room.

**Search.** Every keystroke ranks POIs by text match (exact > prefix > substring >
Damerau-Levenshtein typo) across name, aliases, category synonyms and description, then by
*walking* distance from a Dijkstra field — so "nearest sofa" means nearest on foot, not
through a wall. Filler words are ignored ("take me to the …").

**Guidance.** Turn-by-turn steps name nearby landmarks ("Turn left at Hallway painting"),
the HUD arrow points along the route relative to where you are looking, leaving the route
re-plans automatically, and multi-stop trips are ordered with nearest-neighbour + 2-opt.

## 3. What was measured

Run `npm test` (35 tests) and `npm run test:pipeline` (8 tests); CI runs both. The demonstration
video is recorded from the real app with `node scripts/record_demo.cjs` (see the script header).

| Claim | Evidence |
|---|---|
| Routes never touch obstacles | Tests sample every 2 cm of each route and require body clearance; also asserted for every POI of every shipped scene. |
| Walkable mask is safe | On the synthetic office (exact ground truth): **0.01 %** of cells marked walkable are actually solid. IoU 0.89, recall 0.89 — the missing 11 % is the deliberate 5 cm safety margin around obstacles. |
| Alignment | A capture tilted 17° and shrunk to 0.21× is recovered to < 0.5° gravity error with the correct 24 × 16 m footprint. |
| Route length | Within 5 % of the exact 8-connected shortest path on the test maps. |
| Planning time | ~1–2 ms for the home scene; ~35 ms for a 24 m route on the 347 × 504 office grid (Node 22, one core). |
| Unreachable / too-narrow | Return "no route" rather than a path through a wall; a 0.7 m door passes a person and rejects the 0.76 m step-free profile. |

## 4. Known limits (stated plainly)

- **Scale of the home scene is estimated**, not measured (see `app/scenes/home/scene.json`).
  Distances are consistent but could be off by roughly ±10 %. New captures should set
  `calibration.ceilingHeight` from one tape measurement (see [CAPTURE_SOP.md](CAPTURE_SOP.md));
  `navkit` then derives the scale from the ceiling plane, tested to within 1 % on ground truth.
- **The hostel scene is not photoreal.** It comes from 640×480 PoseCam frames and monocular depth,
  viewable as sharp points (default) or as oriented surface discs (`navkit/surfels.py`, button
  **Surfaces** / key `P`) that read as continuous walls and floors but are softer up close. A
  photoreal splat needs GPU training: the dataset (`datasets/hostel_posecam_nerfstudio.zip`, ARCore
  poses, no COLMAP) and a Colab notebook are ready; `view.splatSource` imports the result. A Gaussian splat trained on the same
  session (GPU) would make it photoreal; the navigation data would not change.
- In the hostel lobby, noisy depth separates the space in front of the lifts from the rest by a gap
  narrower than a person, so the Lifts label marks the waiting spot just in front of the doors.
- **The hostel upload has frames 0–5,499 of 6,908**, so the last ~47 s of the walk (the final corridor
  leg) has no images and is left out of the map.
- Room numbers were not readable at 640×480, so individual rooms are not yet tagged — only wings,
  lobby features, stairs and safety equipment.
- Round 1's per-frame PoseCam clouds were not navigable (under 4 % of points on a floor plane); the
  fused, scale-corrected pipeline above replaces them.
- **One flat floor per scene.** Stairs, ramps and tiered seating need a height-aware grid.
- **The office scene is synthetic** and labelled as such; it exists for ground truth and to show
  venue-scale routing.
- **Full-detail splat rendering was not profiled on real GPUs here.** Development ran in a
  software-rendered headless browser; the 160k-splat lite level is selected automatically on phones.
- POIs in the home scene were placed by eye from renders; re-check them with the editor.

## 5. Third-party software

three.js r167 (MIT), GaussianSplats3D 0.4.7 by Mark Kellogg (MIT) — vendored in `app/vendor/`
with licences. The home splat was trained with Nerfstudio splatfacto (Apache-2.0). numpy,
scipy, Pillow (BSD/HPND) at build time.
