import io
import zipfile

import pymupdf
import pytest

from pdftool import pdf_ops
from pdftool.models import PageRef, Scale
from pdftool.storage import StorageError

from .conftest import page_texts


def refs(*items):
    """refs((doc_id, page[, {extras}]), ...) -> list[PageRef]"""
    return [PageRef(doc_id=i[0], page=i[1], **(i[2] if len(i) > 2 else {})) for i in items]


@pytest.fixture
def loaded(store, doc_a, doc_b):
    a = store.add(doc_a, "a.pdf")
    b = store.add(doc_b, "b.pdf")
    return a.id, b.id


def test_reorder_and_discard(store, loaded):
    a, _ = loaded
    data = pdf_ops.build_pdf(refs((a, 2), (a, 0)), store.path)
    assert page_texts(data) == ["A-p3", "A-p1"]


def test_merge_and_interleave(store, loaded):
    a, b = loaded
    data = pdf_ops.build_pdf(refs((a, 0), (b, 0), (a, 1), (b, 1)), store.path)
    assert page_texts(data) == ["A-p1", "B-p1", "A-p2", "B-p2"]


def test_rotation(store, loaded):
    a, _ = loaded
    data = pdf_ops.build_pdf(refs((a, 0, {"rotation": 90}), (a, 1, {"rotation": -90})), store.path)
    with pymupdf.open(stream=data) as doc:
        assert [p.rotation for p in doc] == [90, 270]
        assert doc[0].rect.width == 500 and doc[0].rect.height == 300


def test_scale_preset_keeps_orientation(store, loaded):
    a, b = loaded
    data = pdf_ops.build_pdf(
        refs(
            (a, 0, {"scale": Scale(preset="A4")}),
            (b, 0, {"scale": Scale(preset="A4")}),
            (a, 1, {"rotation": 90, "scale": Scale(preset="A4")}),
        ),
        store.path,
    )
    with pymupdf.open(stream=data) as doc:
        sizes = [(round(p.rect.width), round(p.rect.height)) for p in doc]
        assert sizes == [(595, 842), (842, 595), (842, 595)]
        assert doc[0].get_text().strip() == "A-p1"


def test_scale_factor(store, loaded):
    a, _ = loaded
    data = pdf_ops.build_pdf(refs((a, 0, {"scale": Scale(factor=2)})), store.path)
    with pymupdf.open(stream=data) as doc:
        assert (doc[0].rect.width, doc[0].rect.height) == (600, 1000)


def test_scaled_and_plain_rotation_match(store, loaded):
    a, _ = loaded
    plain = pdf_ops.build_pdf(refs((a, 0, {"rotation": 90})), store.path)
    scaled = pdf_ops.build_pdf(refs((a, 0, {"rotation": 90, "scale": Scale(factor=1)})), store.path)

    def pos(data):
        with pymupdf.open(stream=data) as doc:
            pg = doc[0]
            r = pg.search_for("A-p1")[0] * pg.rotation_matrix
            return round(r.x0), round(r.y0)

    assert pos(plain) == pos(scaled)


def test_split_each(store, loaded):
    a, b = loaded
    data = pdf_ops.split_pdf(refs((a, 0), (b, 1)), store.path, "salida.pdf")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert zf.namelist() == ["salida_001.pdf", "salida_002.pdf"]
        assert page_texts(zf.read("salida_002.pdf")) == ["B-p2"]


def test_empty_and_out_of_range(store, loaded):
    a, _ = loaded
    with pytest.raises(ValueError):
        pdf_ops.build_pdf([], store.path)
    with pytest.raises(IndexError):
        pdf_ops.build_pdf(refs((a, 9)), store.path)


def test_store_rejects_invalid(store):
    with pytest.raises(StorageError):
        store.add(b"no es un pdf", "x.pdf")


def test_thumbnail_cached(store, loaded):
    a, _ = loaded
    png = store.thumbnail(a, 0, 100)
    assert png.startswith(b"\x89PNG")
    assert store.thumbnail(a, 0, 100) == png
    with pytest.raises(IndexError):
        store.thumbnail(a, 5, 100)
