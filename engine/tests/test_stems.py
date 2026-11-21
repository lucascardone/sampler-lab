import pytest

from sampler_engine.separation.stems import MODEL_SOURCES, REST, choose_model, estimate_seconds, plan_outputs

FOUR = MODEL_SOURCES["htdemucs"]
SIX = MODEL_SOURCES["htdemucs_6s"]


@pytest.mark.parametrize(
    ("stems", "quality", "model"),
    [
        (["vocals"], "fast", "htdemucs"),
        (["vocals"], "best", "htdemucs_ft"),
        (["drums", "bass"], "best", "htdemucs_ft"),
        (["guitar"], "fast", "htdemucs_6s"),
        (["piano", "vocals"], "best", "htdemucs_6s"),  # no fine-tuned 6s exists
    ],
)
def test_choose_model(stems, quality, model):
    assert choose_model(stems, quality) == model


def test_choose_model_rejects_bad_input():
    with pytest.raises(ValueError):
        choose_model([], "fast")
    with pytest.raises(ValueError):
        choose_model(["kazoo"], "fast")


def test_vocals_also_gives_instrumental():
    assert plan_outputs(["vocals"], FOUR) == {"vocals": ["vocals"], REST: ["drums", "bass", "other"]}


def test_all_four_stems_has_no_rest():
    assert REST not in plan_outputs(["vocals", "drums", "bass", "other"], FOUR)


def test_six_stem_rest_includes_guitar_and_piano():
    plan = plan_outputs(["drums"], SIX)
    assert sorted(plan[REST]) == sorted(["bass", "other", "vocals", "guitar", "piano"])


def test_plan_rejects_stem_model_cannot_do():
    with pytest.raises(ValueError):
        plan_outputs(["guitar"], FOUR)


def test_estimates_are_ordered():
    gpu = estimate_seconds("htdemucs", "cuda", 20, model_loaded=True)
    cpu = estimate_seconds("htdemucs", "cpu", 20, model_loaded=True)
    best = estimate_seconds("htdemucs_ft", "cpu", 20, model_loaded=True)
    assert gpu < cpu < best
    # Loading the model adds overhead; very short clips cost at least one segment.
    assert estimate_seconds("htdemucs", "cpu", 1, False) > estimate_seconds("htdemucs", "cpu", 1, True)
    assert estimate_seconds("htdemucs", "cpu", 1, True) == estimate_seconds("htdemucs", "cpu", 5, True)
