---
name: print-bridge
description: "Add thermal printing to a web page with Print Bridge (escpos.js, npm @nb-camelot/rawbt-print). Use when a web app must print receipts, tickets, labels, QR codes or images on a nearby thermal printer straight from the browser (ESC/POS 58/80 mm receipt printers, Phomemo M02 and M02 Pro), through the Print Bridge Android app, Web Bluetooth, Web Serial or the rawbtprint scheme, or when code already uses RawBT, EscPos, PrintBridge, printLayout or printCanvas."
---

# Print Bridge: add thermal printing to a web page

Print Bridge is one browser script, `escpos.js`, that builds ESC/POS bytes and sends them to a nearby thermal printer in one of four ways: the Print Bridge Android app (`via: 'app'`, local API on `127.0.0.1:8787`), Web Bluetooth (`via: 'ble'`), Web Serial (`via: 'serial'`) or the `rawbtprint:` scheme (fallback). It defines the globals `EscPos`, `RawBT` and `PrintBridge`.

Full reference, with every option, result and error code: https://nb-camelot.github.io/raw-bt-print-bridge/llms-full.txt. Read it when a detail is not here. When it and `escpos.js` disagree, the code wins.

## Step 1. Find the platform and the printer

Establish, from the codebase or by asking the user:

1. **Where the page prints**: device and browser (Android with Chrome, a computer with Chrome or Edge, Firefox, iPhone or iPad) and whether the page is served over `https://` or `localhost` (required for BLE and serial).
2. **The printer**: an ESC/POS receipt printer (58 mm = 32 columns, 80 mm = 48 columns) or a Phomemo M02 / M02 Pro; how it connects: Bluetooth Classic (SPP), Bluetooth LE, USB showing up as a serial (COM) port, USB installed with a vendor driver, or network.
3. **What to print**: a standard receipt, a custom layout, or an image or label drawn on a canvas.
4. **Whether the Print Bridge Android app may be installed** on the device.

| Platform, browser | App | Web Bluetooth | Web Serial | Scheme |
|---|---|---|---|---|
| Android, Chrome | yes | yes | Chrome 138+: Bluetooth Classic paired in Android only, no USB | yes |
| Windows, macOS, ChromeOS: Chrome or Edge | no | yes | yes (USB-serial; Bluetooth Classic since 117) | no |
| Linux: Chrome or Edge | no | only behind a flag (experimental, not supported) | yes (USB-serial; Bluetooth Classic since 117) | no |
| Firefox on a computer | no | no | 151+: USB-serial only (Bluetooth Classic not documented), after the site permission add-on Firefox offers | no |
| Safari, any browser on iPhone or iPad | no | no | no | no |

Firefox on Android has neither Web Bluetooth nor Web Serial; the app and the scheme are documented with Chrome. Not reachable from any browser: USB printers installed with the vendor driver (not a COM port) and network printers on TCP 9100. Say so instead of writing code that cannot work.

## Step 2. Pick the way

- **Phomemo M02 / M02 Pro**: `RawBT.printCanvas` with `driver: 'phomemo-m02'` or `'phomemo-m02pro'`; always BLE; images only (draw text on a canvas). Not yet tested on a real Phomemo: tell the user.
- **Android, Bluetooth Classic (SPP) printer paired in Android's Bluetooth settings** (most receipt printers): `via: 'app'` (the default way; the user installs the app from https://github.com/nb-camelot/raw-bt-print-bridge/releases/latest and chooses the printer in it). Without the app, Chrome 138+ reaches the same printer over Web Serial (`via: 'serial'`). The app speaks only Bluetooth Classic (SPP): a BLE-only printer cannot print through it.
- **BLE printer, Android or computer** (the only way for a BLE-only printer; no app needed): `via: 'ble'` (`RawBT.ble`, the way `ble.html` prints).
- **Computer, USB-serial printer or Bluetooth Classic printer paired in the system**: `via: 'serial'`.
- **Several devices with different setups**: omit `via` (`'auto'`) and let each device fix its way with `RawBT.setVia('app' | 'ble' | 'serial')`, for example from a settings screen.
- Use **one way per printer**: a printer connected to the app is busy for BLE, and a serial port open in a tab is busy for other programs.

