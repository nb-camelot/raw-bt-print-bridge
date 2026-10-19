// Tests of RawBT.serial (escpos.js), direct printing over Web Serial, with a fake
// navigator.serial and no printer: USB-serial and Bluetooth (SPP) ports, the port chooser that
// needs a tap, the ports Chrome remembers (getPorts), writes in 256-byte chunks with 25 ms
// pauses, the 10 s timeout of every write (and the wait for its abort), the queue, write errors,
// one open() shared by reconnect() and a print, an open() that settles after an unplug,
// unplugging and plugging in again, the speed, forget (also of a port that is unplugged or not
// open yet), explain, and via 'serial' in RawBT.chooseVia, RawBT.printLayout and
// RawBT.printCanvas. Every library timer
// (when it is set, when it fires, when it is cleared) and every write, open, close and abort go
// to one log, so pauses and timeouts are checked in the order they happen.
// Usage: node test/serial-test.js escpos.js
'use strict';
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const SCALE = 5; // timers 5 times faster: a 25 ms pause takes 5 ms
const WRITE_TIMEOUT = 10000; // every write of the library races a 10 s timer
const SPP = '00001101-0000-1000-8000-00805f9b34fb';
const FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';
const USB = { usbVendorId: 0x0416, usbProductId: 0x5011 };
const USB2 = { usbVendorId: 0x1A86, usbProductId: 0x7523 };
const BT = { bluetoothServiceClassId: SPP };
const BAUDS = [9600, 19200, 38400, 57600, 115200];
const BAD_BAUD = 'baudRate must be one of: 9600, 19200, 38400, 57600, 115200';
const BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];
// Chrome keeps a tap valid for a few seconds (transient user activation), not only during the
// click handler: a chooser opened after a quick await (getPorts) still works.
const ACTIVATION_MS = 5000;
const CANCELLED = "Failed to execute 'requestPort' on 'Serial': No port selected by the user.";
const NO_GESTURE = "Failed to execute 'requestPort' on 'Serial': Must be handling a user gesture to show a permission request.";

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
function data(n, seed = 7) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 0xFF;
  return a;
}
// ImageData-like source: fn(x, y) -> [r, g, b, a].
function pixels(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data: px };
}
async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('should have failed');
}
// A localStorage where an earlier visit saved a port.
function remembered(info, baudRate) {
  const s = storage();
  s.setItem('printbridge.serial', JSON.stringify(baudRate ? { info, baudRate } : { info }));
  return s;
}
// Lets every pending promise callback run.
function tick() { return new Promise((r) => setTimeout(r, 0)); }
function delivered(p) { return p.writes.flat(); }
// The text of a table entry with its {placeholders} filled, as the library does.
function fill(s, params) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params || {}, k) ? String(params[k]) : m));
}
// Writes and timers only: 'w<length>', 't<ms>' when a timer is set, '/t<ms>' when it fires,
// 'c<ms>' when it is cleared before firing.
function wt(log) { return log.filter((x) => /^(w|t|\/t|c)\d/.test(x)); }
// Writes and pauses only: wt without the 10 s timer that guards every write.
function wp(log) { return wt(log).filter((x) => !/^(t|\/t|c)10000$/.test(x)); }

// A writable stream like SerialPort.writable: one writer at a time, Uint8Array chunks only.
// writer.abort(reason) errors the stream: the write in progress rejects a moment later (the
// abort signal of the stream stops it), any later write at once with the reason. As in Chrome,
// SerialPort gives a new writable stream only when the abort is done (a round trip to the
// device): here after o.abortDelay real ms, before the abort promise resolves (null: never).
function stream(p) {
  const w = {
    locked: false,
    errored: false,
    getWriter() {
      if (w.locked) throw new TypeError("Failed to execute 'getWriter' on 'WritableStream': Cannot create writer when WritableStream is locked");
      w.locked = true;
      let released = false;
      const hung = [];
      return {
        write(chunk) {
          if (released) return Promise.reject(new TypeError('This writable stream writer has been released and cannot be used to write.'));
          if (w.errored) return Promise.reject(w.reason);
          if (!(chunk instanceof Uint8Array)) return Promise.reject(new TypeError("Failed to execute 'write': the chunk is not a BufferSource"));
          const n = p.calls++;
          const bytes = Array.from(chunk);
          if (p.log) p.log.push('w' + bytes.length);
          if (p.inFlight > 0) p.overlap++;
          p.inFlight++;
          const err = p.o.fail ? p.o.fail({ n, bytes, port: p }) : null;
          // 'hang': the printer never takes the bytes (flow control held, off, out of paper).
          if (err === 'hang') return new Promise((resolve, reject) => hung.push(reject));
          return new Promise((resolve, reject) => setTimeout(() => {
            p.inFlight--;
            if (err) return reject(err);
            p.writes.push(bytes);
            resolve();
          }, p.o.latency));
        },
        abort(reason) {
          if (released) return Promise.reject(new TypeError('This writable stream writer has been released and cannot be used to abort.'));
          p.aborts++;
          if (p.log) p.log.push('abort');
          w.errored = true;
          w.reason = reason;
          const why = reason === undefined ? dom('AbortError', 'signal is aborted without reason') : reason;
          hung.splice(0).forEach((reject) => setTimeout(() => { p.inFlight--; reject(why); }, 0));
          if (p.o.abortDelay == null) return new Promise(() => {});
          return new Promise((resolve) => setTimeout(() => {
            if (p.writable === w) p.writable = stream(p);
            resolve();
          }, p.o.abortDelay));
        },
        releaseLock() {
          if (released) return;
          released = true;
          w.locked = false;
          p.releases++;
        }
      };
    }
  };
  return w;
}

// A fake SerialPort. info: what getInfo() answers. o.fail({ n, bytes }) may return an error (or
// 'hang') for write n; o.openFail(n, options) one for open n; o.latency: ms per write;
// o.abortDelay: ms until an abort is done (see stream); o.hold: open() stays in progress until
// the test calls p.held.resolve() or p.held.reject(error). Like Chrome, a second open() while
// one is in progress is refused.
function port(info, opts) {
  const o = Object.assign({ latency: 1, fail: null, openFail: null, abortDelay: 5, hold: false }, opts);
  const p = {
    o, info, opens: [], closes: 0, aborts: 0, forgotten: false, plugged: true, opening: false, writes: [], calls: 0,
    releases: 0, inFlight: 0, overlap: 0, readable: null, writable: null, log: null, nav: null,
    getInfo() { return Object.assign({}, info); },
    open(options) {
      p.opens.push(Object.assign({}, options));
      if (p.log) p.log.push('open' + (options && options.baudRate));
      if (p.opening) return Promise.reject(dom('InvalidStateError', "Failed to execute 'open' on 'SerialPort': A call to open() is already in progress."));
      if (p.writable) return Promise.reject(dom('InvalidStateError', "Failed to execute 'open' on 'SerialPort': The port is already open."));
      if (!p.plugged) return Promise.reject(dom('NetworkError', 'Failed to open serial port.'));
      const err = o.openFail ? o.openFail(p.opens.length, options) : null;
      if (err) return Promise.reject(err);
      p.opening = true;
      if (o.hold) {
        return new Promise((resolve, reject) => {
          p.held = {
            resolve() { p.opening = false; p.writable = stream(p); p.readable = {}; resolve(); },
            reject(e) { p.opening = false; reject(e); }
          };
        });
      }
      return new Promise((resolve) => setTimeout(() => {
        p.opening = false;
        p.writable = stream(p);
        p.readable = {};
        resolve();
      }, 1));
    },
    close() {
      if (!p.writable && !p.readable) return Promise.reject(dom('InvalidStateError', "Failed to execute 'close' on 'SerialPort': The port is already closed."));
      if (p.writable && p.writable.locked) return Promise.reject(new TypeError("Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream"));
      p.closes++;
      if (p.log) p.log.push('close');
      p.writable = null;
      p.readable = null;
      return Promise.resolve();
    },
    forget() {
      p.forgotten = true;
      if (p.nav) p.nav.known = p.nav.known.filter((x) => x !== p);
      return Promise.resolve();
    },
    // The cable is pulled (or the Bluetooth link drops): the streams go, Chrome fires "disconnect"
    // and getPorts no longer lists this object. Plugged in again, the printer is a new SerialPort
    // object (see replug).
    unplug() {
      p.plugged = false;
      p.writable = null;
      p.readable = null;
      if (p.nav) {
        p.nav.known = p.nav.known.filter((x) => x !== p);
        p.nav.dispatch('disconnect', p);
      }
    }
  };
  return p;
}

