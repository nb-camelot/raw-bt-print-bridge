// Prove di PrintBridge.render (escpos.js), i layout di stampa dichiarativi, senza stampante.
// I blocchi si provano senza canvas; il logo con un raster gia pronto e con Image e canvas finti.
// Uso: node test/layout-test.js escpos.js
'use strict';
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const SCALE = 50; // timer 50 volte piu veloci: i 10 s di attesa del logo diventano 200 ms
const NOW = new Date(2026, 9, 17, 9, 5, 7); // 17/10/2026 09:05:07, ora locale
const HEAD = [0x1B, 0x40, 0x1C, 0x2E, 0x1B, 0x74, 16]; // ESC @, FS ., ESC t 16

function load(extra = {}) {
  const g = Object.assign({ navigator: {}, localStorage: null, Promise, Date, JSON }, extra);
  g.window = g;
  const fast = (fn, ms) => setTimeout(fn, Math.max(0, (ms || 0) / SCALE));
  // EscPos.rasterize usa document senza window davanti: si passa anche come parametro.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', src)(g, g.document, fast, clearTimeout);
  return g;
}

// --- Decodifica ESC/POS: righe con lo stile in vigore, QR, raster, avanzamenti, taglio ---
const CP1252 = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };
const ALIGN = ['left', 'center', 'right'];
function char(b) { return b < 0x80 || b >= 0xA0 ? String.fromCharCode(b) : (CP1252[b] || '?'); }

function decode(bytes) {
  bytes = Array.from(bytes);
  const ev = [];
  let st = { align: 0, bold: 0, ul: 0, w: 1, h: 1 };
  let text = '';
  let qr = {};
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i], c = bytes[i + 1];
    if (b === 0x1B && c === 0x40) { ev.push({ init: true }); st = { align: 0, bold: 0, ul: 0, w: 1, h: 1 }; i += 2; }
    else if (b === 0x1B && c === 0x74) { ev.push({ codepage: bytes[i + 2] }); i += 3; }
    else if (b === 0x1B && c === 0x61) { st.align = bytes[i + 2]; i += 3; }
    else if (b === 0x1B && c === 0x45) { st.bold = bytes[i + 2]; i += 3; }
    else if (b === 0x1B && c === 0x2D) { st.ul = bytes[i + 2]; i += 3; }
    else if (b === 0x1B && c === 0x64) { ev.push({ feed: bytes[i + 2] }); i += 3; }
    else if (b === 0x1C && c === 0x2E) { ev.push({ kanjiOff: true }); i += 2; }
    else if (b === 0x1D && c === 0x21) { st.w = (bytes[i + 2] >> 4) + 1; st.h = (bytes[i + 2] & 15) + 1; i += 3; }
    else if (b === 0x1D && c === 0x56) {
      if (bytes[i + 2] === 0x42) { ev.push({ cut: 'partial' }); i += 4; } else { ev.push({ cut: 'full' }); i += 3; }
    } else if (b === 0x1D && c === 0x28 && bytes[i + 2] === 0x6B) {
      const len = bytes[i + 3] + (bytes[i + 4] << 8);
      const p = bytes.slice(i + 5, i + 5 + len);
      if (p[1] === 0x43) qr.module = p[2];
      else if (p[1] === 0x45) qr.ec = p[2];
      else if (p[1] === 0x50) qr.data = p.slice(3).map(char).join('');
      else if (p[1] === 0x51) { ev.push({ qr: qr.data, module: qr.module, ec: qr.ec, align: ALIGN[st.align] }); qr = {}; }
      i += 5 + len;
    } else if (b === 0x1D && c === 0x76 && bytes[i + 2] === 0x30) {
      const bpr = bytes[i + 4] + (bytes[i + 5] << 8), rows = bytes[i + 6] + (bytes[i + 7] << 8);
      ev.push({ raster: [bpr * 8, rows], align: ALIGN[st.align], data: bytes.slice(i + 8, i + 8 + bpr * rows) });
      i += 8 + bpr * rows;
    } else if (b === 0x0A) {
      ev.push({ line: text, align: ALIGN[st.align], bold: !!st.bold, ul: !!st.ul, size: [st.w, st.h] });
      text = '';
      i++;
    } else if (b < 0x20 || b === 0x7F) {
      throw new Error('comando sconosciuto 0x' + b.toString(16) + ' 0x' + (c || 0).toString(16) + ' al byte ' + i);
    } else {
      text += char(b);
      i++;
    }
  }
  if (text) ev.push({ unterminated: text });
  return ev;
}
const linesOf = (ev) => ev.filter((e) => 'line' in e).map((e) => e.line);
async function lines(g, layout, data, opts) { return linesOf(decode(await g.PrintBridge.render(layout, data, opts))); }
const text = (t, extra) => ({ blocks: [Object.assign({ text: t }, extra)] });

async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('doveva fallire');
}

