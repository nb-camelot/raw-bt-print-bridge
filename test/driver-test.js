// Tests of the printer drivers in escpos.js: PrintBridge.toBitmap, driverFor, encodeImage, the
// paced driver writes of RawBT.ble (a fake Phomemo with notifications on FF03), phomemoStatus and
// RawBT.printCanvas. No printer and no canvas: a fake navigator.bluetooth, a fake OffscreenCanvas
// and timers sped up. Every library timer and every GATT write goes to one log, so pauses,
// credits and waits are checked in the order they happen.
// Usage: node test/driver-test.js escpos.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const DOC = path.join(__dirname, '..', 'docs', 'phomemo-m02.md');

const U = (s) => '0000' + s + '-0000-1000-8000-00805f9b34fb';
const SFF00 = U('ff00'), CFF01 = U('ff01'), CFF02 = U('ff02'), CFF03 = U('ff03');
const S18F0 = U('18f0'), C2AF0 = U('2af0'), C2AF1 = U('2af1');
const SISSC = '49535343-fe7d-4ae5-8fa9-9fafd205e455', CISSC = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const CREDIT = [0x01, 0x01], DONE = [0x1A, 0x0F, 0x0C], HELLO = [0x02, 0xB6, 0x00];
const BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];
const DRIVER_IDS = 'escpos, phomemo-m02, phomemo-m02pro';
// Phomemo job head: ESC @, 1F 11 02 density, ESC a align.
const HEAD = (density, align) => [0x1B, 0x40, 0x1F, 0x11, 0x02, density, 0x1B, 0x61, align];
// The 164-byte example of docs/phomemo-m02.md: two black rows, 72 bytes per row, defaults.
const EXAMPLE = HEAD(4, 1).concat([0x1D, 0x76, 0x30, 0x00, 0x48, 0x00, 0x02, 0x00],
  new Array(144).fill(0xFF), [0x1B, 0x64, 0x03]);

function dom(name, msg) { return new DOMException(msg, name); }
const UNKNOWN = () => dom('NetworkError', 'GATT operation failed for unknown reason.');
function hex(bytes) { return Array.from(bytes).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join(''); }
function later(fn, ms) { setTimeout(fn, ms || 0); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(cond, what, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(1);
  }
}
async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('should have failed');
}
function layoutErr(fn) {
  try { fn(); } catch (e) { assert.strictEqual(e.name, 'PrintBridgeLayoutError', e.stack); return e; }
  throw new Error('should have thrown');
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

// --- Fake BLE device. services: { uuid: [[charUuid, props], ...] }. Service objects are the
// same on every call (like Chrome's attribute instance map). Every write is logged when it is
// called ('w' + length); frames sent on FF03 are logged as 'f' + hex. o.fail({ n, bytes }) may
// return an error for call n; o.onCall(w, dev) runs when a write is called, o.onWrite(w, dev)
// when it has been received; o.notify is the error startNotifications() rejects with, if any.
function device(opts) {
  const o = Object.assign({
    name: 'M02 Pro', id: 'dev-1', services: {}, latency: 1, fail: null, notify: null,
    onCall: null, onWrite: null, log: []
  }, opts);
  const listeners = {};
  const dev = {
    name: o.name, id: o.id, log: o.log, writes: [], calls: 0, inFlight: 0, overlap: 0, allowed: [],
    notifyStarts: 0, connectCalls: 0, forgotten: false,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatch(t) { (listeners[t] || []).slice().forEach((f) => f({ type: t, target: dev })); },
    forget() { dev.forgotten = true; return Promise.resolve(); }
  };
  function write(c, v, withResponse) {
    const n = dev.calls++;
    const bytes = Array.from(v);
    dev.log.push('w' + bytes.length);
    if (!dev.gatt.connected) return Promise.reject(dom('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.'));
    if (dev.inFlight > 0) dev.overlap++;
    dev.inFlight++;
    const w = { uuid: c.uuid, bytes, withResponse };
    const err = o.fail ? o.fail({ n, bytes, withResponse, uuid: c.uuid, dev }) : null;
    if (!err && o.onCall) o.onCall(w, dev);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        dev.inFlight--;
        if (err) return reject(err);
        dev.writes.push(w);
        if (o.onWrite) o.onWrite(w, dev);
        resolve();
      }, o.latency);
    });
  }
  function makeChar(uuid, props) {
    const ls = [];
    const c = {
      uuid,
      properties: Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false }, props),
      value: null,
      notifying: false,
      writeValueWithResponse: (v) => write(c, v, true),
      writeValueWithoutResponse: (v) => write(c, v, false),
      startNotifications() {
        dev.notifyStarts++;
        if (!dev.gatt.connected) return Promise.reject(dom('NetworkError', 'GATT Server is disconnected.'));
        const e = typeof o.notify === 'function' ? o.notify(dev) : o.notify;
        if (e) return Promise.reject(e);
        c.notifying = true;
        return Promise.resolve(c);
      },
      // EventTarget semantics: the same listener twice is registered once.
      addEventListener(t, fn) { if (t === 'characteristicvaluechanged' && ls.indexOf(fn) < 0) ls.push(fn); },
      removeEventListener(t, fn) { const i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); },
      listenerCount: () => ls.length,
      fire(bytes) {
        c.value = new DataView(Uint8Array.from(bytes).buffer);
        ls.slice().forEach((fn) => fn({ type: 'characteristicvaluechanged', target: c }));
      }
    };
    return c;
  }
  const svcs = {};
  Object.keys(o.services).forEach((u) => {
    const chars = o.services[u].map(([cu, props]) => makeChar(cu, props));
    svcs[u] = {
      uuid: u,
      chars,
      getCharacteristic(cu) {
        const f = chars.find((x) => x.uuid === cu);
        return f ? Promise.resolve(f) : Promise.reject(dom('NotFoundError', 'No Characteristics matching UUID ' + cu + ' found in Service.'));
      },
      getCharacteristics() { return Promise.resolve(chars.slice()); }
    };
  });
  // Like Chrome: only the services declared in filters/optionalServices are visible.
  const visible = (u) => !!svcs[u] && dev.allowed.indexOf(u) >= 0;
  const server = {
    getPrimaryServices() { return Promise.resolve(Object.keys(svcs).filter(visible).map((u) => svcs[u])); },
    getPrimaryService(u) {
      return visible(u) ? Promise.resolve(svcs[u]) : Promise.reject(dom('NotFoundError', 'No Services matching UUID ' + u + ' found in Device.'));
    }
  };
  dev.char = (cu) => {
    for (const u of Object.keys(svcs)) {
      const f = svcs[u].chars.find((x) => x.uuid === cu);
      if (f) return f;
    }
    return null;
  };
  // A notification from the printer on FF03 (lost when notifications are not on).
  dev.emit = (bytes) => {
    dev.log.push('f' + hex(bytes));
    const c = dev.char(CFF03);
    if (c && c.notifying) c.fire(bytes);
  };
  dev.gatt = {
    connected: false,
    connect() {
      dev.connectCalls++;
      dev.gatt.connected = true;
      return Promise.resolve(server);
    },
    disconnect() {
      if (!dev.gatt.connected) return;
      dev.gatt.connected = false;
      Object.keys(svcs).forEach((u) => svcs[u].chars.forEach((c) => { c.notifying = false; }));
      dev.dispatch('gattserverdisconnected');
    }
  };
  return dev;
}

// A Phomemo M02 / M02 Pro: FF00 (FF01 read, FF02 write + write without response, FF03 notify)
// plus an ISSC serial service, which pairing picks first: the driver must switch to FF02.
// o.credits: "01 01" after each packet on FF02; o.hello: "02 B6 00" after the first packet;
// dev.expect(n): "1A 0F 0C" o.doneDelay ms after n more bytes have arrived on FF02.
function phomemo(opts = {}) {
  const o = Object.assign({ credits: true, hello: false, doneDelay: 15, onFF02: null }, opts);
  let received = 0, packets = 0;
  const doneAt = [];
  const dev = device(Object.assign({
    services: {
      [SISSC]: [[CISSC, { write: true, writeWithoutResponse: true }]],
      [SFF00]: [[CFF01, { read: true }], [CFF02, { write: true, writeWithoutResponse: true }], [CFF03, { notify: true }]]
    },
    onWrite(w, d) {
      if (w.uuid !== CFF02) return;
      packets++;
      received += w.bytes.length;
      if (o.hello && packets === 1) later(() => d.emit(HELLO));
      if (o.credits) later(() => d.emit(CREDIT));
      if (o.onFF02) o.onFF02(w, d);
      while (doneAt.length && received >= doneAt[0]) {
        doneAt.shift();
        later(() => d.emit(DONE), o.doneDelay);
      }
    }
  }, opts));
  dev.expect = (n) => { doneAt.push((doneAt.length ? doneAt[doneAt.length - 1] : received) + n); };
  return dev;
}

function netum(opts) {
  return device(Object.assign({
    name: 'BlueTooth Printer',
    services: { [S18F0]: [[C2AF0, { notify: true }], [C2AF1, { write: true, writeWithoutResponse: true }]] }
  }, opts));
}

