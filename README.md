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
tablet può chiamarlo). La pagina web stampa con una semplice `fetch`.

API (tutte su `http://127.0.0.1:8787`):

| Metodo | Percorso   | Descrizione |
|--------|-----------|-------------|
| GET    | `/status` | stato app + stampante + configurazione |
| GET    | `/config` | legge la configurazione corrente |
| POST   | `/config` | aggiorna configurazione (larghezza carta, logo, stampante) |
| POST   | `/receipt`| **JSON scontrino**, l'app genera l'ESC/POS |
| POST   | `/print`  | ESC/POS grezzo in base64 (escape hatch) |

Esempio `POST /receipt`:

```json
{
  "v": 1,
  "shop": "CAMELOT",
  "title": "RICEVUTA",
  "subtitle": "Voto singolo",
  "code": "ABC123",
  "date": true,
  "lines": ["Buono regalo", "Uso entro 12 mesi"],
  "items": [{ "desc": "Caffe", "qty": 2, "price": 1.20 }],
  "total": "",
  "qr": "https://camelot.example/r/ABC123",
  "qrText": "Scansiona per la ricevuta",
  "footer": "Grazie e arrivederci",
  "logo": true,
  "width": 32,
  "cut": true,
  "feed": 3,
  "printer": "5A:4A:D5:BC:47:08"
}
```

Risposta: `{"ok":true,"bytes":N,"summary":"..."}` oppure `{"ok":false,"error":"..."}`.

**Configurazione dall'app** (persistente): larghezza carta **58 mm (32 colonne)**
o **80 mm (48 colonne)**, e **logo** caricabile da **file** o **URL** (o quello
incluso). La larghezza si applica automaticamente allo scontrino; `width` nel
JSON la può sovrascrivere. La pagina di riferimento è `receipt.html`.

Flusso lato pagina (`escpos.js`):

1. `RawBT.sendReceipt(spec)` → `POST /receipt` con JSON;
2. in alternativa `RawBT.send(bytes)` → `POST /print` con ESC/POS già pronto;
3. se l'app **non** risponde → **fallback**: apre l'app con lo scheme `rawbtprint:`.

Perché non "Web Bluetooth"? Funziona solo con stampanti **BLE**; la
`BlueTooth Printer` è **Classic SPP**, quindi non è utilizzabile.

