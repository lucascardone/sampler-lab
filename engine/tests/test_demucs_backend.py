import numpy as np
import pytest
import soundfile as sf

from sampler_engine.separation.backend import JobCancelled, SeparationRequest
from sampler_engine.separation.demucs_backend import DemucsBackend, SegmentProgress, to_channels


def test_to_channels():
    mono = np.ones((1, 5), dtype="float32")
    assert to_channels(mono, 2).shape == (2, 5)
    quad = np.ones((4, 5), dtype="float32")
    assert to_channels(quad, 2).shape == (2, 5)


def test_segment_progress_monotonic_across_bag():
    p = SegmentProgress(length=1000, segment_len=400)  # stride 300 → offsets 0,300,600,900
    values = []
    for model_idx in range(2):
        for off in (0, 300, 600, 900):
            for state in ("start", "end"):
                values.append(
                    p.update({"models": 2, "model_idx_in_bag": model_idx, "segment_offset": off, "state": state})
                )
    assert values == sorted(values)
    assert values[-1] == pytest.approx(1.0)
    assert values[7] == pytest.approx(0.5)  # end of first model = half the job


@pytest.mark.slow
def test_real_separation_on_gpu_or_cpu(tmp_path):
    """Runs htdemucs for real (downloads ~80 MB the first time). `pytest -m slow`"""
    from sampler_engine.device import detect

    sr = 44100
    t = np.arange(sr * 3) / sr
    # A "voice-ish" tone + a click track: enough to exercise the full pipeline.
    tone = 0.3 * np.sin(2 * np.pi * 220 * t)
    clicks = np.zeros_like(t)
    clicks[:: sr // 2] = 0.9
    audio = np.stack([tone + clicks, tone + clicks], axis=1).astype("float32")
    inp = tmp_path / "in.wav"
    sf.write(str(inp), audio, 48000)  # different rate on purpose: exercises resampling

    backend = DemucsBackend(detect().type)
    seen = []
    out = backend.separate(
        SeparationRequest(inp, tmp_path / "out", ["vocals"], "fast"),
        lambda f, s: seen.append(f),
        lambda: False,
    )
    assert set(out) == {"vocals", "rest"}
    for path in out.values():
        y, rate = sf.read(str(path), always_2d=True)
        assert rate == 48000
        assert y.shape == audio.shape  # same length as the input, exactly
    assert seen == sorted(seen) and seen[-1] == 1.0

    # Cancel mid-way.
    calls = {"n": 0}

    def cancelled():
        calls["n"] += 1
        return calls["n"] > 2

    with pytest.raises(JobCancelled):
        backend.separate(SeparationRequest(inp, tmp_path / "out2", ["drums"], "fast"), lambda f, s: None, cancelled)
