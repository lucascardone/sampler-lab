import threading
import time

from sampler_engine.jobs import JobManager
from sampler_engine.separation.backend import JobCancelled


def wait_for(job, statuses, timeout=5.0):
    end = time.monotonic() + timeout
    while job.status not in statuses:
        assert time.monotonic() < end, f"job stuck in {job.status}"
        time.sleep(0.01)


def test_job_runs_and_reports_progress():
    m = JobManager()
    seen = []
    m.subscribe(seen.append)

    def fn(ctx):
        ctx.progress(0.5, "separating")
        return {"ok": 1}

    job = m.submit("t", fn, estimate_seconds=3)
    wait_for(job, {"done"})
    assert job.result == {"ok": 1}
    statuses = [d["status"] for d in seen]
    assert statuses[0] == "queued" and statuses[-1] == "done"
    assert any(d["stage"] == "separating" and d["progress"] == 0.5 for d in seen)


def test_errors_are_captured_and_worker_survives():
    m = JobManager()
    bad = m.submit("t", lambda ctx: 1 / 0)
    wait_for(bad, {"error"})
    assert "division" in bad.error
    good = m.submit("t", lambda ctx: "fine")
    wait_for(good, {"done"})


def test_cancel_running_job():
    m = JobManager()
    started = threading.Event()

    def fn(ctx):
        started.set()
        while True:
            if ctx.cancelled():
                raise JobCancelled()
            time.sleep(0.01)

    job = m.submit("t", fn)
    assert started.wait(2)
    m.cancel(job.id)
    wait_for(job, {"cancelled"})


def test_cancel_queued_job_never_runs():
    m = JobManager()
    gate = threading.Event()
    ran = []
    blocker = m.submit("t", lambda ctx: gate.wait(2))
    queued = m.submit("t", lambda ctx: ran.append(1))
    m.cancel(queued.id)
    assert queued.status == "cancelled"
    gate.set()
    wait_for(blocker, {"done"})
    time.sleep(0.05)
    assert ran == []


def test_eta_uses_estimate_then_progress():
    m = JobManager()
    gate = threading.Event()
    holder = {}

    def fn(ctx):
        holder["ctx"] = ctx
        gate.wait(2)

    job = m.submit("t", fn, estimate_seconds=100)
    wait_for(job, {"running"})
    assert 90 < job.eta_seconds() <= 100
    holder["ctx"].progress(0.0, "loading")  # slow setup must not distort the ETA
    holder["ctx"].progress(0.2, "separating")
    job._work_t0 -= 10  # pretend 10 s of separating elapsed...
    holder["ctx"].progress(0.6)  # ...to go from 20% to 60%
    assert 9 < job.eta_seconds() < 11  # 40% took 10 s → 40% left ≈ 10 s
    gate.set()
