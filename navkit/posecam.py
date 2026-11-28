"""PoseCam session -> metric, gravity-aligned coloured point cloud (no GPU needed).

PoseCam (the team's ARCore recorder) stores, for every frame, the phone's 6-DoF pose
in metres with +Y = up (gravity), plus the camera intrinsics. That removes the two
hardest problems of monocular reconstruction — scale and drift-free orientation — so
geometry can be recovered by placing per-frame depth into a shared world:

  1. Depth Anything V2 (metric, indoor) predicts depth for each sampled frame.
  2. The floor height is found from the poses + depth (the phone is carried at a roughly
     constant height), and each frame's depth scale is corrected so its floor pixels land
     on that floor — this removes most of the per-frame scale error of monocular depth.
  3. Points are fused into a 4 cm voxel grid; only voxels confirmed by several frames are
     kept, which rejects the depth noise that made Round 1's per-frame clouds unusable.
  4. The walked trajectory is exported too: floor a person demonstrably walked on is the
     strongest walkability evidence there is.

Output: <out>/source.ply (point cloud, nav frame: metres, +Y up) and <out>/trajectory.json.

    python -m navkit posecam <session_dir> app/scenes/<id> [--stride 8] [--max-depth 6]
"""
from __future__ import annotations

import csv
import glob
import json
import os
import re
import time
from pathlib import Path

import numpy as np
from PIL import Image

GL_TO_CV = np.diag([1.0, -1.0, -1.0, 1.0])
MODEL = "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"


def quat_to_matrix(qx, qy, qz, qw):
    return np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ])


def load_session(session: Path, stride: int):
    intr = json.loads((session / "intrinsics.json").read_text())
    K = np.array([[intr["fx"], 0, intr["cx"]], [0, intr["fy"], intr["cy"]], [0, 0, 1.0]])
    poses = {}
    with open(session / "poses.csv") as fh:
        for row in csv.DictReader(fh):
            if row["tracking_state"] != "TRACKING":
                continue
            T = np.eye(4)
            T[:3, :3] = quat_to_matrix(*(float(row[k]) for k in ("qx", "qy", "qz", "qw")))
            T[:3, 3] = [float(row["tx"]), float(row["ty"]), float(row["tz"])]
            poses[int(row["frame_index"])] = T @ GL_TO_CV          # camera(OpenCV) -> world
    frames = []
    for path in sorted(glob.glob(str(session / "frames" / "*.jpg"))):
        idx = int(re.match(r"(\d+)_", os.path.basename(path)).group(1))
        if idx % stride == 0 and idx in poses:
            frames.append((idx, path, poses[idx]))
    # Only the stretch of the walk that has images: without them nothing was mapped there.
    last = frames[-1][0] if frames else -1
    trajectory = np.array([T[:3, 3] for i, T in sorted(poses.items()) if i <= last])
    return K, (intr["width"], intr["height"]), frames, trajectory


class DepthModel:
    def __init__(self):
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        torch.set_num_threads(os.cpu_count() or 4)
        self.torch = torch
        self.proc = AutoImageProcessor.from_pretrained(MODEL)
        self.model = AutoModelForDepthEstimation.from_pretrained(MODEL).eval()

    def __call__(self, image: Image.Image) -> np.ndarray:
        # PoseCam frames are in sensor orientation (rotated 90°); the network expects upright.
        upright = image.rotate(-90, expand=True)
        with self.torch.no_grad():
            out = self.model(**self.proc(images=upright, return_tensors="pt")).predicted_depth
            out = self.torch.nn.functional.interpolate(out[:, None], size=upright.size[::-1], mode="bicubic", align_corners=False)
        depth = out[0, 0].numpy()
        return np.rot90(depth, k=1).copy()      # back to sensor orientation (undo the clockwise turn)


def work_scale(W: int, work_width: int = 640) -> float:
    """Depth and fusion run at <= work_width pixels wide: the depth network sees 518 px anyway,
    and 720p/1080p depth maps would only cost RAM (~4 MB each). The splat dataset keeps full size."""
    return min(1.0, work_width / float(W))


def scaled_K(K: np.ndarray, f: float) -> np.ndarray:
    if f == 1.0:
        return K
    Kf = K.copy()
    Kf[0, 0] *= f
    Kf[1, 1] *= f
    Kf[0, 2] = (K[0, 2] + 0.5) * f - 0.5
    Kf[1, 2] = (K[1, 2] + 0.5) * f - 0.5
    return Kf


def open_image(path, f: float = 1.0, gray: bool = False) -> Image.Image:
    im = Image.open(path).convert("L" if gray else "RGB")
    if f != 1.0:
        im = im.resize((round(im.width * f), round(im.height * f)), Image.BILINEAR)
    return im


