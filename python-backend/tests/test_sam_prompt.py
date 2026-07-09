import pytest
from pydantic import ValidationError

from app.api.routes import SAMPromptRequest


def test_valid_positive_and_negative_points() -> None:
    request = SAMPromptRequest(
        frames_dir="/tmp/frames",
        source_frame=4,
        points=[[100.0, 80.0], [120.0, 90.0]],
        labels=[1, 0],
    )
    assert request.labels == [1, 0]


def test_points_and_labels_must_match() -> None:
    with pytest.raises(ValidationError):
        SAMPromptRequest(
            frames_dir="/tmp/frames",
            source_frame=0,
            points=[[10.0, 20.0]],
            labels=[1, 0],
        )


def test_labels_are_binary() -> None:
    with pytest.raises(ValidationError):
        SAMPromptRequest(
            frames_dir="/tmp/frames",
            source_frame=0,
            points=[[10.0, 20.0]],
            labels=[2],
        )