// ports: what the chooser returns, in order (none left = the person closes it). known: the
// ports Chrome already allows for this site (getPorts). serial: false = no Web Serial. scale:
// how much faster the library timers run.
function load({ ports = [], known = [], store = storage(), serial = true, scale = SCALE } = {}) {
  const log = [];
  const listeners = {};
  const nav = {
    requests: [], queue: ports.slice(), known: known.slice(), getPortsCalls: 0,
    inTap: false, tapAt: null, throwSync: null,
    dispatch(type, target) { (listeners[type] || []).slice().forEach((fn) => fn({ type, target })); },
    listenerCount(type) { return (listeners[type] || []).length; }
  };
  const wire = (p) => { p.log = log; p.nav = nav; return p; };
  ports.concat(known).forEach(wire);
  if (serial) {
    nav.serial = {
      requestPort(options) {
        const active = nav.tapAt !== null && Date.now() - nav.tapAt < ACTIVATION_MS;
        nav.requests.push({ options, sync: nav.inTap, active });
        if (nav.throwSync) throw nav.throwSync;
        if (!active) return Promise.reject(dom('SecurityError', NO_GESTURE));
        const p = nav.queue.shift();
        if (!p) return Promise.reject(dom('NotFoundError', CANCELLED));
        if (nav.known.indexOf(p) < 0) nav.known.push(wire(p));
        return Promise.resolve(p);
      },
      getPorts() {
        nav.getPortsCalls++;
        return Promise.resolve(nav.known.slice());
      },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); }
    };
  }
  // The printer plugged in again: a new SerialPort with the same info, listed by getPorts.
  nav.replug = (info) => {
    const p = wire(port(info));
    nav.known.push(p);
    nav.dispatch('connect', p);
    return p;
  };
  const g = { navigator: nav, localStorage: store, Promise, Date, JSON };
  g.window = g;
  const live = new Map();
  const timer = (fn, ms) => {
    ms = ms || 0;
    log.push('t' + ms);
    const h = setTimeout(() => { live.delete(h); log.push('/t' + ms); fn(); }, Math.max(0, ms / scale));
    live.set(h, ms);
    return h;
  };
  const clear = (h) => {
    if (live.has(h)) { log.push('c' + live.get(h)); live.delete(h); }
    clearTimeout(h);
  };
  const noFetch = () => Promise.reject(new TypeError('Failed to fetch'));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'fetch', src)(g, undefined, timer, clear, noFetch);
  return { g, ser: g.RawBT.serial, PB: g.PrintBridge, T: g.PrintBridge.translations, nav, store, log };
}

// A tap on a button: what fn calls synchronously runs inside the gesture.
function tap(nav, fn) {
  nav.inTap = true;
  nav.tapAt = Date.now();
  try { return fn(); } finally { nav.inTap = false; }
}
// A BLE state for the auto choice, without Web Bluetooth.
function stubBle(g, s) {
  g.RawBT.ble.supported = () => true;
  g.RawBT.ble.info = () => ({ paired: !!s.paired, remembered: !!s.remembered });
}
const IDLE = { status: 'idle', paired: false, connected: false, label: null, baudRate: 9600, remembered: false, lastError: null };

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ---------------------------------------------------------------- pair

test('supported() is false without Web Serial: pair rejects (unsupported), reconnect is null', async () => {
  const { ser, T } = load({ serial: false });
  assert.strictEqual(ser.supported(), false);
  const e = await rejects(ser.pair());
  assert.deepStrictEqual([e.name, e.code, e.message], ['PrintBridgeSerialError', 'unsupported', T.en.serialUnsupported]);
  assert.strictEqual(ser.explain(e), e.message);
  assert.strictEqual(await ser.reconnect(), null);
  assert.deepStrictEqual(ser.info(), IDLE);
  const odd = load();
  delete odd.nav.serial.requestPort;
  assert.strictEqual(odd.ser.supported(), false, 'navigator.serial without requestPort');
});

test('pair(): requestPort in the same call (tap), SPP always allowed, filters passed, opened at 9600', async () => {
  const p1 = port(USB);
  const { ser, nav, store } = load({ ports: [p1] });
  assert.strictEqual(ser.supported(), true);
  assert.strictEqual(ser.spp, SPP);
  assert.deepStrictEqual(ser.bauds, BAUDS);
  const filters = [{ usbVendorId: 0x0416 }];
  const pr = tap(nav, () => ser.pair({ filters, bluetoothServiceClassIds: [FFE0] }));
  assert.strictEqual(nav.requests.length, 1, 'requestPort must be called synchronously, inside the tap');
  assert.strictEqual(nav.requests[0].sync, true);
  assert.deepStrictEqual(nav.requests[0].options, { filters, allowedBluetoothServiceClassIds: [SPP, FFE0] });
  const info = await pr;
  assert.deepStrictEqual(p1.opens, [{ baudRate: 9600 }]);
  assert.deepStrictEqual(info, { status: 'ready', paired: true, connected: true, label: 'USB 0416:5011', baudRate: 9600, remembered: true, lastError: null });
  assert.deepStrictEqual(ser.info(), info);
  assert.deepStrictEqual(ser.saved(), { info: USB });
  assert.deepStrictEqual(JSON.parse(store.getItem('printbridge.serial')), { info: USB });
  // No options: every port, and Bluetooth with the Serial Port Profile only.
  const b = load({ ports: [port(USB)] });
  await tap(b.nav, () => b.ser.pair());
  assert.deepStrictEqual(b.nav.requests[0].options, { filters: [], allowedBluetoothServiceClassIds: [SPP] });
});

test('pair({ baudRate }): opened at that speed and kept; a bad speed is refused before the chooser', async () => {
  const store = storage();
  const p1 = port(USB);
  const A = load({ ports: [p1], store });
  for (const bad of [1234, 'fast', 0]) {
    const e = await rejects(tap(A.nav, () => A.ser.pair({ baudRate: bad })));
    assert.deepStrictEqual([e.code, e.message], ['baud', BAD_BAUD], String(bad));
    assert.strictEqual(A.ser.explain(e), BAD_BAUD);
  }
  assert.strictEqual(A.nav.requests.length, 0, 'no chooser for a bad speed');
  const info = await tap(A.nav, () => A.ser.pair({ baudRate: '115200' }));
  assert.deepStrictEqual(p1.opens, [{ baudRate: 115200 }]);
  assert.strictEqual(info.baudRate, 115200);
  assert.strictEqual(A.ser.saved().baudRate, 115200);
  // The next visit opens the port it is given at the saved speed.
  const p2 = port(USB2);
  const B = load({ ports: [p2], store });
  assert.strictEqual(B.ser.info().baudRate, 115200);
  await tap(B.nav, () => B.ser.pair());
  assert.deepStrictEqual(p2.opens, [{ baudRate: 115200 }]);
});

