/*
 * pdfscan.js – zerlegt PDF-Seiten in einzelne, löschbare Elemente
 * (Textzeilen, Bilder, Vektorgrafiken, Anmerkungen) und baut die PDF
 * ohne die gelöschten Elemente wieder zusammen.
 *
 * Funktioniert im Browser (window.PdfScan) und in Node (module.exports).
 */
(function (root) {
  'use strict';

  const lib = () => root.PDFLib || (typeof require === 'function' ? require('../vendor/pdf-lib.min.js') : null);

  /* ------------------------------------------------------------------ *
   *  Lexer für Content-Streams
   * ------------------------------------------------------------------ */
  const isWS = c => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const isDelim = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 ||
    c === 123 || c === 125 || c === 47 || c === 37;

  function Lexer(bytes) {
    this.b = bytes;
    this.p = 0;
  }

  Lexer.prototype.skip = function () {
    const b = this.b;
    while (this.p < b.length) {
      const c = b[this.p];
      if (isWS(c)) this.p++;
      else if (c === 37) { // Kommentar
        while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
      } else break;
    }
  };

  // Liefert {k:'v', v} für Werte, {k:'op', v} für Operatoren, {k:'end'} usw.
  Lexer.prototype.next = function () {
    this.skip();
    const b = this.b;
    if (this.p >= b.length) return null;
    const c = b[this.p];
    if (c === 40) return { k: 'v', v: { s: this.literal() } };
    if (c === 60) {
      if (b[this.p + 1] === 60) { this.p += 2; return { k: 'v', v: this.dict() }; }
      return { k: 'v', v: { s: this.hex() } };
    }
    if (c === 62 && b[this.p + 1] === 62) { this.p += 2; return { k: 'dictEnd' }; }
    if (c === 91) { this.p++; return { k: 'v', v: this.array() }; }
    if (c === 93) { this.p++; return { k: 'arrEnd' }; }
    if (c === 47) return { k: 'v', v: { n: this.name() } };
    if (c === 41 || c === 62 || c === 123 || c === 125) { this.p++; return this.next(); }
    // Zahl oder Schlüsselwort
    const start = this.p;
    while (this.p < b.length && !isWS(b[this.p]) && !isDelim(b[this.p])) this.p++;
    if (this.p === start) { this.p++; return this.next(); }
    let word = '';
    for (let i = start; i < this.p; i++) word += String.fromCharCode(b[i]);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) || /^[+-]?\d*\.\d*$/.test(word) && word !== '.') {
      const n = parseFloat(word);
      return { k: 'v', v: isNaN(n) ? 0 : n };
    }
    if (word === 'true') return { k: 'v', v: true };
    if (word === 'false') return { k: 'v', v: false };
    if (word === 'null') return { k: 'v', v: null };
    return { k: 'op', v: word };
  };

  Lexer.prototype.literal = function () {
    const b = this.b;
    this.p++; // (
    const out = [];
    let depth = 1;
    while (this.p < b.length) {
      let c = b[this.p++];
      if (c === 92) { // Backslash
        c = b[this.p++];
        switch (c) {
          case 110: out.push(10); break;
          case 114: out.push(13); break;
          case 116: out.push(9); break;
          case 98: out.push(8); break;
          case 102: out.push(12); break;
          case 13: if (b[this.p] === 10) this.p++; break;
          case 10: break;
          default:
            if (c >= 48 && c <= 55) {
              let v = c - 48;
              for (let i = 0; i < 2 && b[this.p] >= 48 && b[this.p] <= 55; i++) v = v * 8 + (b[this.p++] - 48);
              out.push(v & 255);
            } else out.push(c);
        }
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Uint8Array.from(out);
  };

  Lexer.prototype.hex = function () {
    const b = this.b;
    this.p++;
    let digits = '';
    while (this.p < b.length && b[this.p] !== 62) {
      const c = b[this.p++];
      if (!isWS(c)) digits += String.fromCharCode(c);
    }
    this.p++;
    if (digits.length % 2) digits += '0';
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16) || 0;
    return out;
  };

  Lexer.prototype.name = function () {
    const b = this.b;
    this.p++;
    let s = '';
    while (this.p < b.length && !isWS(b[this.p]) && !isDelim(b[this.p])) {
      const c = b[this.p++];
      if (c === 35 && this.p + 1 < b.length) {
        const h = parseInt(String.fromCharCode(b[this.p], b[this.p + 1]), 16);
        if (!isNaN(h)) { s += String.fromCharCode(h); this.p += 2; continue; }
      }
      s += String.fromCharCode(c);
    }
    return s;
  };

  Lexer.prototype.array = function () {
    const arr = [];
    for (;;) {
      const t = this.next();
      if (!t || t.k === 'arrEnd') return arr;
      if (t.k === 'v') arr.push(t.v);
    }
  };

  Lexer.prototype.dict = function () {
    const d = {};
    let key = null;
    for (;;) {
      const t = this.next();
      if (!t || t.k === 'dictEnd') return { d };
      if (t.k !== 'v') continue;
      if (key === null) { key = t.v && t.v.n !== undefined ? t.v.n : null; }
      else { d[key] = t.v; key = null; }
    }
  };

  // Inline-Bild: nach "ID" bis zum passenden "EI" springen
  Lexer.prototype.skipInlineImage = function () {
    const b = this.b;
    this.p++; // ein Leerzeichen nach ID
    for (let i = this.p; i < b.length - 1; i++) {
      if (b[i] === 69 && b[i + 1] === 73 && (i === 0 || isWS(b[i - 1])) &&
        (i + 2 >= b.length || isWS(b[i + 2]) || isDelim(b[i + 2]))) {
        this.p = i + 2;
        return;
      }
    }
    this.p = b.length;
  };

  function parseOps(bytes) {
    const lx = new Lexer(bytes);
    const ops = [];
    let args = [];
    let start = -1;
    for (;;) {
      lx.skip();
      const pos = lx.p;
      const t = lx.next();
      if (!t) break;
      if (t.k === 'v') {
        if (start < 0) start = pos;
        args.push(t.v);
        continue;
      }
      if (t.k !== 'op') continue;
      if (start < 0) start = pos;
      if (t.v === 'BI') {
        const d = {};
        let key = null;
        for (;;) {
          const u = lx.next();
          if (!u) break;
          if (u.k === 'op' && u.v === 'ID') { lx.skipInlineImage(); break; }
          if (u.k !== 'v') continue;
          if (key === null) key = u.v && u.v.n !== undefined ? u.v.n : '';
          else { d[key] = u.v; key = null; }
        }
        ops.push({ op: 'BI', args: [{ d }], s: start, e: lx.p });
      } else {
        ops.push({ op: t.v, args, s: start, e: lx.p });
      }
      args = [];
      start = -1;
    }
    return ops;
  }

  /* ------------------------------------------------------------------ *
   *  Hilfen für pdf-lib-Objekte
   * ------------------------------------------------------------------ */
  function N(name) { return lib().PDFName.of(name); }

  function deref(ctx, o) {
    const L = lib();
    return o instanceof L.PDFRef ? ctx.lookup(o) : o;
  }

  function get(ctx, dict, key) {
    if (!dict || !dict.get) return undefined;
    return deref(ctx, dict.get(N(key)));
  }

  function num(o, def) {
    const L = lib();
    if (o instanceof L.PDFNumber) return o.asNumber();
    return def;
  }

  function nameOf(o) {
    const L = lib();
    return o instanceof L.PDFName ? o.decodeText() : null;
  }

  function arr(ctx, o) {
    const L = lib();
    o = deref(ctx, o);
    if (!(o instanceof L.PDFArray)) return null;
    const out = [];
    for (let i = 0; i < o.size(); i++) out.push(deref(ctx, o.get(i)));
    return out;
  }

  function streamBytes(stream) {
    const L = lib();
    if (stream instanceof L.PDFRawStream) {
      return L.decodePDFRawStream(stream).decode();
    }
    if (stream.getUnencodedContents) return stream.getUnencodedContents();
    return stream.getContents();
  }

  const latin1 = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };

  function toBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255;
    return out;
  }

  function concatBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  Matrizen
   * ------------------------------------------------------------------ */
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]
  ];
  const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const ID = [1, 0, 0, 1, 0, 0];

  function bboxOf(points) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of points) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  /* ------------------------------------------------------------------ *
   *  Schriften
   * ------------------------------------------------------------------ */
  const WIN_ANSI_HIGH = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
    0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
    0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ'
  };
  const GLYPHS = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
    quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*',
    plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2',
    three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':',
    semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
    backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{',
    bar: '|', braceright: '}', asciitilde: '~', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü',
    adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', germandbls: 'ß', eacute: 'é', egrave: 'è',
    Eacute: 'É', aacute: 'á', agrave: 'à', acircumflex: 'â', ccedilla: 'ç', section: '§', degree: '°',
    Euro: '€', endash: '–', emdash: '—', bullet: '•', quotedblleft: '“', quotedblright: '”',
    quotedblbase: '„', quotesinglbase: '‚', ellipsis: '…', copyright: '©', registered: '®',
    trademark: '™', periodcentered: '·', multiply: '×', divide: '÷', plusminus: '±', paragraph: '¶',
    guillemotleft: '«', guillemotright: '»', nbspace: ' ', sfthyphen: '-', fi: 'fi', fl: 'fl',
    ff: 'ff', ffi: 'ffi', ffl: 'ffl', ordfeminine: 'ª', ordmasculine: 'º', mu: 'µ', twosuperior: '²',
    threesuperior: '³', onehalf: '½', onequarter: '¼', threequarters: '¾', ocircumflex: 'ô',
    ucircumflex: 'û', ecircumflex: 'ê', icircumflex: 'î', ntilde: 'ñ', oslash: 'ø', aring: 'å'
  };

  function glyphToUnicode(g) {
    if (GLYPHS[g] !== undefined) return GLYPHS[g];
    if (/^[A-Za-z]$/.test(g)) return g;
    let m = /^uni([0-9A-Fa-f]{4,})/.exec(g);
    if (m) return String.fromCodePoint(parseInt(m[1].slice(0, 4), 16));
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(g);
    if (m) return String.fromCodePoint(parseInt(m[1], 16));
    m = /^[A-Za-z]+\.(.*)$/.exec(g);
    if (m) return glyphToUnicode(g.split('.')[0]);
    return '';
  }

  function utf16be(bytes) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }

  function hexBytes(h) {
    h = h.replace(/\s+/g, '');
    if (h.length % 2) h += '0';
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function parseToUnicode(bytes) {
    const text = latin1(bytes);
    const map = new Map();
    let m;
    const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = charBlock.exec(text))) {
      const re = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g;
      let p;
      while ((p = re.exec(m[1]))) map.set(parseInt(p[1].replace(/\s/g, ''), 16), utf16be(hexBytes(p[2])));
    }
    const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = rangeBlock.exec(text))) {
      const re = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(<[0-9a-fA-F\s]*>|\[[^\]]*\])/g;
      let p;
      while ((p = re.exec(m[1]))) {
        const lo = parseInt(p[1].replace(/\s/g, ''), 16);
        const hi = parseInt(p[2].replace(/\s/g, ''), 16);
        if (hi - lo > 65535) continue;
        if (p[3][0] === '[') {
          const items = p[3].match(/<[0-9a-fA-F\s]*>/g) || [];
          items.forEach((it, i) => map.set(lo + i, utf16be(hexBytes(it.slice(1, -1)))));
        } else {
          const dst = hexBytes(p[3].slice(1, -1));
          for (let c = lo; c <= hi; c++) {
            const d = dst.slice();
            const add = c - lo;
            let carry = add;
            for (let i = d.length - 1; i >= 0 && carry; i--) {
              const v = d[i] + carry;
              d[i] = v & 255;
              carry = v >> 8;
            }
            map.set(c, utf16be(d));
          }
        }
      }
    }
    return map;
  }

  function fontStyle(baseFont) {
    const clean = (baseFont || '').replace(/^[A-Z]{6}\+/, '');
    const bold = /bold|black|heavy|semibold|demi/i.test(clean);
    const italic = /italic|oblique|kursiv/i.test(clean);
    let family = 'sans';
    if (/courier|mono|consol/i.test(clean)) family = 'mono';
    else if (/times|serif|roman|garamond|georgia|cambria|book|minion|palatino/i.test(clean) && !/sans/i.test(clean)) family = 'serif';
    // Lesbarer Name für Word-Export, z. B. "TimesNewRomanPS-BoldMT" -> "Times New Roman"
    let name = clean.split(/[-,]/)[0].replace(/(PSMT|PS|MT)$/, '');
    name = name.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return { bold, italic, family, name: name || null };
  }

  function stdFontName(style) {
    const b = style.bold, i = style.italic;
    if (style.family === 'serif') return b && i ? 'Times-BoldItalic' : b ? 'Times-Bold' : i ? 'Times-Italic' : 'Times-Roman';
    if (style.family === 'mono') return b && i ? 'Courier-BoldOblique' : b ? 'Courier-Bold' : i ? 'Courier-Oblique' : 'Courier';
    return b && i ? 'Helvetica-BoldOblique' : b ? 'Helvetica-Bold' : i ? 'Helvetica-Oblique' : 'Helvetica';
  }

  // Metriken der 12 Standardschriften (für PDFs ohne Breitenangaben)
  let stdCache = null;
  async function standardFonts() {
    if (stdCache) return stdCache;
    const L = lib();
    const d = await L.PDFDocument.create();
    const out = {};
    for (const n of ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman',
      'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']) {
      out[n] = d.embedStandardFont(n);
    }
    stdCache = out;
    return out;
  }

  function loadFont(ctx, fontDict, std) {
    const L = lib();
    const subtype = nameOf(get(ctx, fontDict, 'Subtype'));
    const baseFont = nameOf(get(ctx, fontDict, 'BaseFont')) || '';
    const f = {
      type0: subtype === 'Type0',
      type3: subtype === 'Type3',
      baseFont,
      style: fontStyle(baseFont),
      toUni: null,
      widths: null,
      firstChar: 0,
      missing: 0,
      dw: 1000,
      cidW: null,
      scale: 0.001,
      hasWidths: false,
      ascent: 0.8,
      descent: -0.2,
      diffs: null
    };
    try {
      const tu = get(ctx, fontDict, 'ToUnicode');
      if (tu instanceof L.PDFStream) f.toUni = parseToUnicode(streamBytes(tu));
    } catch (e) { /* kaputte CMap ignorieren */ }

    let descriptor;
    if (f.type0) {
      const desc = arr(ctx, get(ctx, fontDict, 'DescendantFonts'));
      const cid = desc && desc[0];
      if (cid) {
        f.dw = num(get(ctx, cid, 'DW'), 1000);
        const w = arr(ctx, get(ctx, cid, 'W'));
        f.cidW = new Map();
        if (w) {
          for (let i = 0; i < w.length;) {
            const first = num(w[i], 0);
            const next = w[i + 1];
            if (next instanceof L.PDFArray) {
              for (let j = 0; j < next.size(); j++) f.cidW.set(first + j, num(deref(ctx, next.get(j)), f.dw));
              i += 2;
            } else {
              const last = num(next, first);
              const width = num(w[i + 2], f.dw);
              if (last - first < 70000) for (let c = first; c <= last; c++) f.cidW.set(c, width);
              i += 3;
            }
          }
        }
        f.hasWidths = true;
        descriptor = get(ctx, cid, 'FontDescriptor');
        if (!f.style.name) f.style = fontStyle(nameOf(get(ctx, cid, 'BaseFont')));
      }
    } else {
      const widths = arr(ctx, get(ctx, fontDict, 'Widths'));
      if (widths) {
        f.widths = widths.map(w => num(w, 0));
        f.firstChar = num(get(ctx, fontDict, 'FirstChar'), 0);
        f.hasWidths = true;
      }
      descriptor = get(ctx, fontDict, 'FontDescriptor');
      if (f.type3) {
        const fm = arr(ctx, get(ctx, fontDict, 'FontMatrix'));
        if (fm) f.scale = Math.abs(num(fm[0], 0.001)) || 0.001;
      }
      const enc = get(ctx, fontDict, 'Encoding');
      if (enc instanceof L.PDFDict) {
        const d = arr(ctx, get(ctx, enc, 'Differences'));
        if (d) {
          f.diffs = new Map();
          let code = 0;
          for (const it of d) {
            if (it instanceof L.PDFNumber) code = it.asNumber();
            else if (it instanceof L.PDFName) f.diffs.set(code++, it.decodeText());
          }
        }
      }
    }
    f.subset = /^[A-Z]{6}\+/.test(baseFont);
    f.embedded = descriptor instanceof L.PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some(k => descriptor.has(N(k)));
    if (descriptor instanceof L.PDFDict) {
      f.missing = num(get(ctx, descriptor, 'MissingWidth'), 0);
      const a = num(get(ctx, descriptor, 'Ascent'), 0);
      const d = num(get(ctx, descriptor, 'Descent'), 0);
      if (a > 100 && a < 1500) f.ascent = a / 1000;
      if (d < 0 && d > -800) f.descent = d / 1000;
      const flags = num(get(ctx, descriptor, 'Flags'), 0);
      if (flags & 2) f.style.family = 'serif';
      if (flags & 1) f.style.family = 'mono';
      if (flags & (1 << 6)) f.style.italic = true;
      if (flags & (1 << 18)) f.style.bold = true;
    }
    if (!f.hasWidths && !f.type0 && !f.type3 && std) {
      f.std = std[stdFontName(f.style)];
      f.stdW = new Map();
      if (f.std) f.hasWidths = true;
    }
    return f;
  }

  function fontCodes(font, bytes) {
    const codes = [];
    if (font.type0) {
      for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
    } else {
      for (let i = 0; i < bytes.length; i++) codes.push(bytes[i]);
    }
    return codes;
  }

  function codeWidth(font, code) {
    if (font.type0) return font.cidW.has(code) ? font.cidW.get(code) : font.dw;
    if (font.widths) {
      const w = font.widths[code - font.firstChar];
      return w === undefined ? font.missing : w;
    }
    if (font.std) {
      if (!font.stdW.has(code)) {
        let w = 500;
        try { const ch = codeText(font, code); w = ch ? font.std.widthOfTextAtSize(ch, 1000) : 0; } catch (e) { w = 500; }
        font.stdW.set(code, w);
      }
      return font.stdW.get(code);
    }
    return 500;
  }

  function codeText(font, code) {
    if (font.toUni && font.toUni.has(code)) return font.toUni.get(code);
    if (font.type0) return '';
    if (font.diffs && font.diffs.has(code)) return glyphToUnicode(font.diffs.get(code));
    if (code >= 0x80 && code <= 0x9F) return WIN_ANSI_HIGH[code] || '';
    if (code < 32) return '';
    return String.fromCharCode(code);
  }

  // Ist der Code in der (evtl. nur teilweise eingebetteten) Schrift vorhanden?
  function codeAvailable(f, c) {
    if (f.type0) return !!(f.toUni && f.toUni.has(c));
    if (f.toUni && f.toUni.size && f.subset) return f.toUni.has(c);
    if (!f.embedded || !f.subset) return true;
    if (f.widths) {
      const w = f.widths[c - f.firstChar];
      return w !== undefined && w > 0;
    }
    return true;
  }

  function reverseMap(f) {
    if (f.rev) return f.rev;
    const rev = new Map();
    if (f.toUni) {
      for (const [code, str] of f.toUni) {
        if (str && !rev.has(str) && (!f.type0 || code <= 0xFFFF)) rev.set(str, code);
      }
    }
    if (!f.type0) {
      for (let c = 32; c < 256; c++) {
        const str = codeText(f, c);
        if (str && !rev.has(str) && codeAvailable(f, c)) rev.set(str, c);
      }
    }
    f.rev = rev;
    return rev;
  }

  function pdfName(n) {
    let out = '/';
    for (const ch of n) {
      const c = ch.charCodeAt(0);
      out += c < 33 || c > 126 || '()<>[]{}/%#'.includes(ch) ? '#' + c.toString(16).padStart(2, '0') : ch;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  Interpreter: Elemente einer Seite einsammeln
   * ------------------------------------------------------------------ */
  const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
  const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

  function cmyk2rgb(c, m, y, k) {
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }

  function colorFromArgs(args) {
    const n = args.filter(a => typeof a === 'number');
    if (n.length === 1) return [n[0], n[0], n[0]];
    if (n.length === 3) return n;
    if (n.length === 4) return cmyk2rgb(n[0], n[1], n[2], n[3]);
    return null;
  }

  function fmt(n) {
    if (!isFinite(n)) return '0';
    const s = n.toFixed(3);
    return s.replace(/\.?0+$/, '') || '0';
  }

  class Scanner {
    constructor(lib, pdfDoc, std) {
      this.std = std || null;
      this.byId = new Map();
      this.fallbackFonts = {};
      this.editInfo = new Map();
      this.doc = pdfDoc;
      this.ctx = pdfDoc.context;
      this.streams = new Map(); // key -> {ops, bytes, kind, ref, pageIndex}
      this.replacements = new Map(); // deleteKey -> Ersatz-Bytes (String)
      this.fontCache = new Map();
      this.pages = [];
    }

    fontFor(resources, name) {
      const fonts = get(this.ctx, resources, 'Font');
      const raw = fonts && fonts.get ? fonts.get(N(name)) : undefined;
      const key = raw ? raw.toString() : name;
      if (this.fontCache.has(key)) return this.fontCache.get(key);
      const dict = deref(this.ctx, raw);
      let f = null;
      if (dict instanceof lib().PDFDict) {
        try { f = loadFont(this.ctx, dict, this.std); } catch (e) { f = null; }
      }
      if (!f) {
        f = { type0: false, baseFont: name, style: fontStyle(name), hasWidths: false, widths: null, firstChar: 0,
          missing: 0, dw: 1000, scale: 0.001, ascent: 0.8, descent: -0.2, toUni: null, diffs: null };
      }
      this.fontCache.set(key, f);
      return f;
    }

    scanAll() {
      const pages = this.doc.getPages();
      pages.forEach((page, i) => this.pages.push(this.scanPage(page, i)));
      return this.pages;
    }

    scanPage(page, pageIndex) {
      const L = lib();
      const node = page.node;
      const elements = [];
      const key = 'p' + pageIndex;
      let bytes = new Uint8Array(0);
      const contents = deref(this.ctx, node.get(N('Contents')));
      const parts = [];
      try {
        if (contents instanceof L.PDFArray) {
          for (let i = 0; i < contents.size(); i++) {
            const s = deref(this.ctx, contents.get(i));
            if (s instanceof L.PDFStream) { parts.push(streamBytes(s)); parts.push(toBytes('\n')); }
          }
        } else if (contents instanceof L.PDFStream) {
          parts.push(streamBytes(contents));
        }
        bytes = concatBytes(parts);
      } catch (e) {
        console.warn('Seite', pageIndex + 1, 'konnte nicht dekodiert werden', e);
      }
      const ops = parseOps(bytes);
      this.streams.set(key, {
        ops, bytes, kind: 'page', pageIndex,
        origContents: node.get(N('Contents'))
      });
      const resources = node.Resources ? node.Resources() : get(this.ctx, node, 'Resources');
      this.streams.get(key).resources = resources;
      this.interpret(key, ops, resources, ID, elements, 0, new Set(), { wm: false, alpha: 1 });

      // Anmerkungen (Stempel, Formularfelder, Freitext …)
      const annots = arr(this.ctx, node.get(N('Annots')));
      if (annots) {
        annots.forEach((a, i) => {
          if (!(a instanceof L.PDFDict)) return;
          const sub = nameOf(get(this.ctx, a, 'Subtype'));
          if (sub === 'Link' || sub === 'Popup') return;
          const rect = arr(this.ctx, get(this.ctx, a, 'Rect'));
          if (!rect || rect.length < 4) return;
          const r = rect.map(v => num(v, 0));
          if (num(get(this.ctx, a, 'F'), 0) & 2) return; // versteckt
          const bbox = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
          const wm = sub === 'Watermark' || sub === 'Stamp';
          elements.push({ kind: 'annot', sub, keys: ['a' + pageIndex + ':' + i], bbox, wm });
          // Inhalt des Erscheinungsbilds (Formularfeld-Werte, Stempeltexte …) einzeln erkennen
          try { this.scanAppearance(a, bbox, elements, wm); } catch (e) { console.warn('Anmerkung', e); }
        });
      }
      this.streams.get(key).origAnnots = node.get(N('Annots'));

      elements.forEach((el, i) => { el.id = pageIndex + ':' + i; el.page = pageIndex; });
      const grouped = this.groupText(elements);
      for (const el of grouped) this.byId.set(el.id, el);
      return { index: pageIndex, elements: grouped };
    }

    scanAppearance(annot, rect, elements, wm) {
      const L = lib();
      const ctx = this.ctx;
      const ap = get(ctx, annot, 'AP');
      if (!(ap instanceof L.PDFDict)) return;
      let raw = ap.get(N('N'));
      let n = deref(ctx, raw);
      if (n instanceof L.PDFDict && !(n instanceof L.PDFStream)) {
        const as = nameOf(get(ctx, annot, 'AS'));
        if (!as) return;
        raw = n.get(N(as));
        n = deref(ctx, raw);
      }
      if (!(n instanceof L.PDFStream) || !(raw instanceof L.PDFRef)) return;
      const fkey = raw.toString();
      let entry = this.streams.get(fkey);
      if (!entry) {
        let fb = new Uint8Array(0);
        try { fb = streamBytes(n); } catch (e) { /* ignorieren */ }
        entry = { ops: parseOps(fb), bytes: fb, kind: 'form', ref: raw, orig: n, annot };
        this.streams.set(fkey, entry);
      }
      const bb = (arr(ctx, get(ctx, n.dict, 'BBox')) || []).map(v => num(v, 0));
      if (bb.length < 4) return;
      const m = arr(ctx, get(ctx, n.dict, 'Matrix'));
      const fm = m && m.length === 6 ? m.map(v => num(v, 0)) : ID;
      const tb = bboxOf([apply(fm, bb[0], bb[1]), apply(fm, bb[2], bb[1]), apply(fm, bb[0], bb[3]), apply(fm, bb[2], bb[3])]);
      const sx = (rect[2] - rect[0]) / ((tb[2] - tb[0]) || 1);
      const sy = (rect[3] - rect[1]) / ((tb[3] - tb[1]) || 1);
      const A = [sx, 0, 0, sy, rect[0] - tb[0] * sx, rect[1] - tb[1] * sy];
      const res = get(ctx, n.dict, 'Resources');
      entry.resources = res;
      const sub = [];
      this.interpret(fkey, entry.ops, res, mul(fm, A), sub, 1, new Set([fkey]), { wm, alpha: 1 });
      for (const e of sub) e.inAnnot = true;
      elements.push(...sub);
    }

    // Aufeinanderfolgende Textstücke derselben Zeile zu einem Element zusammenfassen
    groupText(elements) {
      const out = [];
      let cur = null;
      for (const el of elements) {
        if (el.kind !== 'text') { cur = null; out.push(el); continue; }
        // Ersatzschrift-Stücke (PEd…) aus früheren Bearbeitungen gehören zur Zeile dazu
        const isFb = e => /^PEd/.test(e.ops[0].fontName || '');
        if (cur && cur.stream === el.stream && (cur.font === el.font || isFb(cur) || isFb(el) || cur.hasFb) &&
          cur.invisible === el.invisible &&
          Math.abs(cur.angle - el.angle) < 0.02 &&
          Math.abs(cur.size - el.size) < 0.25 * Math.max(cur.size, 1)) {
          // Abstand in Leserichtung bestimmen
          const cos = Math.cos(el.angle), sin = Math.sin(el.angle);
          const dx = el.origin[0] - cur.end[0], dy = el.origin[1] - cur.end[1];
          const along = dx * cos + dy * sin;
          const across = -dx * sin + dy * cos;
          if (Math.abs(across) < 0.3 * el.size && along > -0.5 * el.size && along < 0.15 * el.size) {
            if (along > 0.18 * el.size && !/\s$/.test(cur.text) && !/^\s/.test(el.text)) cur.text += ' ';
            cur.text += el.text;
            if (isFb(el) || isFb(cur)) cur.hasFb = true;
            if (isFb(cur) && !isFb(el) && cur.ops.every(o => /^PEd/.test(o.fontName || ''))) {
              cur.font = el.font;
              cur.style = el.style;
            }
            cur.keys.push(...el.keys);
            cur.ops.push(...el.ops);
            cur.bbox = [Math.min(cur.bbox[0], el.bbox[0]), Math.min(cur.bbox[1], el.bbox[1]),
              Math.max(cur.bbox[2], el.bbox[2]), Math.max(cur.bbox[3], el.bbox[3])];
            cur.end = el.end;
            cur.wm = cur.wm || el.wm;
            continue;
          }
        }
        cur = el;
        out.push(el);
      }
      return out;
    }

    interpret(streamKey, ops, resources, baseCtm, elements, depth, formStack, inherited) {
      const L = lib();
      const ctx = this.ctx;
      let gs = {
        ctm: baseCtm, Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, Tfs: 0, Tr: 0, Ts: 0,
        fill: [0, 0, 0], alpha: inherited.alpha, lw: 1
      };
      const stack = [];
      let Tm = ID, Tlm = ID;
      const mc = []; // Marked-Content-Stack (true = Wasserzeichen)
      let path = null;

      const inWM = () => inherited.wm || mc.some(Boolean);

      const showText = (op, i, strings) => {
        // strings: Array aus Uint8Array oder Zahl (TJ-Abstände)
        const font = gs.font;
        if (!font) return;
        const startTm = Tm;
        let adv = 0;
        let text = '';
        let glyphs = 0;
        for (const it of strings) {
          if (typeof it === 'number') {
            const d = -it / 1000 * gs.Tfs * gs.Th;
            adv += d;
            if (-it > 180 && text && !/\s$/.test(text)) text += ' ';
            continue;
          }
          if (!(it && it.s)) continue;
          const codes = fontCodes(font, it.s);
          glyphs += codes.length;
          for (const code of codes) {
            const w = codeWidth(font, code) * font.scale;
            const space = !font.type0 && code === 32 ? gs.Tw : 0;
            adv += (w * gs.Tfs + gs.Tc + space) * gs.Th;
            text += codeText(font, code);
          }
        }
        Tm = mul([1, 0, 0, 1, adv, 0], Tm);
        const M = mul(startTm, gs.ctm);
        const yLo = gs.Ts + font.descent * gs.Tfs;
        const yHi = gs.Ts + font.ascent * gs.Tfs;
        const pts = [apply(M, 0, yLo), apply(M, adv, yLo), apply(M, 0, yHi), apply(M, adv, yHi)];
        const angle = Math.atan2(M[1], M[0]);
        const size = Math.abs(gs.Tfs) * Math.hypot(M[2], M[3]);
        const origin = apply(M, 0, gs.Ts);
        const end = apply(M, adv, gs.Ts);
        const key = streamKey + ':' + i;

        // Ersatz für "Löschen": Glyphen raus, Vorschub bleibt erhalten
        let repl;
        if (font.hasWidths && gs.Tfs !== 0 && gs.Th !== 0) {
          repl = '[' + fmt(-adv / (gs.Tfs * gs.Th) * 1000) + '] TJ';
          if (op === "'") repl = 'T* ' + repl;
          if (op === '"') repl = fmt(gs.Tw) + ' Tw ' + fmt(gs.Tc) + ' Tc T* ' + repl;
        } else {
          // Ohne Breitenangaben: Text unsichtbar schalten, Vorschub übernimmt der Viewer
          const orig = latin1(this.streams.get(streamKey).bytes.subarray(ops[i].s, ops[i].e));
          repl = '3 Tr ' + orig + ' ' + fmt(gs.Tr) + ' Tr';
        }
        this.replacements.set(key, repl);

        // reine Abstände oder nur Leerzeichen
        if (!glyphs || !text.trim()) return;
        const deg = Math.abs(((angle * 180 / Math.PI) % 90 + 90) % 90);
        const lum = 0.299 * gs.fill[0] + 0.587 * gs.fill[1] + 0.114 * gs.fill[2];
        elements.push({
          kind: 'text',
          stream: streamKey,
          keys: [key],
          bbox: bboxOf(pts),
          text,
          size,
          angle,
          origin,
          end,
          color: gs.fill.slice(),
          style: Object.assign({}, font.style),
          font,
          // unsichtbarer Text = Texterkennungs-Ebene über einem Scan
          invisible: gs.Tr === 3 || gs.Tr === 7,
          ops: [{ key, op, font, fontName: gs.fontName, Tfs: gs.Tfs, Th: gs.Th, Tc: gs.Tc, Tw: gs.Tw, adv, resources }],
          wm: inWM() || gs.alpha < 0.95 || (deg > 5 && deg < 85) || (size >= 36 && lum > 0.55)
        });
      };

      for (let i = 0; i < ops.length; i++) {
        const { op, args } = ops[i];
        const a = args;
        switch (op) {
          case 'q': stack.push(gs); gs = Object.assign({}, gs); break;
          case 'Q': if (stack.length) gs = stack.pop(); break;
          case 'cm':
            if (a.length >= 6) gs.ctm = mul(a.slice(0, 6).map(Number), gs.ctm);
            break;
          case 'w': if (typeof a[0] === 'number') gs.lw = a[0]; break;
          case 'gs': {
            const egs = get(ctx, get(ctx, resources, 'ExtGState'), a[0] && a[0].n);
            if (egs instanceof L.PDFDict) {
              const ca = num(get(ctx, egs, 'ca'), null);
              if (ca !== null) gs.alpha = Math.min(inherited.alpha, ca);
              const lw = num(get(ctx, egs, 'LW'), null);
              if (lw !== null) gs.lw = lw;
            }
            break;
          }
          case 'g': case 'rg': case 'k': case 'sc': case 'scn': {
            const c = colorFromArgs(a);
            if (c) gs.fill = c;
            break;
          }
          case 'BDC': case 'BMC': {
            const tag = a[0] && a[0].n;
            let isWm = false;
            if (tag === 'Artifact' && a[1]) {
              let props = a[1].d;
              if (!props && a[1].n) {
                const p = get(ctx, get(ctx, resources, 'Properties'), a[1].n);
                if (p instanceof L.PDFDict) {
                  const st = nameOf(get(ctx, p, 'Subtype'));
                  isWm = st === 'Watermark';
                }
              } else if (props) {
                isWm = props.Subtype && props.Subtype.n === 'Watermark';
              }
            }
            mc.push(isWm);
            break;
          }
          case 'EMC': mc.pop(); break;
          case 'BT': Tm = ID; Tlm = ID; break;
          case 'Tc': gs.Tc = +a[0] || 0; break;
          case 'Tw': gs.Tw = +a[0] || 0; break;
          case 'Tz': gs.Th = (+a[0] || 0) / 100; break;
          case 'TL': gs.TL = +a[0] || 0; break;
          case 'Tr': gs.Tr = +a[0] || 0; break;
          case 'Ts': gs.Ts = +a[0] || 0; break;
          case 'Tf':
            gs.fontName = a[0] && a[0].n;
            gs.font = this.fontFor(resources, gs.fontName);
            gs.Tfs = +a[1] || 0;
            break;
          case 'Td': Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm; break;
          case 'TD': gs.TL = -(+a[1] || 0); Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm; break;
          case 'Tm': Tlm = a.slice(0, 6).map(Number); Tm = Tlm; break;
          case 'T*': Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm; break;
          case 'Tj': showText(op, i, [a[0]]); break;
          case 'TJ': showText(op, i, Array.isArray(a[0]) ? a[0] : []); break;
          case "'":
            Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm;
            showText(op, i, [a[0]]);
            break;
          case '"':
            gs.Tw = +a[0] || 0; gs.Tc = +a[1] || 0;
            Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm;
            showText(op, i, [a[2]]);
            break;
          case 'BI': {
            const key = streamKey + ':' + i;
            this.replacements.set(key, '');
            const pts = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)];
            elements.push({ kind: 'image', stream: streamKey, keys: [key], bbox: bboxOf(pts), wm: inWM() || gs.alpha < 0.95 });
            break;
          }
          case 'Do': {
            const name = a[0] && a[0].n;
            const xobjs = get(ctx, resources, 'XObject');
            const raw = xobjs && xobjs.get ? xobjs.get(N(name)) : undefined;
            const xo = deref(ctx, raw);
            if (!(xo instanceof L.PDFStream)) break;
            const sub = nameOf(get(ctx, xo.dict, 'Subtype'));
            const key = streamKey + ':' + i;
            this.replacements.set(key, '');
            if (sub === 'Image') {
              const pts = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)];
              elements.push({ kind: 'image', stream: streamKey, keys: [key], bbox: bboxOf(pts), wm: inWM() || gs.alpha < 0.95 });
            } else if (sub === 'Form' && raw instanceof L.PDFRef && depth < 8 && !formStack.has(raw.toString())) {
              const fkey = raw.toString();
              let entry = this.streams.get(fkey);
              if (!entry) {
                let fb = new Uint8Array(0);
                try { fb = streamBytes(xo); } catch (e) { /* ignorieren */ }
                entry = { ops: parseOps(fb), bytes: fb, kind: 'form', ref: raw, orig: xo };
                this.streams.set(fkey, entry);
              }
              const matrix = arr(ctx, get(ctx, xo.dict, 'Matrix'));
              const fm = matrix && matrix.length === 6 ? matrix.map(v => num(v, 0)) : ID;
              const fres = get(ctx, xo.dict, 'Resources') || resources;
              const sub2 = [];
              formStack.add(fkey);
              this.interpret(fkey, entry.ops, fres, mul(fm, gs.ctm), sub2, depth + 1, formStack,
                { wm: inWM(), alpha: gs.alpha });
              formStack.delete(fkey);
              // Formular-Objekte, die selbst wie Wasserzeichen aussehen, als Ganzes markierbar machen
              entry.resources = fres;
              const allWm = sub2.length > 0 && sub2.every(e => e.wm);
              if (allWm) {
                // Wasserzeichen-Gruppe als Ganzes löschbar, Einzelteile bleiben anklickbar
                const bb = bboxOf(sub2.flatMap(e => [[e.bbox[0], e.bbox[1]], [e.bbox[2], e.bbox[3]]]));
                elements.push({ kind: 'form', stream: streamKey, keys: [key], bbox: bb, wm: true });
                for (const e of sub2) e.wmGroup = true;
              }
              elements.push(...sub2);
            }
            break;
          }
          default:
            if (PATH_BUILD.has(op)) {
              if (!path) path = { start: i, pts: [], clip: false };
              if (op === 're' && a.length >= 4) {
                const [x, y, w, h] = a.map(Number);
                path.pts.push(apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x, y + h), apply(gs.ctm, x + w, y + h));
              } else {
                for (let j = 0; j + 1 < a.length; j += 2) path.pts.push(apply(gs.ctm, +a[j], +a[j + 1]));
              }
            } else if (op === 'W' || op === 'W*') {
              if (path) path.clip = true;
            } else if (PATH_PAINT.has(op)) {
              if (path && !path.clip && op !== 'n' && path.pts.length) {
                const keys = [];
                for (let j = path.start; j <= i; j++) {
                  const k = streamKey + ':' + j;
                  keys.push(k);
                  this.replacements.set(k, '');
                }
                const lw = gs.lw * Math.hypot(gs.ctm[0], gs.ctm[1]) / 2;
                const bb = bboxOf(path.pts);
                bb[0] -= lw; bb[1] -= lw; bb[2] += lw; bb[3] += lw;
                elements.push({ kind: 'path', stream: streamKey, keys, bbox: bb, wm: inWM() || gs.alpha < 0.95 });
              }
              path = null;
            }
        }
      }
    }

    // Content-Stream ohne gelöschte Operatoren erzeugen
    rebuildStream(key, deleted, overrides) {
      const entry = this.streams.get(key);
      const parts = [];
      for (let i = 0; i < entry.ops.length; i++) {
        const k = key + ':' + i;
        if (overrides && overrides.has(k)) {
          parts.push(toBytes(overrides.get(k) + '\n'));
        } else if (deleted.has(k)) {
          const r = this.replacements.get(k);
          if (r) parts.push(toBytes(r + '\n'));
        } else {
          parts.push(entry.bytes.subarray(entry.ops[i].s, entry.ops[i].e));
          parts.push(toBytes('\n'));
        }
      }
      return concatBytes(parts);
    }

    // Löschungen auf das pdf-lib-Dokument anwenden (immer ausgehend vom Original)
    // Ersatzschrift (Standardschrift) im Ressourcen-Verzeichnis eines Streams anmelden
    fallbackFontName(resources, style) {
      const L = lib();
      const std = stdFontName(style);
      if (!this.fallbackFonts[std]) this.fallbackFonts[std] = this.doc.embedStandardFont(std);
      const font = this.fallbackFonts[std];
      const name = 'PEd' + std.replace(/[^A-Za-z]/g, '');
      if (resources instanceof L.PDFDict) {
        let fonts = deref(this.ctx, resources.get(N('Font')));
        if (!(fonts instanceof L.PDFDict)) {
          fonts = this.ctx.obj({});
          resources.set(N('Font'), fonts);
        }
        if (!fonts.has(N(name))) fonts.set(N(name), font.ref);
      }
      return { font, name };
    }

    // Neuen Text in der Originalschrift kodieren. Fehlende Zeichen kommen aus einer Ersatzschrift.
    encodeEdit(el, text) {
      const first = el.ops[0];
      // Schrift: die erste "echte" Originalschrift der Zeile (nicht eine frühere Ersatzschrift)
      const prim = el.ops.find(op => !/^PEd/.test(op.fontName || '')) || first;
      const o = Object.assign({}, prim, { adv: first.adv, op: first.op, Tfs: first.Tfs, Th: first.Th, Tc: first.Tc, Tw: first.Tw });
      const f = o.font;
      const rev = reverseMap(f);
      const missing = [];
      const segs = []; // {orig:true, items:[]} | {fb:true, str}
      let adv = 0;
      const hex = code => f.type0 ? code.toString(16).padStart(4, '0') : code.toString(16).padStart(2, '0');
      const origSeg = () => {
        let s = segs[segs.length - 1];
        if (!s || !s.orig) { s = { orig: true, items: [] }; segs.push(s); }
        return s;
      };
      for (const ch of text.replace(/[\r\n]+/g, ' ')) {
        if (rev.has(ch)) {
          const code = rev.get(ch);
          const s = origSeg();
          const last = s.items[s.items.length - 1];
          if (typeof last === 'string') s.items[s.items.length - 1] = last + hex(code);
          else s.items.push(hex(code));
          const w = codeWidth(f, code) * f.scale;
          adv += (w * o.Tfs + o.Tc + (!f.type0 && code === 32 ? o.Tw : 0)) * o.Th;
        } else if (ch === ' ' || ch === '\u00A0') {
          // Leerzeichen fehlt in der Schrift: als Abstand setzen
          origSeg().items.push(-250);
          adv += (0.25 * o.Tfs + o.Tc + o.Tw) * o.Th;
        } else {
          missing.push(ch);
          let s = segs[segs.length - 1];
          if (!s || !s.fb) { s = { fb: true, str: '' }; segs.push(s); }
          s.str += ch;
        }
      }
      let out = '';
      let fbInfo = null;
      for (const s of segs) {
        if (s.orig) {
          out += '[' + s.items.map(it => typeof it === 'number' ? fmt(it) : '<' + it + '>').join(' ') + '] TJ ';
        } else {
          if (!fbInfo) fbInfo = this.fallbackFontName(o.resources, el.style);
          const fbf = fbInfo.font;
          let str = '';
          for (const ch of s.str) {
            try { fbf.encodeText(ch); str += ch; } catch (e) { str += '?'; }
          }
          const w = fbf.widthOfTextAtSize(str, o.Tfs);
          const spaces = (str.match(/ /g) || []).length;
          adv += (w + o.Tc * [...str].length + o.Tw * spaces) * o.Th;
          out += pdfName(fbInfo.name) + ' ' + fmt(o.Tfs) + ' Tf ' + fbf.encodeText(str).toString() + ' Tj ' +
            pdfName(o.fontName || '') + ' ' + fmt(o.Tfs) + ' Tf ';
        }
      }
      // Vorschub wie beim Original, damit nachfolgender Text nicht verrutscht
      if (o.Tfs && o.Th) out += '[' + fmt(-(o.adv - adv) / (o.Tfs * o.Th) * 1000) + '] TJ';
      if (prim !== first) {
        out = pdfName(prim.fontName) + ' ' + fmt(o.Tfs) + ' Tf ' + out + ' ' + pdfName(first.fontName || '') + ' ' + fmt(o.Tfs) + ' Tf';
      }
      if (o.op === "'") out = 'T* ' + out;
      if (o.op === '"') out = fmt(o.Tw) + ' Tw ' + fmt(o.Tc) + ' Tc T* ' + out;
      this.editInfo.set(el.id, { missing, fallback: fbInfo ? stdFontName(el.style) : null, adv });
      return out;
    }

    // Formularfeld-Wert (/V) mitziehen, damit andere Programme den neuen Text anzeigen
    setFieldValue(annot, text) {
      const L = lib();
      let field = annot;
      for (let i = 0; i < 10 && field; i++) {
        if (field.has(N('V')) || field.has(N('T'))) break;
        field = deref(this.ctx, field.get(N('Parent')));
      }
      if (!(field instanceof L.PDFDict)) return;
      if (!this.origValues) this.origValues = new Map();
      if (!this.origValues.has(field)) this.origValues.set(field, field.get(N('V')));
      if (text === null) {
        const v = this.origValues.get(field);
        if (v) field.set(N('V'), v); else field.delete(N('V'));
      } else {
        field.set(N('V'), L.PDFHexString.fromText(text));
      }
    }

    applyDeletions(deletedKeys, edits) {
      const deleted = deletedKeys instanceof Set ? deletedKeys : new Set(deletedKeys);
      const byStream = new Map();
      const annotDel = new Map();
      // Textänderungen: erster Operator bekommt den neuen Text, die übrigen werden geleert
      const overrides = new Map();
      const editedAnnots = new Map();
      this.editInfo.clear();
      if (edits) {
        for (const [id, text] of (edits instanceof Map ? edits : Object.entries(edits))) {
          const el = this.byId.get(id);
          if (!el || el.kind !== 'text' || el.keys.every(k => deleted.has(k))) continue;
          el.ops.forEach((o, i) => {
            overrides.set(o.key, i === 0 ? this.encodeEdit(el, text) : (this.replacements.get(o.key) || ''));
          });
          byStream.set(el.stream, true);
          const entry = this.streams.get(el.stream);
          if (entry && entry.annot) editedAnnots.set(entry.annot, text);
        }
      }
      if (this.origValues) for (const field of this.origValues.keys()) this.setFieldValue(field, null);
      for (const [annot, text] of editedAnnots) this.setFieldValue(annot, text);
      for (const k of deleted) {
        if (k[0] === 'a') {
          const [p, i] = k.slice(1).split(':').map(Number);
          if (!annotDel.has(p)) annotDel.set(p, new Set());
          annotDel.get(p).add(i);
          continue;
        }
        const sk = k.slice(0, k.lastIndexOf(':'));
        byStream.set(sk, true);
      }
      const pages = this.doc.getPages();
      for (const [key, entry] of this.streams) {
        const touched = byStream.has(key);
        if (entry.kind === 'page') {
          const node = pages[entry.pageIndex].node;
          if (touched) {
            const s = this.ctx.flateStream(this.rebuildStream(key, deleted, overrides));
            node.set(N('Contents'), this.ctx.register(s));
          } else if (entry.origContents) {
            node.set(N('Contents'), entry.origContents);
          }
          // Anmerkungen
          if (entry.origAnnots) {
            const del = annotDel.get(entry.pageIndex);
            if (del && del.size) {
              const orig = deref(this.ctx, entry.origAnnots);
              const keep = this.ctx.obj([]);
              for (let i = 0; i < orig.size(); i++) if (!del.has(i)) keep.push(orig.get(i));
              node.set(N('Annots'), keep);
            } else {
              node.set(N('Annots'), entry.origAnnots);
            }
          }
        } else if (entry.kind === 'form') {
          if (touched) {
            const dict = {};
            for (const [k, v] of entry.orig.dict.entries()) {
              const n = k.decodeText();
              if (n === 'Filter' || n === 'DecodeParms' || n === 'Length') continue;
              dict[n] = v;
            }
            this.ctx.assign(entry.ref, this.ctx.flateStream(this.rebuildStream(key, deleted, overrides), dict));
          } else {
            this.ctx.assign(entry.ref, entry.orig);
          }
        }
      }
    }
  }

  async function open(bytes) {
    const L = lib();
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) {
      const err = new Error('encrypted');
      err.code = 'ENCRYPTED';
      throw err;
    }
    const scanner = new Scanner(L, doc, await standardFonts());
    scanner.scanAll();
    return scanner;
  }

  const api = { open, parseOps, Scanner, fontStyle, mul, apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfScan = api;
})(typeof window !== 'undefined' ? window : globalThis);
