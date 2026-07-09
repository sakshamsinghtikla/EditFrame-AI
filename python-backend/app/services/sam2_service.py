import glob
import os
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image

from app.core.config import settings

ProgressCallback = Callable[[int, str], None]


class SAM2UnavailableError(RuntimeError):
    pass


class SAM2Service:
    def __init__(self) -> None:
        self.predictor: Any | None = None
        self.torch: Any | None = None
        self.device: str | None = None
        self.gpu_name: str | None = None
        self.error: str | None = None

    def load(self) -> None:
        if self.predictor is not None:
            return

        try:
            import torch
            from sam2.build_sam import build_sam2_video_predictor

            checkpoint = settings.sam2_checkpoint.expanduser().resolve()
            if not checkpoint.is_file():
                raise FileNotFoundError(f"SAM 2 checkpoint not found: {checkpoint}")

            self.torch = torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            self.gpu_name = (
                torch.cuda.get_device_name(0) if self.device == "cuda" else None
            )
            self.predictor = build_sam2_video_predictor(
                settings.sam2_config,
                str(checkpoint),
                device=self.device,
            )
            self.error = None
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
            raise SAM2UnavailableError(self.error) from exc

    def health(self) -> dict[str, object]:
        torch_version = getattr(self.torch, "__version__", None)
        cuda_version = getattr(getattr(self.torch, "version", None), "cuda", None)
        return {
            "ready": self.predictor is not None,
            "device": self.device,
            "gpu_name": self.gpu_name,
            "model": "sam2.1_hiera_tiny",
            "config": settings.sam2_config,
            "checkpoint": str(settings.sam2_checkpoint),
            "checkpoint_exists": settings.sam2_checkpoint.expanduser().is_file(),
            "torch": torch_version,
            "cuda": cuda_version,
            "error": self.error,
        }

    @staticmethod
    def prepare_jpeg_frames(frames_dir: Path) -> tuple[Path, int]:
        png_files = sorted(frames_dir.glob("frame_*.png"))
        if not png_files:
            raise ValueError(f"No frame_*.png files found in {frames_dir}")

        jpeg_dir = frames_dir / "_sam2_jpg"
        jpeg_dir.mkdir(parents=True, exist_ok=True)
        existing = sorted(jpeg_dir.glob("*.jpg"))
        if len(existing) == len(png_files):
            return jpeg_dir, len(png_files)

        for path in existing:
            path.unlink()
        for index, png_path in enumerate(png_files):
            with Image.open(png_path) as image:
                image.convert("RGB").save(jpeg_dir / f"{index:05d}.jpg", quality=95)

        return jpeg_dir, len(png_files)

    @staticmethod
    def save_mask(output_path: Path, mask_logits: Any) -> None:
        mask = (mask_logits[0] > 0.0).cpu().numpy()
        if mask.ndim == 3:
            mask = mask[0]
        Image.fromarray((mask * 255).astype(np.uint8), mode="L").save(output_path)

    def _validate_prompt(
        self,
        frames_dir: Path,
        source_frame: int,
        points: list[list[float]],
        labels: list[int],
    ) -> tuple[Path, int]:
        if len(points) != len(labels):
            raise ValueError("points and labels must have the same length")
        if not points:
            raise ValueError("At least one foreground or background point is required")
        if any(label not in {0, 1} for label in labels):
            raise ValueError("labels must contain only 0 or 1")

        jpeg_dir, total = self.prepare_jpeg_frames(frames_dir)
        if source_frame < 0 or source_frame >= total:
            raise ValueError(f"source_frame must be between 0 and {total - 1}")
        return jpeg_dir, total

    def segment(
        self,
        frames_dir: Path,
        source_frame: int,
        points: list[list[float]],
        labels: list[int],
        object_id: int = 1,
    ) -> dict[str, object]:
        self.load()
        assert self.predictor is not None
        assert self.torch is not None
        assert self.device is not None

        jpeg_dir, _ = self._validate_prompt(frames_dir, source_frame, points, labels)
        preview_dir = frames_dir / "_preview"
        preview_dir.mkdir(parents=True, exist_ok=True)
        output_path = preview_dir / f"preview_{source_frame:06d}.png"
        autocast_dtype = (
            self.torch.bfloat16 if self.device == "cuda" else self.torch.float32
        )

        try:
            with self.torch.inference_mode(), self.torch.autocast(
                device_type=self.device,
                dtype=autocast_dtype,
            ):
                state = self.predictor.init_state(
                    video_path=str(jpeg_dir),
                    offload_video_to_cpu=settings.sam2_offload_video_to_cpu,
                    offload_state_to_cpu=settings.sam2_offload_state_to_cpu,
                )
                self.predictor.reset_state(state)
                _, _, mask_logits = self.predictor.add_new_points_or_box(
                    inference_state=state,
                    frame_idx=source_frame,
                    obj_id=object_id,
                    points=np.asarray(points, dtype=np.float32),
                    labels=np.asarray(labels, dtype=np.int32),
                )
                self.save_mask(output_path, mask_logits)
        finally:
            if self.device == "cuda":
                self.torch.cuda.empty_cache()

        return {"mask_path": str(output_path), "source_frame": source_frame}

    def track(
        self,
        frames_dir: Path,
        masks_dir: Path,
        source_frame: int,
        points: list[list[float]],
        labels: list[int],
        object_id: int = 1,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, object]:
        self.load()
        assert self.predictor is not None
        assert self.torch is not None
        assert self.device is not None

        jpeg_dir, total = self._validate_prompt(frames_dir, source_frame, points, labels)
        masks_dir.mkdir(parents=True, exist_ok=True)
        for old_mask in glob.glob(os.path.join(masks_dir, "mask_*.png")):
            os.remove(old_mask)

        autocast_dtype = (
            self.torch.bfloat16 if self.device == "cuda" else self.torch.float32
        )
        tracked: set[int] = set()

        try:
            with self.torch.inference_mode(), self.torch.autocast(
                device_type=self.device,
                dtype=autocast_dtype,
            ):
                state = self.predictor.init_state(
                    video_path=str(jpeg_dir),
                    offload_video_to_cpu=settings.sam2_offload_video_to_cpu,
                    offload_state_to_cpu=settings.sam2_offload_state_to_cpu,
                )
                self.predictor.reset_state(state)
                self.predictor.add_new_points_or_box(
                    inference_state=state,
                    frame_idx=source_frame,
                    obj_id=object_id,
                    points=np.asarray(points, dtype=np.float32),
                    labels=np.asarray(labels, dtype=np.int32),
                )

                for reverse in (False, True):
                    for frame_index, _, mask_logits in self.predictor.propagate_in_video(
                        state,
                        start_frame_idx=source_frame,
                        reverse=reverse,
                    ):
                        self.save_mask(
                            masks_dir / f"mask_{frame_index:06d}.png",
                            mask_logits,
                        )
                        tracked.add(frame_index)
                        if on_progress:
                            progress = min(99, max(1, round(len(tracked) / total * 100)))
                            on_progress(progress, "tracking")
        finally:
            if self.device == "cuda":
                self.torch.cuda.empty_cache()

        if on_progress:
            on_progress(100, "completed")

        return {
            "masks_dir": str(masks_dir),
            "tracked_frames": len(tracked),
            "total_frames": total,
            "source_frame": source_frame,
        }


sam2_service = SAM2Service()
