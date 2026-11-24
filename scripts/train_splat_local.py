#!/usr/bin/env python3
"""Train the hostel's photoreal Gaussian splat on a laptop/PC with an NVIDIA GPU — one command.

    conda activate nerfstudio
    python scripts/train_splat_local.py              # full quality, about 30-60 min
    python scripts/train_splat_local.py --quick      # 3,000-step smoke test, about 5 min

Setup (once) and troubleshooting: docs/TRAIN_SPLAT_LOCAL.md.

Steps: unzip datasets/hostel_posecam_nerfstudio.zip -> ns-train splatfacto (in the capture's own
metric frame, so the result lines up with the map) -> ns-eval -> ns-export -> slim the file to
what the web app uses. Result: training/hostel_splat.ply (~60 MB) and training/eval.json.
Only needs the Python standard library, numpy and Nerfstudio 1.1.5.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET_ZIP = ROOT / "datasets" / "hostel_posecam_nerfstudio.zip"
WORK = ROOT / "training"


def say(msg: str) -> None:
    print(f"\n=== {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"\nERROR: {msg}\nSee docs/TRAIN_SPLAT_LOCAL.md -> Troubleshooting.", file=sys.stderr)
    sys.exit(1)


def check_environment() -> None:
    say("Checking the environment")
    if shutil.which("ns-train") is None:
        fail("`ns-train` not found. Activate the environment first: conda activate nerfstudio")
    try:
        import torch
    except ImportError:
        fail("PyTorch is not installed in this environment.")
    if not torch.cuda.is_available():
        fail("PyTorch cannot see an NVIDIA GPU. Check `nvidia-smi` works and that the CUDA build of "
             "PyTorch is installed (torch.version.cuda should not be None).")
    props = torch.cuda.get_device_properties(0)
    vram = props.total_memory / 2**30
    print(f"GPU: {props.name}, {vram:.1f} GB  |  torch {torch.__version__}, CUDA {torch.version.cuda}")
    if vram < 5.5:
        print("Warning: under 6 GB of GPU memory; use --low-vram if training runs out of memory.")
    try:
        import gsplat  # noqa: F401
    except Exception as err:  # noqa: BLE001
        fail(f"gsplat failed to import: {err}")
    say("Compiling and testing the GPU rasteriser (several minutes the first time)")
    import gsplat
    means = torch.randn(64, 3, device="cuda") + torch.tensor([0, 0, 3.0], device="cuda")
    quats = torch.nn.functional.normalize(torch.randn(64, 4, device="cuda"), dim=-1)
    try:
        img, _, _ = gsplat.rasterization(
            means, quats, torch.full((64, 3), 0.05, device="cuda"), torch.ones(64, device="cuda"),
            torch.rand(64, 3, device="cuda"), torch.eye(4, device="cuda")[None],
            torch.tensor([[[300.0, 0, 160], [0, 300.0, 120], [0, 0, 1]]], device="cuda"), 320, 240)
    except Exception as err:  # noqa: BLE001
        fail(f"gsplat could not compile/run its CUDA code: {err}\n"
             "On Windows run this from a terminal where vcvars64.bat has been called (see the guide).")
    print("gsplat OK:", tuple(img.shape))


def prepare_dataset() -> Path:
    data = WORK / "hostel_posecam_nerfstudio"
    if (data / "transforms.json").exists():
        return data
    if not DATASET_ZIP.exists():
        fail(f"{DATASET_ZIP} is missing. Clone the full repository (git clone, not a ZIP of the code only).")
    say("Unpacking the dataset")
    WORK.mkdir(exist_ok=True)
    with zipfile.ZipFile(DATASET_ZIP) as z:
        z.extractall(WORK)
    print(len(list((data / "images").iterdir())), "frames")
    return data


def run(cmd: list[str], log_path: Path, show) -> int:
    print("$", " ".join(cmd), flush=True)
    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace")
        for line in proc.stdout:
            log.write(line)
            if show(line):
                print(line.rstrip()[-150:], flush=True)
        return proc.wait()


def slim_splat(src: Path, dst: Path) -> int:
    """Keep what the web app uses (position, base colour, opacity, scale, rotation): ~4x smaller."""
    import numpy as np
    with open(src, "rb") as fh:
        header = b""
        while not header.endswith(b"end_header\n"):
            header += fh.readline()
        text = header.decode()
        n = int(re.search(r"element vertex (\d+)", text).group(1))
        props = re.findall(r"property float (\w+)", text)
        data = np.frombuffer(fh.read(n * 4 * len(props)), "<f4").reshape(n, len(props))
    keep = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3"]
    head = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n
    head += "".join(f"property float {k}\n" for k in keep) + "end_header\n"
    with open(dst, "wb") as fh:
        fh.write(head.encode())
        fh.write(np.ascontiguousarray(data[:, [props.index(k) for k in keep]], "<f4").tobytes())
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="3,000 steps to check everything works (~5 min)")
    ap.add_argument("--iterations", type=int, default=30_000)
    ap.add_argument("--low-vram", action="store_true", help="keep training images in CPU memory (6 GB GPUs)")
    ap.add_argument("--skip-checks", action="store_true")
    args = ap.parse_args()
    steps = 3_000 if args.quick else args.iterations

    if not args.skip_checks:
        check_environment()
    data = prepare_dataset()
    out_dir = WORK / "outputs"

    say(f"Training splatfacto for {steps:,} steps (keep the laptop plugged in and awake)")
    cmd = ["ns-train", "splatfacto", "--data", str(data), "--output-dir", str(out_dir),
           "--experiment-name", "hostel", "--max-num-iterations", str(steps), "--vis", "tensorboard",
           "--viewer.quit-on-train-completion", "True"]
    if args.low_vram:
        cmd += ["--pipeline.datamanager.cache-images", "cpu"]
    # These four keep PoseCam's metric, gravity-aligned frame (and load the start cloud as-is).
    cmd += ["nerfstudio-data", "--orientation-method", "none", "--center-method", "none",
            "--auto-scale-poses", "False", "--load-3D-points", "True"]
    t0 = time.time()
    code = run(cmd, WORK / "train.log", lambda l: "Step" in l or "%" in l or "rror" in l or "Saving" in l)
    ckpts = sorted(glob.glob(str(out_dir / "hostel" / "splatfacto" / "*" / "nerfstudio_models" / "*.ckpt")),
                   key=os.path.getmtime)
    if code != 0 or not ckpts:
        print((WORK / "train.log").read_text(encoding="utf-8", errors="replace")[-3000:])
        fail("training did not finish (log above, full log in training/train.log). "
             "Out of memory? Try --low-vram.")
    config = Path(ckpts[-1]).parent.parent / "config.yml"
    print(f"Trained in {(time.time() - t0) / 60:.0f} min: {ckpts[-1]}")

    say("Measuring quality on held-out photos")
    eval_path = WORK / "eval.json"
    if run(["ns-eval", "--load-config", str(config), "--output-path", str(eval_path)],
           WORK / "eval.log", lambda l: "rror" in l) == 0:
        res = json.loads(eval_path.read_text())["results"]
        print({k: round(v, 3) for k, v in res.items() if not k.endswith("_std")})
    else:
        print("Evaluation failed (see training/eval.log); continuing with the export.")

    say("Exporting the splat")
    export = WORK / "export"
    if run(["ns-export", "gaussian-splat", "--load-config", str(config), "--output-dir", str(export)],
           WORK / "export.log", lambda l: "rror" in l) != 0:
        fail("export failed (see training/export.log)")
    n = slim_splat(export / "splat.ply", WORK / "hostel_splat.ply")
    shutil.copy(config.parent / "dataparser_transforms.json", WORK / "dataparser_transforms.json")

    size = (WORK / "hostel_splat.ply").stat().st_size / 1e6
    say(f"Done: {n:,} gaussians -> {WORK / 'hostel_splat.ply'} ({size:.0f} MB)")
    print("Upload training/hostel_splat.ply (and training/eval.json) to Google Drive and share the link.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
