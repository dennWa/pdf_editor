/*
 * app.js – Oberfläche des PDF-Editors
 * Alles läuft lokal im Browser, es wird nichts hochgeladen.
 */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  window.PDF_OPTS = {
    standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    cMapUrl: 'vendor/pdfjs/cmaps/',
    cMapPacked: true
  };

  const E = window.Exporter;
  const $ = id => document.getElementById(id);
  const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const CSS_PER_PT = 96 / 72;

  const state = {
    docs: [],
    active: null,
    tool: 'select',
    zoomIdx: 3,
    showEls: true
  };
  let uid = 1;
  const zoom = () => ZOOMS[state.zoomIdx] * CSS_PER_PT;

  /* ------------------------------------------------------------------ *
   *  Kleine Helfer
   * ------------------------------------------------------------------ */
  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 3500);
  }

  function busy(msg) {
    $('busyText').textContent = msg || '';
    $('busy').classList.toggle('hidden', !msg);
  }

  const clone = o => JSON.parse(JSON.stringify(o));
  const el = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  };

  function rgbToHex(c) {
    return '#' + (c || [0, 0, 0]).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
  }

  function baseName(name) {
    return name.replace(/\.(pdf|pdfprojekt)$/i, '');
  }

  const doc = () => state.active;

  /* ------------------------------------------------------------------ *
   *  Dokumente öffnen
   * ------------------------------------------------------------------ */
  async function openFiles(files) {
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      if (/\.pdfprojekt$/i.test(f.name) || buf[0] === 0x7B) {
        await openProject(buf, f.name);
      } else {
        await openPdf(f.name, buf);
      }
    }
  }

  async function openProject(buf, fileName) {
    try {
      const data = JSON.parse(new TextDecoder().decode(buf));
      if (data.app !== 'pdf-editor') throw new Error('kein Projekt');
      const bytes = E.dataUrlBytes('data:;base64,' + data.pdf);
      await openPdf(data.name || fileName, bytes, data);
    } catch (e) {
      console.error(e);
      toast('Die Projektdatei „' + fileName + '“ konnte nicht gelesen werden.');
    }
  }

  async function openPdf(name, bytes, restore) {
    busy('Analysiere „' + name + '“ … (jede Seite wird zerlegt)');
    try {
      const scanner = await PdfScan.open(bytes.slice());
      const d = {
        id: uid++,
        name,
        bytes,
        scanner,
        pages: scanner.pages.map(p => ({ elements: p.elements })),
        deleted: new Set(restore ? restore.deleted : []),
        overlays: restore ? restore.overlays : [],
        images: restore ? restore.images || {} : {},
        undo: [],
        redo: [],
        dirty: false,
        saveTarget: null,
        sel: new Set(),
        view: null,
        pdfjs: null
      };
      state.docs.push(d);
      buildDocView(d);
      await render(d);
      activate(d);
      const counts = d.pages.reduce((n, p) => n + p.elements.length, 0);
      toast(d.pages.length + (d.pages.length === 1 ? ' Seite' : ' Seiten') + ', ' + counts + ' Elemente erkannt.');
    } catch (e) {
      console.error(e);
      if (e.code === 'ENCRYPTED') {
        toast('„' + name + '“ ist mit einem Passwort/Schutz versehen. Diese PDF kann (noch) nicht bearbeitet werden.', 7000);
      } else {
        toast('„' + name + '“ konnte nicht geöffnet werden. Ist es wirklich eine PDF?', 6000);
      }
    } finally {
      busy(null);
    }
  }

  function closeDoc(d) {
    if (d.dirty && !confirm('„' + d.name + '“ hat ungespeicherte Änderungen. Trotzdem schließen?')) return;
    state.docs = state.docs.filter(x => x !== d);
    d.view.remove();
    if (d.pdfjs) d.pdfjs.destroy();
    if (state.active === d) state.active = null;
    activate(state.docs[state.docs.length - 1] || null);
  }

  function activate(d) {
    state.active = d;
    for (const x of state.docs) x.view.classList.toggle('hidden', x !== d);
    $('empty').classList.toggle('hidden', !!d);
    updateDocList();
    updateButtons();
    updateCtx();
  }

  function updateDocList() {
    const ul = $('docList');
    ul.innerHTML = '';
    for (const d of state.docs) {
      const li = el('li', d === state.active ? 'active' : '', ul);
      li.title = d.name;
      if (d.dirty) el('span', 'dirty', li).title = 'Ungespeicherte Änderungen';
      const n = el('span', 'name', li);
      n.textContent = d.name;
      const m = el('span', 'meta', li);
      m.textContent = d.pages.length + ' S.';
      const x = el('button', 'close', li);
      x.textContent = '×';
      x.title = 'Schließen';
      x.onclick = ev => { ev.stopPropagation(); closeDoc(d); };
      li.onclick = () => activate(d);
    }
  }

  function updateButtons() {
    const d = doc();
    $('btnSave').disabled = !d;
    $('btnSaveAs').disabled = !d;
    $('btnUndo').disabled = !d || !d.undo.length;
    $('btnRedo').disabled = !d || !d.redo.length;
    $('zoomLabel').textContent = Math.round(ZOOMS[state.zoomIdx] * 100) + ' %';
  }

  function markDirty(d) {
    if (!d.dirty) { d.dirty = true; updateDocList(); }
  }

  /* ------------------------------------------------------------------ *
   *  Ansicht aufbauen & rendern
   * ------------------------------------------------------------------ */
  function buildDocView(d) {
    d.view = el('div', 'doc-view' + (state.showEls ? ' show-els' : ''), $('docs'));
    d.pages.forEach((p, i) => {
      p.wrap = el('div', 'page', d.view);
      p.wrap.dataset.page = i;
      p.canvas = el('canvas', 'render', p.wrap);
      const num = el('div', 'pnum', p.wrap);
      num.textContent = 'Seite ' + (i + 1);
      p.scaled = el('div', 'layer', p.wrap); // wird per CSS skaliert, Koordinaten in pt
      p.scaled.style.transformOrigin = '0 0';
      p.elLayer = el('div', 'layer el-layer', p.scaled);
      p.ovLayer = el('div', 'layer ov-layer', p.scaled);
      attachPageEvents(d, p, i);
    });
  }

  async function currentBytes(d) {
    if (!d.deleted.size) return d.bytes;
    d.scanner.applyDeletions(d.deleted);
    return d.scanner.doc.save({ useObjectStreams: false });
  }

  async function render(d) {
    const token = (d.renderToken = (d.renderToken || 0) + 1);
    const bytes = await currentBytes(d);
    const pdf = await pdfjsLib.getDocument(Object.assign({ data: bytes.slice() }, window.PDF_OPTS)).promise;
    if (token !== d.renderToken) { pdf.destroy(); return; }
    const old = d.pdfjs;
    d.pdfjs = pdf;
    for (let i = 0; i < d.pages.length; i++) {
      const p = d.pages[i];
      const page = await pdf.getPage(i + 1);
      if (!p.vp1) {
        p.vp1 = page.getViewport({ scale: 1 });
        layoutElements(d, p);
      }
      await drawPage(d, p, page, token);
      if (token !== d.renderToken) break;
    }
    if (old) old.destroy();
    refreshElementState(d);
    renderOverlays(d);
  }

  async function drawPage(d, p, page, token) {
    const z = zoom();
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: z * dpr });
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
    if (token !== d.renderToken) return;
    const w = p.vp1.width * z, h = p.vp1.height * z;
    p.wrap.style.width = w + 'px';
    p.wrap.style.height = h + 'px';
    p.canvas.width = off.width;
    p.canvas.height = off.height;
    p.canvas.style.width = w + 'px';
    p.canvas.style.height = h + 'px';
    p.canvas.getContext('2d').drawImage(off, 0, 0);
    p.scaled.style.width = p.vp1.width + 'px';
    p.scaled.style.height = p.vp1.height + 'px';
    p.scaled.style.transform = 'scale(' + z + ')';
  }

  async function rezoom() {
    const d = doc();
    updateButtons();
    if (!d) return;
    for (const x of state.docs) x.renderToken = (x.renderToken || 0) + 1;
    const token = d.renderToken;
    for (let i = 0; i < d.pages.length; i++) {
      const page = await d.pdfjs.getPage(i + 1);
      await drawPage(d, d.pages[i], page, token);
      if (token !== d.renderToken) return;
    }
    // andere Dokumente beim nächsten Anzeigen neu zeichnen
    for (const x of state.docs) if (x !== d) render(x);
  }

  // Elemente in Bildschirm-Koordinaten (pt, Seite gedreht wie angezeigt) umrechnen
  function layoutElements(d, p) {
    p.elDivs = new Map();
    for (const e of p.elements) {
      const r = p.vp1.convertToViewportRectangle(e.bbox);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
      e.r = [x, y, Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])];
      if (e.kind === 'text') {
        const o = p.vp1.convertToViewportPoint(e.origin[0], e.origin[1]);
        const t = p.vp1.convertToViewportPoint(e.end[0], e.end[1]);
        e.vorigin = o;
        e.vang = Math.atan2(t[1] - o[1], t[0] - o[0]);
      }
      const div = el('div', 'el ' + e.kind + (e.wm ? ' wm' : ''), p.elLayer);
      div.style.left = (x - 1) + 'px';
      div.style.top = (y - 1) + 'px';
      div.style.width = Math.max(e.r[2], 2) + 2 + 'px';
      div.style.height = Math.max(e.r[3], 2) + 2 + 'px';
      p.elDivs.set(e.id, div);
    }
  }

  const isDeleted = (d, e) => e.keys.every(k => d.deleted.has(k));

  function refreshElementState(d) {
    for (const p of d.pages) {
      if (!p.elDivs) continue;
      for (const e of p.elements) {
        const div = p.elDivs.get(e.id);
        div.classList.toggle('deleted', isDeleted(d, e));
        div.classList.toggle('sel', d.sel.has('e' + e.id));
      }
    }
  }

  /* ------------------------------------------------------------------ *
   *  Eigene Ebenen (eingefügter Text, Bilder, Unterschriften)
   * ------------------------------------------------------------------ */
  function renderOverlays(d) {
    for (const p of d.pages) p.ovLayer.innerHTML = '';
    for (const ov of d.overlays) {
      const p = d.pages[ov.page];
      if (!p) continue;
      const div = el('div', 'ov ' + ov.type + (d.sel.has('o' + ov.id) ? ' sel' : ''), p.ovLayer);
      div.dataset.ov = ov.id;
      div.style.left = ov.x + 'px';
      div.style.top = ov.y + 'px';
      if (ov.type === 'text') {
        styleText(div, ov);
        div.textContent = ov.text;
      } else {
        div.style.width = ov.w + 'px';
        div.style.height = ov.h + 'px';
        const img = el('img', '', div);
        img.src = d.images[ov.img];
        img.draggable = false;
      }
      el('div', 'handle', div);
    }
  }

  function styleText(div, ov) {
    div.style.fontFamily = E.FONT_CSS[ov.family];
    div.style.fontSize = ov.size + 'px';
    div.style.color = ov.color;
    div.style.fontWeight = ov.bold ? '700' : '400';
    div.style.fontStyle = ov.italic ? 'italic' : 'normal';
  }

  const ovById = (d, id) => d.overlays.find(o => o.id === +id);
  const ovDiv = (d, ov) => d.pages[ov.page].ovLayer.querySelector('[data-ov="' + ov.id + '"]');

  function nextOvId(d) {
    return d.overlays.reduce((m, o) => Math.max(m, o.id), 0) + 1;
  }

  /* ------------------------------------------------------------------ *
   *  Rückgängig / Wiederholen
   * ------------------------------------------------------------------ */
  function snapshot(d) {
    return { deleted: [...d.deleted], overlays: clone(d.overlays.filter(o => o.type !== 'text' || o.text.trim())) };
  }

  function pushUndo(d) {
    d.undo.push(snapshot(d));
    if (d.undo.length > 150) d.undo.shift();
    d.redo = [];
    markDirty(d);
    updateButtons();
  }

  async function restore(d, snap) {
    const delChanged = snap.deleted.length !== d.deleted.size || snap.deleted.some(k => !d.deleted.has(k));
    d.deleted = new Set(snap.deleted);
    d.overlays = snap.overlays;
    d.sel.clear();
    markDirty(d);
    updateButtons();
    updateCtx();
    if (delChanged) await render(d);
    else { refreshElementState(d); renderOverlays(d); }
  }

  async function undo() {
    const d = doc();
    if (!d || !d.undo.length) return;
    commitEditing();
    d.redo.push(snapshot(d));
    await restore(d, d.undo.pop());
  }

  async function redo() {
    const d = doc();
    if (!d || !d.redo.length) return;
    d.undo.push(snapshot(d));
    await restore(d, d.redo.pop());
  }

  /* ------------------------------------------------------------------ *
   *  Auswahl
   * ------------------------------------------------------------------ */
  function setSel(d, keys, add) {
    if (!add) d.sel.clear();
    for (const k of keys) {
      if (add && d.sel.has(k) && keys.length === 1) d.sel.delete(k);
      else d.sel.add(k);
    }
    refreshElementState(d);
    for (const p of d.pages) {
      p.ovLayer.querySelectorAll('.ov').forEach(div => div.classList.toggle('sel', d.sel.has('o' + div.dataset.ov)));
    }
    updateCtx();
  }

  function selectedElements(d) {
    const out = [];
    for (const p of d.pages) for (const e of p.elements) if (d.sel.has('e' + e.id)) out.push(e);
    return out;
  }

  function selectedOverlays(d) {
    return d.overlays.filter(o => d.sel.has('o' + o.id));
  }

  // Kleinstes Element unter dem Punkt
  function hitTest(d, p, x, y) {
    let best = null, bestArea = Infinity;
    const pad = 2;
    const prio = { text: 0, image: 1, annot: 2, form: 2, path: 3 };
    for (const e of p.elements) {
      if (isDeleted(d, e)) continue;
      const [ex, ey, ew, eh] = e.r;
      if (x < ex - pad || x > ex + ew + pad || y < ey - pad || y > ey + eh + pad) continue;
      const area = Math.max(ew, 6) * Math.max(eh, 6) * (1 + prio[e.kind] * 0.15);
      if (area < bestArea) { best = e; bestArea = area; }
    }
    return best;
  }

  async function deleteSelection() {
    const d = doc();
    if (!d || !d.sel.size) return;
    const els = selectedElements(d);
    const ovs = selectedOverlays(d);
    pushUndo(d);
    for (const e of els) e.keys.forEach(k => d.deleted.add(k));
    d.overlays = d.overlays.filter(o => !ovs.includes(o));
    d.sel.clear();
    updateCtx();
    if (els.length) {
      busy('Entferne …');
      try { await render(d); } finally { busy(null); }
    } else {
      renderOverlays(d);
    }
  }

  // Originaltext in bearbeitbaren Text umwandeln
  async function editOriginalText(d, e) {
    pushUndo(d);
    e.keys.forEach(k => d.deleted.add(k));
    const fam = e.style.family;
    const size = Math.round(e.size * 10) / 10;
    const base = e.vorigin || [e.r[0], e.r[1] + e.r[3] * 0.8];
    const ov = {
      id: nextOvId(d),
      page: e.page,
      type: 'text',
      x: base[0],
      y: base[1] - E.BASELINE[fam] * size,
      text: e.text.trim(),
      size,
      family: fam,
      bold: !!e.style.bold,
      italic: !!e.style.italic,
      color: rgbToHex(e.color)
    };
    d.overlays.push(ov);
    d.sel.clear();
    d.sel.add('o' + ov.id);
    await render(d);
    updateCtx();
    startEditing(d, ov, true);
  }

  /* ------------------------------------------------------------------ *
   *  Text direkt bearbeiten
   * ------------------------------------------------------------------ */
  let editing = null; // {d, ov, div, before}

  function startEditing(d, ov, selectAll) {
    commitEditing();
    const div = ovDiv(d, ov);
    if (!div) return;
    try { div.contentEditable = 'plaintext-only'; } catch (e) { div.contentEditable = 'true'; }
    if (div.contentEditable !== 'plaintext-only') div.contentEditable = 'true';
    editing = { d, ov, div, before: ov.text };
    div.focus();
    const range = document.createRange();
    range.selectNodeContents(div);
    if (!selectAll) range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    div.addEventListener('blur', commitEditing, { once: true });
    div.addEventListener('input', () => {
      ov.text = div.innerText.replace(/\n$/, '');
    });
  }

  function commitEditing() {
    if (!editing) return;
    const { d, ov, div, before } = editing;
    editing = null;
    div.contentEditable = 'false';
    const text = div.innerText.replace(/\r/g, '').replace(/\n$/, '');
    ov.text = before;
    if (text !== before) {
      pushUndo(d);
      ov.text = text;
    }
    if (!ov.text.trim()) {
      d.overlays = d.overlays.filter(o => o !== ov);
      d.sel.delete('o' + ov.id);
      updateCtx();
    }
    renderOverlays(d);
  }

  /* ------------------------------------------------------------------ *
   *  Maus / Zeiger auf einer Seite
   * ------------------------------------------------------------------ */
  function pagePoint(p, ev) {
    const r = p.wrap.getBoundingClientRect();
    const z = zoom();
    return [(ev.clientX - r.left) / z, (ev.clientY - r.top) / z];
  }

  function attachPageEvents(d, p, pageIndex) {
    let drag = null;
    let hoverDiv = null;

    p.wrap.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      if (editing && editing.div.contains(ev.target)) return;
      commitEditing();
      const [x, y] = pagePoint(p, ev);
      const ovEl = ev.target.closest('.ov');

      if (state.tool === 'text' && !ovEl) {
        ev.preventDefault();
        const size = 11;
        const ov = {
          id: nextOvId(d), page: pageIndex, type: 'text', x, y: y - size * 0.6, text: '', size,
          family: 'sans', bold: false, italic: false, color: '#000000'
        };
        d.overlays.push(ov);
        markDirty(d);
        setTool('select');
        d.sel.clear();
        d.sel.add('o' + ov.id);
        renderOverlays(d);
        updateCtx();
        startEditing(d, ov);
        return;
      }

      if (ovEl) {
        ev.preventDefault();
        const ov = ovById(d, ovEl.dataset.ov);
        const key = 'o' + ov.id;
        if (ev.shiftKey) setSel(d, [key], true);
        else if (!d.sel.has(key)) setSel(d, [key]);
        const moving = selectedOverlays(d);
        drag = {
          type: ev.target.classList.contains('handle') ? 'resize' : 'move',
          start: [x, y],
          ov,
          orig: moving.map(o => ({ o, x: o.x, y: o.y, w: o.w, h: o.h, size: o.size })),
          pushed: false
        };
        p.wrap.setPointerCapture(ev.pointerId);
        return;
      }

      drag = { type: 'band', start: [x, y], band: null, shift: ev.shiftKey };
      p.wrap.setPointerCapture(ev.pointerId);
    });

    p.wrap.addEventListener('pointermove', ev => {
      const [x, y] = pagePoint(p, ev);
      if (!drag) {
        // Hover-Hervorhebung
        let div = null;
        if (state.tool === 'select' && !ev.target.closest('.ov')) {
          const e = hitTest(d, p, x, y);
          if (e) div = p.elDivs.get(e.id);
        }
        if (div !== hoverDiv) {
          if (hoverDiv) hoverDiv.classList.remove('hover');
          if (div) div.classList.add('hover');
          hoverDiv = div;
        }
        return;
      }
      const dx = x - drag.start[0], dy = y - drag.start[1];
      if (drag.type === 'band') {
        if (!drag.band && Math.hypot(dx, dy) * zoom() < 4) return;
        if (!drag.band) drag.band = el('div', 'band', p.scaled);
        const bx = Math.min(x, drag.start[0]), by = Math.min(y, drag.start[1]);
        Object.assign(drag.band.style, {
          left: bx + 'px', top: by + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px'
        });
        return;
      }
      if (!drag.pushed) {
        if (Math.hypot(dx, dy) * zoom() < 2) return;
        d.undo.push({ deleted: [...d.deleted], overlays: clone(d.overlays.map(o => {
          const st = drag.orig.find(s => s.o === o);
          return st ? Object.assign({}, o, { x: st.x, y: st.y, w: st.w, h: st.h, size: st.size }) : o;
        })) });
        d.redo = [];
        markDirty(d);
        updateButtons();
        drag.pushed = true;
      }
      if (drag.type === 'move') {
        for (const s of drag.orig) {
          s.o.x = s.x + dx;
          s.o.y = s.y + dy;
          const div = ovDiv(d, s.o);
          if (div) { div.style.left = s.o.x + 'px'; div.style.top = s.o.y + 'px'; }
        }
      } else {
        const s = drag.orig.find(t => t.o === drag.ov) || { o: drag.ov, w: drag.ov.w, h: drag.ov.h, size: drag.ov.size };
        const o = s.o;
        const div = ovDiv(d, o);
        if (o.type === 'image') {
          const ratio = s.h / s.w;
          o.w = Math.max(10, s.w + dx);
          o.h = o.w * ratio;
          if (div) { div.style.width = o.w + 'px'; div.style.height = o.h + 'px'; }
        } else {
          const box = div.getBoundingClientRect();
          const wPt = box.width / zoom();
          const f = Math.max(0.2, (wPt + dx) / Math.max(wPt, 1));
          o.size = Math.max(3, Math.round(s.size * Math.min(f, 4) * 10) / 10);
          if (div) div.style.fontSize = o.size + 'px';
        }
      }
    });

    const finish = ev => {
      if (!drag) return;
      const dr = drag;
      drag = null;
      const [x, y] = pagePoint(p, ev);
      if (dr.type === 'band') {
        if (dr.band) {
          dr.band.remove();
          const x0 = Math.min(x, dr.start[0]), x1 = Math.max(x, dr.start[0]);
          const y0 = Math.min(y, dr.start[1]), y1 = Math.max(y, dr.start[1]);
          const keys = [];
          for (const e of p.elements) {
            if (isDeleted(d, e)) continue;
            const [ex, ey, ew, eh] = e.r;
            if (ex >= x0 - 1 && ey >= y0 - 1 && ex + ew <= x1 + 1 && ey + eh <= y1 + 1) keys.push('e' + e.id);
          }
          for (const o of d.overlays) {
            if (o.page !== pageIndex) continue;
            if (o.x >= x0 && o.y >= y0 && o.x <= x1 && o.y <= y1) keys.push('o' + o.id);
          }
          setSel(d, keys, dr.shift);
          if (keys.length) toast(keys.length + ' Elemente ausgewählt – Entf zum Löschen.', 2500);
        } else {
          const e = hitTest(d, p, x, y);
          if (e) setSel(d, ['e' + e.id], dr.shift);
          else if (!dr.shift) setSel(d, []);
        }
      } else if (dr.pushed) {
        updateCtx();
      }
    };
    p.wrap.addEventListener('pointerup', finish);
    p.wrap.addEventListener('pointercancel', finish);
    p.wrap.addEventListener('pointerleave', () => {
      if (hoverDiv) { hoverDiv.classList.remove('hover'); hoverDiv = null; }
    });

    p.wrap.addEventListener('dblclick', ev => {
      const ovEl = ev.target.closest('.ov');
      if (ovEl) {
        const ov = ovById(d, ovEl.dataset.ov);
        if (ov.type === 'text') startEditing(d, ov);
        return;
      }
      const [x, y] = pagePoint(p, ev);
      const e = hitTest(d, p, x, y);
      if (e && e.kind === 'text') editOriginalText(d, e);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Kontextleiste
   * ------------------------------------------------------------------ */
  function updateCtx() {
    const bar = $('ctxbar');
    const d = doc();
    bar.innerHTML = '';
    if (!d || !d.sel.size) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const els = selectedElements(d);
    const ovs = selectedOverlays(d);
    const btn = (label, fn, cls, title) => {
      const b = el('button', cls || '', bar);
      b.textContent = label;
      if (title) b.title = title;
      b.onclick = fn;
      return b;
    };

    if (ovs.length === 1 && !els.length && ovs[0].type === 'text') {
      const ov = ovs[0];
      const change = fn => () => { pushUndo(d); fn(); renderOverlays(d); };
      const fam = el('select', '', bar);
      [['sans', 'Helvetica / Arial'], ['serif', 'Times'], ['mono', 'Courier']].forEach(([v, l]) => {
        const o = el('option', '', fam);
        o.value = v; o.textContent = l;
      });
      fam.value = ov.family;
      fam.onchange = change(() => { ov.family = fam.value; });
      const size = el('input', '', bar);
      size.type = 'number'; size.min = 3; size.max = 300; size.step = 0.5; size.value = ov.size;
      size.title = 'Schriftgröße (pt)';
      size.onchange = change(() => { ov.size = Math.max(3, +size.value || ov.size); });
      const b = btn('F', change(() => { ov.bold = !ov.bold; updateCtx(); }), ov.bold ? 'active' : '', 'Fett');
      b.style.fontWeight = '700';
      const it = btn('K', change(() => { ov.italic = !ov.italic; updateCtx(); }), ov.italic ? 'active' : '', 'Kursiv');
      it.style.fontStyle = 'italic';
      const col = el('input', '', bar);
      col.type = 'color'; col.value = ov.color; col.title = 'Farbe';
      col.onchange = change(() => { ov.color = col.value; });
      btn('Bearbeiten', () => startEditing(d, ov));
      btn('Löschen', deleteSelection, 'danger');
      return;
    }

    const info = el('span', 'info', bar);
    if (els.length === 1 && !ovs.length) {
      const e = els[0];
      const names = { text: 'Text', image: 'Bild', path: 'Grafik/Linie', annot: 'Anmerkung', form: 'Wasserzeichen-Gruppe' };
      info.textContent = (e.wm ? 'Mögliches Wasserzeichen · ' : '') + names[e.kind] +
        (e.kind === 'text' ? ': „' + e.text.trim() + '“' : '') +
        (e.kind === 'annot' && e.sub ? ' (' + e.sub + ')' : '');
      if (e.kind === 'text') btn('Text ändern', () => editOriginalText(d, e), 'primary');
    } else {
      info.textContent = (els.length + ovs.length) + ' Elemente ausgewählt';
    }
    btn('Löschen', deleteSelection, 'danger', 'Entfernen (Entf)');
    btn('Abwählen', () => setSel(d, []));
  }

  /* ------------------------------------------------------------------ *
   *  Werkzeuge
   * ------------------------------------------------------------------ */
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    document.body.classList.toggle('tool-text', t === 'text');
  }

  // Seite, die gerade am meisten sichtbar ist
  function visiblePage(d) {
    const main = $('main').getBoundingClientRect();
    let best = 0, bestVis = -1;
    d.pages.forEach((p, i) => {
      const r = p.wrap.getBoundingClientRect();
      const vis = Math.min(r.bottom, main.bottom) - Math.max(r.top, main.top);
      if (vis > bestVis) { bestVis = vis; best = i; }
    });
    return best;
  }

  function insertImage(dataUrl, natW, natH, targetW) {
    const d = doc();
    if (!d) return;
    const pi = visiblePage(d);
    const p = d.pages[pi];
    const w = Math.min(targetW, p.vp1.width * 0.6);
    const h = w * natH / natW;
    const main = $('main').getBoundingClientRect();
    const r = p.wrap.getBoundingClientRect();
    const z = zoom();
    const cy = Math.max(0, Math.min(p.vp1.height - h, ((main.top + main.bottom) / 2 - r.top) / z - h / 2));
    pushUndo(d);
    const imgId = 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    d.images[imgId] = dataUrl;
    const ov = { id: nextOvId(d), page: pi, type: 'image', x: (p.vp1.width - w) / 2, y: cy, w, h, img: imgId };
    d.overlays.push(ov);
    d.sel.clear();
    d.sel.add('o' + ov.id);
    renderOverlays(d);
    updateCtx();
    toast('Eingefügt – zum Verschieben ziehen, unten rechts an der Ecke die Größe ändern.');
  }

  // Bild-Dialog
  let pendingImg = null;
  function loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        pendingImg = { img, url: reader.result, type: file.type };
        drawImagePreview();
        $('dlgImage').showModal();
      };
      img.onerror = () => toast('Das Bild konnte nicht gelesen werden.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function processedImage() {
    const { img } = pendingImg;
    const max = 1600;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    if ($('chkWhite').checked) {
      const data = g.getImageData(0, 0, c.width, c.height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (l > 235) px[i + 3] = 0;
        else if (l > 190) px[i + 3] = Math.round(px[i + 3] * (235 - l) / 45);
      }
      g.putImageData(data, 0, 0);
    }
    return c;
  }

  function drawImagePreview() {
    const c = processedImage();
    const prev = $('imgPrev');
    prev.width = c.width;
    prev.height = c.height;
    prev.getContext('2d').drawImage(c, 0, 0);
  }

  // Unterschrift zeichnen
  const pad = { strokes: [], cur: null };
  function setupSignPad() {
    const c = $('signPad');
    const g = c.getContext('2d');
    const redraw = () => {
      g.clearRect(0, 0, c.width, c.height);
      g.strokeStyle = '#dde1e8';
      g.beginPath(); g.moveTo(30, 160); g.lineTo(570, 160); g.stroke();
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of pad.strokes) {
        g.strokeStyle = s.color; g.lineWidth = s.width;
        g.beginPath();
        s.pts.forEach(([x, y], i) => {
          if (i === 0) g.moveTo(x, y);
          else {
            const [px, py] = s.pts[i - 1];
            g.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
          }
        });
        if (s.pts.length === 1) g.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
        g.stroke();
      }
    };
    pad.redraw = redraw;
    const pos = ev => {
      const r = c.getBoundingClientRect();
      return [(ev.clientX - r.left) * c.width / r.width, (ev.clientY - r.top) * c.height / r.height];
    };
    c.addEventListener('pointerdown', ev => {
      c.setPointerCapture(ev.pointerId);
      pad.cur = { color: $('signColor').value, width: +$('signWidth').value, pts: [pos(ev)] };
      pad.strokes.push(pad.cur);
      redraw();
    });
    c.addEventListener('pointermove', ev => {
      if (!pad.cur) return;
      pad.cur.pts.push(pos(ev));
      redraw();
    });
    const end = () => { pad.cur = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    $('signClear').onclick = () => { pad.strokes = []; redraw(); };
    $('dlgSign').addEventListener('close', () => {
      if ($('dlgSign').returnValue !== 'ok' || !pad.strokes.length) return;
      // auf die gezeichnete Fläche zuschneiden, in doppelter Auflösung
      const pts = pad.strokes.flatMap(s => s.pts);
      const m = Math.max(...pad.strokes.map(s => s.width)) + 2;
      const x0 = Math.max(0, Math.min(...pts.map(p => p[0])) - m), y0 = Math.max(0, Math.min(...pts.map(p => p[1])) - m);
      const x1 = Math.min(c.width, Math.max(...pts.map(p => p[0])) + m), y1 = Math.min(c.height, Math.max(...pts.map(p => p[1])) + m);
      const out = document.createElement('canvas');
      out.width = Math.max(1, (x1 - x0) * 2);
      out.height = Math.max(1, (y1 - y0) * 2);
      const og = out.getContext('2d');
      og.scale(2, 2);
      og.translate(-x0, -y0);
      og.lineCap = 'round'; og.lineJoin = 'round';
      for (const s of pad.strokes) {
        og.strokeStyle = s.color; og.lineWidth = s.width;
        og.beginPath();
        s.pts.forEach(([x, y], i) => {
          if (i === 0) og.moveTo(x, y);
          else {
            const [px, py] = s.pts[i - 1];
            og.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
          }
        });
        if (s.pts.length === 1) og.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
        og.stroke();
      }
      insertImage(out.toDataURL('image/png'), out.width, out.height, Math.min(180, (x1 - x0) * 0.45));
    });
  }

  function findWatermarks() {
    const d = doc();
    if (!d) return;
    const keys = [];
    let first = null;
    for (const p of d.pages) {
      for (const e of p.elements) {
        if (e.wm && !isDeleted(d, e)) {
          keys.push('e' + e.id);
          if (!first) first = p.elDivs.get(e.id);
        }
      }
    }
    setSel(d, keys);
    if (keys.length) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast(keys.length + ' mögliche Wasserzeichen markiert. Prüfen und mit Entf löschen.', 5000);
    } else {
      toast('Keine eindeutigen Wasserzeichen gefunden. Einfach anklicken oder per Rahmen markieren und löschen.', 5000);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Speichern
   * ------------------------------------------------------------------ */
  const FORMATS = {
    pdf: { ext: 'pdf', mime: 'application/pdf', desc: 'PDF-Dokument' },
    docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', desc: 'Word-Dokument' },
    png: { ext: 'png', mime: 'image/png', desc: 'PNG-Bild' },
    jpg: { ext: 'jpg', mime: 'image/jpeg', desc: 'JPG-Bild' },
    pdfprojekt: { ext: 'pdfprojekt', mime: 'application/json', desc: 'PDF-Editor-Projekt' }
  };

  async function produce(d, fmt, base) {
    if (fmt === 'pdf') return { blob: new Blob([await E.pdf(d)], { type: FORMATS.pdf.mime }), ext: 'pdf' };
    if (fmt === 'docx') return { blob: await E.docx(d), ext: 'docx' };
    if (fmt === 'png' || fmt === 'jpg') return E.images(d, fmt, base);
    return { blob: E.project(d), ext: 'pdfprojekt' };
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function writeOut(d, fmt, base, handle) {
    busy('Speichere …');
    try {
      const res = await produce(d, fmt, base);
      if (handle) {
        const w = await handle.createWritable();
        await w.write(res.blob);
        await w.close();
      } else {
        download(res.blob, base + '.' + res.ext);
      }
      d.dirty = false;
      updateDocList();
      toast('Gespeichert: ' + (handle ? handle.name : base + '.' + res.ext));
      return true;
    } catch (e) {
      console.error(e);
      toast('Speichern fehlgeschlagen: ' + (e.message || e), 6000);
      return false;
    } finally {
      busy(null);
    }
  }

  function saveAs() {
    const d = doc();
    if (!d) return;
    commitEditing();
    const dlg = $('dlgSave');
    const target = d.saveTarget;
    $('saveName').value = target ? target.base : baseName(d.name) + '_bearbeitet';
    const fmt = target ? target.fmt : 'pdf';
    dlg.querySelectorAll('input[name=fmt]').forEach(r => { r.checked = r.value === fmt; });
    dlg.returnValue = '';
    dlg.showModal();
  }

  async function onSaveDialogClosed() {
    const d = doc();
    const dlg = $('dlgSave');
    if (!d || dlg.returnValue !== 'ok') return;
    const fmt = dlg.querySelector('input[name=fmt]:checked').value;
    const base = ($('saveName').value.trim() || baseName(d.name)).replace(/\.(pdf|docx|png|jpg|zip|pdfprojekt)$/i, '');
    const f = FORMATS[fmt];
    let handle = null;
    const multiImg = (fmt === 'png' || fmt === 'jpg') && d.pages.length > 1;
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: base + '.' + (multiImg ? 'zip' : f.ext),
          types: [multiImg ? { description: 'ZIP-Archiv', accept: { 'application/zip': ['.zip'] } }
            : { description: f.desc, accept: { [f.mime]: ['.' + f.ext] } }]
        });
      } catch (e) {
        if (e.name === 'AbortError') return;
        handle = null;
      }
    }
    if (await writeOut(d, fmt, base, handle)) {
      d.saveTarget = { fmt, base: handle ? handle.name.replace(/\.[^.]+$/, '') : base, handle };
    }
  }

  async function save() {
    const d = doc();
    if (!d) return;
    commitEditing();
    const t = d.saveTarget;
    if (!t) return saveAs();
    if (t.handle && t.handle.requestPermission) {
      const perm = await t.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return saveAs();
    }
    await writeOut(d, t.fmt, t.base, t.handle);
  }

  /* ------------------------------------------------------------------ *
   *  Verdrahtung
   * ------------------------------------------------------------------ */
  function init() {
    E.measureBaselines();
    setupSignPad();

    const pick = () => $('fileInput').click();
    $('btnOpen').onclick = pick;
    $('btnAdd').onclick = pick;
    $('empty').onclick = pick;
    $('fileInput').onchange = async ev => {
      const files = [...ev.target.files];
      ev.target.value = '';
      await openFiles(files);
    };

    // Klick neben die Seiten hebt die Auswahl auf
    $('main').addEventListener('pointerdown', ev => {
      if (ev.target.closest('.page') || !doc()) return;
      commitEditing();
      setSel(doc(), []);
    });

    $('btnSave').onclick = save;
    $('btnSaveAs').onclick = saveAs;
    $('dlgSave').addEventListener('close', onSaveDialogClosed);
    $('btnUndo').onclick = undo;
    $('btnRedo').onclick = redo;

    document.querySelectorAll('#tools [data-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });
    $('btnImage').onclick = () => { if (doc()) $('imgInput').click(); else toast('Öffne zuerst eine PDF.'); };
    $('imgInput').onchange = ev => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (f) loadImageFile(f);
    };
    $('chkWhite').onchange = drawImagePreview;
    $('dlgImage').addEventListener('close', () => {
      if ($('dlgImage').returnValue !== 'ok' || !pendingImg) return;
      const c = processedImage();
      const keepJpeg = !$('chkWhite').checked && pendingImg.type === 'image/jpeg';
      const url = keepJpeg ? pendingImg.url : c.toDataURL('image/png');
      insertImage(url, c.width, c.height, 200);
      pendingImg = null;
    });
    $('btnSign').onclick = () => {
      if (!doc()) { toast('Öffne zuerst eine PDF.'); return; }
      pad.strokes = [];
      pad.redraw();
      $('dlgSign').returnValue = '';
      $('dlgSign').showModal();
    };
    $('btnWm').onclick = findWatermarks;
    $('chkShow').onchange = ev => {
      state.showEls = ev.target.checked;
      for (const d of state.docs) d.view.classList.toggle('show-els', state.showEls);
    };
    $('btnZoomIn').onclick = () => { if (state.zoomIdx < ZOOMS.length - 1) { state.zoomIdx++; rezoom(); } };
    $('btnZoomOut').onclick = () => { if (state.zoomIdx > 0) { state.zoomIdx--; rezoom(); } };
    $('main').addEventListener('wheel', ev => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const n = state.zoomIdx + (ev.deltaY < 0 ? 1 : -1);
      if (n >= 0 && n < ZOOMS.length) { state.zoomIdx = n; rezoom(); }
    }, { passive: false });

    // Drag & Drop
    let dragDepth = 0;
    window.addEventListener('dragenter', ev => { ev.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', ev => ev.preventDefault());
    window.addEventListener('drop', ev => {
      ev.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      const files = [...ev.dataTransfer.files];
      const imgs = files.filter(f => f.type.startsWith('image/'));
      const docs = files.filter(f => !f.type.startsWith('image/'));
      if (docs.length) openFiles(docs);
      if (imgs.length && doc()) loadImageFile(imgs[0]);
    });

    // Tastatur
    document.addEventListener('keydown', ev => {
      const inField = editing || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName) || document.querySelector('dialog[open]');
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      if (mod && k === 's') { ev.preventDefault(); if (ev.shiftKey) saveAs(); else save(); return; }
      if (mod && k === 'o') { ev.preventDefault(); pick(); return; }
      if (inField) {
        if (editing && ev.key === 'Escape') { editing.div.blur(); }
        return;
      }
      if (mod && k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
      if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) { ev.preventDefault(); redo(); return; }
      const d = doc();
      if (!d) return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelection(); return; }
      if (ev.key === 'Escape') { setSel(d, []); setTool('select'); return; }
      if (!mod && k === 'v') setTool('select');
      if (!mod && k === 't') setTool('text');
      if (ev.key.startsWith('Arrow')) {
        const ovs = selectedOverlays(d);
        if (!ovs.length) return;
        ev.preventDefault();
        const step = ev.shiftKey ? 10 : 1;
        pushUndo(d);
        for (const o of ovs) {
          if (ev.key === 'ArrowLeft') o.x -= step;
          if (ev.key === 'ArrowRight') o.x += step;
          if (ev.key === 'ArrowUp') o.y -= step;
          if (ev.key === 'ArrowDown') o.y += step;
        }
        renderOverlays(d);
      }
    });

    // Warnung vor dem Schließen
    window.addEventListener('beforeunload', ev => {
      if (state.docs.some(d => d.dirty)) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });

    updateButtons();
  }

  init();
})();
