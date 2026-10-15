# Changelog

Tutte le modifiche notevoli a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/).

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