// Fake OffscreenCanvas: records fillRect/drawImage, draws a source with nearest-neighbour
// sampling and source-over blending, and can be tainted (getImageData throws SecurityError).
function canvasKit() {
  const kit = { made: [], taint: false };
  kit.OffscreenCanvas = function (w, h) {
    this.width = w;
    this.height = h;
    this.ops = [];
    this.px = new Float64Array(w * h * 4);
    kit.made.push(this);
  };
  kit.OffscreenCanvas.prototype.getContext = function () {
    const cv = this;
    return {
      fillStyle: '#000',
      fillRect(x, y, w, h) {
        cv.ops.push(['fillRect', this.fillStyle, x, y, w, h]);
        const v = this.fillStyle === '#fff' ? 255 : 0;
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) cv.px.set([v, v, v, 255], (yy * cv.width + xx) * 4);
        }
      },
      drawImage(s, x, y, w, h) {
        cv.ops.push(['drawImage', s, x, y, w, h]);
        const sw = s.naturalWidth || s.width, sh = s.naturalHeight || s.height;
        for (let ty = 0; ty < h; ty++) {
          for (let tx = 0; tx < w; tx++) {
            const p = s.pixel(Math.floor(tx * sw / w), Math.floor(ty * sh / h));
            const a = p[3] / 255, i = ((y + ty) * cv.width + x + tx) * 4;
            for (let k = 0; k < 3; k++) cv.px[i + k] = p[k] * a + cv.px[i + k] * (1 - a);
            cv.px[i + 3] = 255 * (a + (cv.px[i + 3] / 255) * (1 - a));
          }
        }
      },
      getImageData(x, y, w, h) {
        if (kit.taint) throw dom('SecurityError', 'The canvas has been tainted by cross-origin data.');
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i++) data[i] = Math.round(cv.px[i]);
        return { width: w, height: h, data };
      }
    };
  };
  return kit;
}

function load({ devices = [], store = storage(), scale = 50, log = null, canvas = null } = {}) {
  const nav = {
    requests: [],
    queue: devices.slice(),
    bluetooth: {
      requestDevice(options) {
        nav.requests.push(options);
        const d = nav.queue.shift();
        if (!d) return Promise.reject(dom('NotFoundError', 'User cancelled the requestDevice() chooser.'));
        d.allowed = (options.optionalServices || []).concat(
          (options.filters || []).flatMap((f) => f.services || []));
        return Promise.resolve(d);
      },
      getAvailability() { return Promise.resolve(true); }
    }
  };
  const g = { navigator: nav, localStorage: store, Promise, Date, JSON, AbortController };
  if (canvas) g.OffscreenCanvas = canvas.OffscreenCanvas;
  g.window = g;
  const L = log || (devices[0] && devices[0].log) || [];
  // Timers 'scale' times faster; each one is logged with the delay the library asked for.
  const fast = (fn, ms) => { L.push('t' + (ms || 0)); return setTimeout(fn, Math.max(0, (ms || 0) / scale)); };
  const noFetch = () => Promise.reject(new TypeError('Failed to fetch'));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'fetch', src)(g, undefined, fast, clearTimeout, noFetch);
  return { g, ble: g.RawBT.ble, PB: g.PrintBridge, nav, store, log: L };
}

// ImageData-like source: fn(x, y) -> [r, g, b, a] or a grey level.
function pixels(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let p = fn(x, y);
      if (typeof p === 'number') p = [p, p, p, 255];
      data.set(p, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
function data(n, seed = 7) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 0xFF;
  return a;
}
function sizes(dev, uuid) { return dev.writes.filter((w) => !uuid || w.uuid === uuid).map((w) => w.bytes.length); }
function delivered(dev, uuid) { return dev.writes.filter((w) => !uuid || w.uuid === uuid).flatMap((w) => w.bytes); }
// Writes and timers; the 10 s timer that bounds startNotifications (set before any write) is left out.
const wt = (log) => log.filter((e, i) => (e[0] === 'w' || e[0] === 't') && !(e === 't10000' && !log.slice(0, i).some((x) => x[0] === 'w')));
const nt = (log) => log.filter((e, i) => !(e === 't10000' && !log.slice(0, i).some((x) => x[0] === 'w')));
const count = (log, e) => log.filter((x) => x === e).length;
function transport(PB, extra) { return Object.assign({}, PB.drivers['phomemo-m02pro'].transport, extra); }
// One row of 'dots' with the dots from..to (inclusive) black, as bytes.
function row(dots, from, to) {
  const out = new Array(dots / 8).fill(0);
  for (let x = from; x <= to; x++) out[x >> 3] |= 0x80 >> (x & 7);
  return out;
}

// Splits a job into the bytes before the first GS v 0, the GS v 0 blocks and the bytes after.
function parseJob(bytes) {
  bytes = Array.from(bytes);
  const r = { head: [], blocks: [], tail: [] };
  for (let i = 0; i < bytes.length;) {
    if (bytes[i] === 0x1D && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const bpr = bytes[i + 4] + (bytes[i + 5] << 8), rows = bytes[i + 6] + (bytes[i + 7] << 8);
      r.blocks.push({ at: i, header: bytes.slice(i, i + 8), mode: bytes[i + 3], bpr, rows, data: bytes.slice(i + 8, i + 8 + bpr * rows) });
      i += 8 + bpr * rows;
    } else {
      (r.blocks.length ? r.tail : r.head).push(bytes[i]);
      i++;
    }
  }
  return r;
}

// Independent reference of the bitmap: luma, alpha on white, threshold or Floyd-Steinberg
// (7/16 right, 3/16 below left, 5/16 below, 1/16 below right), MSB first, 1 = black.
function reference(px, dots, { dither = 'floyd-steinberg', threshold = 128, align = 'center' } = {}) {
  const w = px.width, h = px.height, d = px.data;
  const x0 = align === 'left' ? 0 : align === 'right' ? dots - w : Math.floor((dots - w) / 2);
  const bpr = dots / 8, out = new Uint8Array(bpr * h), gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3];
    gray[i] = ((0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (255 - a)) / 255;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x, v = gray[k], black = v < threshold;
      if (black) out[y * bpr + ((x0 + x) >> 3)] |= 0x80 >> ((x0 + x) & 7);
      if (dither !== 'floyd-steinberg') continue;
      const e = v - (black ? 0 : 255);
      if (x + 1 < w) gray[k + 1] += e * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) gray[k + w - 1] += e * 3 / 16;
        gray[k + w] += e * 5 / 16;
        if (x + 1 < w) gray[k + w + 1] += e / 16;
      }
    }
  }
  return out;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ---------------------------------------------------------------- toBitmap

test('toBitmap: MSB first, 1 = black, one bit per dot, shape of the result', async () => {
  const { PB } = load();
  const bm = PB.toBitmap(pixels(16, 2, (x, y) => ((y === 0 && (x === 0 || x === 9)) || (y === 1 && x === 7) ? BLACK : WHITE)), { width: 16, dither: 'threshold' });
  assert.strictEqual(bm.width, 16);
  assert.strictEqual(bm.height, 2);
  assert.strictEqual(bm.bytesPerRow, 2);
  assert.ok(bm.data instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(bm.data), [0x80, 0x40, 0x01, 0x00]);
});

test('toBitmap: alpha composited on white (alpha 128 -> grey 127 black, alpha 127 -> 128 white)', async () => {
  const { PB } = load();
  const px = pixels(8, 1, (x) => [[0, 0, 0, 128], [0, 0, 0, 127], [0, 0, 0, 0], BLACK, [255, 255, 255, 0], [0, 0, 0, 255], [10, 10, 10, 1], WHITE][x]);
  const bm = PB.toBitmap(px, { width: 8, dither: 'threshold' });
  assert.deepStrictEqual(Array.from(bm.data), [0b10010100]);
  // Fully transparent black is paper, also with Floyd-Steinberg.
  const clear = PB.toBitmap(pixels(8, 2, () => [0, 0, 0, 0]), { width: 8 });
  assert.deepStrictEqual(Array.from(clear.data), [0, 0]);
});

test('toBitmap: threshold mode, threshold option, luma 0.299/0.587/0.114', async () => {
  const { PB } = load();
  // Grey 100 everywhere: all black with a threshold.
  assert.deepStrictEqual(Array.from(PB.toBitmap(pixels(8, 2, () => 100), { width: 8, dither: 'threshold' }).data), [0xFF, 0xFF]);
  // Grey 150: white at the default 128, black at 160.
  assert.deepStrictEqual(Array.from(PB.toBitmap(pixels(8, 1, () => 150), { width: 8, dither: 'threshold' }).data), [0x00]);
  assert.deepStrictEqual(Array.from(PB.toBitmap(pixels(8, 1, () => 150), { width: 8, dither: 'threshold', threshold: 160 }).data), [0xFF]);
  // Pure red is 0.299 * 255 = 76 (black), pure green 150 (white), pure blue 29 (black).
  const rgb = pixels(8, 1, (x) => [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][x % 3]);
  assert.deepStrictEqual(Array.from(PB.toBitmap(rgb, { width: 8, dither: 'threshold' }).data), [0b10110110]);
});

test('toBitmap: Floyd-Steinberg on known inputs (hand-computed) and against a reference', async () => {
  const { PB } = load();
  // One row of grey 100: 100 B, 143.75 W, 51.33 B, 122.46 B, 153.57 W, 55.63 B, 124.34 B, 154.40 W.
  assert.deepStrictEqual(Array.from(PB.toBitmap(pixels(8, 1, () => 100), { width: 8, align: 'left' }).data), [0xB6]);
  assert.deepStrictEqual(Array.from(PB.toBitmap(pixels(8, 1, () => 100)).data.slice(23, 25)), [0x0B, 0x60], 'centred in 384 dots: 188-195');
  // 2 x 2 of grey 100: a = 100 B; b = 143.75 W; c = 100 + 31.25 - 20.86 = 110.39 B;
  // d = 100 + 6.25 - 34.77 + 48.30 = 119.78 B. Needs all four weights.
  assert.deepStrictEqual(Array.from(PB.toBitmap(pixels(2, 2, () => 100), { width: 8, align: 'left' }).data), [0x80, 0xC0]);
  // Default dither is Floyd-Steinberg: the same as asking for it.
  const px = pixels(16, 8, (x, y) => (x * 37 + y * 91 + x * y * 13) % 256);
  const fs = PB.toBitmap(px, { width: 32, dither: 'floyd-steinberg', align: 'right' });
  assert.deepStrictEqual(Array.from(PB.toBitmap(px, { width: 32, align: 'right' }).data), Array.from(fs.data));
  assert.deepStrictEqual(Array.from(fs.data), Array.from(reference(px, 32, { align: 'right' })));
  const th = PB.toBitmap(px, { width: 32, dither: 'threshold', threshold: 90, align: 'left' });
  assert.deepStrictEqual(Array.from(th.data), Array.from(reference(px, 32, { dither: 'threshold', threshold: 90, align: 'left' })));
  assert.notDeepStrictEqual(Array.from(fs.data), Array.from(PB.toBitmap(px, { width: 32, dither: 'threshold', align: 'right' }).data));
});

