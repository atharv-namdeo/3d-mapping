"""Pipeline accuracy against ground truth (run: python -m unittest discover -s tests -p 'test_*.py')."""
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from navkit import synth  # noqa: E402
from navkit.align import estimate_frame, transform_cloud  # noqa: E402
from navkit.build import build_scene, encode_nav  # noqa: E402
from navkit.grid import build_grid  # noqa: E402
from navkit.io_ply import Cloud, read_ply, write_splat  # noqa: E402


def rotation(axis, degrees):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    a = np.radians(degrees)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


class SyntheticOffice(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.boxes, cls.pois = synth.layout()
        cls.xyz, cls.rgb = synth.sample_cloud(cls.boxes, spacing=0.04)

    def test_walkable_mask_matches_ground_truth(self):
        grid = build_grid(self.xyz, res=0.05)
        truth = ~synth.blocked_mask(self.boxes, grid.res, grid.x0, grid.z0, (grid.shape[1], grid.shape[0]))
        iou = (grid.walkable & truth).sum() / (grid.walkable | truth).sum()
        # The pipeline deliberately keeps a one-cell (5 cm) margin around every obstacle,
        # so it under-covers slightly; that margin is what the remaining ~10 % is.
        self.assertGreater(iou, 0.85, f"walkable IoU {iou:.3f}")
        # Safety matters more than coverage: almost nothing solid may be marked walkable.
        leaked = (grid.walkable & ~truth).sum() / grid.walkable.sum()
        self.assertLess(leaked, 0.01, f"{leaked:.2%} of walkable cells are actually solid")

    def test_alignment_recovers_gravity_scale_and_floor(self):
        # Present the capture the way a radiance-field export arrives: tilted, shrunk, shifted.
        R = rotation([1, 0.3, 0.2], 17.0)
        scale = 0.21
        skewed = (self.xyz @ R.T) * scale + np.array([0.4, -1.1, 2.0])
        true_up = R @ np.array([0, 1.0, 0])
        frame, report = estimate_frame(Cloud(skewed, self.rgb), up_hint=[0, 1, 0], metres_per_unit=1 / scale)
        up_error = np.degrees(np.arccos(np.clip(np.dot(report["up_in_source"], true_up), -1, 1)))
        self.assertLess(up_error, 0.5, f"gravity off by {up_error:.2f} deg")
        aligned = frame.apply(skewed)
        floor = aligned[np.abs(aligned[:, 1]) < 0.05]
        self.assertGreater(len(floor) / len(aligned), 0.25, "floor did not land on y = 0")
        # Manhattan yaw: walls end up axis-aligned, so the footprint is the true 24 m x 16 m box.
        extent = np.sort(np.ptp(aligned[:, [0, 2]], axis=0))
        np.testing.assert_allclose(extent, [16.15, 24.15], atol=0.2)

    def test_scale_from_one_ceiling_measurement(self):
        # Close the office with a ceiling at 2.7 m, then shrink it by an unknown factor.
        rng = np.random.default_rng(5)
        n = 250_000
        ceiling = np.column_stack([rng.uniform(0, synth.WIDTH, n), np.full(n, synth.WALL_H), rng.uniform(0, synth.DEPTH, n)])
        closed = np.vstack([self.xyz, ceiling + rng.normal(0, 0.008, ceiling.shape)])
        shrink = 0.137
        frame, report = estimate_frame(Cloud(closed * shrink, np.zeros((len(closed), 3), np.uint8)),
                                       up_hint=[0, 1, 0], square_up=False, ceiling_height_m=2.7)
        self.assertAlmostEqual(report["metres_per_unit"] * shrink, 1.0, delta=0.01, msg=report["scale_from"])
        # Without enough ceiling in view it refuses rather than guessing.
        with self.assertRaisesRegex(RuntimeError, "too little ceiling"):
            estimate_frame(Cloud(self.xyz * shrink, self.rgb), up_hint=[0, 1, 0], ceiling_height_m=2.7)

    def test_end_to_end_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            scene = Path(tmp)
            synth.write_ply(scene / "source.ply", self.xyz, self.rgb)
            (scene / "pois.source.json").write_text(json.dumps(self.pois))
            (scene / "scene.json").write_text(json.dumps({
                "id": "t", "name": "t", "source": {"path": "source.ply"},
                "calibration": {"up": [0, 1, 0], "squareUp": False}, "view": {"maxPoints": 20000}}))
            nav = build_scene(scene, verbose=False)
            for name in ("nav.json", "floorplan.png", "scene.points.bin", "suggestions.json", "pois.json"):
                self.assertTrue((scene / name).exists(), name)
            W, H = nav["size"]
            bits = np.unpackbits(np.frombuffer(base64.b64decode(nav["walkable"]), np.uint8), bitorder="little")[:W * H]
            self.assertAlmostEqual(bits.sum() * nav["resolution"] ** 2, nav["stats"]["walkable_area_m2"], delta=0.01)
            # Every published POI can be reached: there is walkable floor within 1.5 m of it.
            walk = bits.reshape(H, W).astype(bool)
            jj, ii = np.nonzero(walk)
            cx = nav["origin"][0] + (ii + 0.5) * nav["resolution"]
            cz = nav["origin"][1] + (jj + 0.5) * nav["resolution"]
            for poi in json.loads((scene / "pois.json").read_text()):
                d = np.hypot(cx - poi["position"][0], cz - poi["position"][2]).min()
                self.assertLess(d, 1.5, f"{poi['name']} is {d:.1f} m from any walkable floor")

    def test_noisy_capture_is_rejected_not_silently_mapped(self):
        rng = np.random.default_rng(0)
        with tempfile.TemporaryDirectory() as tmp:
            scene = Path(tmp)
            synth.write_ply(scene / "source.ply", rng.normal(0, 2, (40000, 3)), np.full((40000, 3), 128, np.uint8))
            (scene / "scene.json").write_text(json.dumps({"id": "n", "name": "n", "source": {"path": "source.ply"}}))
            with self.assertRaisesRegex(RuntimeError, "too\\s+noisy|no near-horizontal|floor"):
                build_scene(scene, verbose=False)


class Surfels(unittest.TestCase):
    def test_discs_lie_flat_on_surfaces_and_close_gaps(self):
        from navkit.surfels import to_surfels
        rng = np.random.default_rng(4)
        # A 2 m x 2 m floor and a wall, sampled with 4 cm gaps like a fused scan.
        g = np.arange(0, 2, 0.04)
        X, Z = np.meshgrid(g, g)
        floor = np.c_[X.ravel(), np.zeros(X.size), Z.ravel()]
        wall = np.c_[X.ravel(), Z.ravel(), np.zeros(X.size)]
        pts = np.vstack([floor, wall]) + rng.normal(0, 0.003, (2 * X.size, 3))
        cloud = to_surfels(Cloud(pts, np.full((len(pts), 3), 200, np.uint8)), log=lambda *_: None)
        w, x, y, z = cloud.quats.T
        normal = np.stack([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)], 1)
        inner = (pts[:, 0] > 0.2) & (pts[:, 0] < 1.8)
        on_floor = inner & (np.abs(pts[:, 1]) < 0.02) & (pts[:, 2] > 0.2) & (pts[:, 2] < 1.8)
        on_wall = inner & (np.abs(pts[:, 2]) < 0.02) & (pts[:, 1] > 0.2) & (pts[:, 1] < 1.8)
        self.assertGreater(np.mean(np.abs(normal[on_floor, 1]) > 0.95), 0.95, "floor discs face up")
        self.assertGreater(np.mean(np.abs(normal[on_wall, 2]) > 0.95), 0.95, "wall discs face out of the wall")
        np.testing.assert_allclose(np.linalg.norm(cloud.quats, axis=1), 1, atol=1e-9)
        # Wide enough to close a 4 cm gap (neighbouring 2-sigma footprints overlap), thin across the surface.
        self.assertTrue(np.all(2 * cloud.scales[on_floor, 0] >= 0.04 * 0.99))
        self.assertTrue(np.all(cloud.scales[on_floor, 2] <= 0.005))


