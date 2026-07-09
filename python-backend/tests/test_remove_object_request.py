import pytest
from pydantic import ValidationError

from app.api.routes import RemoveObjectRequest


def test_remove_object_defaults() -> None:
    request = RemoveObjectRequest(
        frames_dir="/tmp/frames",
        masks_dir="/tmp/masks",
        source_video="/tmp/source.mp4",
    )

    assert request.dilation_radius == 4
    assert request.feather_radius == 2.0
    assert request.fps is None


def test_remove_object_rejects_invalid_mask_options() -> None:
    with pytest.raises(ValidationError):
        RemoveObjectRequest(
            frames_dir="/tmp/frames",
            masks_dir="/tmp/masks",
            source_video="/tmp/source.mp4",
            dilation_radius=33,
        )

    with pytest.raises(ValidationError):
        RemoveObjectRequest(
            frames_dir="/tmp/frames",
            masks_dir="/tmp/masks",
            source_video="/tmp/source.mp4",
            feather_radius=-1,
        )
