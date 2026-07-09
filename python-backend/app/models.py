from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import Enum, Float, ForeignKey, Integer, JSON, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UUIDPrimaryKeyMixin


class JobType(StrEnum):
    FRAME_EXTRACTION = "FRAME_EXTRACTION"
    SEGMENTATION = "SEGMENTATION"
    TRACKING = "TRACKING"
    INPAINTING = "INPAINTING"
    VIDEO_EXPORT = "VIDEO_EXPORT"


class JobStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class ProcessingJob(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "processing_jobs"

    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    parent_job_id: Mapped[UUID | None] = mapped_column(
        Uuid, ForeignKey("processing_jobs.id", ondelete="SET NULL"), index=True
    )
    job_type: Mapped[JobType] = mapped_column(Enum(JobType), index=True)
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus), default=JobStatus.PENDING, index=True
    )
    stage: Mapped[str] = mapped_column(String(100), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    celery_task_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    input_data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    output_data: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error_message: Mapped[str | None] = mapped_column(Text)
    elapsed_seconds: Mapped[float | None] = mapped_column(Float)
