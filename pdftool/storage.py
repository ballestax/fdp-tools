"""Almacenamiento temporal de los PDFs cargados y caché de miniaturas."""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

from . import pdf_ops

MAX_FILE_SIZE = 200 * 1024 * 1024  # 200 MB

PALETTE = [
    "#2563eb", "#dc2626", "#16a34a", "#d97706",
    "#7c3aed", "#0891b2", "#db2777", "#65a30d",
]


class StorageError(ValueError):
    """Error de validación al cargar un documento."""


@dataclass
class DocMeta:
    id: str
    name: str
    page_count: int
    pages: list[dict]
    color: str
    path: Path = field(repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "page_count": self.page_count,
            "pages": self.pages,
            "color": self.color,
        }


def sanitize_filename(name: str, default: str = "documento.pdf") -> str:
    name = Path(name or "").name
    name = re.sub(r"[^\w.\- ()áéíóúÁÉÍÓÚñÑüÜ]", "_", name).strip(" .")
    return name or default


class DocumentStore:
    def __init__(self, root: Path | None = None) -> None:
        self._tmp = None
        if root is None:
            self._tmp = tempfile.TemporaryDirectory(prefix="pdftool-")
            root = Path(self._tmp.name)
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._docs: dict[str, DocMeta] = {}
        self._lock = threading.Lock()
        self._color_idx = 0

    # -- documentos -------------------------------------------------------
    def add(self, data: bytes, name: str) -> DocMeta:
        if len(data) > MAX_FILE_SIZE:
            raise StorageError(f"'{name}' supera el tamaño máximo de 200 MB")
        try:
            doc = pymupdf.open(stream=data, filetype="pdf")
        except Exception as exc:  # noqa: BLE001 - cualquier fallo = no es PDF válido
            raise StorageError(f"'{name}' no es un PDF válido") from exc
        with doc:
            if doc.needs_pass:
                raise StorageError(f"'{name}' está protegido con contraseña")
            if doc.page_count == 0:
                raise StorageError(f"'{name}' no tiene hojas")
            pages = [
                {"w": round(p.rect.width, 2), "h": round(p.rect.height, 2)}
                for p in doc
            ]
        doc_id = uuid.uuid4().hex
        doc_dir = self.root / doc_id
        doc_dir.mkdir()
        path = doc_dir / "source.pdf"
        path.write_bytes(data)
        with self._lock:
            color = PALETTE[self._color_idx % len(PALETTE)]
            self._color_idx += 1
            meta = DocMeta(doc_id, sanitize_filename(name), len(pages), pages, color, path)
            self._docs[doc_id] = meta
        return meta

    def get(self, doc_id: str) -> DocMeta:
        try:
            return self._docs[doc_id]
        except KeyError:
            raise KeyError(doc_id) from None

    def path(self, doc_id: str) -> Path:
        return self.get(doc_id).path

    def remove(self, doc_id: str) -> None:
        with self._lock:
            meta = self._docs.pop(doc_id)
        shutil.rmtree(meta.path.parent, ignore_errors=True)

    def list(self) -> list[DocMeta]:
        return list(self._docs.values())

    # -- miniaturas -------------------------------------------------------
    def thumbnail(self, doc_id: str, page: int, width: int) -> bytes:
        meta = self.get(doc_id)
        if not 0 <= page < meta.page_count:
            raise IndexError(page)
        cache = meta.path.parent / f"p{page}_w{width}.png"
        if cache.exists():
            return cache.read_bytes()
        png = pdf_ops.render_page_png(meta.path, page, width)
        cache.write_bytes(png)
        return png

    def close(self) -> None:
        if self._tmp is not None:
            self._tmp.cleanup()