test('pair(): chooser closed -> NotFoundError explained as ""; outside a tap -> SecurityError; a throwing requestPort -> a rejected promise', async () => {
  const A = load({ ports: [] });
  let e = await rejects(tap(A.nav, () => A.ser.pair()));
  assert.strictEqual(e.name, 'NotFoundError');
  assert.strictEqual(A.ser.explain(e), '');
  assert.deepStrictEqual(A.ser.info(), IDLE);
  assert.strictEqual(A.ser.saved(), null);
  const B = load({ ports: [port(USB)] });
  e = await rejects(B.ser.pair());
  assert.strictEqual(e.name, 'SecurityError');
  assert.strictEqual(B.ser.explain(e), 'Choosing the printer needs a tap on a button.');
  const C = load({ ports: [port(USB)] });
  C.nav.throwSync = dom('SecurityError', NO_GESTURE);
  const p = tap(C.nav, () => C.ser.pair());
  assert.ok(p && typeof p.then === 'function', 'pair never throws');
  e = await rejects(p);
  assert.strictEqual(e.name, 'SecurityError');
});

test('pair() again with another port: the old one is closed, the new one saved and watched', async () => {
  const a = port(USB), b = port(USB2);
  const { ser, nav } = load({ ports: [a, b] });
  await tap(nav, () => ser.pair());
  await tap(nav, () => ser.pair());
  assert.strictEqual(a.closes, 1);
  assert.deepStrictEqual(ser.saved().info, USB2);
  assert.strictEqual(ser.info().label, 'USB 1A86:7523');
  assert.strictEqual(nav.listenerCount('disconnect'), 1, 'one listener, whatever the number of pairings');
  a.unplug();
  assert.strictEqual(ser.info().status, 'ready', 'the old port no longer matters');
  b.unplug();
  assert.strictEqual(ser.info().status, 'disconnected');
});

test('Bluetooth Classic port (SPP): label "Bluetooth SPP", found again by its service class', async () => {
  const store = storage();
  const A = load({ ports: [port(BT)], store });
  const info = await tap(A.nav, () => A.ser.pair());
  assert.strictEqual(info.label, 'Bluetooth SPP');
  assert.deepStrictEqual(A.ser.saved().info, BT);
  // Next visit: Chrome allows a USB port and the Bluetooth one: the Bluetooth one is used.
  const usb = port(USB), bt = port(BT);
  const B = load({ known: [usb, bt], store });
  assert.strictEqual(B.ser.info().label, 'Bluetooth SPP', 'label of the saved port before reconnecting');
  const again = await B.ser.reconnect();
  assert.deepStrictEqual([again.status, again.label], ['ready', 'Bluetooth SPP']);
  assert.deepStrictEqual([bt.opens.length, usb.opens.length, B.nav.requests.length], [1, 0, 0]);
  const C = load({ ports: [port({ bluetoothServiceClassId: FFE0 })] });
  assert.strictEqual((await tap(C.nav, () => C.ser.pair({ bluetoothServiceClassIds: [FFE0] }))).label, 'Bluetooth ' + FFE0);
});

// ---------------------------------------------------------------- reconnect

test('reconnect(): no chooser, no tap: the saved port among those Chrome allows, else the only one', async () => {
  const store = storage();
  const A = load({ ports: [port(USB)], store });
  await tap(A.nav, () => A.ser.pair({ baudRate: 19200 }));
  // The saved one among others.
  const other = port(USB2), same = port(USB);
  const B = load({ known: [other, same], store });
  assert.deepStrictEqual(B.ser.info(), { status: 'idle', paired: false, connected: false, label: 'USB 0416:5011', baudRate: 19200, remembered: true, lastError: null });
  const info = await B.ser.reconnect();
  assert.deepStrictEqual([info.status, info.connected, info.label], ['ready', true, 'USB 0416:5011']);
  assert.deepStrictEqual(same.opens, [{ baudRate: 19200 }]);
  assert.strictEqual(other.opens.length, 0);
  assert.strictEqual(B.nav.requests.length, 0, 'no chooser');
  // A single port that is not the saved one: that one, and it becomes the saved port.
  const only = port(USB2);
  const C = load({ known: [only], store });
  assert.strictEqual((await C.ser.reconnect()).label, 'USB 1A86:7523');
  assert.deepStrictEqual(C.ser.saved(), { info: USB2, baudRate: 19200 });
  // Two ports and neither is the saved one: a tap is needed.
  const D = load({ known: [port({ usbVendorId: 1, usbProductId: 2 }), port({ usbVendorId: 3, usbProductId: 4 })], store });
  assert.strictEqual(await D.ser.reconnect(), null);
  assert.strictEqual(D.ser.info().paired, false);
  // No port allowed, or no getPorts: null.
  assert.strictEqual(await load({ store }).ser.reconnect(), null);
  const E = load({ known: [port(USB2)], store });
  delete E.nav.serial.getPorts;
  assert.strictEqual(await E.ser.reconnect(), null);
  // Nothing saved: the only port is used too.
  const F = load({ known: [port(USB)] });
  assert.strictEqual((await F.ser.reconnect()).status, 'ready');
});

// ---------------------------------------------------------------- print

test('print(): 256-byte chunks with 25 ms pauses, the exact bytes, progress, the writer released', async () => {
  const p1 = port(USB);
  const { ser, nav, log } = load({ ports: [p1] });
  await tap(nav, () => ser.pair());
  const states = [];
  ser.on((i) => states.push(i.status));
  log.length = 0;
  const d = data(600);
  const prog = [];
  const r = await ser.print(d, { onProgress: (s, t) => prog.push([s, t]) });
  // Every write races a 10 s timer, cleared as soon as the write is done.
  assert.deepStrictEqual(wt(log), [
    'w256', 't10000', 'c10000', 't25', '/t25',
    'w256', 't10000', 'c10000', 't25', '/t25',
    'w88', 't10000', 'c10000'
  ], 'each pause ends before the next chunk; each write timer is cleared');
  assert.deepStrictEqual(wp(log), ['w256', 't25', '/t25', 'w256', 't25', '/t25', 'w88']);
  assert.strictEqual(p1.aborts, 0);
  assert.deepStrictEqual(delivered(p1), Array.from(d));
  assert.deepStrictEqual(prog, [[256, 600], [512, 600], [600, 600]]);
  assert.deepStrictEqual([r.ok, r.bytes, r.chunk], [true, 600, 256]);
  assert.ok(r.ms >= 0);
  assert.deepStrictEqual([p1.writable.locked, p1.releases, p1.overlap], [false, 1, 0]);
  assert.deepStrictEqual(states, ['printing', 'ready']);
  // Exactly two chunks: no pause after the last one.
  log.length = 0;
  await ser.print(data(512, 3));
  assert.deepStrictEqual(wp(log), ['w256', 't25', '/t25', 'w256']);
  // A plain array of bytes works too (sent as Uint8Array).
  log.length = 0;
  p1.writes.length = 0;
  await ser.print([0x1B, 0x40, 0x0A]);
  assert.deepStrictEqual(wt(log), ['w3', 't10000', 'c10000']);
  assert.deepStrictEqual(delivered(p1), [0x1B, 0x40, 0x0A]);
  assert.strictEqual(p1.opens.length, 1, 'the open port is reused');
});