// --- Riferimento: Receipt.parse + Receipt.render dell'app (android/.../Receipt.kt) ---
// Tradotti riga per riga. Due differenze volute, le stesse del renderer: in testa anche FS .
// (kanjiOff) e la dimensione con GS ! invece di ESC !. EscPos.size scrive ESC ! con i bit di
// GS !, che sulle stampanti vere scelgono font B e doppia altezza invece di 2x.
function appReceipt(g, o, now, logoRaster) {
  const optString = (k) => (o[k] == null ? '' : String(o[k]));
  const optBoolean = (k, def) => (typeof o[k] === 'boolean' ? o[k] : def);
  const optInt = (k, def) => (typeof o[k] === 'number' ? Math.trunc(o[k]) : def);
  const s = {
    shop: optString('shop'), title: optString('title'), subtitle: optString('subtitle'), code: optString('code'),
    date: optBoolean('date', true), total: optString('total'), qr: optString('qr'), qrText: optString('qrText'),
    footer: optString('footer'), logo: optBoolean('logo', false), width: 32, cut: optBoolean('cut', true),
    feed: Math.min(20, Math.max(0, optInt('feed', 3))),
    lines: (o.lines || []).map((x) => String(x)),
    items: (o.items || []).filter((x) => x && typeof x === 'object').map((x) => ({
      desc: x.desc == null ? '' : String(x.desc),
      qty: typeof x.qty === 'number' ? x.qty : 1,
      price: typeof x.price === 'number' ? x.price : 0
    }))
  };
  const p = new g.EscPos();
  const size = (w, h) => p.raw(0x1D, 0x21, ((w - 1) << 4) | (h - 1));
  const fmt = (v) => v.toFixed(2).replace('.', ','); // String.format(Locale.ITALY, "%.2f", v)
  const pad = (left, right, width) => {
    const space = width - right.length;
    const l = space <= 1 ? '' : left.length >= space ? left.slice(0, space - 1) : left;
    return l + ' '.repeat(Math.max(0, space - l.length)) + right;
  };
  const width = s.width;
  p.init().kanjiOff().codepage(0x10);
  if (s.logo) { p.align('center'); p.image(logoRaster); p.line(''); }
  if (s.shop) { p.align('center').bold(true); size(2, 2); p.line(s.shop); size(1, 1); p.bold(false); }
  if (s.title) { p.align('center').bold(true); size(2, 1); p.line(s.title); size(1, 1); p.bold(false); }
  p.align('left').rule(width);
  if (s.code) p.line('Ricevuta n. ' + s.code);
  if (s.date) p.line(now);
  if (s.subtitle) p.line(s.subtitle);
  if (s.lines.length || s.items.length || s.code || s.date) p.rule(width);
  s.lines.forEach((l) => p.line(l));
  let sum = 0;
  s.items.forEach((it) => {
    const value = it.qty * it.price;
    sum += value;
    p.line(pad(it.desc, fmt(value), width));
  });
  if (s.items.length) p.rule(width);
  const totalValue = s.total ? s.total : s.items.length ? fmt(sum) : '';
  if (totalValue) { p.bold(true); size(1, 2); p.line(pad('TOTALE EUR', totalValue, width)); size(1, 1); p.bold(false); }
  if (s.qr) {
    p.feed(1).align('center');
    p.qr(s.qr, 6, 0x31);
    p.line(s.qrText ? s.qrText : s.qr);
  } else if (s.qrText) {
    p.feed(1).align('center').line(s.qrText);
  }
  if (s.footer) p.feed(1).align('center').line(s.footer);
  p.feed(s.feed);
  if (s.cut) p.cut();
  return p.bytes();
}

// --- Image e canvas finti: getImageData restituisce nero dove si e disegnata l'immagine ---
function fakeDom(fixtures) {
  const created = [];
  const canvases = [];
  class FakeImage {
    constructor() { created.push(this); }
    set src(v) {
      this._src = v;
      this.crossOriginAtSrc = this.crossOrigin;
      const f = fixtures[v];
      setTimeout(() => {
        if (f === 'hang') return;
        if (!f) { if (this.onerror) this.onerror(new Error('404')); return; }
        this.naturalWidth = f.w;
        this.naturalHeight = f.h;
        if (this.onload) this.onload();
      }, 1);
    }
    get src() { return this._src; }
  }
  const document = {
    createElement(tag) {
      assert.strictEqual(tag, 'canvas');
      const cv = { width: 0, height: 0, draws: [] };
      cv.getContext = () => ({
        fillStyle: '',
        fillRect() {},
        drawImage(img, x, y, w, h) { cv.draws.push({ img, x, y, w, h }); },
        getImageData(x, y, w, h) {
          if (cv.draws.some((d) => d.img.tainted)) throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
          const data = new Uint8ClampedArray(w * h * 4).fill(255);
          cv.draws.forEach((d) => {
            for (let yy = d.y; yy < d.y + d.h; yy++) {
              for (let xx = d.x; xx < d.x + d.w; xx++) {
                const i = (yy * w + xx) * 4;
                data[i] = data[i + 1] = data[i + 2] = 0;
              }
            }
          });
          return { data };
        }
      });
      canvases.push(cv);
      return cv;
    }
  };
  return { Image: FakeImage, document, created, canvases };
}

// Raster finto: 8 punti x 2 righe.
const RASTER = [0x1D, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0xAA, 0x55];

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- Vincoli del file ---

