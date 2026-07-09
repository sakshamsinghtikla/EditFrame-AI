import asyncio
from pathlib import Path
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionFactory, get_db_session
from app.models import JobStatus, JobType, ProcessingJob
from app.services.ffmpeg_service import FFmpegError, ffmpeg_service
from app.services.lama_service import lama_service
from app.services.sam2_service import sam2_service
from app.tasks.inpainting_tasks import remove_object_task
from app.tasks.sam2_tasks import segment_task, track_task
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


class SAMPromptRequest(BaseModel):
    frames_dir: Path
    source_frame: int = Field(ge=0)
    points: list[list[float]]
    labels: list[int]
    object_id: int = Field(default=1, ge=1)
    owner_id: str = "development-user"

    @model_validator(mode="after")
    def validate_prompt(self):
        if not self.points:
            raise ValueError("At least one prompt point is required")
        if len(self.points) != len(self.labels):
            raise ValueError("points and labels must have the same length")
        if any(len(point) != 2 for point in self.points):
            raise ValueError("Each point must contain exactly [x, y]")
        if any(label not in {0, 1} for label in self.labels):
            raise ValueError("labels may contain only 0 or 1")
        return self


class RemoveObjectRequest(BaseModel):
    frames_dir: Path
    masks_dir: Path
    source_video: Path
    fps: float | None = Field(default=None, gt=0, le=240)
    dilation_radius: int = Field(default=4, ge=0, le=32)
    feather_radius: float = Field(default=2.0, ge=0, le=20)
    owner_id: str = "development-user"


def existing_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {resolved}")
    return resolved


async def create_job(
    session: AsyncSession,
    owner_id: str,
    job_type: JobType,
    input_data: dict[str, object],
) -> ProcessingJob:
    job = ProcessingJob(
        owner_id=owner_id,
        job_type=job_type,
        input_data=input_data,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return job


def job_payload(job: ProcessingJob) -> dict[str, object]:
    return {
        "id": str(job.id),
        "job_type": job.job_type,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "output_data": job.output_data,
        "error_message": job.error_message,
        "elapsed_seconds": job.elapsed_seconds,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
    }


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
    job = await create_job(
        session,
        request.owner_id,
        JobType.FRAME_EXTRACTION,
        {"video_path": str(video_path), "fps": request.fps},
    )

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


@router.get("/ai/sam2/health", tags=["AI"])
async def sam2_health() -> dict[str, object]:
    return sam2_service.health()


@router.get("/ai/lama/health", tags=["AI"])
async def lama_health() -> dict[str, object]:
    return lama_service.health()


@router.post("/ai/segment", status_code=status.HTTP_202_ACCEPTED, tags=["AI"])
async def segment(
    request: SAMPromptRequest,
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    frames_dir = existing_path(request.frames_dir)
    job = await create_job(
        session,
        request.owner_id,
        JobType.SEGMENTATION,
        request.model_dump(mode="json"),
    )
    task = segment_task.delay(
        str(job.id),
        str(frames_dir),
        request.source_frame,
        request.points,
        request.labels,
        request.object_id,
    )
    job.celery_task_id = task.id
    await session.commit()
    return {"job_id": str(job.id), "status": job.status}


@router.post("/ai/track", status_code=status.HTTP_202_ACCEPTED, tags=["AI"])
async def track(
    request: SAMPromptRequest,
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    frames_dir = existing_path(request.frames_dir)
    job = await create_job(
        session,
        request.owner_id,
        JobType.TRACKING,
        request.model_dump(mode="json"),
    )
    task = track_task.delay(
        str(job.id),
        str(frames_dir),
        request.source_frame,
        request.points,
        request.labels,
        request.object_id,
    )
    job.celery_task_id = task.id
    await session.commit()
    return {"job_id": str(job.id), "status": job.status}


@router.post("/ai/remove-object", status_code=status.HTTP_202_ACCEPTED, tags=["AI"])
async def remove_object(
    request: RemoveObjectRequest,
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    frames_dir = existing_path(request.frames_dir)
    masks_dir = existing_path(request.masks_dir)
    source_video = existing_path(request.source_video)

    job = await create_job(
        session,
        request.owner_id,
        JobType.INPAINTING,
        request.model_dump(mode="json"),
    )
    task = remove_object_task.delay(
        str(job.id),
        str(frames_dir),
        str(masks_dir),
        str(source_video),
        request.fps,
        request.dilation_radius,
        request.feather_radius,
    )
    job.celery_task_id = task.id
    await session.commit()
    return {"job_id": str(job.id), "status": job.status}


@router.get("/jobs/{job_id}", tags=["jobs"])
async def get_job(
    job_id: UUID,
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    job = await session.get(ProcessingJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_payload(job)


@router.websocket("/ws/jobs/{job_id}")
async def job_updates(websocket: WebSocket, job_id: UUID) -> None:
    await websocket.accept()
    previous_signature: tuple[object, ...] | None = None

    try:
        while True:
            async with AsyncSessionFactory() as session:
                job = await session.get(ProcessingJob, job_id)

            if job is None:
                await websocket.send_json({"type": "error", "detail": "Job not found"})
                await websocket.close(code=4404)
                return

            signature = (
                job.status,
                job.stage,
                job.progress,
                job.error_message,
                str(job.output_data),
            )
            if signature != previous_signature:
                await websocket.send_json({"type": "job", **job_payload(job)})
                previous_signature = signature

            if job.status in {
                JobStatus.COMPLETED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
            }:
                await websocket.close(code=1000)
                return

            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        return
