// Tests of the languages of escpos.js: the language taken from the browser, RawBT.setLanguage
// and its localStorage key (printbridge.lang, shared by the pages), the English and Italian
// tables (same keys, same {placeholders}, an ASCII-only source, no Italian text in the code
// outside the Italian table) and the messages of RawBT.ble,
// RawBT.serial, RawBT.check, RawBT.printLayout and RawBT.printCanvas in both languages; the
// labels the messages quote, compared with the dictionaries of the pages (ble.html, serial.html).
// No printer: fake navigator objects and a fake fetch.
// Usage: node test/i18n-test.js escpos.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const file = process.argv[2];
const raw = fs.readFileSync(file);
const src = raw.toString('utf8');
const SCALE = 50; // timers 50 times faster: a 1 s timeout becomes 20 ms
const LANGS = ['en', 'it'];
const DRIVER_IDS = 'escpos, phomemo-m02, phomemo-m02pro';
const BAUD_LIST = '9600, 19200, 38400, 57600, 115200';
const BLACK = [0, 0, 0, 255];

function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
// The dictionary T = { en, it } of a page of the repository: a plain object literal in its script
// (var T = { ... }; closed at the same indentation).
function pageDictionary(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  const m = html.match(/\n([ \t]*)var T = (\{[\s\S]*?\n\1\});/);
  assert.ok(m, name + ': var T = { en, it } not found');
  // eslint-disable-next-line no-new-func
  const T = new Function('return ' + m[2])();
  assert.deepStrictEqual(Object.keys(T).sort(), LANGS, name);
  return T;
}
// How the messages quote a label of the pages.
const QUOTE = { en: (s) => '"' + s + '"', it: (s) => '«' + s + '»' };
function dom(name, msg) { return new DOMException(msg, name); }
// The text of a table entry with its {placeholders} filled, as the library does.
function fill(s, params) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (params && own(params, k) ? String(params[k]) : m));
}
function storage() {
  const m = {};
  return {
    m,
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}
// localStorage blocked by the browser: every call throws.
function blocked() {
  const no = () => { throw dom('SecurityError', 'Access is denied for this document.'); };
  return { getItem: no, setItem: no, removeItem: no };
}
async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('should have failed');
}
function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}
// ImageData-like source: fn(x, y) -> [r, g, b, a].
function pixels(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

// The app on 127.0.0.1: reply null = connection refused, 'hang' = never answers,
// { status, body } = an HTTP answer.
function server() {
  const s = { reply: null, calls: 0 };
  s.fetch = () => {
    s.calls++;
    if (s.reply === 'hang') return new Promise(() => {});
    if (!s.reply) return Promise.reject(new TypeError('Failed to fetch'));
    const body = typeof s.reply.body === 'string' ? s.reply.body : JSON.stringify(s.reply.body);
    return Promise.resolve({ status: s.reply.status || 200, text: () => Promise.resolve(body) });
  };
  return s;
}

// opts: nav (the navigator; undefined = none), store (the localStorage; undefined = none), fetch.
function load(opts = {}) {
  const nav = own(opts, 'nav') ? opts.nav : {};
  const store = own(opts, 'store') ? opts.store : storage();
  const g = { navigator: nav, localStorage: store, Promise, Date, JSON };
  g.window = g;
  const fast = (fn, ms) => setTimeout(fn, Math.max(0, (ms || 0) / SCALE));
  const fetch = opts.fetch || server().fetch;
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'fetch', src)(g, undefined, fast, clearTimeout, fetch);
  return g;
}
// Choosers that the person closes at once.
function closedChoosers() {
  return {
    bluetooth: { requestDevice: () => Promise.reject(dom('NotFoundError', 'User cancelled the requestDevice() chooser.')) },
    serial: {
      requestPort: () => Promise.reject(dom('NotFoundError', "Failed to execute 'requestPort' on 'Serial': No port selected by the user.")),
      getPorts: () => Promise.resolve([]),
      addEventListener() {}
    }
  };
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ---------------------------------------------------------------- language and setLanguage

test('language(): the first browser language with a translation, else English', async () => {
  const cases = [
    [{ language: 'it-IT' }, 'it'],
    [{ language: 'en-US' }, 'en'],
    [{ language: 'de' }, 'en'],
    [{ languages: ['de', 'it'], language: 'de' }, 'it'],
    [{ languages: ['de-CH', 'it-CH', 'en'], language: 'de-CH' }, 'it'],
    [{ languages: ['fr-FR', 'en-GB', 'it-IT'], language: 'fr-FR' }, 'en'],
    [{ languages: [], language: 'it' }, 'it'], // an empty list: navigator.language
    [{ language: 'IT-it' }, 'it'],
    [{ language: 'constructor' }, 'en'], // names of Object.prototype are not languages
    [{ languages: ['toString', '__proto__', 'it'] }, 'it'],
    [{}, 'en']
  ];
  for (const [nav, want] of cases) assert.strictEqual(load({ nav }).RawBT.language(), want, JSON.stringify(nav));
  assert.strictEqual(load({ nav: undefined }).RawBT.language(), 'en', 'no navigator at all');
  // The messages follow it.
  const it = load({ nav: { languages: ['de', 'it-IT'] } });
  assert.ok(/blocco sconosciuto/.test((await rejects(it.PrintBridge.render({ blocks: [{ boh: 1 }] }))).message));
  const en = load({ nav: { language: 'de' } });
  assert.ok(/unknown block/.test((await rejects(en.PrintBridge.render({ blocks: [{ boh: 1 }] }))).message));
});

test('setLanguage(): kept in localStorage (printbridge.lang), read by the other pages, wins over the browser', async () => {
  const store = storage();
  const a = load({ nav: { language: 'en-US' }, store });
  assert.strictEqual(a.RawBT.language(), 'en');
  assert.strictEqual(a.RawBT.setLanguage('it'), 'it');
  assert.strictEqual(store.getItem('printbridge.lang'), 'it');
  assert.strictEqual(a.RawBT.language(), 'it');
  const b = load({ nav: { languages: ['en-US', 'en'] }, store });
  assert.strictEqual(b.RawBT.language(), 'it', 'another page of the same site reads the choice');
  assert.strictEqual(b.RawBT.setLanguage('en'), 'en');
  assert.strictEqual(store.getItem('printbridge.lang'), 'en');
  const c = load({ nav: { language: 'it-IT' }, store });
  assert.strictEqual(c.RawBT.language(), 'en', 'English chosen by hand on an Italian browser');
  // One code per language: region and case are dropped.
  assert.strictEqual(c.RawBT.setLanguage('it-IT'), 'it');
  assert.strictEqual(store.getItem('printbridge.lang'), 'it');
  assert.strictEqual(c.RawBT.setLanguage('EN'), 'en');
  assert.strictEqual(store.getItem('printbridge.lang'), 'en');
  // A page without escpos.js stores the key itself: the library reads it.
  const d = storage();
  d.setItem('printbridge.lang', 'it');
  assert.strictEqual(load({ nav: { language: 'en' }, store: d }).RawBT.language(), 'it');
});

test('setLanguage("auto"), null or nothing clears the choice: the browser language again', async () => {
  const store = storage();
  store.setItem('printbridge.lang', 'it');
  const g = load({ nav: { language: 'en-US' }, store });
  assert.strictEqual(g.RawBT.language(), 'it');
  assert.strictEqual(g.RawBT.setLanguage('auto'), 'en', 'returns the language now in use');
  assert.ok(!own(store.m, 'printbridge.lang'), 'the key is removed');
  assert.strictEqual(g.RawBT.language(), 'en');
  g.RawBT.setLanguage('it');
  assert.strictEqual(g.RawBT.setLanguage(null), 'en');
  assert.ok(!own(store.m, 'printbridge.lang'));
  g.RawBT.setLanguage('it');
  assert.strictEqual(g.RawBT.setLanguage(), 'en');
  assert.ok(!own(store.m, 'printbridge.lang'));
  const it = load({ nav: { languages: ['it-IT'] }, store });
  it.RawBT.setLanguage('en');
  assert.strictEqual(it.RawBT.setLanguage('auto'), 'it');
  assert.strictEqual(it.RawBT.language(), 'it');
});

test('setLanguage(): an unknown language is refused and the choice in force stays', async () => {
  const store = storage();
  const g = load({ nav: { language: 'en-US' }, store });
  g.RawBT.setLanguage('it');
  for (const bad of ['de', 'fr-FR', '', 'constructor', '__proto__', 'auto-it', 42, {}]) {
    const e = thrown(() => g.RawBT.setLanguage(bad));
    assert.ok(e, 'accepted ' + JSON.stringify(bad));
    assert.deepStrictEqual([e.name, e.code], ['PrintBridgeLayoutError', 'language'], JSON.stringify(bad));
    assert.strictEqual(e.message, 'la lingua deve essere una tra: en, it, oppure "auto"');
    assert.strictEqual(store.getItem('printbridge.lang'), 'it');
    assert.strictEqual(g.RawBT.language(), 'it');
  }
  g.RawBT.setLanguage('en');
  assert.strictEqual(thrown(() => g.RawBT.setLanguage('de')).message, 'language must be one of: en, it, or "auto"');
  assert.strictEqual(store.getItem('printbridge.lang'), 'en');
  // A stored value that is not a language (an old version, another script) is ignored.
  for (const stored of ['fr', 'constructor', '']) {
    const s = storage();
    s.setItem('printbridge.lang', stored);
    assert.strictEqual(load({ nav: { language: 'it' }, store: s }).RawBT.language(), 'it', JSON.stringify(stored));
    assert.strictEqual(load({ nav: { language: 'en' }, store: s }).RawBT.language(), 'en', JSON.stringify(stored));
  }
});

test('without localStorage (blocked or missing): the choice lasts as long as the page', async () => {
  for (const store of [blocked(), undefined]) {
    const g = load({ nav: { language: 'en-US' }, store });
    assert.strictEqual(g.RawBT.language(), 'en');
    assert.strictEqual(g.RawBT.setLanguage('it'), 'it');
    assert.strictEqual(g.RawBT.language(), 'it');
    assert.ok(/blocco sconosciuto/.test((await rejects(g.PrintBridge.render({ blocks: [{ boh: 1 }] }))).message));
    assert.strictEqual(g.RawBT.setLanguage('auto'), 'en');
    assert.strictEqual(g.RawBT.language(), 'en');
  }
});

test('the language is read at every message: a switch applies to the next one', async () => {
  const g = load({ nav: { language: 'it-IT' } });
  const msg = async () => (await rejects(g.PrintBridge.render({ blocks: [{ boh: 1 }] }))).message;
  assert.ok(/blocco sconosciuto/.test(await msg()));
  g.RawBT.setLanguage('en');
  assert.ok(/unknown block/.test(await msg()));
  g.RawBT.setLanguage('it');
  assert.ok(/blocco sconosciuto/.test(await msg()));
  g.RawBT.setLanguage('auto');
  assert.ok(/blocco sconosciuto/.test(await msg()));
});

// ---------------------------------------------------------------- the tables

test('translations: en and it have the same keys and the same {placeholders}; messages is the English table', async () => {
  const g = load();
  const T = g.PrintBridge.translations;
  assert.deepStrictEqual(Object.keys(T).sort(), LANGS);
  assert.strictEqual(g.PrintBridge.messages, T.en);
  const onlyEn = Object.keys(T.en).filter((k) => !own(T.it, k));
  const onlyIt = Object.keys(T.it).filter((k) => !own(T.en, k));
  assert.deepStrictEqual(onlyEn, [], 'missing in it: ' + onlyEn.join(', '));
  assert.deepStrictEqual(onlyIt, [], 'missing in en: ' + onlyIt.join(', '));
  const holes = (s) => Array.from(new Set(String(s).match(/\{\w+\}/g) || [])).sort().join(' ');
  const wrong = Object.keys(T.en).filter((k) => holes(T.en[k]) !== holes(T.it[k]))
    .map((k) => k + ' (en: ' + (holes(T.en[k]) || '-') + ', it: ' + (holes(T.it[k]) || '-') + ')');
  assert.deepStrictEqual(wrong, [], 'different placeholders: ' + wrong.join('; '));
  const notText = LANGS.flatMap((l) => Object.keys(T[l]).filter((k) => typeof T[l][k] !== 'string' || !T[l][k].trim()).map((k) => l + '.' + k));
  assert.deepStrictEqual(notText, [], 'empty or not a string: ' + notText.join(', '));
  const copies = Object.keys(T.en).filter((k) => T.en[k] === T.it[k]);
  assert.deepStrictEqual(copies, [], 'Italian equal to English (not translated): ' + copies.join(', '));
  assert.ok(Object.keys(T.en).length >= 80, 'about 84 messages');
});

test('translations: every key the code asks for exists, and every key is used', async () => {
  const T = load().PrintBridge.translations;
  const used = new Set();
  // message('key' ...), layoutError('code', 'key' ...), serialError('code', 'key' ...).
  for (const m of src.matchAll(/\b(?:message|layoutError|serialError)\(\s*(?:'[\w-]+',\s*)?'(\w+)'/g)) used.add(m[1]);
  // message(cond ? 'a' : 'b' ...).
  for (const m of src.matchAll(/\bmessage\([^()']*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)) { used.add(m[1]); used.add(m[2]); }
  assert.ok(used.size >= 60, 'found ' + used.size + ' keys in the code');
  const unknown = Array.from(used).filter((k) => !own(T.en, k));
  assert.deepStrictEqual(unknown, [], 'asked for but missing in the tables: ' + unknown.join(', '));
  const dead = Object.keys(T.en).filter((k) => src.indexOf("'" + k + "'") < 0);
  assert.deepStrictEqual(dead, [], 'in the tables but never used: ' + dead.join(', '));
});

test('escpos.js is ASCII only (accents written as \\u escapes)', async () => {
  const bad = [];
  let line = 1, col = 1;
  for (let i = 0; i < raw.length && bad.length < 5; i++) {
    if (raw[i] > 0x7F) bad.push(file + ':' + line + ':' + col + ' byte 0x' + raw[i].toString(16));
    if (raw[i] === 0x0A) { line++; col = 1; } else col++;
  }
  assert.deepStrictEqual(bad, [], 'non-ASCII bytes: ' + bad.join(', '));
  // The Italian texts still have their accents, from the escapes.
  const it = load().PrintBridge.translations.it;
  assert.ok(it.badJson.indexOf('non \u00e8 JSON') >= 0, it.badJson);
  assert.ok(it.explainNetwork.indexOf('\u00abRiconnetti\u00bb') >= 0, it.explainNetwork);
});

test('outside the Italian table the code has no Italian text: what people read goes through the tables', async () => {
  const code = src.replace(/\r\n/g, '\n');
  const start = code.indexOf('var MESSAGES_IT = {');
  const end = code.indexOf('\n  };', start);
  assert.ok(start > 0 && end > start, 'var MESSAGES_IT = { ... }; not found');
  const rest = code.slice(0, start) + code.slice(end);
  // The source writes every text in single quotes (no double-quoted or template literals).
  const literals = Array.from(rest.matchAll(/'((?:[^'\\\n]|\\.)*)'/g), (m) => m[1]);
  assert.ok(literals.length > 500, 'found ' + literals.length + ' string literals');
  // 'non' but not the English prefix of 'non-ASCII'.
  const ITALIAN = /\b(non(?!-)|della|delle|degli|stampante|scrivibile|questa|questo|nessun[ao]?|trovat[oaie]|caratteristica|servizio|errore|riprova|impostazioni|scegli|apri|accendi)\b/i;
  const found = literals.filter((s) => ITALIAN.test(s));
  assert.deepStrictEqual(found, [], 'Italian text in the code: ' + found.join(' | '));
});

test('the labels the messages point to are the labels of the pages', async () => {
  const T = load().PrintBridge.translations;
  const want = {
    en: [['explainNoChannel', '"Diagnostics"'], ['explainNotFound', '"I can\'t find the printer in the list"'],
      ['explainNetwork', '"Reconnect"'], ['explainSerialLost', '"Reconnect"'], ['explainNotSupported', '"Advanced"']],
    it: [['explainNoChannel', '\u00abDiagnostica\u00bb'], ['explainNotFound', '\u00abNon trovo la stampante nell\'elenco\u00bb'],
      ['explainNetwork', '\u00abRiconnetti\u00bb'], ['explainSerialLost', '\u00abRiconnetti\u00bb'], ['explainNotSupported', '\u00abAvanzate\u00bb']]
  };
  for (const lang of LANGS) {
    for (const [key, label] of want[lang]) assert.ok(T[lang][key].indexOf(label) >= 0, lang + '.' + key + ' should name ' + label + ': ' + T[lang][key]);
  }
});

test('explainNotFound and the other messages quote the exact labels of ble.html and serial.html, in both languages', async () => {
  const T = load().PrintBridge.translations;
  const ble = pageDictionary('ble.html'), serial = pageDictionary('serial.html');
  // The labels themselves, as the pages show them.
  assert.deepStrictEqual([ble.en.btnAll, ble.it.btnAll], ['I can\'t find the printer in the list', 'Non trovo la stampante nell\'elenco']);
  assert.deepStrictEqual([ble.en.btnReconnect, ble.it.btnReconnect, serial.en.btnReconnect, serial.it.btnReconnect],
    ['Reconnect', 'Riconnetti', 'Reconnect', 'Riconnetti']);
  assert.deepStrictEqual([ble.en.advTitle, ble.it.advTitle], ['Advanced', 'Avanzate']);
  for (const lang of LANGS) {
    const q = QUOTE[lang], t = T[lang];
    const quoted = [
      ['explainNotFound', ble[lang].btnAll, 'ble.html btnAll'],
      ['explainNetwork', ble[lang].btnReconnect, 'ble.html btnReconnect'],
      ['explainSerialLost', serial[lang].btnReconnect, 'serial.html btnReconnect'],
      ['explainNotSupported', ble[lang].advTitle, 'ble.html advTitle'],
      // The button reads "Diagnostics: services and characteristics": the message names its first word.
      ['explainNoChannel', ble[lang].btnDiag.split(':')[0], 'ble.html btnDiag']
    ];
    for (const [key, label, where] of quoted) {
      assert.ok(t[key].indexOf(q(label)) >= 0, lang + '.' + key + ' should quote ' + q(label) + ' (' + where + '): ' + t[key]);
    }
    // Quoted exactly: nothing cut before the closing quote.
    const names = (s) => Array.from(s.matchAll(lang === 'en' ? /"([^"]+)"/g : /\u00ab([^\u00bb]+)\u00bb/g), (m) => m[1]);
    assert.deepStrictEqual(names(t.explainNotFound), [ble[lang].btnAll], lang + '.explainNotFound');
  }
});

test('badVia names every value of via (RawBT.setVia, options.via), in English and in Italian', async () => {
  const m = src.match(/var VIAS = \[([^\]]*)\]/);
  assert.ok(m, 'var VIAS = [...] not found in escpos.js');
  const vias = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepStrictEqual(vias, ['auto', 'ble', 'app', 'serial']);
  const px = pixels(8, 1, () => BLACK);
  for (const lang of LANGS) {
    const g = load({ nav: closedChoosers() });
    g.RawBT.setLanguage(lang);
    const T = g.PrintBridge.translations[lang];
    const named = Array.from(T.badVia.matchAll(/"([^"]+)"/g), (x) => x[1]);
    assert.deepStrictEqual(named.slice().sort(), vias.slice().sort(), lang + '.badVia: ' + T.badVia);
    for (const via of vias) {
      assert.strictEqual(g.RawBT.setVia(via), via, lang + ' setVia ' + via);
      assert.strictEqual(thrown(() => g.RawBT.chooseVia({ via })), null, lang + ' chooseVia ' + via);
    }
    g.RawBT.setVia('auto');
    for (const bad of ['usb', 'bluetooth', 'BLE', '']) {
      const e = thrown(() => g.RawBT.setVia(bad));
      assert.deepStrictEqual([e && e.code, e && e.message], ['via', T.badVia], lang + ' setVia ' + JSON.stringify(bad));
      assert.strictEqual(thrown(() => g.RawBT.chooseVia({ via: bad })).message, T.badVia);
    }
    const r = await g.RawBT.printLayout({ blocks: [] }, {}, { via: 'usb' });
    assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'via', T.badVia]);
    const c = await g.RawBT.printCanvas(px, { driver: 'escpos', via: 'usb' });
    assert.deepStrictEqual([c.ok, c.code, c.error], [false, 'via', T.badVia]);
  }
});

// ---------------------------------------------------------------- explain() in both languages

test('RawBT.ble.explain(): every case in English and in Italian', async () => {
  const g = load();
  const T = g.PrintBridge.translations;
  const cases = [
    [{ code: 'cat-printer', message: 'cat' }, 'explainCat'],
    [{ code: 'no-channel', message: 'no known print channel (services found: none)' }, 'explainNoChannel', true],
    [{ code: 'unsupported', message: 'x' }, 'explainUnsupported'],
    [{ code: 'timeout', message: 'Connection to the printer: no answer within 20 s' }, 'explainTimeout', true],
    [{ code: 'no-notify', message: 'x' }, 'explainNoNotify'],
    [dom('NotFoundError', 'User cancelled the requestDevice() chooser.'), ''],
    [dom('NotFoundError', 'Bluetooth adapter not available. Location permission is required.'), 'explainLocation'],
    [dom('NotFoundError', 'No Services matching UUID 0000ff00 found in Device.'), 'explainNotFound', true],
    [dom('SecurityError', 'Must be handling a user gesture to show a permission request.'), 'explainGesture'],
    [dom('NetworkError', 'Bluetooth Device is no longer in range.'), 'explainNetwork', true],
    [dom('NotSupportedError', 'GATT Error Unknown.'), 'explainNotSupported', true],
    [new TypeError('something else'), null]
  ];
  const seen = { en: [], it: [] };
  for (const lang of LANGS) {
    assert.strictEqual(g.RawBT.setLanguage(lang), lang);
    for (const [err, key, detail] of cases) {
      const want = key === '' ? '' : key === null ? err.message : fill(T[lang][key], detail ? { detail: err.message } : null);
      const got = g.RawBT.ble.explain(err);
      assert.strictEqual(got, want, lang + ' ' + (key || err.name));
      seen[lang].push(got);
    }
  }
  cases.forEach(([err, key], i) => {
    if (key) assert.notStrictEqual(seen.en[i], seen.it[i], key + ' is the same in both languages');
  });
  g.RawBT.setLanguage('en');
  assert.strictEqual(g.RawBT.ble.explain(dom('SecurityError', 'x')), 'Choosing the printer needs a tap on a button.');
  g.RawBT.setLanguage('it');
  assert.strictEqual(g.RawBT.ble.explain(dom('SecurityError', 'x')), 'Serve un tocco su un pulsante per scegliere la stampante.');
});

test('RawBT.serial.explain(): every code in English and in Italian', async () => {
  const g = load();
  const T = g.PrintBridge.translations;
  const cases = [
    [{ name: 'PrintBridgeSerialError', code: 'unsupported', message: 'x' }, 'serialUnsupported'],
    [{ name: 'PrintBridgeSerialError', code: 'open', message: 'Failed to open serial port.' }, 'explainSerialOpen', true],
    [{ name: 'PrintBridgeSerialError', code: 'no-port', message: 'x' }, 'explainSerialLost'],
    [{ name: 'PrintBridgeSerialError', code: 'closed', message: 'x' }, 'explainSerialLost'],
    [{ name: 'PrintBridgeSerialError', code: 'write', message: 'The device has been lost.' }, 'explainSerialWrite', true],
    [{ name: 'PrintBridgeSerialError', code: 'baud', message: 'baudRate must be one of: 9600' }, null],
    [dom('NotFoundError', "Failed to execute 'requestPort' on 'Serial': No port selected by the user."), ''],
    [dom('SecurityError', 'Must be handling a user gesture to show a permission request.'), 'explainGesture'],
    [dom('NetworkError', 'Failed to open serial port.'), null]
  ];
  for (const lang of LANGS) {
    g.RawBT.setLanguage(lang);
    for (const [err, key, detail] of cases) {
      const want = key === '' ? '' : key === null ? err.message : fill(T[lang][key], detail ? { detail: err.message } : null);
      assert.strictEqual(g.RawBT.serial.explain(err), want, lang + ' ' + (key || err.code || err.name));
    }
  }
  g.RawBT.setLanguage('en');
  assert.strictEqual(g.RawBT.serial.explain({ code: 'no-port' }),
    'The serial port was closed or unplugged: plug the printer in (or turn it on) and press "Reconnect".');
});

// ---------------------------------------------------------------- errors made by the library

test('errors made by the library are written in the language in force when they happen', async () => {
  for (const lang of LANGS) {
    const g = load({ nav: {} }); // no Web Bluetooth, no Web Serial
    g.RawBT.setLanguage(lang);
    const T = g.PrintBridge.translations[lang];
    let e = await rejects(g.RawBT.ble.pair());
    assert.deepStrictEqual([e.code, e.message], ['unsupported', T.bleUnsupported], lang);
    e = await rejects(g.RawBT.ble.print([1, 2]));
    assert.deepStrictEqual([e.code, e.message], ['no-device', T.noPrinterPaired], lang);
    e = await rejects(g.RawBT.serial.pair());
    assert.deepStrictEqual([e.code, e.message], ['unsupported', T.serialUnsupported], lang);
    e = await rejects(g.RawBT.serial.print([1, 2]));
    assert.deepStrictEqual([e.code, e.message], ['no-port', T.noPort], lang);
    e = await rejects(g.RawBT.serial.setBaudRate(1234));
    assert.deepStrictEqual([e.code, e.message], ['baud', fill(T.badBaud, { list: BAUD_LIST })], lang);
    assert.strictEqual(g.RawBT.localAccessHint('denied'), fill(T.lnaDenied, { steps: T.lnaSteps }));
    assert.strictEqual(g.RawBT.localAccessHint('prompt'), fill(T.lnaNeeded, { steps: T.lnaSteps }));
    assert.strictEqual(g.RawBT.serial.info().label, null);
  }
  const it = load();
  it.RawBT.setLanguage('it');
  assert.strictEqual((await rejects(it.RawBT.serial.print([1]))).message, 'nessuna porta seriale scelta');
});

test('RawBT.check(): the reasons in the language in force (not the app, bad answer, timeout)', async () => {
  for (const lang of LANGS) {
    const app = server();
    const g = load({ fetch: app.fetch });
    g.RawBT.setLanguage(lang);
    const T = g.PrintBridge.translations[lang];
    app.reply = { body: { app: false } };
    let r = await g.RawBT.check(1000);
    assert.deepStrictEqual([r.ok, r.reason, r.message], [false, 'response', T.notTheApp], lang);
    app.reply = { status: 500, body: 'oops' };
    r = await g.RawBT.check(1000);
    assert.deepStrictEqual([r.ok, r.reason, r.message], [false, 'response', fill(T.badResponse, { status: 500 })], lang);
    app.reply = 'hang';
    r = await g.RawBT.check(1000);
    assert.deepStrictEqual([r.ok, r.reason, r.message], [false, 'timeout', fill(T.noAnswerMs, { ms: 1000 })], lang);
    app.reply = { body: { app: true, version: 'x' } };
    r = await g.RawBT.check(1000);
    assert.strictEqual(r.ok, true);
  }
});

test('printLayout: every failure explained in the language in force', async () => {
  for (const lang of LANGS) {
    const app = server();
    const g = load({ nav: closedChoosers(), fetch: app.fetch });
    g.RawBT.setLanguage(lang);
    const T = g.PrintBridge.translations[lang];
    const x = { blocks: [{ text: 'x' }] };
    let r = await g.RawBT.printLayout({ blocks: [{ boh: 1 }] }, {}, { via: 'app' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'layout']);
    assert.ok((lang === 'en' ? /unknown block/ : /blocco sconosciuto/).test(r.error), r.error);
    r = await g.RawBT.printLayout('nope', {}, { via: 'app' });
    assert.strictEqual(r.error, fill(T.unknownLayout, { name: 'nope', list: Object.keys(g.PrintBridge.layouts).join(', ') }));
    r = await g.RawBT.printLayout(x, {}, { via: 'usb' });
    assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'via', T.badVia]);
    // The app does not answer: chosen automatically, then asked for.
    r = await g.RawBT.printLayout(x);
    assert.deepStrictEqual([r.ok, r.via, r.reason, r.code], [false, 'app', 'default', 'network']);
    assert.strictEqual(r.error, fill(T.appUnreachableAuto, { detail: 'Failed to fetch' }));
    r = await g.RawBT.printLayout(x, {}, { via: 'app' });
    assert.strictEqual(r.error, fill(T.appUnreachable, { detail: 'Failed to fetch' }));
    app.reply = { body: { ok: false, error: 'no paper' } };
    r = await g.RawBT.printLayout(x, {}, { via: 'app' });
    assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'app', fill(T.appFailed, { detail: 'no paper' })]);
    // The person closes the Bluetooth chooser or the port chooser.
    r = await g.RawBT.printLayout(x, {}, { via: 'ble' });
    assert.deepStrictEqual([r.ok, r.cancelled, r.error], [false, true, T.pairCancelled]);
    r = await g.RawBT.printLayout(x, {}, { via: 'serial' });
    assert.deepStrictEqual([r.ok, r.cancelled, r.via, r.error], [false, true, 'serial', T.portCancelled]);
    // Rendering alone.
    const e = await rejects(g.PrintBridge.render({ blocks: [{ text: '{{a|boh}}' }] }));
    assert.strictEqual(e.message, fill(T.unknownFilter, { name: 'boh', expr: '{{a|boh}}' }));
  }
  const en = load({ nav: closedChoosers() });
  en.RawBT.setLanguage('en');
  assert.strictEqual((await en.RawBT.printLayout({ blocks: [] }, {}, { via: 'serial' })).error, 'Port selection cancelled');
  assert.strictEqual((await en.RawBT.printLayout({ blocks: [] }, {}, { via: 'ble' })).error, 'Printer selection cancelled');
  const it = load({ nav: closedChoosers() });
  it.RawBT.setLanguage('it');
  assert.strictEqual((await it.RawBT.printLayout({ blocks: [] }, {}, { via: 'serial' })).error, 'Scelta della porta annullata');
  assert.strictEqual((await it.RawBT.printLayout({ blocks: [] }, {}, { via: 'ble' })).error, 'Scelta della stampante annullata');
});

