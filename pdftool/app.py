"""Aplicación FastAPI: API REST y frontend estático."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import pdf_ops
from .models import ExportRequest, SplitRequest
from .storage import DocumentStore, StorageError, sanitize_filename

STATIC_DIR = Path(__file__).parent / "static"


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}


def _ensure_ext(name: str, ext: str) -> str:
    return name if name.lower().endswith(ext) else f"{Path(name).stem or name}{ext}"


def create_app(store: DocumentStore | None = None) -> FastAPI:
    store = store or DocumentStore()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        store.close()

    app = FastAPI(title="PDF Tool", lifespan=lifespan)
    app.state.store = store

    def resolve(doc_id: str) -> Path:
        try:
            return store.path(doc_id)
        except KeyError:
            raise HTTPException(404, f"Documento no encontrado: {doc_id}") from None

    def build(req: ExportRequest) -> bytes:
        try:
            return pdf_ops.build_pdf(req.pages, resolve)
        except (IndexError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/documents")
    async def upload(files: list[UploadFile] = File(...)) -> list[dict]:
        result, errors = [], []
        for f in files:
            try:
                result.append(store.add(await f.read(), f.filename or "documento.pdf").to_dict())
            except StorageError as exc:
                errors.append(str(exc))
        if errors and not result:
            raise HTTPException(400, "; ".join(errors))
        return result

    @app.get("/api/documents")
    def list_documents() -> list[dict]:
        return [m.to_dict() for m in store.list()]

    @app.delete("/api/documents/{doc_id}", status_code=204)
    def delete_document(doc_id: str) -> Response:
        try:
            store.remove(doc_id)
        except KeyError:
            raise HTTPException(404, "Documento no encontrado") from None
        return Response(status_code=204)

    @app.get("/api/documents/{doc_id}/pages/{page}/thumb")
    def thumbnail(doc_id: str, page: int, w: int = Query(220, ge=32, le=2400)) -> Response:
        try:
            png = store.thumbnail(doc_id, page, w)
        except (KeyError, IndexError):
            raise HTTPException(404, "Hoja no encontrada") from None
        return Response(png, media_type="image/png",
                        headers={"Cache-Control": "private, max-age=86400"})

    @app.post("/api/export")
    def export(req: ExportRequest) -> Response:
        name = _ensure_ext(sanitize_filename(req.filename), ".pdf")
        return Response(build(req), media_type="application/pdf", headers=_attachment(name))

    @app.post("/api/split")
    def split(req: SplitRequest) -> Response:
        name = sanitize_filename(req.filename)
        if req.mode == "selection":
            name = _ensure_ext(name, ".pdf")
            return Response(build(req), media_type="application/pdf", headers=_attachment(name))
        try:
            data = pdf_ops.split_pdf(req.pages, resolve, name)
        except (IndexError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        zip_name = f"{Path(name).stem or 'hojas'}.zip"
        return Response(data, media_type="application/zip", headers=_attachment(zip_name))

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app