class Formats(unittest.TestCase):
    def test_nav_encoding_is_bit_exact(self):
        boxes, _ = synth.layout()
        xyz, _ = synth.sample_cloud(boxes, spacing=0.08)
        grid = build_grid(xyz, res=0.1)
        nav = encode_nav(grid)
        W, H = nav["size"]
        bits = np.unpackbits(np.frombuffer(base64.b64decode(nav["walkable"]), np.uint8), bitorder="little")[:W * H]
        np.testing.assert_array_equal(bits.reshape(H, W).astype(bool), grid.walkable)

    def test_splat_file_is_importance_sorted_so_a_prefix_is_a_valid_lod(self):
        rng = np.random.default_rng(1)
        n = 500
        quats = rng.normal(size=(n, 4))
        cloud = Cloud(rng.normal(size=(n, 3)), rng.integers(0, 255, (n, 3)).astype(np.uint8),
                      rng.uniform(0.05, 1, n), rng.uniform(0.01, 0.2, (n, 3)), quats / np.linalg.norm(quats, axis=1, keepdims=True))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.splat"
            self.assertEqual(write_splat(path, cloud), n)
            rec = np.fromfile(path, dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
            self.assertEqual(path.stat().st_size, 32 * n)
            importance = (rec["c"][:, 3] / 255) * np.prod(rec["s"], axis=1) ** (1 / 3)
            self.assertTrue(np.all(np.diff(importance) <= 0.02), "splats are not sorted by importance")

    def test_transform_keeps_splat_shapes_rigid(self):
        rng = np.random.default_rng(2)
        quats = rng.normal(size=(50, 4))
        quats /= np.linalg.norm(quats, axis=1, keepdims=True)
        cloud = Cloud(rng.normal(size=(50, 3)), np.zeros((50, 3), np.uint8), np.ones(50), np.full((50, 3), 0.1), quats)
        from navkit.align import Frame
        out = transform_cloud(cloud, Frame(rotation([0, 0, 1], 40), 2.0, np.zeros(3)))
        np.testing.assert_allclose(np.linalg.norm(out.quats, axis=1), 1, atol=1e-9)
        np.testing.assert_allclose(out.scales, 0.2)


if __name__ == "__main__":
    unittest.main()