test('escpos.js: solo ASCII, niente eval o new Function, sintassi ES5 (niente =>, let, const, `)', async () => {
  assert.ok(/^[\x00-\x7f]*$/.test(src), 'caratteri non ASCII: usa gli escape \\uXXXX');
  assert.ok(!/\beval\s*\(|new\s+Function/.test(src), 'eval o new Function in escpos.js');
  assert.ok(!/=>|`|\b(let|const|class)\s/.test(src), 'sintassi oltre ES5 in escpos.js');
});

// --- Intestazione, testo, stili ---

test('intestazione ESC @, FS ., ESC t 16 e testo: byte esatti', async () => {
  const g = load();
  assert.deepStrictEqual(await g.PrintBridge.render(text('Ciao')), HEAD.concat([0x43, 0x69, 0x61, 0x6F, 0x0A]));
});

test('code page: dal layout, e opzioni.codepage vale di piu', async () => {
  const g = load();
  const lay = { codepage: 2, blocks: [] };
  assert.deepStrictEqual(await g.PrintBridge.render(lay), [0x1B, 0x40, 0x1C, 0x2E, 0x1B, 0x74, 2]);
  assert.deepStrictEqual(await g.PrintBridge.render(lay, {}, { codepage: 19 }), [0x1B, 0x40, 0x1C, 0x2E, 0x1B, 0x74, 19]);
});

test('stili: align, bold, underline e size con GS !; si mandano solo i cambi e non passano al blocco dopo', async () => {
  const g = load();
  const b = await g.PrintBridge.render({
    blocks: [
      { text: 'G', bold: true, underline: true, size: [2, 3], align: 'right' },
      { text: 'H', bold: true, underline: true, size: [2, 3], align: 'right' },
      { text: 'N' },
      { text: 'Q', size: 2 }
    ]
  });
  assert.deepStrictEqual(b.slice(HEAD.length), [
    0x1B, 0x61, 2, 0x1B, 0x45, 1, 0x1B, 0x2D, 1, 0x1D, 0x21, 0x12, 0x47, 0x0A,
    0x48, 0x0A,
    0x1B, 0x61, 0, 0x1B, 0x45, 0, 0x1B, 0x2D, 0, 0x1D, 0x21, 0x00, 0x4E, 0x0A,
    0x1D, 0x21, 0x11, 0x51, 0x0A
  ]);
});

test('a capo automatico: 32 colonne, 48 con carta da 80, 16 con size [2,1]', async () => {
  const g = load();
  const t = 'uno due tre quattro cinque sei sette otto nove dieci';
  assert.deepStrictEqual(await lines(g, text(t)), ['uno due tre quattro cinque sei', 'sette otto nove dieci']);
  assert.deepStrictEqual(await lines(g, text(t), {}, { paper: 80 }), ['uno due tre quattro cinque sei sette otto nove', 'dieci']);
  assert.deepStrictEqual(await lines(g, text(t), {}, { paper: 576 }), ['uno due tre quattro cinque sei sette otto nove', 'dieci']);
  assert.deepStrictEqual(await lines(g, text(t, { size: [2, 1] })), ['uno due tre', 'quattro cinque', 'sei sette otto', 'nove dieci']);
  assert.deepStrictEqual(await lines(g, text(t, { size: [3, 1] })), ['uno due', 'tre', 'quattro', 'cinque sei', 'sette otto', 'nove dieci']);
});

test('a capo: parole lunghe spezzate, \\n rispettati, spazi intatti se la riga ci sta', async () => {
  const g = load();
  assert.deepStrictEqual(await lines(g, text('x'.repeat(40))), ['x'.repeat(32), 'x'.repeat(8)]);
  assert.deepStrictEqual(await lines(g, text('ab ' + 'y'.repeat(70) + ' cd')), ['ab', 'y'.repeat(32), 'y'.repeat(32), 'y'.repeat(6) + ' cd']);
  assert.deepStrictEqual(await lines(g, text('uno\n\ndue')), ['uno', '', 'due']);
  assert.deepStrictEqual(await lines(g, text('A     B')), ['A     B']);
  assert.deepStrictEqual(await lines(g, text('')), ['']);
});

// --- Segnaposto e filtri ---

test('segnaposto: percorsi a.b, campi mancanti, numeri, booleani, oggetti', async () => {
  const g = load();
  const d = { a: { b: 'B', n: 0 }, n: 3.5, t: true, f: false, o: { k: 1 }, arr: [1], z: null, inf: Infinity };
  assert.strictEqual(g.PrintBridge.format('{{a.b}}|{{a.x.y}}|{{ n }}|{{t}}|{{f}}|{{o}}|{{arr}}|{{z}}|{{a.n}}|{{inf}}|{{}}', d),
    'B||3.5|true|false||||0||');
  assert.deepStrictEqual(await lines(g, text('Ciao {{nome}}, ordine {{ordine.numero}}'), { nome: 'Ada', ordine: { numero: 42 } }), ['Ciao Ada, ordine 42']);
  assert.deepStrictEqual(await lines(g, text('[{{manca}}]')), ['[]']);
  assert.strictEqual(g.PrintBridge.format('{{items.length}}', { items: [1, 2, 3] }), '3');
});

test('segnaposto: solo proprieta proprie, niente prototipo', async () => {
  const g = load();
  assert.strictEqual(g.PrintBridge.format('[{{constructor}}][{{__proto__}}][{{toString}}][{{a.constructor.name}}][{{hasOwnProperty}}][{{s.length}}]',
    { a: {}, s: 'abc' }), '[][][][][][]');
  assert.strictEqual(g.PrintBridge.format('{{__proto__.x}}', JSON.parse('{"__proto__": {"x": "dati"}}')), 'dati');
});

test('filtro euro: it-IT con la virgola, punto delle migliaia, arrotondamento; € = 0x80', async () => {
  const g = load();
  const cases = [
    [1.2, '1,20 €'], [0, '0,00 €'], [1234.5, '1.234,50 €'], [1000000, '1.000.000,00 €'], [-3, '-3,00 €'],
    [1.005, '1,01 €'], [2.675, '2,68 €'], [0.1 + 0.2, '0,30 €'], [-0.001, '0,00 €'], ['2.5', '2,50 €'],
    ['1.234,5', '1.234,50 €'], ['1,5', '1,50 €'], [' 7 ', '7,00 €'], ['Gratis', 'Gratis'], [undefined, ''], [null, ''], [true, 'true']
  ];
  cases.forEach(([v, out]) => assert.strictEqual(g.PrintBridge.format('{{v|euro}}', { v }), out, String(v)));
  assert.strictEqual(g.PrintBridge.format('{{v|euro:0}}', { v: 1234.5 }), '1.235 €');
  const b = await g.PrintBridge.render(text('{{v|euro}}'), { v: 1.2 });
  assert.deepStrictEqual(b.slice(HEAD.length), [0x31, 0x2C, 0x32, 0x30, 0x20, 0x80, 0x0A]);
});

test('filtro num: virgola senza migliaia (come l\'app), decimali a scelta', async () => {
  const g = load();
  const f = (v, arg) => g.PrintBridge.format('{{v|num' + (arg == null ? '' : ':' + arg) + '}}', { v });
  assert.strictEqual(f(1234.5), '1234,50');
  assert.strictEqual(f(2), '2,00');
  assert.strictEqual(f(2.6, 0), '3');
  assert.strictEqual(f(1.23456, 3), '1,235');
  assert.strictEqual(f('x'), 'x');
  assert.strictEqual(f(undefined), '');
});

test('filtro date: true/now = adesso, Date, millisecondi, ISO, formato a scelta', async () => {
  const g = load();
  const f = (tpl, v) => g.PrintBridge.format(tpl, { v }, { now: NOW });
  assert.strictEqual(f('{{v|date}}', true), '17/10/2026 09:05');
  assert.strictEqual(f('{{v|date}}', 'now'), '17/10/2026 09:05');
  assert.strictEqual(f('{{v|date:dd/MM/yy}}', NOW), '17/10/26');
  assert.strictEqual(f('{{v|date:HH:mm:ss}}', NOW.getTime()), '09:05:07');
  assert.strictEqual(f('{{v|date:yyyy-MM-dd}}', '2026-03-04T08:00:00'), '2026-03-04');
  assert.strictEqual(f('{{v|date}}', 'domani'), 'domani');
  assert.strictEqual(f('{{v|date}}', undefined), '');
  assert.strictEqual(f('{{v|date}}', false), '');
  assert.strictEqual(f('{{v}}', NOW), '17/10/2026 09:05', 'una Date senza filtro');
  const now = g.PrintBridge.format('{{v|date:yyyy}}', { v: true });
  assert.strictEqual(now, String(new Date().getFullYear()), 'senza opzioni.now e adesso');
});

test('filtri upper e lower, anche in catena, con gli accenti', async () => {
  const g = load();
  assert.strictEqual(g.PrintBridge.format('{{s|upper}} / {{s|lower}} / {{s|upper|lower}}', { s: 'Caffè Già' }), 'CAFFÈ GIÀ / caffè già / caffè già');
  const b = await g.PrintBridge.render(text('{{s|upper}}'), { s: 'è' });
  assert.deepStrictEqual(b.slice(HEAD.length), [0xC8, 0x0A]);
});

test('filtro sconosciuto: errore chiaro; filtri in piu da opzioni e da PrintBridge.filters', async () => {
  const g = load();
  const e = await rejects(g.PrintBridge.render(text('{{a|boh}}'), { a: 1 }));
  assert.strictEqual(e.code, 'filter');
  assert.ok(/boh/.test(e.message));
  assert.strictEqual(e.name, 'PrintBridgeLayoutError');
  assert.deepStrictEqual(await lines(g, text('{{a|stelle}}'), { a: 'x' }, { filters: { stelle: (v) => '*' + v + '*' } }), ['*x*']);
  g.PrintBridge.filters.tre = (v, arg) => String(v).repeat(Number(arg) || 3);
  assert.deepStrictEqual(await lines(g, text('{{a|tre}} {{a|tre:2}}'), { a: 'o' }), ['ooo oo']);
  assert.strictEqual((await rejects(g.PrintBridge.render(text('{{a|constructor}}')))).code, 'filter');
});

test('caratteri di controllo dei dati tolti: niente comandi iniettati', async () => {
  const g = load();
  const evil = 'A\x1bB\x1dV\x00C\x1b@D\tE\r\nF\x7f';
  assert.deepStrictEqual(await lines(g, text('{{x}}'), { x: evil }), ['ABVC@D E', 'F']);
  const b = await g.PrintBridge.render({ blocks: [{ row: ['{{x}}', '{{x}}'] }] }, { x: 'P\x1bp\x00\x19' });
  assert.deepStrictEqual(b.slice(HEAD.length).filter((x) => x < 0x20), [0x0A]);
});

// --- Righe e colonne ---

function appPad(left, right, width) {
  const space = width - right.length;
  const l = space <= 1 ? '' : left.length >= space ? left.slice(0, space - 1) : left;
  return l + ' '.repeat(Math.max(0, space - l.length)) + right;
}

test('row [sinistra, destra]: uguale a pad() di Receipt.kt (troncamento compreso)', async () => {
  const g = load();
  const pairs = [['Caffè', '2,40'], ['x'.repeat(40), '1,00'], ['', '5'], ['abc', 'y'.repeat(31)], ['abc', 'y'.repeat(30)],
    ['a'.repeat(27), '1,00'], ['a'.repeat(28), '1,00'], ['TOTALE EUR', '1234,50']];
  for (const [l, r] of pairs) {
    assert.deepStrictEqual(await lines(g, { blocks: [{ row: ['{{l}}', '{{r}}'] }] }, { l, r }), [appPad(l, r, 32)], l + ' / ' + r);
  }
  assert.deepStrictEqual(await lines(g, { blocks: [{ row: ['Totale', '3,90'] }] }, {}, { paper: 80 }), [appPad('Totale', '3,90', 48)]);
});

test('row con size [2,x]: colonne dimezzate (16), stile della riga', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({ blocks: [{ row: ['Totale', '3,90 €'], size: [2, 2], bold: true }] }));
  const l = ev.filter((e) => 'line' in e);
  assert.deepStrictEqual(l, [{ line: 'Totale      3,90 €', align: 'left', bold: true, ul: false, size: [2, 2] }].map((x) => Object.assign(x, { line: appPad('Totale', '3,90 €', 16) })));
  assert.strictEqual(l[0].line.length, 16);
  assert.deepStrictEqual(await lines(g, { blocks: [{ row: ['Totale', '3,90'], size: [1, 2] }] }), [appPad('Totale', '3,90', 32)]);
});

test('row con colonne fisse, flessibili e auto; allineamenti; gap', async () => {
  const g = load();
  const r = (row, extra, d) => lines(g, { blocks: [Object.assign({ row }, extra)] }, d);
  // 3 fissa | flessibile | auto a destra
  assert.deepStrictEqual(await r([{ text: '{{q}}x', width: 3 }, { text: '{{n}}' }, { text: '{{p}}', width: 'auto' }], {}, { q: 2, n: 'Cornetto', p: '1,50 €' }),
    ['2x  ' + 'Cornetto'.padEnd(21) + ' 1,50 €']);
  // pesi 1:3 su 31 colonne libere: 7 + 23, il resto (1) alla prima
  assert.deepStrictEqual(await r([{ text: 'a', flex: 1 }, { text: 'b', flex: 3 }]), ['a' + ' '.repeat(8) + ' '.repeat(22) + 'b']);
  // centro e destra espliciti, gap 2
  assert.deepStrictEqual(await r([{ text: 'L', width: 5 }, { text: 'C', width: 5, align: 'center' }, { text: 'R', width: 5, align: 'right' }], { gap: 2 }),
    ['L    ' + '  ' + '  C  ' + '  ' + '    R']);
  // gap 0, forma breve con tre testi: la prima flessibile, le altre auto, l'ultima a destra
  assert.deepStrictEqual(await r(['Caffè', '2x', '2,40'], {}), ['Caffè'.padEnd(24) + ' 2x 2,40']);
  assert.deepStrictEqual(await r(['ab', 'cd'], { gap: 0 }), ['ab' + ' '.repeat(28) + 'cd']);
  // testo lungo troncato, \n diventa spazio
  assert.deepStrictEqual(await r(['{{x}}', 'OK'], {}, { x: 'riga\nunica' }), ['riga unica'.padEnd(29) + ' OK']);
});

test('row con wrap: la colonna va a capo e le altre restano sulla prima riga', async () => {
  const g = load();
  const lay = { blocks: [{ row: [{ text: '{{d}}', wrap: true }, '{{p}}'] }] };
  assert.deepStrictEqual(await lines(g, lay, { d: 'Spremuta d\'arancia fresca grande formato', p: '4,00' }),
    ['Spremuta d\'arancia fresca   4,00', 'grande formato']);
  // wrap sulla riga vale per tutte le colonne; l'ultima resta allineata a destra
  const lay2 = { blocks: [{ row: [{ text: 'aaa bbb', width: 3 }, { text: 'ccc ddd eee', width: 7 }], wrap: true }] };
  assert.deepStrictEqual(await lines(g, lay2), ['aaa ccc ddd', 'bbb     eee']);
  const lay3 = { blocks: [{ row: [{ text: 'aaa bbb', width: 3, wrap: false }, { text: 'ccc ddd eee', width: 7, align: 'left' }], wrap: true }] };
  assert.deepStrictEqual(await lines(g, lay3), ['aaa ccc ddd', '    eee']);
});

// --- Ripetizioni e condizioni ---

test('each: un elemento alla volta, campi del livello sopra, @number, "." per i testi', async () => {
  const g = load();
  const d = { shop: 'S', items: [{ name: 'a' }, { name: 'b', shop: 'T' }], lines: ['uno', 2] };
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'items', text: '{{@number}}. {{name}} ({{shop}}) #{{@index}}' }] }, d),
    ['1. a (S) #0', '2. b (T) #1']);
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'lines', text: '- {{.}} {{this}}' }] }, d), ['- uno uno', '- 2 2']);
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'manca', text: 'x' }, { each: 'shop', text: 'y' }] }, d), []);
});

test('each con blocks: @first, @last, if per elemento, each annidati', async () => {
  const g = load();
  const lay = {
    blocks: [{
      each: 'groups',
      blocks: [
        { 'if': '@first', rule: true },
        { text: '{{name}}' },
        { each: 'items', 'if': 'items', text: '  {{@number}} {{.}} di {{name}}' },
        { 'if': '!@last', text: '~' }
      ]
    }]
  };
  const d = { groups: [{ name: 'G1', items: ['x', 'y'] }, { name: 'G2', items: [] }] };
  assert.deepStrictEqual(await lines(g, lay, d), ['-'.repeat(32), 'G1', '  1 x di G1', '  2 y di G1', '~', 'G2']);
});

test('if: valori falsi e veri, !, &&, ||, true/false; su each vale per tutto il blocco', async () => {
  const g = load();
  const yes = async (cond, d) => (await lines(g, { blocks: [{ 'if': cond, text: 'Y' }] }, d)).length === 1;
  for (const v of [undefined, null, false, 0, '', [], NaN]) assert.strictEqual(await yes('v', { v }), false, String(v));
  for (const v of [true, 1, -1, 'a', '0', [0], {}]) assert.strictEqual(await yes('v', { v }), true, JSON.stringify(v));
  assert.strictEqual(await yes('!v', { v: '' }), true);
  assert.strictEqual(await yes('!!v', { v: 'x' }), true);
  assert.strictEqual(await yes('a && b', { a: 1, b: 0 }), false);
  assert.strictEqual(await yes('a || b', { a: 0, b: 'x' }), true);
  assert.strictEqual(await yes('a && !b || c', { a: 1, b: 1, c: 0 }), false);
  assert.strictEqual(await yes('a && !b || c', { a: 0, b: 1, c: 1 }), true);
  assert.strictEqual(await yes(' x.y ', { x: { y: 1 } }), true);
  assert.strictEqual(await yes(true, {}), true);
  assert.strictEqual(await yes(false, { v: 1 }), false);
  const d = { show: false, items: [{ n: 1 }, { n: 2 }] };
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'items', 'if': 'show', text: '{{n}}' }] }, d), []);
  d.show = true;
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'items', 'if': 'show', text: '{{n}}' }] }, d), ['1', '2']);
  assert.strictEqual((await rejects(g.PrintBridge.render({ blocks: [{ 'if': 'a && !', text: 'x' }] }))).code, 'layout');
});

test('defaults del layout: valgono quando il dato manca o e null', async () => {
  const g = load();
  const lay = { defaults: { who: 'Cliente', n: 3 }, blocks: [{ text: '{{who}} {{n}}' }] };
  assert.deepStrictEqual(await lines(g, lay), ['Cliente 3']);
  assert.deepStrictEqual(await lines(g, lay, { who: 'Ada', n: 0 }), ['Ada 0']);
  assert.deepStrictEqual(await lines(g, lay, { who: null }), ['Cliente 3']);
});

// --- Righe, QR, avanzamento, taglio, byte grezzi ---

test('rule: 32 o 48 trattini, carattere a scelta, stile normale; rule false salta', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({ blocks: [{ text: 'T', bold: true, size: 2, align: 'center' }, { rule: true }, { rule: '=' }, { rule: false }] }));
  const l = ev.filter((e) => 'line' in e);
  assert.deepStrictEqual(l.slice(1), [
    { line: '-'.repeat(32), align: 'left', bold: false, ul: false, size: [1, 1] },
    { line: '='.repeat(32), align: 'left', bold: false, ul: false, size: [1, 1] }
  ]);
  assert.deepStrictEqual(await lines(g, { blocks: [{ rule: true }] }, {}, { paper: 80 }), ['-'.repeat(48)]);
});

test('qr: modulo, correzione, allineamento (centro di default); dati vuoti = niente QR', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({
    blocks: [{ qr: '{{u}}', size: 5, ec: 'h' }, { qr: 'fisso', align: 'left' }, { qr: '{{manca}}' }]
  }, { u: 'https://example.com/r/1' }));
  assert.deepStrictEqual(ev.filter((e) => 'qr' in e), [
    { qr: 'https://example.com/r/1', module: 5, ec: 0x33, align: 'center' },
    { qr: 'fisso', module: 6, ec: 0x31, align: 'left' }
  ]);
  const b = await g.PrintBridge.render({ blocks: [{ qr: 'A', align: 'left' }] });
  assert.deepStrictEqual(b.slice(HEAD.length), new g.EscPos().qr('A', 6, 0x31).bytes());
  assert.strictEqual((await rejects(g.PrintBridge.render({ blocks: [{ qr: 'A', ec: 'Z' }] }))).code, 'layout');
});

test('feed (anche da segnaposto), cut intero o parziale, cut false; raw inviato com\'e', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({
    blocks: [{ feed: 2 }, { feed: '{{n}}' }, { feed: '{{manca}}' }, { cut: true }, { cut: 'partial' }, { cut: false }]
  }, { n: 4 }));
  assert.deepStrictEqual(ev.slice(3), [{ feed: 2 }, { feed: 4 }, { cut: 'full' }, { cut: 'partial' }]);
  const b = await g.PrintBridge.render({ blocks: [{ raw: [0x1B, 0x70, 0, 25, 250] }] });
  assert.deepStrictEqual(b.slice(HEAD.length), [0x1B, 0x70, 0, 25, 250]);
});

// --- Forma del layout ed errori ---

test('layout come testo JSON o per nome; carta da opzioni; errori chiari con la posizione', async () => {
  const g = load();
  assert.deepStrictEqual(await lines(g, JSON.stringify({ paper: 80, blocks: [{ rule: true }] })), ['-'.repeat(48)]);
  assert.deepStrictEqual(await lines(g, { paper: 80, blocks: [{ rule: true }] }, {}, { paper: 58 }), ['-'.repeat(32)]);
  assert.deepStrictEqual(await lines(g, { paper: 384, blocks: [{ rule: true }] }), ['-'.repeat(32)]);
  assert.ok((await lines(g, 'receipt', { shop: 'X' }, { now: NOW })).indexOf('X') >= 0);
  const cases = [
    ['scontrino', /sconosciuto.*receipt/],
    ['{ non json', /JSON del layout/],
    [{}, /blocks/],
    [null, /blocks/],
    [{ blocks: [{ text: 'a' }, { boh: 1 }] }, /blocks\[1\]: blocco non riconosciuto/],
    [{ blocks: [{ blocks: [{ text: 'a' }, 'testo'] }] }, /blocks\[0\]\.blocks\[1\]: blocco non valido/],
    [{ paper: 57, blocks: [] }, /paper/],
    [{ blocks: [{ text: 'a', align: 'middle' }] }, /align/],
    [{ blocks: [{ row: [] }] }, /row/],
    [{ blocks: [{ raw: 'x' }] }, /raw/],
    [{ prepare: 'boh', blocks: [] }, /Preparazione/]
  ];
  for (const [lay, re] of cases) {
    const e = await rejects(g.PrintBridge.render(lay));
    assert.strictEqual(e.code, 'layout', JSON.stringify(lay));
    assert.ok(re.test(e.message), e.message);
  }
  let deep = { text: 'fondo' };
  for (let i = 0; i < 30; i++) deep = { blocks: [deep] };
  assert.ok(/annidati/.test((await rejects(g.PrintBridge.render({ blocks: [deep] }))).message));
  // Mai un'eccezione sincrona: sempre una promessa rifiutata.
  assert.ok(typeof g.PrintBridge.render(undefined).catch(() => {}).then === 'function');
});

// --- Lo scontrino dell'app ---

test('layout receipt: stessi eventi di Receipt.kt (righe, stili, QR, avanzamenti, taglio)', async () => {
  const g = load();
  const nowText = '17/10/2026 09:05';
  const specs = [
    {
      shop: 'NEGOZIO DEMO', title: 'RICEVUTA', subtitle: 'Ordine 42', code: 'ABC123', date: true,
      lines: ['Buono regalo', 'Uso entro 12 mesi'],
      items: [{ desc: 'Caffe', qty: 2, price: 1.20 }, { desc: 'Spremuta d\'arancia fresca grande', qty: 1, price: 4 }, 'non una voce'],
      total: '', qr: 'https://example.com/r/ABC123', qrText: 'Scansiona per la ricevuta', footer: 'Grazie e arrivederci',
      cut: true, feed: 3
    },
    {},
    { shop: 'Bar', date: false, total: '5,00' },
    { date: false, total: 3.9, qr: 'https://example.com/q' },
    { qrText: 'Solo testo', footer: 'Ciao', cut: false, feed: 0 },
    { items: [{ desc: 'Senza prezzo' }, { desc: 'Tre pezzi', qty: 3, price: 0.5 }], lines: ['Nota'] },
    { code: 'X1', items: [{ desc: 'Gratis', price: 0 }] }
  ];
  for (const spec of specs) {
    const mine = decode(await g.PrintBridge.render(g.PrintBridge.layouts.receipt, spec, { now: NOW }));
    const app = decode(appReceipt(g, spec, nowText));
    assert.deepStrictEqual(mine, app, JSON.stringify(spec));
  }
});

test('layout receipt con logo: il raster di opzioni.logo, centrato, poi una riga vuota come nell\'app', async () => {
  const g = load();
  const spec = { logo: true, shop: 'Bar', date: false };
  const mine = decode(await g.PrintBridge.render('receipt', spec, { logo: RASTER }));
  assert.deepStrictEqual(mine, decode(appReceipt(g, spec, '', RASTER)));
  assert.strictEqual(mine[3].align, 'center');
  const e = await rejects(g.PrintBridge.render('receipt', spec));
  assert.strictEqual(e.code, 'logo-missing');
  assert.ok(/opzioni\.logo/.test(e.message));
});

test('PrintBridge.prepare.receipt: amount = qty x price, total calcolato solo se manca', async () => {
  const g = load();
  const d = g.PrintBridge.prepare.receipt({ items: [{ desc: 'a', qty: '2', price: '1,5' }, { desc: 'b' }, null, [1]], extra: 1 });
  assert.deepStrictEqual(d.items.map((i) => [i.desc, i.qty, i.price, i.amount]), [['a', 2, 1.5, 3], ['b', 1, 0, 0]]);
  assert.strictEqual(d.total, '3,00');
  assert.strictEqual(d.extra, 1);
  assert.strictEqual(g.PrintBridge.prepare.receipt({ total: 7, items: [{ price: 1 }] }).total, '7');
  assert.strictEqual(g.PrintBridge.prepare.receipt({}).total, '');
});

// --- Logo ---

test('logo da raster gia pronto (array o Uint8Array): inserito com\'e, centrato', async () => {
  const g = load();
  const b = await g.PrintBridge.render({ blocks: [{ logo: RASTER }, { text: 'x' }] });
  assert.deepStrictEqual(b.slice(HEAD.length), [0x1B, 0x61, 1].concat(RASTER, [0x1B, 0x61, 0, 0x78, 0x0A]));
  const b2 = await g.PrintBridge.render({ blocks: [{ logo: true }] }, {}, { logo: Uint8Array.from(RASTER) });
  assert.deepStrictEqual(b2.slice(HEAD.length), [0x1B, 0x61, 1].concat(RASTER));
});

test('logo: segnaposto vuoto = niente logo; senza Image un URL da\' un errore chiaro', async () => {
  const g = load();
  assert.deepStrictEqual(await g.PrintBridge.render({ blocks: [{ logo: '{{logo}}' }] }), HEAD);
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'logo.png' }] }));
  assert.strictEqual(e.code, 'logo-load');
  assert.ok(/raster/.test(e.message));
});

function rowOf(ev, band, row) {
  const r = ev.filter((e) => e.raster)[band];
  const bpr = r.raster[0] / 8;
  return r.data.slice(row * bpr, (row + 1) * bpr);
}

test('logo da URL: crossOrigin prima di src, alto al massimo 240 punti, bande da 128, centrato', async () => {
  const dom = fakeDom({ 'logo.png': { w: 200, h: 400 } });
  const g = load({ Image: dom.Image, document: dom.document });
  const ev = decode(await g.PrintBridge.render({ blocks: [{ logo: 'logo.png' }] }));
  assert.strictEqual(dom.created.length, 1);
  assert.strictEqual(dom.created[0].crossOriginAtSrc, 'anonymous', 'crossOrigin va impostato prima di src');
  assert.deepStrictEqual(ev.filter((e) => e.raster).map((e) => [e.raster, e.align]), [[[384, 128], 'center'], [[384, 112], 'center']]);
  // 200x400 in 384x240: largo 120, da 132 a 251
  const row = rowOf(ev, 0, 0);
  const expected = new Array(48).fill(0);
  expected[16] = 0x0F;
  for (let i = 17; i <= 30; i++) expected[i] = 0xFF;
  expected[31] = 0xF0;
  assert.deepStrictEqual(row, expected);
  assert.deepStrictEqual(rowOf(ev, 1, 111), expected);
});

test('logo da URL: cache per src (un solo caricamento), raster per carta e maxHeight', async () => {
  const dom = fakeDom({ 'https://cdn.example/logo.png': { w: 200, h: 400 } });
  const g = load({ Image: dom.Image, document: dom.document });
  const lay = { blocks: [{ logo: '{{logo}}' }] };
  const d = { logo: 'https://cdn.example/logo.png' };
  const a = await g.PrintBridge.render(lay, d);
  const b = await g.PrintBridge.render(lay, d);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(dom.created.length, 1, 'immagine caricata una volta');
  assert.strictEqual(dom.canvases.length, 1, 'raster preparato una volta');
  const ev80 = decode(await g.PrintBridge.render(lay, d, { paper: 80 }));
  assert.deepStrictEqual(ev80.filter((e) => e.raster).map((e) => e.raster), [[576, 128], [576, 112]]);
  assert.strictEqual(dom.created.length, 1);
  assert.strictEqual(dom.canvases.length, 2);
  const small = decode(await g.PrintBridge.render({ blocks: [{ logo: '{{logo}}', maxHeight: 100 }] }, d));
  assert.deepStrictEqual(small.filter((e) => e.raster).map((e) => e.raster), [[384, 100]]);
  g.PrintBridge.clearCache();
  await g.PrintBridge.render(lay, d);
  assert.strictEqual(dom.created.length, 2, 'dopo clearCache si ricarica');
});

test('logo da URL non caricato: errore con il suggerimento CORS (solo se di un altro dominio), niente cache', async () => {
  const dom = fakeDom({});
  const g = load({ Image: dom.Image, document: dom.document, location: { origin: 'https://shop.example' } });
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'https://cdn.example/x.png' }] }));
  assert.strictEqual(e.code, 'logo-load');
  assert.ok(/Access-Control-Allow-Origin/.test(e.message), e.message);
  await rejects(g.PrintBridge.render({ blocks: [{ logo: 'https://cdn.example/x.png' }] }));
  assert.strictEqual(dom.created.length, 2, 'un caricamento fallito non resta in cache');
  const same = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'https://shop.example/x.png' }] }));
  assert.ok(!/CORS/.test(same.message), same.message);
  const rel = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'manca.png' }] }));
  assert.ok(/manca\.png/.test(rel.message) && !/CORS/.test(rel.message), rel.message);
});

test('logo con canvas "tainted" (immagine di un altro dominio senza CORS): errore chiaro in italiano', async () => {
  const dom = fakeDom({});
  const g = load({ Image: dom.Image, document: dom.document });
  const img = { naturalWidth: 100, naturalHeight: 50, complete: true, tainted: true };
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: img }] }));
  assert.strictEqual(e.code, 'logo-cors');
  assert.ok(/altro dominio/.test(e.message) && /CORS/.test(e.message) && /tainted/.test(e.message), e.message);
});

test('logo da immagine della pagina: aspetta il caricamento se non e completa', async () => {
  const dom = fakeDom({});
  const g = load({ Image: dom.Image, document: dom.document });
  const handlers = {};
  const img = { complete: false, addEventListener: (t, fn) => { handlers[t] = fn; } };
  const p = g.PrintBridge.render({ blocks: [{ logo: img }] });
  await new Promise((r) => setTimeout(r, 5));
  img.naturalWidth = 384;
  img.naturalHeight = 10;
  img.complete = true;
  handlers.load();
  const ev = decode(await p);
  assert.deepStrictEqual(ev.filter((x) => x.raster).map((x) => x.raster), [[384, 10]]);
  const bad = await rejects(g.PrintBridge.render({ blocks: [{ logo: { complete: true } }] }));
  assert.strictEqual(bad.code, 'logo-load');
});

test('logo da URL che non risponde: errore dopo 10 s', async () => {
  const dom = fakeDom({ 'lento.png': 'hang' });
  const g = load({ Image: dom.Image, document: dom.document });
  const t0 = Date.now();
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'lento.png' }] }));
  assert.strictEqual(e.code, 'logo-load');
  assert.ok(/entro 10 s/.test(e.message), e.message);
  assert.ok(Date.now() - t0 < 2000);
});

// --- RawBT.printLayout ---

function stubTransports(g, paired) {
  const calls = { sent: [], pair: [] };
  let isPaired = paired;
  g.RawBT.send = (bytes, opts) => { calls.sent.push(['app', bytes, opts]); return Promise.resolve({ ok: true, bytes: bytes.length }); };
  g.RawBT.ble.print = (bytes, opts) => { calls.sent.push(['ble', bytes, opts]); return Promise.resolve({ ok: true, bytes: bytes.length }); };
  g.RawBT.ble.info = () => ({ paired: isPaired });
  g.RawBT.ble.pair = (opts) => { calls.pair.push(opts); isPaired = true; return Promise.resolve({ paired: true }); };
  return calls;
}

test('printLayout: stessi byte via app e via BLE, opzioni passate al trasporto', async () => {
  const g = load();
  const calls = stubTransports(g, true);
  const lay = { blocks: [{ text: 'Ciao {{n}}' }, { cut: true }] };
  const expected = await g.PrintBridge.render(lay, { n: 'Ada' });
  const onProgress = () => {};
  const r1 = await g.RawBT.printLayout(lay, { n: 'Ada' }, { via: 'app', timeoutMs: 5000 });
  const r2 = await g.RawBT.printLayout(lay, { n: 'Ada' }, { via: 'ble', onProgress });
  await g.RawBT.printLayout(lay, { n: 'Ada' });
  assert.deepStrictEqual(calls.sent.map((c) => c[0]), ['app', 'ble', 'app'], 'via predefinita: app');
  calls.sent.forEach((c) => assert.deepStrictEqual(c[1], expected));
  assert.strictEqual(calls.sent[0][2].timeoutMs, 5000);
  assert.strictEqual(calls.sent[1][2].onProgress, onProgress);
  assert.strictEqual(r1.ok && r2.ok, true);
  assert.strictEqual(calls.pair.length, 0);
});

test('printLayout via BLE senza stampante: l\'elenco di Chrome si apre subito (gesto), poi stampa', async () => {
  const g = load();
  const calls = stubTransports(g, false);
  const p = g.RawBT.printLayout({ blocks: [{ text: 'x' }] }, {}, { via: 'ble' });
  assert.strictEqual(calls.pair.length, 1, 'pair va chiamata in modo sincrono');
  assert.deepStrictEqual(calls.pair[0], { sameName: true });
  await p;
  assert.deepStrictEqual(calls.sent.map((c) => c[0]), ['ble']);
});

test('printLayout: via sbagliata o layout sbagliato = promessa rifiutata, niente stampa', async () => {
  const g = load();
  const calls = stubTransports(g, true);
  assert.strictEqual((await rejects(g.RawBT.printLayout({ blocks: [] }, {}, { via: 'usb' }))).code, 'via');
  assert.strictEqual((await rejects(g.RawBT.printLayout({ blocks: [{ boh: 1 }] }, {}, { via: 'ble' }))).code, 'layout');
  assert.strictEqual(calls.sent.length, 0);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('OK   ' + name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n     '));
    }
  }
  console.log(failed ? failed + ' PROVE FALLITE' : 'TUTTO OK (' + tests.length + ' prove)');
  process.exit(failed ? 1 : 0);
})();
