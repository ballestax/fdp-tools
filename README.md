# PDF Tool

Herramienta web local (Python) para organizar hojas de PDF en una grilla de miniaturas:

- **Cargar** uno o varios PDF (botón *＋ Agregar PDF* o arrastrándolos a la ventana).
- **Ver todas las hojas en una grilla**: cada celda es una hoja; doble clic abre una vista ampliada.
- **Descartar** hojas, **duplicarlas** y **reordenarlas con drag & drop** (si arrastras una hoja seleccionada, se mueve toda la selección).
- **Combinar documentos**: al agregar otro archivo sus hojas se suman a la misma grilla y se pueden intercalar libremente con las de los demás. Cada documento tiene un color para identificar el origen de cada hoja.
- **Rotar** (90°) y **escalar** hojas de forma independiente: A4, Carta, Oficio, A3, A5 o un porcentaje. El contenido se ajusta proporcionalmente y centrado.
- **Exportar** todas las hojas a un único PDF (unión).
- **Dividir**: *Selección → PDF* crea un archivo con las hojas seleccionadas; *Cada hoja → PDF* crea un archivo por hoja (seleccionadas o todas) y los descarga en un ZIP.
- Deshacer / rehacer.

Los archivos originales nunca se modifican: la grilla guarda referencias a las hojas y el PDF final se genera al exportar, sin pérdida de calidad.

## Instalación

Requiere Python 3.10+.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e .
```

## Uso

```bash
pdftool                 # o: python -m pdftool
```

Se abre el navegador en `http://127.0.0.1:8000/`. Opciones: `--port 9000`, `--host 0.0.0.0`, `--no-browser`.

### Atajos de teclado

| Acción | Atajo |
|---|---|
| Seleccionar / alternar / rango | Clic / Ctrl+clic / Shift+clic |
| Seleccionar todo / ninguna | Ctrl+A / Esc |
| Rotar derecha / izquierda | R / Shift+R |
| Descartar | Supr |
| Duplicar | Ctrl+D |
| Deshacer / rehacer | Ctrl+Z / Ctrl+Y |
| Vista ampliada | Doble clic o Enter (← → para navegar) |
| Abrir archivo | O |

## Arquitectura

```
pdftool/
  app.py        API FastAPI + archivos estáticos
  storage.py    almacenamiento temporal de PDFs y caché de miniaturas
  pdf_ops.py    render de hojas, construcción y división de PDFs (PyMuPDF)
  models.py     modelos Pydantic (PageRef, Scale, …)
  static/       frontend HTML/CSS/JS (SortableJS para drag & drop)
```

API principal:

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/documents` | Sube PDFs (multipart, campo `files`) |
| `GET` | `/api/documents/{id}/pages/{n}/thumb?w=220` | Miniatura PNG de una hoja |
| `DELETE` | `/api/documents/{id}` | Quita un documento |
| `POST` | `/api/export` | `{pages: [PageRef], filename}` → PDF |
| `POST` | `/api/split` | `{pages, mode: "selection" \| "each", filename}` → PDF o ZIP |

`PageRef = {doc_id, page, rotation: 0|90|180|270, scale: null | {preset: "A4"|"LETTER"|"LEGAL"|"A3"|"A5"} | {factor: 0.1–4}}`

## Pruebas

```bash
pip install -e ".[dev]"
pytest
```
