# SAM 2 Service — Setup (S5.1)

A small Python (FastAPI) service that runs Meta's **SAM 2.1 Tiny** for video object tracking on your GPU. Your Node backend calls it over HTTP; it never touches your database or files directly.

> Your machine: **RTX 3050 Laptop, 4 GB VRAM, CUDA 12.7 driver.** These steps target that. SAM 2.1 **Tiny** + chunked processing is chosen deliberately for 4 GB.

---

## 1. Prerequisites

- **Python 3.10 or higher** — check with `python --version`
- Your NVIDIA driver is already installed (confirmed: driver 566.07, CUDA 12.7)

---

## 2. Create an isolated Python environment

From the `sam2-service/` folder:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

You should see `(.venv)` at the start of your prompt. **Do all the following steps with the venv activated.**

> If PowerShell blocks the activate script, run once:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

---

## 3. Install PyTorch with CUDA

SAM 2 needs `torch>=2.5.1`. Install the CUDA build (not the CPU build). For your CUDA 12.7 driver, the CUDA 12.4 wheels are compatible:

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
```

> **Verify the exact command at https://pytorch.org/** (pick Stable · Windows · Pip · CUDA 12.4). These commands change over time.

**Confirm PyTorch sees your GPU:**

```powershell
python -c "import torch; print('cuda:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
```

Expected: `cuda: True NVIDIA GeForce RTX 3050 Laptop GPU`. If it says `False`, the CUDA wheel didn't install correctly — reinstall using the pytorch.org command.

---

## 4. Install SAM 2

Clone the official repo somewhere (e.g. inside `sam2-service/`) and install it into the venv:

```powershell
git clone https://github.com/facebookresearch/sam2.git
cd sam2
```

**On Windows, skip the custom CUDA kernel build** (it needs Visual Studio build tools and commonly fails — and it's optional, only affects minor mask post-processing):

```powershell
$env:SAM2_BUILD_CUDA=0
pip install -e .
cd ..
```

> If you later want the post-processing kernel, install VS Build Tools + CUDA Toolkit and reinstall without `SAM2_BUILD_CUDA=0`. Not needed to get tracking working.

---

## 5. Download the SAM 2.1 Tiny checkpoint

```powershell
mkdir checkpoints
curl -L -o checkpoints/sam2.1_hiera_tiny.pt "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
```

This is ~150 MB. It is **not** committed to Git (add `checkpoints/` and `*.pt` to `.gitignore`).

---

## 6. Install the service dependencies

```powershell
pip install -r requirements.txt
```

---

## 7. Run the service

```powershell
uvicorn app:app --host 127.0.0.1 --port 5001
```

You should see `[SAM2] Model ready on cuda (NVIDIA GeForce RTX 3050 Laptop GPU)`.

---

## 8. Verify it works

In another terminal:

```powershell
curl http://127.0.0.1:5001/health
```

Expected response:

```json
{
  "ready": true,
  "gpu": true,
  "device": "cuda",
  "gpu_name": "NVIDIA GeForce RTX 3050 Laptop GPU",
  "model": "sam2.1_hiera_tiny",
  "torch": "2.5.1+cu124",
  "cuda": "12.4",
  "vram_total_mb": 4096,
  "error": null
}
```

If `ready: true` and `gpu: true`, **S5.1 is done** — the SAM 2 service is running on your GPU.

---

## Troubleshooting

- **`ready: false` with an `error` mentioning the config** — the Hydra config path can vary by SAM 2 version. Try setting `SAM2_CONFIG` to `sam2.1_hiera_t.yaml` (without the `configs/sam2.1/` prefix) before launching:
  `$env:SAM2_CONFIG="sam2.1_hiera_t.yaml"`
- **`gpu: false`** — PyTorch installed the CPU build. Reinstall torch with the CUDA index-url from step 3.
- **CUDA out of memory at load** — unlikely for Tiny, but close other GPU apps. The 4 GB budget is managed by chunking in S5.2.
- **`Failed to build the SAM 2 CUDA extension`** during install — this is fine, ignore it (you used `SAM2_BUILD_CUDA=0`). Tracking still works.