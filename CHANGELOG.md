# Changelog

Tutte le modifiche notevoli a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/).

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
