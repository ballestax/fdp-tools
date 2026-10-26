"""Operaciones sobre PDF: render de hojas, construcción y división de documentos."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Callable, Iterable

import pymupdf

from .models import PAGE_PRESETS, PageRef

PathResolver = Callable[[str], Path]


def render_page_png(path: Path, page: int, width: int) -> bytes:
    """Renderiza una hoja como PNG con el ancho indicado (en píxeles)."""
    with pymupdf.open(path) as doc:
        pg = doc[page]
        zoom = width / pg.rect.width
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")


def _target_size(ref: PageRef, src_page: pymupdf.Page) -> tuple[float, float]:
    """Tamaño final (ancho, alto) de una hoja escalada, ya con la rotación aplicada."""
    # rect ya incluye la rotación propia de la hoja; solo la rotación extra cambia la orientación.
    w, h = src_page.rect.width, src_page.rect.height
    if ref.rotation in (90, 270):
        w, h = h, w
    if ref.scale.preset:
        pw, ph = PAGE_PRESETS[ref.scale.preset]
        # Conservar la orientación (vertical/horizontal) del contenido.
        if w > h:
            pw, ph = ph, pw
        return pw, ph
    return w * ref.scale.factor, h * ref.scale.factor


def build_pdf(pages: Iterable[PageRef], resolve: PathResolver) -> bytes:
    """Construye un PDF nuevo a partir de una lista ordenada de referencias a hojas."""
    pages = list(pages)
    if not pages:
        raise ValueError("No hay hojas para exportar")
    sources: dict[str, pymupdf.Document] = {}
    out = pymupdf.open()
    try:
        for ref in pages:
            src = sources.get(ref.doc_id)
            if src is None:
                src = sources[ref.doc_id] = pymupdf.open(resolve(ref.doc_id))
            if not 0 <= ref.page < src.page_count:
                raise IndexError(f"Hoja {ref.page} fuera de rango en {ref.doc_id}")
            src_page = src[ref.page]
            if ref.scale is None:
                out.insert_pdf(src, from_page=ref.page, to_page=ref.page)
                new = out[-1]
                new.set_rotation((new.rotation + ref.rotation) % 360)
            else:
                w, h = _target_size(ref, src_page)
                new = out.new_page(width=w, height=h)
                # show_pdf_page respeta la rotación propia de la hoja; añadimos la del usuario.
                new.show_pdf_page(
                    new.rect, src, ref.page, rotate=-ref.rotation, keep_proportion=True
                )
        return out.tobytes(garbage=3, deflate=True)
    finally:
        out.close()
        for doc in sources.values():
            doc.close()


def split_pdf(
    pages: list[PageRef], resolve: PathResolver, base_name: str
) -> bytes:
    """Genera un ZIP con un PDF por hoja."""
    stem = Path(base_name).stem or "hoja"
    digits = max(3, len(str(len(pages))))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, ref in enumerate(pages, start=1):
            zf.writestr(f"{stem}_{i:0{digits}d}.pdf", build_pdf([ref], resolve))
    return buf.getvalue()
