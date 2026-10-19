# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries
before 1.10.0 are in Italian.

## 1.13.0 — Landing page, Web Serial, English and Italian

Print Bridge now also prints from a computer without the app: **Web Serial** reaches
USB-serial printers and Bluetooth Classic printers paired in the system. The pages and the
messages of `escpos.js` are in **English and Italian**, the home page on Pages is a new
**landing page** and the app test page moves to `app.html`. Read **Changed** before
updating: some texts and results differ from 1.12.0.

### Added

- **Landing page** `index.html`, the home page on Pages: what Print Bridge is and its three
  ways (app, Web Bluetooth, Web Serial); **What works on this device** (platform, browser,
  Web Bluetooth, Bluetooth radio, Web Serial, the app); **What to use here**, with the page
  or the download that fits; the pages and the documentation; an example to copy. The app
  is asked only when **Check the app on this device** is pressed, so the page never
  triggers Chrome's "Apps on device" prompt by itself.
- **Direct printing over Web Serial, `RawBT.serial`** in `escpos.js`, without the app:
  USB-serial printers (CH340, PL2303, FTDI, CP210x) and Bluetooth Classic printers paired in
  the system (Serial Port Profile over RFCOMM).
  - Where: Chrome and Edge on a computer (Bluetooth Classic since 117), Firefox 151 or later
    on a computer (USB printers, after the site permission add-on Firefox offers), Chrome 138 or later on
    Android (Bluetooth Classic only, wired USB not yet). Not Safari, iPhone and iPad, or
    Firefox for Android.
  - `pair({ filters, bluetoothServiceClassIds, baudRate })` opens the port chooser in the tap
    (the Serial Port Profile is always allowed); `reconnect()` reopens, without a tap, the
    port the browser remembers for the site; `print(bytes, { onProgress })` queues the print and
    writes 256-byte chunks with 25 ms pauses, as the app does over SPP; `setBaudRate` (9600
    to 115200), `disconnect`, `forget`, `saved`, `info`, `on`, `explain`.
  - Every write races a 10 s timeout that aborts the writer: a printer that is off, out of
    paper or holding the line fails the print with code `write`, and the queue goes on.
  - `reconnect()` and a print started together share one open. An unplugged port is dropped
    but remembered (`printbridge.serial` in `localStorage`), so `reconnect()` finds the
    printer plugged in again without the chooser.
  - `forget()` also revokes a remembered port that is unplugged or closed; after it,
    `reconnect()` does not take the only listed port until the next `pair()`
    (`printbridge.serial.forgotten`).
  - Errors are `PrintBridgeSerialError` with code `unsupported`, `baud`, `no-port`, `open`,
    `write` or `closed`.
- **`via: 'serial'`** in `RawBT.printLayout`, `RawBT.printCanvas`, `RawBT.chooseVia` and
  `RawBT.setVia`. With `'auto'` the order is: saved preference, BLE printer paired in this
  tab, serial port open in this tab, app that answered `RawBT.check()`, BLE printer from an
  earlier visit, serial port from an earlier visit, app. New `reason` values `serial-open`
  and `serial-remembered`. Images go to a serial port with the `escpos` driver; the Phomemo
  drivers stay BLE only.
- **`serial.html`**, direct printing over Web Serial, on Pages: compatibility checks; the
  **Printer** card (state, port, **Speed (baud rate)**, **Choose port**, **Reconnect**,
  **Disconnect**, **Forget**); test prints (plain text, accents, receipt with QR, the
  built-in `receipt` layout, a test image with a preview of its dots); **Advanced** (paper
  width, code page); help for each platform; a log to copy.
