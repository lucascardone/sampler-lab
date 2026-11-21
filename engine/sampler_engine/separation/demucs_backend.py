"""Local separation with Demucs v4 (github.com/adefossez/demucs; code MIT — the weights'
license is NOT clear, see docs/MODELS.md).

Models (downloaded on first use from the HuggingFace hub into the app's models folder):
- htdemucs     — 4 stems, fast.
- htdemucs_ft  — 4 stems, fine-tuned bag of 4 models: better, ~4× slower.
- htdemucs_6s  — 6 stems (adds guitar, piano). Piano quality is limited.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from .backend import CancelledFn, JobCancelled, ProgressFn, SeparationBackend, SeparationRequest
from .stems import MODEL_SOURCES, choose_model, estimate_seconds, plan_outputs

log = logging.getLogger(__name__)


def to_channels(x: np.ndarray, n: int) -> np.ndarray:
    """(channels, frames) → exactly `n` channels: mono is duplicated, extra channels
    are dropped (surround material is rare for samples)."""
    if x.shape[0] == n:
        return x
    if x.shape[0] == 1:
        return np.repeat(x, n, axis=0)
    return x[:n]


class SegmentProgress:
    """Turns Demucs' per-segment callbacks into one 0..1 fraction across the whole job
    (all models of a bag, all segments)."""

    def __init__(self, length: int, segment_len: int, overlap: float = 0.25):
        self.length = max(length, 1)
        self.stride = max(int((1 - overlap) * segment_len), 1)
        self.best = 0.0

    def update(self, d: dict) -> float:
        models = d.get("models", 1) or 1
        idx = d.get("model_idx_in_bag", 0)
        done_in_model = d.get("segment_offset", 0) + (self.stride if d.get("state") == "end" else 0)
        frac = (idx + min(done_in_model / self.length, 1.0)) / models
        # Never go backwards (shifted chunks can report slightly out of order).
        self.best = max(self.best, min(frac, 1.0))
        return self.best


class DemucsBackend(SeparationBackend):
    name = "demucs"

    def __init__(self, device_type: str):
        self.device_type = device_type
        self._models: dict[str, object] = {}
        self._lock = threading.Lock()

    def describe(self) -> dict:
        return {"name": self.name, "models": list(MODEL_SOURCES)}

    def _load(self, name: str):
        with self._lock:
            if name not in self._models:
                from demucs.pretrained import get_model

                log.info("loading model %s", name)
                model = get_model(name)
                model.eval()
                self._models[name] = model
            return self._models[name]

    def estimate_seconds(self, req: SeparationRequest) -> float | None:
        if req.duration is None:
            return None
        model = choose_model(req.stems, req.quality)
        return estimate_seconds(model, self.device_type, req.duration, model in self._models)

    def separate(self, req: SeparationRequest, progress: ProgressFn, cancelled: CancelledFn) -> dict[str, Path]:
        import julius
        import torch
        from demucs.apply import apply_model

        model_name = choose_model(req.stems, req.quality)
        plan = plan_outputs(req.stems, MODEL_SOURCES[model_name])

        progress(0.0, "loading")
        model = self._load(model_name)
        if cancelled():
            raise JobCancelled()

        audio, sr = sf.read(str(req.input_path), dtype="float32", always_2d=True)  # (frames, ch)
        frames = audio.shape[0]
        x = torch.from_numpy(to_channels(audio.T.copy(), model.audio_channels))
        if sr != model.samplerate:
            x = julius.resample_frac(x, sr, model.samplerate)

        # Same normalization as `demucs.separate`.
        ref = x.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        x = (x - mean) / std

        tracker = SegmentProgress(x.shape[-1], int(model.samplerate * float(_segment(model))))

        def on_segment(d: dict) -> None:
            if cancelled():
                raise JobCancelled()
            progress(0.02 + 0.93 * tracker.update(d), "separating")

        with torch.inference_mode():
            out = apply_model(
                model, x[None], device=self.device_type, shifts=1, split=True, overlap=0.25,
                progress=False, callback=on_segment,
            )[0]
        out = out * std + mean  # (sources, channels, frames)

        progress(0.96, "writing")
        req.out_dir.mkdir(parents=True, exist_ok=True)
        sources = list(model.sources)
        results: dict[str, Path] = {}
        for name, parts in plan.items():
            y = sum(out[sources.index(p)] for p in parts)
            if sr != model.samplerate:
                y = julius.resample_frac(y, model.samplerate, sr)
            y = y[..., :frames].cpu().numpy()
            if y.shape[-1] < frames:  # resampling can lose a frame or two
                y = np.pad(y, ((0, 0), (0, frames - y.shape[-1])))
            path = req.out_dir / f"{name}.wav"
            sf.write(str(path), y.T, sr, subtype="FLOAT")
            results[name] = path

        if self.device_type == "cuda":
            torch.cuda.empty_cache()
        progress(1.0, "writing")
        return results


def _segment(model) -> float:
    """Segment length in seconds (a bag exposes its sub-models' segment)."""
    seg = getattr(model, "segment", None)
    if seg is None and hasattr(model, "models"):
        seg = getattr(model.models[0], "segment", 7.8)
    return float(seg or 7.8)
