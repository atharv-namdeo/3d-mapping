"""Rasterise an aligned reconstruction into a walkable-floor grid.

The grid lies in the XZ plane of the navigation frame. Cell ``(col i, row j)`` covers
``x ∈ [x0 + i·res, x0 + (i+1)·res)`` and ``z ∈ [z0 + j·res, z0 + (j+1)·res)``.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as ndi


@dataclass
class AgentSpec:
    """Physical assumptions about the person walking through the space (metres)."""

    height: float = 1.8       # anything lower than this above the floor blocks the way
    step: float = 0.12        # ... unless it is lower than a comfortable step
    floor_band: float = 0.07  # reconstruction noise tolerated around the floor plane


@dataclass
class NavGrid:
    res: float
    x0: float
    z0: float
    walkable: np.ndarray              # (H, W) bool
    obstacle_height: np.ndarray       # (H, W) float32 metres, 0 where nothing stands
    stats: dict = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int]:
        return self.walkable.shape

    def cell_of(self, x: float, z: float) -> tuple[int, int]:
        return int((x - self.x0) // self.res), int((z - self.z0) // self.res)

    def clearance(self) -> np.ndarray:
        """Distance (m) from each walkable cell centre to the nearest non-walkable cell."""
        return ndi.distance_transform_edt(self.walkable) * self.res


def _disk(radius_cells: int) -> np.ndarray:
    r = max(1, radius_cells)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) <= r * r


def _hysteresis(count: np.ndarray, low: float, high: float) -> np.ndarray:
    """Keep weak evidence only where it touches strong evidence (as in Canny edges)."""
    weak = count >= low
    labels, n = ndi.label(weak, structure=np.ones((3, 3)))
    if n == 0:
        return weak
    strong = np.zeros(n + 1, bool)
    strong[np.unique(labels[count >= high])] = True
    strong[0] = False
    return strong[labels]


def build_grid(xyz: np.ndarray, *, res: float = 0.05, agent: AgentSpec | None = None,
               weight: np.ndarray | None = None, margin: float = 0.6,
               seed_xz: tuple[float, float] | None = None, gap_fill: float = 0.15,
               context_margin: float = 1.2) -> NavGrid:
    """Extract the walkable floor from points already expressed in the navigation frame.

    1. Floor evidence   — points within ``floor_band`` of y = 0.
    2. Obstacle evidence — points between step height and head height.
    3. A cell is walkable when the floor was *observed* there and nothing blocks it;
       unobserved space is never assumed to be free.
    4. Only the connected region the visitor can actually reach is kept.
    """
    agent = agent or AgentSpec()
    y = xyz[:, 1]
    w = np.ones(len(xyz)) if weight is None else weight
    is_floor = np.abs(y) <= agent.floor_band
    is_obstacle = (y > agent.step) & (y < agent.height)
    if is_floor.sum() < 100:
        raise RuntimeError("almost no floor points — is the floor plane / scale right?")

    fx, fz = xyz[is_floor, 0], xyz[is_floor, 2]
    x0 = float(np.percentile(fx, 0.5) - margin)
    z0 = float(np.percentile(fz, 0.5) - margin)
    W = int(np.ceil((np.percentile(fx, 99.5) + margin - x0) / res))
    H = int(np.ceil((np.percentile(fz, 99.5) + margin - z0) / res))

    ci = np.floor((xyz[:, 0] - x0) / res).astype(np.int64)
    cj = np.floor((xyz[:, 2] - z0) / res).astype(np.int64)
    inside = (ci >= 0) & (ci < W) & (cj >= 0) & (cj < H)

    def accumulate(mask: np.ndarray) -> np.ndarray:
        m = mask & inside
        return np.bincount(cj[m] * W + ci[m], weights=w[m], minlength=W * H).reshape(H, W)

    floor_count = accumulate(is_floor)
    obstacle_count = accumulate(is_obstacle)

    # Thresholds adapt to the capture's sampling density instead of being hard-coded.
    density = float(np.median(floor_count[floor_count > 0]))
    floor_seen = floor_count >= max(1.0, 0.15 * density)
    obstacle = _hysteresis(obstacle_count, max(1.5, 0.2 * density), max(3.0, 0.5 * density))
    obstacle = ndi.binary_opening(obstacle, structure=np.ones((2, 2))) | (obstacle_count >= 2.0 * density)

    # Bridge sampling gaps in the floor (dark grout, glossy tiles) without leaking through walls.
    floor_closed = ndi.binary_closing(floor_seen, structure=_disk(round(gap_fill / res)), border_value=0)
    walkable = floor_closed & ~ndi.binary_dilation(obstacle, structure=np.ones((3, 3)))
    walkable = ndi.binary_opening(walkable, structure=_disk(1))

    labels, n = ndi.label(walkable)  # 4-connectivity: diagonal pinholes do not connect rooms
    if n == 0:
        raise RuntimeError("no walkable area found")
    if seed_xz is not None:
        si, sj = int((seed_xz[0] - x0) // res), int((seed_xz[1] - z0) // res)
        keep = labels[sj, si] if 0 <= si < W and 0 <= sj < H and labels[sj, si] else 0
    else:
        keep = 0
    if not keep:
        keep = 1 + int(np.argmax(ndi.sum(walkable, labels, index=np.arange(1, n + 1))))
    walkable = labels == keep
    # Islands of "unknown" smaller than a footprint inside the floor are noise, not pillars.
    holes, m = ndi.label(~walkable)
    sizes = ndi.sum(~walkable, holes, index=np.arange(1, m + 1))
    tiny = np.zeros(m + 1, bool)
    tiny[1:] = sizes * res * res < 0.02
    walkable |= tiny[holes] & ~obstacle

    # Per-cell obstacle height: the heightfield used for picking, occlusion and the blueprint view.
    height = np.zeros(W * H, np.float32)
    m = inside & (y > agent.step) & (y < 2.6)
    np.maximum.at(height, cj[m] * W + ci[m], y[m].astype(np.float32))
    height = height.reshape(H, W)
    tall = _hysteresis(accumulate(m), max(1.5, 0.3 * density), max(3.0, 0.8 * density))
    # Keep only structure bordering the mapped floor: what lies beyond the first wall is
    # reconstruction background, and a median filter removes single-cell spikes.
    context = ndi.binary_dilation(walkable, structure=_disk(round(context_margin / res)))
    height = ndi.median_filter(np.where(tall, height, 0), size=3)
    height = np.where(context & ~walkable, height, 0).astype(np.float32)

    stats = {
        "cells": [W, H], "resolution_m": res,
        "walkable_area_m2": round(float(walkable.sum()) * res * res, 2),
        "floor_density_per_cell": round(density, 2),
        "regions_discarded": int(n - 1),
    }
    return NavGrid(res, x0, z0, walkable, height, stats)