- **Messages in English and Italian.** `PrintBridge.translations` has one table per
  language, `{ en, it }`, with the same keys and `{name}` placeholders;
  `PrintBridge.messages` is the English table. They cover the layout and image errors,
  `RawBT.ble.explain`, `RawBT.serial.explain` and the errors about the app.
  - `RawBT.language()` returns `'en'` or `'it'`: the language set with
    `RawBT.setLanguage('it' | 'en' | 'auto')`, otherwise the first browser language with a
    table, otherwise English.
  - `RawBT.setLanguage` keeps the choice in `localStorage` under `printbridge.lang`, shared
    by the pages of the same site; a language without a table throws an error with code
    `language`.
  - Another language is one more table; a key missing from it falls back to English.
- **Pages in English and Italian**: `index.html`, `app.html` (and the copy served by the
  app), `ble.html` and `serial.html` open in the language of `RawBT.language()` and have an
  **EN | IT** switch in the header.
- **`README.it.md`**, the Italian translation of the README.
- **For AI coding agents**, served on Pages as they are: `llms.txt`, the short index for
  LLMs; `llms-full.txt`, a self-contained integration reference; the agent skill
  `skills/print-bridge/SKILL.md` (Agent Skills format), with step-by-step instructions and
  code templates to add thermal printing to a web page.
- `docs/desktop-companion.md` (in Italian `docs/desktop-companion.it.md`): what browsers
  reach on a computer and what they cannot (USB printers installed with the vendor's driver,
  network printers on port 9100), and the design of a native desktop app answering the same
  local API as the Android app. A proposal, not implemented.
- Node tests, also run by CI: `test/serial-test.js` (`RawBT.serial` with a fake Web Serial:
  chunks, pauses, write timeouts, queue, shared open, unplugging, speed, `via: 'serial'`)
  and `test/i18n-test.js` (the language from the browser, `setLanguage`, the two tables, the
  messages in both languages, and the page labels the messages quote, checked against the
  dictionaries of `ble.html` and `serial.html`).

### Changed

- **The home page on Pages is the landing page.** The app test page, `index.html` until
  1.12.0, is now `app.html`, still identical to `android/app/src/main/assets/test.html`
  except the `src` of `escpos.js`. The Pages test address in the app points to `app.html`.
- **The built-in `receipt` layout follows the language** of `RawBT.language()`, as the app
  prints `POST /receipt` in the language of the device: "Receipt no." or "Ricevuta n.",
  "TOTAL EUR" or "TOTALE EUR", `yyyy-MM-dd HH:mm` or `dd/MM/yyyy HH:mm`, a decimal point or
  a comma in the item amounts and in the computed total. In 1.12.0 it always printed the
  Italian receipt: a page in Italian prints as before, one in English now prints the English
  receipt. `RawBT.setLanguage('it')` keeps the old print.
- **Messages follow the language.** The errors of `RawBT.ble` and about the app, in Italian
  until 1.12.0, are now in English unless the browser (or `RawBT.setLanguage`) asks for
  Italian; the layout and image errors, in English in 1.12.0, are in Italian when the
  language is Italian. Pages that test the text of `error` should test `code` instead.
- **The BLE channel chosen by hand is the profile `'manual'`** in `RawBT.ble.info()`: it was
  the Italian text `'scelto a mano'`. `ble.html` shows it as "chosen by hand" or "scelto a
  mano".
- When the app does not answer and the way was chosen automatically, the error also suggests
  a serial port; the BLE advice and `ble.html` point Bluetooth Classic printers to
  `serial.html` as well as to the app.
- **README in English**, the main language of the project, with the Italian translation in
  `README.it.md`, and new sections on languages, Web Serial, desktop and AI agents.
- **Code comments in English** in `escpos.js`, in the Kotlin sources and in the XML
  resources of the app; no change in behaviour.
- **Pages serves the files as they are**: a `.nojekyll` file turns Jekyll off, so
  `llms.txt`, `llms-full.txt` and `skills/print-bridge/SKILL.md` are published unchanged,
  and the Markdown files are no longer rendered as HTML pages on Pages (read them on
  GitHub).
- CI (`build-apk.yml`) also runs `test/i18n-test.js` and `test/serial-test.js`, checks the
  inline scripts of `app.html` and `serial.html`, and checks that `app.html`, no longer
  `index.html`, matches the test page of the app; `bump-version.yml` makes the same check.