test('print() without a port: no-port, explained', async () => {
  const { ser } = load();
  const e = await rejects(ser.print(data(10)));
  assert.deepStrictEqual([e.name, e.code, e.message], ['PrintBridgeSerialError', 'no-port', 'no serial port chosen']);
  assert.strictEqual(ser.explain(e), 'The serial port was closed or unplugged: plug the printer in (or turn it on) and press "Reconnect".');
});

test('queue: two prints at once do not interleave and never hold two writers', async () => {
  const p1 = port(USB, { latency: 3 });
  const { ser, nav } = load({ ports: [p1] });
  await tap(nav, () => ser.pair());
  const a = data(700, 1), b = data(700, 2);
  const [ra, rb] = await Promise.all([ser.print(a), ser.print(b)]);
  assert.ok(ra.ok && rb.ok);
  assert.deepStrictEqual(delivered(p1), Array.from(a).concat(Array.from(b)));
  assert.deepStrictEqual([p1.overlap, p1.releases], [0, 2]);
});

test('a failed write: code write, cause kept, writer released, still ready; the queued print goes on', async () => {
  const lost = dom('NetworkError', 'The device has been lost.');
  let failAt = 1;
  const p1 = port(USB, { fail: ({ n }) => (n === failAt ? lost : null) });
  const { ser, nav } = load({ ports: [p1] });
  await tap(nav, () => ser.pair());
  const first = ser.print(data(600));
  const second = ser.print(data(10, 5));
  const e = await rejects(first);
  assert.deepStrictEqual([e.name, e.code, e.message], ['PrintBridgeSerialError', 'write', 'The device has been lost.']);
  assert.strictEqual(e.cause, lost);
  assert.strictEqual(ser.explain(e), 'Error while sending to the serial port (The device has been lost.): print again; if it happens again, check the speed (baud rate) in the settings.');
  const r = await second;
  assert.ok(r.ok);
  assert.deepStrictEqual(delivered(p1), Array.from(data(600)).slice(0, 256).concat(Array.from(data(10, 5))), 'stopped at the failed chunk, then the next print');
  assert.deepStrictEqual([p1.writable.locked, p1.releases], [false, 2]);
  assert.deepStrictEqual([ser.info().status, ser.info().lastError], ['ready', null]);
  failAt = p1.calls;
  await rejects(ser.print(data(5)));
  assert.deepStrictEqual([ser.info().status, ser.info().connected, ser.info().lastError], ['ready', true, 'The device has been lost.']);
  assert.strictEqual(p1.aborts, 0, 'a write that fails is not aborted');
});

test('a write that never completes: aborted after 10 s with the timeout as the reason, failed once the abort is done; the queued print goes on', async () => {
  let hangAt = 1;
  const p1 = port(USB, { fail: ({ n }) => (n === hangAt ? 'hang' : null) });
  // Timers 100 times faster: the 10 s timeout takes 100 ms.
  const { ser, nav, log, T, g } = load({ ports: [p1], scale: 100 });
  await tap(nav, () => ser.pair());
  const seen = [];
  ser.on((i) => seen.push([i.status, i.lastError]));
  log.length = 0;
  const first = ser.print(data(600));
  const second = ser.print(data(10, 5));
  const e = await rejects(first);
  const TIMEOUT = fill(T.en.serialTimeout, { s: 10 });
  assert.strictEqual(TIMEOUT, 'no answer from the serial port within 10 s (printer off, out of paper or holding the line)');
  assert.deepStrictEqual([e.name, e.code, e.message], ['PrintBridgeSerialError', 'write', TIMEOUT]);
  assert.strictEqual(ser.explain(e), fill(T.en.explainSerialWrite, { detail: TIMEOUT }));
  const r = await second;
  assert.deepStrictEqual([r.ok, r.bytes], [true, 10], 'the queue goes on');
  assert.deepStrictEqual(log.filter((x) => /^(w|t|\/t|c)\d|^abort$/.test(x)), [
    'w256', 't10000', 'c10000', 't25', '/t25',
    'w256', 't10000', '/t10000', 'abort', // the second chunk hangs: the timer fires, the writer is aborted
    't2000', 'c2000', // the failure waits for the abort (at most 2 s): here it is done in 5 ms
    'w10', 't10000', 'c10000' // the next print, on the new stream of the port
  ]);
  assert.strictEqual(p1.aborts, 1);
  assert.deepStrictEqual(delivered(p1), Array.from(data(600)).slice(0, 256).concat(Array.from(data(10, 5))));
  assert.deepStrictEqual([p1.writable.locked, p1.releases, p1.inFlight], [false, 2, 0], 'both writers released, nothing pending');
  assert.deepStrictEqual(seen, [['printing', null], ['ready', TIMEOUT], ['printing', null], ['ready', null]]);
  assert.strictEqual(p1.opens.length, 1, 'the port stays open');
  // In Italian.
  g.RawBT.setLanguage('it');
  hangAt = p1.calls;
  const it = await rejects(ser.print(data(5)));
  assert.deepStrictEqual([it.code, it.message], ['write', fill(T.it.serialTimeout, { s: 10 })]);
  assert.strictEqual(p1.aborts, 2);
  assert.ok((await ser.print(data(3))).ok);
});

test('an abort that never ends: the print fails 2 s later; the next one fails with the timeout message, not "undefined"', async () => {
  const p1 = port(USB, { fail: ({ n }) => (n === 1 ? 'hang' : null), abortDelay: null });
  const { ser, nav, log, T } = load({ ports: [p1], scale: 100 });
  await tap(nav, () => ser.pair());
  log.length = 0;
  const first = ser.print(data(600));
  const second = ser.print(data(10, 5));
  const TIMEOUT = fill(T.en.serialTimeout, { s: 10 });
  const e = await rejects(first);
  assert.deepStrictEqual([e.code, e.message], ['write', TIMEOUT]);
  // The port still gives the errored stream: its writes fail with the reason of the abort.
  const e2 = await rejects(second);
  assert.deepStrictEqual([e2.code, e2.message], ['write', TIMEOUT]);
  assert.strictEqual(ser.explain(e2), fill(T.en.explainSerialWrite, { detail: TIMEOUT }));
  assert.deepStrictEqual(log.filter((x) => /^(w|t|\/t|c)\d|^abort$/.test(x)), [
    'w256', 't10000', 'c10000', 't25', '/t25',
    'w256', 't10000', '/t10000', 'abort',
    't2000', '/t2000', // no end of the abort: the 2 s limit
    't10000', 'c10000' // the next print: the write is refused at once
  ]);
  assert.deepStrictEqual([p1.aborts, p1.releases], [1, 2]);
});