def backproject(depth, K, T, step=2):
    h, w = depth.shape
    v, u = np.mgrid[0:h:step, 0:w:step]
    z = depth[v, u]
    x = (u - K[0, 2]) * z / K[0, 0]
    y = (v - K[1, 2]) * z / K[1, 1]
    cam = np.stack([x, y, z], -1).reshape(-1, 3)
    world = cam @ T[:3, :3].T + T[:3, 3]
    return world, v.ravel(), u.ravel(), z.ravel()


def metric_scale(frames, depth_of, K, log=print, f: float = 1.0) -> float:
    """True/predicted depth ratio, from features triangulated with ARCore's metric poses.

    Monocular networks get absolute scale wrong for an unfamiliar camera; ARCore's camera
    motion is in real metres, so points triangulated between two frames give the truth.
    """
    import cv2
    orb = cv2.ORB_create(3000)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    ratios = []
    for a in range(0, len(frames) - 4, 3):
        ia, pa, Ta = frames[a]
        for k in (2, 3, 4):
            ib, pb, Tb = frames[a + k]
            if np.linalg.norm(Ta[:3, 3] - Tb[:3, 3]) < 0.3:
                continue
            ka, da = orb.detectAndCompute(np.asarray(open_image(pa, f, gray=True)), None)
            kb, db = orb.detectAndCompute(np.asarray(open_image(pb, f, gray=True)), None)
            if da is None or db is None:
                continue
            m = matcher.match(da, db)
            if len(m) < 60:
                continue
            xa = np.float64([ka[x.queryIdx].pt for x in m])
            xb = np.float64([kb[x.trainIdx].pt for x in m])
            Pa, Pb = K @ np.linalg.inv(Ta)[:3], K @ np.linalg.inv(Tb)[:3]
            X = cv2.triangulatePoints(Pa, Pb, xa.T, xb.T)
            X = (X[:3] / X[3]).T
            Xh = np.c_[X, np.ones(len(X))]
            ca, cb = (Xh @ np.linalg.inv(Ta).T)[:, :3], (Xh @ np.linalg.inv(Tb).T)[:, :3]
            rep = lambda P, x: np.linalg.norm((Xh @ P.T)[:, :2] / (Xh @ P.T)[:, 2:] - x, axis=1)
            ra, rb = Ta[:3, 3] - X, Tb[:3, 3] - X
            parallax = np.degrees(np.arccos(np.clip((ra * rb).sum(1) / np.linalg.norm(ra, axis=1) / np.linalg.norm(rb, axis=1), -1, 1)))
            ok = (ca[:, 2] > 0.3) & (cb[:, 2] > 0.3) & (ca[:, 2] < 8) & (rep(Pa, xa) < 1.5) & (rep(Pb, xb) < 1.5) & (parallax > 2.0)
            if ok.sum() < 15:
                continue
            pred = depth_of(a)
            ratios.append(np.median(ca[ok, 2] / pred[xa[ok, 1].astype(int), xa[ok, 0].astype(int)]))
            break
    if len(ratios) < 10:
        raise RuntimeError("too few triangulated frame pairs to fix the depth scale — walk more slowly with more texture in view")
    r = np.array(ratios)
    log(f"[posecam] depth scale from {len(r)} triangulated frame pairs: {np.median(r):.3f} "
        f"(25–75 %: {np.percentile(r, 25):.3f}–{np.percentile(r, 75):.3f})")
    return float(np.median(r))


