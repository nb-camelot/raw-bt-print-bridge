# Changelog

Tutte le modifiche notevoli a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/).

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
