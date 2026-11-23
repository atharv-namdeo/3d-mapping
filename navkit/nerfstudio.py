"""PoseCam session -> Nerfstudio dataset, and trained splats -> back into a scene.

Training a Gaussian splat is what gives a capture photographic detail, but it needs an
NVIDIA GPU. This module does everything around that step on a CPU:

    python -m navkit nerfstudio <session> <dataset_dir> --scene app/scenes/hostel
        writes images/, transforms.json and sparse_pc.ply

    ns-train splatfacto --data <dataset_dir> nerfstudio-data \\
        --orientation-method none --center-method none --auto-scale-poses False
        (on a GPU — see notebooks/train_splat_colab.ipynb)

    set "view": {"splatSource": "trained_splat.ply"} in the scene's scene.json and run
    python -m navkit build <scene> — the splat lands in the same frame as the labels and routes.

Why no COLMAP: PoseCam already records ARCore's camera-to-world pose for every frame in metres
with gravity up. Nerfstudio uses the same camera axes as ARCore (OpenGL: +X right, +Y up,
looking down −Z), so the poses go in unchanged. This was checked by projecting the fused cloud
into the photos: the direct convention matches far better than any rotated alternative.

Coordinates: everything is written in the scene's *source* frame (ARCore world, shifted so
the floor is at y = 0), exactly like source.ply from ``navkit posecam``. With the three
dataparser flags above, Nerfstudio keeps that frame, so the exported splat needs no fixing.
If it was trained with Nerfstudio's defaults instead, pass the dataparser_transforms.json it
wrote and the build undoes Nerfstudio's re-centring and re-scaling.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np

from .align import Frame
from .io_ply import read_ply
from .posecam import GL_TO_CV, load_session
from .synth import write_ply


def floor_offset(session: Path, stride: int, scene_dir: Path | None) -> float:
    """World height of the floor, as used when the scene's source.ply was written."""
    if scene_dir and (scene_dir / "trajectory.json").exists():
        meta = json.loads((scene_dir / "trajectory.json").read_text())
        if "floor_offset_m" in meta:
            return float(meta["floor_offset_m"])
        _, _, _, traj = load_session(session, stride)
        return float(np.median(traj[:, 1]) - meta["camera_above_floor_m"])
    raise RuntimeError("pass --scene (a scene built with `navkit posecam`) so the floor offset is known")


def export_dataset(session: str | Path, out_dir: str | Path, *, stride: int = 4,
                   scene_dir: str | Path | None = None, init_points: int = 300_000, log=print) -> dict:
    session, out_dir = Path(session), Path(out_dir)
    scene_dir = Path(scene_dir) if scene_dir else None
    K, (W, H), frames, _ = load_session(session, stride)
    floor0 = floor_offset(session, stride, scene_dir)
    (out_dir / "images").mkdir(parents=True, exist_ok=True)

    shift = np.eye(4)
    shift[1, 3] = -floor0
    entries = []
    for idx, path, T_cv in frames:
        name = f"images/{idx:06d}.jpg"
        shutil.copyfile(path, out_dir / name)
        c2w = shift @ T_cv @ GL_TO_CV                       # ARCore camera-to-world, OpenGL axes
        entries.append({"file_path": name, "transform_matrix": c2w.round(7).tolist()})

    meta = {
        "camera_model": "OPENCV",
        "fl_x": float(K[0, 0]), "fl_y": float(K[1, 1]), "cx": float(K[0, 2]), "cy": float(K[1, 2]),
        "w": int(W), "h": int(H), "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,
        # Must be explicit: without it Nerfstudio assumes sparse_pc.ply came from COLMAP and swaps
        # and flips its axes (but not the cameras), starting training from a misplaced cloud.
        "applied_transform": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
        "frames": entries,
    }
    if scene_dir and (scene_dir / "source.ply").exists():
        # Start training from the fused point cloud: much faster convergence than random init.
        cloud = read_ply(scene_dir / "source.ply")
        rng = np.random.default_rng(0)
        pick = rng.choice(len(cloud), min(init_points, len(cloud)), replace=False)
        write_ply(out_dir / "sparse_pc.ply", cloud.xyz[pick], cloud.rgb[pick])
        meta["ply_file_path"] = "sparse_pc.ply"
    (out_dir / "transforms.json").write_text(json.dumps(meta, indent=1))
    log(f"[nerfstudio] {len(entries)} frames, {W}x{H}, floor offset {floor0:.3f} m"
        f"{', init cloud ' + str(min(init_points, len(cloud))) + ' points' if 'ply_file_path' in meta else ''} -> {out_dir}")
    return meta


def undo_dataparser(transforms_path: str | Path) -> Frame:
    """Inverse of Nerfstudio's dataparser transform (p_ns = s · (R p + t)) as a navkit Frame."""
    d = json.loads(Path(transforms_path).read_text())
    M = np.array(d["transform"], float)                     # 3x4
    s = float(d.get("scale", 1.0))
    R, t = M[:3, :3], M[:3, 3]
    return Frame(R.T, 1.0 / s, -(R.T @ t))
