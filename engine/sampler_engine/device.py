"""Pick the fastest available compute device."""

from __future__ import annotations

import platform
from dataclasses import dataclass


@dataclass(frozen=True)
class Device:
    type: str  # "cuda" | "mps" | "cpu"
    name: str

    def to_dict(self) -> dict:
        return {"type": self.type, "name": self.name}


def detect() -> Device:
    import torch

    if torch.cuda.is_available():
        return Device("cuda", torch.cuda.get_device_name(0))
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return Device("mps", "Apple GPU")
    return Device("cpu", platform.processor() or platform.machine() or "CPU")
