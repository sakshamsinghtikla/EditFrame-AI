from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db_session
from app.models import JobType, ProcessingJob
from app.services.ffmpeg_service import FFmpegError, ffmpeg_service
from app.tasks.video_tasks import extract_frames_task

router = APIRouter()


class MetadataRequest(BaseModel):
    video_path: Path


class ExtractionRequest(BaseModel):
    video_path: Path
    owner_id: str = "development-user"
    fps: float | None = Field(default=None, gt=0, le=240)


class ReassembleRequest(BaseModel):
    frames_dir: Path
    output_path: Path
    fps: float = Field(gt=0, le=240)
    audio_source: Path | None = None


def existing_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {resolved}")
    return resolved


@router.get("/health", tags=["health"])
async def health() -> dict[str, object]:
    return {"status": "ok", "ffmpeg": ffmpeg_service.check_binaries()}


@router.get("/video/ffmpeg/health", tags=["video"])
async def ffmpeg_health() -> dict[str, object]:
    return ffmpeg_service.check_binaries()


@router.post("/video/metadata", tags=["video"])
async def metadata(request: MetadataRequest) -> dict[str, object]:
    try:
        return ffmpeg_service.probe(existing_path(request.video_path)).to_dict()
    except (FFmpegError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/video/extract", status_code=status.HTTP_202_ACCEPTED, tags=["video"])
async def extract(
    request: ExtractionRequest,
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    video_path = existing_path(request.video_path)
    job = ProcessingJob(
        owner_id=request.owner_id,
        job_type=JobType.FRAME_EXTRACTION,
        input_data={"video_path": str(video_path), "fps": request.fps},
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    task = extract_frames_task.delay(str(job.id), str(video_path), request.fps)
    job.celery_task_id = task.id
    await session.commit()

    return {"job_id": str(job.id), "status": job.status}


@router.post("/video/reassemble", tags=["video"])
async def reassemble(request: ReassembleRequest) -> dict[str, str]:
    try:
        output = ffmpeg_service.reassemble(
            existing_path(request.frames_dir),
            request.output_path,
            request.fps,
            existing_path(request.audio_source) if request.audio_source else None,
        )
    except (FFmpegError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"output_path": str(output)}


@router.get("/jobs/{job_id}", tags=["jobs"])
async def get_job(
    job_id: UUID,
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    job = await session.get(ProcessingJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "id": str(job.id),
        "job_type": job.job_type,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "output_data": job.output_data,
        "error_message": job.error_message,
    }
