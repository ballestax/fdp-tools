import pymupdf
import pytest

from pdftool.storage import DocumentStore


def make_pdf(label: str, n: int, width: float = 300, height: float = 500) -> bytes:
    doc = pymupdf.open()
    for i in range(1, n + 1):
        page = doc.new_page(width=width, height=height)
        page.insert_text((20, 40), f"{label}-p{i}", fontsize=14)
    data = doc.tobytes()
    doc.close()
    return data


def page_texts(data: bytes) -> list[str]:
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return [p.get_text().strip() for p in doc]


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path)


@pytest.fixture
def doc_a():
    return make_pdf("A", 3)


@pytest.fixture
def doc_b():
    return make_pdf("B", 2, width=500, height=300)