## Step 3. Include the script

```html
<script src="https://cdn.jsdelivr.net/npm/@nb-camelot/rawbt-print@VERSION/escpos.js"></script>
```

Replace `VERSION` with an exact version: the latest one is printed by `npm view @nb-camelot/rawbt-print version` (or see the CHANGELOG). 1.13.0 has the app, `RawBT.ble`, layouts, `printCanvas`, `RawBT.serial` and `RawBT.setLanguage`; `RawBT.serial` (`via: 'serial'`) and `RawBT.setLanguage` need 1.13.0 or later. Do not use `@1` in production, and never a GitHub Release asset (served as a download). Self-hosting the file is fine. It is a plain script with globals, not a module: no server-side rendering.

## Step 4. Write the print handler

The golden rule: **the print call is the first thing the tap handler does.** `RawBT.printLayout`, `RawBT.printCanvas`, `RawBT.ble.pair` and `RawBT.serial.pair` open the browser's printer or port chooser, which works only during the user's tap. No `await`, `.then`, `fetch` or `setTimeout` before them; load the data before the tap. `printLayout` and `printCanvas` never reject: check `r.ok`, and show `r.error` unless `r.cancelled`. `ble.pair` and `serial.pair` resolve to the printer or port info and **reject** on failure: always add a rejection handler that passes the error to `RawBT.ble.explain(e)` / `RawBT.serial.explain(e)` and shows the message unless it is `''` (the person closed the chooser).

### A. The standard receipt (built-in `receipt` layout)

```js
var receipt = {                       // the same JSON as POST /receipt of the app
  shop: 'DEMO SHOP', title: 'RECEIPT', code: 'ABC123',
  items: [{ desc: 'Coffee', qty: 2, price: 1.20 }],   // amount = qty x price
  qr: 'https://example.com/r/ABC123', footer: 'Thank you'
  // optional: subtitle, lines: [...], total (printed as given), date (default now), width,
  // labels: { code: 'Order', total: 'TOTAL' }, logo: true (needs options.logo), feed, cut
};
document.getElementById('print').onclick = function () {
  RawBT.printLayout('receipt', receipt, { via: 'ble', paper: 58 }).then(function (r) {
    if (r.ok) console.log('printed via', r.via, r.bytes, 'bytes in', r.ms, 'ms');
    else if (!r.cancelled) alert(r.error);
  });
};
```

Set `via` from step 2 (or leave it out for `'auto'`) and `paper` to 58 or 80. The labels ("Receipt no.", "TOTAL EUR"), the date format and the decimal separator follow `RawBT.language()`. `labels.code` and `labels.total` replace only the two labels (an empty `code` label prints the number only). The date format and the decimal separator follow the language only: change them with `RawBT.setLanguage('en' | 'it')`. A `total` you pass is printed as given (the item amounts still follow the language). Through the app only, `RawBT.sendReceipt(receipt)` makes the app lay it out with the logo configured in the app.

### B. A custom layout

```js
var LAYOUT = {
  paper: 58,
  blocks: [
    { logo: 'logo.png', maxHeight: 160 },                        // same origin, data URL, or CORS
    { text: '{{shop}}', align: 'center', bold: true, size: [2, 2] },
    { rule: true },
    { row: ['Order {{order}}', '{{date|date:dd/MM/yy}}'] },
    { each: 'items', row: [{ text: '{{qty}} x {{name}}', wrap: true }, '{{price|euro}}'] },
    { rule: '=' },
    { row: ['TOTAL', '{{total|euro}}'], bold: true, size: [1, 2] },
    { if: 'qr', blocks: [{ feed: 1 }, { qr: '{{qr}}', size: 5 }] },
    { if: 'note', text: '{{note}}', align: 'center' },
    { feed: 3 },
    { cut: true }
  ]
};
// currentOrder, ready before the tap: { shop, order, date: true, items: [{ qty, name, price }],
// total, qr, note }
document.getElementById('print').onclick = function () {
  RawBT.printLayout(LAYOUT, currentOrder, { via: 'ble' }).then(function (r) {
    if (!r.ok && !r.cancelled) alert(r.error);
  });
};
```