test('unplugged (disconnect event): status disconnected, the dead port dropped (saved info kept); print() is no-port until it is back', async () => {
  const p1 = port(USB), other = port(USB2);
  const { ser, nav, T } = load({ ports: [p1] });
  await tap(nav, () => ser.pair({ baudRate: 19200 }));
  nav.dispatch('disconnect', other);
  assert.strictEqual(ser.info().status, 'ready', 'another port of the site does not matter');
  const states = [];
  ser.on((i) => states.push(i.status));
  p1.unplug();
  assert.deepStrictEqual(ser.info(), { status: 'disconnected', paired: false, connected: false, label: 'USB 0416:5011', baudRate: 19200, remembered: true, lastError: null });
  assert.deepStrictEqual(ser.saved(), { info: USB, baudRate: 19200 }, 'the saved port stays, to find it again');
  const e = await rejects(ser.print(data(10)));
  assert.deepStrictEqual([e.code, e.message], ['no-port', T.en.noPort]);
  assert.strictEqual(ser.explain(e), T.en.explainSerialLost);
  assert.strictEqual(await ser.reconnect(), null, 'still unplugged: getPorts does not list it, a tap would be needed');
  // A late event for the dead port changes nothing.
  nav.dispatch('disconnect', p1);
  assert.deepStrictEqual(states, ['disconnected']);
  assert.deepStrictEqual([p1.opens.length, nav.requests.length], [1, 1], 'the dead port is never opened again');
  assert.strictEqual(ser.info().status, 'disconnected');
});

test('unplugged and plugged in again (a new SerialPort, same info): printLayout and reconnect() find it with getPorts, no chooser', async () => {
  const p1 = port(USB);
  const { g, ser, nav, PB } = load({ ports: [p1] });
  await tap(nav, () => ser.pair({ baudRate: 57600 }));
  const lay = { blocks: [{ text: 'back {{n}}' }, { cut: true }] };
  // printLayout auto, outside a tap.
  p1.unplug();
  const back = nav.replug(USB);
  const r = await g.RawBT.printLayout(lay, { n: 1 });
  assert.deepStrictEqual([r.ok, r.via, r.reason], [true, 'serial', 'serial-remembered']);
  assert.deepStrictEqual(back.opens, [{ baudRate: 57600 }]);
  assert.deepStrictEqual(delivered(back), Array.from(await PB.render(lay, { n: 1 })));
  assert.deepStrictEqual([ser.info().status, ser.info().paired, ser.info().connected], ['ready', true, true]);
  // Again with via 'serial' given.
  back.unplug();
  const again = nav.replug(USB);
  const r2 = await g.RawBT.printLayout(lay, { n: 2 }, { via: 'serial' });
  assert.deepStrictEqual([r2.ok, r2.via, r2.reason], [true, 'serial', 'option']);
  assert.deepStrictEqual(delivered(again), Array.from(await PB.render(lay, { n: 2 })));
  // And the page's own "Reconnect" button: reconnect(), then print().
  again.unplug();
  const third = nav.replug(USB);
  const info = await ser.reconnect();
  assert.deepStrictEqual([info.status, info.connected, info.label], ['ready', true, 'USB 0416:5011']);
  assert.ok((await ser.print(data(20))).ok);
  assert.deepStrictEqual(delivered(third), Array.from(data(20)));
  assert.strictEqual(nav.requests.length, 1, 'the chooser opened only for the first pairing');
  assert.deepStrictEqual([p1.opens.length, back.opens.length, again.opens.length, third.opens.length], [1, 1, 1, 1]);
  assert.strictEqual(nav.listenerCount('disconnect'), 1, 'one listener, whatever the number of ports');
});

test('reconnect() at page load and a print tapped meanwhile share one open() (Chrome refuses a second one)', async () => {
  const store = storage();
  const A = load({ ports: [port(USB)], store });
  await tap(A.nav, () => A.ser.pair());
  // Next visit: the page calls reconnect() at load; the person taps print before it is done.
  const same = port(USB);
  const B = load({ known: [same], store });
  const states = [];
  B.ser.on((i) => states.push(i.status));
  const loading = B.ser.reconnect();
  const printing = tap(B.nav, () => B.g.RawBT.printLayout({ blocks: [{ text: 'x' }] }));
  const [info, r] = await Promise.all([loading, printing]);
  assert.deepStrictEqual(same.opens, [{ baudRate: 9600 }], 'one open()');
  assert.strictEqual(info.connected, true);
  assert.deepStrictEqual([r.ok, r.via, r.reason], [true, 'serial', 'serial-remembered']);
  assert.ok(same.writes.length > 0);
  assert.strictEqual(B.nav.requests.length, 0, 'no chooser');
  assert.ok(states.indexOf('error') < 0, states.join(' '));
  // The port known in this tab, closed: reconnect() and print() at once, still one open().
  await B.ser.disconnect();
  const again = B.ser.reconnect();
  const p = B.ser.print(data(10));
  const [i2, r2] = await Promise.all([again, p]);
  assert.deepStrictEqual([i2.connected, r2.ok], [true, true]);
  assert.deepStrictEqual(same.opens, [{ baudRate: 9600 }, { baudRate: 9600 }]);
  assert.ok(states.indexOf('error') < 0, states.join(' '));
  // Once settled, the next open() is a new one (nothing left in progress).
  await B.ser.disconnect();
  assert.ok((await B.ser.print(data(3))).ok);
  assert.strictEqual(same.opens.length, 3);
});

test('unplugged while open() is in progress: its late failure or success leaves "disconnected"; a port opened too late is closed', async () => {
  // pair(): the disconnect event, then open() fails.
  const p1 = port(USB, { hold: true });
  const A = load({ ports: [p1] });
  const states = [];
  A.ser.on((i) => states.push(i.status));
  const pairing = tap(A.nav, () => A.ser.pair());
  await tick();
  assert.ok(p1.held, 'open() in progress');
  p1.unplug();
  p1.held.reject(dom('NetworkError', 'Failed to open serial port.'));
  const e = await rejects(pairing);
  assert.deepStrictEqual([e.code, e.message], ['open', 'Failed to open serial port.']);
  assert.deepStrictEqual(states, ['connecting', 'disconnected']);
  assert.deepStrictEqual([A.ser.info().status, A.ser.info().paired, A.ser.info().remembered, A.ser.info().lastError],
    ['disconnected', false, true, null]);
  // Plugged in again: found without a chooser.
  const back = A.nav.replug(USB);
  assert.strictEqual((await A.ser.reconnect()).status, 'ready');
  assert.deepStrictEqual([back.opens.length, A.nav.requests.length], [1, 1]);
  // reconnect() at page load: the disconnect event, then open() succeeds anyway.
  const p2 = port(USB, { hold: true });
  const B = load({ known: [p2], store: remembered(USB) });
  const seen = [];
  B.ser.on((i) => seen.push(i.status));
  const loading = B.ser.reconnect();
  await tick();
  p2.unplug();
  p2.held.resolve();
  const e2 = await rejects(loading);
  assert.deepStrictEqual([e2.code, B.ser.explain(e2)], ['closed', B.T.en.explainSerialLost]);
  assert.deepStrictEqual(seen, ['connecting', 'disconnected']);
  assert.deepStrictEqual([B.ser.info().status, B.ser.info().lastError], ['disconnected', null]);
  assert.deepStrictEqual([p2.closes, p2.writable], [1, null], 'the port that opened too late is closed');
});

