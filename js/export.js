/*
 * export.js – Speichern als PDF, Word, PNG/JPG oder Projektdatei
 */
(function () {
  'use strict';

  const FONT_CSS = {
    sans: 'Helvetica, Arial, "Liberation Sans", Arimo, sans-serif',
    serif: '"Times New Roman", Times, "Liberation Serif", Tinos, serif',
    mono: '"Courier New", Courier, "Liberation Mono", Cousine, monospace'
  };
  const WORD_FONT = { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New' };
  const LINE_HEIGHT = 1.15;

  // Abstand Oberkante -> Grundlinie (in em), wird beim Start im Browser gemessen
  const BASELINE = { sans: 0.92, serif: 0.91, mono: 0.84 };

  function measureBaselines() {
    for (const fam of Object.keys(FONT_CSS)) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;' +
        'font-size:100px;line-height:' + LINE_HEIGHT + ';font-family:' + FONT_CSS[fam];
      d.innerHTML = '<span style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>Hg';
      document.body.appendChild(d);
      const probe = d.firstChild.getBoundingClientRect().top - d.getBoundingClientRect().top;
      if (probe > 50 && probe < 115) BASELINE[fam] = probe / 100;
      d.remove();
    }
  }

  function standardFontName(fam, bold, italic) {
    const S = PDFLib.StandardFonts;
    if (fam === 'serif') return bold && italic ? S.TimesRomanBoldItalic : bold ? S.TimesRomanBold : italic ? S.TimesRomanItalic : S.TimesRoman;
    if (fam === 'mono') return bold && italic ? S.CourierBoldOblique : bold ? S.CourierBold : italic ? S.CourierOblique : S.Courier;
    return bold && italic ? S.HelveticaBoldOblique : bold ? S.HelveticaBold : italic ? S.HelveticaOblique : S.Helvetica;
  }

  const REPLACE = { '−': '-', ' ': ' ', ' ': ' ', ' ': ' ', '‐': '-', '‑': '-' };

  function sanitize(text, font) {
    if (!font.__chars) font.__chars = new Set(font.getCharacterSet());
    let out = '';
    for (const ch of text) {
      const c = REPLACE[ch] || ch;
      out += font.__chars.has(c.codePointAt(0)) ? c : '?';
    }
    return out;
  }

  function hexToRgb(hex) {
    const n = parseInt((hex || '#000000').slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  function dataUrlBytes(url) {
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // PDF ohne gelöschte Elemente (optional weitere Schlüssel entfernen)
  async function baseBytes(doc, extraDeleted) {
    const del = new Set(doc.deleted);
    if (extraDeleted) for (const k of extraDeleted) del.add(k);
    doc.scanner.applyDeletions(del, doc.edits);
    const bytes = await doc.scanner.doc.save({ useObjectStreams: false });
    if (extraDeleted) doc.scanner.applyDeletions(doc.deleted, doc.edits);
    return bytes;
  }

  async function pdf(doc, opts) {
    opts = opts || {};
    const L = PDFLib;
    const bytes = await baseBytes(doc, opts.extraDeleted);
    if (!doc.overlays.length) return bytes;
    const toRgb = hex => { const [r, g, b] = hexToRgb(hex); return L.rgb(r, g, b); };
    const out = await L.PDFDocument.load(bytes, { updateMetadata: false });
    const pages = out.getPages();
    const fonts = {};
    const images = {};
    for (const ov of doc.overlays) {
      const page = pages[ov.page];
      const vp = doc.pages[ov.page].vp1;
      if (!page || !vp) continue;
      const angleAt = (x, y) => {
        const p0 = vp.convertToPdfPoint(x, y);
        const p1 = vp.convertToPdfPoint(x + 1, y);
        return { p: p0, deg: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI };
      };
      if (ov.type === 'text') {
        if (opts.textOverlays === false) continue;
        const fname = standardFontName(ov.family, ov.bold, ov.italic);
        if (!fonts[fname]) fonts[fname] = await out.embedFont(fname);
        const font = fonts[fname];
        const [r, g, b] = hexToRgb(ov.color);
        ov.text.split('\n').forEach((line, i) => {
          if (!line) return;
          const base = ov.y + (BASELINE[ov.family] + i * LINE_HEIGHT) * ov.size;
          const { p, deg } = angleAt(ov.x, base);
          page.drawText(sanitize(line, font), {
            x: p[0], y: p[1], size: ov.size, font, color: L.rgb(r, g, b), rotate: L.degrees(deg)
          });
        });
      } else if (ov.type === 'rect') {
        const { p, deg } = angleAt(ov.x, ov.y + ov.h);
        page.drawRectangle({ x: p[0], y: p[1], width: ov.w, height: ov.h, color: toRgb(ov.color), rotate: L.degrees(deg) });
      } else if (ov.type === 'image') {
        const src = doc.images[ov.img];
        if (!src) continue;
        if (!images[ov.img]) {
          const data = dataUrlBytes(src);
          images[ov.img] = src.startsWith('data:image/jpeg') ? await out.embedJpg(data) : await out.embedPng(data);
        }
        const { p, deg } = angleAt(ov.x, ov.y + ov.h);
        page.drawImage(images[ov.img], { x: p[0], y: p[1], width: ov.w, height: ov.h, rotate: L.degrees(deg) });
      }
    }
    return out.save({ useObjectStreams: false });
  }

  async function renderPages(bytes, scale, type) {
    // Seiten immer auf weißem Hintergrund rendern
    const task = pdfjsLib.getDocument(Object.assign({ data: bytes.slice() }, window.PDF_OPTS));
    const pdfDoc = await task.promise;
    const blobs = [];
    try {
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        blobs.push(await new Promise(res => c.toBlob(res, type, 0.92)));
      }
    } finally {
      pdfDoc.destroy();
    }
    return blobs;
  }

  async function images(doc, fmt, baseName) {
    const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
    const bytes = await pdf(doc);
    const blobs = await renderPages(bytes, 200 / 72, mime);
    if (blobs.length === 1) return { blob: blobs[0], ext: fmt, mime };
    const zip = new JSZip();
    blobs.forEach((b, i) => zip.file(baseName + '_Seite_' + (i + 1) + '.' + fmt, b));
    return { blob: await zip.generateAsync({ type: 'blob' }), ext: 'zip', mime: 'application/zip' };
  }

  async function docx(doc) {
    const D = window.docx;
    const twip = pt => Math.round(pt * 20);

    // Waagrechte Texte kommen als echter Word-Text, alles andere als Hintergrundbild
    const extra = [];
    const texts = doc.pages.map(() => []);
    doc.pages.forEach((p, pi) => {
      for (const el of p.elements) {
        if (el.kind !== 'text' || el.invisible || el.ocr || el.keys.every(k => doc.deleted.has(k))) continue;
        if (Math.abs(el.vang) > 0.03) continue;
        extra.push(...el.keys);
        texts[pi].push({
          x: el.r[0], y: el.r[1], w: el.r[2], text: doc.edits[el.id] !== undefined ? doc.edits[el.id] : el.text,
          size: el.size,
          font: el.style.name || WORD_FONT[el.style.family], bold: el.style.bold, italic: el.style.italic,
          color: el.color
        });
      }
    });
    for (const ov of doc.overlays) {
      if (ov.type !== 'text' || !doc.pages[ov.page]) continue;
      const lines = ov.text.split('\n');
      texts[ov.page].push({
        x: ov.x, y: ov.y, w: Math.max(...lines.map(l => l.length)) * ov.size * 0.6, lines,
        size: ov.size, font: WORD_FONT[ov.family], bold: ov.bold, italic: ov.italic,
        colorHex: (ov.color || '#000000').slice(1)
      });
    }

    const bg = await pdf(doc, { textOverlays: false, extraDeleted: extra });
    const pngs = await renderPages(bg, 2, 'image/png');

    const sections = [];
    for (let i = 0; i < doc.pages.length; i++) {
      const vp = doc.pages[i].vp1;
      const W = vp.width, H = vp.height;
      const children = [];
      const img = new Uint8Array(await pngs[i].arrayBuffer());
      children.push(new D.Paragraph({
        children: [new D.ImageRun({
          data: img,
          transformation: { width: W * 96 / 72, height: H * 96 / 72 },
          floating: {
            horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: 0 },
            verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: 0 },
            behindDocument: true,
            allowOverlap: true
          }
        })]
      }));
      for (const t of texts[i]) {
        const color = t.colorHex || (t.color || [0, 0, 0]).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16).padStart(2, '0')).join('');
        const lines = t.lines || [t.text];
        const runs = lines.map((line, li) => new D.TextRun({
          text: line, break: li ? 1 : 0, size: Math.max(2, Math.round(t.size * 2)), font: t.font,
          bold: !!t.bold, italics: !!t.italic, color
        }));
        children.push(new D.Paragraph({
          frame: {
            type: 'absolute',
            position: { x: twip(t.x), y: twip(t.y) },
            width: twip(Math.max(t.w * 1.12 + 6, 10)),
            height: twip(t.size * LINE_HEIGHT * lines.length),
            anchor: { horizontal: D.FrameAnchorType.PAGE, vertical: D.FrameAnchorType.PAGE },
            rule: 'atLeast'
          },
          spacing: { before: 0, after: 0, line: 240 },
          children: runs
        }));
      }
      sections.push({
        properties: {
          page: {
            size: { width: twip(W), height: twip(H) },
            margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 }
          }
        },
        children
      });
    }
    const file = new D.Document({ creator: 'PDF-Editor', sections });
    return D.Packer.toBlob(file);
  }

  function project(doc) {
    const data = {
      app: 'pdf-editor',
      version: 1,
      name: doc.name,
      pdf: toBase64(doc.bytes),
      deleted: [...doc.deleted],
      edits: doc.edits,
      covered: [...doc.covered],
      ocr: doc.ocr,
      overlays: doc.overlays,
      images: doc.images
    };
    return new Blob([JSON.stringify(data)], { type: 'application/json' });
  }

  window.Exporter = {
    FONT_CSS, BASELINE, LINE_HEIGHT, measureBaselines, pdf, images, docx, project, dataUrlBytes
  };
})();
