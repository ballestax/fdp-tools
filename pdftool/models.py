"""Modelos de datos de la API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# Tamaños de página en puntos PDF (1/72 pulgada), orientación vertical.
PAGE_PRESETS: dict[str, tuple[float, float]] = {
    "A3": (841.89, 1190.55),
    "A4": (595.28, 841.89),
    "A5": (419.53, 595.28),
    "LETTER": (612.0, 792.0),
    "LEGAL": (612.0, 1008.0),
}


class Scale(BaseModel):
    """Escala de una hoja: un tamaño de página predefinido o un factor."""

    preset: Literal["A3", "A4", "A5", "LETTER", "LEGAL"] | None = None
    factor: float | None = Field(default=None, ge=0.1, le=4.0)

    @model_validator(mode="after")
    def _exactly_one(self) -> "Scale":
        if (self.preset is None) == (self.factor is None):
            raise ValueError("Indique 'preset' o 'factor' (solo uno)")
        return self


class PageRef(BaseModel):
    """Referencia a una hoja de un documento cargado, con sus ediciones."""

    doc_id: str
    page: int = Field(ge=0)
    rotation: int = 0
    scale: Scale | None = None

    @field_validator("rotation")
    @classmethod
    def _valid_rotation(cls, v: int) -> int:
        if v % 90:
            raise ValueError("La rotación debe ser múltiplo de 90")
        return v % 360


class ExportRequest(BaseModel):
    pages: list[PageRef] = Field(min_length=1)
    filename: str = "documento.pdf"


class SplitRequest(ExportRequest):
    mode: Literal["selection", "each"] = "each"
