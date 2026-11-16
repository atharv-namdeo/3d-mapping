#!/usr/bin/env python3
"""Fetch the raw Gaussian-splat export behind the "home" scene.

The trained splat (256 MB) is too large for this repository. It is published in
chunks by the team's training repository (BENi-Aditya/Namma-Space); this script
reassembles it and verifies the checksum, so `python -m navkit build app/scenes/home`
can be reproduced from scratch.

    git clone --depth 1 https://github.com/BENi-Aditya/Namma-Space ../Namma-Space
    python scripts/fetch_home_splat.py ../Namma-Space
"""
import gzip
import hashlib
import json
import sys
from pathlib import Path

ASSET = "models/kitchen_30k/splat.ply"
TARGET = Path(__file__).resolve().parent.parent / "data" / "sources" / "kitchen_30k.ply"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    assets = Path(sys.argv[1]) / "deployment" / "assets"
    entry = json.loads((assets / "index.json").read_text())["assets"][ASSET]
    blob = b"".join((assets / "chunks" / name).read_bytes() for name in entry["chunks"])
    if blob[:2] == b"\x1f\x8b":
        blob = gzip.decompress(blob)
    digest = hashlib.sha256(blob).hexdigest()
    if digest != entry["sha256"] or len(blob) != entry["bytes"]:
        print(f"checksum mismatch: got {digest}, expected {entry['sha256']}")
        return 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_bytes(blob)
    print(f"wrote {TARGET} ({len(blob) / 1e6:.0f} MB, sha256 ok)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
