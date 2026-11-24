# Train the hostel's photoreal splat on your own laptop

This turns the hostel PoseCam capture into a **photoreal Gaussian splat** (the kind of detail the
home/kitchen scene has). It runs on your NVIDIA GPU: about **30–60 minutes** of training after a
one-time setup of roughly 30 minutes. At the end you send one file, `hostel_splat.ply` (≈ 60 MB).

Everything you need is in this repository: the prepared dataset
(`datasets/hostel_posecam_nerfstudio.zip`, 1,376 frames with ARCore camera poses — no COLMAP step)
and the script `scripts/train_splat_local.py`, which does the whole job in one command.

## 1. Check your laptop

| Need | How to check |
|---|---|
| **NVIDIA GPU, 6 GB+ memory** (8 GB+ is comfortable) | `nvidia-smi` in a terminal shows the GPU and driver. |
| Windows 10/11 or Linux | A Mac will **not** work — the trainer needs NVIDIA CUDA. |
| ~15 GB free disk, laptop **plugged in** | Training is heavy; battery mode throttles the GPU. |

## 2. One-time setup

Uses the versions Nerfstudio's own installation guide recommends (Torch 2.1.2 + CUDA 11.8).

**Windows only, first:** install **Git** and **Visual Studio 2022 Build Tools** with the
**"Desktop development with C++"** workload (needed once to compile the GPU rasteriser).
If compilation later fails with MSVC 14.4x, also add the "MSVC v142 (VS 2019) build tools" component.

**Everyone:** install [Miniconda](https://docs.conda.io/en/latest/miniconda.html), then open
*Anaconda Prompt* (Windows) or a terminal (Linux) and run, one line at a time:

```bash
conda create --name nerfstudio -y python=3.10
```

```bash
conda activate nerfstudio
```

```bash
python -m pip install --upgrade pip
```

```bash
pip install torch==2.1.2+cu118 torchvision==0.16.2+cu118 --extra-index-url https://download.pytorch.org/whl/cu118
```

```bash
conda install -y -c "nvidia/label/cuda-11.8.0" cuda-toolkit
```

```bash
pip install nerfstudio==1.1.5 "numpy<2"
```

`tiny-cuda-nn` from the Nerfstudio guide is **not** needed — it is for other methods, not splatfacto.

Get the repository (it includes the 45 MB dataset):

```bash
git clone https://github.com/atharv-namdeo/3d-mapping.git
```

## 3. Train

**Windows only:** in the same Anaconda Prompt, activate the C++ compiler first (every new window,
before the first run):

```bat
"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
```

Then, on any system:

```bash
cd 3d-mapping
```

```bash
python scripts/train_splat_local.py --quick
```

`--quick` is a 5-minute test (3,000 steps). The first run also compiles the GPU code for several
minutes — that is normal. If it ends with **Done**, run the real training:

```bash
python scripts/train_splat_local.py
```

The script checks the GPU, unpacks the dataset into `training/`, trains 30,000 steps, measures the
quality on 137 held-out photos (PSNR; above ~22 dB is good for these 640×480 frames), exports the
splat and slims it to what the web app uses.

## 4. Send the result

Upload **`training/hostel_splat.ply`** (≈ 60 MB) and `training/eval.json` to Google Drive, share as
*Anyone with the link*, and send the link. It is then imported with:

```bash
python -m navkit build app/scenes/hostel   # with "view": {"splatSource": "trained_splat.ply"}
```

No alignment work is needed: training keeps PoseCam's metric, gravity-aligned frame, so the splat
lands exactly on the hostel's map, labels and routes.

## Troubleshooting

| Message | Fix |
|---|---|
| `ns-train not found` | `conda activate nerfstudio` in this terminal. |
| `PyTorch cannot see an NVIDIA GPU` | `nvidia-smi` must work (update the NVIDIA driver). Then `python -c "import torch; print(torch.version.cuda)"` must print `11.8`; if it prints `None`, repeat the `pip install torch==2.1.2+cu118 …` line. |
| `gsplat could not compile` (Windows) | Run `vcvars64.bat` (step 3) in this same window first. If it still fails, install the MSVC v142 component and run `vcvarsall.bat x64 -vcvars_ver=14.29` from the same folder instead. |
| `gsplat could not compile` (Linux) | `conda install -y -c "nvidia/label/cuda-11.8.0" cuda-toolkit` again, then retry. |
| `CUDA out of memory` | Close other GPU apps and run `python scripts/train_splat_local.py --low-vram`. Still failing: add `--iterations 15000`. |
| NumPy errors such as `_ARRAY_API not found` | `pip install "numpy<2"`. |
| Anything else | Send the last 30 lines of `training/train.log`. |

The script never deletes your files; `training/` can be removed afterwards (it is ignored by Git).
