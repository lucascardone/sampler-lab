"""The abstract separation interface. The local Demucs backend implements it today; a
cloud API (or RoFormer models) can be plugged in later without touching the API/jobs."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .stems import Quality

ProgressFn = Callable[[float, str], None]
"""progress(fraction 0..1, stage) where stage is 'loading' | 'separating' | 'writing'."""

CancelledFn = Callable[[], bool]


class JobCancelled(BaseException):
    """Raised inside a backend to abort work. BaseException on purpose: Demucs catches
    BaseException in its chunk loop to stop remaining chunks, then re-raises."""


@dataclass
class SeparationRequest:
    input_path: Path
    out_dir: Path
    stems: list[str]
    quality: Quality = "fast"
    #: Length of the audio in seconds, if the caller knows it (for estimates).
    duration: float | None = None
    extra: dict = field(default_factory=dict)


class SeparationBackend(ABC):
    name: str = "abstract"

    @abstractmethod
    def separate(
        self, req: SeparationRequest, progress: ProgressFn, cancelled: CancelledFn
    ) -> dict[str, Path]:
        """Run the separation. Returns {output name: wav path}. Must raise JobCancelled
        promptly when `cancelled()` becomes true."""

    @abstractmethod
    def estimate_seconds(self, req: SeparationRequest) -> float | None:
        """Rough processing time before starting, or None if unknown."""

    def describe(self) -> dict:
        """Info for the UI (device, etc.)."""
        return {"name": self.name}
