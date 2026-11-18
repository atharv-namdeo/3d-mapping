"""Point cloud -> oriented surface discs ("surfels"), rendered as flat Gaussians.

A raw point cloud draws as separate square dots with gaps between them. Here every
point becomes a small disc that lies on the local surface (normal from the PCA of its
neighbours) and is just wide enough to reach them, so walls, floors and furniture read
as continuous surfaces. The result uses the standard 3D-Gaussian layout, so the existing
splat renderer, LOD file and phone "lite" version all work unchanged.
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from .io_ply import Cloud


def quats_from_matrices(R: np.ndarray) -> np.ndarray:
    """Batched rotation matrices (N, 3, 3) -> unit quaternions (N, 4) as w, x, y, z."""
    tr = R[:, 0, 0] + R[:, 1, 1] + R[:, 2, 2]
    w = np.sqrt(np.maximum(0, 1 + tr)) / 2
    x = np.copysign(np.sqrt(np.maximum(0, 1 + R[:, 0, 0] - R[:, 1, 1] - R[:, 2, 2])) / 2, R[:, 2, 1] - R[:, 1, 2])
    y = np.copysign(np.sqrt(np.maximum(0, 1 - R[:, 0, 0] + R[:, 1, 1] - R[:, 2, 2])) / 2, R[:, 0, 2] - R[:, 2, 0])
    z = np.copysign(np.sqrt(np.maximum(0, 1 - R[:, 0, 0] - R[:, 1, 1] + R[:, 2, 2])) / 2, R[:, 1, 0] - R[:, 0, 1])
    q = np.stack([w, x, y, z], axis=1)
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def to_surfels(cloud: Cloud, *, k: int = 12, min_size: float = 0.012, max_size: float = 0.06,
               coverage: float = 0.75, thickness: float = 0.004, opacity: float = 0.95,
               log=print) -> Cloud:
    """Return a splat Cloud with one flat Gaussian per input point.

    ``coverage`` scales the disc's standard deviation relative to the local point spacing:
    ~0.75 makes neighbouring discs overlap enough to close gaps without blurring edges.
    """
    xyz = cloud.xyz
    tree = cKDTree(xyz)
    dist, idx = tree.query(xyz, k=k + 1, workers=-1)
    nbr = xyz[idx[:, 1:]]                                   # (N, k, 3)
    centred = nbr - nbr.mean(axis=1, keepdims=True)
    cov = np.einsum("nki,nkj->nij", centred, centred) / k
    evals, evecs = np.linalg.eigh(cov)                      # ascending eigenvalues
    normal = evecs[:, :, 0]
    t1 = evecs[:, :, 2]
    t2 = np.cross(normal, t1)                               # right-handed frame (t1, t2, normal)

    spacing = dist[:, 1:5].mean(axis=1)                     # typical distance to nearby points
    sigma = np.clip(coverage * spacing, min_size, max_size)
    # Planar neighbourhoods get thin discs; noisy or edge points stay round and small.
    planarity = (evals[:, 1] - evals[:, 0]) / np.maximum(evals[:, 2], 1e-12)
    flat = planarity > 0.25
    scales = np.empty((len(xyz), 3))
    scales[:, 0] = scales[:, 1] = sigma
    scales[:, 2] = np.where(flat, thickness, sigma * 0.6)
    scales[~flat, :2] *= 0.8

    R = np.stack([t1, t2, normal], axis=2)                  # columns = local axes in world
    quats = quats_from_matrices(R)
    log(f"[surfels] {len(xyz):,} discs, {flat.mean():.0%} on flat surfaces, "
        f"median size {np.median(sigma) * 100:.1f} cm")
    return Cloud(xyz, cloud.rgb, np.full(len(xyz), opacity), scales, quats)
