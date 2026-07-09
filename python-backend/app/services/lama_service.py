from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from app.core.config import settings
from app.services.mask_service import mask_service


class LaMaUnavailableError(RuntimeError):
    pass


class LaMaService:
    def __init__(self) -> None:
        self.session: Any | None = None
        self.input_names: list[str] = []
        self.output_name: str | None = None
        self.error: str | None = None

    def load(self) -> None:
        if self.session is not None:
            return

        checkpoint = settings.lama_checkpoint.expanduser().resolve()
        if not checkpoint.is_file():
            self.error = f"LaMa checkpoint not found: {checkpoint}"
            raise LaMaUnavailableError(self.error)

        try:
            import onnxruntime as ort

            providers = [settings.lama_execution_provider]
            self.session = ort.InferenceSession(str(checkpoint), providers=providers)
            self.input_names = [item.name for item in self.session.get_inputs()]
            self.output_name = self.session.get_outputs()[0].name
            if len(self.input_names) < 2:
                raise RuntimeError("LaMa model must expose image and mask inputs")
            self.error = None
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
            self.session = None
            raise LaMaUnavailableError(self.error) from exc

    def health(self) -> dict[str, object]:
        checkpoint = settings.lama_checkpoint.expanduser().resolve()
        return {
            "ready": self.session is not None,
            "model": "lama_fp32.onnx",
            "checkpoint": str(checkpoint),
            "checkpoint_exists": checkpoint.is_file(),
            "provider": settings.lama_execution_provider,
            "model_size": settings.lama_model_size,
            "error": self.error,
        }

    def inpaint_frame(
        self,
        frame_path: Path,
        mask_path: Path,
        output_path: Path,
        dilation_radius: int = 4,
        feather_radius: float = 2.0,
    ) -> Path:
        self.load()
        assert self.session is not None
        assert self.output_name is not None

        with Image.open(frame_path) as source:
            original = source.convert("RGB")

        original_size = original.size
        inference_mask, blend_mask = mask_service.prepare(
            mask_path,
            original_size,
            dilation_radius=dilation_radius,
            feather_radius=feather_radius,
        )

        if inference_mask.getbbox() is None:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            original.save(output_path, format="PNG")
            return output_path

        model_size = settings.lama_model_size
        resized_image = original.resize((model_size, model_size), Image.Resampling.BILINEAR)
        resized_mask = inference_mask.resize(
            (model_size, model_size),
            Image.Resampling.NEAREST,
        )

        image_array = np.asarray(resized_image, dtype=np.float32) / 255.0
        image_tensor = np.transpose(image_array, (2, 0, 1))[None, ...]
        mask_array = np.asarray(resized_mask, dtype=np.float32) / 255.0
        mask_tensor = (mask_array >= 0.5).astype(np.float32)[None, None, ...]

        feeds = {
            self.input_names[0]: image_tensor,
            self.input_names[1]: mask_tensor,
        }
        output = self.session.run([self.output_name], feeds)[0]
        output_array = np.asarray(output, dtype=np.float32)

        if output_array.ndim != 4 or output_array.shape[1] != 3:
            raise RuntimeError(f"Unexpected LaMa output shape: {output_array.shape}")

        output_array = output_array[0]
        sampled_max = float(np.max(output_array))
        if sampled_max <= 1.5:
            output_array *= 255.0

        output_array = np.clip(output_array, 0, 255).astype(np.uint8)
        output_image = Image.fromarray(np.transpose(output_array, (1, 2, 0)), mode="RGB")
        output_image = output_image.resize(original_size, Image.Resampling.BILINEAR)

        blended = Image.composite(output_image, original, blend_mask)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        blended.save(output_path, format="PNG")
        return output_path


lama_service = LaMaService()
