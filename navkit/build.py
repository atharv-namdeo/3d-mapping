"""Scene builder: reconstruction in, web-ready navigable scene bundle out.

A scene lives in ``app/scenes/<id>/``. The hand-written ``scene.json`` describes the
capture (source file, calibration, agent); everything else in the folder is generated:

    nav.json            walkable grid + obstacle heightfield + alignment transform
    floorplan.png       automatic top-down "floor plan" image used by the minimap
    scene.splat         aligned, cropped, importance-sorted Gaussians (photoreal view)
    scene.lite.splat    the first N splats of the same ordering (phones / slow GPUs)
    scene.points.bin    aligned colour point cloud (for point-cloud reconstructions)
    suggestions.json    machine-proposed POIs / zones awaiting a human label
"""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from . import __version__
from .align import estimate_frame, transform_cloud
from .grid import AgentSpec, NavGrid, build_grid
from .io_ply import Cloud, read_ply, write_points, write_splat
from .suggest import suggest_objects, suggest_zones

HEIGHT_STEP = 0.02  # metres per unit in the 8-bit obstacle heightfield


def encode_nav(grid: NavGrid) -> dict:
    """Pack the grid for the browser: 1 bit per cell for walkability, 1 byte for height."""
    H, W = grid.shape
    bits = np.packbits(grid.walkable.ravel(), bitorder="little")
    heights = np.clip(np.round(grid.obstacle_height / HEIGHT_STEP), 0, 255).astype(np.uint8)
    return {
        "resolution": grid.res,
        "origin": [round(grid.x0, 4), round(grid.z0, 4)],
        "size": [W, H],
        "walkable": base64.b64encode(bits.tobytes()).decode("ascii"),
        "obstacleHeight": base64.b64encode(heights.tobytes()).decode("ascii"),
        "heightStep": HEIGHT_STEP,
    }


def render_floorplan(cloud: Cloud, grid: NavGrid, *, px_per_cell: int = 4, ceiling: float = 1.9) -> Image.Image:
    """Orthographic top-down colour render with the ceiling removed — the auto floor plan."""
    H, W = grid.shape
    k = px_per_cell
    keep = (cloud.xyz[:, 1] > -0.15) & (cloud.xyz[:, 1] < ceiling)
    if cloud.is_splat:
        keep &= cloud.opacity > 0.35
    p, c = cloud.xyz[keep], cloud.rgb[keep]
    u = ((p[:, 0] - grid.x0) / grid.res * k).astype(np.int64)
    v = ((p[:, 2] - grid.z0) / grid.res * k).astype(np.int64)
    ok = (u >= 0) & (u < W * k - 2) & (v >= 0) & (v < H * k - 2)
    order = np.argsort(p[ok, 1])  # painter's algorithm: highest point wins
    u, v, c = u[ok][order], v[ok][order], c[ok][order]
    img = np.zeros((H * k, W * k, 4), np.uint8)
    for dv in range(3):
        for du in range(3):
            img[v + dv, u + du, :3] = c
            img[v + dv, u + du, 3] = 255
    # Fill pin-holes with the nearest painted pixel, but only close to real data.
    empty = img[..., 3] == 0
    dist, (iy, ix) = ndi.distance_transform_edt(empty, return_indices=True)
    fill = empty & (dist <= 3)
    img[fill] = img[iy[fill], ix[fill]]
    # Fade out everything that is not the mapped floor or the structure right around it.
    near = ndi.distance_transform_edt(~(grid.walkable | (grid.obstacle_height > 0))) * grid.res
    fade = np.clip(1.0 - (near - 0.15) / 0.5, 0.0, 1.0)
    fade = np.kron(fade, np.ones((k, k)))
    img[..., 3] = (img[..., 3] * ndi.gaussian_filter(fade, k)).astype(np.uint8)
    return Image.fromarray(img)


def crop_for_viewing(cloud: Cloud, grid: NavGrid, margin: float, ceiling: float) -> Cloud:
    """Drop geometry far outside the mapped floor — mostly floaters and background."""
    H, W = grid.shape
    jj, ii = np.nonzero(grid.walkable)
    lo_x, hi_x = grid.x0 + ii.min() * grid.res - margin, grid.x0 + (ii.max() + 1) * grid.res + margin
    lo_z, hi_z = grid.z0 + jj.min() * grid.res - margin, grid.z0 + (jj.max() + 1) * grid.res + margin
    p = cloud.xyz
    keep = (p[:, 0] > lo_x) & (p[:, 0] < hi_x) & (p[:, 2] > lo_z) & (p[:, 2] < hi_z)
    keep &= (p[:, 1] > -0.6) & (p[:, 1] < ceiling)
    if cloud.is_splat:
        keep &= cloud.opacity > 0.04
        keep &= cloud.scales.max(axis=1) < 1.5  # metre-sized blobs are never real surfaces indoors
    return cloud.select(keep)