test('toBitmap: centre (default), left and right alignment of a narrower image', async () => {
  const { PB } = load();
  const px = pixels(3, 1, () => BLACK);
  assert.deepStrictEqual(Array.from(PB.toBitmap(px, { width: 16 }).data), [0x03, 0x80], 'centre: dots 6-8');
  assert.deepStrictEqual(Array.from(PB.toBitmap(px, { width: 16, align: 'center' }).data), [0x03, 0x80]);
  assert.deepStrictEqual(Array.from(PB.toBitmap(px, { width: 16, align: 'left' }).data), [0xE0, 0x00]);
  assert.deepStrictEqual(Array.from(PB.toBitmap(px, { width: 16, align: 'right' }).data), [0x00, 0x07]);
  // Default width 384 dots.
  const bm = PB.toBitmap(px);
  assert.strictEqual(bm.width, 384);
  assert.deepStrictEqual(Array.from(bm.data), row(384, 190, 192));
});

test('toBitmap: errors (ImageData wider than the paper, bad width, dither, align, image)', async () => {
  const { PB } = load();
  let e = layoutErr(() => PB.toBitmap(pixels(400, 1, () => BLACK)));
  assert.strictEqual(e.code, 'image');
  assert.strictEqual(e.message, 'The image is 400 dots wide and the paper 384: pass a canvas or an image (they are scaled down) or ImageData no wider than the paper');
  e = layoutErr(() => PB.toBitmap(pixels(17, 1, () => BLACK), { width: 16 }));
  assert.ok(/17 dots wide and the paper 16/.test(e.message));
  PB.toBitmap(pixels(16, 1, () => BLACK), { width: 16 });
  [0, 4, 12, 100, 2056, 'abc', -8].forEach((w) => {
    const x = layoutErr(() => PB.toBitmap(pixels(8, 1, () => BLACK), { width: w }));
    assert.strictEqual(x.code, 'image', String(w));
    assert.strictEqual(x.message, 'width must be a multiple of 8, from 8 to 2048 dots');
  });
  assert.strictEqual(PB.toBitmap(pixels(8, 1, () => BLACK), { width: 2048 }).bytesPerRow, 256);
  e = layoutErr(() => PB.toBitmap(pixels(8, 1, () => BLACK), { dither: 'atkinson' }));
  assert.strictEqual(e.code, 'image');
  assert.strictEqual(e.message, 'dither must be "floyd-steinberg" or "threshold"');
  e = layoutErr(() => PB.toBitmap(pixels(8, 1, () => BLACK), { align: 'middle' }));
  assert.strictEqual(e.code, 'image');
  assert.strictEqual(e.message, 'image: align must be left, center or right');
  [null, undefined, {}, { width: 0, height: 4 }, 42].forEach((s) => {
    const x = layoutErr(() => PB.toBitmap(s));
    assert.strictEqual(x.code, 'image');
    assert.strictEqual(x.message, 'Invalid image: use a canvas, an image, an ImageBitmap or ImageData');
  });
});

test('toBitmap: drawables go on a white canvas, scaled down to the paper, never up', async () => {
  const kit = canvasKit();
  const { PB } = load({ canvas: kit });
  // ImageBitmap-like, 768 x 4, left half black: drawn at 384 x 2.
  const big = { width: 768, height: 4, pixel: (x) => (x < 384 ? BLACK : WHITE) };
  let bm = PB.toBitmap(big);
  assert.strictEqual(kit.made.length, 1);
  assert.deepStrictEqual([kit.made[0].width, kit.made[0].height], [384, 2]);
  assert.deepStrictEqual(kit.made[0].ops, [['fillRect', '#fff', 0, 0, 384, 2], ['drawImage', big, 0, 0, 384, 2]]);
  assert.deepStrictEqual([bm.width, bm.height], [384, 2]);
  assert.deepStrictEqual(Array.from(bm.data), row(384, 0, 191).concat(row(384, 0, 191)));
  // 100 x 10 is not scaled up: drawn at 100 x 10 and centred in 384 dots (142-241).
  const small = { width: 100, height: 10, pixel: () => BLACK };
  bm = PB.toBitmap(small, { dither: 'threshold' });
  assert.deepStrictEqual(kit.made[1].ops[1], ['drawImage', small, 0, 0, 100, 10]);
  assert.strictEqual(bm.height, 10);
  assert.deepStrictEqual(Array.from(bm.data.slice(0, 48)), row(384, 142, 241));
  // An image element uses its natural size: 1000 x 500 -> 384 x 192.
  const el = { naturalWidth: 1000, naturalHeight: 500, width: 10, height: 5, pixel: () => WHITE };
  bm = PB.toBitmap(el);
  assert.deepStrictEqual([kit.made[2].width, kit.made[2].height, bm.height], [384, 192, 192]);
  // Transparent pixels are paper; half-transparent black over white is grey 127 (black).
  const ghost = { width: 8, height: 1, pixel: (x) => (x === 0 ? [0, 0, 0, 128] : [0, 0, 0, 0]) };
  assert.deepStrictEqual(Array.from(PB.toBitmap(ghost, { width: 8, dither: 'threshold' }).data), [0x80]);
});

test('toBitmap: tainted canvas and no canvas at all', async () => {
  const kit = canvasKit();
  kit.taint = true;
  const { PB } = load({ canvas: kit });
  let e = layoutErr(() => PB.toBitmap({ width: 8, height: 8, pixel: () => BLACK }));
  assert.strictEqual(e.code, 'image-cors');
  assert.ok(e.message.indexOf('The browser does not let the page read the pixels of this image (tainted canvas): the server must allow CORS') === 0, e.message);
  const bare = load();
  e = layoutErr(() => bare.PB.toBitmap({ width: 8, height: 8, pixel: () => BLACK }));
  assert.strictEqual(e.code, 'image');
  assert.strictEqual(e.message, 'There is no canvas here to read the image: pass ImageData');
});

// ---------------------------------------------------------------- drivers, driverFor

test('drivers: ids, widths and transports; pacings', async () => {
  const { PB } = load();
  assert.deepStrictEqual(Object.keys(PB.drivers), ['escpos', 'phomemo-m02', 'phomemo-m02pro']);
  const d = PB.drivers;
  assert.deepStrictEqual([d.escpos.dpi, d.escpos.dots, d.escpos.widths, d.escpos.transport], [203, 384, [384, 576], null]);
  assert.deepStrictEqual([d['phomemo-m02'].dpi, d['phomemo-m02'].dots, d['phomemo-m02'].widths], [203, 384, [384]]);
  assert.deepStrictEqual([d['phomemo-m02pro'].dpi, d['phomemo-m02pro'].dots, d['phomemo-m02pro'].widths], [300, 576, [576, 624]]);
  assert.strictEqual(d['phomemo-m02'].transport, d['phomemo-m02pro'].transport);
  assert.deepStrictEqual(d['phomemo-m02pro'].transport, {
    label: 'Phomemo', service: SFF00, write: CFF02, notify: CFF03,
    chunk: 128, maxChunk: 182, delay: 20, flow: 'delay', withResponse: false,
    initialCredits: 4, creditTimeout: 1500,
    done: DONE, doneBase: 10000, donePerRow: 40, tailWait: 2000
  });
  assert.deepStrictEqual(PB.pacings, {
    standard: { chunk: 128, delay: 20, flow: 'delay' },
    slow: { chunk: 60, delay: 20, flow: 'delay' },
    credits: { chunk: 182, delay: 20, flow: 'credits' }
  });
});

test('driverFor: M02 Pro, M02PRO, M02, other M02 models -> null, anything else -> escpos', async () => {
  const { PB } = load();
  const cases = [
    ['M02 Pro', 'phomemo-m02pro'], ['M02PRO', 'phomemo-m02pro'], ['m02 pro', 'phomemo-m02pro'], ['M02-Pro', 'phomemo-m02pro'],
    ['M02', 'phomemo-m02'], ['m02', 'phomemo-m02'], [' M02 ', 'phomemo-m02'],
    ['M02S', null], ['M02X', null], ['M02L', null], ['M02 Pro2', null], ['M02-1234', null],
    ['BlueTooth Printer', 'escpos'], ['MPT-II', 'escpos'], ['M110', 'escpos'], ['M0', 'escpos'],
    ['', 'escpos'], [null, 'escpos'], [undefined, 'escpos']
  ];
  cases.forEach(([name, want]) => assert.strictEqual(PB.driverFor(name), want, JSON.stringify(name)));
});

// ---------------------------------------------------------------- encodeImage

test('encodeImage phomemo-m02pro: the 164-byte example of docs/phomemo-m02.md, byte for byte', async () => {
  const { PB } = load();
  const job = PB.encodeImage(pixels(576, 2, () => BLACK), 'phomemo-m02pro');
  assert.strictEqual(job.driver, 'phomemo-m02pro');
  assert.deepStrictEqual([job.bitmap.width, job.bitmap.height, job.bitmap.bytesPerRow], [576, 2, 72]);
  assert.strictEqual(job.bytes.length, 164);
  assert.deepStrictEqual(Array.from(job.bytes), EXAMPLE);
  // The same bytes as written in the document.
  const m = /## Example byte stream[\s\S]*?```[ \t]*\r?\n([0-9A-F ]+)\r?\n```/.exec(fs.readFileSync(DOC, 'utf8'));
  assert.ok(m, 'example block not found in docs/phomemo-m02.md');
  assert.deepStrictEqual(Array.from(job.bytes), m[1].trim().split(/\s+/).map((h) => parseInt(h, 16)));
});

