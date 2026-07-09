from app.services.ffmpeg_service import parse_fraction


def test_parse_fraction() -> None:
    assert parse_fraction("30/1") == 30.0
    assert parse_fraction("30000/1001") == 30000 / 1001
    assert parse_fraction("0/0", 24.0) == 24.0
    assert parse_fraction(None, 25.0) == 25.0