test('printCanvas: driver, via and image errors in the language in force', async () => {
  const px = pixels(8, 1, () => BLACK);
  for (const lang of LANGS) {
    const g = load({ nav: closedChoosers() });
    g.RawBT.setLanguage(lang);
    const T = g.PrintBridge.translations[lang];
    let r = await g.RawBT.printCanvas(px, { driver: 'nope' });
    assert.strictEqual(r.error, fill(T.unknownDriver, { name: 'nope', list: DRIVER_IDS }));
    r = await g.RawBT.printCanvas(px, { driver: 'phomemo-m02pro', via: 'app' });
    assert.strictEqual(r.error, fill(T.driverBleOnly, { driver: 'Phomemo M02 Pro' }));
    r = await g.RawBT.printCanvas(px, { driver: 'phomemo-m02pro', via: 'serial' });
    assert.strictEqual(r.error, fill(T.driverSerialNo, { driver: 'Phomemo M02 Pro' }));
    r = await g.RawBT.printCanvas(px, { driver: 'escpos', width: 100 });
    assert.deepStrictEqual([r.code, r.error], ['image', fill(T.badWidth, { max: 576 })]);
    r = await g.RawBT.printCanvas(px, { driver: 'escpos', pacing: 'turbo' });
    assert.deepStrictEqual([r.code, r.error], ['driver', T.badPacing]);
    r = await g.RawBT.printCanvas(null, { driver: 'escpos', via: 'app' });
    assert.deepStrictEqual([r.code, r.error], ['image', T.badImage]);
    r = await g.RawBT.printCanvas(px, { via: 'serial' });
    assert.deepStrictEqual([r.cancelled, r.error], [true, T.portCancelled]);
  }
});

test('a key missing from the Italian table falls back to English, then to the key itself', async () => {
  const g = load({ nav: { language: 'it' } });
  const T = g.PrintBridge.translations;
  assert.strictEqual((await rejects(g.RawBT.serial.print([1]))).message, 'nessuna porta seriale scelta');
  delete T.it.noPort;
  assert.strictEqual((await rejects(g.RawBT.serial.print([1]))).message, 'no serial port chosen');
  delete T.en.noPort;
  assert.strictEqual((await rejects(g.RawBT.serial.print([1]))).message, 'noPort');
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