def publish_source_pois(scene_dir: Path, frame) -> int:
    """Convert POIs tagged in *capture* coordinates (``pois.source.json``) to the nav frame.

    Lets a venue be tagged against a floor plan or survey before reconstruction settles;
    scenes tagged in the browser editor already use nav coordinates and skip this step.
    """
    src = scene_dir / "pois.source.json"
    if not src.exists():
        return 0
    out = []
    for poi in json.loads(src.read_text()):
        poi = dict(poi)
        poi["position"] = frame.apply(np.array([poi["position"]], float))[0].round(3).tolist()
        if poi.get("zone"):
            corners = np.array([[x, 0.0, z] for x, z in poi["zone"]])
            poi["zone"] = frame.apply(corners)[:, [0, 2]].round(3).tolist()
        poi.setdefault("id", "-".join("".join(ch if ch.isalnum() else " " for ch in poi["name"].lower()).split()))
        out.append(poi)
    (scene_dir / "pois.json").write_text(json.dumps(out, indent=1))
    return len(out)


def build_scene(scene_dir: str | Path, *, verbose: bool = True) -> dict:
    scene_dir = Path(scene_dir)
    cfg = json.loads((scene_dir / "scene.json").read_text())
    src = cfg["source"]
    source_path = (scene_dir / src["path"]).resolve()
    log = (lambda *a: print("[navkit]", *a)) if verbose else (lambda *a: None)
    t0 = time.time()

    log(f"reading {source_path.name}")
    cloud = read_ply(source_path)
    log(f"  {len(cloud):,} {'gaussians' if cloud.is_splat else 'points'}")

    cal = cfg.get("calibration", {})
    frame, align_report = estimate_frame(
        cloud, up_hint=cal.get("up", [0, 0, 1]), metres_per_unit=cal.get("metresPerUnit", 1.0),
        square_up=cal.get("squareUp", True), yaw_deg=cal.get("yawDeg"), ceiling_height_m=cal.get("ceilingHeight"))
    log(f"  floor plane inliers {align_report['floor_inlier_ratio']:.1%}, yaw {align_report['yaw_deg']}°, "
        f"scale {align_report['metres_per_unit']:.4f} m/unit from {align_report['scale_from']}")
    if align_report["floor_inlier_ratio"] < 0.05:
        raise RuntimeError(
            f"only {align_report['floor_inlier_ratio']:.1%} of the reconstruction lies on a floor plane - it is too "
            "noisy to navigate. Re-capture with more floor in view (see docs/CAPTURE_SOP.md).")
    cloud = transform_cloud(cloud, frame)

    a = cfg.get("agent", {})
    agent = AgentSpec(a.get("height", 1.8), a.get("step", 0.12), a.get("floorBand", 0.07))
    confident = cloud
    if cloud.is_splat:
        size = cloud.scales.max(axis=1)
        confident = cloud.select((cloud.opacity > 0.5) & (size < np.percentile(size, 90)))
    g = cfg.get("grid", {})
    walked = None
    if (scene_dir / "trajectory.json").exists():
        tr = np.array(json.loads((scene_dir / "trajectory.json").read_text())["points"], float)
        walked = frame.apply(np.c_[tr[:, 0], np.zeros(len(tr)), tr[:, 1]])[:, [0, 2]]
        log(f"  using {len(walked):,} walked-path samples as observed free floor")
    grid = build_grid(confident.xyz, res=g.get("resolution", 0.05), agent=agent, walked_xz=walked,
                      seed_xz=tuple(g["seed"]) if g.get("seed") else None,
                      gap_fill=g.get("gapFill", 0.15))
    log(f"  grid {grid.shape[1]}×{grid.shape[0]} @ {grid.res} m, walkable {grid.stats['walkable_area_m2']} m²")

    view = cfg.get("view", {})
    visible = crop_for_viewing(cloud, grid, view.get("cropMargin", 2.5), view.get("ceiling", 4.0))
    assets: dict[str, object] = {"floorplan": "floorplan.png"}
    if visible.is_splat:
        n = write_splat(scene_dir / "scene.splat", visible, view.get("maxSplats"))
        lite = write_splat(scene_dir / "scene.lite.splat", visible, min(n, view.get("liteSplats", 160_000)))
        assets.update(splat="scene.splat", splatCount=n, splatLite="scene.lite.splat", splatLiteCount=lite)
    else:
        n = write_points(scene_dir / "scene.points.bin", visible, view.get("maxPoints", 600_000))
        assets.update(points="scene.points.bin", pointCount=n)
    render_floorplan(confident if cloud.is_splat else cloud, grid,
                     ceiling=view.get("floorplanCeiling", 1.9)).save(scene_dir / "floorplan.png", optimize=True)

    publish_source_pois(scene_dir, frame)
    suggestions = suggest_objects(grid) + suggest_zones(grid)
    (scene_dir / "suggestions.json").write_text(json.dumps(suggestions, indent=1))

    nav = {
        "version": 2, "generator": f"navkit {__version__}",
        "frame": {"sourceToNav": frame.matrix(), **align_report},
        "agent": {"height": agent.height, "step": agent.step},
        **encode_nav(grid),
        "floorplan": {"pxPerCell": 4},
        "assets": assets,
        "stats": {**grid.stats, "build_seconds": round(time.time() - t0, 1)},
    }
    (scene_dir / "nav.json").write_text(json.dumps(nav))
    log(f"  wrote {scene_dir}/nav.json (+ floorplan, visuals, {len(suggestions)} suggestions) in {time.time() - t0:.1f}s")
    return nav