test('an open() that settles after its port was replaced or forgotten: the status of the current port stays', async () => {
  // reconnect() opens port a; meanwhile pair() gets port b, which opens. a then fails or opens.
  for (const late of ['reject', 'resolve']) {
    const a = port(USB, { hold: true }), b = port(USB2);
    const L = load({ known: [a], ports: [b], store: remembered(USB) });
    const loading = L.ser.reconnect();
    await tick();
    const info = await tap(L.nav, () => L.ser.pair());
    assert.deepStrictEqual([info.status, info.label], ['ready', 'USB 1A86:7523'], late);
    if (late === 'reject') a.held.reject(dom('NetworkError', 'Failed to open serial port.'));
    else a.held.resolve();
    const e = await rejects(loading);
    assert.strictEqual(e.code, late === 'reject' ? 'open' : 'closed', late);
    const i = L.ser.info();
    assert.deepStrictEqual([i.status, i.connected, i.label, i.lastError], ['ready', true, 'USB 1A86:7523', null], late);
    assert.strictEqual(a.writable, null, late + ': port a is not left open');
    assert.ok((await L.ser.print(data(5))).ok);
    assert.deepStrictEqual(delivered(b), Array.from(data(5)));
  }
  // forget() while reconnect() is opening the port: idle stays, the port opened late is closed.
  const p = port(USB, { hold: true });
  const F = load({ known: [p], store: remembered(USB) });
  const seen = [];
  F.ser.on((i) => seen.push(i.status));
  const loading = F.ser.reconnect();
  await tick();
  await F.ser.forget();
  assert.strictEqual(p.forgotten, true);
  p.held.resolve();
  assert.strictEqual((await rejects(loading)).code, 'closed');
  assert.deepStrictEqual(seen, ['connecting', 'disconnected', 'idle']);
  assert.deepStrictEqual(F.ser.info(), IDLE);
  assert.deepStrictEqual([p.closes, p.writable], [1, null]);
});

test('open() refused because the port was opened meanwhile (InvalidStateError, streams there): ready', async () => {
  // Another script of the page opens the port while ours is being opened.
  const p1 = port(USB, {
    openFail: (n) => {
      if (n !== 2) return null;
      p1.writable = stream(p1);
      p1.readable = {};
      return dom('InvalidStateError', "Failed to execute 'open' on 'SerialPort': The port is already open.");
    }
  });
  const { ser, nav } = load({ ports: [p1] });
  await tap(nav, () => ser.pair());
  await ser.disconnect();
  const r = await ser.reconnect();
  assert.deepStrictEqual([r.status, r.connected, r.lastError], ['ready', true, null]);
  assert.ok((await ser.print(data(3))).ok);
  // Refused for another reason: an open error.
  const p2 = port(USB, { openFail: () => dom('InvalidStateError', 'A call to open() is already in progress.') });
  const B = load({ ports: [p2] });
  const e = await rejects(tap(B.nav, () => B.ser.pair()));
  assert.deepStrictEqual([e.code, B.ser.info().status, B.ser.info().lastError], ['open', 'error', 'A call to open() is already in progress.']);
});

// ---------------------------------------------------------------- speed, disconnect, forget

test('setBaudRate(): validated, kept; the port closes after the queued print and reopens at the new speed', async () => {
  const p1 = port(USB, { latency: 2 });
  const { ser, nav, log } = load({ ports: [p1] });
  await tap(nav, () => ser.pair());
  for (const bad of [1234, 'fast', null]) {
    const e = await rejects(ser.setBaudRate(bad));
    assert.deepStrictEqual([e.code, e.message], ['baud', BAD_BAUD], String(bad));
  }
  assert.deepStrictEqual([p1.closes, ser.info().baudRate, ser.info().status], [0, 9600, 'ready']);
  log.length = 0;
  const printing = ser.print(data(600));
  const setting = ser.setBaudRate('115200');
  const [r, b] = await Promise.all([printing, setting]);
  assert.ok(r.ok);
  assert.strictEqual(b, 115200);
  assert.deepStrictEqual(log.filter((x) => /^(w|close)/.test(x)), ['w256', 'w256', 'w88', 'close'], 'closed after the print');
  assert.deepStrictEqual([ser.info().status, ser.info().connected, ser.info().baudRate, ser.saved().baudRate],
    ['disconnected', false, 115200, 115200]);
  await ser.print(data(10));
  assert.deepStrictEqual(p1.opens, [{ baudRate: 9600 }, { baudRate: 115200 }]);
  assert.strictEqual(ser.info().status, 'ready');
  for (const ok of BAUDS) assert.strictEqual(await ser.setBaudRate(ok), ok);
  // Without a port the speed is kept for the next one.
  const B = load();
  assert.strictEqual(await B.ser.setBaudRate(38400), 38400);
  assert.strictEqual(B.ser.info().baudRate, 38400);
});

test('disconnect(): closes the port and keeps it chosen; reconnect() reopens it without a chooser', async () => {
  const p1 = port(USB);
  const { ser, nav } = load({ ports: [p1] });
  assert.strictEqual(await ser.disconnect(), null, 'nothing to close');
  await tap(nav, () => ser.pair());
  await ser.disconnect();
  assert.strictEqual(p1.closes, 1);
  const i = ser.info();
  assert.deepStrictEqual([i.status, i.paired, i.connected, i.remembered], ['disconnected', true, false, true]);
  await ser.disconnect();
  assert.strictEqual(p1.closes, 1, 'already closed');
  const info = await ser.reconnect();
  assert.deepStrictEqual([info.status, info.connected], ['ready', true]);
  assert.deepStrictEqual([nav.requests.length, nav.getPortsCalls], [1, 0], 'the port of this page, no chooser, no getPorts');
});

test('forget(): closes the port, clears the saved one, calls port.forget, back to idle', async () => {
  const store = storage();
  const p1 = port(USB);
  const { ser, nav } = load({ ports: [p1], store });
  await tap(nav, () => ser.pair({ baudRate: 38400 }));
  await ser.forget();
  assert.deepStrictEqual([p1.closes, p1.forgotten], [1, true]);
  assert.strictEqual(ser.saved(), null);
  assert.strictEqual(store.getItem('printbridge.serial'), null);
  assert.deepStrictEqual(ser.info(), IDLE);
  assert.strictEqual((await rejects(ser.print(data(5)))).code, 'no-port');
  assert.strictEqual(await ser.reconnect(), null, 'Chrome no longer allows the port');
  // A browser without SerialPort.forget(), or one where it fails: forget() still works.
  for (const f of [undefined, () => Promise.reject(new Error('not allowed'))]) {
    const p2 = port(USB);
    if (f) p2.forget = f; else delete p2.forget;
    const B = load({ ports: [p2] });
    await tap(B.nav, () => B.ser.pair());
    await B.ser.forget();
    assert.deepStrictEqual([B.ser.saved(), B.ser.info().status, p2.closes], [null, 'idle', 1]);
  }
});