- `test/layout-test.js` compares the `receipt` layout with `Receipt.kt` in English and in
  Italian, with the labels and date patterns read from the string resources of the app, and
  tests `RawBT.send` on Android and elsewhere; `test/ble-test.js` checks the messages in
  both languages and the profile `'manual'`.

### Removed

- `web-ble-test.html` and `web-ble-test2.html`, which only redirected to `ble.html` since
  1.9.0: use `ble.html`.

### Fixed

- **`RawBT.send` outside Android**: after a refused connection it opened the `rawbtprint:`
  scheme, which no app handles on a computer or an iPhone, and answered
  `{ ok: true, fallback: true }` for a print that never happened. The fallback now runs only
  on Android, recognised from `navigator.userAgentData.platform` or the user agent;
  elsewhere the result is `{ ok: false, error }`.
- **`labels` in the `receipt` layout**: `labels.code` and `labels.total` were ignored, so
  the same JSON printed other labels through the page than through the app
  (`POST /receipt`). They now win in both languages, as in the app: trailing spaces of
  `labels.code` are dropped, and an empty `labels.code` prints the number only.
- `RawBT.ble.explain` mixed two languages (the `no-notify` advice in English, the rest in
  Italian) and quoted a button that `ble.html` does not have ("Non trovo la stampante"
  instead of "Non trovo la stampante nell'elenco"). The labels the messages quote are now
  those of the pages, in both languages, and `test/i18n-test.js` keeps them aligned.

## 1.12.0 — Printer drivers for images: Phomemo M02 and M02 Pro

**Not yet tested on a real Phomemo printer.** The Phomemo drivers follow the protocol notes
in `docs/phomemo-m02.md`, checked against open-source projects that printed on a real M02
Pro from native apps; no source has printed on an M02 Pro from a Chrome page. Printing text
and layouts on ESC/POS printers does not change.

### Added

- **Printer drivers for images** in `escpos.js`: `PrintBridge.drivers`, all with the same
  shape `{ id, label, family, dpi, dots, widths, encode(bitmap, options), transport }`:
  - `escpos`: 203 dpi, 384 dots by default, up to 576; `ESC @`, `GS v 0` in bands of 128
    rows, `ESC d` feed, optional cut (`true` or `'partial'`). Sent with the usual write
    modes of `RawBT.ble`, or through the app;
  - `phomemo-m02`: Phomemo M02, 203 dpi, 384 dots;
  - `phomemo-m02pro`: Phomemo M02 Pro, 300 dpi, 576 dots by default, 624 allowed (the
    printable width is disputed between the sources: calibrate before using 624).
  - The Phomemo job is `ESC @`, `1F 11 02 NN` (density 1, 2 or 4, default 4), `ESC a`
    (`01` centre, `00` with `align: 'left'`, `02` with `align: 'right'`, the last not yet tried on a Phomemo), `GS v 0` in blocks of at most 255 rows with the
    exact row count, `ESC d` feed (default 3). Optional `escape0A` (data bytes `0x0A` sent
    as `0x14`), off by default. No other `1F 11` command is sent and none is built from page
    input.
- **`PrintBridge.toBitmap(src, { width, dither, threshold, align })`**: a canvas, an
  `OffscreenCanvas`, an image or an `ImageBitmap` (drawn on white, scaled down to the width,
  never up) or `ImageData` (used as it is) to a 1-bit bitmap `{ width, height, bytesPerRow,
  data }`, most significant bit first, 1 = black. Floyd-Steinberg dithering (default) or a
  threshold (default 128); transparency is paper.
