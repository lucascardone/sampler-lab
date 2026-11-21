"""API tests with a fake backend (no torch, no models)."""

import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from sampler_engine.app import create_app
from sampler_engine.separation.backend import JobCancelled, SeparationBackend

TOKEN = "secret"
H = {"x-token": TOKEN}


class FakeBackend(SeparationBackend):
    name = "fake"

    def __init__(self, slow=False):
        self.slow = slow

    def estimate_seconds(self, req):
        return 1.0

    def separate(self, req, progress, cancelled):
        audio, sr = sf.read(str(req.input_path), always_2d=True)
        req.out_dir.mkdir(parents=True, exist_ok=True)
        out = {}
        steps = 200 if self.slow else 2
        for i in range(steps):
            if cancelled():
                raise JobCancelled()
            progress(i / steps, "separating")
            if self.slow:
                time.sleep(0.01)
        for s in req.stems:
            p = req.out_dir / f"{s}.wav"
            sf.write(str(p), audio * 0.5, sr)
            out[s] = p
        return out


@pytest.fixture
def wav(tmp_path) -> Path:
    p = tmp_path / "in.wav"
    sf.write(str(p), np.zeros((4410, 2), dtype="float32"), 44100)
    return p


def client(backend=None):
    return TestClient(create_app(TOKEN, backend or FakeBackend(), {"type": "cpu", "name": "test"}))


def wait_job(c, job_id, statuses=("done", "error", "cancelled")):
    for _ in range(500):
        j = c.get(f"/jobs/{job_id}", headers=H).json()
        if j["status"] in statuses:
            return j
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_token_required():
    with client() as c:
        assert c.get("/health").status_code == 401
        assert c.get("/health", headers={"x-token": "nope"}).status_code == 401
        assert c.get("/health", headers=H).json()["device"]["type"] == "cpu"


def test_separate_end_to_end(wav, tmp_path):
    with client() as c:
        r = c.post(
            "/separate",
            headers=H,
            json={"inputPath": str(wav), "outDir": str(tmp_path / "out"), "stems": ["vocals"], "quality": "fast"},
        )
        assert r.status_code == 200, r.text
        job = r.json()
        assert job["estimateSeconds"] == 1.0
        done = wait_job(c, job["id"])
        assert done["status"] == "done"
        assert done["result"]["model"] == "htdemucs"
        assert Path(done["result"]["stems"]["vocals"]).is_file()


def test_validation_errors(wav, tmp_path):
    with client() as c:
        base = {"inputPath": str(wav), "outDir": str(tmp_path)}
        assert c.post("/separate", headers=H, json={**base, "stems": []}).status_code == 400
        assert c.post("/separate", headers=H, json={**base, "stems": ["kazoo"]}).status_code == 422
        missing = {**base, "inputPath": str(tmp_path / "nope.wav"), "stems": ["vocals"]}
        assert c.post("/separate", headers=H, json=missing).status_code == 400


def test_cancel(wav, tmp_path):
    with client(FakeBackend(slow=True)) as c:
        job = c.post(
            "/separate", headers=H, json={"inputPath": str(wav), "outDir": str(tmp_path), "stems": ["drums"]}
        ).json()
        wait_job(c, job["id"], ("running",))
        assert c.delete(f"/jobs/{job['id']}", headers=H).status_code == 200
        assert wait_job(c, job["id"])["status"] == "cancelled"


def test_websocket_streams_job_updates(wav, tmp_path):
    with client() as c:
        with c.websocket_connect(f"/ws?token={TOKEN}") as ws:
            job = c.post(
                "/separate", headers=H, json={"inputPath": str(wav), "outDir": str(tmp_path), "stems": ["bass"]}
            ).json()
            statuses = []
            while "done" not in statuses:
                msg = ws.receive_json()
                assert msg["type"] == "job" and msg["job"]["id"] == job["id"]
                statuses.append(msg["job"]["status"])
            assert statuses[0] == "queued"


def test_websocket_rejects_bad_token():
    with client() as c:
        with pytest.raises(Exception):
            with c.websocket_connect("/ws?token=bad") as ws:
                ws.receive_json()