test('encodeImage phomemo-m02: 384 dots, 48-byte rows; M02 Pro 624 dots -> 78-byte rows', async () => {
  const { PB } = load();
  const job = PB.encodeImage(pixels(384, 3, () => BLACK), 'phomemo-m02');
  assert.deepStrictEqual(Array.from(job.bytes), HEAD(4, 1).concat([0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0x03, 0x00],
    new Array(144).fill(0xFF), [0x1B, 0x64, 0x03]));
  const wide = PB.encodeImage(pixels(624, 1, () => BLACK), 'phomemo-m02pro', { width: 624 });
  assert.deepStrictEqual(parseJob(wide.bytes).blocks[0].header, [0x1D, 0x76, 0x30, 0x00, 0x4E, 0x00, 0x01, 0x00]);
  let e = layoutErr(() => PB.encodeImage(pixels(8, 1, () => BLACK), 'phomemo-m02', { width: 576 }));
  assert.deepStrictEqual([e.code, e.message], ['image', 'width must be a multiple of 8, from 8 to 384 dots']);
  e = layoutErr(() => PB.encodeImage(pixels(8, 1, () => BLACK), 'phomemo-m02pro', { width: 640 }));
  assert.deepStrictEqual([e.code, e.message], ['image', 'width must be a multiple of 8, from 8 to 624 dots']);
  // A narrower image on the M02 Pro is centred in 576 dots (284-291).
  const narrow = PB.encodeImage(pixels(8, 1, () => BLACK), 'phomemo-m02pro', { dither: 'threshold' });
  assert.deepStrictEqual(parseJob(narrow.bytes).blocks[0].data, row(576, 284, 291));
});

test('encodeImage phomemo: blocks of at most 255 rows with the exact count, data in order', async () => {
  const { PB } = load();
  const job = PB.encodeImage(pixels(384, 600, (x, y) => ((y % 3 === 0) !== (x === y % 384) ? BLACK : WHITE)), 'phomemo-m02', { dither: 'threshold' });
  const p = parseJob(job.bytes);
  assert.deepStrictEqual(p.head, HEAD(4, 1));
  assert.deepStrictEqual(p.blocks.map((b) => b.rows), [255, 255, 90]);
  assert.deepStrictEqual(p.blocks.map((b) => b.header), [
    [0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0xFF, 0x00],
    [0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0xFF, 0x00],
    [0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0x5A, 0x00]
  ]);
  assert.deepStrictEqual(p.blocks.map((b) => b.at), [9, 9 + 8 + 255 * 48, 9 + 2 * (8 + 255 * 48)]);
  assert.deepStrictEqual(p.blocks.flatMap((b) => b.data), Array.from(job.bitmap.data));
  assert.deepStrictEqual(p.tail, [0x1B, 0x64, 0x03]);
  assert.strictEqual(job.bytes.length, 9 + 3 * 8 + 600 * 48 + 3);
  // Exactly 255 rows: one block. 256: 255 + 1.
  assert.deepStrictEqual(parseJob(PB.encodeImage(pixels(8, 255, () => BLACK), 'phomemo-m02').bytes).blocks.map((b) => b.rows), [255]);
  assert.deepStrictEqual(parseJob(PB.encodeImage(pixels(8, 256, () => BLACK), 'phomemo-m02').bytes).blocks.map((b) => b.rows), [255, 1]);
});

test('encodeImage phomemo: density 1, 2, 4 (default 4), anything else rejected', async () => {
  const { PB } = load();
  const px = pixels(8, 1, () => BLACK);
  [[undefined, 4], [1, 1], [2, 2], [4, 4], ['2', 2]].forEach(([d, b]) => {
    const bytes = PB.encodeImage(px, 'phomemo-m02pro', { density: d }).bytes;
    assert.deepStrictEqual(bytes.slice(0, 9), HEAD(b, 1), String(d));
  });
  [3, 0, 5, 8, 15, 'high', -1, 4.5].forEach((d) => {
    const e = layoutErr(() => PB.encodeImage(px, 'phomemo-m02', { density: d }));
    assert.deepStrictEqual([e.code, e.message], ['driver', 'density must be 1, 2 or 4'], String(d));
  });
});

