from pathlib import Path

from PIL import Image, ImageFilter


class MaskService:
    @staticmethod
    def prepare(
        mask_path: Path,
        target_size: tuple[int, int],
        dilation_radius: int = 4,
        feather_radius: float = 2.0,
    ) -> tuple[Image.Image, Image.Image]:
        with Image.open(mask_path) as source:
            mask = source.convert("L").resize(target_size, Image.Resampling.NEAREST)

        binary = mask.point(lambda value: 255 if value >= 128 else 0)
        if dilation_radius > 0:
            kernel = dilation_radius * 2 + 1
            binary = binary.filter(ImageFilter.MaxFilter(kernel))

        blend = binary
        if feather_radius > 0:
            blend = blend.filter(ImageFilter.GaussianBlur(feather_radius))

        return binary, blend


mask_service = MaskService()