- **`RawBT.printCanvas(src, options)`**, also `PrintBridge.printCanvas`: prints an image
  with a driver and never rejects, like `RawBT.printLayout`. `driver: 'auto'` (default)
  takes it from the name of the paired BLE printer (`M02 Pro` → `phomemo-m02pro`, `M02` →
  `phomemo-m02`, other `M02…` names → choose by hand, anything else → `escpos`); Phomemo
  drivers print only over BLE. Options `via`, `width`, `dither`, `threshold`, `align`,
  `feed`, `cut`, `density`, `pacing`, `escape0A`, `onProgress`. Result `{ ok, via, reason,
  driver, bytes, rows, ms, result }`, or `{ ok: false, …, error, code }` with
  `cancelled: true` when the chooser was closed.
- `PrintBridge.encodeImage(src, driver, options)` returns `{ driver, bitmap, bytes }`
  without printing; `PrintBridge.driverFor(name)` maps a BLE name to a driver;
  `PrintBridge.pacings` lists the Phomemo pacings.
- **Phomemo over Web Bluetooth** in `RawBT.ble.print(bytes, { transport, rows })`: the
  driver's channel (service `FF00`, write `FF02`, whatever channel was chosen when pairing),
  notifications on `FF03`, paced writes without response (`standard`, the default, 128 B
  every 20 ms, the baseline a native app (danielgormly/phomo) printed with on a real M02 Pro; `slow` 60 B every 20 ms;
  `credits` up to 182 B per `01 01` credit, falling back to 128 B every 20 ms without notifications or after 1.5 s with no credit, `flow: 'credits+delay'`), retry on transient write errors, then the wait for "print complete" (`1A 0F 0C`)
  for at most 10 s + 40 ms per row, or 2 s without notifications. The result adds `flow`,
  `notifications`, `done` (`true`, `false` or `null`), `warnings` (`paper-out`,
  `cover-open`, `too-hot`) and `frames`.
- **`RawBT.ble.phomemoStatus()`**: firmware, battery, paper, cover and temperature, with
  the five read-only status queries `1F 11 07`, `08`, `11`, `12`, `13` and nothing else.
  Needs notifications on `FF03`, otherwise it rejects with code `no-notify`.
- `docs/phomemo-m02.md`: the protocol notes behind the driver, with their sources, the
  contradictions between them and a test plan for a real printer.

### Changed

- The BLE chooser also lists printers whose name starts with `M02`: the Phomemo M02 family
  advertises only the service `FEE7`, so it cannot be found by service.
- `RawBT.ble.explain` explains the new `no-notify` error.
- After a Phomemo print `RawBT.ble.info()` reports the profile `Phomemo` and the
  characteristic `FF02`, the channel the driver switched to.
- `PrintBridge.messages` has the texts of the new errors (driver, image, width, dithering,
  density, pacing), to translate them.

## 1.11.1 — Big characters with GS !

### Fixed

- **`EscPos.size(w, h)`**, in `escpos.js` and in the app, now sends `GS !`, the character
  size command. It sent `ESC !` with the same bits, which the ESC/POS standard reads as
  print modes:
  - `size(2, 2)` gave font B and double height instead of twice the size;
  - `size(2, 1)` gave double height instead of double width;
  - `size(1, 2)` gave font B, the smallest print;
  - the bold set before with `ESC E` was switched off.
- This affects the shop name, title and total of `POST /receipt` and the test prints of
  `ble.html` and `index.html`: they now print really enlarged, and the receipt keeps its
  bold, as `PrintBridge.layouts.receipt` does. A shop name longer than 16 characters (24
  on 80 mm paper) now wraps on the printer, because it is twice as wide.
## 1.11.0 — App in English and Italian

### Added

- The Android app is now available in **English** (default) and **Italian**. It follows
  the device language and falls back to English. On Android 13+ the language can be
  set for the app alone (per-app language).
- The language applies to the UI, the notification, the log, the self-test and the
  human-readable API messages (`message`, `detail`, `summary`, `error`).
- `POST /receipt` accepts an optional `labels` object, `{ "code": "...", "total": "..." }`,
  which sets the receipt labels regardless of the language.
- CI: `test/strings-check.js` checks the string resources before the Gradle build:
  - every key is in both languages;
  - placeholders are the same in both languages;
  - apostrophes and quotes are escaped;
  - every reference in the code exists;
  - each call passes the right number of arguments.

