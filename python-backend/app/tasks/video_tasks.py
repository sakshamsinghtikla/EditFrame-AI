import asyncio
import time
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
    started = time.monotonic()
    asyncio.run(
        update_job(
            parsed_job_id,
            status=JobStatus.RUNNING,
            stage="probing",
            progress=1,
            error_message=None,
        )
    )

    try:
        def on_progress(progress: int, stage: str) -> None:
            self.update_state(
                state="PROGRESS",
                meta={"job_id": job_id, "progress": progress, "stage": stage},
            )
            asyncio.run(
                update_job(
                    parsed_job_id,
                    status=JobStatus.RUNNING,
                    stage=stage,
                    progress=progress,
                )
            )

        result = ffmpeg_service.extract_frames(
            Path(video_path),
            storage.frames_directory(parsed_job_id),
            fps=fps,
            on_progress=on_progress,
        )
        asyncio.run(
            update_job(
                parsed_job_id,
                status=JobStatus.COMPLETED,
                stage="completed",
                progress=100,
                output_data=result,
                elapsed_seconds=time.monotonic() - started,
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
                elapsed_seconds=time.monotonic() - started,
            )
        )
        raise
