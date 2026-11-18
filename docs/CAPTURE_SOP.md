# Capture SOP — from a phone video to a navigable space

This is the procedure for capturing a space that the Round 2 navigator can route through,
and the one to rehearse for the Round 3 on-site capture (e.g. a floor of the Lecture Hall
Complex). Target: one corridor plus two or three rooms, 60–200 m² of floor.

Total time for a 100 m² space: about 15 min capture, 30–60 min splat training on a
CUDA GPU, 1 min `navkit`, 15 min tagging POIs.

## 1. Before you start (2 min)

- **Measure one thing with a tape: the floor-to-ceiling height** in the main room. Write it
  down in metres. This gives the model its real scale (see step 4). If the ceiling height varies,
  measure where you will film most of it.
- Turn on every light; avoid direct sun through windows. Close doors you will not walk through.
- Ask people to stay out of shot. Anything that moves becomes a ghost in the reconstruction
  and can block the floor in the walkable map.
- Phone: clean the lens, Do Not Disturb, enough storage (≈ 2 GB per 5 min of 4K).
- Camera: **video, 4K 30 fps (1080p60 also works), lock exposure and focus** (long-press on the
  screen), stabilisation on, HDR off if exposure flickers.

## 2. Filming route (10–15 min)

The navigator can only route over floor it has **seen**. Every rule below exists to give it floor.

1. Start in a doorway, hold still 2 s.
2. **Walk slowly** (half normal pace) along the middle of corridors and around the edge of each room,
   about 1 m from the walls.
3. **Hold the phone at chest height, tilted 20–30° down**, so the floor fills the bottom third of
   the frame the whole time. Do not film only at eye level.
4. In each room: one loop facing the walls, then one loop facing the room centre.
   Pause 2 s and slowly pan at each corner.
5. Film the **ceiling** of the main room for 5–10 s (tilt up, sweep across). Needed for scale.
6. Walk through each door **slowly and straight**, keeping both door frames in view —
   doorways are where reconstructions most often break apart.
7. Finish where you started (closing the loop keeps rooms aligned with each other).
8. Overlap matters more than coverage: never turn faster than ~45° per second.

For more than ~300 m², record one video per wing with 2 m of shared corridor between them.

## 3a. PoseCam route (no GPU needed) — used for the hostel scene

Record with the team's PoseCam app instead of the plain camera. It saves ARCore's metric,
gravity-aligned pose for every frame, so scale and "which way is up" are measured, not guessed.

1. Copy the **raw session folder** off the phone (`frames/`, `poses.csv`, `intrinsics.json`, `imu.csv`,
   `manifest.json`) — not the "Export for pipeline" MP4. **Zip it before uploading**: a 4-minute
   session is ~7,000 files, which Drive serves one by one and slowly.
2. Check `manifest.json`: `tracked_frame_count` should equal `frame_count` and
   `longest_tracking_gap_s` should be near 0.
3. Build the point cloud and walked path (CPU, ~6 min for 700 frames; installs PyTorch the first time):
   ```bash
   pip install torch --index-url https://download.pytorch.org/whl/cpu
   pip install transformers opencv-python-headless
   python -m navkit posecam path/to/session app/scenes/myspace
   ```
   It estimates depth per frame (Depth Anything V2), **fixes the depth scale by triangulating image
   features against ARCore's metric camera motion**, finds the floor, fuses frames into a 4 cm voxel
   cloud (keeping only voxels seen from ≥ 2 frames) and saves the walked path. The log prints two
   independent checks — the triangulated scale and the per-frame floor correction (should be ≈ 1.0).
4. `scene.json` for a PoseCam scene uses `"up": [0, 1, 0]` and `"metresPerUnit": 1.0`, and
   `"view": { "surfels": true }` so the cloud is drawn as continuous surfaces (see below); then continue
   with step 4. `navkit build` treats the walked path as observed free floor. Use `--stride 4` (every 4th
   frame) for the final build: twice the views fills more holes in walls.

**Surfels.** With `view.surfels`, every point becomes a small disc lying on its local surface (normal
from its neighbours) and just wide enough to meet them, so walls and floors render as surfaces instead of
separate squares. The phone version is built from a sparser sample with wider discs, not cut from the
full one, so it has no extra gaps. The plain points are written as well and are the default for the
hostel (`"defaultStyle": "points"`): they are sharper up close, the discs look more solid. Visitors switch
with the **Points / Surfaces** button or `P`; `?style=surfaces` opens a scene in the disc view.

## 3b. Train a Gaussian splat (photoreal view; needs a GPU)

Any tool that exports a standard 3DGS `.ply` (fields `f_dc_*`, `opacity`, `scale_*`, `rot_*`) works:

- **Nerfstudio splatfacto** (used for the shipped home scene; needs an NVIDIA/CUDA GPU):
  ```bash
  ns-process-data video --data capture.mp4 --output-dir data/myspace --num-frames-target 400
  ns-train splatfacto --data data/myspace --max-num-iterations 30000
  ns-export gaussian-splat --load-config outputs/.../config.yml --output-dir exports/myspace
  ```
  The team's training studio (`BENi-Aditya/Namma-Space`, `./start-admin.sh`) wraps the same steps.
- **Brush** (open source, runs on Windows/macOS/Linux GPUs without CUDA) — load the COLMAP output
  from `ns-process-data`, train, export `.ply`.
- Phone apps that export 3DGS `.ply` are fastest on site; check the export format before relying on one.

Check the result in any splat viewer: walls straight, floor continuous, rooms joined at the doors.
If a room is detached or duplicated, re-film that doorway (step 2.6) — no later step can fix it.

## 4. Make it navigable (1 min)

```bash
mkdir -p app/scenes/myspace
cp exports/myspace/splat.ply data/sources/myspace.ply
```

`app/scenes/myspace/scene.json`:

```json
{
  "id": "myspace",
  "name": "LHC — Ground floor",
  "source": { "path": "../../../data/sources/myspace.ply", "type": "gaussian-splat" },
  "calibration": { "up": [0, 0, 1], "ceilingHeight": 3.05 }
}
```

- `ceilingHeight` is the tape measurement from step 1. `navkit` finds the ceiling plane in the
  reconstruction and derives metres-per-unit from it (tested to within 1 % on ground truth). If it
  reports too little ceiling, film more ceiling or set `"metresPerUnit"` manually instead.
- `up` is the source's vertical axis: `[0, 0, 1]` for Nerfstudio exports (the header says
  "Vertical Axis: z"), `[0, 1, 0]` for most others. A wrong value fails loudly at the floor step.

```bash
python -m navkit build app/scenes/myspace
```

Read the output: floor inliers above ~15 % and a walkable area close to the real floor area are good.
Then add the scene to `app/scenes/index.json` and open `http://localhost:8080/app/?scene=myspace`.
Press `V` — green should cover the floor you walked. Holes mean that floor was not filmed.

## 5. Tag POIs (≈ 15 min)

Press `E` in the app. Name rooms first (**Draw zone**, click the corners on the floor), then
objects people will search for. Add aliases with the words visitors actually use ("loo, washroom,
toilet"). The editor's "Detected, not yet named" list jumps to furniture the pipeline found.
**Export pois.json**, save it as `app/scenes/myspace/pois.json`, and run `npm test` — the scene
test checks every POI is valid, searchable and reachable on foot.

## 6. Publish

```bash
git add app/scenes/myspace && git commit -m "Add myspace scene" && git push
```

GitHub Pages serves it a minute later. Keep `data/sources/` out of git (it is ignored); the
web-ready `scene.splat` that navkit writes is what the app loads.
