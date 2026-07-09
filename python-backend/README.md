# EditFrame Python Backend — Phase 1

Runnable FastAPI foundation for replacing the Node.js backend while keeping the current React/Vite frontend intact during migration.

## Included

- FastAPI API
- Async SQLAlchemy database layer
- Persistent media and processing jobs
- Redis/Celery background workers
- FFprobe metadata inspection
- FFmpeg frame extraction and audio-preserving reassembly
- Docker Compose
- SAM 2 and video-inpainting integration boundaries

## Start

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8000/docs`.

## Current endpoints

- `GET /`
- `GET /api/v1/health`
- `GET /api/v1/video/ffmpeg/health`
- `POST /api/v1/video/metadata`
- `POST /api/v1/video/extract`
- `POST /api/v1/video/reassemble`
- `GET /api/v1/jobs/{job_id}`
- `WS /api/v1/ws/jobs/{job_id}`

Phase 2 will port authentication/media upload and integrate SAM 2. Phase 3 will add mask processing and video inpainting.