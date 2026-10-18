// Prove di RawBT.ble (escpos.js) con un navigator.bluetooth finto, senza stampante.
// Uso: node test/ble-test.js escpos.js
'use strict';
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const SCALE = 50; // timer 50 volte piu veloci: 20 s di timeout diventano 400 ms

const U = (s) => '0000' + s + '-0000-1000-8000-00805f9b34fb';
const S18F0 = U('18f0'), C2AF1 = U('2af1'), C2AF0 = U('2af0');
const SFFF0 = U('fff0'), CFFF2 = U('fff2'), CFFF1 = U('fff1');
const SAE30 = U('ae30'), CAE01 = U('ae01');
const SISSC = '49535343-fe7d-4ae5-8fa9-9fafd205e455', CISSC = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const SUNDECLARED = '12345678-1234-1234-1234-123456789abc';

function dom(name, msg) { return new DOMException(msg, name); }

function storage() {
  const m = {};
  return {
    m,
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}

// Dispositivo finto. services: { uuid: [[charUuid, props], ...] }.
function device(opts) {
  const o = Object.assign({ name: 'BlueTooth Printer', id: 'dev-1', services: {}, connect: null, fail: null, latency: 1 }, opts);
  const listeners = {};
  const dev = {
    name: o.name, id: o.id, writes: [], calls: 0, connectCalls: 0, inFlight: 0, overlap: 0, forgotten: false, allowed: [],
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatch(t) { (listeners[t] || []).slice().forEach((f) => f({ type: t, target: dev })); },
    forget() { dev.forgotten = true; return Promise.resolve(); },
    listenerCount(t) { return (listeners[t] || []).length; }
  };
  function write(uuid, v, withResponse) {
    const n = dev.calls++;
    if (!dev.gatt.connected) return Promise.reject(dom('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.'));
    if (dev.inFlight > 0) dev.overlap++;
    dev.inFlight++;
    const bytes = Array.from(v);
    const err = o.fail ? o.fail({ n, len: bytes.length, withResponse, uuid, dev }) : null;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        dev.inFlight--;
        if (err) return reject(err);
        dev.writes.push({ uuid, bytes, withResponse });
        resolve();
      }, o.latency);
    });
  }
  const chars = {};
  Object.keys(o.services).forEach((s) => {
    chars[s] = o.services[s].map(([uuid, props]) => ({
      uuid,
      properties: Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false }, props),
      writeValueWithResponse: (v) => write(uuid, v, true),
      writeValueWithoutResponse: (v) => write(uuid, v, false)
    }));
  });
  function svc(u) {
    return {
      uuid: u,
      getCharacteristic(c) {
        const f = chars[u].find((x) => x.uuid === c);
        return f ? Promise.resolve(f) : Promise.reject(dom('NotFoundError', 'No Characteristics matching UUID ' + c + ' found in Service.'));
      },
      getCharacteristics() { return Promise.resolve(chars[u].slice()); }
    };
  }
  const server = {
    // Come Chrome: si vedono solo i servizi dichiarati in filters/optionalServices.
    getPrimaryServices() {
      return Promise.resolve(Object.keys(o.services).filter((u) => dev.allowed.indexOf(u) >= 0).map(svc));
    }
  };
  dev.gatt = {
    connected: false,
    connect() {
      dev.connectCalls++;
      const r = o.connect ? o.connect(dev.connectCalls) : null;
      if (r === 'hang') return new Promise(() => {});
      if (r) return Promise.reject(r);
      dev.gatt.connected = true;
      return Promise.resolve(server);
    },
    disconnect() {
      if (!dev.gatt.connected) return;
      dev.gatt.connected = false;
      dev.dispatch('gattserverdisconnected');
    }
  };
  return dev;
}

function load({ devices = [], remember = false, store = storage(), throwSync = null } = {}) {
  const nav = {
    requests: [],
    queue: devices.slice(),
    bluetooth: {
      requestDevice(options) {
        nav.requests.push(options);
        if (throwSync) throw throwSync;
        const d = nav.queue.shift();
        if (!d) return Promise.reject(dom('NotFoundError', 'User cancelled the requestDevice() chooser.'));
        d.allowed = (options.optionalServices || []).concat(
          (options.filters || []).flatMap((f) => f.services || []));
        return Promise.resolve(d);
      },
      getAvailability() { return Promise.resolve(true); }
    }
  };
  if (remember) {
    nav.bluetooth.getDevices = () => Promise.resolve(devices.slice());
  }
  const g = { navigator: nav, localStorage: store, Promise, Date, JSON, AbortController };
  g.window = g;
  const fast = (fn, ms) => setTimeout(fn, Math.max(0, (ms || 0) / SCALE));
  // eslint-disable-next-line no-new-func
  new Function('window', 'setTimeout', 'clearTimeout', src)(g, fast, clearTimeout);
  return { g, ble: g.RawBT.ble, nav, store };
}

