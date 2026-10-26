"""Punto de entrada: `python -m pdftool` o `pdftool`."""

from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Herramienta web local para gestionar PDF")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="no abrir el navegador")
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    print(f"PDF Tool en {url}  (Ctrl+C para salir)")
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