Blocks: `text`, `row`, `each`, `blocks` (group), `logo`, `rule`, `qr`, `feed`, `cut`, `raw`; any block may have `if` (`'a'`, `'!a'`, `'a && b'`, `'a || b'`). Filters: `euro`, `num`, `date`, `upper`, `lower`. **`euro`, `num` and `date` use Italian formats** (`1.234,50`, `dd/MM/yyyy HH:mm`) in every language: for other formats pre-format the values in the data, or register `PrintBridge.filters.name = function (value, argument) { ... }`. Layouts are plain JSON (no code runs), so they can come from a server.

### C. An image or label (`printCanvas`)

```js
var DRIVER = 'escpos';                // or 'phomemo-m02', 'phomemo-m02pro'
var WIDTH = PrintBridge.drivers[DRIVER].dots;   // the driver's default (384 for escpos); 576 for an 80 mm ESC/POS printer
function drawLabel(text) {
  var c = document.createElement('canvas');     // drawn exactly as wide as what is printed
  c.width = WIDTH; c.height = 160;
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000'; ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, WIDTH / 2, 80);
  return c;
}
document.getElementById('print').onclick = function () {
  RawBT.printCanvas(drawLabel('Hello'), { driver: DRIVER, width: WIDTH, dither: 'threshold', via: 'ble' })
    .then(function (r) {
      if (!r.ok && !r.cancelled) alert(r.error);
      else if (r.ok && r.result && r.result.warnings && r.result.warnings.length) alert(r.result.warnings.join(', '));
    });
};
```

For an 80 mm ESC/POS printer set `WIDTH` to 576: the canvas and the `width` option must match, because images are never scaled up (a narrower one is centred). `dither: 'threshold'` for text, lines and QR codes; the default `'floyd-steinberg'` for photos. Phomemo drivers ignore `via` and always use BLE; `via: 'app'` or `'serial'` with them is an error.

### D. A "Pair printer" button (BLE)

```js
var ble = RawBT.ble;
var label = document.getElementById('printerState');
ble.on(function (info) { label.textContent = (info.name || '-') + ': ' + info.status; });
document.getElementById('pair').onclick = function () {
  ble.pair().then(null, function (e) { var m = ble.explain(e); if (m) alert(m); });
};
document.getElementById('pairAll').onclick = function () {       // "I can't find the printer"
  ble.pair({ all: true }).then(null, function (e) { var m = ble.explain(e); if (m) alert(m); });
};
```

The pairing lasts while the tab is open. After a reload, a tap on print (`via: 'ble'`) reopens the chooser filtered on the same printer.

### E. A "Choose port" button (Web Serial)

```js
var serial = RawBT.serial;
if (serial && serial.supported()) {
  var speed = document.getElementById('speed');  // <select>: 9600 19200 38400 57600 115200
  speed.value = String(serial.info().baudRate);  // the saved speed, 9600 by default
  serial.reconnect().catch(function () {});      // at load: reopens the remembered port, no tap
  document.getElementById('port').onclick = function () {
    // No baudRate here: the port opens at the saved speed, the one the select shows.
    serial.pair().then(null, function (e) { var m = serial.explain(e); if (m) alert(m); });
  };
  speed.onchange = function () {
    serial.setBaudRate(this.value).catch(function (e) { alert(serial.explain(e)); });
  };
}
```

The speed matters only for USB-serial printers (often 9600 or 115200; random characters mean a wrong speed). One program at a time per port.

