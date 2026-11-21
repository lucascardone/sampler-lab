"""A tiny job queue: one worker thread runs jobs in order (one GPU, one job at a time),
with progress, ETA and cancellation. Updates are pushed to `on_update` listeners."""

from __future__ import annotations

import logging
import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .separation.backend import JobCancelled

log = logging.getLogger(__name__)

# Progress reported during this stage drives the ETA (setup stages like model download
# are excluded). Jobs that never report it fall back to the initial estimate.
WORK_STAGE = "separating"

# Don't flood the UI: at most one progress update per job per this many seconds.
_THROTTLE_SECS = 0.1


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    stage: str = ""
    estimate_seconds: float | None = None
    started_at: float | None = None
    #: When the main work stage began and the progress at that moment (for the ETA).
    _work_t0: float | None = field(default=None, repr=False)
    _work_p0: float = field(default=0.0, repr=False)
    finished_at: float | None = None
    result: Any = None
    error: str | None = None
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def eta_seconds(self) -> float | None:
        if self.status != "running" or self.started_at is None:
            return self.estimate_seconds if self.status == "queued" else None
        now = time.monotonic()
        done = self.progress - self._work_p0
        # Until there's real progress to extrapolate from, count down the estimate.
        if self._work_t0 is None or done < 0.1:
            if not self.estimate_seconds:
                return None
            return max(self.estimate_seconds - (now - self.started_at), 2.0)
        return (now - self._work_t0) / done * (1 - self.progress)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 4),
            "stage": self.stage,
            "estimateSeconds": self.estimate_seconds,
            "etaSeconds": self.eta_seconds(),
            "result": self.result,
            "error": self.error,
        }


class JobContext:
    """What a running job sees."""

    def __init__(self, manager: JobManager, job: Job):
        self._m, self._job = manager, job

    def progress(self, fraction: float, stage: str = "") -> None:
        self._m._progress(self._job, fraction, stage)

    def cancelled(self) -> bool:
        return self._job._cancel.is_set()


JobFn = Callable[[JobContext], Any]


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._queue: queue.Queue[tuple[Job, JobFn]] = queue.Queue()
        self._listeners: list[Callable[[dict], None]] = []
        self._last_emit: dict[str, float] = {}
        self._worker = threading.Thread(target=self._run, name="job-worker", daemon=True)
        self._worker.start()

    def subscribe(self, fn: Callable[[dict], None]) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def submit(self, kind: str, fn: JobFn, estimate_seconds: float | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, estimate_seconds=estimate_seconds)
        self._jobs[job.id] = job
        self._queue.put((job, fn))
        self._emit(job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        job = self._jobs.get(job_id)
        if job and job.status in ("queued", "running"):
            job._cancel.set()
            if job.status == "queued":
                # The worker will skip it; report right away.
                job.status = "cancelled"
                self._emit(job)
        return job

    # ---- internals ----

    def _emit(self, job: Job, force: bool = True) -> None:
        now = time.monotonic()
        if not force and now - self._last_emit.get(job.id, 0) < _THROTTLE_SECS:
            return
        self._last_emit[job.id] = now
        data = job.to_dict()
        for fn in list(self._listeners):
            try:
                fn(data)
            except Exception:  # a broken listener must not kill the worker
                log.exception("job listener failed")

    def _progress(self, job: Job, fraction: float, stage: str) -> None:
        job.progress = max(0.0, min(1.0, fraction))
        stage_changed = stage and stage != job.stage
        if stage:
            job.stage = stage
        if stage_changed and stage == WORK_STAGE:
            job._work_t0, job._work_p0 = time.monotonic(), job.progress
        self._emit(job, force=bool(stage_changed))

    def _run(self) -> None:
        while True:
            job, fn = self._queue.get()
            if job._cancel.is_set():
                continue
            job.status, job.started_at = "running", time.monotonic()
            self._emit(job)
            try:
                job.result = fn(JobContext(self, job))
                job.status, job.progress = "done", 1.0
            except JobCancelled:
                job.status = "cancelled"
            except Exception as e:
                log.error("job %s failed:\n%s", job.id, traceback.format_exc())
                job.status, job.error = "error", str(e) or type(e).__name__
            job.finished_at = time.monotonic()
            self._emit(job)