test('encodeImage phomemo: align left -> 1B 61 00 (and a left bitmap), feed, escape0A only in data', async () => {
  const { PB } = load();
  const px = pixels(8, 1, () => BLACK);
  const left = PB.encodeImage(px, 'phomemo-m02', { align: 'left', dither: 'threshold' }).bytes;
  assert.deepStrictEqual(left.slice(0, 9), HEAD(4, 0));
  assert.deepStrictEqual(parseJob(left).blocks[0].data, row(384, 0, 7));
  assert.deepStrictEqual(PB.encodeImage(px, 'phomemo-m02', { align: 'center' }).bytes.slice(0, 9), HEAD(4, 1));
  const right = PB.encodeImage(px, 'phomemo-m02', { align: 'right', dither: 'threshold' }).bytes;
  assert.deepStrictEqual(right.slice(0, 9), HEAD(4, 2));
  assert.deepStrictEqual(parseJob(right).blocks[0].data, row(384, 376, 383));
  // Feed: default 3, clamped to 0-10.
  [[undefined, 3], [0, 0], [5, 5], [10, 10], [50, 10], [-2, 0], ['7', 7]].forEach(([f, b]) => {
    assert.deepStrictEqual(parseJob(PB.encodeImage(px, 'phomemo-m02', { feed: f }).bytes).tail, [0x1B, 0x64, b], String(f));
  });
  // 80 dots (10 bytes per row) and 10 rows: the header has 0x0A twice, the feed too; every
  // data row is 0A 00 ... (dots 4 and 6 black).
  const tenRows = pixels(8, 10, (x) => (x === 4 || x === 6 ? BLACK : WHITE));
  const opts = { width: 80, align: 'left', dither: 'threshold', feed: 10 };
  const plain = PB.encodeImage(tenRows, 'phomemo-m02', opts).bytes;
  const esc = PB.encodeImage(tenRows, 'phomemo-m02', Object.assign({ escape0A: true }, opts)).bytes;
  const hdr = [0x1D, 0x76, 0x30, 0x00, 0x0A, 0x00, 0x0A, 0x00];
  const rowOf = (b) => [b, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rows = (b) => [].concat(...new Array(10).fill(0).map(() => rowOf(b)));
  assert.deepStrictEqual(Array.from(plain), HEAD(4, 0).concat(hdr, rows(0x0A), [0x1B, 0x64, 0x0A]));
  assert.deepStrictEqual(Array.from(esc), HEAD(4, 0).concat(hdr, rows(0x14), [0x1B, 0x64, 0x0A]));
});

test('encodeImage escpos: ESC @, 128-row bands, ESC d feed, optional full/partial cut', async () => {
  const { PB } = load();
  const job = PB.encodeImage(pixels(384, 300, (x, y) => (x === y ? BLACK : WHITE)), 'escpos', { dither: 'threshold' });
  const p = parseJob(job.bytes);
  assert.deepStrictEqual(p.head, [0x1B, 0x40]);
  assert.deepStrictEqual(p.blocks.map((b) => b.header), [
    [0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0x80, 0x00],
    [0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0x80, 0x00],
    [0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0x2C, 0x00]
  ]);
  assert.deepStrictEqual(p.blocks.flatMap((b) => b.data), Array.from(job.bitmap.data));
  assert.deepStrictEqual(p.tail, [0x1B, 0x64, 0x03]);
  assert.strictEqual(job.bytes.length, 2 + 3 * 8 + 300 * 48 + 3);
  const px = pixels(8, 1, () => BLACK);
  const tail = (o) => parseJob(PB.encodeImage(px, 'escpos', o).bytes).tail;
  assert.deepStrictEqual(tail({ cut: true }), [0x1B, 0x64, 0x03, 0x1D, 0x56, 0x00]);
  assert.deepStrictEqual(tail({ cut: 'full' }), [0x1B, 0x64, 0x03, 0x1D, 0x56, 0x00]);
  assert.deepStrictEqual(tail({ cut: 'partial', feed: 6 }), [0x1B, 0x64, 0x06, 0x1D, 0x56, 0x42, 0x00]);
  assert.deepStrictEqual(tail({ cut: false, feed: 300 }), [0x1B, 0x64, 0xFF]);
  // No density, no 1F 11, no ESC a in an ESC/POS job; 576 dots allowed, 624 not.
  assert.deepStrictEqual(parseJob(PB.encodeImage(px, 'escpos', { width: 576, density: 3 }).bytes).blocks[0].header,
    [0x1D, 0x76, 0x30, 0x00, 0x48, 0x00, 0x01, 0x00]);
  const e = layoutErr(() => PB.encodeImage(px, 'escpos', { width: 624 }));
  assert.deepStrictEqual([e.code, e.message], ['image', 'width must be a multiple of 8, from 8 to 576 dots']);
});

test('encodeImage: unknown driver, custom driver object', async () => {
  const { PB } = load();
  const e = layoutErr(() => PB.encodeImage(pixels(8, 1, () => BLACK), 'nope'));
  assert.deepStrictEqual([e.code, e.message], ['driver', 'Unknown printer driver "nope" (available: ' + DRIVER_IDS + ')']);
  const mine = { id: 'mine', dots: 16, widths: [16], encode: (bm, o) => [bm.width, bm.height, o.extra] };
  const job = PB.encodeImage(pixels(8, 3, () => BLACK), mine, { extra: 9 });
  assert.deepStrictEqual([job.driver, job.bytes], ['mine', [16, 3, 9]]);
});

// ---------------------------------------------------------------- RawBT.ble with a driver transport

test('pair(): chooser filters gained namePrefix M02; a Phomemo with ISSC is paired on ISSC first', async () => {
  const dev = phomemo();
  const { ble, nav } = load({ devices: [dev] });
  const info = await ble.pair();
  const opt = nav.requests[0];
  assert.ok(opt.filters.some((f) => f.namePrefix === 'M02' && Object.keys(f).length === 1));
  assert.ok(!opt.filters.some((f) => f.services && f.services[0] === SFF00 && f.namePrefix), 'FF00 is not combined with a name');
  assert.ok(opt.optionalServices.indexOf(SFF00) >= 0);
  assert.ok(opt.optionalServices.indexOf(U('fee7')) >= 0);
  assert.strictEqual(info.profile, 'ISSC');
  assert.strictEqual(info.characteristic, CISSC);
});

test('driver print, pacing standard: forced to FF00/FF02, 128 B without response, 20 ms after each, waits for 1A 0F 0C', async () => {
  const dev = phomemo({ hello: true });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const d = data(300);
  dev.expect(300);
  const prog = [];
  const r = await ble.print(d, { transport: transport(PB), rows: 7, onProgress: (s, t) => prog.push([s, t]) });
  assert.deepStrictEqual(dev.writes.map((w) => [w.uuid, w.bytes.length, w.withResponse]),
    [[CFF02, 128, false], [CFF02, 128, false], [CFF02, 44, false]]);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.deepStrictEqual(wt(log), ['w128', 't20', 'w128', 't20', 'w44', 't20', 't10280']);
  assert.deepStrictEqual(prog, [[128, 300], [256, 300], [300, 300]]);
  assert.strictEqual(typeof r.ms, 'number');
  delete r.ms;
  assert.deepStrictEqual(r, {
    ok: true, bytes: 300, chunk: 128, withResponse: false, flow: 'delay', notifications: true,
    done: true, warnings: [], frames: 5
  });
  assert.strictEqual(dev.notifyStarts, 1);
  assert.strictEqual(dev.overlap, 0);
  assert.strictEqual(ble.info().profile, 'Phomemo');
  assert.strictEqual(ble.info().characteristic, CFF02);
  assert.strictEqual(ble.info().status, 'ready');
  // A second job reuses the channel and the notifications (one listener on FF03).
  dev.expect(10);
  const r2 = await ble.print(data(10), { transport: transport(PB), rows: 1 });
  assert.strictEqual(r2.done, true);
  assert.strictEqual(dev.notifyStarts, 1);
  assert.strictEqual(dev.char(CFF03).listenerCount(), 1);
  assert.ok(dev.writes.every((w) => w.uuid === CFF02));
});

test('driver print, pacing slow: 60 B chunks with 20 ms pauses', async () => {
  const dev = phomemo();
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  dev.expect(130);
  const r = await ble.print(data(130), { transport: transport(PB, PB.pacings.slow), rows: 2 });
  assert.deepStrictEqual(sizes(dev), [60, 60, 10]);
  assert.deepStrictEqual(wt(log), ['w60', 't20', 'w60', 't20', 'w10', 't20', 't10080']);
  assert.deepStrictEqual([r.chunk, r.flow, r.done], [60, 'delay', true]);
});

test('driver print, chunk cap: never above maxChunk or 182, never below 20', async () => {
  const dev = phomemo();
  const { ble, PB } = load({ devices: [dev] });
  await ble.pair();
  const run = async (extra, n) => {
    dev.writes.length = 0;
    dev.expect(n);
    const r = await ble.print(data(n), { transport: transport(PB, extra), rows: 1 });
    return [r.chunk, sizes(dev)];
  };
  assert.deepStrictEqual(await run({ chunk: 400, maxChunk: undefined }, 400), [182, [182, 182, 36]]);
  assert.deepStrictEqual(await run({ chunk: 400 }, 400), [182, [182, 182, 36]]);
  assert.deepStrictEqual(await run({ chunk: 400, maxChunk: 100 }, 250), [100, [100, 100, 50]]);
  assert.deepStrictEqual(await run({ chunk: 5 }, 50), [20, [20, 20, 10]]);
  assert.deepStrictEqual(await run({ chunk: undefined }, 130), [128, [128, 2]]);
});

test('driver print, credits: 4 to start, one 182 B chunk per 01 01, no pauses', async () => {
  const dev = phomemo();
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const d = data(182 * 3 + 50);
  dev.expect(d.length);
  const r = await ble.print(d, { transport: transport(PB, PB.pacings.credits), rows: 4 });
  assert.deepStrictEqual(sizes(dev), [182, 182, 182, 50]);
  assert.ok(dev.writes.every((w) => w.withResponse === false && w.uuid === CFF02));
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.deepStrictEqual(wt(log), ['w182', 'w182', 'w182', 'w50', 't10160']);
  assert.deepStrictEqual([r.chunk, r.flow, r.notifications, r.done, r.frames], [182, 'credits', true, true, 5]);
});

test('driver print, credits: after 4 chunks it waits for 01 01, one chunk per credit; other frames are not credits', async () => {
  // While the first chunk is written the printer sends 02 B6 00 and a status frame: no credit.
  const dev = phomemo({
    credits: false,
    onCall: (w, d) => { if (d.calls === 1) { d.emit(HELLO); d.emit([0x1A, 0x06, 0x89]); } }
  });
  const { ble, PB, log } = load({ devices: [dev], scale: 5 });
  await ble.pair();
  log.length = 0;
  const d = data(182 * 6);
  const p = ble.print(d, { transport: transport(PB, PB.pacings.credits), rows: 1 });
  await until(() => count(log, 't1500') === 1, 'the first credit wait');
  await sleep(20);
  assert.deepStrictEqual(sizes(dev), [182, 182, 182, 182], 'only the 4 initial credits');
  dev.emit(CREDIT);
  await until(() => count(log, 't1500') === 2, 'the second credit wait');
  assert.strictEqual(dev.writes.length, 5);
  dev.emit(CREDIT);
  await until(() => log.indexOf('t10040') >= 0, 'the wait for print complete');
  dev.emit(DONE);
  const r = await p;
  assert.deepStrictEqual(nt(log), ['w182', 'f02b600', 'f1a0689', 'w182', 'w182', 'w182', 't1500', 'f0101', 'w182', 't1500', 'f0101', 'w182', 't10040', 'f1a0f0c']);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.deepStrictEqual([r.flow, r.done, r.frames, r.warnings], ['credits', true, 5, []]);
});

test('driver print, credits: no 01 01 within 1.5 s -> back to 20 ms pauses (credits+delay)', async () => {
  const dev = phomemo({ credits: false });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const d = data(182 * 4 + 100);
  dev.expect(d.length);
  const r = await ble.print(d, { transport: transport(PB, PB.pacings.credits), rows: 2 });
  assert.deepStrictEqual(wt(log), ['w182', 'w182', 'w182', 'w182', 't1500', 'w100', 't20', 't10080']);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.deepStrictEqual([r.flow, r.done], ['credits+delay', true]);
});

test('driver print: "unknown reason" retried, the same chunk again, no byte lost or doubled', async () => {
  const dev = phomemo({ fail: ({ n }) => (n === 2 ? UNKNOWN() : null) });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const d = data(300);
  dev.expect(300);
  const r = await ble.print(d, { transport: transport(PB), rows: 1 });
  assert.deepStrictEqual(wt(log), ['w128', 't20', 'w128', 't20', 'w44', 't80', 'w44', 't20', 't10040']);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.strictEqual(dev.calls, 4);
  assert.strictEqual(r.done, true);
});

test('driver print, credits: a retried chunk does not spend its credit twice', async () => {
  const dev = phomemo({ credits: false, fail: ({ n }) => (n === 1 ? UNKNOWN() : null) });
  const { ble, PB, log } = load({ devices: [dev], scale: 5 });
  await ble.pair();
  log.length = 0;
  const d = data(182 * 6);
  const p = ble.print(d, { transport: transport(PB, PB.pacings.credits), rows: 1 });
  await until(() => count(log, 't1500') === 1, 'the first credit wait');
  assert.deepStrictEqual(nt(log), ['w182', 'w182', 't80', 'w182', 'w182', 'w182', 't1500']);
  assert.strictEqual(dev.writes.length, 4, '4 initial credits = 4 chunks delivered');
  dev.emit(CREDIT);
  await until(() => dev.writes.length === 5, 'chunk 5');
  dev.emit(CREDIT);
  await until(() => log.indexOf('t10040') >= 0, 'the wait for print complete');
  dev.emit(DONE);
  const r = await p;
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.strictEqual(r.done, true);
});

test('driver print: "unknown reason" more than 3 times -> the error, status ready', async () => {
  const dev = phomemo({ fail: ({ n }) => (n >= 1 ? UNKNOWN() : null) });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const e = await rejects(ble.print(data(300), { transport: transport(PB), rows: 1 }));
  assert.strictEqual(e.message, 'GATT operation failed for unknown reason.');
  assert.deepStrictEqual(wt(log), ['w128', 't20', 'w128', 't80', 'w128', 't160', 'w128', 't240', 'w128']);
  assert.strictEqual(ble.info().status, 'ready');
});

test('driver print: a 1A 0F 0C before the last write is stale; no 1A 0F 0C -> done false after 10 s + 40 ms/row', async () => {
  // Stale frame after the first chunk.
  let dev = phomemo({ onFF02: (w, d) => { if (d.writes.length === 1) later(() => d.emit(DONE)); } });
  let L = load({ devices: [dev] });
  await L.ble.pair();
  L.log.length = 0;
  let r = await L.ble.print(data(300), { transport: transport(L.PB), rows: 3 });
  assert.strictEqual(r.done, false);
  assert.ok(L.log.indexOf('f1a0f0c') < L.log.indexOf('w44'));
  assert.deepStrictEqual(wt(L.log).slice(-1), ['t10120']);
  // Frame sent while the last write is still pending.
  dev = phomemo({ onCall: (w, d) => { if (w.uuid === CFF02 && w.bytes.length === 44) d.emit(DONE); } });
  L = load({ devices: [dev] });
  await L.ble.pair();
  r = await L.ble.print(data(300), { transport: transport(L.PB), rows: 3 });
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.frames, 4, 'three credits and the stale frame were seen');
  // No frame at all: the timeout.
  dev = phomemo();
  L = load({ devices: [dev] });
  await L.ble.pair();
  L.log.length = 0;
  const t0 = Date.now();
  r = await L.ble.print(data(100), { transport: transport(L.PB), rows: 3 });
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.notifications, true);
  assert.deepStrictEqual(wt(L.log), ['w100', 't20', 't10120']);
  assert.ok(Date.now() - t0 >= 150, 'waited for the timeout');
});

