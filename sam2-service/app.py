# ─────────────────────────────────────────────────────────────────────────────
# sam2-service/app.py
# SAM 2 tracking sidecar.
#   S5.1  /health  — model loaded on GPU
#   S5.2  /track   — click on one frame → mask for every frame (chunked/offloaded
#                    for 4 GB VRAM). Masks saved as PNGs in <frames_dir>/masks/.
#
# Run:  uvicorn app:app --host 127.0.0.1 --port 5001
# ─────────────────────────────────────────────────────────────────────────────

import os
import glob
from contextlib import asynccontextmanager

import numpy as np
import torch
from PIL import Image
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_CFG  = os.getenv("SAM2_CONFIG",     "configs/sam2.1/sam2.1_hiera_t.yaml")
CHECKPOINT = os.getenv("SAM2_CHECKPOINT", "./checkpoints/sam2.1_hiera_tiny.pt")

STATE = {"predictor": None, "device": None, "gpu_name": None, "error": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        STATE["device"]   = device
        STATE["gpu_name"] = torch.cuda.get_device_name(0) if device == "cuda" else None
        from sam2.build_sam import build_sam2_video_predictor
        print(f"[SAM2] Loading {CHECKPOINT} on {device} …")
        STATE["predictor"] = build_sam2_video_predictor(MODEL_CFG, CHECKPOINT, device=device)
        print(f"[SAM2] Model ready on {device}"
              + (f" ({STATE['gpu_name']})" if STATE["gpu_name"] else ""))
    except Exception as e:  # noqa: BLE001
        STATE["error"] = f"{type(e).__name__}: {e}"
        print(f"[SAM2] Failed to load model: {STATE['error']}")
    yield
    STATE["predictor"] = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


app = FastAPI(title="EditFrame SAM 2 Service", lifespan=lifespan)


# ─── /health (S5.1) ───────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "ready":     STATE["predictor"] is not None,
        "gpu":       torch.cuda.is_available(),
        "device":    STATE["device"],
        "gpu_name":  STATE["gpu_name"],
        "model":     "sam2.1_hiera_tiny",
        "torch":     torch.__version__,
        "cuda":      torch.version.cuda,
        "vram_total_mb": (
            round(torch.cuda.get_device_properties(0).total_memory / 1024 / 1024)
            if torch.cuda.is_available() else None
        ),
        "error":     STATE["error"],
    }


# ─── Helpers ────────────────────────────────────────────────────────────────

def prepare_jpeg_frames(frames_dir: str):
    """
    SAM 2 only reads JPEG frames named as integers (00000.jpg …).
    Our Sprint-4 frames are frame_000000.png, so we build a cached JPEG copy in
    <frames_dir>/_sam2_jpg/. Index order matches the PNG sort order exactly, so
    SAM 2 frame index N == our frame_00000N.png.
    """
    png_files = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))
    if not png_files:
        raise HTTPException(400, f"No frame_*.png files found in {frames_dir}")

    jpeg_dir = os.path.join(frames_dir, "_sam2_jpg")
    os.makedirs(jpeg_dir, exist_ok=True)

    existing = sorted(glob.glob(os.path.join(jpeg_dir, "*.jpg")))
    if len(existing) == len(png_files):
        return jpeg_dir, len(png_files)  # cached — already converted

    for f in existing:
        os.remove(f)
    for i, p in enumerate(png_files):
        Image.open(p).convert("RGB").save(os.path.join(jpeg_dir, f"{i:05d}.jpg"), quality=95)

    return jpeg_dir, len(png_files)


def save_mask(masks_dir: str, frame_idx: int, mask_logits):
    """Threshold logits (>0) → white-on-black PNG named mask_000000.png."""
    m = (mask_logits[0] > 0.0).cpu().numpy()
    if m.ndim == 3:
        m = m[0]
    Image.fromarray((m * 255).astype(np.uint8), mode="L") \
         .save(os.path.join(masks_dir, f"mask_{frame_idx:06d}.png"))


# ─── /track (S5.2) ────────────────────────────────────────────────────────────

class TrackRequest(BaseModel):
    frames_dir: str                 # absolute path to the job's frame folder
    source_frame: int               # index of the frame the user clicked
    points: list[list[float]]       # [[x, y], ...] in ORIGINAL frame pixels
    labels: list[int]               # 1 = foreground, 0 = background
    obj_id: int = 1


class SegmentRequest(BaseModel):
    frames_dir: str
    source_frame: int
    points: list[list[float]]
    labels: list[int]
    obj_id: int = 1


