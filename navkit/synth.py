"""Synthetic office floor with exact ground truth.

Real captures have no ground truth, so this module builds a 24 m × 16 m office as a
noisy coloured point cloud from a known layout. It is used to

  * measure the pipeline: walkable-mask IoU and alignment error (see tests/), and
  * ship a venue-sized demo scene (clearly labelled synthetic) for long multi-room routes.

Source frame: metres, +Y up, floor at y = 0, x ∈ [0, 24], z ∈ [0, 16].
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

WIDTH, DEPTH, WALL_H, WALL_T = 24.0, 16.0, 2.7, 0.15


@dataclass
class Box:
    x0: float
    z0: float
    x1: float
    z1: float
    h: float
    color: tuple[int, int, int]


def _wall(x0, z0, x1, z1):
    """A wall segment given by its centre line; thickness is added around it."""
    t = WALL_T / 2
    return Box(min(x0, x1) - t, min(z0, z1) - t, max(x0, x1) + t, max(z0, z1) + t, WALL_H, (232, 229, 222))


def _wall_with_doors(a, b, fixed, doors, vertical=False):
    """Wall along one axis from a to b with door gaps [(start, end), ...]."""
    out, cur = [], a
    for d0, d1 in sorted(doors):
        if d0 > cur:
            out.append(_wall(fixed, cur, fixed, d0) if vertical else _wall(cur, fixed, d0, fixed))
        cur = d1
    if cur < b:
        out.append(_wall(fixed, cur, fixed, b) if vertical else _wall(cur, fixed, b, fixed))
    return out


ZONES = [  # name, category, rectangle (x0, z0, x1, z1), floor tint, aliases
    ("Reception", "service", (0, 0, 6, 7), (226, 232, 240), ["front desk", "help", "lobby"]),
    ("Meeting Room A", "room", (6, 0, 12, 7), (233, 228, 240), ["conference room", "meeting room 1"]),
    ("Meeting Room B", "room", (12, 0, 18, 7), (228, 238, 232), ["conference room", "meeting room 2"]),
    ("Pantry", "food", (18, 0, 24, 7), (242, 234, 222), ["kitchen", "cafeteria", "break room"]),
    ("Main corridor", "room", (0, 7, 24, 9), (214, 216, 220), ["hallway", "passage"]),
    ("Open workspace", "room", (0, 9, 14, 16), (230, 234, 238), ["desks", "office", "work area"]),
    ("Lounge", "seating", (14, 9, 20, 16), (240, 230, 226), ["break area", "sofa area", "relax"]),
    ("Server room", "room", (20, 9, 24, 16), (220, 226, 230), ["it room", "data room"]),
]


def layout() -> tuple[list[Box], list[dict]]:
    """Returns the solid boxes and the named points of interest (source coordinates)."""
    boxes: list[Box] = []
    # Outer shell; the main entrance is a gap in the west wall at the corridor.
    boxes += _wall_with_doors(0, DEPTH, 0, [(7.4, 8.6)], vertical=True)
    boxes += [_wall(WIDTH, 0, WIDTH, DEPTH), _wall(0, 0, WIDTH, 0), _wall(0, DEPTH, WIDTH, DEPTH)]
    # North rooms open onto the corridor through doors; reception is fully open.
    boxes += _wall_with_doors(6, WIDTH, 7, [(8.4, 9.5), (14.4, 15.5), (20.2, 21.6)])
    boxes += [_wall(6, 0, 6, 7), _wall(12, 0, 12, 7), _wall(18, 0, 18, 7)]
    # South side.
    boxes += _wall_with_doors(0, WIDTH, 9, [(3.0, 4.4), (10.0, 11.4), (16.2, 17.8), (21.4, 22.4)])
    boxes += [_wall(14, 9, 14, 16), _wall(20, 9, 20, 16)]

    wood, dark, blue, green, steel, white = (176, 132, 86), (58, 62, 72), (72, 110, 190), (70, 150, 96), (150, 156, 166), (236, 238, 240)
    pois: list[dict] = []

    def add(name, category, box, aliases=(), desc="", label_h=None):
        boxes.append(box)
        pois.append({"name": name, "category": category, "aliases": list(aliases), "description": desc,
                     "position": [(box.x0 + box.x1) / 2, (label_h or box.h + 0.35), (box.z0 + box.z1) / 2]})

    add("Reception desk", "service", Box(1.6, 2.4, 4.4, 3.2, 1.05, wood), ["front desk", "help desk", "info"], "Sign in here on arrival.")
    add("Visitor sofa", "seating", Box(0.5, 4.6, 2.6, 5.5, 0.75, blue), ["3-seater sofa", "couch", "waiting area"], "Three-seater sofa for visitors.")
    add("Table A", "table", Box(7.6, 2.4, 10.4, 4.2, 0.74, wood), ["meeting table"], "Eight-seat table in Meeting Room A.")
    add("Table B", "table", Box(13.6, 2.4, 16.4, 4.2, 0.74, wood), ["meeting table"], "Eight-seat table in Meeting Room B.")
    add("Display screen", "appliance", Box(8.2, 0.2, 9.8, 0.4, 1.9, dark), ["tv", "monitor", "projector"], "Wall display in Meeting Room A.")
    add("Whiteboard", "landmark", Box(14.0, 0.2, 16.0, 0.3, 2.0, white), ["board"], "Whiteboard in Meeting Room B.")
    add("Pantry counter", "food", Box(18.4, 0.3, 22.6, 1.0, 0.92, steel), ["kitchen counter", "sink"], "Counter with the sink.")
    add("Coffee machine", "food", Box(19.0, 0.4, 19.5, 0.9, 1.35, dark), ["coffee", "espresso", "tea"], "Bean-to-cup machine on the counter.")
    add("Fridge", "appliance", Box(23.0, 0.3, 23.8, 1.1, 1.85, white), ["refrigerator", "cold drinks"], "Shared fridge.")
    add("Pantry table", "table", Box(20.0, 3.6, 22.0, 4.8, 0.74, wood), ["lunch table", "eat"], "High table for lunch.")
    for row in range(3):  # three rows of four desks in the open workspace
        for col in range(4):
            x, z = 1.4 + col * 3.0, 10.4 + row * 1.9
            box = Box(x, z, x + 1.6, z + 0.8, 0.74, wood)
            if col == 0:
                add(f"Desk row {row + 1}", "table", Box(x, z, x + 1.6, z + 0.8, 0.74, wood), ["desks", "workstation"], f"Row {row + 1} of the open workspace.")
            else:
                boxes.append(box)
            boxes.append(Box(x + 0.55, z + 0.95, x + 1.05, z + 1.4, 0.5, dark))  # chair
    add("Printer", "appliance", Box(13.0, 9.4, 13.7, 10.1, 1.1, steel), ["copier", "scanner", "print"], "Multi-function printer.")
    add("Lounge sofas", "seating", Box(14.6, 13.6, 17.4, 14.6, 0.75, green), ["3-seater sofas", "couch", "sofa"], "Three-seater sofas around the coffee table.")
    add("Coffee table", "table", Box(15.4, 11.8, 16.6, 12.6, 0.42, wood), ["low table"], "Low table in the lounge.")
    boxes.append(Box(18.2, 11.4, 19.2, 13.0, 0.75, green))
    add("Bookshelf", "storage", Box(19.2, 14.4, 19.8, 15.8, 1.9, wood), ["books", "library", "shelf"], "Lounge bookshelf.")
    add("Server racks", "appliance", Box(21.2, 12.4, 23.6, 13.4, 2.0, dark), ["servers", "network", "rack"], "Three 42U racks.")
    for x, z in ((12.0, 8.0), (18.0, 8.0)):  # structural pillars in the corridor
        boxes.append(Box(x - 0.25, z - 0.25, x + 0.25, z + 0.25, WALL_H, (200, 200, 204)))
    add("Plant", "landmark", Box(5.2, 7.2, 5.7, 7.7, 1.3, green), ["greenery", "tree"], "Large potted plant by reception.")
    pois.append({"name": "Main entrance", "category": "entrance", "aliases": ["exit", "door", "way out", "front door"],
                 "description": "Street entrance on the west side.", "position": [0.7, 1.6, 8.0]})
    for name, category, (x0, z0, x1, z1), _, aliases in ZONES:
        pois.append({"name": name, "category": category, "aliases": aliases, "description": "",
                     "position": [(x0 + x1) / 2, 1.9, (z0 + z1) / 2],
                     "zone": [[x0 + 0.1, z0 + 0.1], [x1 - 0.1, z0 + 0.1], [x1 - 0.1, z1 - 0.1], [x0 + 0.1, z1 - 0.1]]})
    return boxes, pois


def blocked_mask(boxes: list[Box], res: float, x0: float = 0.0, z0: float = 0.0,
                 size: tuple[int, int] | None = None) -> np.ndarray:
    """Ground truth: True where a cell centre lies inside a solid or outside the building."""
    W, H = size or (int(round(WIDTH / res)), int(round(DEPTH / res)))
    xs = x0 + (np.arange(W) + 0.5) * res
    zs = z0 + (np.arange(H) + 0.5) * res
    X, Z = np.meshgrid(xs, zs)
    blocked = (X < 0) | (X > WIDTH) | (Z < 0) | (Z > DEPTH)
    for b in boxes:
        blocked |= (X >= b.x0) & (X <= b.x1) & (Z >= b.z0) & (Z <= b.z1)
    return blocked


def sample_cloud(boxes: list[Box], *, spacing: float = 0.03, noise: float = 0.008, seed: int = 3):
    """Sample the floor and every box surface the way a scanner would see them."""
    rng = np.random.default_rng(seed)
    pts, cols = [], []

    def emit(p, c, shade=1.0):
        p = p + rng.normal(0, noise, p.shape)
        c = np.clip(np.asarray(c, float) * shade * rng.uniform(0.93, 1.05, (len(p), 1)), 0, 255)
        pts.append(p)
        cols.append(c)

    # Floor, tinted per zone with a tile pattern so the walkthrough has visual texture.
    n = int(WIDTH * DEPTH / spacing ** 2)
    f = np.column_stack([rng.uniform(0, WIDTH, n), np.zeros(n), rng.uniform(0, DEPTH, n)])
    tint = np.full((n, 3), 215.0)
    for _, _, (x0, z0, x1, z1), color, _ in ZONES:
        inside = (f[:, 0] >= x0) & (f[:, 0] < x1) & (f[:, 2] >= z0) & (f[:, 2] < z1)
        tint[inside] = color
    grout = (np.abs(f[:, 0] % 0.6) < 0.02) | (np.abs(f[:, 2] % 0.6) < 0.02)
    tint[grout] *= 0.82
    covered = np.zeros(n, bool)
    for b in boxes:
        covered |= (f[:, 0] > b.x0) & (f[:, 0] < b.x1) & (f[:, 2] > b.z0) & (f[:, 2] < b.z1)
    emit(f[~covered], tint[~covered])

    for b in boxes:
        w, d = b.x1 - b.x0, b.z1 - b.z0
        k = max(8, int(w * d / spacing ** 2))
        emit(np.column_stack([rng.uniform(b.x0, b.x1, k), np.full(k, b.h), rng.uniform(b.z0, b.z1, k)]), b.color)
        for (ax, az, bx, bz), shade in (((b.x0, b.z0, b.x1, b.z0), 0.86), ((b.x0, b.z1, b.x1, b.z1), 0.9),
                                        ((b.x0, b.z0, b.x0, b.z1), 0.8), ((b.x1, b.z0, b.x1, b.z1), 0.94)):
            k = max(8, int(np.hypot(bx - ax, bz - az) * b.h / spacing ** 2))
            t = rng.uniform(0, 1, k)
            emit(np.column_stack([ax + (bx - ax) * t, rng.uniform(0, b.h, k), az + (bz - az) * t]), b.color, shade)
    return np.concatenate(pts), np.concatenate(cols).astype(np.uint8)


def write_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    v = np.zeros(len(xyz), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")])
    v["x"], v["y"], v["z"] = xyz.T
    v["red"], v["green"], v["blue"] = rgb.T
    header = ("ply\nformat binary_little_endian 1.0\nelement vertex %d\nproperty float x\nproperty float y\nproperty float z\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n" % len(v))
    with open(path, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(v.tobytes())


def write_scene(scene_dir: str | Path, spacing: float = 0.03) -> None:
    """Create ``source.ply`` and ``pois.source.json`` for the synthetic office scene."""
    scene_dir = Path(scene_dir)
    scene_dir.mkdir(parents=True, exist_ok=True)
    boxes, pois = layout()
    xyz, rgb = sample_cloud(boxes, spacing=spacing)
    write_ply(scene_dir / "source.ply", xyz, rgb)
    (scene_dir / "pois.source.json").write_text(json.dumps(pois, indent=1))
    print(f"[navkit] synthetic office: {len(xyz):,} points, {len(pois)} POIs -> {scene_dir}")
