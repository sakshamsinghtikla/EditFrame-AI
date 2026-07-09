import asyncio
from pathlib import Path
from uuid import UUID

from app.db import AsyncSessionFactory
from app.models import JobStatus, ProcessingJob
from app.services.ffmpeg_service import ffmpeg_service
from app.services.storage import storage
from app.tasks.celery_app import celery_app


async def update_job(job_id: UUID, **values: object) -> None:
    async with AsyncSessionFactory() as session:
        job = await session.get(ProcessingJob, job_id)
        if job is None:
            raise LookupError(f"Job {job_id} not found")
        for key, value in values.items():
            setattr(job, key, value)
        await session.commit()


@celery_app.task(bind=True, name="video.extract_frames")
def extract_frames_task(self, job_id: str, video_path: str, fps: float | None = None):
    parsed_job_id = UUID(job_id)
    asyncio.run(update_job(parsed_job_id, status=JobStatus.RUNNING, stage="extracting", progress=5))

    try:
        result = ffmpeg_service.extract_frames(
            Path(video_path),
            storage.frames_directory(parsed_job_id),
            fps=fps,
        )
        asyncio.run(
            update_job(
                parsed_job_id,
                status=JobStatus.COMPLETED,
                stage="completed",
                progress=100,
                output_data=result,
            )
        )
        return result
    except Exception as exc:
        asyncio.run(
            update_job(
                parsed_job_id,
                status=JobStatus.FAILED,
                stage="failed",
                error_message=str(exc),
            )
        )
        raise