### Changed

- Receipts printed by the app follow the language too:
  - **Italian devices print exactly as before**;
  - in English they print "Receipt no.", "TOTAL EUR", a `yyyy-MM-dd HH:mm` date and a
    decimal point.
- Numbers are always formatted with Latin digits, so a device set to Arabic or Persian
  does not send the printer digits it cannot print.
- The notification channel name and description are updated at every start, in the
  current language.
- JSON keys and technical values do not change: levels `ok`, `warn`, `error` and the
  error code `not found`.

### Fixed

- The self-test recognises a busy printer from a flag, no longer from the text of the
  error, so it still reports a warning (not an error) when the language is not Italian.

## 1.10.0 — Print layouts

### Added

- **Print layouts**: `PrintBridge.render(layout, data, options)` in `escpos.js` returns
  the ESC/POS bytes of a JSON layout written once and filled with the data on every
  print. Blocks for logo, text with word wrap, columns (fixed, flexible, as wide as the
  text), `each` repetitions, groups, `if` conditions, rules, QR codes, feed, cut and raw
  bytes; `{{a.b}}` placeholders and the `euro`, `num`, `date`, `upper`, `lower` filters.
  Columns on 32 or 48 characters and 384 or 576 dots (or `columns`), big characters with
  `GS !`. No `eval`: layouts may come from a server, and control characters in the data
  are dropped.
- **One entry point for printing**: `RawBT.printLayout(layout, data, { via })`, also
  `PrintBridge.print`, sends the same bytes to `RawBT.ble.print` (`via: 'ble'`) or to
  `RawBT.sendApi` (`via: 'app'`). With `via: 'auto'`, the default, the way is chosen
  synchronously in the tap: saved preference, BLE printer paired in this tab, app that
  answered `RawBT.check()`, BLE printer from an earlier visit (the chooser opens in the
  same tap), then the app. The promise never rejects and the result is the same for both
  ways: `{ ok, via, reason, bytes, ms, result }` or `{ ok: false, …, error, code, cause }`.
- `RawBT.chooseVia(options)` shows the choice without printing; `RawBT.setVia('app' |
  'ble' | 'auto')` saves a preference in `localStorage` (`printbridge.via`).
- **`PrintBridge.layouts.receipt`**: the `POST /receipt` receipt as a layout, `width`
  included, so the same JSON as `RawBT.sendReceipt` prints the same way over BLE.
- Logos from a URL, a data URL, an image of the page or a ready-made raster: at most 240
  dots high, in 128-row bands, cached by URL, with clear errors when CORS is missing.
- The messages of the new API are in one table, `PrintBridge.messages`, ready to be
  translated.
- `ble.html`: **Layout receipt** card with layout and data editable in JSON, two examples
  (one is the app receipt), **Check without printing** and a print button.
- Node tests of the layouts and of the way chosen (`test/layout-test.js`), compared with
  a translation of `Receipt.kt` too; CI runs them.

### Changed

- README: «Print layouts» section (format, blocks, columns, filters, app receipt, logo and
  CORS, printing and the way).

## 1.9.0 — Stampa diretta via Web Bluetooth

### Aggiunto

- **`ble.html`**, pagina di stampa diretta su stampanti **BLE** senza app, pubblicata
  su Pages: controlli di compatibilità, **Abbina stampante**, **Riconnetti «nome»**,
  **Non trovo la stampante nell'elenco** (tutti i dispositivi), stato della
  connessione, stampe di prova (testo, accenti, scontrino con QR, scontrino con
  logo, anche da file) con barra di avanzamento, impostazioni avanzate (carta 58/80
  mm, code page, modalità di invio), **Diagnostica** dei servizi con scelta manuale
  del canale, guida ai problemi tipici e registro copiabile.
