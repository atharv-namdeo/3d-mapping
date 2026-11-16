"""Bring a reconstruction into the navigation frame: Y up, floor at y = 0, metres."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .io_ply import Cloud


@dataclass
class Frame:
    """Similarity transform ``p_nav = scale * R @ p_src + t`` from source to navigation space."""

    R: np.ndarray       # (3, 3) proper rotation
    scale: float        # metres per source unit
    t: np.ndarray       # (3,) translation in metres

    def apply(self, xyz: np.ndarray) -> np.ndarray:
        return self.scale * xyz @ self.R.T + self.t

    def matrix(self) -> list[list[float]]:
        m = np.eye(4)
        m[:3, :3] = self.scale * self.R
        m[:3, 3] = self.t
        return m.round(6).tolist()


def fit_floor_plane(xyz: np.ndarray, up_hint: np.ndarray, *, iters: int = 1500,
                    max_tilt_deg: float = 30.0, seed: int = 0) -> tuple[np.ndarray, float, float]:
    """RANSAC the dominant near-horizontal plane that has the scene above it.

    Returns ``(unit_normal, offset, inlier_ratio)`` with ``normal @ p = offset`` on the floor.
    The inlier tolerance scales with the scene so the same code works on metric
    captures and on unit-normalised radiance-field exports.
    """
    rng = np.random.default_rng(seed)
    sub = xyz[rng.choice(len(xyz), min(len(xyz), 120_000), replace=False)]
    up_hint = up_hint / np.linalg.norm(up_hint)
    extent = np.percentile(sub, 98, axis=0) - np.percentile(sub, 2, axis=0)
    tol = 0.006 * float(extent.max())
    cos_limit = np.cos(np.radians(max_tilt_deg))
    heights = sub @ up_hint
    low = sub[heights < np.percentile(heights, 60)]  # floor lives in the lower part of the scene

    best_score, best = -1.0, None
    for _ in range(iters):
        a, b, c = low[rng.choice(len(low), 3, replace=False)]
        n = np.cross(b - a, c - a)
        norm = np.linalg.norm(n)
        if norm < 1e-12:
            continue
        n /= norm
        if n @ up_hint < 0:
            n = -n
        if n @ up_hint < cos_limit:
            continue
        d = (sub - a) @ n
        inliers = np.abs(d) < tol
        # A floor has (almost) nothing beneath it; a table top or ceiling does.
        below = np.mean(d < -3 * tol)
        score = inliers.sum() * (1.0 - min(1.0, 4.0 * below))
        if score > best_score:
            best_score, best = score, (n, a, inliers)

    if best is None:
        raise RuntimeError("no near-horizontal plane found — check the `up` hint in the scene config")
    n, a, inliers = best
    pts = sub[inliers]
    centroid = pts.mean(axis=0)
    # Least-squares refinement: the normal is the smallest principal axis of the inliers.
    _, _, vt = np.linalg.svd(pts - centroid, full_matrices=False)
    refined = vt[2] if vt[2] @ n > 0 else -vt[2]
    return refined, float(refined @ centroid), float(inliers.mean())


def manhattan_yaw(xz: np.ndarray, cell: float = 0.05) -> float:
    """Yaw (radians, within ±45°) that makes walls axis-aligned.

    Minimises the entropy of the coordinate histograms: when walls line up with the
    axes, their points pile into few bins and the histograms become sharply peaked.
    """
    def entropy(theta: float) -> float:
        c, s = np.cos(theta), np.sin(theta)
        total = 0.0
        for coord in (c * xz[:, 0] - s * xz[:, 1], s * xz[:, 0] + c * xz[:, 1]):
            hist = np.bincount(((coord - coord.min()) / cell).astype(np.int64)).astype(np.float64)
            p = hist[hist > 0] / hist.sum()
            total += float(-(p * np.log(p)).sum())
        return total

    coarse = np.radians(np.arange(-45.0, 45.0, 1.0))
    best = coarse[int(np.argmin([entropy(t) for t in coarse]))]
    fine = best + np.radians(np.arange(-1.0, 1.01, 0.1))
    return float(fine[int(np.argmin([entropy(t) for t in fine]))])


def estimate_frame(cloud: Cloud, *, up_hint=(0, 0, 1), metres_per_unit: float = 1.0,
                   square_up: bool = True, yaw_deg: float | None = None) -> tuple[Frame, dict]:
    """Estimate the source→navigation transform and report how well the floor was found."""
    confident = cloud.xyz
    if cloud.is_splat:  # ignore faint / oversized splats: they are mostly floaters
        size = cloud.scales.max(axis=1)
        confident = cloud.xyz[(cloud.opacity > 0.5) & (size < np.percentile(size, 90))]

    normal, offset, inlier_ratio = fit_floor_plane(confident, np.asarray(up_hint, float))
    helper = np.array([1.0, 0, 0]) if abs(normal[0]) < 0.9 else np.array([0, 0, 1.0])
    e1 = np.cross(helper, normal)
    e1 /= np.linalg.norm(e1)
    R = np.stack([e1, normal, np.cross(e1, normal)])  # rows = nav X, Y, Z axes (right-handed)
    frame = Frame(R, metres_per_unit, np.array([0.0, -offset * metres_per_unit, 0.0]))

    yaw = 0.0
    if yaw_deg is not None:
        yaw = np.radians(yaw_deg)
    elif square_up:
        p = frame.apply(confident)
        walls = p[(p[:, 1] > 0.3) & (p[:, 1] < 2.0)]
        if len(walls) > 2000:
            rng = np.random.default_rng(1)
            walls = walls[rng.choice(len(walls), min(len(walls), 60_000), replace=False)]
            yaw = manhattan_yaw(walls[:, [0, 2]])
    if yaw:
        c, s = np.cos(yaw), np.sin(yaw)
        # rotate about +Y so that x' = c·x − s·z, z' = s·x + c·z
        frame = Frame(np.array([[c, 0, -s], [0, 1, 0], [s, 0, c]]) @ R, metres_per_unit, frame.t)

    report = {"floor_inlier_ratio": round(inlier_ratio, 4), "yaw_deg": round(float(np.degrees(yaw)), 2),
              "up_in_source": normal.round(5).tolist(), "metres_per_unit": metres_per_unit}
    return frame, report


def _quat_from_matrix(R: np.ndarray) -> np.ndarray:
    w = np.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = np.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2
    y = np.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2
    z = np.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2
    x = np.copysign(x, R[2, 1] - R[1, 2])
    y = np.copysign(y, R[0, 2] - R[2, 0])
    z = np.copysign(z, R[1, 0] - R[0, 1])
    return np.array([w, x, y, z])


def transform_cloud(cloud: Cloud, frame: Frame) -> Cloud:
    """Apply the frame to positions and, for splats, to each Gaussian's size and orientation."""
    xyz = frame.apply(cloud.xyz)
    if not cloud.is_splat:
        return Cloud(xyz, cloud.rgb)
    w0, x0, y0, z0 = _quat_from_matrix(frame.R)
    w1, x1, y1, z1 = cloud.quats.T
    quats = np.stack([  # Hamilton product q_frame ⊗ q_splat
        w0 * w1 - x0 * x1 - y0 * y1 - z0 * z1,
        w0 * x1 + x0 * w1 + y0 * z1 - z0 * y1,
        w0 * y1 - x0 * z1 + y0 * w1 + z0 * x1,
        w0 * z1 + x0 * y1 - y0 * x1 + z0 * w1,
    ], axis=1)
    return Cloud(xyz, cloud.rgb, cloud.opacity, cloud.scales * frame.scale, quats)