def build(session: str | Path, out_dir: str | Path, *, stride: int = 8, max_depth: float = 6.0,
          voxel: float = 0.04, min_views: int = 2, cache: str | Path | None = None, log=print):
    session, out_dir = Path(session), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    K, (W, H), frames, trajectory = load_session(session, stride)
    log(f"[posecam] {len(frames)} frames (stride {stride}), trajectory {len(trajectory)} poses")
    wf = work_scale(W)
    if wf != 1.0:
        log(f"[posecam] frames are {W}x{H}; depth and fusion run at {round(W * wf)}x{round(H * wf)}")
    K = scaled_K(K, wf)

    cache = Path(cache or out_dir / ".depth_cache")
    cache.mkdir(exist_ok=True)
    model = None
    t0 = time.time()
    depths = []
    for n, (idx, path, T) in enumerate(frames):
        f = cache / f"{idx:06d}.npy"
        if f.exists():
            d = np.load(f)
        else:
            model = model or DepthModel()
            d = model(open_image(path, wf)).astype(np.float16)
            np.save(f, d)
        depths.append(d.astype(np.float32))
        if n % 100 == 0:
            log(f"  depth {n}/{len(frames)}  ({time.time() - t0:.0f}s)")

    scale = metric_scale(frames, lambda k: depths[k], K, log, wf)
    depths = [d * scale for d in depths]

    # Floor height: the lowest dense horizontal layer of points seen near each camera.
    samples = []
    for (idx, path, T), d in zip(frames[::4], depths[::4]):
        p, *_ = backproject(d, K, T, step=8)
        samples.append(p[:, 1] - T[1, 3])
    rel = np.concatenate(samples)
    hist, edges = np.histogram(rel[(rel < -0.6) & (rel > -2.2)], bins=160)
    cam_above_floor = -float(edges[np.argmax(hist)] + (edges[1] - edges[0]) / 2)
    log(f"[posecam] camera carried {cam_above_floor:.2f} m above the floor (median)")

    # Per-frame scale correction (make each frame's floor land on the floor), then fuse.
    keys_all, sums_all, cols_all, n_all = [], [], [], []
    scales = []
    for (idx, path, T), d in zip(frames, depths):
        floor_y = T[1, 3] - cam_above_floor
        p, v, u, z = backproject(d, K, T, step=4)
        near_floor = (np.abs(p[:, 1] - floor_y) < 0.35) & (z < 4.0) & (p[:, 1] < T[1, 3] - 0.3)
        s = 1.0
        if near_floor.sum() > 150:
            # A floor point seen at depth z really lies at z·(camY−floorY)/(camY−pY).
            ratio = (T[1, 3] - floor_y) / np.maximum(T[1, 3] - p[near_floor, 1], 1e-3)
            s = float(np.clip(np.median(ratio), 0.6, 1.6))
        scales.append(s)
        p, v, u, z = backproject(d * s, K, T, step=2)
        keep = (z > 0.25) & (z < max_depth)
        p, v, u = p[keep], v[keep], u[keep]
        rgb = np.asarray(open_image(path, wf))[v, u].astype(np.float64)
        ijk = np.floor(p / voxel).astype(np.int64) + (1 << 20)
        key = (ijk[:, 0] << 42) | (ijk[:, 1] << 21) | ijk[:, 2]
        uk, inv = np.unique(key, return_inverse=True)
        keys_all.append(uk)
        sums_all.append(np.stack([np.bincount(inv, p[:, a], len(uk)) for a in range(3)], 1))
        cols_all.append(np.stack([np.bincount(inv, rgb[:, a], len(uk)) for a in range(3)], 1))
        n_all.append(np.bincount(inv, minlength=len(uk)))
    log(f"[posecam] per-frame depth scale correction: median {np.median(scales):.2f} "
        f"(10–90 %: {np.percentile(scales, 10):.2f}–{np.percentile(scales, 90):.2f})")

    keys = np.concatenate(keys_all)
    uk, inv = np.unique(keys, return_inverse=True)
    views = np.bincount(inv, minlength=len(uk))                 # frames that saw each voxel
    n = np.bincount(inv, np.concatenate(n_all), len(uk))
    pos = np.stack([np.bincount(inv, np.concatenate(sums_all)[:, a], len(uk)) for a in range(3)], 1) / n[:, None]
    col = np.stack([np.bincount(inv, np.concatenate(cols_all)[:, a], len(uk)) for a in range(3)], 1) / n[:, None]
    good = views >= min_views
    log(f"[posecam] {len(uk):,} voxels, {good.sum():,} confirmed by ≥{min_views} frames")

    # Nav frame: floor at y = 0 (gravity already vertical, units already metres).
    floor0 = float(np.median(trajectory[:, 1]) - cam_above_floor)
    xyz = pos[good] - np.array([0.0, floor0, 0.0])
    rgb = np.clip(col[good], 0, 255).astype(np.uint8)
    from .synth import write_ply
    write_ply(out_dir / "source.ply", xyz, rgb)
    walked = trajectory - np.array([0.0, floor0, 0.0])
    (out_dir / "trajectory.json").write_text(json.dumps({
        "note": "PoseCam camera path in nav coordinates (metres, +Y up, floor at 0); a person walked here.",
        "camera_above_floor_m": round(cam_above_floor, 3),
        "floor_offset_m": round(floor0, 4),
        "depth_scale": round(scale, 4),
        "points": walked[::3, [0, 2]].round(3).tolist(),
    }))
    log(f"[posecam] wrote {out_dir / 'source.ply'} ({len(xyz):,} points) and trajectory.json")
    return xyz, rgb, walked
