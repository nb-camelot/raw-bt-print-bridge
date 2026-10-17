// Tests of PrintBridge.render and RawBT.printLayout (escpos.js), the print layouts, without a
// printer. Blocks are tested without a canvas; the logo with a ready-made raster and with a fake
// Image and canvas; the transports with stubs.
// Usage: node test/layout-test.js escpos.js
'use strict';
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const SCALE = 50; // timers 50 times faster: the 10 s logo timeout becomes 200 ms
const NOW = new Date(2026, 9, 17, 9, 5, 7); // 17/10/2026 09:05:07, local time
const HEAD = [0x1B, 0x40, 0x1C, 0x2E, 0x1B, 0x74, 16]; // ESC @, FS ., ESC t 16

function storage() {
  const m = {};
  return {
    m,
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}

function load(extra = {}) {
  const g = Object.assign({ navigator: {}, localStorage: storage(), Promise, Date, JSON }, extra);
  g.window = g;
  const fast = (fn, ms) => setTimeout(fn, Math.max(0, (ms || 0) / SCALE));
  // EscPos.rasterize uses document without window in front: it is passed as a parameter too.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', src)(g, g.document, fast, clearTimeout);
  return g;
}

// --- ESC/POS decoder: lines with the style in force, QR codes, rasters, feeds, cuts ---
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
      throw new Error('unknown command 0x' + b.toString(16) + ' 0x' + (c || 0).toString(16) + ' at byte ' + i);
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
  throw new Error('should have failed');
}