test('forget() of a printer that is unplugged or not open yet: its permission is revoked too, and reconnect() does not take it back', async () => {
  // Paired, then unplugged: the dropped port is forgotten too. Plugged in again, it is the only
  // port Chrome lists, and reconnect() does not take it.
  const p1 = port(USB);
  const A = load({ ports: [p1] });
  await tap(A.nav, () => A.ser.pair());
  p1.unplug();
  assert.strictEqual(A.ser.info().status, 'disconnected');
  await A.ser.forget();
  assert.deepStrictEqual([p1.forgotten, A.ser.saved(), A.store.getItem('printbridge.serial.forgotten')], [true, null, '1']);
  assert.deepStrictEqual(A.ser.info(), IDLE);
  const back = A.nav.replug(USB);
  assert.strictEqual(await A.ser.reconnect(), null, 'the only port listed is not taken after forget()');
  assert.deepStrictEqual([back.opens.length, A.ser.info().paired], [0, false]);
  // A reload with the printer unplugged: remembered, not open. forget(), then plugged in and
  // reloaded: not taken either.
  const store = remembered(USB);
  const B = load({ store });
  assert.strictEqual(B.ser.info().remembered, true);
  await B.ser.forget();
  assert.deepStrictEqual([B.ser.info().remembered, store.getItem('printbridge.serial')], [false, null]);
  const C = load({ known: [port(USB)], store });
  assert.strictEqual(await C.ser.reconnect(), null);
  assert.strictEqual(C.ser.info().paired, false);
  // A reload with the printer plugged in, before any reconnect(): the port Chrome lists for the
  // saved printer is forgotten (getPorts), not the other one.
  const same = port(USB), other = port(USB2);
  const D = load({ known: [other, same], store: remembered(USB, 19200) });
  await D.ser.forget();
  assert.deepStrictEqual([same.forgotten, other.forgotten, D.nav.getPortsCalls], [true, false, 1]);
  assert.deepStrictEqual(D.nav.known, [other]);
  // A port chosen again ends it: at the next visit the only port listed is taken again.
  const E = load({ ports: [port(USB2)], store });
  await tap(E.nav, () => E.ser.pair());
  assert.strictEqual(store.getItem('printbridge.serial.forgotten'), null);
  const G = load({ known: [port(USB)], store });
  assert.strictEqual((await G.ser.reconnect()).label, 'USB 0416:5011', 'the only port, as before forget()');
});

test('explain(): every code (English)', async () => {
  const { ser, T } = load();
  const LOST = 'The serial port was closed or unplugged: plug the printer in (or turn it on) and press "Reconnect".';
  const cases = [
    [{ code: 'unsupported', message: 'x' }, T.en.serialUnsupported],
    [{ code: 'open', message: 'Failed to open serial port.' }, 'The serial port could not be opened (Failed to open serial port.): another program may be using it (close it), or the printer is off or unplugged.'],
    [{ code: 'no-port', message: 'x' }, LOST],
    [{ code: 'closed', message: 'x' }, LOST],
    [{ code: 'write', message: 'Buffer overrun.' }, 'Error while sending to the serial port (Buffer overrun.): print again; if it happens again, check the speed (baud rate) in the settings.'],
    [{ code: 'baud', message: BAD_BAUD }, BAD_BAUD],
    [dom('NotFoundError', CANCELLED), ''],
    [dom('SecurityError', NO_GESTURE), 'Choosing the printer needs a tap on a button.'],
    [dom('NetworkError', 'Failed to open serial port.'), 'Failed to open serial port.']
  ];
  for (const [e, want] of cases) assert.strictEqual(ser.explain(e), want, e.code || e.name);
});

test('on(): every status reaches the listener; the returned function removes it; a broken listener is harmless', async () => {
  const p1 = port(USB);
  const { ser, nav } = load({ ports: [p1] });
  const seen = [];
  const off = ser.on((i) => seen.push([i.status, i.connected]));
  await tap(nav, () => ser.pair());
  await ser.print(data(10));
  off();
  await ser.print(data(10));
  assert.deepStrictEqual(seen, [['connecting', false], ['ready', true], ['printing', true], ['ready', true]]);
  ser.on(() => { throw new Error('page bug'); });
  assert.ok((await ser.print(data(3))).ok);
});

// ---------------------------------------------------------------- via 'serial'

test('chooseVia(): a port open in this tab (serial-open), a port from an earlier visit (serial-remembered)', async () => {
  const store = storage();
  const A = load({ ports: [port(USB)], store });
  const C = (o) => A.g.RawBT.chooseVia(o);
  assert.deepStrictEqual(C(), { via: 'app', reason: 'default', needsPairing: false });
  await tap(A.nav, () => A.ser.pair());
  assert.deepStrictEqual(C(), { via: 'serial', reason: 'serial-open', needsPairing: false });
  A.g.RawBT.lastCheck = { ok: true };
  assert.deepStrictEqual(C(), { via: 'serial', reason: 'serial-open', needsPairing: false }, 'an open port comes before the app');
  await A.ser.disconnect();
  assert.deepStrictEqual(C(), { via: 'app', reason: 'app-ok', needsPairing: false }, 'a closed port comes after the app');
  A.g.RawBT.lastCheck = null;
  assert.deepStrictEqual(C(), { via: 'serial', reason: 'serial-remembered', needsPairing: false }, 'chosen in this tab: reopened at the print');
  // A BLE printer paired in this tab comes before an open port.
  const open = load({ ports: [port(USB)] });
  await tap(open.nav, () => open.ser.pair());
  stubBle(open.g, { paired: true });
  assert.deepStrictEqual(open.g.RawBT.chooseVia(), { via: 'ble', reason: 'paired', needsPairing: false });
  // Next visit: the saved port; a BLE printer from an earlier visit comes first.
  const B = load({ known: [port(USB)], store });
  assert.deepStrictEqual(B.g.RawBT.chooseVia(), { via: 'serial', reason: 'serial-remembered', needsPairing: true });
  stubBle(B.g, { remembered: true });
  assert.deepStrictEqual(B.g.RawBT.chooseVia(), { via: 'ble', reason: 'remembered', needsPairing: true });
  // The preference and the option.
  assert.strictEqual(B.g.RawBT.setVia('serial'), 'serial');
  assert.strictEqual(store.getItem('printbridge.via'), 'serial');
  assert.deepStrictEqual(B.g.RawBT.chooseVia(), { via: 'serial', reason: 'preference', needsPairing: true });
  B.g.RawBT.setVia('auto');
  assert.deepStrictEqual(B.g.RawBT.chooseVia({ via: 'serial' }), { via: 'serial', reason: 'option', needsPairing: true });
  // Without Web Serial a saved port does not count.
  const D = load({ serial: false, store });
  assert.deepStrictEqual(D.g.RawBT.chooseVia(), { via: 'app', reason: 'default', needsPairing: false });
});

test('printLayout via serial: requestPort in the same call, the bytes of render, normalized result', async () => {
  const p1 = port(USB);
  const { g, nav, PB } = load({ ports: [p1] });
  const lay = { blocks: [{ text: 'Hello {{n}}' }, { cut: true }] };
  const expected = Array.from(await PB.render(lay, { n: 'Ada' }));
  const prog = [];
  const pr = tap(nav, () => g.RawBT.printLayout(lay, { n: 'Ada' }, { via: 'serial', onProgress: (s, t) => prog.push([s, t]) }));
  assert.strictEqual(nav.requests.length, 1, 'requestPort must be called synchronously, before the layout is rendered');
  assert.strictEqual(nav.requests[0].sync, true);
  const r = await pr;
  assert.deepStrictEqual(Object.keys(r).sort(), ['bytes', 'ms', 'ok', 'reason', 'result', 'via']);
  assert.deepStrictEqual([r.ok, r.via, r.reason, r.bytes], [true, 'serial', 'option', expected.length]);
  assert.deepStrictEqual([r.result.ok, r.result.bytes, r.result.chunk], [true, expected.length, 256]);
  assert.deepStrictEqual(delivered(p1), expected);
  assert.deepStrictEqual(prog[prog.length - 1], [expected.length, expected.length]);
  // Auto with the port open in this tab: no chooser.
  p1.writes.length = 0;
  const r2 = await g.RawBT.printLayout(lay, { n: 'Bo' });
  assert.deepStrictEqual([r2.ok, r2.via, r2.reason], [true, 'serial', 'serial-open']);
  assert.strictEqual(nav.requests.length, 1);
  assert.deepStrictEqual(delivered(p1), Array.from(await PB.render(lay, { n: 'Bo' })));
  // A long receipt: 256-byte chunks, nothing lost.
  p1.writes.length = 0;
  const many = { blocks: Array.from({ length: 40 }, (x, i) => ({ text: 'line ' + i + ' ' + '.'.repeat(24) })) };
  const want = Array.from(await PB.render(many, {}));
  assert.ok(want.length > 1024);
  const r3 = await g.RawBT.printLayout(many, {});
  assert.ok(r3.ok);
  assert.deepStrictEqual(delivered(p1), want);
  assert.ok(p1.writes.every((w) => w.length <= 256));
});