function data(n, seed = 7) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 0xFF;
  return a;
}
function delivered(dev) { return dev.writes.flatMap((w) => w.bytes); }
function netum(extra) {
  return device(Object.assign({
    services: { [S18F0]: [[C2AF0, { notify: true }], [C2AF1, { write: true, writeWithoutResponse: true }]] }
  }, extra));
}
async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('doveva fallire');
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('kanjiOff() = FS . (1C 2E)', async () => {
  const { g } = load();
  assert.deepStrictEqual(new g.EscPos().kanjiOff().bytes(), [0x1C, 0x2E]);
});

test('pair(): requestDevice parte subito (gesto), filtri e optionalServices completi, profilo 18F0/2AF1', async () => {
  const dev = netum();
  const { ble, nav } = load({ devices: [dev] });
  const p = ble.pair();
  assert.strictEqual(nav.requests.length, 1, 'requestDevice deve essere chiamata in modo sincrono');
  const info = await p;
  const opt = nav.requests[0];
  assert.ok(opt.filters.some((f) => f.services && f.services[0] === S18F0));
  assert.ok(opt.filters.some((f) => f.name === 'BlueTooth Printer'));
  ble.profiles.forEach((pr) => assert.ok(opt.optionalServices.indexOf(pr.service) >= 0, pr.name));
  assert.ok(opt.optionalServices.indexOf(SAE30) >= 0);
  assert.strictEqual(info.profile, '18F0');
  assert.strictEqual(info.characteristic, C2AF1);
  assert.strictEqual(info.status, 'ready');
  assert.strictEqual(info.paired, true);
  assert.strictEqual(ble.saved().name, 'BlueTooth Printer');
});

test('print() automatica: pezzi da 100 con conferma, byte identici, avanzamento', async () => {
  const dev = netum();
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const d = data(250);
  const prog = [];
  const r = await ble.print(d, { onProgress: (s, t) => prog.push([s, t]) });
  assert.deepStrictEqual(dev.writes.map((w) => w.bytes.length), [100, 100, 50]);
  assert.ok(dev.writes.every((w) => w.withResponse));
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.deepStrictEqual(prog, [[100, 250], [200, 250], [250, 250]]);
  assert.strictEqual(r.chunk, 100);
  assert.strictEqual(dev.overlap, 0);
});

test('ripiego 100 -> 20 se il primo pezzo e rifiutato (NotSupportedError), ricordato', async () => {
  const dev = netum({ fail: ({ len }) => (len > 20 ? dom('NotSupportedError', 'GATT operation not supported.') : null) });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const d = data(95);
  const r = await ble.print(d);
  assert.strictEqual(r.chunk, 20);
  assert.deepStrictEqual(dev.writes.map((w) => w.bytes.length), [20, 20, 20, 20, 15]);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.strictEqual(ble.saved().chunk, 20);
  dev.writes.length = 0;
  const r2 = await ble.print(data(30));
  assert.strictEqual(r2.chunk, 20, 'la stampa successiva parte gia da 20');
  assert.strictEqual(dev.calls, 8, 'nessun nuovo tentativo da 100');
});

test('errore transitorio "unknown reason": ritenta lo stesso pezzo, niente ripiego', async () => {
  const dev = netum({ fail: ({ n }) => (n === 1 ? dom('NetworkError', 'GATT operation failed for unknown reason.') : null) });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const d = data(250);
  const r = await ble.print(d);
  assert.strictEqual(r.chunk, 100);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.strictEqual(ble.saved().chunk || null, null);
});

test('"unknown reason" ripetuto al primo pezzo: 3 tentativi, poi ripiego a 20', async () => {
  const dev = netum({ fail: ({ len }) => (len > 20 ? dom('NetworkError', 'GATT operation failed for unknown reason.') : null) });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const d = data(45);
  const r = await ble.print(d);
  assert.strictEqual(r.chunk, 20);
  assert.strictEqual(dev.calls, 4 + 3, '1 + 3 tentativi da 100, poi 3 pezzi da 20');
  assert.deepStrictEqual(delivered(dev), Array.from(d));
});