// --- Reference: Receipt.parse + Receipt.render of the app (android/.../Receipt.kt) ---
// Translated line by line. One deliberate difference, the same as in the renderer: FS .
// (kanjiOff) in the header. EscPos.size writes GS !, as the renderer does.
function appReceipt(g, o, now, logoRaster) {
  const optString = (k) => (o[k] == null ? '' : String(o[k]));
  const optBoolean = (k, def) => (typeof o[k] === 'boolean' ? o[k] : def);
  const optInt = (k, def) => (typeof o[k] === 'number' ? Math.trunc(o[k]) : def);
  const s = {
    shop: optString('shop'), title: optString('title'), subtitle: optString('subtitle'), code: optString('code'),
    date: optBoolean('date', true), total: optString('total'), qr: optString('qr'), qrText: optString('qrText'),
    footer: optString('footer'), logo: optBoolean('logo', false), cut: optBoolean('cut', true),
    width: Math.min(64, Math.max(16, optInt('width', 32))),
    feed: Math.min(20, Math.max(0, optInt('feed', 3))),
    lines: (o.lines || []).map((x) => String(x)),
    items: (o.items || []).filter((x) => x && typeof x === 'object').map((x) => ({
      desc: x.desc == null ? '' : String(x.desc),
      qty: typeof x.qty === 'number' ? x.qty : 1,
      price: typeof x.price === 'number' ? x.price : 0
    }))
  };
  const p = new g.EscPos();
  const fmt = (v) => v.toFixed(2).replace('.', ','); // String.format(Locale.ITALY, "%.2f", v)
  const pad = (left, right, width) => {
    const space = width - right.length;
    const l = space <= 1 ? '' : left.length >= space ? left.slice(0, space - 1) : left;
    return l + ' '.repeat(Math.max(0, space - l.length)) + right;
  };
  const width = s.width;
  p.init().kanjiOff().codepage(0x10);
  if (s.logo) { p.align('center'); p.image(logoRaster); p.line(''); }
  if (s.shop) p.align('center').bold(true).size(2, 2).line(s.shop).size(1, 1).bold(false);
  if (s.title) p.align('center').bold(true).size(2, 1).line(s.title).size(1, 1).bold(false);
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
  if (totalValue) p.bold(true).size(1, 2).line(pad('TOTALE EUR', totalValue, width)).size(1, 1).bold(false);
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

// --- Fake Image and canvas: getImageData returns black where the image was drawn ---
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

// Fake raster: 8 dots x 2 rows.
const RASTER = [0x1D, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0xAA, 0x55];

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- Constraints of the file ---

test('escpos.js: ASCII only, no eval or new Function, ES5 syntax (no =>, let, const, `)', async () => {
  assert.ok(/^[\x00-\x7f]*$/.test(src), 'non-ASCII characters: use \\uXXXX escapes');
  assert.ok(!/\beval\s*\(|new\s+Function/.test(src), 'eval or new Function in escpos.js');
  // Rough: arrows, template strings, and let/const/class where a statement or a for begins.
  assert.ok(!/=>|`|^\s*(let|const|class)\s|\(\s*(let|const)\s/m.test(src), 'syntax beyond ES5 in escpos.js');
});

// --- Header, text, styles ---

test('header ESC @, FS ., ESC t 16 and text: exact bytes', async () => {
  const g = load();
  assert.deepStrictEqual(await g.PrintBridge.render(text('Ciao')), HEAD.concat([0x43, 0x69, 0x61, 0x6F, 0x0A]));
});

test('code page: from the layout, and options.codepage wins', async () => {
  const g = load();
  const lay = { codepage: 2, blocks: [] };
  assert.deepStrictEqual(await g.PrintBridge.render(lay), [0x1B, 0x40, 0x1C, 0x2E, 0x1B, 0x74, 2]);
  assert.deepStrictEqual(await g.PrintBridge.render(lay, {}, { codepage: 19 }), [0x1B, 0x40, 0x1C, 0x2E, 0x1B, 0x74, 19]);
});

test('styles: align, bold, underline and size with GS !; only changes are sent, nothing leaks to the next block', async () => {
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

test('EscPos.size writes GS !, not ESC ! (which reads the same bits as font B and double height)', async () => {
  const g = load();
  assert.deepStrictEqual(new g.EscPos().size(2, 2).bytes(), [0x1D, 0x21, 0x11]);
  assert.deepStrictEqual(new g.EscPos().size(2, 1).size(1, 2).bytes(), [0x1D, 0x21, 0x10, 0x1D, 0x21, 0x01]);
  assert.deepStrictEqual(new g.EscPos().size(1, 1).size().size(9, 0).bytes(), [0x1D, 0x21, 0x00, 0x1D, 0x21, 0x00, 0x1D, 0x21, 0x70]);
});

test('word wrap: 32 columns, 48 with 80 mm paper, 16 with size [2,1]', async () => {
  const g = load();
  const t = 'uno due tre quattro cinque sei sette otto nove dieci';
  assert.deepStrictEqual(await lines(g, text(t)), ['uno due tre quattro cinque sei', 'sette otto nove dieci']);
  assert.deepStrictEqual(await lines(g, text(t), {}, { paper: 80 }), ['uno due tre quattro cinque sei sette otto nove', 'dieci']);
  assert.deepStrictEqual(await lines(g, text(t), {}, { paper: 576 }), ['uno due tre quattro cinque sei sette otto nove', 'dieci']);
  assert.deepStrictEqual(await lines(g, text(t, { size: [2, 1] })), ['uno due tre', 'quattro cinque', 'sei sette otto', 'nove dieci']);
  assert.deepStrictEqual(await lines(g, text(t, { size: [3, 1] })), ['uno due', 'tre', 'quattro', 'cinque sei', 'sette otto', 'nove dieci']);
});

test('word wrap: long words split, \\n kept, spaces untouched when the line fits', async () => {
  const g = load();
  assert.deepStrictEqual(await lines(g, text('x'.repeat(40))), ['x'.repeat(32), 'x'.repeat(8)]);
  assert.deepStrictEqual(await lines(g, text('ab ' + 'y'.repeat(70) + ' cd')), ['ab', 'y'.repeat(32), 'y'.repeat(32), 'y'.repeat(6) + ' cd']);
  assert.deepStrictEqual(await lines(g, text('uno\n\ndue')), ['uno', '', 'due']);
  assert.deepStrictEqual(await lines(g, text('A     B')), ['A     B']);
  assert.deepStrictEqual(await lines(g, text('')), ['']);
});

test('columns: a number or a placeholder (16-64) replaces those of the paper', async () => {
  const g = load();
  assert.deepStrictEqual(await lines(g, { columns: 40, blocks: [{ rule: true }] }), ['-'.repeat(40)]);
  assert.deepStrictEqual(await lines(g, { columns: '{{w}}', blocks: [{ rule: true }] }, { w: 42 }), ['-'.repeat(42)]);
  assert.deepStrictEqual(await lines(g, { columns: '{{w}}', blocks: [{ rule: true }] }, {}, { paper: 80 }), ['-'.repeat(48)]);
  assert.deepStrictEqual(await lines(g, { columns: 8, blocks: [{ rule: true }] }), ['-'.repeat(16)]);
  assert.deepStrictEqual(await lines(g, { columns: 40, blocks: [{ row: ['a', 'b'], size: [2, 1] }] }), ['a' + ' '.repeat(18) + 'b']);
});

// --- Placeholders and filters ---

test('placeholders: a.b paths, missing fields, numbers, booleans, objects', async () => {
  const g = load();
  const d = { a: { b: 'B', n: 0 }, n: 3.5, t: true, f: false, o: { k: 1 }, arr: [1], z: null, inf: Infinity };
  assert.strictEqual(g.PrintBridge.format('{{a.b}}|{{a.x.y}}|{{ n }}|{{t}}|{{f}}|{{o}}|{{arr}}|{{z}}|{{a.n}}|{{inf}}|{{}}', d),
    'B||3.5|true|false||||0||');
  assert.deepStrictEqual(await lines(g, text('Ciao {{nome}}, ordine {{ordine.numero}}'), { nome: 'Ada', ordine: { numero: 42 } }), ['Ciao Ada, ordine 42']);
  assert.deepStrictEqual(await lines(g, text('[{{missing}}]')), ['[]']);
  assert.strictEqual(g.PrintBridge.format('{{items.length}}', { items: [1, 2, 3] }), '3');
});

test('placeholders: own properties only, no prototype', async () => {
  const g = load();
  assert.strictEqual(g.PrintBridge.format('[{{constructor}}][{{__proto__}}][{{toString}}][{{a.constructor.name}}][{{hasOwnProperty}}][{{s.length}}]',
    { a: {}, s: 'abc' }), '[][][][][][]');
  assert.strictEqual(g.PrintBridge.format('{{__proto__.x}}', JSON.parse('{"__proto__": {"x": "data"}}')), 'data');
});

test('euro filter: it-IT with decimal comma, thousands dot, rounding; € = 0x80', async () => {
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

test('num filter: decimal comma without thousands (as the app), decimals by argument', async () => {
  const g = load();
  const f = (v, arg) => g.PrintBridge.format('{{v|num' + (arg == null ? '' : ':' + arg) + '}}', { v });
  assert.strictEqual(f(1234.5), '1234,50');
  assert.strictEqual(f(2), '2,00');
  assert.strictEqual(f(2.6, 0), '3');
  assert.strictEqual(f(1.23456, 3), '1,235');
  assert.strictEqual(f('x'), 'x');
  assert.strictEqual(f(undefined), '');
});

test('date filter: true/now = now, Date, milliseconds, ISO, custom format', async () => {
  const g = load();
  const f = (tpl, v) => g.PrintBridge.format(tpl, { v }, { now: NOW });
  assert.strictEqual(f('{{v|date}}', true), '17/10/2026 09:05');
  assert.strictEqual(f('{{v|date}}', 'now'), '17/10/2026 09:05');
  assert.strictEqual(f('{{v|date:dd/MM/yy}}', NOW), '17/10/26');
  assert.strictEqual(f('{{v|date:HH:mm:ss}}', NOW.getTime()), '09:05:07');
  assert.strictEqual(f('{{v|date:yyyy-MM-dd}}', '2026-03-04T08:00:00'), '2026-03-04');
  assert.strictEqual(f('{{v|date}}', 'tomorrow'), 'tomorrow');
  assert.strictEqual(f('{{v|date}}', undefined), '');
  assert.strictEqual(f('{{v|date}}', false), '');
  assert.strictEqual(f('{{v}}', NOW), '17/10/2026 09:05', 'a Date without filter');
  const now = g.PrintBridge.format('{{v|date:yyyy}}', { v: true });
  assert.strictEqual(now, String(new Date().getFullYear()), 'without options.now it is now');
});

test('upper and lower filters, chained too, with accents', async () => {
  const g = load();
  assert.strictEqual(g.PrintBridge.format('{{s|upper}} / {{s|lower}} / {{s|upper|lower}}', { s: 'Caffè Già' }), 'CAFFÈ GIÀ / caffè già / caffè già');
  const b = await g.PrintBridge.render(text('{{s|upper}}'), { s: 'è' });
  assert.deepStrictEqual(b.slice(HEAD.length), [0xC8, 0x0A]);
});

test('unknown filter: clear error; extra filters from options and PrintBridge.filters', async () => {
  const g = load();
  const e = await rejects(g.PrintBridge.render(text('{{a|boh}}'), { a: 1 }));
  assert.strictEqual(e.code, 'filter');
  assert.strictEqual(e.message, 'Unknown filter "boh" in {{a|boh}}');
  assert.strictEqual(e.name, 'PrintBridgeLayoutError');
  assert.deepStrictEqual(await lines(g, text('{{a|stars}}'), { a: 'x' }, { filters: { stars: (v) => '*' + v + '*' } }), ['*x*']);
  g.PrintBridge.filters.three = (v, arg) => String(v).repeat(Number(arg) || 3);
  assert.deepStrictEqual(await lines(g, text('{{a|three}} {{a|three:2}}'), { a: 'o' }), ['ooo oo']);
  assert.strictEqual((await rejects(g.PrintBridge.render(text('{{a|constructor}}')))).code, 'filter');
});

test('messages: one table (PrintBridge.messages), replaceable for translations', async () => {
  const g = load();
  assert.strictEqual(typeof g.PrintBridge.messages.unknownFilter, 'string');
  g.PrintBridge.messages.unknownFilter = 'Filtro sconosciuto «{name}» in {expr}';
  const e = await rejects(g.PrintBridge.render(text('{{a|boh}}')));
  assert.strictEqual(e.message, 'Filtro sconosciuto «boh» in {{a|boh}}');
  Object.keys(g.PrintBridge.messages).forEach((k) => assert.ok(/^[\x00-\x7f]*$/.test(g.PrintBridge.messages[k]) || k === 'unknownFilter', k));
});

test('control characters in the data dropped: no injected commands', async () => {
  const g = load();
  const evil = 'A\x1bB\x1dV\x00C\x1b@D\tE\r\nF\x7f';
  assert.deepStrictEqual(await lines(g, text('{{x}}'), { x: evil }), ['ABVC@D E', 'F']);
  const b = await g.PrintBridge.render({ blocks: [{ row: ['{{x}}', '{{x}}'] }] }, { x: 'P\x1bp\x00\x19' });
  assert.deepStrictEqual(b.slice(HEAD.length).filter((x) => x < 0x20), [0x0A]);
});

// --- Rows and columns ---

function appPad(left, right, width) {
  const space = width - right.length;
  const l = space <= 1 ? '' : left.length >= space ? left.slice(0, space - 1) : left;
  return l + ' '.repeat(Math.max(0, space - l.length)) + right;
}

test('row [left, right]: same as pad() in Receipt.kt (cutting included)', async () => {
  const g = load();
  const pairs = [['Caffè', '2,40'], ['x'.repeat(40), '1,00'], ['', '5'], ['abc', 'y'.repeat(31)], ['abc', 'y'.repeat(30)],
    ['a'.repeat(27), '1,00'], ['a'.repeat(28), '1,00'], ['TOTALE EUR', '1234,50']];
  for (const [l, r] of pairs) {
    assert.deepStrictEqual(await lines(g, { blocks: [{ row: ['{{l}}', '{{r}}'] }] }, { l, r }), [appPad(l, r, 32)], l + ' / ' + r);
  }
  assert.deepStrictEqual(await lines(g, { blocks: [{ row: ['Totale', '3,90'] }] }, {}, { paper: 80 }), [appPad('Totale', '3,90', 48)]);
});

test('row with size [2,x]: half the columns (16), style of the row', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({ blocks: [{ row: ['Totale', '3,90 €'], size: [2, 2], bold: true }] }));
  const l = ev.filter((e) => 'line' in e);
  assert.deepStrictEqual(l, [{ line: appPad('Totale', '3,90 €', 16), align: 'left', bold: true, ul: false, size: [2, 2] }]);
  assert.strictEqual(l[0].line.length, 16);
  assert.deepStrictEqual(await lines(g, { blocks: [{ row: ['Totale', '3,90'], size: [1, 2] }] }), [appPad('Totale', '3,90', 32)]);
});

test('row with fixed, flexible and auto columns; alignments; gap', async () => {
  const g = load();
  const r = (row, extra, d) => lines(g, { blocks: [Object.assign({ row }, extra)] }, d);
  // fixed 3 | flexible | auto on the right
  assert.deepStrictEqual(await r([{ text: '{{q}}x', width: 3 }, { text: '{{n}}' }, { text: '{{p}}', width: 'auto' }], {}, { q: 2, n: 'Cornetto', p: '1,50 €' }),
    ['2x  ' + 'Cornetto'.padEnd(21) + ' 1,50 €']);
  // weights 1:3 over 31 free columns: 7 + 23, the remainder (1) to the first one
  assert.deepStrictEqual(await r([{ text: 'a', flex: 1 }, { text: 'b', flex: 3 }]), ['a' + ' '.repeat(8) + ' '.repeat(22) + 'b']);
  // explicit center and right, gap 2
  assert.deepStrictEqual(await r([{ text: 'L', width: 5 }, { text: 'C', width: 5, align: 'center' }, { text: 'R', width: 5, align: 'right' }], { gap: 2 }),
    ['L    ' + '  ' + '  C  ' + '  ' + '    R']);
  // short form with three texts: the first flexible, the others auto, the last right-aligned
  assert.deepStrictEqual(await r(['Caffè', '2x', '2,40'], {}), ['Caffè'.padEnd(24) + ' 2x 2,40']);
  assert.deepStrictEqual(await r(['ab', 'cd'], { gap: 0 }), ['ab' + ' '.repeat(28) + 'cd']);
  // \n becomes a space
  assert.deepStrictEqual(await r(['{{x}}', 'OK'], {}, { x: 'riga\nunica' }), ['riga unica'.padEnd(29) + ' OK']);
});

test('row with wrap: the column wraps and the others stay on the first line', async () => {
  const g = load();
  const lay = { blocks: [{ row: [{ text: '{{d}}', wrap: true }, '{{p}}'] }] };
  assert.deepStrictEqual(await lines(g, lay, { d: 'Spremuta d\'arancia fresca grande formato', p: '4,00' }),
    ['Spremuta d\'arancia fresca   4,00', 'grande formato']);
  // wrap on the row applies to every column; the last one stays right-aligned
  const lay2 = { blocks: [{ row: [{ text: 'aaa bbb', width: 3 }, { text: 'ccc ddd eee', width: 7 }], wrap: true }] };
  assert.deepStrictEqual(await lines(g, lay2), ['aaa ccc ddd', 'bbb     eee']);
  const lay3 = { blocks: [{ row: [{ text: 'aaa bbb', width: 3, wrap: false }, { text: 'ccc ddd eee', width: 7, align: 'left' }], wrap: true }] };
  assert.deepStrictEqual(await lines(g, lay3), ['aaa ccc ddd', '    eee']);
});

// --- Repetitions and conditions ---

test('each: one element at a time, fields of the level above, @number, "." for texts', async () => {
  const g = load();
  const d = { shop: 'S', items: [{ name: 'a' }, { name: 'b', shop: 'T' }], lines: ['uno', 2] };
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'items', text: '{{@number}}. {{name}} ({{shop}}) #{{@index}}' }] }, d),
    ['1. a (S) #0', '2. b (T) #1']);
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'lines', text: '- {{.}} {{this}}' }] }, d), ['- uno uno', '- 2 2']);
  assert.deepStrictEqual(await lines(g, { blocks: [{ each: 'missing', text: 'x' }, { each: 'shop', text: 'y' }] }, d), []);
});

test('each with blocks: @first, @last, if per element, nested each', async () => {
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

test('if: false and true values, !, &&, ||, true/false; on each it applies to the whole block', async () => {
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
  const e = await rejects(g.PrintBridge.render({ blocks: [{ 'if': 'a && !', text: 'x' }] }));
  assert.strictEqual(e.code, 'layout');
  assert.strictEqual(e.message, 'blocks[0]: invalid condition "a && !"');
});

test('layout defaults: used when the field is missing or null', async () => {
  const g = load();
  const lay = { defaults: { who: 'Cliente', n: 3 }, blocks: [{ text: '{{who}} {{n}}' }] };
  assert.deepStrictEqual(await lines(g, lay), ['Cliente 3']);
  assert.deepStrictEqual(await lines(g, lay, { who: 'Ada', n: 0 }), ['Ada 0']);
  assert.deepStrictEqual(await lines(g, lay, { who: null }), ['Cliente 3']);
});

// --- Rules, QR, feed, cut, raw bytes ---

test('rule: 32 or 48 dashes, custom character, plain style; rule false is skipped', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({ blocks: [{ text: 'T', bold: true, size: 2, align: 'center' }, { rule: true }, { rule: '=' }, { rule: false }] }));
  const l = ev.filter((e) => 'line' in e);
  assert.deepStrictEqual(l.slice(1), [
    { line: '-'.repeat(32), align: 'left', bold: false, ul: false, size: [1, 1] },
    { line: '='.repeat(32), align: 'left', bold: false, ul: false, size: [1, 1] }
  ]);
  assert.deepStrictEqual(await lines(g, { blocks: [{ rule: true }] }, {}, { paper: 80 }), ['-'.repeat(48)]);
});

test('qr: module, error correction, alignment (center by default); empty data = no QR', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({
    blocks: [{ qr: '{{u}}', size: 5, ec: 'h' }, { qr: 'fixed', align: 'left' }, { qr: '{{missing}}' }]
  }, { u: 'https://example.com/r/1' }));
  assert.deepStrictEqual(ev.filter((e) => 'qr' in e), [
    { qr: 'https://example.com/r/1', module: 5, ec: 0x33, align: 'center' },
    { qr: 'fixed', module: 6, ec: 0x31, align: 'left' }
  ]);
  const b = await g.PrintBridge.render({ blocks: [{ qr: 'A', align: 'left' }] });
  assert.deepStrictEqual(b.slice(HEAD.length), new g.EscPos().qr('A', 6, 0x31).bytes());
  assert.strictEqual((await rejects(g.PrintBridge.render({ blocks: [{ qr: 'A', ec: 'Z' }] }))).code, 'layout');
});

test('feed (also from a placeholder), full or partial cut, cut false; raw sent as it is', async () => {
  const g = load();
  const ev = decode(await g.PrintBridge.render({
    blocks: [{ feed: 2 }, { feed: '{{n}}' }, { feed: '{{missing}}' }, { cut: true }, { cut: 'partial' }, { cut: false }]
  }, { n: 4 }));
  assert.deepStrictEqual(ev.slice(3), [{ feed: 2 }, { feed: 4 }, { cut: 'full' }, { cut: 'partial' }]);
  const b = await g.PrintBridge.render({ blocks: [{ raw: [0x1B, 0x70, 0, 25, 250] }] });
  assert.deepStrictEqual(b.slice(HEAD.length), [0x1B, 0x70, 0, 25, 250]);
});

// --- Shape of the layout and errors ---

test('layout as JSON text or by name; paper from options; clear errors with the position', async () => {
  const g = load();
  assert.deepStrictEqual(await lines(g, JSON.stringify({ paper: 80, blocks: [{ rule: true }] })), ['-'.repeat(48)]);
  assert.deepStrictEqual(await lines(g, { paper: 80, blocks: [{ rule: true }] }, {}, { paper: 58 }), ['-'.repeat(32)]);
  assert.deepStrictEqual(await lines(g, { paper: 384, blocks: [{ rule: true }] }), ['-'.repeat(32)]);
  assert.ok((await lines(g, 'receipt', { shop: 'X' }, { now: NOW })).indexOf('X') >= 0);
  const cases = [
    ['scontrino', /^Unknown layout "scontrino" \(built in: receipt\)$/],
    ['{ not json', /^The layout is not valid JSON/],
    [{}, /blocks/],
    [null, /blocks/],
    [{ blocks: [{ text: 'a' }, { boh: 1 }] }, /^blocks\[1\]: unknown block \({"boh":1}\)$/],
    [{ blocks: [{ blocks: [{ text: 'a' }, 'testo'] }] }, /^blocks\[0\]\.blocks\[1\]: invalid block/],
    [{ paper: 57, blocks: [] }, /paper/],
    [{ blocks: [{ text: 'a', align: 'middle' }] }, /align/],
    [{ blocks: [{ row: [] }] }, /row/],
    [{ blocks: [{ raw: 'x' }] }, /raw/],
    [{ prepare: 'boh', blocks: [] }, /Unknown data preparation/]
  ];
  for (const [lay, re] of cases) {
    const e = await rejects(g.PrintBridge.render(lay));
    assert.strictEqual(e.code, 'layout', JSON.stringify(lay));
    assert.ok(re.test(e.message), e.message);
  }
  let deep = { text: 'bottom' };
  for (let i = 0; i < 30; i++) deep = { blocks: [deep] };
  assert.ok(/too many nested levels/.test((await rejects(g.PrintBridge.render({ blocks: [deep] }))).message));
  // Never a synchronous exception: always a rejected promise.
  assert.ok(typeof g.PrintBridge.render(undefined).catch(() => {}).then === 'function');
});

// --- The app receipt ---

test('receipt layout: same events as Receipt.kt (lines, styles, QR, feeds, cut, width)', async () => {
  const g = load();
  const nowText = '17/10/2026 09:05';
  const specs = [
    {
      shop: 'NEGOZIO DEMO', title: 'RICEVUTA', subtitle: 'Ordine 42', code: 'ABC123', date: true,
      lines: ['Buono regalo', 'Uso entro 12 mesi'],
      items: [{ desc: 'Caffe', qty: 2, price: 1.20 }, { desc: 'Spremuta d\'arancia fresca grande', qty: 1, price: 4 }, 'not an item'],
      total: '', qr: 'https://example.com/r/ABC123', qrText: 'Scansiona per la ricevuta', footer: 'Grazie e arrivederci',
      cut: true, feed: 3
    },
    {},
    { shop: 'Bar', date: false, total: '5,00' },
    { date: false, total: 3.9, qr: 'https://example.com/q' },
    { qrText: 'Solo testo', footer: 'Ciao', cut: false, feed: 0 },
    { items: [{ desc: 'Senza prezzo' }, { desc: 'Tre pezzi', qty: 3, price: 0.5 }], lines: ['Nota'] },
    { code: 'X1', items: [{ desc: 'Gratis', price: 0 }] },
    { shop: 'Largo', width: 48, items: [{ desc: 'Caffe', qty: 1, price: 1.2 }] },
    { width: 40, code: 'W', items: [{ desc: 'Una descrizione abbastanza lunga da tagliare', price: 2 }] },
    { width: 10, items: [{ desc: 'Min', price: 1 }] }
  ];
  for (const spec of specs) {
    const mine = decode(await g.PrintBridge.render(g.PrintBridge.layouts.receipt, spec, { now: NOW }));
    const app = decode(appReceipt(g, spec, nowText));
    assert.deepStrictEqual(mine, app, JSON.stringify(spec));
  }
});

test('receipt layout with logo: the raster of options.logo, centered, then an empty line as in the app', async () => {
  const g = load();
  const spec = { logo: true, shop: 'Bar', date: false };
  const mine = decode(await g.PrintBridge.render('receipt', spec, { logo: RASTER }));
  assert.deepStrictEqual(mine, decode(appReceipt(g, spec, '', RASTER)));
  assert.strictEqual(mine[3].align, 'center');
  const e = await rejects(g.PrintBridge.render('receipt', spec));
  assert.strictEqual(e.code, 'logo-missing');
  assert.ok(/options\.logo/.test(e.message));
});

test('PrintBridge.prepare.receipt: amount = qty x price, total computed only when missing', async () => {
  const g = load();
  const d = g.PrintBridge.prepare.receipt({ items: [{ desc: 'a', qty: '2', price: '1,5' }, { desc: 'b' }, null, [1]], extra: 1 });
  assert.deepStrictEqual(d.items.map((i) => [i.desc, i.qty, i.price, i.amount]), [['a', 2, 1.5, 3], ['b', 1, 0, 0]]);
  assert.strictEqual(d.total, '3,00');
  assert.strictEqual(d.extra, 1);
  assert.strictEqual(g.PrintBridge.prepare.receipt({ total: 7, items: [{ price: 1 }] }).total, '7');
  assert.strictEqual(g.PrintBridge.prepare.receipt({}).total, '');
});

// --- Logo ---

test('logo from a ready-made raster (array or Uint8Array): inserted as it is, centered', async () => {
  const g = load();
  const b = await g.PrintBridge.render({ blocks: [{ logo: RASTER }, { text: 'x' }] });
  assert.deepStrictEqual(b.slice(HEAD.length), [0x1B, 0x61, 1].concat(RASTER, [0x1B, 0x61, 0, 0x78, 0x0A]));
  const b2 = await g.PrintBridge.render({ blocks: [{ logo: true }] }, {}, { logo: Uint8Array.from(RASTER) });
  assert.deepStrictEqual(b2.slice(HEAD.length), [0x1B, 0x61, 1].concat(RASTER));
});

test('logo: empty placeholder = no logo; without Image a URL gives a clear error', async () => {
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

test('logo from a URL: crossOrigin before src, at most 240 dots high, 128-row bands, centered', async () => {
  const dom = fakeDom({ 'logo.png': { w: 200, h: 400 } });
  const g = load({ Image: dom.Image, document: dom.document });
  const ev = decode(await g.PrintBridge.render({ blocks: [{ logo: 'logo.png' }] }));
  assert.strictEqual(dom.created.length, 1);
  assert.strictEqual(dom.created[0].crossOriginAtSrc, 'anonymous', 'crossOrigin must be set before src');
  assert.deepStrictEqual(ev.filter((e) => e.raster).map((e) => [e.raster, e.align]), [[[384, 128], 'center'], [[384, 112], 'center']]);
  // 200x400 in 384x240: 120 wide, from 132 to 251
  const row = rowOf(ev, 0, 0);
  const expected = new Array(48).fill(0);
  expected[16] = 0x0F;
  for (let i = 17; i <= 30; i++) expected[i] = 0xFF;
  expected[31] = 0xF0;
  assert.deepStrictEqual(row, expected);
  assert.deepStrictEqual(rowOf(ev, 1, 111), expected);
});

test('logo from a URL: cache by src (loaded once), rasters by paper and maxHeight', async () => {
  const dom = fakeDom({ 'https://cdn.example/logo.png': { w: 200, h: 400 } });
  const g = load({ Image: dom.Image, document: dom.document });
  const lay = { blocks: [{ logo: '{{logo}}' }] };
  const d = { logo: 'https://cdn.example/logo.png' };
  const a = await g.PrintBridge.render(lay, d);
  const b = await g.PrintBridge.render(lay, d);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(dom.created.length, 1, 'image loaded once');
  assert.strictEqual(dom.canvases.length, 1, 'raster prepared once');
  const ev80 = decode(await g.PrintBridge.render(lay, d, { paper: 80 }));
  assert.deepStrictEqual(ev80.filter((e) => e.raster).map((e) => e.raster), [[576, 128], [576, 112]]);
  assert.strictEqual(dom.created.length, 1);
  assert.strictEqual(dom.canvases.length, 2);
  const small = decode(await g.PrintBridge.render({ blocks: [{ logo: '{{logo}}', maxHeight: 100 }] }, d));
  assert.deepStrictEqual(small.filter((e) => e.raster).map((e) => e.raster), [[384, 100]]);
  g.PrintBridge.clearCache();
  await g.PrintBridge.render(lay, d);
  assert.strictEqual(dom.created.length, 2, 'after clearCache it loads again');
});

test('logo from a URL not loaded: error with the CORS hint (only for another domain), not cached', async () => {
  const dom = fakeDom({});
  const g = load({ Image: dom.Image, document: dom.document, location: { origin: 'https://shop.example' } });
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'https://cdn.example/x.png' }] }));
  assert.strictEqual(e.code, 'logo-load');
  assert.ok(/Access-Control-Allow-Origin/.test(e.message), e.message);
  await rejects(g.PrintBridge.render({ blocks: [{ logo: 'https://cdn.example/x.png' }] }));
  assert.strictEqual(dom.created.length, 2, 'a failed load does not stay in the cache');
  const same = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'https://shop.example/x.png' }] }));
  assert.strictEqual(same.message, 'Logo not loaded: https://shop.example/x.png');
  const rel = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'missing.png' }] }));
  assert.strictEqual(rel.message, 'Logo not loaded: missing.png');
});

test('logo with a "tainted" canvas (image of another domain without CORS): clear error', async () => {
  const dom = fakeDom({});
  const g = load({ Image: dom.Image, document: dom.document });
  const img = { naturalWidth: 100, naturalHeight: 50, complete: true, tainted: true };
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: img }] }));
  assert.strictEqual(e.code, 'logo-cors');
  assert.ok(/another domain/.test(e.message) && /CORS/.test(e.message) && /tainted/.test(e.message), e.message);
});

test('logo from an image of the page: waits for it to load when it is not complete', async () => {
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

test('logo from a URL that does not answer: error after 10 s', async () => {
  const dom = fakeDom({ 'slow.png': 'hang' });
  const g = load({ Image: dom.Image, document: dom.document });
  const t0 = Date.now();
  const e = await rejects(g.PrintBridge.render({ blocks: [{ logo: 'slow.png' }] }));
  assert.strictEqual(e.code, 'logo-load');
  assert.ok(/within 10 s/.test(e.message), e.message);
  assert.ok(Date.now() - t0 < 2000);
});

// --- RawBT.chooseVia, RawBT.setVia, RawBT.printLayout ---

function dom(name, msg) { return new DOMException(msg, name); }

// Stubs the two transports and the BLE state. ble: { paired, remembered, supported }.
function stub(g, ble = {}, app = {}) {
  const calls = { sent: [], pair: [] };
  const state = Object.assign({ paired: false, remembered: false, supported: true }, ble);
  g.RawBT.sendApi = (bytes, opts) => {
    calls.sent.push(['app', bytes, opts]);
    if (app.fail) return Promise.reject(app.fail);
    return Promise.resolve(app.answer || { ok: true, bytes: bytes.length });
  };
  g.RawBT.ble.print = (bytes, opts) => {
    calls.sent.push(['ble', bytes, opts]);
    if (ble.fail) return Promise.reject(ble.fail);
    return Promise.resolve({ ok: true, bytes: bytes.length, ms: 5, chunk: 100, withResponse: true });
  };
  g.RawBT.ble.info = () => ({ paired: state.paired, remembered: state.remembered });
  g.RawBT.ble.supported = () => state.supported;
  g.RawBT.ble.pair = (opts) => {
    calls.pair.push(opts);
    if (ble.pairFail) return Promise.reject(ble.pairFail);
    state.paired = true;
    return Promise.resolve({ paired: true });
  };
  return calls;
}

test('chooseVia: option, preference, paired printer, app check, remembered printer, app (in this order)', async () => {
  const g = load();
  const C = (opts) => g.RawBT.chooseVia(opts);
  stub(g, { paired: true, remembered: true });
  g.RawBT.lastCheck = { ok: true };
  assert.deepStrictEqual(C({ via: 'app' }), { via: 'app', reason: 'option', needsPairing: false });
  g.RawBT.setVia('app');
  assert.deepStrictEqual(C(), { via: 'app', reason: 'preference', needsPairing: false });
  g.RawBT.setVia('auto');
  assert.deepStrictEqual(C(), { via: 'ble', reason: 'paired', needsPairing: false });
  stub(g, { paired: false, remembered: true });
  assert.deepStrictEqual(C(), { via: 'app', reason: 'app-ok', needsPairing: false });
  g.RawBT.lastCheck = { ok: false, reason: 'network' };
  assert.deepStrictEqual(C({ via: 'auto' }), { via: 'ble', reason: 'remembered', needsPairing: true });
  stub(g, { paired: false, remembered: true, supported: false });
  assert.deepStrictEqual(C(), { via: 'app', reason: 'default', needsPairing: false });
  stub(g, { paired: false, remembered: false });
  g.RawBT.lastCheck = null;
  assert.deepStrictEqual(C(), { via: 'app', reason: 'default', needsPairing: false });
  assert.deepStrictEqual(C({ via: 'ble' }), { via: 'ble', reason: 'option', needsPairing: true });
  assert.strictEqual((() => { try { C({ via: 'usb' }); } catch (e) { return e.code; } })(), 'via');
});

test('setVia: kept in localStorage (printbridge.via), auto clears it, works without localStorage', async () => {
  const store = storage();
  const g = load({ localStorage: store });
  stub(g, { paired: true });
  assert.strictEqual(g.RawBT.setVia('ble'), 'ble');
  assert.strictEqual(store.getItem('printbridge.via'), 'ble');
  const again = load({ localStorage: store });
  stub(again);
  assert.deepStrictEqual(again.RawBT.chooseVia(), { via: 'ble', reason: 'preference', needsPairing: true }, 'the preference survives a reload');
  g.RawBT.setVia('auto');
  assert.strictEqual(store.getItem('printbridge.via'), null);
  assert.strictEqual(g.RawBT.chooseVia().reason, 'paired');
  assert.throws(() => g.RawBT.setVia('usb'), (e) => e.code === 'via');
  const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
  const h = load({ localStorage: broken });
  stub(h);
  h.RawBT.setVia('app');
  assert.strictEqual(h.RawBT.chooseVia().reason, 'preference');
});

test('printLayout: same bytes via app and via BLE, normalized result, options passed on', async () => {
  const g = load();
  const calls = stub(g, { paired: true });
  const lay = { blocks: [{ text: 'Ciao {{n}}' }, { cut: true }] };
  const expected = await g.PrintBridge.render(lay, { n: 'Ada' });
  const onProgress = () => {};
  const r1 = await g.RawBT.printLayout(lay, { n: 'Ada' }, { via: 'app', timeoutMs: 5000 });
  const r2 = await g.RawBT.printLayout(lay, { n: 'Ada' }, { via: 'ble', onProgress });
  const r3 = await g.PrintBridge.print(lay, { n: 'Ada' });
  assert.deepStrictEqual(calls.sent.map((c) => c[0]), ['app', 'ble', 'ble'], 'auto with a paired printer: BLE');
  calls.sent.forEach((c) => assert.deepStrictEqual(c[1], expected));
  assert.strictEqual(calls.sent[0][2].timeoutMs, 5000);
  assert.strictEqual(calls.sent[1][2].onProgress, onProgress);
  for (const [r, via, reason] of [[r1, 'app', 'option'], [r2, 'ble', 'option'], [r3, 'ble', 'paired']]) {
    assert.deepStrictEqual(Object.keys(r).sort(), ['bytes', 'ms', 'ok', 'reason', 'result', 'via']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.via, via);
    assert.strictEqual(r.reason, reason);
    assert.strictEqual(r.bytes, expected.length);
    assert.ok(r.ms >= 0);
  }
  assert.strictEqual(r2.result.chunk, 100);
  assert.strictEqual(calls.pair.length, 0);
  assert.strictEqual(g.PrintBridge.print, g.RawBT.printLayout);
});

test('printLayout via BLE without a printer: Chrome\'s chooser opens at once (same tap), then it prints', async () => {
  const g = load();
  const calls = stub(g, { paired: false });
  const p = g.RawBT.printLayout({ blocks: [{ text: 'x' }] }, {}, { via: 'ble' });
  assert.strictEqual(calls.pair.length, 1, 'pair must be called synchronously');
  assert.deepStrictEqual(calls.pair[0], { sameName: true });
  const r = await p;
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls.sent.map((c) => c[0]), ['ble']);
});

test('printLayout auto with a BLE printer from an earlier visit: pairs in the same tap', async () => {
  const g = load();
  const calls = stub(g, { paired: false, remembered: true });
  const p = g.RawBT.printLayout({ blocks: [{ text: 'x' }] }, {});
  assert.strictEqual(calls.pair.length, 1, 'pair must be called synchronously');
  const r = await p;
  assert.deepStrictEqual([r.ok, r.via, r.reason], [true, 'ble', 'remembered']);
});

test('printLayout auto: app after a good RawBT.check(), app by default without BLE', async () => {
  const g = load();
  let calls = stub(g, { paired: false, remembered: true });
  g.RawBT.lastCheck = { ok: true };
  const r = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] });
  assert.deepStrictEqual([r.ok, r.via, r.reason], [true, 'app', 'app-ok']);
  assert.strictEqual(calls.pair.length, 0);
  g.RawBT.lastCheck = null;
  calls = stub(g, { paired: false, remembered: false });
  const r2 = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] });
  assert.deepStrictEqual([r2.ok, r2.via, r2.reason], [true, 'app', 'default']);
});

test('printLayout never rejects: the app does not answer (hint about both ways only when chosen automatically)', async () => {
  const g = load();
  stub(g, {}, { fail: new TypeError('Failed to fetch') });
  const auto = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] });
  assert.strictEqual(auto.ok, false);
  assert.deepStrictEqual([auto.via, auto.reason, auto.code], ['app', 'default', 'network']);
  assert.ok(/Open the app, or pair a Bluetooth LE printer/.test(auto.error), auto.error);
  assert.ok(auto.cause instanceof TypeError);
  assert.ok(auto.bytes > 0);
  const timeout = new Error('no answer within 40000 ms');
  timeout.name = 'TimeoutError';
  stub(g, {}, { fail: timeout });
  const asked = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] }, {}, { via: 'app' });
  assert.deepStrictEqual([asked.ok, asked.code], [false, 'timeout']);
  assert.strictEqual(asked.error, 'The Print Bridge app did not answer (no answer within 40000 ms). Open the app and try again.');
  stub(g, {}, { answer: { ok: false, error: 'printer off' } });
  const refused = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] }, {}, { via: 'app' });
  assert.deepStrictEqual([refused.ok, refused.code, refused.error], [false, 'app', 'The Print Bridge app could not print: printer off']);
});

test('printLayout never rejects: BLE chooser closed, BLE error, layout error, wrong via', async () => {
  const g = load();
  let calls = stub(g, { paired: false, pairFail: dom('NotFoundError', 'User cancelled the requestDevice() chooser.') });
  const cancelled = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] }, {}, { via: 'ble' });
  assert.deepStrictEqual([cancelled.ok, cancelled.cancelled, cancelled.code, cancelled.error], [false, true, 'NotFoundError', 'Printer selection cancelled']);
  assert.strictEqual(calls.sent.length, 0);
  calls = stub(g, { paired: true, fail: dom('NetworkError', 'GATT Server is disconnected.') });
  const lost = await g.RawBT.printLayout({ blocks: [{ text: 'x' }] });
  assert.deepStrictEqual([lost.ok, lost.via, lost.code], [false, 'ble', 'NetworkError']);
  assert.strictEqual(lost.error, g.RawBT.ble.explain(lost.cause));
  calls = stub(g, { paired: true });
  const bad = await g.RawBT.printLayout({ blocks: [{ boh: 1 }] });
  assert.deepStrictEqual([bad.ok, bad.code, bad.bytes], [false, 'layout', 0]);
  assert.ok(/unknown block/.test(bad.error));
  const via = await g.RawBT.printLayout({ blocks: [] }, {}, { via: 'usb' });
  assert.deepStrictEqual([via.ok, via.code, via.via], [false, 'via', null]);
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
  console.log(failed ? failed + ' TESTS FAILED' : 'ALL OK (' + tests.length + ' tests)');
  process.exit(failed ? 1 : 0);
})();