- **`RawBT.ble`** in `escpos.js`: `pair`, `reconnect`, `print` (in coda),
  `describe`, `useCharacteristic`, `setWriteMode`, `disconnect`, `forget`, `info`,
  `on`, `explain`. Profili `18f0/2af1`, `E7810A71`, ISSC, `ff00/ff02`, `ffe0/ffe1`,
  Nordic UART; scritture da 100 byte con conferma e ripiego automatico a 20 byte,
  oppure 20 byte senza conferma con pause; nuovi tentativi solo per gli errori in
  cui la scrittura non è partita; rifiuto delle «cat printer» non ESC/POS.
- L'abbinamento vale per tutta la scheda e la connessione resta aperta tra una
  stampa e l'altra. Dopo una ricarica basta un tocco (elenco filtrato sulla
  stampante già usata); con l'opzione di Chrome per i permessi persistenti la
  pagina si ricollega da sola.
- `EscPos.prototype.kanjiOff()` (`FS .`): esce dalla modalità caratteri cinesi, che
  su molti firmware stampa gli accenti come ideogrammi.
- Prove di `RawBT.ble` con un Bluetooth finto (`test/ble-test.js`), eseguite dalla CI.

### Modificato

- `web-ble-test.html` e `web-ble-test2.html` (prove della 1.8.0, non funzionanti)
  rimandano a `ble.html`.
- README: sezione sulla stampa BLE (stampanti compatibili, abbinamento, invio dei
  dati, API, limiti).

## 1.8.2 — Logo stampato a bande

### Corretto

- **Logo da URL (o da file) che degenerava in caratteri senza senso e bloccava la
  stampante.** Il logo era scalato a tutta larghezza senza limite d'altezza e inviato
  come un unico comando raster `GS v 0`. Molti firmware economici leggono l'altezza su
  un solo byte: oltre 255 righe stampano il resto dei pixel come testo, compresi byte
  che sembrano comandi (ritorno della carta, sovrastampa, blocco). Ora:
  - il logo è alto al massimo 240 punti (circa 3 cm) ed è centrato;
  - viene inviato in bande da al massimo 128 righe;
  - l'app lo scrive sulla stampante a pezzi da 256 byte con brevi pause, perché le
    stampanti economiche perdono byte se ricevono tutto il raster in un colpo;
  - i loghi molto grandi vengono sottocampionati in decodifica, invece di occupare
    decine di MB di memoria.
- Client web: `EscPos.rasterize(img, larghezza, soglia, { maxHeight, band })` crea le
  stesse bande da al massimo 128 righe e centra l'immagine su fondo bianco.

## 1.8.1 — Batteria e sospensione, autotest completo, nuovo aspetto

La causa del «caricamento infinito» dal browser era Android che sospendeva l'app in
background (ottimizzazione batteria e sospensione delle app in cache): verificato
sul tablet con LineageOS 18.1, disattivandole la stampa dal browser funziona.

### Aggiunto

- App: riga **Batteria e sospensione in background** nel pannello di stato
  (ottimizzazione batteria, limitazione in background, sospensione delle app in
  cache anche sul valore predefinito di Android 12+, «Sospendi attività app se non
  in uso», risparmio energetico) con il pulsante **Risolvi**, che dice cosa apre e
  porta all'impostazione giusta; avviso all'avvio per ogni problema che blocca
  l'app; avviso in testa alla notifica e in `GET /status` (campo `power`).
- App: **sospensione rilevata dal sintomo**: se il controllo periodico del servizio
  si ferma con il tablet acceso, l'app scrive nel registro «App sospesa dal sistema
  per N s» e la riga batteria resta rossa per mezz'ora, anche con impostazioni in
  apparenza corrette (ROM con ottimizzazioni proprie).
- App: **Autotest completo** con riepilogo copiabile: app e dispositivo, servizio,
  server, API, pagina di test, client web, Bluetooth, connessione alla stampante,
  batteria, notifiche (anche il canale del servizio) e, a scelta, una stampa di
  prova via API. Disponibile anche come `GET /selftest` e dalla pagina di test
  (`RawBT.selftest()`).