test('driver print: notifications refused -> timers only, tail wait 2 s, done null', async () => {
  const dev = phomemo({ notify: dom('NotSupportedError', 'GATT Error: Not supported.') });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  dev.expect(130);
  let r = await ble.print(data(130), { transport: transport(PB), rows: 1 });
  assert.deepStrictEqual(wt(log), ['w128', 't20', 'w2', 't20', 't2000']);
  assert.deepStrictEqual([r.notifications, r.done, r.flow, r.frames, r.warnings], [false, null, 'delay', 0, []]);
  assert.strictEqual(dev.notifyStarts, 1);
  // Credits pacing without notifications: no credit can come, plain pauses from the start.
  log.length = 0;
  r = await ble.print(data(100), { transport: transport(PB, PB.pacings.credits), rows: 1 });
  assert.deepStrictEqual(wt(log), ['w100', 't20', 't2000']);
  assert.deepStrictEqual([r.notifications, r.done, r.flow], [false, null, 'delay']);
});

test('driver print: warnings paper-out, cover-open, too-hot from 1A frames (once each)', async () => {
  const dev = phomemo({
    onFF02: (w, d) => {
      if (d.writes.length !== 1) return;
      later(() => {
        d.emit([0x1A, 0x06, 0x89, 0x1A, 0x05, 0x98, 0x1A, 0x03, 0xA8]);
        d.emit([0x1A, 0x05, 0x99]);
        d.emit([0x01, 0x01, 0x1A, 0x03, 0xA9, 0x1A, 0x06, 0x88]);
        d.emit([0x1A, 0x05, 0x99]);
      });
    }
  });
  const { ble, PB } = load({ devices: [dev] });
  await ble.pair();
  dev.expect(300);
  const r = await ble.print(data(300), { transport: transport(PB), rows: 1 });
  assert.deepStrictEqual(r.warnings, ['cover-open', 'paper-out', 'too-hot']);
  assert.strictEqual(r.done, true);
  // Normal values only: no warning.
  const dev2 = phomemo({ onFF02: (w, d) => later(() => d.emit([0x1A, 0x06, 0x89, 0x1A, 0x05, 0x98, 0x1A, 0x03, 0xA8])) });
  const L2 = load({ devices: [dev2] });
  await L2.ble.pair();
  dev2.expect(10);
  assert.deepStrictEqual((await L2.ble.print(data(10), { transport: transport(L2.PB), rows: 1 })).warnings, []);
});

test('driver print: the next queued job starts only after 1A 0F 0C of the previous one', async () => {
  const dev = phomemo({ credits: false });
  const { ble, PB, log } = load({ devices: [dev], scale: 10 });
  await ble.pair();
  log.length = 0;
  const a = data(200, 1), b = data(150, 2);
  let firstDone = false;
  const p1 = ble.print(a, { transport: transport(PB), rows: 1 });
  const p2 = ble.print(b, { transport: transport(PB), rows: 1 });
  p1.then(() => { firstDone = true; });
  await until(() => log.indexOf('t10040') >= 0, 'job 1 waiting for print complete');
  await sleep(30);
  assert.deepStrictEqual(delivered(dev), Array.from(a), 'job 2 has not started');
  assert.strictEqual(firstDone, false);
  dev.emit(DONE);
  const r1 = await p1;
  await until(() => count(log, 't10040') === 2, 'job 2 waiting for print complete');
  dev.emit(DONE);
  const r2 = await p2;
  assert.deepStrictEqual([r1.done, r2.done], [true, true]);
  assert.deepStrictEqual(delivered(dev), Array.from(a).concat(Array.from(b)));
  assert.deepStrictEqual(nt(log), ['w128', 't20', 'w72', 't20', 't10040', 'f1a0f0c', 'w128', 't20', 'w22', 't20', 't10040', 'f1a0f0c']);
  assert.strictEqual(dev.overlap, 0);
});

test('driver print after a disconnection: channel and notifications set up again', async () => {
  const dev = phomemo();
  const { ble, PB } = load({ devices: [dev] });
  await ble.pair();
  dev.expect(10);
  assert.strictEqual((await ble.print(data(10), { transport: transport(PB), rows: 1 })).done, true);
  dev.gatt.disconnect();
  assert.strictEqual(ble.info().status, 'disconnected');
  dev.expect(20);
  const r = await ble.print(data(20), { transport: transport(PB), rows: 1 });
  assert.deepStrictEqual([r.done, r.notifications, r.frames], [true, true, 2]);
  assert.strictEqual(dev.notifyStarts, 2);
  assert.strictEqual(dev.char(CFF03).listenerCount(), 1);
  assert.strictEqual(ble.info().profile, 'Phomemo');
  assert.ok(dev.writes.every((w) => w.uuid === CFF02));
});

test('driver transport on a printer without FF00: no-channel, nothing written', async () => {
  const dev = netum();
  const { ble, PB } = load({ devices: [dev] });
  await ble.pair();
  const e = await rejects(ble.print(data(10), { transport: transport(PB), rows: 1 }));
  assert.strictEqual(e.code, 'no-channel');
  assert.strictEqual(dev.writes.length, 0);
  assert.strictEqual(ble.info().status, 'ready');
});

test('legacy ESC/POS print without transport: unchanged (100 B with response, no notifications)', async () => {
  for (const dev of [netum(), phomemo()]) {
    const { ble, log } = load({ devices: [dev] });
    await ble.pair();
    log.length = 0;
    const d = data(250);
    const r = await ble.print(d);
    const ch = dev.name === 'M02 Pro' ? CISSC : C2AF1;
    assert.deepStrictEqual(dev.writes.map((w) => [w.uuid, w.bytes.length, w.withResponse]), [[ch, 100, true], [ch, 100, true], [ch, 50, true]]);
    assert.deepStrictEqual(delivered(dev), Array.from(d));
    assert.deepStrictEqual(wt(log), ['w100', 'w100', 'w50', 't300']);
    assert.strictEqual(typeof r.ms, 'number');
    delete r.ms;
    assert.deepStrictEqual(r, { ok: true, bytes: 250, chunk: 100, withResponse: true });
    assert.strictEqual(dev.notifyStarts, 0);
  }
});

// ---------------------------------------------------------------- phomemoStatus

const REPLIES = {
  0x07: [0x1A, 0x07, 0x02, 0x00, 0x06], 0x08: [0x1A, 0x04, 0x55], 0x11: [0x1A, 0x06, 0x89],
  0x12: [0x1A, 0x05, 0x98], 0x13: [0x1A, 0x03, 0xA8]
};
const QUERIES = [0x07, 0x08, 0x11, 0x12, 0x13];

