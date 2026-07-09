from pathlib import Path
from uuid import UUID

from app.core.config import settings


class LocalStorage:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or settings.storage_root).resolve()

    def ensure_root(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root

    def frames_directory(self, job_id: UUID | str) -> Path:
        directory = self.ensure_root() / "jobs" / str(job_id) / "frames"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def masks_directory(self, job_id: UUID | str) -> Path:
        directory = self.ensure_root() / "jobs" / str(job_id) / "masks"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def processed_directory(self, job_id: UUID | str) -> Path:
        directory = self.ensure_root() / "jobs" / str(job_id) / "processed"
        directory.mkdir(parents=True, exist_ok=True)
        return directory


storage = LocalStorage()