test('"unknown reason" a meta stampa oltre i tentativi: errore, niente ripiego', async () => {
  const dev = netum({ fail: ({ n }) => (n >= 1 ? dom('NetworkError', 'GATT operation failed for unknown reason.') : null) });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const e = await rejects(ble.print(data(250)));
  assert.strictEqual(e.name, 'NetworkError');
  assert.strictEqual(dev.calls, 1 + 4);
  assert.strictEqual(ble.info().status, 'ready');
});

test('"GATT Error Unknown." senza conferma: nessun nuovo tentativo, lavoro interrotto', async () => {
  const dev = device({
    services: { [S18F0]: [[C2AF1, { writeWithoutResponse: true }]] },
    fail: ({ n }) => (n === 2 ? dom('NotSupportedError', 'GATT Error Unknown.') : null)
  });
  const { g, ble } = load({ devices: [dev] });
  await ble.pair();
  const e = await rejects(ble.print(data(100)));
  assert.strictEqual(e.message, 'GATT Error Unknown.');
  assert.strictEqual(dev.calls, 3);
  // The advice names the "Advanced" section of the pages, in the language in force.
  g.RawBT.setLanguage('en');
  const advice = ble.explain(e);
  assert.ok(advice.indexOf('(GATT Error Unknown.): print again.') >= 0 && /"Advanced"/.test(advice), advice);
  g.RawBT.setLanguage('it');
  assert.ok(/Avanzate/.test(ble.explain(e)));
});

test('solo writeWithoutResponse: pezzi da 20, nessuna conferma (neanche l\'ultimo)', async () => {
  const dev = device({ services: { [S18F0]: [[C2AF1, { writeWithoutResponse: true }]] } });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const d = data(50);
  const r = await ble.print(d);
  assert.deepStrictEqual(dev.writes.map((w) => [w.bytes.length, w.withResponse]), [[20, false], [20, false], [10, false]]);
  assert.strictEqual(r.withResponse, false);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
});

test('modalita noresponse-20 scelta a mano: anche l\'ultimo pezzo senza conferma', async () => {
  const dev = netum();
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  ble.setWriteMode('noresponse-20');
  await ble.print(data(41));
  assert.deepStrictEqual(dev.writes.map((w) => [w.bytes.length, w.withResponse]), [[20, false], [20, false], [1, false]]);
  assert.strictEqual(ble.info().writeMode, 'noresponse-20');
});

test('modalita response-20: pezzi da 20 con conferma', async () => {
  const dev = netum();
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  ble.setWriteMode('response-20');
  await ble.print(data(41));
  assert.deepStrictEqual(dev.writes.map((w) => [w.bytes.length, w.withResponse]), [[20, true], [20, true], [1, true]]);
});

test('coda: due stampe insieme non si mescolano e non si sovrappongono', async () => {
  const dev = netum({ latency: 3 });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const a = data(300, 1), b = data(300, 2);
  await Promise.all([ble.print(a), ble.print(b)]);
  assert.deepStrictEqual(delivered(dev), Array.from(a).concat(Array.from(b)));
  assert.strictEqual(dev.overlap, 0);
});

test('coda: una stampa fallita non blocca la successiva', async () => {
  let failNext = true;
  const dev = netum({ fail: () => (failNext ? (failNext = false, dom('NotSupportedError', 'GATT Error Unknown.')) : null) });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  ble.setWriteMode('noresponse-20');
  const p1 = ble.print(data(10));
  const p2 = ble.print(data(10, 3));
  await rejects(p1);
  await p2;
  assert.deepStrictEqual(delivered(dev), Array.from(data(10, 3)));
});

test('cat printer (solo AE30): rifiutata con messaggio chiaro', async () => {
  const dev = device({ name: 'MX06', services: { [SAE30]: [[CAE01, { writeWithoutResponse: true }]] } });
  const { ble } = load({ devices: [dev] });
  const e = await rejects(ble.pair({ all: true }));
  assert.strictEqual(e.code, 'cat-printer');
  assert.ok(/cat printer/.test(ble.explain(e)));
  assert.strictEqual(ble.info().status, 'error');
});

