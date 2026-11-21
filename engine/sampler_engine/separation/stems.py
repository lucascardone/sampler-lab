"""Which model to run for a request, and how to turn model outputs into the stems the
user asked for. Pure logic, no torch — easy to test."""

from __future__ import annotations

from typing import Literal

Stem = Literal["vocals", "drums", "bass", "guitar", "piano", "other"]
Quality = Literal["fast", "best"]

ALL_STEMS: list[str] = ["vocals", "drums", "bass", "guitar", "piano", "other"]

# Output name for "everything you didn't ask for" (e.g. asking for vocals also gives
# you the instrumental). Very useful for samplers, and costs nothing extra.
REST = "rest"

MODEL_SOURCES: dict[str, list[str]] = {
    "htdemucs": ["drums", "bass", "other", "vocals"],
    "htdemucs_ft": ["drums", "bass", "other", "vocals"],
    "htdemucs_6s": ["drums", "bass", "other", "vocals", "guitar", "piano"],
}


def choose_model(stems: list[str], quality: Quality) -> str:
    """Pick the Demucs model.

    - Guitar/piano only exist in the 6-source model (there's no fine-tuned 6s variant,
      so "best" falls back to it too).
    - Otherwise: fast → htdemucs, best → htdemucs_ft (4 fine-tuned models, ~4× slower).
    """
    unknown = set(stems) - set(ALL_STEMS)
    if unknown:
        raise ValueError(f"stems desconocidos: {sorted(unknown)}")
    if not stems:
        raise ValueError("elegí al menos un stem")
    if {"guitar", "piano"} & set(stems):
        return "htdemucs_6s"
    return "htdemucs_ft" if quality == "best" else "htdemucs"


def plan_outputs(stems: list[str], model_sources: list[str]) -> dict[str, list[str]]:
    """Map each output file to the model sources that are summed into it.

    >>> plan_outputs(["vocals"], ["drums", "bass", "other", "vocals"])
    {'vocals': ['vocals'], 'rest': ['drums', 'bass', 'other']}
    """
    plan: dict[str, list[str]] = {}
    for s in stems:
        if s not in model_sources:
            raise ValueError(f"el modelo no separa '{s}'")
        plan[s] = [s]
    remaining = [s for s in model_sources if s not in stems]
    if remaining:
        plan[REST] = remaining
    return plan


# Rough seconds of processing per second of audio, by device. Used for the initial
# estimate only; the job's ETA switches to measured progress once it starts.
_REALTIME_FACTOR = {
    "cuda": {"htdemucs": 0.07, "htdemucs_6s": 0.07, "htdemucs_ft": 0.25},  # measured: RTX 3070
    "mps": {"htdemucs": 0.15, "htdemucs_6s": 0.18, "htdemucs_ft": 0.6},
    "cpu": {"htdemucs": 0.6, "htdemucs_6s": 0.7, "htdemucs_ft": 2.4},
}
_LOAD_OVERHEAD_SECS = 3.0


def estimate_seconds(model: str, device_type: str, audio_secs: float, model_loaded: bool) -> float:
    factor = _REALTIME_FACTOR.get(device_type, _REALTIME_FACTOR["cpu"])[model]
    # Demucs processes in ~7.8 s segments; anything shorter still costs one segment.
    effective = max(audio_secs, 7.8)
    return effective * factor + (0.0 if model_loaded else _LOAD_OVERHEAD_SECS)
