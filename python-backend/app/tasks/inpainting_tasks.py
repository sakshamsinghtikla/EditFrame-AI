import asyncio
import shutil
import time
from pathlib import Path
from uuid import UUID

from app.db import AsyncSessionFactory
from app.models import JobStatus, ProcessingJob
from app.services.ffmpeg_service import ffmpeg_service
from app.services.lama_service import lama_service
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


@celery_app.task(bind=True, name="inpainting.remove_object")
def remove_object_task(
    self,
    job_id: str,
    frames_dir: str,
    masks_dir: str,
    source_video: str,
    fps: float | None = None,
    dilation_radius: int = 4,
    feather_radius: float = 2.0,
):
    parsed_job_id = UUID(job_id)
    started = time.monotonic()
    source_frames = Path(frames_dir)
    source_masks = Path(masks_dir)
    source_video_path = Path(source_video)

    asyncio.run(
        update_job(
            parsed_job_id,
            status=JobStatus.RUNNING,
            stage="loading-model",
            progress=1,
            error_message=None,
        )
    )

    try:
        frame_paths = sorted(source_frames.glob("frame_*.png"))
        if not frame_paths:
            raise ValueError(f"No frame_*.png files found in {source_frames}")

        processed_dir = storage.processed_directory(parsed_job_id)
        for old_frame in processed_dir.glob("frame_*.png"):
            old_frame.unlink()

        inpainted_count = 0
        copied_count = 0
        total = len(frame_paths)

        for index, frame_path in enumerate(frame_paths):
            mask_path = source_masks / frame_path.name.replace("frame_", "mask_", 1)
            output_path = processed_dir / frame_path.name

            if mask_path.is_file():
                lama_service.inpaint_frame(
                    frame_path,
                    mask_path,
                    output_path,
                    dilation_radius=dilation_radius,
                    feather_radius=feather_radius,
                )
                inpainted_count += 1
            else:
                shutil.copy2(frame_path, output_path)
                copied_count += 1

            progress = min(90, max(2, round((index + 1) / total * 90)))
            self.update_state(
                state="PROGRESS",
                meta={"job_id": job_id, "progress": progress, "stage": "inpainting"},
            )
            asyncio.run(
                update_job(
                    parsed_job_id,
                    status=JobStatus.RUNNING,
                    stage="inpainting",
                    progress=progress,
                )
            )

        metadata = ffmpeg_service.probe(source_video_path)
        output_fps = fps or metadata.fps
        output_path = storage.result_video_path(parsed_job_id)

        asyncio.run(
            update_job(
                parsed_job_id,
                status=JobStatus.RUNNING,
                stage="exporting",
                progress=95,
            )
        )
        result_video = ffmpeg_service.reassemble(
            processed_dir,
            output_path,
            output_fps,
            audio_source=source_video_path if metadata.has_audio else None,
        )

        result = {
            "result_video": str(result_video),
            "processed_frames_dir": str(processed_dir),
            "total_frames": total,
            "inpainted_frames": inpainted_count,
            "copied_frames": copied_count,
            "fps": output_fps,
            "audio_preserved": metadata.has_audio,
            "backend": "lama",
        }
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