test('canale sconosciuto: no-channel, diagnostica, scelta a mano ricordata', async () => {
  const dev = device({ name: 'Strana', services: { [SFFF0]: [[CFFF1, { notify: true }], [CFFF2, { write: true }]], [SUNDECLARED]: [[U('aaaa'), { write: true }]] } });
  const store = storage();
  const { ble } = load({ devices: [dev], store });
  const e = await rejects(ble.pair({ all: true }));
  assert.strictEqual(e.code, 'no-channel');
  const list = await ble.describe();
  assert.deepStrictEqual(list.map((s) => s.service), [SFFF0], 'il servizio non dichiarato resta invisibile');
  assert.deepStrictEqual(list[0].characteristics.map((c) => [c.uuid, c.write]), [[CFFF1, false], [CFFF2, true]]);
  const info = await ble.useCharacteristic(SFFF0, CFFF2);
  assert.strictEqual(info.profile, 'scelto a mano');
  assert.strictEqual(info.characteristic, CFFF2);
  await ble.print(data(30));
  assert.ok(dev.writes.every((w) => w.uuid === CFFF2));
  const saved = JSON.parse(store.getItem('printbridge.ble'));
  assert.strictEqual(saved.service, SFFF0);
  assert.strictEqual(saved.characteristic, CFFF2);
});

test('UUID atteso assente nel servizio noto: usa la prima caratteristica scrivibile', async () => {
  const dev = device({ services: { [SISSC]: [[U('1111'), { notify: true }], [U('2222'), { writeWithoutResponse: true }]] } });
  const { ble } = load({ devices: [dev] });
  const info = await ble.pair();
  assert.strictEqual(info.profile, 'ISSC');
  assert.strictEqual(info.characteristic, U('2222'));
});

test('profilo ISSC con UUID corretto', async () => {
  const dev = device({ services: { [SISSC]: [[CISSC, { write: true, writeWithoutResponse: true }]] } });
  const { ble } = load({ devices: [dev] });
  const info = await ble.pair();
  assert.strictEqual(info.characteristic, CISSC);
});

test('stampante scollegata (auto-sleep): stato aggiornato, la stampa si ricollega da sola', async () => {
  const dev = netum();
  const { ble } = load({ devices: [dev] });
  const states = [];
  ble.on((i) => states.push(i.status));
  await ble.pair();
  dev.gatt.disconnect();
  assert.strictEqual(ble.info().status, 'disconnected');
  assert.strictEqual(ble.info().connected, false);
  const d = data(120);
  await ble.print(d);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.strictEqual(dev.connectCalls, 2);
  assert.ok(states.indexOf('printing') >= 0);
  assert.strictEqual(ble.info().status, 'ready');
});

test('pair(): NetworkError alla prima connessione -> ritenta una volta', async () => {
  const dev = netum({ connect: (n) => (n === 1 ? dom('NetworkError', 'Connection attempt failed.') : null) });
  const { ble } = load({ devices: [dev] });
  const info = await ble.pair();
  assert.strictEqual(info.status, 'ready');
  assert.strictEqual(dev.connectCalls, 2);
});

test('connessione: NetworkError poi stampa -> bleEnsure ritenta', async () => {
  let fails = 0;
  const dev = netum({ connect: () => (fails-- > 0 ? dom('NetworkError', 'Connection attempt failed.') : null) });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  dev.gatt.disconnect();
  fails = 1;
  await ble.print(data(10));
  assert.strictEqual(dev.connectCalls, 3);
});

test('connessione appesa: errore timeout senza nuovo tentativo', async () => {
  let hang = false;
  const dev = netum({ connect: () => (hang ? 'hang' : null) });
  const { g, ble } = load({ devices: [dev] });
  await ble.pair();
  dev.gatt.disconnect();
  hang = true;
  const t0 = Date.now();
  const e = await rejects(ble.print(data(10)));
  assert.strictEqual(e.code, 'timeout');
  assert.strictEqual(dev.connectCalls, 2, 'un timeout non si ritenta');
  assert.ok(Date.now() - t0 < 2000);
  g.RawBT.setLanguage('en');
  assert.strictEqual(e.message, 'Connection to the printer: no answer within 20 s');
  assert.ok(/Turn the printer on, bring it closer and try again/.test(ble.explain(e)), ble.explain(e));
  g.RawBT.setLanguage('it');
  assert.ok(/Accendi la stampante/.test(ble.explain(e)));
});

test('pair({ sameName }) filtra per il nome salvato', async () => {
  const dev = netum();
  const dev2 = netum();
  const store = storage();
  const first = load({ devices: [dev], store });
  await first.ble.pair();
  const second = load({ devices: [dev2], store });
  await second.ble.pair({ sameName: true });
  assert.deepStrictEqual(second.nav.requests[0].filters, [{ name: 'BlueTooth Printer' }]);
  assert.ok(second.nav.requests[0].optionalServices.indexOf(S18F0) >= 0);
});

