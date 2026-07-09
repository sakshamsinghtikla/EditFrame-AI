from pathlib import Path
from uuid import UUID

from app.core.config import settings


class LocalStorage:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or settings.storage_root).resolve()

    def ensure_root(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root

    def job_directory(self, job_id: UUID | str) -> Path:
        directory = self.ensure_root() / "jobs" / str(job_id)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def frames_directory(self, job_id: UUID | str) -> Path:
        directory = self.job_directory(job_id) / "frames"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def masks_directory(self, job_id: UUID | str) -> Path:
        directory = self.job_directory(job_id) / "masks"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def processed_directory(self, job_id: UUID | str) -> Path:
        directory = self.job_directory(job_id) / "processed"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def results_directory(self, job_id: UUID | str) -> Path:
        directory = self.job_directory(job_id) / "results"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def result_video_path(self, job_id: UUID | str) -> Path:
        return self.results_directory(job_id) / "object_removed.mp4"


storage = LocalStorage()