- App: card **Indirizzi di prova** con **Copia** e **Apri** (pagina di test locale,
  stato, autotest, Pages, URL CDN del client); **Copia** del registro.
- Marchio proprio dell'app, **Print Bridge**: icona adattiva e classica, icona di
  notifica, logo nell'intestazione e nella pagina di test, favicon.

### Modificato

- Nuova grafica dell'app (tema teal e ardesia, card arrotondate, pulsanti pieni e
  contornati) e della pagina di test (tema chiaro e scuro, stato con indicatori
  colorati, checklist dell'autotest).
- Il logo incluso nell'app è il logo neutro «Print Bridge»: l'app non è legata ad
  alcun marchio, e il logo degli scontrini si configura da file, URL o API.
  **Attenzione**: chi usava `{"logoMode":"asset"}` (o «logo incluso») ora stampa
  questo logo neutro. Per il proprio marchio usare `logoUrl` o «Da file».
- Scontrini di prova con un esempio neutro («NEGOZIO DEMO») e QR verso la pagina di
  test locale; script di prova da PC con ricevuta neutra; tolte dal repo le
  immagini di un cliente in `assets/`.
- Un autotest lanciato dal browser non colora più come «lenta» la riga delle
  chiamate e, durante l'autotest, la pagina disattiva i pulsanti di stampa.
- Edge-to-edge di Android 15: la schermata lascia spazio alle barre di sistema.

### Corretto

- I loghi PNG con sfondo trasparente non escono più come un blocco nero: la
  trasparenza viene composta sul bianco della carta.
- `serve.ps1` serve `index.html` (prima rimandava a una pagina che non esisteva più).
- Pagina di test di nuovo completa (vedi 1.8.0).

## 1.8.0 — Pagina sperimentale Web Bluetooth (nessuna Release APK)

- Aggiunta `web-ble-test.html`, prova di stampa via Web Bluetooth. Funziona solo con
  stampanti **BLE**: le stampanti Bluetooth Classic (SPP) restano raggiungibili
  solo tramite l'app.
- Nel riallineamento con il repository, `test.html` e `index.html` sono rimasti
  troncati (solo il tag script della CDN 1.6.1, senza logica): la pagina di test non
  funzionava, su Pages e nell'app. La CI ha fermato la build dell'APK, quindi la
  Release 1.8.0 non esiste. Il pacchetto npm 1.8.0 ha lo stesso `escpos.js` della
  1.7.0. La 1.8.1 ripristina le pagine complete.

## 1.7.0 — Stato e salute del bridge

### Aggiunto

- App: pannello **Stato del bridge** con i tre tratti (server API, chiamate dal
  browser, Bluetooth e stampante), aggiornato ogni 2 s; pulsanti **Riavvia server**
  e **Prova Bluetooth** (connessione SPP senza stampare).
- App: **autotest** del server ogni 15 s (`GET /status` su se stesso) con riavvio
  automatico se il server non è in ascolto o non risponde due volte di seguito.
- App: ogni chiamata ricevuta finisce nel registro (metodo, percorso, esito, ms
  dall'arrivo della richiesta, origine); il pannello mostra anche le richieste in
  corso, le connessioni aperte senza richiesta e il totale delle connessioni
  ricevute, per distinguere «mai arrivata», «arrivata e appesa» e «connessione
  senza richiesta». Il registro conserva le ultime 300 righe anche con l'app in
  background e segnala i buchi del watchdog (app sospesa).
- App: `GET /escpos.js` serve il client web incluso nell'APK; `GET /status` riporta
  `version`, `versionCode`, `server`, `calls` e `bluetooth`.
- Web: `RawBT.check()` con esito, durata e motivo dell'errore (`timeout`,
  `network`, `response`); timeout su tutte le chiamate, anche dove `fetch` ignora
  l'abort.
- CI: build firmata di prova sulle pull request (versione `<v>-pr<N>`, senza
  Release; le PR da fork firmano con la chiave debug); controlli di sintassi JS e
  di allineamento degli asset in build-apk e, prima del bump, in bump-version.

### Modificato

- La pagina di test servita dall'app carica `escpos.js` dall'app stessa e quella
  su Pages dalla radice del repo: niente più CDN pinnata a mano, funziona offline.
- La pagina di test mostra l'errore vero con i millisecondi e non blocca più la
  stampa se il controllo di stato fallisce; «Stampa tramite l'app» rimanda
  all'app l'ultima stampa tentata.
- `RawBT.send()` ripiega sull'intent solo se la connessione viene rifiutata subito,
  e allora restituisce `{ ok: true, fallback: true, confirmed: false, error }`
  (esito della stampa sconosciuto: non ritentare). Dopo un timeout non ripiega più
  e restituisce `{ ok: false, timeout: true, error }`. `RawBT.ping()` attende fino
  a 5 s (prima 1,5 s) e, come `check()`, accetta solo risposte con `"app": true`.
- Lo stato Bluetooth è calcolato in background: `/status` e l'autotest non
  dipendono più dalla velocità dello stack Bluetooth.
- Notifica del servizio con lo stato reale invece del testo fisso «In ascolto».
- La schermata dell'app scorre; il registro ha altezza fissa ed è selezionabile.

### Corretto

- **Chiamate a `/status` in coda dietro una appesa.** Chrome mette in coda le GET
  identiche dietro una ancora in corso (lock della cache HTTP), e il vecchio
  `ping()` non annullava mai la richiesta dopo 1,5 s. Bastava una `/status` appesa
  (per esempio in attesa del prompt LNA) per bloccare tutte le successive, da
  qualunque scheda e anche dalla barra degli indirizzi, finché Chrome non veniva
  riavviato. Ora tutte le chiamate usano `cache: 'no-store'` e un timeout che le
  annulla. Riprodotto in Chromium: la seconda richiesta passa da «in coda finché
  la prima non finisce» a circa 15 ms.
- Il ciclo di accept del server non può più terminare lasciando la porta aperta
  (il browser restava in caricamento infinito); errori ripetuti di accept non
  fanno più girare la CPU a vuoto.
- Un errore di scrittura Bluetooth non viene più riportato come stampa riuscita;
  un rifiuto immediato della connessione non appare più come «timeout dopo 8 s».
- La Release viene creata solo da tag o da avvio manuale su `main`.

## Rilascio iniziale

Prima versione del progetto **Raw BT Print Bridge**, così come introdotta nei
commit iniziali (`1af3fbe` … `9d1f86d`).

### Aggiunto

- App Android nativa `com.rawbtprint.bridge`: riceve `rawbtprint:base64,<dati>`,
  sceglie la stampante Bluetooth Classic (SPP) accoppiata e scrive i byte sulla
  stampante (`android/`).
- Libreria `escpos.js` lato web per generare ESC/POS (testo, logo raster, QR
  nativo) con trasporto `RawBT` configurabile.
- Pagine demo: `voto.html` (ricevuta di voto con logo + codice + QR),
  `ricevuta.html`, `print-test.html`.
- Script di utilità: `print-logo-receipt.ps1` (test locale su `COM9`) e
  `serve.ps1` (mini server HTTPS/HTTP locale su porta 8000).
- CI/CD: workflow `build-apk.yml` (compilazione APK e pubblicazione Release) e
  `opencode.yml` (flusso di sviluppo agentico issue → plan → build → review →
  merge → publish).
- Documentazione iniziale (`README.md`).

### Corretto

- `btAdapter` e funzione: va invocata con le parentesi (`d550a4b`).
- CI: uso di `sdkmanager` preinstallato al posto di `setup-android@v3`
  (`fae0f5a`).

### Modificato

- CI: aggiornate le GitHub Action deprecate legate a Node20 (`checkout@v6`,
  `artifact@v5`, `gradle@v5`, `release@v3`) (`25ce5e7`).
- CI: `upload-artifact` portato a `v7` (`9d1f86d`).
