"""PLY readers and the compact ``.splat`` writer used by the web viewer."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_PLY_TYPES = {
    "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
    "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
    "short": "<i2", "ushort": "<u2", "int": "<i4", "int32": "<i4", "uint": "<u4",
}
SH_C0 = 0.28209479177387814  # zeroth-order spherical-harmonic basis constant


@dataclass
class Cloud:
    """A reconstruction reduced to what navigation needs, plus optional splat attributes."""

    xyz: np.ndarray                 # (N, 3) float64 positions in source units
    rgb: np.ndarray                 # (N, 3) uint8 colours
    opacity: np.ndarray | None = None   # (N,) 0..1      (splats only)
    scales: np.ndarray | None = None    # (N, 3) linear  (splats only)
    quats: np.ndarray | None = None     # (N, 4) w,x,y,z (splats only)

    @property
    def is_splat(self) -> bool:
        return self.quats is not None

    def select(self, mask: np.ndarray) -> "Cloud":
        pick = lambda a: None if a is None else a[mask]
        return Cloud(self.xyz[mask], self.rgb[mask], pick(self.opacity), pick(self.scales), pick(self.quats))

    def __len__(self) -> int:
        return len(self.xyz)


def _read_vertices(path: Path) -> np.ndarray:
    with open(path, "rb") as fh:
        header = b""
        while not header.endswith(b"end_header\n"):
            line = fh.readline()
            if not line:
                raise ValueError(f"{path}: truncated PLY header")
            header += line
        text = header.decode("ascii", "replace")
        if "binary_little_endian" not in text:
            raise ValueError(f"{path}: only binary_little_endian PLY is supported")
        count = int(re.search(r"element vertex (\d+)", text).group(1))
        vertex_block = text.split("element vertex", 1)[1].split("element", 1)[0]
        props = re.findall(r"property (\w+) (\w+)", vertex_block)
        dtype = np.dtype([(name, _PLY_TYPES[kind]) for kind, name in props])
        return np.frombuffer(fh.read(count * dtype.itemsize), dtype=dtype, count=count)


def read_ply(path: str | Path) -> Cloud:
    """Read either a coloured point cloud / mesh-vertex PLY or a 3D Gaussian Splatting PLY."""
    v = _read_vertices(Path(path))
    names = v.dtype.names
    xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float64)

    if "f_dc_0" in names:  # 3DGS export (Nerfstudio / INRIA / Brush layout)
        dc = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=1)
        rgb = (np.clip(0.5 + SH_C0 * dc, 0, 1) * 255).astype(np.uint8)
        opacity = 1.0 / (1.0 + np.exp(-v["opacity"].astype(np.float64)))
        scales = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=1).astype(np.float64))
        quats = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], axis=1).astype(np.float64)
        quats /= np.linalg.norm(quats, axis=1, keepdims=True) + 1e-12
        return Cloud(xyz, rgb, opacity, scales, quats)

    if "red" in names:
        rgb = np.stack([v["red"], v["green"], v["blue"]], axis=1).astype(np.uint8)
    else:
        rgb = np.full((len(xyz), 3), 190, np.uint8)
    return Cloud(xyz, rgb)


def write_splat(path: str | Path, cloud: Cloud, limit: int | None = None) -> int:
    """Write the 32-byte-per-splat ``.splat`` format, most important splats first.

    Because the file is importance-sorted, any prefix of it is a valid lower level of
    detail — the builder uses that to emit a small "lite" file for phones.
    """
    importance = cloud.opacity * np.prod(cloud.scales, axis=1) ** (1 / 3)
    order = np.argsort(-importance)
    if limit:
        order = order[:limit]
    out = np.zeros(len(order), dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
    out["p"] = cloud.xyz[order]
    out["s"] = cloud.scales[order]
    out["c"][:, :3] = cloud.rgb[order]
    out["c"][:, 3] = np.clip(cloud.opacity[order] * 255, 0, 255)
    out["r"] = np.clip(cloud.quats[order] * 128 + 128, 0, 255)
    out.tofile(path)
    return len(order)


def write_points(path: str | Path, cloud: Cloud, limit: int | None = None, seed: int = 7) -> int:
    """Write a compact binary point cloud (float32 xyz + uint8 rgb, 15 bytes/point)."""
    idx = np.arange(len(cloud))
    if limit and len(idx) > limit:
        idx = np.random.default_rng(seed).choice(idx, limit, replace=False)
    out = np.zeros(len(idx), dtype=[("p", "<f4", 3), ("c", "u1", 3)])
    out["p"] = cloud.xyz[idx]
    out["c"] = cloud.rgb[idx]
    out.tofile(path)
    return len(idx)


def write_gaussian_ply(path: str | Path, cloud: Cloud) -> None:
    """Write a standard 3D-Gaussian-Splatting PLY (degree-0 colour), readable by read_ply and splat tools."""
    n = len(cloud)
    fields = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
              "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.zeros((n, len(fields)), "<f4")
    data[:, 0:3] = cloud.xyz
    data[:, 3:6] = (cloud.rgb / 255.0 - 0.5) / SH_C0
    op = np.clip(cloud.opacity, 1e-4, 1 - 1e-4)
    data[:, 6] = np.log(op / (1 - op))
    data[:, 7:10] = np.log(np.maximum(cloud.scales, 1e-8))
    data[:, 10:14] = cloud.quats
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n
    header += "".join(f"property float {f}\n" for f in fields) + "end_header\n"
    with open(path, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(data.tobytes())