test('phomemoStatus: exactly the five queries 1F 11 07/08/11/12/13 on FF02, replies parsed', async () => {
  const dev = phomemo({
    credits: false,
    onFF02: (w, d) => {
      const op = w.bytes[2];
      if (w.bytes.length === 3 && REPLIES[op]) later(() => { d.emit(CREDIT); d.emit(REPLIES[op]); });
    }
  });
  const { ble, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const s = await ble.phomemoStatus();
  assert.deepStrictEqual(dev.writes.map((w) => [w.uuid, w.bytes, w.withResponse]),
    QUERIES.map((op) => [CFF02, [0x1F, 0x11, op], false]));
  assert.deepStrictEqual(wt(log), ['w3', 't300', 'w3', 't300', 'w3', 't300', 'w3', 't300', 'w3', 't300', 't700']);
  assert.deepStrictEqual(s, {
    firmware: '2.0.6', battery: 85, paper: 'ok', cover: 'closed', temperature: 'ok',
    raw: [].concat(...QUERIES.map((op) => CREDIT.concat(REPLIES[op])))
  });
  assert.strictEqual(ble.info().profile, 'Phomemo');
});

test('phomemoStatus: replies glued in one frame; out, open, hot; battery 0x1A and 0xA1', async () => {
  const glued = [0x01, 0x01, 0x1A, 0x07, 0x02, 0x01, 0x03, 0x01, 0x01, 0x1A, 0x04, 0x1A, 0x01, 0x01, 0x1A, 0x06, 0x88,
    0x01, 0x01, 0x1A, 0x05, 0x99, 0x01, 0x01, 0x1A, 0x03, 0xA9];
  const dev = phomemo({ credits: false, onFF02: (w, d) => { if (w.bytes[2] === 0x13) later(() => d.emit(glued)); } });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const s = await ble.phomemoStatus();
  assert.deepStrictEqual(s, { firmware: '2.1.3', battery: 26, paper: 'out', cover: 'open', temperature: 'hot', raw: glued });
  // Unexplained battery values (0xA1 and above) are not a percentage; no answer -> null.
  const dev2 = phomemo({ credits: false, onFF02: (w, d) => { if (w.bytes[2] === 0x08) later(() => d.emit([0x01, 0x01, 0x1A, 0x04, 0xA1])); } });
  const L2 = load({ devices: [dev2] });
  await L2.ble.pair();
  assert.deepStrictEqual(await L2.ble.phomemoStatus(),
    { firmware: null, battery: null, paper: null, cover: null, temperature: null, raw: [0x01, 0x01, 0x1A, 0x04, 0xA1] });
});

test('phomemoStatus: queued behind a print that waits for 1A 0F 0C', async () => {
  const dev = phomemo({
    credits: false,
    onFF02: (w, d) => {
      const op = w.bytes[2];
      if (w.bytes.length === 3 && REPLIES[op]) later(() => { d.emit(CREDIT); d.emit(REPLIES[op]); });
    }
  });
  const { ble, PB, log } = load({ devices: [dev], scale: 10 });
  await ble.pair();
  log.length = 0;
  const p = ble.print(data(100), { transport: transport(PB), rows: 1 });
  const s = ble.phomemoStatus();
  await until(() => log.indexOf('t10040') >= 0, 'the print waiting for print complete');
  await sleep(30);
  assert.deepStrictEqual(sizes(dev), [100], 'no query while the print is not complete');
  dev.emit(DONE);
  assert.strictEqual((await p).done, true);
  const st = await s;
  assert.deepStrictEqual(sizes(dev), [100, 3, 3, 3, 3, 3]);
  assert.deepStrictEqual([st.firmware, st.battery, st.paper, st.cover, st.temperature], ['2.0.6', 85, 'ok', 'closed', 'ok']);
});

test('phomemoStatus: notifications refused -> no-notify, no query sent; no FF00 -> no-channel', async () => {
  const dev = phomemo({ notify: dom('NotAllowedError', 'Encryption is insufficient.') });
  const { ble } = load({ devices: [dev] });
  await ble.pair();
  const e = await rejects(ble.phomemoStatus());
  assert.strictEqual(e.code, 'no-notify');
  assert.strictEqual(dev.writes.length, 0);
  assert.strictEqual(dev.calls, 0);
  assert.ok(/notifications/.test(ble.explain(e)));
  const other = netum();
  const L = load({ devices: [other] });
  await L.ble.pair();
  assert.strictEqual((await rejects(L.ble.phomemoStatus())).code, 'no-channel');
  assert.strictEqual(other.writes.length, 0);
});

// ---------------------------------------------------------------- printCanvas

test('printCanvas: driver auto from the BLE name, pairing in the same call, the 164 bytes on FF02', async () => {
  const dev = phomemo();
  const { g, nav } = load({ devices: [dev] });
  dev.expect(164);
  const p = g.RawBT.printCanvas(pixels(576, 2, () => BLACK), { via: 'ble' });
  assert.strictEqual(nav.requests.length, 1, 'requestDevice must be called synchronously');
  assert.ok(nav.requests[0].filters.some((f) => f.namePrefix === 'M02'));
  const r = await p;
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual([r.via, r.reason, r.driver, r.bytes, r.rows], ['ble', 'option', 'phomemo-m02pro', 164, 2]);
  assert.strictEqual(typeof r.ms, 'number');
  assert.deepStrictEqual([r.result.flow, r.result.done, r.result.chunk, r.result.withResponse], ['delay', true, 128, false]);
  assert.deepStrictEqual(sizes(dev), [128, 36]);
  assert.deepStrictEqual(delivered(dev, CFF02), EXAMPLE);
  // Paired in this tab: no chooser the second time.
  dev.expect(164);
  const r2 = await g.RawBT.printCanvas(pixels(576, 2, () => BLACK));
  assert.deepStrictEqual([r2.ok, r2.via, r2.reason, r2.driver], [true, 'ble', 'paired', 'phomemo-m02pro']);
  assert.strictEqual(nav.requests.length, 1);
});

test('printCanvas: "M02" -> phomemo-m02 (48-byte rows); a plain ESC/POS name -> escpos write modes', async () => {
  const dev = phomemo({ name: 'M02' });
  const L = load({ devices: [dev] });
  dev.expect(9 + 8 + 48 * 5 + 3);
  const r = await L.g.RawBT.printCanvas(pixels(384, 5, () => BLACK), { via: 'ble', pacing: 'slow' });
  assert.deepStrictEqual([r.ok, r.driver, r.bytes, r.rows], [true, 'phomemo-m02', 260, 5]);
  const p = parseJob(delivered(dev, CFF02));
  assert.deepStrictEqual(p.blocks.map((b) => b.header), [[0x1D, 0x76, 0x30, 0x00, 0x30, 0x00, 0x05, 0x00]]);
  assert.deepStrictEqual(sizes(dev), [60, 60, 60, 60, 20]);
  const nt = netum();
  const N = load({ devices: [nt] });
  const r2 = await N.g.RawBT.printCanvas(pixels(384, 5, () => BLACK), { via: 'ble', cut: true });
  assert.deepStrictEqual([r2.ok, r2.driver, r2.bytes], [true, 'escpos', 2 + 8 + 240 + 3 + 3]);
  assert.deepStrictEqual(nt.writes.map((w) => [w.uuid, w.bytes.length, w.withResponse]),
    [[C2AF1, 100, true], [C2AF1, 100, true], [C2AF1, 56, true]]);
  assert.deepStrictEqual(parseJob(delivered(nt)).tail, [0x1B, 0x64, 0x03, 0x1D, 0x56, 0x00]);
  assert.strictEqual(r2.result.flow, undefined);
});

test('printCanvas: an M02 model of unknown width (M02S) -> error asking to choose the driver', async () => {
  const dev = phomemo({ name: 'M02S' });
  const { g, nav } = load({ devices: [dev] });
  const r = await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { via: 'ble' });
  assert.strictEqual(nav.requests.length, 1);
  assert.deepStrictEqual([r.ok, r.code, r.via, r.driver, r.bytes, r.rows], [false, 'driver', 'ble', null, 0, 0]);
  assert.strictEqual(r.error, 'Cannot tell which model "M02S" is: choose the driver by hand (driver: ' + DRIVER_IDS + ')');
  assert.strictEqual(dev.calls, 0);
  // Chosen by hand it prints.
  dev.expect(9 + 8 + 48 + 3);
  const r2 = await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { driver: 'phomemo-m02' });
  assert.deepStrictEqual([r2.ok, r2.via, r2.reason, r2.driver, r2.bytes], [true, 'ble', 'driver', 'phomemo-m02', 68]);
});

test('printCanvas: a Phomemo driver with via app -> error, no chooser, nothing sent', async () => {
  const { g, nav } = load({ devices: [phomemo()] });
  const sent = [];
  g.RawBT.sendApi = (b) => { sent.push(b); return Promise.resolve({ ok: true }); };
  for (const driver of ['phomemo-m02pro', 'phomemo-m02']) {
    const r = await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { driver, via: 'app' });
    assert.deepStrictEqual([r.ok, r.code, r.via, r.driver], [false, 'via', null, driver]);
    assert.strictEqual(r.error, g.PrintBridge.drivers[driver].label + ' prints only over Bluetooth LE (via: "ble")');
  }
  assert.strictEqual(nav.requests.length, 0);
  assert.strictEqual(sent.length, 0);
  // Driver auto with via app: the ESC/POS bytes go to the app.
  const r = await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { via: 'app', dither: 'threshold' });
  assert.deepStrictEqual([r.ok, r.via, r.reason, r.driver, r.bytes, r.result], [true, 'app', 'option', 'escpos', 2 + 8 + 48 + 3, { ok: true }]);
  assert.deepStrictEqual(sent[0].slice(0, 2), [0x1B, 0x40]);
});

test('printCanvas: an explicit Phomemo driver forces BLE and pairs in the same call', async () => {
  const dev = phomemo();
  const { g, nav } = load({ devices: [dev] });
  dev.expect(164);
  const p = g.RawBT.printCanvas(pixels(576, 2, () => BLACK), { driver: 'phomemo-m02pro' });
  assert.strictEqual(nav.requests.length, 1, 'requestDevice must be called synchronously');
  assert.ok(nav.requests[0].filters.some((f) => f.namePrefix === 'M02'));
  const r = await p;
  assert.deepStrictEqual([r.ok, r.via, r.reason, r.driver, r.bytes], [true, 'ble', 'driver', 'phomemo-m02pro', 164]);
  assert.deepStrictEqual(delivered(dev, CFF02), EXAMPLE);
});

test('printCanvas: transport from the pacing (standard, slow, credits; 182 cap), rows, a copy', async () => {
  const { g, PB } = load();
  const calls = [];
  g.RawBT.ble.info = () => ({ paired: true, name: 'M02 Pro' });
  g.RawBT.ble.pair = () => { throw new Error('no pairing expected'); };
  g.RawBT.ble.print = (bytes, opts) => { calls.push(opts); return Promise.resolve({ ok: true }); };
  const base = PB.drivers['phomemo-m02pro'].transport;
  const snapshot = JSON.stringify(base);
  const want = { undefined: [128, 20, 'delay'], standard: [128, 20, 'delay'], slow: [60, 20, 'delay'], credits: [182, 20, 'credits'] };
  for (const pacing of [undefined, 'standard', 'slow', 'credits']) {
    const r = await g.RawBT.printCanvas(pixels(8, 3, () => BLACK), { pacing, onProgress: 'cb' });
    assert.strictEqual(r.ok, true, r.error);
    const o = calls[calls.length - 1];
    assert.deepStrictEqual([o.transport.chunk, o.transport.delay, o.transport.flow], want[String(pacing)], String(pacing));
    assert.deepStrictEqual([o.rows, o.onProgress], [3, 'cb']);
    assert.notStrictEqual(o.transport, base);
    assert.deepStrictEqual([o.transport.service, o.transport.write, o.transport.notify, o.transport.done, o.transport.maxChunk],
      [SFF00, CFF02, CFF03, DONE, 182]);
  }
  assert.strictEqual(JSON.stringify(base), snapshot, 'the driver transport is not changed');
  // A pacing chunk above 182 is capped by the transport.
  PB.pacings.credits.chunk = 300;
  await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { pacing: 'credits' });
  assert.strictEqual(calls[calls.length - 1].transport.chunk, 182);
  PB.pacings.credits.chunk = 182;
  // ESC/POS has no transport: the ESC/POS write modes of RawBT.ble.
  g.RawBT.ble.info = () => ({ paired: true, name: 'BlueTooth Printer' });
  await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { pacing: 'credits' });
  assert.strictEqual(calls[calls.length - 1].transport, null);
  // An unknown pacing is refused before anything is sent.
  const n = calls.length;
  const bad = await g.RawBT.printCanvas(pixels(8, 1, () => BLACK), { pacing: 'turbo' });
  assert.deepStrictEqual([bad.ok, bad.code, bad.error], [false, 'driver', 'pacing must be "standard", "slow" or "credits"']);
  assert.strictEqual(calls.length, n);
});

