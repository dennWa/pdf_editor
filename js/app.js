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
        edits: restore && restore.edits ? restore.edits : {}, // Element-ID -> neuer Text (Originalschrift)
        covered: new Set(restore && restore.covered ? restore.covered : []), // übermalte Scan-Texte
        ocr: restore && restore.ocr ? restore.ocr : {},
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
      d.glyphs = restore && restore.glyphs ? restore.glyphs : {};
      for (const [pi, list] of Object.entries(d.ocr)) {
        if (d.pages[pi]) d.pages[pi].elements.push(...list.map(ocrElement));
      }
      registerVector(d);
      buildDocView(d);
      await render(d);
      activate(d);
      const auto = pagesNeedingOcr(d);
      if (auto.length) {
        busy(null);
        await runOcr(d, auto, true);
        return;
      }
      const counts = d.pages.reduce((n, p) => n + p.elements.filter(e => !e.absorbed).length, 0);
      const msg = d.pages.length + (d.pages.length === 1 ? ' Seite' : ' Seiten') + ', ' + counts + ' Elemente erkannt.';
      const scan = scanHint(d);
      toast(scan ? msg + ' ' + scan : msg, scan ? 9000 : 3500);
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

  // Gespeicherte Texterkennungs-Ergebnisse wieder zu Elementen machen
  function ocrElement(o) {
    return {
      id: o.id, page: o.page, kind: 'text', ocr: true, vector: !!o.vector, keys: o.keys || [], r: o.r.slice(),
      text: o.text, size: o.size, vorigin: o.vorigin,
      style: { family: 'sans', bold: false, italic: false, name: null }, color: o.color || [0, 0, 0], wm: false, vang: 0
    };
  }

  // Erkannten Grafik-Text beim Scanner anmelden und die einzelnen Buchstaben-Zeichnungen ausblenden
  function registerVector(d) {
    const vec = new Map();
    const absorbed = new Set();
    for (const list of Object.values(d.ocr)) {
      for (const o of list) {
        if (!o.vector) continue;
        vec.set(o.id, {
          keys: o.keys, page: o.page, x: o.x, baseline: o.baseline, size: o.size, color: o.color, space: o.space,
          weight: o.weight, chars: o.chars, text: o.text
        });
        o.absorbed.forEach(id => absorbed.add(id));
      }
    }
    const glyphs = new Map(Object.entries(d.glyphs || {}));
    d.scanner.setVectorText(vec, glyphs);
    for (const p of d.pages) for (const e of p.elements) if (e.kind === 'path') e.absorbed = absorbed.has(e.id);
  }

  // Seiten ohne echten Text, aber mit Buchstaben-Grafiken oder Scan-Bild
  function pagesNeedingOcr(d) {
    const out = [];
    d.pages.forEach((p, i) => {
      if (d.ocr[i]) return;
      const W = p.vp1.width, H = p.vp1.height;
      const real = p.elements.filter(e => e.kind === 'text' && !e.ocr).length;
      const glyphLike = p.elements.filter(isGlyphPath).length;
      const big = p.elements.some(e => e.kind === 'image' && e.r[2] * e.r[3] > 0.5 * W * H);
      if (real < 3 && (glyphLike > 30 || big)) out.push(i);
    });
    return out;
  }

  function scanHint(d) {
    let invisible = false, scanned = false;
    for (const p of d.pages) {
      const W = p.vp1.width, H = p.vp1.height;
      const big = p.elements.some(e => e.kind === 'image' && e.r[2] * e.r[3] > 0.5 * W * H);
      const vis = p.elements.filter(e => e.kind === 'text' && !e.invisible && !e.ocr).length;
      if (p.elements.some(e => e.invisible)) invisible = true;
      else if (big && vis < 3 && !p.elements.some(e => e.ocr)) scanned = true;
    }
    if (invisible) return 'Scan mit Textebene erkannt: Doppelklick auf einen Text übermalt das Alte passend und setzt neuen Text darüber.';
    if (scanned) return 'Diese PDF sieht nach einem Scan aus – klick auf „Text erkennen“, dann wird die Schrift einzeln anklickbar.';
    return '';
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
    if (!d.deleted.size && !Object.keys(d.edits).length) return d.bytes;
    d.scanner.applyDeletions(d.deleted, d.edits);
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
    updateEditedBoxes(d);
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
      if (e.ocr) { addElementDiv(p, e); continue; }
      const r = p.vp1.convertToViewportRectangle(e.bbox);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
      e.r = [x, y, Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])];
      if (e.kind === 'text') {
        const o = p.vp1.convertToViewportPoint(e.origin[0], e.origin[1]);
        const t = p.vp1.convertToViewportPoint(e.end[0], e.end[1]);
        e.vorigin = o;
        e.vang = Math.atan2(t[1] - o[1], t[0] - o[0]);
      }
      addElementDiv(p, e);
    }
  }

  function addElementDiv(p, e) {
    const div = el('div', 'el ' + e.kind + (e.wm ? ' wm' : '') + (e.invisible || e.ocr ? ' scan' : ''), p.elLayer);
    e.r0 = e.r0 || e.r.slice();
    placeElementDiv(div, e.r);
    p.elDivs.set(e.id, div);
  }

  function placeElementDiv(div, r) {
    div.style.left = (r[0] - 1) + 'px';
    div.style.top = (r[1] - 1) + 'px';
    div.style.width = Math.max(r[2], 2) + 2 + 'px';
    div.style.height = Math.max(r[3], 2) + 2 + 'px';
  }

  // Nach einer Textänderung die Rahmenbreite an den neuen Text anpassen
  function updateEditedBoxes(d) {
    for (const p of d.pages) {
      if (!p.elDivs) continue;
      for (const e of p.elements) {
        if (e.kind !== 'text' || !e.ops) continue;
        const info = d.edits[e.id] !== undefined && d.scanner.editInfo.get(e.id);
        const orig = e.ops.reduce((n, o) => n + o.adv, 0);
        e.r = e.r0.slice();
        if (info && orig > 0 && Math.abs(e.vang || 0) < 0.03) e.r[2] = e.r0[2] * info.adv / orig;
        placeElementDiv(p.elDivs.get(e.id), e.r);
      }
    }
  }

  const curText = (d, e) => d.edits[e.id] !== undefined ? d.edits[e.id] : e.text.trim();
  const isDeleted = (d, e) => d.covered.has(e.id) || (e.keys.length > 0 && e.keys.every(k => d.deleted.has(k)));

  function refreshElementState(d) {
    for (const p of d.pages) {
      if (!p.elDivs) continue;
      for (const e of p.elements) {
        const div = p.elDivs.get(e.id);
            div.classList.toggle('deleted', isDeleted(d, e) || !!e.absorbed);
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
      } else if (ov.type === 'rect') {
        div.style.width = ov.w + 'px';
        div.style.height = ov.h + 'px';
        div.style.background = ov.color;
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
    return {
      deleted: [...d.deleted],
      overlays: clone(d.overlays.filter(o => o.type !== 'text' || o.text.trim())),
      edits: Object.assign({}, d.edits),
      covered: [...d.covered]
    };
  }

  function pushUndo(d) {
    d.undo.push(snapshot(d));
    if (d.undo.length > 150) d.undo.shift();
    d.redo = [];
    markDirty(d);
    updateButtons();
  }

  async function restore(d, snap) {
    const delChanged = snap.deleted.length !== d.deleted.size || snap.deleted.some(k => !d.deleted.has(k)) ||
      JSON.stringify(snap.edits) !== JSON.stringify(d.edits);
    d.deleted = new Set(snap.deleted);
    d.overlays = snap.overlays;
    d.edits = snap.edits;
    d.covered = new Set(snap.covered);
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
      if (e.absorbed || isDeleted(d, e)) continue;
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
    for (const e of els) {
      if (e.invisible || (e.ocr && !e.keys.length)) coverElement(d, e);
      else e.keys.forEach(k => d.deleted.add(k));
    }
    d.overlays = d.overlays.filter(o => !ovs.includes(o));
    d.sel.clear();
    updateCtx();
    if (els.some(e => e.keys.length && !e.invisible)) {
      busy('Entferne …');
      try { await render(d); } finally { busy(null); }
    } else {
      refreshElementState(d);
      renderOverlays(d);
    }
  }

  // Farben unter einem Bereich aus dem gerenderten Bild ablesen (Hintergrund + Schrift)
  function sampleColors(p, r) {
    const c = p.canvas;
    const k = c.width / p.vp1.width;
    const pad = 3;
    const x0 = Math.max(0, Math.floor((r[0] - pad) * k)), y0 = Math.max(0, Math.floor((r[1] - pad) * k));
    const x1 = Math.min(c.width, Math.ceil((r[0] + r[2] + pad) * k)), y1 = Math.min(c.height, Math.ceil((r[1] + r[3] + pad) * k));
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return { bg: '#ffffff', fg: '#000000' };
    const px = c.getContext('2d').getImageData(x0, y0, w, h).data;
    const border = [], inner = [];
    const bw = Math.max(1, Math.round(pad * k * 0.6));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = [px[i], px[i + 1], px[i + 2]];
        if (x < bw || y < bw || x >= w - bw || y >= h - bw) border.push(v);
        else inner.push(v);
      }
    }
    const median = list => [0, 1, 2].map(ch => {
      const vals = list.map(v => v[ch]).sort((a, b) => a - b);
      return vals[vals.length >> 1] || 0;
    });
    const hex = v => '#' + v.map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
    const bg = median(border.length ? border : inner);
    const lum = v => 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
    inner.sort((a, b) => lum(a) - lum(b));
    const dark = inner.slice(0, Math.max(1, Math.round(inner.length * 0.08)));
    const fg = dark.length ? median(dark) : [0, 0, 0];
    return { bg: hex(bg), fg: Math.abs(lum(fg) - lum(bg)) < 40 ? '#000000' : hex(fg) };
  }

  // Scan-Text (Bild) mit Hintergrundfarbe übermalen
  function coverElement(d, e) {
    const p = d.pages[e.page];
    const r = e.r;
    const padY = r[3] * 0.12, padX = Math.min(3, r[3] * 0.15);
    const { bg, fg } = sampleColors(p, [r[0] - padX, r[1] - padY, r[2] + 2 * padX, r[3] + 2 * padY]);
    d.overlays.push({
      id: nextOvId(d), page: e.page, type: 'rect', color: bg,
      x: r[0] - padX, y: r[1] - padY, w: r[2] + 2 * padX, h: r[3] + 2 * padY
    });
    if (e.keys.length) e.keys.forEach(k => d.deleted.add(k));
    d.covered.add(e.id);
    return fg;
  }

  function editOriginalText(d, e) {
    if (e.invisible || (e.ocr && !e.vector)) return replaceScanText(d, e);
    openInlineEditor(d, e);
  }

  // Scan: alten Text übermalen und neuen Text in passender Farbe/Größe darüberlegen
  function replaceScanText(d, e) {
    pushUndo(d);
    const fg = coverElement(d, e);
    const fam = e.style.family || 'sans';
    const size = Math.round(e.size * 10) / 10;
    const ov = {
      id: nextOvId(d), page: e.page, type: 'text',
      x: e.r[0], y: e.r[1] + e.r[3] / 2 - size * E.LINE_HEIGHT / 2,
      text: e.text.trim(), size, family: fam, bold: !!e.style.bold, italic: !!e.style.italic, color: fg
    };
    d.overlays.push(ov);
    d.sel.clear();
    d.sel.add('o' + ov.id);
    // unsichtbarer Text ändert das Bild nicht – kein Neuzeichnen nötig
    refreshElementState(d);
    renderOverlays(d);
    updateCtx();
    startEditing(d, ov, true);
  }

  // Originaltext direkt an Ort und Stelle bearbeiten – gespeichert wird in der Originalschrift
  let inline = null;
  function openInlineEditor(d, e) {
    commitEditing();
    closeInline(true);
    const p = d.pages[e.page];
    const fam = e.style.family || 'sans';
    const size = e.size;
    const o = e.vorigin || [e.r[0], e.r[1] + e.r[3] * 0.8];
    const box = el('div', 'inline-edit', p.scaled);
    box.style.left = o[0] + 'px';
    box.style.top = (o[1] - E.BASELINE[fam] * size) + 'px';
    box.style.minWidth = e.r[2] + 'px';
    box.style.fontSize = size + 'px';
    box.style.fontFamily = (e.style.name ? '"' + e.style.name.replace(/"/g, '') + '", ' : '') + E.FONT_CSS[fam];
    box.style.fontWeight = e.style.bold ? '700' : '400';
    box.style.fontStyle = e.style.italic ? 'italic' : 'normal';
    box.style.color = rgbToHex(e.color);
    if (Math.abs(e.vang || 0) > 0.03) {
      box.style.transformOrigin = '0 ' + (E.BASELINE[fam] * size) + 'px';
      box.style.transform = 'rotate(' + e.vang + 'rad)';
    }
    box.textContent = curText(d, e);
    try { box.contentEditable = 'plaintext-only'; } catch (err) { box.contentEditable = 'true'; }
    if (box.contentEditable !== 'plaintext-only') box.contentEditable = 'true';
    inline = { d, e, box };
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    box.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); closeInline(); }
      if (ev.key === 'Escape') { ev.preventDefault(); closeInline(true); }
      ev.stopPropagation();
    });
    box.addEventListener('blur', () => closeInline());
  }

  async function closeInline(cancel) {
    if (!inline) return;
    const { d, e, box } = inline;
    inline = null;
    const text = box.innerText.replace(/[\r\n]+/g, ' ');
    box.remove();
    if (cancel || text === curText(d, e)) return;
    pushUndo(d);
    if (!text.trim()) {
      e.keys.forEach(k => d.deleted.add(k));
      delete d.edits[e.id];
    } else if (text === e.text.trim()) {
      delete d.edits[e.id];
    } else {
      d.edits[e.id] = text;
    }
    busy('Übernehme Änderung …');
    try { await render(d); } finally { busy(null); }
    updateCtx();
    const info = d.scanner.editInfo.get(e.id);
    if (info && info.missing.length) {
      const chars = [...new Set(info.missing)].join(' ');
      toast('Hinweis: „' + chars + '“ ist in der Originalschrift dieser PDF nicht enthalten – ' +
        'dafür wird die ähnlichste Standardschrift (' + info.fallback + ') verwendet.', 7000);
    }
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
      if (inline && inline.box.contains(ev.target)) return;
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

      drag = { type: state.tool === 'cover' ? 'cover' : 'band', start: [x, y], band: null, shift: ev.shiftKey };
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
      if (drag.type === 'band' || drag.type === 'cover') {
        if (!drag.band && Math.hypot(dx, dy) * zoom() < 4) return;
        if (!drag.band) drag.band = el('div', 'band' + (drag.type === 'cover' ? ' cover' : ''), p.scaled);
        const bx = Math.min(x, drag.start[0]), by = Math.min(y, drag.start[1]);
        Object.assign(drag.band.style, {
          left: bx + 'px', top: by + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px'
        });
        return;
      }
      if (!drag.pushed) {
        if (Math.hypot(dx, dy) * zoom() < 2) return;
        const snap = snapshot(d);
        snap.overlays = clone(d.overlays.map(o => {
          const st = drag.orig.find(t => t.o === o);
          return st ? Object.assign({}, o, { x: st.x, y: st.y, w: st.w, h: st.h, size: st.size }) : o;
        }));
        d.undo.push(snap);
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
        if (o.type === 'rect') {
          o.w = Math.max(2, s.w + dx);
          o.h = Math.max(2, s.h + dy);
          if (div) { div.style.width = o.w + 'px'; div.style.height = o.h + 'px'; }
        } else if (o.type === 'image') {
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
      if (dr.type === 'cover') {
        if (dr.band) dr.band.remove();
        const r = [Math.min(x, dr.start[0]), Math.min(y, dr.start[1]), Math.abs(x - dr.start[0]), Math.abs(y - dr.start[1])];
        if (r[2] < 2 || r[3] < 2) return;
        pushUndo(d);
        const { bg } = sampleColors(p, r);
        const ov = { id: nextOvId(d), page: pageIndex, type: 'rect', color: bg, x: r[0], y: r[1], w: r[2], h: r[3] };
        d.overlays.push(ov);
        d.sel.clear();
        d.sel.add('o' + ov.id);
        renderOverlays(d);
        updateCtx();
        return;
      }
      if (dr.type === 'band') {
        if (dr.band) {
          dr.band.remove();
          const x0 = Math.min(x, dr.start[0]), x1 = Math.max(x, dr.start[0]);
          const y0 = Math.min(y, dr.start[1]), y1 = Math.max(y, dr.start[1]);
          const keys = [];
          for (const e of p.elements) {
            if (e.absorbed || isDeleted(d, e)) continue;
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
    if (ovs.length === 1 && !els.length && ovs[0].type === 'rect') {
      const ov = ovs[0];
      info.textContent = 'Abdeckung';
      const col = el('input', '', bar);
      col.type = 'color'; col.value = ov.color; col.title = 'Farbe der Abdeckung';
      col.onchange = () => { pushUndo(d); ov.color = col.value; renderOverlays(d); };
    } else if (els.length === 1 && !ovs.length) {
      const e = els[0];
      const names = { text: 'Text', image: 'Bild', path: 'Grafik/Linie', annot: 'Anmerkung/Feld', form: 'Wasserzeichen-Gruppe' };
      let label = (e.wm ? 'Mögliches Wasserzeichen · ' : '') + names[e.kind];
      if (e.kind === 'text') {
        label = (e.invisible || e.ocr ? 'Scan-Text' : label) + ': „' + curText(d, e) + '“';
        if (!e.ocr) {
          const st = e.style;
          const font = [st.name || { sans: 'Sans', serif: 'Serif', mono: 'Mono' }[st.family], st.bold ? 'fett' : '',
            st.italic ? 'kursiv' : '', (Math.round(e.size * 10) / 10) + ' pt'].filter(Boolean).join(' · ');
          const fi = el('span', 'fontinfo', bar);
          fi.textContent = font;
          fi.title = 'Erkannte Schrift – wird beim Ändern beibehalten';
          fi.style.order = 1;
        }
      }
      if (e.kind === 'annot' && e.sub) label += ' (' + e.sub + ')';
      info.textContent = label;
      info.title = label;
      if (e.kind === 'text') {
        const b = btn('Text ändern', () => editOriginalText(d, e), 'primary');
        b.style.order = 2;
      }
    } else {
      info.textContent = (els.length + ovs.length) + ' Elemente ausgewählt';
    }
    btn('Löschen', deleteSelection, 'danger', 'Entfernen (Entf)').style.order = 3;
    btn('Abwählen', () => setSel(d, [])).style.order = 4;
  }

  /* ------------------------------------------------------------------ *
   *  Werkzeuge
   * ------------------------------------------------------------------ */
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    document.body.classList.toggle('tool-text', t === 'text');
    document.body.classList.toggle('tool-cover', t === 'cover');
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

  /* ------------------------------------------------------------------ *
   *  Texterkennung (OCR) für eingescannte Seiten – läuft lokal im Browser
   * ------------------------------------------------------------------ */
  let ocrWorkerP = null;
  let ocrLabel = '';

  function loadScript(src) {
    return new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = src;
      sc.onload = res;
      sc.onerror = () => rej(new Error('Skript nicht ladbar: ' + src));
      document.head.appendChild(sc);
    });
  }

  function ocrWorker() {
    if (!ocrWorkerP) {
      ocrWorkerP = (async () => {
        if (!window.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js');
        const abs = u => new URL(u, location.href).href;
        return Tesseract.createWorker('deu', 1, {
          workerPath: abs('vendor/tesseract/worker.min.js'),
          corePath: abs('vendor/tesseract/'),
          langPath: abs('vendor/tesseract/lang'),
          gzip: true,
          logger: m => {
            if (m.status === 'recognizing text' && ocrLabel) busy(ocrLabel + ' ' + Math.round(m.progress * 100) + ' %');
          }
        });
      })();
      ocrWorkerP.catch(() => { ocrWorkerP = null; });
    }
    return ocrWorkerP;
  }

  async function runOcr(d, pageList, auto) {
    d = d || doc();
    if (!d) { toast('Öffne zuerst eine PDF.'); return; }
    commitEditing();
    const pagesToDo = pageList || d.pages.map((_, i) => i);
    busy('Lade Texterkennung … (beim ersten Mal ein paar Sekunden)');
    let added = 0, vectorCount = 0;
    try {
      const worker = await ocrWorker();
      const run = Date.now().toString(36);
      for (const i of pagesToDo) {
        const p = d.pages[i];
        ocrLabel = 'Texterkennung Seite ' + (i + 1) + ' von ' + d.pages.length + ' …';
        busy(ocrLabel);
        const scale = 3;
        const c = await renderForOcr(d, i, scale);
        const { data } = await worker.recognize(c);
        const list = ocrPage(d, p, i, data, scale, run);
        // alte Ergebnisse dieser Seite ersetzen
        for (const e of p.elements) if (e.ocr) { const div = p.elDivs.get(e.id); if (div) div.remove(); p.elDivs.delete(e.id); }
        p.elements = p.elements.filter(e => !e.ocr);
        d.ocr[i] = list;
        for (const o of list) {
          const e = ocrElement(o);
          p.elements.push(e);
          addElementDiv(p, e);
          if (o.vector) vectorCount++;
        }
        added += list.length;
      }
      registerVector(d);
      refreshElementState(d);
      if (vectorCount) {
        toast('Diese PDF enthält Text nur als Grafik (z. B. über PDF24 gedruckt). ' + vectorCount +
          ' Textstellen erkannt – Doppelklick zum Ändern, die Buchstaben werden aus dem Original zusammengesetzt.', 9000);
      } else {
        toast(added ? added + ' Textstellen erkannt – anklicken zum Löschen, Doppelklick zum Ändern.'
          : 'Kein zusätzlicher Text gefunden.', 6000);
      }
    } catch (e) {
      console.error(e);
      toast('Texterkennung fehlgeschlagen: ' + (e.message || e), 6000);
    } finally {
      ocrLabel = '';
      busy(null);
    }
  }

  const isGlyphPath = e => e.kind === 'path' && e.filled && e.ctm && e.r[3] < 40 && e.r[2] < 60;

  // Seite für die Texterkennung rendern. Liegt Text als Grafik vor, werden vorher alle anderen
  // Elemente (Wasserzeichen, Linien, Bilder) ausgeblendet – das macht die Erkennung viel sauberer.
  async function renderForOcr(d, i, scale) {
    const p = d.pages[i];
    let pdf = d.pdfjs, tmp = null;
    const glyphs = p.elements.filter(isGlyphPath).length;
    if (glyphs > 30) {
      const del = new Set(d.deleted);
      for (const e of p.elements) if (!isGlyphPath(e) && !e.ocr) e.keys.forEach(k => del.add(k));
      d.scanner.applyDeletions(del, d.edits);
      const bytes = await d.scanner.doc.save({ useObjectStreams: false });
      d.scanner.applyDeletions(d.deleted, d.edits);
      tmp = await pdfjsLib.getDocument(Object.assign({ data: bytes }, window.PDF_OPTS)).promise;
      pdf = tmp;
    }
    try {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
      return c;
    } finally {
      if (tmp) tmp.destroy();
    }
  }

  const DESC = new Set([...'gjpqyQ,;()[]{}/|@$µ']);
  const CAPS = /^[A-PR-Z0-9ÄÖÜ]$/;
  const XLOW = /^[acemnorsuvwxz]$/;

  // Lage, Grundlinie und Schriftgröße direkt aus den Buchstaben-Zeichnungen bestimmen (PDF-Koordinaten)
  function vectorGeometry(paths, placed, fallbackSize) {
    const x0 = Math.min(...paths.map(e => e.bbox[0]));
    const median = a => { const b = a.slice().sort((m, n) => m - n); return b[b.length >> 1]; };
    const noDesc = placed.filter(pl => pl.ps.length && !pl.junk && !DESC.has(pl.sy.text));
    const bottoms = (noDesc.length ? noDesc.flatMap(pl => pl.ps) : paths).map(e => e.bbox[1]);
    const baseline = median(bottoms);
    const capH = placed.filter(pl => pl.ps.length && CAPS.test(pl.sy.text))
      .map(pl => Math.max(...pl.ps.map(e => e.bbox[3])) - baseline);
    const xH = placed.filter(pl => pl.ps.length && XLOW.test(pl.sy.text))
      .map(pl => Math.max(...pl.ps.map(e => e.bbox[3])) - baseline);
    let size;
    if (capH.length) size = median(capH) / 0.716;
    else if (xH.length) size = median(xH) / 0.519;
    else size = Math.max(...paths.map(e => e.bbox[3])) - baseline > 0 ? (Math.max(...paths.map(e => e.bbox[3])) - baseline) / 0.73 : fallbackSize;
    size = Math.round(size * 4) / 4;
    const top = Math.min(...paths.map(e => e.r[1]));
    const left = Math.min(...paths.map(e => e.r[0]));
    const r = [left, top, Math.max(...paths.map(e => e.r[0] + e.r[2])) - left, Math.max(...paths.map(e => e.r[1] + e.r[3])) - top];
    return {
      vector: true, keys: paths.flatMap(e => e.keys), absorbed: paths.map(e => e.id), color: paths[0].fill,
      x: x0, baseline, size, r
    };
  }

  // Original-Zeichnung je Zeichen als Vorlage merken
  function collectGlyphs(glyphs, placed, o, page) {
    // Ziffern nur aus Zahlen, Buchstaben nur aus Wörtern übernehmen (verhindert O/0-, l/1-Verwechslungen)
    const kind = ch => /[0-9]/.test(ch) ? 'd' : /\p{L}/u.test(ch) ? 'l' : 'o';
    placed.forEach((pl, k) => {
      if (!pl.ps.length || pl.sy.confidence < 75) return;
      const ch = pl.sy.text;
      const word = [...pl.word.text].filter(c => kind(c) !== 'o');
      const kc = kind(ch);
      if (kc !== 'o' && word.length > 1 && word.filter(c => kind(c) === kc).length / word.length < 0.75) return;
      const left = Math.min(...pl.ps.map(e => e.bbox[0]));
      const right = Math.max(...pl.ps.map(e => e.bbox[2]));
      const next = placed.slice(k + 1).find(n => n.ps.length && n.word === pl.word);
      const adv = next ? Math.min(...next.ps.map(e => e.bbox[0])) - left : right - left + o.size * 0.07;
      if (adv <= 0 || adv > o.size * 2) return;
      const arr = glyphs[ch] || (glyphs[ch] = []);
      if (arr.some(a => a.el === o.id)) return;
      if (arr.length >= 40) return;
      const top = Math.max(...pl.ps.map(e => e.bbox[3]));
      arr.push({
        page, el: o.id, pathIds: pl.ps.map(e => e.id), refX: left, baseY: o.baseline, size: o.size, adv,
        weight: pl.weight, conf: pl.sy.confidence, w: (right - left) / o.size, h: (top - o.baseline) / o.size
      });
    });
  }

  // Buchstaben-Zeichnungen ohne Lesung zu Wörtern gruppieren (gleiche Grundlinie, kleine Abstände)
  function clusterGlyphs(paths) {
    const sorted = paths.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
    const groups = [];
    for (const e of sorted) {
      const h = e.bbox[3] - e.bbox[1];
      const g = groups.find(gr => Math.abs(gr.base - e.bbox[1]) < Math.max(gr.h, h) * 0.35 &&
        e.bbox[0] - gr.right < Math.max(gr.h, h) * 0.6 && e.bbox[0] >= gr.left - 1);
      if (g) {
        g.items.push(e);
        g.right = Math.max(g.right, e.bbox[2]);
        g.h = Math.max(g.h, h);
      } else {
        groups.push({ items: [e], base: e.bbox[1], left: e.bbox[0], right: e.bbox[2], h });
      }
    }
    return groups.map(gr => gr.items);
  }

  // OCR-Ergebnis einer Seite in Elemente umsetzen; Buchstaben-Grafiken werden zugeordnet
  function ocrPage(d, p, i, data, scale, run) {
    const vp = p.vp1;
    const toUser = (x, y) => vp.convertToPdfPoint(x, y);
    const native = p.elements.filter(e => e.kind === 'text' && !e.invisible && !e.ocr && !isDeleted(d, e));
    const glyphPaths = p.elements.filter(e => isGlyphPath(e) && !isDeleted(d, e));
    const used = new Set();
    const inside = (e, r, padY) => {
      const cx = e.r[0] + e.r[2] / 2, cy = e.r[1] + e.r[3] / 2;
      return cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] - padY && cy <= r[1] + r[3] + padY;
    };
    const list = [];
    for (const line of data.lines || []) {
      const words = (line.words || []).filter(w => w.text.trim() && w.confidence > 30);
      if (!words.length) continue;
      const lh = line.bbox.y1 - line.bbox.y0;
      const bl = line.baseline || {};
      const baseAt = x => {
        if (bl.has_baseline === false || bl.y0 === undefined) return line.bbox.y1;
        return bl.y0 + (bl.y1 - bl.y0) * (x - bl.x0) / ((bl.x1 - bl.x0) || 1);
      };
      const rowH = line.rowAttributes && line.rowAttributes.row_height ? line.rowAttributes.row_height : lh / 1.1;
      const size = Math.max(4, Math.round(rowH / scale / 0.94 * 2) / 2);
      // Zeile an großen Lücken (Spalten, Tabellen) aufteilen
      const segs = [];
      let cur = null;
      for (const w of words) {
        if (cur && w.bbox.x0 - cur.x1 < lh * 1.1) {
          cur.gaps.push(w.bbox.x0 - cur.x1);
          cur.words.push(w);
          cur.x1 = w.bbox.x1;
          cur.y0 = Math.min(cur.y0, w.bbox.y0);
          cur.y1 = Math.max(cur.y1, w.bbox.y1);
        } else {
          cur = { words: [w], gaps: [], x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 };
          segs.push(cur);
        }
      }
      for (const sg of segs) {
        const text = sg.words.map(w => w.text).join(' ');
        const r = [sg.x0 / scale, sg.y0 / scale, (sg.x1 - sg.x0) / scale, (sg.y1 - sg.y0) / scale];
        const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
        if (native.some(e => cx >= e.r[0] && cx <= e.r[0] + e.r[2] && cy >= e.r[1] && cy <= e.r[1] + e.r[3])) continue;
        const o = { id: 'ocr' + run + ':' + i + ':' + list.length, page: i, r, text, size };
        let paths = glyphPaths.filter(e => !used.has(e.id) && e.r[3] <= r[3] * 1.6 + 1 && inside(e, r, r[3] * 0.2));
        if (paths.length) {
          // nur Zeichnungen auf der Grundlinie dieser Zeile (Nachbarzeilen bei engem Zeilenabstand ausschließen)
          const hs = paths.map(e => e.r[3]).sort((m, n) => m - n);
          const medH = hs[hs.length >> 1];
          const base = baseAt((sg.x0 + sg.x1) / 2) / scale;
          paths = paths.filter(e => {
            const c = e.r[1] + e.r[3] / 2;
            return c > base - 1.6 * medH && c < base + 0.35 * medH;
          });
        }
        if (paths.length) {
          paths.forEach(e => used.add(e.id));
          // Zeichnungen zu Buchstaben bündeln (i-Punkt, Umlaut-Punkte gehören zum Buchstaben darunter)
          const sortedP = paths.slice().sort((a, b) => (a.r[0] + a.r[2] / 2) - (b.r[0] + b.r[2] / 2));
          const clusters = [];
          for (const e of sortedP) {
            const last = clusters[clusters.length - 1];
            if (last) {
              const ov = Math.min(last.x1, e.r[0] + e.r[2]) - Math.max(last.x0, e.r[0]);
              if (ov > 0 && ov > 0.5 * Math.min(last.x1 - last.x0, e.r[2])) {
                last.ps.push(e);
                last.x0 = Math.min(last.x0, e.r[0]);
                last.x1 = Math.max(last.x1, e.r[0] + e.r[2]);
                continue;
              }
            }
            clusters.push({ ps: [e], x0: e.r[0], x1: e.r[0] + e.r[2] });
          }
          // Bündel den gelesenen Wörtern zuordnen und je Wort der Reihe nach den Buchstaben
          const byWord = sg.words.map(() => []);
          for (const cl of clusters) {
            const cx = (cl.x0 + cl.x1) / 2 * scale;
            let bi = 0, bd = Infinity;
            sg.words.forEach((w, k) => {
              const dd = cx < w.bbox.x0 ? w.bbox.x0 - cx : cx > w.bbox.x1 ? cx - w.bbox.x1 : 0;
              if (dd < bd) { bd = dd; bi = k; }
            });
            byWord[bi].push(cl);
          }
          const placed = [];
          sg.words.forEach((w, k) => {
            const chs = [...w.text];
            const cls = byWord[k];
            if (chs.length === cls.length) {
              chs.forEach((ch, j) => {
                const cl = cls[j];
                const top = Math.min(...cl.ps.map(e => e.r[1])), bot = Math.max(...cl.ps.map(e => e.r[1] + e.r[3]));
                placed.push({ sy: { text: ch, confidence: w.confidence }, sr: [cl.x0, top, cl.x1 - cl.x0, bot - top], ps: cl.ps, word: w });
              });
            } else {
              // Anzahl passt nicht (Erkennungsfehler): Wort ohne Zuordnung
              chs.forEach(ch => placed.push({ sy: { text: ch, confidence: 0 }, sr: [0, 0, 0, 0], ps: [], word: w }));
              cls.forEach(cl => placed.push({ sy: { text: '', confidence: 0 }, sr: [0, 0, 0, 0], ps: cl.ps, word: w, junk: true }));
            }
          });
          Object.assign(o, vectorGeometry(paths, placed, size));
          // Strichstärke je Buchstabe aus der Vektorform: 2·Fläche/Umfang, relativ zur Schriftgröße
          // (fett/normal kann innerhalb einer Zeile wechseln)
          for (const pl of placed) {
            if (pl.junk || !pl.ps.length) continue;
            const A = pl.ps.reduce((n, e) => n + (e.area || 0), 0), P = pl.ps.reduce((n, e) => n + (e.perim || 0), 0);
            pl.weight = P > 0 ? 2 * A / P / o.size : 0;
          }
          const wts = placed.filter(pl => pl.weight && !pl.junk).map(pl => pl.weight).sort((m, n) => m - n);
          o.weight = wts.length ? wts[wts.length >> 1] : 0;
          // Zeichenfolge mit Original-Zeichnungen (für "nur Geändertes neu setzen")
          o.chars = [];
          let complete = true;
          let prevWord = null;
          for (const pl of placed) {
            if (prevWord && pl.word !== prevWord) o.chars.push({ ch: ' ' });
            prevWord = pl.word;
            if (pl.junk || !pl.ps.length) { complete = false; continue; }
            o.chars.push({
              ch: pl.sy.text, ids: pl.ps.map(e => e.id),
              left: Math.min(...pl.ps.map(e => e.bbox[0])), right: Math.max(...pl.ps.map(e => e.bbox[2]))
            });
          }
          const assigned = new Set(placed.flatMap(pl => pl.ps.map(e => e.id)));
          if (!complete || paths.some(e => !assigned.has(e.id))) o.chars = null;
          else o.text = o.chars.map(c => c.ch).join('');
          o.id = 'ocr' + run + ':' + i + ':' + list.length;
          o.vorigin = vp.convertToViewportPoint(o.x, o.baseline);
          const gaps = sg.gaps.slice().sort((a, b) => a - b);
          o.space = gaps.length ? Math.max(o.size * 0.2, gaps[gaps.length >> 1] / scale) : o.size * 0.28;
          collectGlyphs(d.glyphs, placed, o, i);
        }
        list.push(o);
      }
    }
    // Übrig gebliebene Buchstaben-Zeichnungen (nicht gelesen) wenigstens wortweise anklickbar machen
    const rest = glyphPaths.filter(e => !used.has(e.id));
    for (const grp of clusterGlyphs(rest)) {
      const o = Object.assign({ id: 'ocr' + run + ':' + i + ':' + list.length, page: i, text: '' },
        vectorGeometry(grp, [], 10));
      o.vorigin = vp.convertToViewportPoint(o.x, o.baseline);
      o.space = o.size * 0.28;
      list.push(o);
    }
    return list;
  }

  function findWatermarks() {
    const d = doc();
    if (!d) return;
    const keys = [];
    let first = null;
    for (const p of d.pages) {
      let found = p.elements.filter(e => e.wm && !e.wmGroup && !e.invisible && !isDeleted(d, e));
      if (!found.length) {
        // kein markiertes Wasserzeichen: große Bilder, die über viel Text liegen, sind verdächtig
        const area = p.vp1.width * p.vp1.height;
        const texts = p.elements.filter(e => e.kind === 'text' && !isDeleted(d, e));
        found = p.elements.filter(e => {
          if (e.kind !== 'image' || isDeleted(d, e) || e.r[2] * e.r[3] < area * 0.08 || e.r[2] * e.r[3] > area * 0.9) return false;
          const over = texts.filter(t => t.r[0] < e.r[0] + e.r[2] && t.r[0] + t.r[2] > e.r[0] &&
            t.r[1] < e.r[1] + e.r[3] && t.r[1] + t.r[3] > e.r[1]).length;
          return over >= 5;
        });
      }
      for (const e of found) {
        keys.push('e' + e.id);
        if (!first) first = p.elDivs.get(e.id);
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
    $('btnOcr').onclick = () => runOcr();
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
      if (!mod && k === 'a') setTool('cover');
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