### F. Checking the app

`RawBT.check()` calls `127.0.0.1:8787`; on a public `https://` page Chrome 142+ then asks for the "Apps on device" permission. Call it at page load **only** on pages that print through the app (it lets `'auto'` pick the app); otherwise call it from a button:

```js
var appState = document.getElementById('appState');   // an element that shows the answer
function show(text) { appState.textContent = text; }
document.getElementById('checkApp').onclick = function () {
  RawBT.check(8000).then(function (r) {
    if (r.ok) { show('App ' + r.status.version + ' ready'); return; }
    RawBT.localAccess().then(function (a) {
      show(a && a.state === 'denied' ? RawBT.localAccessHint('denied')
        : 'The app did not answer (' + r.reason + '): open it and try again.');
    });
  });
};
```

Never retry a print after a `timeout`, or after `RawBT.send` fell back to the scheme (`fallback: true`): it may already be printing.

## Step 5. Language

Messages and the `receipt` labels are in English or Italian: `RawBT.language()` follows the browser. When the host app has its own language setting, apply it at load (it is stored in `localStorage` under `printbridge.lang`):

```js
if (RawBT.setLanguage) RawBT.setLanguage(appLanguage === 'it' ? 'it' : 'en');   // 'auto' = browser
```

Other languages: add `PrintBridge.translations.xx = { ... }` (missing keys fall back to English).

## Step 6. Test

- Without a printer: `PrintBridge.render(layout, data, { now: new Date(2026, 0, 1) })` resolves to the bytes, and `RawBT.chooseVia({ via })` shows the way. It also runs in Node with a stub `window` (snippet in llms-full.txt, section 15).
- Fake devices: the repository tests are patterns for a fake `navigator.bluetooth`, `navigator.serial`, Phomemo and `fetch` (`test/ble-test.js`, `test/serial-test.js`, `test/driver-test.js`, `test/i18n-test.js`, `test/layout-test.js` in https://github.com/nb-camelot/raw-bt-print-bridge).
- On the device, before blaming the code, try the printer on the Pages test pages: https://nb-camelot.github.io/raw-bt-print-bridge/ (what works here), `app.html` (the app), `ble.html` (BLE; its "Layout receipt" card checks a layout without printing), `serial.html` (Web Serial).
- Serve local tests from `http://localhost`, not from the PC's IP address: BLE and serial need a secure context.

## Pitfalls

- Print call not first in the tap handler -> `SecurityError` ("Choosing the printer needs a tap on a button.").
- `RawBT.check()` at load on a page that does not use the app -> an unexpected permission prompt.
- Logo or image from another domain without CORS -> `logo-load`, `logo-cors` or `image-cors`. Use the same origin, a data URL or enable CORS.
- The printer is connected elsewhere (the app, another phone, the vendor app) -> not found or `NetworkError`.
- Tab closed or in the background while printing -> the connection or port is lost.
- Phomemo: BLE and `printCanvas` only; never send any other `1F 11` command (unknown ones have been reported to brick an M02X), so never put `1F 11` in a layout `raw` block.
- Hand-built bytes (`new EscPos()`) must start with `.init().kanjiOff().codepage(16)`; text is Windows-1252.
- "Bluetooth 4.0" printers are often Classic only: no BLE, use the app or Web Serial.
- Android 11 and earlier: BLE scanning needs the Location permission and Location on.
- The app suspended by Android in the background (prints hang until the app is reopened): turn off battery optimization for the app.

## Done when

- The way (or `'auto'` with `RawBT.setVia`) matches the user's devices and printers.
- The script tag pins an exact version that has every API used.
- Every print and pair call is the first statement of a tap handler; every print result checks `r.ok` and `r.cancelled`, and every pair call has a rejection handler that shows `explain(e)` when it is not empty.
- The user knows what to install or pair (the app, the printer in the system settings) and which Pages test page to try first.
