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
    args = parser.parse_args(argv)

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
