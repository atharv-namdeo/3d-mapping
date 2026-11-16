"""Propose candidate POIs and zones so a human only has to *name* things, not find them.

These are suggestions surfaced in the web editor — nothing is published until a person
confirms and labels it.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from .grid import NavGrid


def _describe(height: float, footprint: float) -> str:
    if height < 0.6:
        return "low object (seat / bench / low table)"
    if height < 1.1:
        return "table-height object (table / desk / counter)"
    if footprint > 1.5:
        return "tall fixture (wall unit / partition)"
    return "tall object (shelf / cabinet / appliance / pillar)"


def suggest_objects(grid: NavGrid, min_area: float = 0.08, max_area: float = 6.0) -> list[dict]:
    """Furniture-sized obstacle blobs next to the walkable floor."""
    res = grid.res
    solid = grid.obstacle_height > 0
    near_floor = ndi.binary_dilation(grid.walkable, iterations=round(0.6 / res))
    labels, n = ndi.label(solid)
    out = []
    for k, sl in enumerate(ndi.find_objects(labels), start=1):
        blob = labels[sl] == k
        area = float(blob.sum()) * res * res
        if not (min_area <= area <= max_area) or not (blob & near_floor[sl]).any():
            continue
        heights = grid.obstacle_height[sl][blob]
        jj, ii = np.nonzero(blob)
        cx = grid.x0 + (sl[1].start + ii.mean() + 0.5) * res
        cz = grid.z0 + (sl[0].start + jj.mean() + 0.5) * res
        top = float(np.percentile(heights, 90))
        out.append({
            "kind": "object", "hint": _describe(top, area),
            "position": [round(cx, 3), round(cz, 3)], "height_m": round(top, 2),
            "footprint_m2": round(area, 2),
            "size_m": [round((sl[1].stop - sl[1].start) * res, 2), round((sl[0].stop - sl[0].start) * res, 2)],
        })
    return sorted(out, key=lambda o: -o["footprint_m2"])


def suggest_zones(grid: NavGrid, min_radius: float = 0.45) -> list[dict]:
    """Open areas found as peaks of the clearance field (a light-weight room segmentation)."""
    clearance = grid.clearance()
    window = max(3, round(1.2 / grid.res) | 1)
    peaks = (clearance == ndi.maximum_filter(clearance, size=window)) & (clearance >= min_radius)
    labels, n = ndi.label(peaks)
    zones = []
    for j, i in ndi.center_of_mass(peaks, labels, index=np.arange(1, n + 1)):
        r = float(clearance[int(round(j)), int(round(i))])
        zones.append({
            "kind": "zone", "hint": "open area",
            "position": [round(grid.x0 + (i + 0.5) * grid.res, 3), round(grid.z0 + (j + 0.5) * grid.res, 3)],
            "radius_m": round(r, 2),
        })
    return sorted(zones, key=lambda z: -z["radius_m"])
