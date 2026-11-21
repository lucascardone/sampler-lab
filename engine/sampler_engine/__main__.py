"""Entry point: `python -m sampler_engine --port 0 --token T [--parent-pid P] [--models-dir D]`.

Prints `{"event": "ready", "port": N}` on stdout once it accepts connections."""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time


def _watch_parent(pid: int) -> None:
    """Exit if the desktop app dies without stopping us (crash, kill -9...)."""
    import psutil

    while True:
        if not psutil.pid_exists(pid):
            os._exit(0)
        time.sleep(2)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="sampler-engine")
    ap.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    ap.add_argument("--token", required=True)
    ap.add_argument("--parent-pid", type=int)
    ap.add_argument("--models-dir", help="where model weights are cached")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.models_dir:
        # Must be set before huggingface_hub / torch are imported.
        os.environ["HF_HOME"] = os.path.join(args.models_dir, "huggingface")
        os.environ["TORCH_HOME"] = os.path.join(args.models_dir, "torch")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    if args.parent_pid:
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()

    import uvicorn

    from .app import create_app, print_ready
    from .device import detect
    from .separation.demucs_backend import DemucsBackend

    device = detect()
    logging.info("device: %s (%s)", device.type, device.name)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))
    port = sock.getsockname()[1]

    app = create_app(
        token=args.token,
        backend=DemucsBackend(device.type),
        device=device.to_dict(),
        on_ready=lambda: print_ready(port),
    )
    config = uvicorn.Config(app, log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
