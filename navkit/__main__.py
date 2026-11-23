"""Command line: ``python -m navkit build app/scenes/<id>`` (or ``build --all``)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .build import build_scene

SCENES_ROOT = Path(__file__).resolve().parent.parent / "app" / "scenes"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="navkit", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="generate nav.json, floorplan and web visuals for a scene")
    build.add_argument("scenes", nargs="*", type=Path, help="scene folders containing scene.json")
    build.add_argument("--all", action="store_true", help=f"build every scene under {SCENES_ROOT}")
    synth = sub.add_parser("synth", help="generate the synthetic ground-truth office capture")
    synth.add_argument("scene", type=Path, nargs="?", default=SCENES_ROOT / "office")
    pc = sub.add_parser("posecam", help="PoseCam session -> metric point cloud + walked path (CPU only)")
    pc.add_argument("session", type=Path, help="raw PoseCam session folder (frames/, poses.csv, intrinsics.json)")
    pc.add_argument("scene", type=Path, help="scene folder to write source.ply and trajectory.json into")
    pc.add_argument("--stride", type=int, default=8, help="use every Nth frame (default 8 = ~4 per second)")
    pc.add_argument("--max-depth", type=float, default=5.0, help="ignore depth beyond this many metres")
    ns = sub.add_parser("nerfstudio", help="PoseCam session -> Nerfstudio dataset for GPU splat training")
    ns.add_argument("session", type=Path)
    ns.add_argument("dataset", type=Path, help="output folder (images/, transforms.json, sparse_pc.ply)")
    ns.add_argument("--scene", type=Path, required=True, help="scene built from this session with `navkit posecam`")
    ns.add_argument("--stride", type=int, default=4)
    args = parser.parse_args(argv)

    if args.command == "nerfstudio":
        from .nerfstudio import export_dataset
        export_dataset(args.session, args.dataset, stride=args.stride, scene_dir=args.scene)
        return 0

    if args.command == "posecam":
        from .posecam import build as build_posecam
        build_posecam(args.session, args.scene, stride=args.stride, max_depth=args.max_depth)
        return 0

    if args.command == "synth":
        from .synth import write_scene
        write_scene(args.scene)
        return 0

    scenes = list(args.scenes)
    if args.all:
        scenes += sorted(p.parent for p in SCENES_ROOT.glob("*/scene.json"))
    if not scenes:
        parser.error("give at least one scene folder or --all")
    for scene in scenes:
        build_scene(scene)
    return 0


if __name__ == "__main__":
    sys.exit(main())
