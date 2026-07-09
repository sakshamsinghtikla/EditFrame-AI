from pathlib import Path

from PIL import Image

from app.services.mask_service import mask_service


def test_empty_mask_remains_empty(tmp_path: Path) -> None:
    path = tmp_path / "mask.png"
    Image.new("L", (16, 16), 0).save(path)

    binary, blend = mask_service.prepare(path, (16, 16), dilation_radius=3, feather_radius=2)

    assert binary.getbbox() is None
    assert blend.getbbox() is None


def test_dilation_expands_mask(tmp_path: Path) -> None:
    path = tmp_path / "mask.png"
    mask = Image.new("L", (21, 21), 0)
    mask.putpixel((10, 10), 255)
    mask.save(path)

    binary, _ = mask_service.prepare(path, (21, 21), dilation_radius=2, feather_radius=0)

    assert binary.getbbox() == (8, 8, 13, 13)


def test_feathering_creates_soft_edge(tmp_path: Path) -> None:
    path = tmp_path / "mask.png"
    mask = Image.new("L", (21, 21), 0)
    for x in range(8, 13):
        for y in range(8, 13):
            mask.putpixel((x, y), 255)
    mask.save(path)

    binary, blend = mask_service.prepare(path, (21, 21), dilation_radius=0, feather_radius=2)

    assert binary.getpixel((10, 10)) == 255
    assert 0 < blend.getpixel((6, 10)) < 255