test('printLayout auto with a port from an earlier visit: getPorts, no chooser, no tap needed', async () => {
  const store = storage();
  const A = load({ ports: [port(USB)], store });
  await tap(A.nav, () => A.ser.pair({ baudRate: 57600 }));
  const same = port(USB);
  const B = load({ known: [same], store });
  const r = await B.g.RawBT.printLayout({ blocks: [{ text: 'x' }] });
  assert.deepStrictEqual([r.ok, r.via, r.reason], [true, 'serial', 'serial-remembered']);
  assert.strictEqual(B.nav.requests.length, 0);
  assert.deepStrictEqual(same.opens, [{ baudRate: 57600 }]);
  assert.ok(same.writes.length > 0);
  // The saved port is no longer allowed and two others are: the chooser opens, still within the
  // tap (getPorts answers at once).
  const fresh = port(USB);
  const C = load({ known: [port(USB2), port({ usbVendorId: 1, usbProductId: 1 })], ports: [fresh], store });
  store.setItem('printbridge.serial', JSON.stringify({ info: { usbVendorId: 9, usbProductId: 9 } }));
  const r3 = await tap(C.nav, () => C.g.RawBT.printLayout({ blocks: [{ text: 'x' }] }));
  assert.deepStrictEqual([r3.ok, r3.via, r3.reason], [true, 'serial', 'serial-remembered']);
  assert.strictEqual(C.nav.requests.length, 1);
  assert.ok(fresh.writes.length > 0);
});

test('printLayout via serial never rejects: chooser closed, outside a tap, port that does not open, write error, no Web Serial', async () => {
  const x = { blocks: [{ text: 'x' }] };
  let L = load({ ports: [] });
  let r = await tap(L.nav, () => L.g.RawBT.printLayout(x, {}, { via: 'serial' }));
  assert.deepStrictEqual([r.ok, r.cancelled, r.via, r.code, r.error], [false, true, 'serial', 'NotFoundError', 'Port selection cancelled']);
  L = load({ ports: [port(USB)] });
  r = await L.g.RawBT.printLayout(x, {}, { via: 'serial' });
  assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'SecurityError', 'Choosing the printer needs a tap on a button.']);
  const busy = port(USB, { openFail: () => dom('NetworkError', 'Failed to open serial port.') });
  L = load({ ports: [busy] });
  r = await tap(L.nav, () => L.g.RawBT.printLayout(x, {}, { via: 'serial' }));
  assert.deepStrictEqual([r.ok, r.via, r.code], [false, 'serial', 'open']);
  assert.strictEqual(r.error, L.ser.explain(r.cause));
  assert.ok(/another program may be using it/.test(r.error), r.error);
  const broken = port(USB, { fail: () => dom('NetworkError', 'The device has been lost.') });
  L = load({ ports: [broken] });
  r = await tap(L.nav, () => L.g.RawBT.printLayout(x, {}, { via: 'serial' }));
  assert.deepStrictEqual([r.ok, r.via, r.code], [false, 'serial', 'write']);
  assert.ok(r.bytes > 0);
  assert.strictEqual(r.error, L.ser.explain(r.cause));
  L = load({ serial: false });
  r = await L.g.RawBT.printLayout(x, {}, { via: 'serial' });
  assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'unsupported', L.T.en.serialUnsupported]);
});

test('printCanvas via serial: the escpos driver (auto or given), the bytes of encodeImage, the chooser in the same call', async () => {
  const p1 = port(USB);
  const { g, PB, nav } = load({ ports: [p1] });
  const px = pixels(8, 1, () => BLACK);
  const pr = tap(nav, () => g.RawBT.printCanvas(px, { via: 'serial', dither: 'threshold' }));
  assert.strictEqual(nav.requests.length, 1, 'requestPort must be called synchronously');
  assert.strictEqual(nav.requests[0].sync, true);
  const r = await pr;
  assert.deepStrictEqual([r.ok, r.via, r.reason, r.driver, r.bytes, r.rows], [true, 'serial', 'option', 'escpos', 2 + 8 + 48 + 3, 1]);
  assert.deepStrictEqual(delivered(p1), Array.from(PB.encodeImage(px, 'escpos', { dither: 'threshold' }).bytes));
  assert.deepStrictEqual(delivered(p1).slice(0, 2), [0x1B, 0x40]);
  // Driver given, wider paper, a cut; auto via: the open port, many chunks.
  p1.writes.length = 0;
  const wide = pixels(576, 40, (x, y) => ((x + y) % 3 ? WHITE : BLACK));
  const r2 = await g.RawBT.printCanvas(wide, { driver: 'escpos', width: 576, cut: true });
  const want = Array.from(PB.encodeImage(wide, 'escpos', { width: 576, cut: true }).bytes);
  assert.deepStrictEqual([r2.ok, r2.via, r2.reason, r2.driver, r2.rows, r2.bytes], [true, 'serial', 'serial-open', 'escpos', 40, want.length]);
  assert.deepStrictEqual(delivered(p1), want);
  assert.ok(p1.writes.length > 10 && p1.writes.every((w) => w.length <= 256));
  assert.strictEqual(nav.requests.length, 1);
});

test('printCanvas: a Phomemo driver with via serial is refused (no chooser, nothing written)', async () => {
  const p1 = port(USB);
  const { g, nav } = load({ ports: [p1] });
  const px = pixels(8, 1, () => BLACK);
  for (const driver of ['phomemo-m02pro', 'phomemo-m02']) {
    const r = await tap(nav, () => g.RawBT.printCanvas(px, { driver, via: 'serial' }));
    assert.deepStrictEqual([r.ok, r.code, r.via, r.driver], [false, 'via', null, driver]);
    assert.strictEqual(r.error, g.PrintBridge.drivers[driver].label + ' prints only over Bluetooth LE, not over a serial port');
  }
  // A driver object with its own transport is refused the same way.
  const mine = Object.assign({}, g.PrintBridge.drivers['phomemo-m02'], { id: 'mine', label: 'Mine' });
  const r2 = await tap(nav, () => g.RawBT.printCanvas(px, { driver: mine, via: 'serial' }));
  assert.deepStrictEqual([r2.ok, r2.code, r2.error], [false, 'via', 'Mine prints only over Bluetooth LE, not over a serial port']);
  assert.deepStrictEqual([nav.requests.length, p1.writes.length, p1.opens.length], [0, 0, 0]);
  // The serial port as the preferred way: a Phomemo driver still goes to Bluetooth LE.
  g.RawBT.setVia('serial');
  const r3 = await tap(nav, () => g.RawBT.printCanvas(px, { driver: 'phomemo-m02pro' }));
  assert.deepStrictEqual([r3.ok, r3.via, r3.reason], [false, 'ble', 'driver']);
  assert.strictEqual(r3.error, 'Phomemo M02 Pro prints only over Web Bluetooth: use Chrome on Android or on a computer');
  assert.strictEqual(nav.requests.length, 0, 'never the port chooser');
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