test('printCanvas never rejects: normalized results for every failure', async () => {
  const px = pixels(576, 2, () => BLACK);
  // Unknown driver, bad density, bad image (after pairing), chooser closed.
  let L = load({ devices: [phomemo()] });
  let r = await L.g.RawBT.printCanvas(px, { driver: 'nope' });
  assert.deepStrictEqual([r.ok, r.code, r.via, r.driver], [false, 'driver', null, null]);
  assert.strictEqual(r.error, 'Unknown printer driver "nope" (available: ' + DRIVER_IDS + ')');
  assert.strictEqual(L.nav.requests.length, 0);
  r = await L.g.RawBT.printCanvas(px, { driver: 'phomemo-m02pro', density: 3 });
  assert.deepStrictEqual([r.ok, r.code, r.error, r.via], [false, 'driver', 'density must be 1, 2 or 4', null]); // checked before the chooser opens
  r = await L.g.RawBT.printCanvas(null, { driver: 'phomemo-m02pro' });
  assert.deepStrictEqual([r.ok, r.code, r.bytes], [false, 'image', 0]);
  L = load();
  r = await L.g.RawBT.printCanvas(px, { driver: 'phomemo-m02pro' });
  assert.deepStrictEqual([r.ok, r.cancelled, r.code, r.error, r.via], [false, true, 'NotFoundError', 'Printer selection cancelled', 'ble']);
  // A BLE write that fails: the explained error, with what was being printed.
  const broken = phomemo({ fail: () => dom('NotSupportedError', 'GATT Error Unknown.') });
  L = load({ devices: [broken] });
  r = await L.g.RawBT.printCanvas(px, { via: 'ble' });
  assert.deepStrictEqual([r.ok, r.code, r.via, r.driver, r.bytes, r.rows], [false, 'NotSupportedError', 'ble', 'phomemo-m02pro', 164, 2]);
  assert.strictEqual(r.error, L.ble.explain(r.cause));
  // The app does not answer / answers with an error.
  L = load();
  r = await L.g.RawBT.printCanvas(px, { via: 'app', width: 576 });
  assert.deepStrictEqual([r.ok, r.code, r.via, r.driver], [false, 'network', 'app', 'escpos']);
  assert.strictEqual(r.error, 'The Print Bridge app did not answer (Failed to fetch). Open the app and try again.');
  L.g.RawBT.sendApi = () => Promise.resolve({ ok: false, error: 'no paper' });
  r = await L.g.RawBT.printCanvas(px, { via: 'app', width: 576 });
  assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'app', 'The Print Bridge app could not print: no paper']);
  // Anything thrown synchronously is a result too.
  L = load();
  r = await L.g.RawBT.printCanvas(px, { via: 'nowhere' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'via']);
  r = await L.g.RawBT.printCanvas();
  assert.strictEqual(r.ok, false);
});

// ---------------------------------------------------------------- fixes after review

test('credits without notifications: back to 128 B chunks, never 182 without flow control', async () => {
  const dev = phomemo({ notify: dom('NotSupportedError', 'GATT Error: Not supported.') });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const r = await ble.print(data(300), { transport: transport(PB, PB.pacings.credits), rows: 1 });
  assert.deepStrictEqual(wt(log), ['w128', 't20', 'w128', 't20', 'w44', 't20', 't2000']);
  assert.deepStrictEqual([r.chunk, r.flow, r.done], [128, 'delay', null]);
});

test('credits that stop coming: the rest goes in 128 B chunks with 20 ms pauses', async () => {
  const dev = phomemo({ credits: false });
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  log.length = 0;
  const d = data(182 * 4 + 300);
  dev.expect(d.length);
  const r = await ble.print(d, { transport: transport(PB, PB.pacings.credits), rows: 2 });
  assert.deepStrictEqual(wt(log), ['w182', 'w182', 'w182', 'w182', 't1500', 'w128', 't20', 'w128', 't20', 'w44', 't20', 't10080']);
  assert.deepStrictEqual(delivered(dev), Array.from(d));
  assert.deepStrictEqual([r.chunk, r.flow, r.done], [128, 'credits+delay', true]);
});

test('density: only the numbers (or digit strings) 1, 2, 4; true, [4], {} rejected', async () => {
  const { PB } = load();
  const px = pixels(384, 1, () => BLACK);
  [true, [4], {}, NaN].forEach((density) => {
    assert.throws(() => PB.encodeImage(px, 'phomemo-m02', { density }), /density must be 1, 2 or 4/, String(density));
  });
  assert.strictEqual(PB.encodeImage(px, 'phomemo-m02', { density: '2' }).bytes[5], 2);
});

test('printCanvas: an invalid via is refused with a Phomemo driver too', async () => {
  const dev = phomemo();
  const L = load({ devices: [dev] });
  const r = await L.g.RawBT.printCanvas(pixels(576, 1, () => BLACK), { driver: 'phomemo-m02pro', via: 'nowhere' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'via']);
  assert.strictEqual(L.nav.requests.length, 0, 'no chooser');
});

test('printCanvas: a driver object that is not registered works as in encodeImage', async () => {
  const dev = phomemo();
  const { g, ble, PB } = load({ devices: [dev] });
  await ble.pair();
  const mine = {
    id: 'mine', label: 'Mine', dots: 576, widths: [576],
    transport: PB.drivers['phomemo-m02pro'].transport,
    encode: () => [0x1B, 0x40, 0x1B, 0x64, 0x01]
  };
  const r = await g.RawBT.printCanvas(pixels(576, 1, () => WHITE), { driver: mine });
  assert.deepStrictEqual([r.ok, r.driver, r.bytes, r.via], [true, 'mine', 5, 'ble'], r.error);
  assert.deepStrictEqual(delivered(dev, CFF02), [0x1B, 0x40, 0x1B, 0x64, 0x01]);
});

test('printer gone while waiting for "print complete": done false at once, state disconnected', async () => {
  const dev = phomemo({ credits: false });
  const { ble, PB, log } = load({ devices: [dev], scale: 1 });
  await ble.pair();
  log.length = 0;
  const p = ble.print(data(130), { transport: transport(PB), rows: 1 });
  await until(() => log.indexOf('t10040') >= 0, 'the wait for print complete');
  const t0 = Date.now();
  dev.gatt.disconnect();
  const r = await p;
  assert.ok(Date.now() - t0 < 1000, 'resolved on the disconnection, not after the 10 s timeout');
  assert.strictEqual(r.done, false);
  assert.strictEqual(ble.info().status, 'disconnected');
});

// ---------------------------------------------------------------- fixes after the second review

test('printCanvas, credits pacing without notifications: chunks of the driver (128 B), not 182', async () => {
  const dev = phomemo({ notify: dom('NotSupportedError', 'GATT Error: Not supported.') });
  const { g, ble } = load({ devices: [dev] });
  await ble.pair();
  const r = await g.RawBT.printCanvas(pixels(576, 6, () => BLACK), { driver: 'phomemo-m02pro', pacing: 'credits' });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(sizes(dev, CFF02).every((n) => n <= 128), JSON.stringify(sizes(dev, CFF02)));
  assert.strictEqual(r.result.chunk, 128);
});

test('printer gone in the pause after the last chunk: done false at once, no 10 s wait', async () => {
  let total = 0;
  const dev = phomemo({ credits: false, onFF02: (w, d) => { total += w.bytes.length; if (total >= 130) d.gatt.disconnect(); } });
  const { ble, PB } = load({ devices: [dev], scale: 1 });
  await ble.pair();
  const t0 = Date.now();
  const r = await ble.print(data(130), { transport: transport(PB), rows: 1 });
  assert.ok(Date.now() - t0 < 1500, 'no wait for the full timeout');
  assert.strictEqual(r.done, false);
});

test('startNotifications that never settles: after 10 s the job goes on with timers (done null)', async () => {
  const dev = phomemo();
  const { ble, PB, log } = load({ devices: [dev] });
  await ble.pair();
  dev.char(CFF03).startNotifications = () => new Promise(() => {});
  log.length = 0;
  const r = await ble.print(data(130), { transport: transport(PB), rows: 1 });
  assert.deepStrictEqual([r.notifications, r.done], [false, null]);
  assert.ok(log.indexOf('t10000') >= 0, 'the 10 s bound was set');
});

test('an image still loading is refused (code image), not printed as blank paper', async () => {
  const { g, PB } = load();
  const img = { complete: false, naturalWidth: 0, naturalHeight: 0, width: 100, height: 50 };
  assert.throws(() => PB.encodeImage(img, 'escpos'), /not finished loading/);
  const r = await g.RawBT.printCanvas(img, { driver: 'escpos', via: 'app' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'image']);
});

test('printCanvas with an explicit driver: a bad option is refused before the chooser opens', async () => {
  const dev = phomemo();
  const L = load({ devices: [dev] });
  const r = await L.g.RawBT.printCanvas(pixels(576, 1, () => BLACK), { driver: 'phomemo-m02pro', density: 3 });
  assert.deepStrictEqual([r.ok, r.code], [false, 'driver']);
  assert.strictEqual(L.nav.requests.length, 0, 'no chooser opened');
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