test('altra stampante: le scelte manuali della precedente vengono dimenticate', async () => {
  const store = storage();
  const a = load({ devices: [netum()], store });
  await a.ble.pair();
  a.ble.setWriteMode('response-20');
  const b = load({ devices: [netum({ name: 'MPT-II', id: 'dev-2' })], store });
  const info = await b.ble.pair();
  assert.strictEqual(info.writeMode, 'auto');
  assert.strictEqual(b.ble.saved().name, 'MPT-II');
});

test('reconnect() senza permessi persistenti: null (serve un tocco)', async () => {
  const store = storage();
  const a = load({ devices: [netum()], store });
  await a.ble.pair();
  const b = load({ devices: [netum()], store });
  assert.strictEqual(b.ble.canRemember(), false);
  assert.strictEqual(await b.ble.reconnect(), null);
});

test('reconnect() con getDevices: si ricollega da sola alla stampante ricordata', async () => {
  const store = storage();
  const dev = netum();
  const a = load({ devices: [dev], store });
  await a.ble.pair();
  dev.gatt.disconnect();
  const dev2 = netum();
  dev2.allowed = dev.allowed;
  const b = load({ devices: [dev2], store, remember: true });
  assert.strictEqual(b.ble.canRemember(), true);
  const info = await b.ble.reconnect();
  assert.strictEqual(info.status, 'ready');
  assert.strictEqual(b.nav.requests.length, 0, 'nessun chooser');
});

test('forget(): stato idle, salvataggio rimosso, permesso revocato', async () => {
  const dev = netum();
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  await ble.forget();
  assert.strictEqual(ble.saved(), null);
  assert.strictEqual(ble.info().status, 'idle');
  assert.strictEqual(ble.info().paired, false);
  assert.strictEqual(dev.forgotten, true);
  assert.strictEqual(dev.listenerCount('gattserverdisconnected'), 0);
  const e = await rejects(ble.print(data(5)));
  assert.strictEqual(e.code, 'no-device');
});

test('requestDevice che lancia subito (SecurityError): pair restituisce una promessa rifiutata', async () => {
  const { g, ble } = load({ throwSync: dom('SecurityError', 'Must be handling a user gesture to show a permission request.') });
  const p = ble.pair();
  assert.ok(p && typeof p.then === 'function');
  const e = await rejects(p);
  assert.strictEqual(e.name, 'SecurityError');
  g.RawBT.setLanguage('en');
  assert.ok(/needs a tap/.test(ble.explain(e)), ble.explain(e));
  g.RawBT.setLanguage('it');
  assert.ok(/tocco/.test(ble.explain(e)));
});

test('explain(): annullamento = stringa vuota; Posizione; non supportato', async () => {
  const { g, ble } = load();
  const cancel = dom('NotFoundError', 'User cancelled the requestDevice() chooser.');
  const location = dom('NotFoundError', 'Bluetooth adapter not available. Location permission is required.');
  const range = dom('NetworkError', 'Bluetooth Device is no longer in range.');
  g.RawBT.setLanguage('en');
  assert.strictEqual(ble.explain(cancel), '');
  assert.ok(/give Chrome the Location permission/.test(ble.explain(location)), ble.explain(location));
  assert.ok(/Print Bridge app/.test(ble.explain({ code: 'unsupported', message: 'x' })));
  assert.ok(/no longer in range.*"Reconnect"/.test(ble.explain(range)), ble.explain(range));
  g.RawBT.setLanguage('it');
  assert.strictEqual(ble.explain(cancel), '');
  assert.ok(/Posizione/.test(ble.explain(location)));
  assert.ok(/Print Bridge/.test(ble.explain({ code: 'unsupported', message: 'x' })));
  assert.ok(/Riconnetti/.test(ble.explain(range)));
});

test('supported()/canRemember() senza Web Bluetooth', async () => {
  const g = { navigator: {}, localStorage: storage(), Promise, Date, JSON };
  g.window = g;
  // eslint-disable-next-line no-new-func
  new Function('window', src)(g);
  assert.strictEqual(g.RawBT.ble.supported(), false);
  assert.strictEqual(g.RawBT.ble.canRemember(), false);
  assert.strictEqual(await g.RawBT.ble.available(), null);
  const e = await rejects(g.RawBT.ble.pair());
  assert.strictEqual(e.code, 'unsupported');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('OK   ' + name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     '));
    }
  }
  console.log(failed ? failed + ' PROVE FALLITE' : 'TUTTO OK (' + tests.length + ' prove)');
  process.exit(failed ? 1 : 0);
})();