Requisiti: l'app va avviata **almeno una volta** e va concesso il permesso
Bluetooth; poi resta attiva in background (notifica persistente "Raw BT Print
Bridge attiva"). Porta locale configurabile via `RawBT.apiPort`.

#### Local Network Access (LNA) — importante in produzione

Da Chrome **142+** una pagina su origine **pubblica** (es. `https://...`) che chiama
`127.0.0.1` è soggetta a **Local Network Access**: la richiesta è **bloccata** finché
l'utente non concede il permesso. Sintomi: in console errori tipo
`blocked by CORS policy ... Permission was denied for this request` (o
*"traffic to 127.0.0.1 not permitted"*) e `fetch` che vanno in **timeout**.

- Permesso per `127.0.0.1`: **`loopback-network`**, in Chrome si chiama
  **"App sul dispositivo"** (Chrome 145+); su **142-144** è `local-network-access`
  (**"Accesso alla rete locale"**).
- Al **primo** tentativo Chrome mostra un **prompt**: va premuto **Consenti**.
  Se è stato negato: icona **lucchetto** → *Impostazioni sito* → *App sul dispositivo*
  → **Consenti**, poi ricarica.
- **Kiosk/tablet controllati**: pre-approvabile via policy enterprise
  `LocalNetworkAccessAllowedForUrls` (Chrome) / `localnetworkaccessallowedforurls` (Edge).
- In `escpos.js`: `RawBT.localAccess()` restituisce `{ name, state }`;
  `RawBT.localAccessHint(state)` dà il messaggio con le istruzioni; le chiamate
  all'API locale usano `targetAddressSpace: 'loopback'`.

**Fallback senza LNA — scheme/intent.** La navigazione verso lo **scheme**
`rawbtprint:base64,<dati>` (o `intent://...#Intent;...`) è una *navigazione
top-level*: **non** è soggetta a LNA né a CORS. `RawBT.send()` la usa già come
fallback automatico quando la `fetch` non risponde. Cosa comporta:

| | API HTTP `127.0.0.1:8787` | Scheme/intent `rawbtprint:` |
|---|---|---|
| Permesso LNA | sì (una volta per sito) | no |
| Risposta JSON | sì (`ok`, `bytes`, `error`) | no (fire-and-forget) |
| Dimensione payload | nessun limite pratico | limitata dalla lunghezza URL |
| Contesto pagina | resta nel browser | l'app va in primo piano |

Consiglio: **API HTTP come principale** (con LNA), **scheme come fallback** per i casi
in cui il permesso non è disponibile.

### Integrare lo script nella pagina web

Lo script client e' `escpos.js` (espone `EscPos` e `RawBT`). Si configura anche
via **meta tag**, senza scrivere JS:

```html
<meta name="rawbt-api-port" content="8787">
<meta name="rawbt-scheme" content="rawbtprint">
<script src="/assets/escpos.js"></script>
<script>
  RawBT.sendReceipt({
    shop: "CAMELOT", title: "RICEVUTA", code: "ABC123",
    items: [{ desc: "Caffe", qty: 2, price: 1.20 }],
    qr: "https://camelot.example/r/ABC123", footer: "Grazie"
  }).then(function (r) { console.log(r); });
</script>
```

Come distribuire `escpos.js`:

- **jsDelivr da questo repo (pubblico)**, pinnato al tag:
  `https://cdn.jsdelivr.net/gh/nb-camelot/raw-bt-print-bridge@v<ver>/escpos.js`
  (oppure `@latest` / `@<ver>` con cache piu' breve: pinna il tag in produzione).
- **npm (trusted publishing, senza token)**: la CI pubblica ad ogni release il
  pacchetto `@nb-camelot/rawbt-print` (file `escpos.js`) su npmjs.org tramite
  **OIDC**. Uso: `https://cdn.jsdelivr.net/npm/@nb-camelot/rawbt-print@<ver>/escpos.js`
  o con range `@1`.
- **Self-hosting**: servitelo dal vostro dominio (`/assets/escpos.js`).
- **Asset di release GitHub**: NON includibili con `<script src>` (vengono serviti
  come download, `Content-Type: application/octet-stream`); utili solo per scaricarli.

> Nota: le pagine di test del repo (`receipt.html`, `voto.html`, `ricevuta.html`,
> `print-test.html`) caricano `escpos.js` **dalla CDN npm pinnata alla versione**
> della release (`https://cdn.jsdelivr.net/npm/@nb-camelot/rawbt-print@<ver>/escpos.js`),
> così validano proprio l'artefatto distribuito. Al rilascio di una nuova versione va
> aggiornata la versione nella `src` delle pagine.

Per attivare npm (una volta sola):

1. crea il pacchetto/scope `@nb-camelot` su npmjs.org;
2. su npm → *Package settings → Trusted Publisher* aggiungi: **GitHub Actions**,
   repository `nb-camelot/raw-bt-print-bridge`, workflow **`publish-web.yml`**;
3. non serve alcun `NPM_TOKEN`: la pubblicazione usa `id-token` (OIDC) + provenance.

La pipeline `bump-version.yml` dispaccia automaticamente `build-apk.yml` (APK) e
`publish-web.yml` (client web) dopo ogni bump di versione.

## CI/CD

- `.github/workflows/build-apk.yml` — compila gli APK release
  (`app-arm64-release-<v>.apk` e `app-release-<v>.apk` universale) su tag `v*`
  o manualmente, e pubblica la Release. La versione è letta da
  `android/app/build.gradle`. La release è **firmata con una keystore stabile**
  fornita dai secret (`SIGNING_KEYSTORE_BASE64`, `SIGNING_STORE_PASSWORD`,
  `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`): così tutte le release hanno la
  stessa firma e l'aggiornamento in-place funziona. Senza quei secret (build
  locale) si ricade sulla debug keystore.
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

