import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from pdftool.app import create_app

from .conftest import page_texts


@pytest.fixture
def client(store):
    with TestClient(create_app(store)) as c:
        yield c


def upload(client, *files):
    r = client.post(
        "/api/documents",
        files=[("files", (name, data, "application/pdf")) for name, data in files],
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "<html" in r.text.lower()
    assert client.get("/static/vendor/Sortable.min.js").status_code == 200


def test_upload_list_delete(client, doc_a, doc_b):
    docs = upload(client, ("a.pdf", doc_a), ("b.pdf", doc_b))
    assert [d["page_count"] for d in docs] == [3, 2]
    assert docs[0]["color"] != docs[1]["color"]
    assert len(client.get("/api/documents").json()) == 2
    assert client.delete(f"/api/documents/{docs[0]['id']}").status_code == 204
    assert client.delete(f"/api/documents/{docs[0]['id']}").status_code == 404


def test_upload_invalid(client):
    r = client.post("/api/documents", files=[("files", ("x.pdf", b"nope", "application/pdf"))])
    assert r.status_code == 400


def test_thumbnail(client, doc_a):
    (a,) = upload(client, ("a.pdf", doc_a))
    r = client.get(f"/api/documents/{a['id']}/pages/0/thumb?w=120")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert client.get(f"/api/documents/{a['id']}/pages/7/thumb").status_code == 404


def test_export_merge(client, doc_a, doc_b):
    a, b = upload(client, ("a.pdf", doc_a), ("b.pdf", doc_b))
    pages = [
        {"doc_id": b["id"], "page": 1},
        {"doc_id": a["id"], "page": 0, "rotation": 180},
        {"doc_id": a["id"], "page": 2, "scale": {"preset": "LETTER"}},
    ]
    r = client.post("/api/export", json={"pages": pages, "filename": "unido"})
    assert r.status_code == 200
    assert "unido.pdf" in r.headers["content-disposition"]
    assert page_texts(r.content) == ["B-p2", "A-p1", "A-p3"]


def test_export_errors(client, doc_a):
    (a,) = upload(client, ("a.pdf", doc_a))
    assert client.post("/api/export", json={"pages": []}).status_code == 422
    assert client.post("/api/export", json={"pages": [{"doc_id": "zzz", "page": 0}]}).status_code == 404
    assert client.post("/api/export", json={"pages": [{"doc_id": a["id"], "page": 0, "rotation": 45}]}).status_code == 422
    assert client.post("/api/export", json={"pages": [{"doc_id": a["id"], "page": 0, "scale": {}}]}).status_code == 422


def test_split_modes(client, doc_a):
    (a,) = upload(client, ("a.pdf", doc_a))
    pages = [{"doc_id": a["id"], "page": i} for i in (2, 0)]
    r = client.post("/api/split", json={"pages": pages, "mode": "selection", "filename": "sel.pdf"})
    assert r.headers["content-type"] == "application/pdf"
    assert page_texts(r.content) == ["A-p3", "A-p1"]
    r = client.post("/api/split", json={"pages": pages, "mode": "each", "filename": "doc.pdf"})
    assert r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert len(zf.namelist()) == 2
