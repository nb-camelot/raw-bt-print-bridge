# Raw BT Print Bridge

Ponte tra una pagina web e una stampante termica **Bluetooth Classic (SPP)** su
Android. La web genera ESC/POS (logo + codice + QR) e lo invia all'app tramite
lo scheme `rawbtprint:`; l'app apre il socket SPP e scrive i byte sulla
stampante.

Progetto ispirato a [vibe-maribit/simple_order_manager](https://github.com/vibe-maribit/simple_order_manager).

## Contenuto

- `android/` — app Android nativa minimale (`com.rawbtprint.bridge`):
  riceve `rawbtprint:base64,<dati>`, sceglie la stampante accoppiata e stampa.
- `escpos.js` — libreria ESC/POS lato web (testo, logo raster, QR nativo) con
  trasporto `RawBT` configurabile.
- `voto.html` — pagina ricevuta di voto (logo + codice + QR).
- `ricevuta.html`, `print-test.html` — pagine demo.
- `print-logo-receipt.ps1` — test locale verso `COM9`.
- `serve.ps1` — mini server HTTPS/HTTP locale (porta 8000).
- `CHANGELOG.md` — storico delle modifiche.

## App Android

- **Nome**: Raw BT Print Bridge
- **Package**: `com.rawbtprint.bridge`
- **Scheme**: `rawbtprint`
- API `minSdk 23`, `targetSdk 35`.

Dalla web: `rawbtprint:base64,<payload-base64>` (vedi `escpos.js` → `RawBT.url`).
La prima volta l'app chiede quale stampante accoppiata usare e la memorizza.

### Comportamento e diagnostica

L'app mostra una schermata con **stampante selezionata**, **stato** corrente
(connessione/stampa/errore) e un **registro** con timestamp. Non esce da sola:
resta aperta per mostrare l'esito (esci con "Torna al browser").

- Il permesso `BLUETOOTH_CONNECT` è richiesto **all'avvio**, non durante la stampa.
- La connessione SPP ha un **timeout** (8s): il socket viene chiuso e l'errore è
  mostrato con un messaggio esplicativo, senza restare bloccata.
- La stampante viene "dimenticata" solo se risulta **non più accoppiata**; un
  errore transitorio non cancella la scelta.
- Pulsanti: **Scegli stampante**, **Stampa di prova**, **Dimentica stampante
  (ripristina)**, **Torna al browser**.

> Nota SPP: Bluetooth Classic ammette **una sola connessione alla volta**. Se il
> PC tiene aperto `COM9` (o un'altra app usa la stampante), l'app va in timeout.
> Libera la porta sull'altra parte e riprova.

### Stampa senza uscire dal browser (API locale)

L'app non richiede più di "saltare" fuori dal browser: gira in un **Foreground
Service** e ospita un **mini server HTTP locale** su `127.0.0.1:8787` (solo il
tablet può chiamarlo). La pagina web stampa con una semplice `fetch`:

```
POST http://127.0.0.1:8787/print   body = ESC/POS in base64
GET  http://127.0.0.1:8787/status  → { app, state, detail, device }
```

Flusso lato pagina (`escpos.js` → `RawBT.send`):

1. prova l'API locale dell'app;
2. se l'app **non** risponde (non avviata / permesso negato), **fallback**: apre
   l'app con lo scheme `rawbtprint:` (comportamento precedente).

Perché non "Web Bluetooth"? Funziona solo con stampanti **BLE**; la
`BlueTooth Printer` è **Classic SPP**, quindi non è utilizzabile.

Requisiti: l'app va avviata **almeno una volta** e va concesso il permesso
Bluetooth; poi resta attiva in background (notifica persistente "Raw BT Print
Bridge attiva"). Porta locale configurabile via `RawBT.apiPort`.

## CI/CD

- `.github/workflows/build-apk.yml` — compila gli APK release
  (`app-arm64-release-<v>.apk` e `app-release-<v>.apk` universale) su tag `v*`
  o manualmente, e pubblica la Release. La versione è letta da
  `android/app/build.gradle`.
- `.github/workflows/bump-version.yml` — ad ogni push/merge su `main` calcola il
  nuovo numero di versione (semver), aggiorna `versionName`/`versionCode`, fa
  commit `chore(release): vX.Y.Z` e avvia `build-apk.yml` → nuova Release.
- `.github/workflows/opencode.yml` — flusso di sviluppo agentico autonomo
  **issue → plan → build → review → merge → publish**. Vedi sotto.

### Versioning automatico

Al merge di una PR su `main`, `bump-version.yml` deduce il tipo di bump dal
messaggio di commit (conventional commits):

| Trigger nel commit | Bump |
|---|---|
| `feat:` / `feat(scope):` | minor |
| `!:` o `BREAKING CHANGE` o `[semver:major]` | major |
| `[semver:minor]` | minor |
| tutto il resto (o `[semver:patch]`) | patch |

Override manuale: esegui `bump-version.yml` con `release_type` = `patch|minor|major`.
Per saltare il bump/release includi `[skip release]` nel commit.


## Sviluppo agentico (OpenCode)

Flusso attivato commentando `/oc` o `/opencode` in una issue, in un commento o
in un commento di review di una PR (oppure manualmente con `Run workflow` su
`opencode.yml`). Il workflow:

1. **Authorize** — solo owner/collaborator/member o utenti in
   `vars.OPENCODE_ALLOWED_USERS`.
2. **Plan** — produce `issue_plans/<branch>.md` (sola lettura) e lo committa.
3. **Build & Review loop** — l'agente `build` implementa il piano, l'agente
   `reviewer` verifica i criteri (`VERDICT: PASS/FAIL`), fino a
   `MAX_ITERATIONS` (4).
4. **PR** — apre/aggiorna la PR, risolve i conflitti con `main`.
5. **Auto-merge** — squash-merge su `main` solo se `VERDICT: PASS`.
6. **Publish** — il merge avvia `bump-version.yml` → bump versione →
   `build-apk.yml` → APK nella Release.

### Configurazione del repository (Settings → Secrets and variables → Actions)

**Variables** (opzionali):

| Variabile | Default | Descrizione |
|---|---|---|
| `OPENCODE_ALLOWED_USERS` | *(vuoto)* | Utenti extra autorizzati (separati da spazio) |
| `OPENCODE_DEFAULT_MODEL` | `opencode/big-pickle` | Modello di default |
| `OPENCODE_VISUAL_MODEL` | `opencode/space-bunny-free` | Modello per issue con immagini |

**Secrets** (opzionali, solo per provider a pagamento):

`OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

Esempi di comando: `/oc aggiungi il supporto per il taglio parziale`,
`/oc --model opencode/big-pickle correggi il bug #12`.

## Test locale (PC)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1   # server su :8000
powershell -NoProfile -ExecutionPolicy Bypass -File .\print-logo-receipt.ps1 -Port COM9 -Code "XXXX-XXXX"
```

Apri `http://<ip-del-pc>:8000/` dal tablet o dal PC. La pagina `print-test.html`
mostra lo **stato della stampante sul PC** e permette di stampare direttamente
sulla porta seriale.

### API del server locale

| Metodo | Percorso | Descrizione |
|---|---|---|
| `GET` | `/api/printer` | Stato stampante: `{ port, bluetooth, present, openable, error, checkedAt }` |
| `POST` | `/api/print` | Body = payload **base64** (ASCII) → scritto sulla porta seriale. Risponde `{ ok, bytes, port }` |

Esempio:

```powershell
Invoke-RestMethod http://localhost:8000/api/printer
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("`e@ciao`n`n`n"))
Invoke-RestMethod http://localhost:8000/api/print -Method POST -Body $b64
```