@app.post("/segment")
def segment(req: SegmentRequest):
    """
    Fast single-frame preview: seed a click and return the mask for THAT frame
    only, without propagating across the video. Used so the user can confirm
    the click landed on the right object before committing to full tracking.
    """
    if STATE["predictor"] is None:
        raise HTTPException(503, f"Model not ready: {STATE['error']}")
    if not os.path.isdir(req.frames_dir):
        raise HTTPException(400, f"frames_dir does not exist: {req.frames_dir}")

    predictor = STATE["predictor"]
    device    = STATE["device"]
    jpeg_dir, total = prepare_jpeg_frames(req.frames_dir)
    if req.source_frame < 0 or req.source_frame >= total:
        raise HTTPException(400, f"source_frame {req.source_frame} out of range (0..{total-1})")

    preview_dir = os.path.join(req.frames_dir, "_preview")
    os.makedirs(preview_dir, exist_ok=True)

    autocast_dtype = torch.bfloat16 if device == "cuda" else torch.float32

    try:
        with torch.inference_mode(), torch.autocast(device_type=device, dtype=autocast_dtype):
            state = predictor.init_state(
                video_path=jpeg_dir,
                offload_video_to_cpu=True,
                offload_state_to_cpu=True,
            )
            predictor.reset_state(state)

            _frame_idx, _obj_ids, mask_logits = predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=req.source_frame,
                obj_id=req.obj_id,
                points=np.array(req.points, dtype=np.float32),
                labels=np.array(req.labels, dtype=np.int32),
            )

            out_path = os.path.join(preview_dir, f"preview_{req.source_frame:06d}.png")
            save_mask(preview_dir, req.source_frame, mask_logits)
            os.replace(
                os.path.join(preview_dir, f"mask_{req.source_frame:06d}.png"),
                out_path,
            )

    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Segmentation failed: {type(e).__name__}: {e}")
    finally:
        if device == "cuda":
            torch.cuda.empty_cache()

    return {"mask_path": out_path, "source_frame": req.source_frame}


@app.post("/track")
def track(req: TrackRequest):
    if STATE["predictor"] is None:
        raise HTTPException(503, f"Model not ready: {STATE['error']}")
    if not os.path.isdir(req.frames_dir):
        raise HTTPException(400, f"frames_dir does not exist: {req.frames_dir}")
    if len(req.points) != len(req.labels):
        raise HTTPException(400, "points and labels must be the same length")

    predictor = STATE["predictor"]
    device    = STATE["device"]

    # 1. Prepare SAM2-compatible JPEG frames (cached)
    jpeg_dir, total = prepare_jpeg_frames(req.frames_dir)
    if req.source_frame < 0 or req.source_frame >= total:
        raise HTTPException(400, f"source_frame {req.source_frame} out of range (0..{total-1})")

    # 2. Output folder for masks (sibling of frames, won't clash with frame_*.png)
    masks_dir = os.path.join(req.frames_dir, "masks")
    os.makedirs(masks_dir, exist_ok=True)
    for f in glob.glob(os.path.join(masks_dir, "mask_*.png")):
        os.remove(f)

    autocast_dtype = torch.bfloat16 if device == "cuda" else torch.float32
    tracked = set()

    try:
        with torch.inference_mode(), torch.autocast(device_type=device, dtype=autocast_dtype):
            # offload_* keeps frames + memory bank in system RAM → fits 4 GB VRAM
            state = predictor.init_state(
                video_path=jpeg_dir,
                offload_video_to_cpu=True,
                offload_state_to_cpu=True,
            )
            predictor.reset_state(state)

            predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=req.source_frame,
                obj_id=req.obj_id,
                points=np.array(req.points, dtype=np.float32),
                labels=np.array(req.labels, dtype=np.int32),
            )

            # Propagate forward from the clicked frame …
            for f_idx, _obj_ids, mask_logits in predictor.propagate_in_video(
                state, start_frame_idx=req.source_frame
            ):
                save_mask(masks_dir, f_idx, mask_logits)
                tracked.add(f_idx)

            # … and backward, to cover frames before the clicked one
            for f_idx, _obj_ids, mask_logits in predictor.propagate_in_video(
                state, start_frame_idx=req.source_frame, reverse=True
            ):
                save_mask(masks_dir, f_idx, mask_logits)
                tracked.add(f_idx)

    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        raise HTTPException(507, "GPU out of memory. Try a shorter clip or a lower fps extraction.")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Tracking failed: {type(e).__name__}: {e}")
    finally:
        if device == "cuda":
            torch.cuda.empty_cache()

    return {
        "masks_dir":      masks_dir,
        "tracked_frames": len(tracked),
        "total_frames":   total,
        "source_frame":   req.source_frame,
    }