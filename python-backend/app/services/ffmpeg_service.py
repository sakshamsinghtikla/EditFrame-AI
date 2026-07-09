import json
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.core.config import settings


class FFmpegError(RuntimeError):
    pass


@dataclass(frozen=True)
class VideoMetadataResult:
    duration_seconds: float
    fps: float
    width: int
    height: int
    codec: str
    frame_count: int
    has_audio: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_fraction(value: str | None, fallback: float = 0.0) -> float:
    if not value or value in {"0/0", "N/A"}:
        return fallback
    if "/" not in value:
        return float(value)
    numerator, denominator = value.split("/", 1)
    return fallback if float(denominator) == 0 else float(numerator) / float(denominator)


class FFmpegService:
    def check_binaries(self) -> dict[str, Any]:
        ffmpeg_path = shutil.which(settings.ffmpeg_bin)
        ffprobe_path = shutil.which(settings.ffprobe_bin)
        return {
            "ready": bool(ffmpeg_path and ffprobe_path),
            "ffmpeg": ffmpeg_path,
            "ffprobe": ffprobe_path,
        }

    def probe(self, video_path: Path) -> VideoMetadataResult:
        video_path = video_path.expanduser().resolve()
        if not video_path.is_file():
            raise FileNotFoundError(f"Video not found: {video_path}")

        result = subprocess.run(
            [settings.ffprobe_bin, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video_path)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise FFmpegError(result.stderr.strip() or "ffprobe failed")

        payload = json.loads(result.stdout)
        streams = payload.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if video is None:
            raise FFmpegError("No video stream found")

        fps = parse_fraction(video.get("avg_frame_rate") or video.get("r_frame_rate"), 30.0)
        duration = float(payload.get("format", {}).get("duration") or video.get("duration") or 0.0)
        raw_count = video.get("nb_frames")
        frame_count = int(raw_count) if raw_count and raw_count != "N/A" else max(1, round(duration * fps))

        return VideoMetadataResult(
            duration_seconds=duration,
            fps=round(fps, 6),
            width=int(video["width"]),
            height=int(video["height"]),
            codec=str(video.get("codec_name") or "unknown"),
            frame_count=frame_count,
            has_audio=any(s.get("codec_type") == "audio" for s in streams),
        )

    def extract_frames(self, video_path: Path, frames_dir: Path, fps: float | None = None) -> dict[str, Any]:
        metadata = self.probe(video_path)
        target_fps = fps or metadata.fps
        frames_dir.mkdir(parents=True, exist_ok=True)

        result = subprocess.run(
            [
                settings.ffmpeg_bin,
                "-hide_banner",
                "-y",
                "-i",
                str(video_path.resolve()),
                "-vf",
                f"fps={target_fps}",
                "-start_number",
                "0",
                str(frames_dir / "frame_%06d.png"),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise FFmpegError(result.stderr.strip() or "Frame extraction failed")

        frame_count = len(list(frames_dir.glob("frame_*.png")))
        if frame_count == 0:
            raise FFmpegError("FFmpeg produced no frames")

        return {
            "frames_dir": str(frames_dir),
            "frame_count": frame_count,
            "fps": target_fps,
            "source_metadata": metadata.to_dict(),
        }

    def reassemble(self, frames_dir: Path, output_path: Path, fps: float, audio_source: Path | None = None) -> Path:
        output_path = output_path.expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)

        command = [
            settings.ffmpeg_bin,
            "-hide_banner",
            "-y",
            "-framerate",
            str(fps),
            "-start_number",
            "0",
            "-i",
            str(frames_dir.resolve() / "frame_%06d.png"),
        ]
        if audio_source is not None:
            command.extend(["-i", str(audio_source.resolve()), "-map", "0:v:0", "-map", "1:a:0?"])
        command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps)])
        if audio_source is not None:
            command.extend(["-c:a", "aac", "-shortest"])
        command.append(str(output_path))

        result = subprocess.run(command, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            raise FFmpegError(result.stderr.strip() or "Video reassembly failed")
        return output_path


ffmpeg_service = FFmpegService()
