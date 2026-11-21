"""HTTP + WebSocket API used by the desktop app.

Only listens on 127.0.0.1. Every request must carry the token the app generated when it
launched us (header `x-token`, or `?token=` for the WebSocket)."""

from __future__ import annotations

import asyncio
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .jobs import JobManager
from .separation.backend import SeparationBackend, SeparationRequest
from .separation.stems import ALL_STEMS, REST, choose_model


class SeparateBody(BaseModel):
    input_path: str = Field(alias="inputPath")
    out_dir: str = Field(alias="outDir")
    stems: list[Literal["vocals", "drums", "bass", "guitar", "piano", "other"]]
    quality: Literal["fast", "best"] = "fast"
    duration: float | None = None


def create_app(
    token: str,
    backend: SeparationBackend,
    device: dict,
    jobs: JobManager | None = None,
    on_ready=None,
) -> FastAPI:
    jobs = jobs or JobManager()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if on_ready:
            on_ready()
        yield

    app = FastAPI(title="Sampler Lab engine", version=__version__, lifespan=lifespan)
    # The webview's origin varies by OS (tauri://localhost, http://tauri.localhost) and
    # in dev it's the Vite server; the token is what actually protects us.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def auth(x_token: str = Header(default="")) -> None:
        if x_token != token:
            raise HTTPException(status_code=401, detail="token inválido")

    @app.get("/health", dependencies=[Depends(auth)])
    def health() -> dict:
        return {"ok": True, "version": __version__, "device": device, "backend": backend.describe()}

    @app.get("/separation/options", dependencies=[Depends(auth)])
    def options() -> dict:
        return {"stems": ALL_STEMS, "rest": REST, "qualities": ["fast", "best"]}

    @app.post("/separate", dependencies=[Depends(auth)])
    def separate(body: SeparateBody) -> dict:
        inp = Path(body.input_path)
        if not inp.is_file():
            raise HTTPException(status_code=400, detail="no existe el archivo de entrada")
        try:
            model = choose_model(list(body.stems), body.quality)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        req = SeparationRequest(
            input_path=inp,
            out_dir=Path(body.out_dir),
            stems=list(body.stems),
            quality=body.quality,
            duration=body.duration,
        )

        def run(ctx) -> dict:
            paths = backend.separate(req, ctx.progress, ctx.cancelled)
            return {"model": model, "stems": {k: str(v) for k, v in paths.items()}}

        job = jobs.submit("separate", run, estimate_seconds=backend.estimate_seconds(req))
        return job.to_dict()

    @app.get("/jobs/{job_id}", dependencies=[Depends(auth)])
    def get_job(job_id: str) -> dict:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="no existe el trabajo")
        return job.to_dict()

    @app.delete("/jobs/{job_id}", dependencies=[Depends(auth)])
    def cancel_job(job_id: str) -> dict:
        job = jobs.cancel(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="no existe el trabajo")
        return job.to_dict()

    @app.websocket("/ws")
    async def ws(socket: WebSocket, token_q: str = Query(default="", alias="token")) -> None:
        if token_q != token:
            await socket.close(code=4401)
            return
        await socket.accept()
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[dict] = asyncio.Queue()
        # Job updates come from the worker thread; hop onto the event loop.
        unsubscribe = jobs.subscribe(lambda d: loop.call_soon_threadsafe(q.put_nowait, d))
        try:
            while True:
                data = await q.get()
                await socket.send_text(json.dumps({"type": "job", "job": data}))
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            unsubscribe()

    return app


def print_ready(port: int) -> None:
    """The desktop app waits for exactly this line on stdout."""
    sys.stdout.write(json.dumps({"event": "ready", "port": port}) + "\n")
    sys.stdout.flush()
