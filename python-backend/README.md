# EditFrame Python Backend

FastAPI backend for video frame extraction, prompt-based object segmentation, object tracking, LaMa inpainting, and audio-preserving export.

## Included

- FastAPI API
- Async SQLAlchemy processing jobs
- Redis/Celery background workers
- FFprobe metadata inspection
- FFmpeg frame extraction and reassembly
- SAM 2 preview segmentation and bidirectional tracking
- Mask dilation and feathering
- LaMa ONNX frame inpainting
- Original-audio preservation
- Persistent job progress through REST and WebSocket
- Downloadable processed-video results
- Docker Compose and GitHub Actions CI

## Start

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8000/docs`.

Model installation is documented in `SETUP_ML.md`.

## Main workflow

```text
POST /api/v1/video/extract
POST /api/v1/ai/segment
POST /api/v1/ai/track
POST /api/v1/ai/remove-object
GET  /api/v1/jobs/{job_id}
GET  /api/v1/jobs/{job_id}/result
WS   /api/v1/ws/jobs/{job_id}
```

### Remove-object request

```json
{
  "frames_dir": "/data/editframe/jobs/extraction-job/frames",
  "masks_dir": "/data/editframe/jobs/tracking-job/masks",
  "source_video": "/data/uploads/source.mp4",
  "dilation_radius": 4,
  "feather_radius": 2.0
}
```

The worker applies LaMa to frames with a corresponding `mask_XXXXXX.png`, copies frames without masks unchanged, exports at the source FPS unless overridden, and restores the original audio stream when present.

## Health endpoints

- `GET /api/v1/health`
- `GET /api/v1/video/ffmpeg/health`
- `GET /api/v1/ai/sam2/health`
- `GET /api/v1/ai/lama/health`

Local-path endpoints are temporary development interfaces. Authentication, upload ownership, and storage-key validation must be added before untrusted deployment.
