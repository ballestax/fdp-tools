/* PDF Tool - frontend.
 *
 * El estado es una lista ordenada de referencias a hojas (`state.pages`).
 * Cada referencia apunta a una hoja de un documento cargado en el servidor y
 * guarda sus ediciones (rotación, escala). El PDF final lo construye el
 * servidor a partir de esta lista al exportar o dividir.
 */
(() => {
  "use strict";

  const PRESETS = {
    A3: [841.89, 1190.55],
    A4: [595.28, 841.89],
    A5: [419.53, 595.28],
    LETTER: [612, 792],
    LEGAL: [612, 1008],
  };
  const PRESET_LABELS = { A3: "A3", A4: "A4", A5: "A5", LETTER: "Carta", LEGAL: "Oficio" };
  const HISTORY_LIMIT = 100;

  const state = {
    docs: new Map(),      // id -> {id, name, page_count, pages:[{w,h}], color}
    pages: [],            // [{uid, doc_id, page, rotation, scale}]
    selected: new Set(),  // uids
    anchor: null,         // uid para selección por rango
    undo: [],
    redo: [],
    thumb: 180,
    viewerUid: null,
  };
  let uidCounter = 0;
  const newUid = () => `p${++uidCounter}`;

  const $ = (sel) => document.querySelector(sel);
  const grid = $("#grid");
  const cardEls = new Map();

  // ---------------------------------------------------------------- utilidades
  function toast(msg, isError = false) {
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3000);
  }

  function busy(text) {
    $("#busy-text").textContent = text || "Procesando…";
    $("#busy").hidden = !text;
  }

  async function apiError(res) {
    try {
      const body = await res.json();
      if (typeof body.detail === "string") return body.detail;
      if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join("; ");
    } catch (_) { /* respuesta sin JSON */ }
    return `Error ${res.status}`;
  }

  function filenameFromResponse(res, fallback) {
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    return m ? decodeURIComponent(m[1]) : fallback;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Calcula cómo dibujar una hoja dentro de una caja: el marco (tamaño final de
  // la hoja, ya escalada) y la imagen (sin rotar) que se rota con CSS.
  function layoutSheet(ref, boxW, boxH) {
    const dims = state.docs.get(ref.doc_id).pages[ref.page];
    const quarter = ref.rotation === 90 || ref.rotation === 270;
    const cw = quarter ? dims.h : dims.w;
    const ch = quarter ? dims.w : dims.h;
    let tw = cw, th = ch;
    if (ref.scale && ref.scale.preset) {
      [tw, th] = PRESETS[ref.scale.preset];
      if (cw > ch) [tw, th] = [th, tw];
    } else if (ref.scale && ref.scale.factor) {
      tw = cw * ref.scale.factor;
      th = ch * ref.scale.factor;
    }
    const k = Math.min(boxW / tw, boxH / th);
    const fw = tw * k, fh = th * k;
    const s = Math.min(fw / cw, fh / ch);
    const dw = cw * s, dh = ch * s;
    return {
      frameW: fw, frameH: fh,
      imgW: quarter ? dh : dw,
      imgH: quarter ? dw : dh,
      outW: tw, outH: th,
    };
  }

  function thumbUrl(ref, px) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(2400, Math.max(120, Math.ceil((px * dpr) / 120) * 120));
    return `/api/documents/${ref.doc_id}/pages/${ref.page}/thumb?w=${w}`;
  }

  function scaleLabel(scale) {
    if (!scale) return "";
    if (scale.preset) return PRESET_LABELS[scale.preset];
    return `${Math.round(scale.factor * 100)}%`;
  }

  const byUid = (uid) => state.pages.find((p) => p.uid === uid);

  // ---------------------------------------------------------------- historial
  function snapshot() {
    return JSON.stringify(state.pages);
  }

  function pushHistory() {
    state.undo.push(snapshot());
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo = [];
  }

  function restore(snap) {
    state.pages = JSON.parse(snap).filter((p) => state.docs.has(p.doc_id));
    const uids = new Set(state.pages.map((p) => p.uid));
    for (const uid of [...state.selected]) if (!uids.has(uid)) state.selected.delete(uid);
    render();
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  // ---------------------------------------------------------------- render
  function createCard(ref) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.uid = ref.uid;
    el.innerHTML = `
      <div class="src-bar"></div>
      <input type="checkbox" class="card-check" title="Seleccionar">
      <div class="card-tools">
        <button data-act="rotl" title="Rotar a la izquierda">↺</button>
        <button data-act="rotr" title="Rotar a la derecha">↻</button>
        <button data-act="del" title="Descartar">✕</button>
      </div>
      <div class="thumb-box"><div class="sheet"><img alt="" draggable="false" loading="lazy"></div></div>
      <div class="card-footer">
        <span class="card-pos"></span>
        <span class="card-src"></span>
        <span class="badge tag card-scale"></span>
      </div>`;
    return el;
  }

  function updateCard(el, ref, index) {
    const doc = state.docs.get(ref.doc_id);
    const size = state.thumb;
    const lay = layoutSheet(ref, size, size);
    const sheet = el.querySelector(".sheet");
    sheet.style.width = `${lay.frameW}px`;
    sheet.style.height = `${lay.frameH}px`;
    const img = el.querySelector("img");
    const url = thumbUrl(ref, size);
    if (img.getAttribute("src") !== url) img.src = url;
    img.style.width = `${lay.imgW}px`;
    img.style.height = `${lay.imgH}px`;
    img.style.transform = `translate(-50%, -50%) rotate(${ref.rotation}deg)`;

    el.querySelector(".src-bar").style.background = doc.color;
    el.querySelector(".card-pos").textContent = index + 1;
    const src = el.querySelector(".card-src");
    src.textContent = `${doc.name} · p. ${ref.page + 1}`;
    src.title = src.textContent;
    const badge = el.querySelector(".card-scale");
    badge.textContent = scaleLabel(ref.scale);
    badge.hidden = !ref.scale;

    const sel = state.selected.has(ref.uid);
    el.classList.toggle("selected", sel);
    el.querySelector(".card-check").checked = sel;
  }

  function render() {
    const seen = new Set();
    state.pages.forEach((ref, i) => {
      let el = cardEls.get(ref.uid);
      if (!el) {
        el = createCard(ref);
        cardEls.set(ref.uid, el);
      }
      updateCard(el, ref, i);
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
      seen.add(ref.uid);
    });
    for (const [uid, el] of cardEls) {
      if (!seen.has(uid)) {
        el.remove();
        cardEls.delete(uid);
      }
    }
    renderDocs();
    renderStatus();
    if (state.viewerUid) renderViewer();
  }

  function renderDocs() {
    const list = $("#doc-list");
    list.innerHTML = "";
    const counts = {};
    for (const p of state.pages) counts[p.doc_id] = (counts[p.doc_id] || 0) + 1;
    for (const doc of state.docs.values()) {
      const li = document.createElement("li");
      li.className = "doc-item";
      li.innerHTML = `
        <span class="doc-swatch"></span>
        <span class="doc-name"></span>
        <span class="doc-meta"></span>
        <span class="doc-actions">
          <button data-act="readd" title="Agregar de nuevo todas sus hojas">＋</button>
          <button data-act="remove" title="Quitar documento">✕</button>
        </span>`;
      li.querySelector(".doc-swatch").style.background = doc.color;
      li.querySelector(".doc-name").textContent = doc.name;
      li.querySelector(".doc-name").title = doc.name;
      li.querySelector(".doc-meta").textContent =
        `${counts[doc.id] || 0} de ${doc.page_count} hojas en uso`;
      li.querySelector('[data-act="readd"]').onclick = () => readdDoc(doc.id);
      li.querySelector('[data-act="remove"]').onclick = () => removeDoc(doc.id);
      list.appendChild(li);
    }
    $("#doc-empty").hidden = state.docs.size > 0;
  }

  function renderStatus() {
    const n = state.pages.length;
    const s = state.selected.size;
    $("#status").textContent =
      `${n} ${n === 1 ? "hoja" : "hojas"}` + (s ? ` · ${s} seleccionada${s === 1 ? "" : "s"}` : "");
    $("#empty").hidden = n > 0;
    grid.classList.toggle("has-selection", s > 0);

    document.querySelectorAll("[data-needs-selection]").forEach((el) => {
      const ctrls = el.matches("button, select") ? [el] : el.querySelectorAll("button, select");
      ctrls.forEach((c) => { c.disabled = s === 0; });
    });
    $("#btn-export").disabled = n === 0;
    $("#btn-split-each").disabled = n === 0;
    $("#btn-select-all").disabled = n === 0;
    $("#btn-select-none").disabled = s === 0;
    $("#btn-undo").disabled = !state.undo.length;
    $("#btn-redo").disabled = !state.redo.length;
  }

  // ---------------------------------------------------------------- selección
  function selectOnly(uid) {
    state.selected = new Set([uid]);
    state.anchor = uid;
  }

  function toggleSelect(uid) {
    if (state.selected.has(uid)) state.selected.delete(uid);
    else state.selected.add(uid);
    state.anchor = uid;
  }

  function selectRange(uid) {
    const order = state.pages.map((p) => p.uid);
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(uid);
    if (a < 0) return selectOnly(uid);
    const [from, to] = a < b ? [a, b] : [b, a];
    for (let i = from; i <= to; i++) state.selected.add(order[i]);
  }

  function clearSelection() {
    state.selected.clear();
    state.anchor = null;
  }

  const selectedRefs = () => state.pages.filter((p) => state.selected.has(p.uid));

  // ---------------------------------------------------------------- ediciones
  function rotate(uids, delta) {
    if (!uids.length) return;
    pushHistory();
    for (const uid of uids) {
      const ref = byUid(uid);
      ref.rotation = (((ref.rotation + delta) % 360) + 360) % 360;
    }
    render();
  }

  function setScale(uids, scale) {
    if (!uids.length) return;
    pushHistory();
    for (const uid of uids) byUid(uid).scale = scale ? { ...scale } : null;
    render();
  }

  function discard(uids) {
    if (!uids.length) return;
    pushHistory();
    const drop = new Set(uids);
    state.pages = state.pages.filter((p) => !drop.has(p.uid));
    for (const uid of uids) state.selected.delete(uid);
    render();
  }

  function duplicate(uids) {
    if (!uids.length) return;
    pushHistory();
    const dup = new Set(uids);
    const out = [];
    const copies = [];
    for (const p of state.pages) {
      out.push(p);
      if (dup.has(p.uid)) {
        const copy = { ...p, scale: p.scale ? { ...p.scale } : null, uid: newUid() };
        out.push(copy);
        copies.push(copy.uid);
      }
    }
    state.pages = out;
    state.selected = new Set(copies);
    render();
  }

  // Inserta hojas nuevas tras la última seleccionada, o al final.
  function insertPages(refs) {
    let at = state.pages.length;
    if (state.selected.size) {
      const idx = state.pages.map((p, i) => (state.selected.has(p.uid) ? i : -1));
      at = Math.max(...idx) + 1;
    }
    state.pages.splice(at, 0, ...refs);
  }

  function refsForDoc(doc) {
    return doc.pages.map((_, i) => ({
      uid: newUid(), doc_id: doc.id, page: i, rotation: 0, scale: null,
    }));
  }

  function readdDoc(docId) {
    pushHistory();
    const refs = refsForDoc(state.docs.get(docId));
    insertPages(refs);
    state.selected = new Set(refs.map((r) => r.uid));
    render();
  }

  async function removeDoc(docId) {
    const doc = state.docs.get(docId);
    if (!confirm(`¿Quitar "${doc.name}" y todas sus hojas de la grilla?`)) return;
    try {
      await fetch(`/api/documents/${docId}`, { method: "DELETE" });
    } catch (_) { /* aunque falle en el servidor, se quita del área de trabajo */ }
    state.docs.delete(docId);
    for (const p of state.pages) if (p.doc_id === docId) state.selected.delete(p.uid);
    state.pages = state.pages.filter((p) => p.doc_id !== docId);
    const keep = (snap) => JSON.parse(snap).some((p) => p.doc_id !== docId);
    state.undo = state.undo.filter(keep);
    state.redo = state.redo.filter(keep);
    render();
  }

  // ---------------------------------------------------------------- carga
  async function uploadFiles(fileList) {
    const files = [...fileList].filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (!files.length) {
      toast("Solo se admiten archivos PDF", true);
      return;
    }
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    busy(`Cargando ${files.length} archivo${files.length > 1 ? "s" : ""}…`);
    try {
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await apiError(res));
      const docs = await res.json();
      if (docs.length < files.length) {
        toast(`${files.length - docs.length} archivo(s) no se pudieron cargar`, true);
      }
      pushHistory();
      const refs = [];
      for (const doc of docs) {
        state.docs.set(doc.id, doc);
        refs.push(...refsForDoc(doc));
      }
      insertPages(refs);
      const fname = $("#filename");
      if (!fname.value && docs.length) {
        fname.value = docs[0].name.replace(/\.pdf$/i, "") + "_editado.pdf";
      }
      render();
      toast(`${refs.length} hojas agregadas`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(null);
    }
  }

  // ---------------------------------------------------------------- exportar
  function payload(refs, extra = {}) {
    return {
      pages: refs.map(({ doc_id, page, rotation, scale }) => ({ doc_id, page, rotation, scale })),
      filename: $("#filename").value.trim() || "documento.pdf",
      ...extra,
    };
  }

  async function download(url, body, fallback) {
    busy("Generando archivo…");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await apiError(res));
      const name = filenameFromResponse(res, fallback);
      saveBlob(await res.blob(), name);
      toast(`Descargado: ${name}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(null);
    }
  }

  function exportAll() {
    if (state.pages.length) download("/api/export", payload(state.pages), "documento.pdf");
  }

  function exportSelection() {
    const refs = selectedRefs();
    if (refs.length) download("/api/split", payload(refs, { mode: "selection" }), "seleccion.pdf");
  }

  function exportEach() {
    const refs = state.selected.size ? selectedRefs() : state.pages;
    if (refs.length) download("/api/split", payload(refs, { mode: "each" }), "hojas.zip");
  }

  // ---------------------------------------------------------------- visor
  function openViewer(uid) {
    state.viewerUid = uid;
    $("#viewer").hidden = false;
    renderViewer();
  }

  function closeViewer() {
    state.viewerUid = null;
    $("#viewer").hidden = true;
    $("#viewer-stage").innerHTML = "";
  }

  function stepViewer(delta) {
    const i = state.pages.findIndex((p) => p.uid === state.viewerUid);
    const next = state.pages[i + delta];
    if (next) {
      state.viewerUid = next.uid;
      selectOnly(next.uid);
      render();
    }
  }

  function renderViewer() {
    const ref = byUid(state.viewerUid);
    if (!ref) return closeViewer();
    const stage = $("#viewer-stage");
    const idx = state.pages.indexOf(ref);
    const doc = state.docs.get(ref.doc_id);
    $("#viewer-title").textContent =
      `Hoja ${idx + 1} de ${state.pages.length} — ${doc.name}, p. ${ref.page + 1}` +
      (ref.scale ? ` (${scaleLabel(ref.scale)})` : "");
    const W = stage.clientWidth - 40;
    const H = stage.clientHeight - 40;
    const lay = layoutSheet(ref, W, H);
    stage.innerHTML = `<div class="sheet"><img alt=""></div>`;
    const sheet = stage.firstElementChild;
    sheet.style.width = `${lay.frameW}px`;
    sheet.style.height = `${lay.frameH}px`;
    const img = sheet.firstElementChild;
    img.src = thumbUrl(ref, Math.max(lay.imgW, lay.imgH));
    img.style.width = `${lay.imgW}px`;
    img.style.height = `${lay.imgH}px`;
    img.style.transform = `translate(-50%, -50%) rotate(${ref.rotation}deg)`;
    $("#viewer-prev").disabled = idx === 0;
    $("#viewer-next").disabled = idx === state.pages.length - 1;
  }

  // ---------------------------------------------------------------- eventos
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) {
      if (e.target === grid) { clearSelection(); render(); }
      return;
    }
    const uid = card.dataset.uid;
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      if (btn.dataset.act === "rotl") rotate([uid], -90);
      else if (btn.dataset.act === "rotr") rotate([uid], 90);
      else if (btn.dataset.act === "del") discard([uid]);
      return;
    }
    if (e.target.classList.contains("card-check") || e.ctrlKey || e.metaKey) toggleSelect(uid);
    else if (e.shiftKey) selectRange(uid);
    else selectOnly(uid);
    render();
  });

  grid.addEventListener("dblclick", (e) => {
    const card = e.target.closest(".card");
    if (card && !e.target.closest("button, input")) openViewer(card.dataset.uid);
  });

  $("#workspace").addEventListener("click", (e) => {
    if (e.target.id === "workspace") { clearSelection(); render(); }
  });

  // Drag & drop para reordenar. Si se arrastra una hoja seleccionada, se mueve
  // toda la selección (manteniendo su orden relativo) a la posición de destino.
  Sortable.create(grid, {
    animation: 150,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    filter: ".card-tools, .card-check",
    preventOnFilter: false,
    onStart(evt) {
      const uid = evt.item.dataset.uid;
      if (state.selected.has(uid) && state.selected.size > 1) {
        for (const sel of state.selected) {
          if (sel !== uid) cardEls.get(sel).classList.add("drag-companion");
        }
      }
    },
    onEnd(evt) {
      document.querySelectorAll(".drag-companion").forEach((el) => el.classList.remove("drag-companion"));
      if (evt.oldIndex === evt.newIndex) return;
      const dragged = evt.item.dataset.uid;
      const domOrder = [...grid.children].map((el) => el.dataset.uid);
      let order = domOrder;
      if (state.selected.has(dragged) && state.selected.size > 1) {
        const others = domOrder.filter((u) => !state.selected.has(u));
        const k = domOrder.slice(0, domOrder.indexOf(dragged)).filter((u) => !state.selected.has(u)).length;
        const group = state.pages.filter((p) => state.selected.has(p.uid)).map((p) => p.uid);
        order = [...others.slice(0, k), ...group, ...others.slice(k)];
      }
      const map = new Map(state.pages.map((p) => [p.uid, p]));
      pushHistory();
      state.pages = order.map((u) => map.get(u));
      render();
    },
  });

  // Botones de la barra
  $("#btn-open").onclick = () => $("#file-input").click();
  $("#file-input").onchange = (e) => {
    if (e.target.files.length) uploadFiles(e.target.files);
    e.target.value = "";
  };
  $("#btn-select-all").onclick = () => { state.selected = new Set(state.pages.map((p) => p.uid)); render(); };
  $("#btn-select-none").onclick = () => { clearSelection(); render(); };
  $("#btn-rot-left").onclick = () => rotate([...state.selected], -90);
  $("#btn-rot-right").onclick = () => rotate([...state.selected], 90);
  $("#btn-delete").onclick = () => discard([...state.selected]);
  $("#btn-duplicate").onclick = () => duplicate([...state.selected]);
  $("#btn-undo").onclick = undo;
  $("#btn-redo").onclick = redo;
  $("#btn-export").onclick = exportAll;
  $("#btn-split-sel").onclick = exportSelection;
  $("#btn-split-each").onclick = exportEach;

  $("#sel-scale").onchange = (e) => {
    const v = e.target.value;
    e.target.value = "";
    const uids = [...state.selected];
    if (v === "none") setScale(uids, null);
    else if (v === "factor") {
      const input = prompt("Escala en porcentaje (10 – 400):", "100");
      if (input === null) return;
      const pct = parseFloat(input.replace(",", "."));
      if (!(pct >= 10 && pct <= 400)) return toast("Porcentaje no válido (10 – 400)", true);
      setScale(uids, { factor: pct / 100 });
    } else setScale(uids, { preset: v });
  };

  $("#zoom").oninput = (e) => {
    state.thumb = +e.target.value;
    document.documentElement.style.setProperty("--thumb", `${state.thumb}px`);
    render();
  };

  // Visor
  $("#viewer-close").onclick = closeViewer;
  $("#viewer-prev").onclick = () => stepViewer(-1);
  $("#viewer-next").onclick = () => stepViewer(1);
  $("#viewer-rot-left").onclick = () => rotate([state.viewerUid], -90);
  $("#viewer-rot-right").onclick = () => rotate([state.viewerUid], 90);
  $("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer-stage") closeViewer(); });
  window.addEventListener("resize", () => { if (state.viewerUid) renderViewer(); });

  // Soltar archivos desde el sistema
  const overlay = $("#drop-overlay");
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) overlay.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    overlay.hidden = true;
    uploadFiles(e.dataTransfer.files);
  });

  // Teclado
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=text], select, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (state.viewerUid) {
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") stepViewer(-1);
      else if (e.key === "ArrowRight") stepViewer(1);
      else if (key === "r" && !mod) rotate([state.viewerUid], e.shiftKey ? -90 : 90);
      else return;
      e.preventDefault();
      return;
    }
    const sel = [...state.selected];
    if (mod && key === "z" && !e.shiftKey) undo();
    else if (mod && (key === "y" || (key === "z" && e.shiftKey))) redo();
    else if (mod && key === "a") { state.selected = new Set(state.pages.map((p) => p.uid)); render(); }
    else if (mod && key === "d") duplicate(sel);
    else if (mod) return;
    else if (e.key === "Delete" || e.key === "Backspace") discard(sel);
    else if (key === "r") rotate(sel, e.shiftKey ? -90 : 90);
    else if (key === "o") $("#file-input").click();
    else if (e.key === "Escape") { clearSelection(); render(); }
    else if (e.key === "Enter" && sel.length === 1) openViewer(sel[0]);
    else return;
    e.preventDefault();
  });

  render();
})();
