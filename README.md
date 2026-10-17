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
- `index.html` — pagina di test pubblicata su GitHub Pages. È identica a
  `android/app/src/main/assets/test.html` (che l'app serve su
  `http://127.0.0.1:8787/`) salvo il percorso di `escpos.js`; la CI lo verifica.
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
- Pulsanti: **Scegli stampante**, **Prova stampa (via API)**, **Dimentica stampante
  (ripristina)**, **Torna al browser**, più **Riavvia server** e **Prova Bluetooth**
  nel pannello di stato.

#### Stato del bridge

In cima all'app un pannello mostra, aggiornato ogni 2 secondi, lo stato dei tre
tratti del ponte (pallino verde / giallo / rosso / grigio):

| Tratto | Cosa dice | Da dove viene |
|---|---|---|
| **Server API** | in ascolto da quanto, esito e durata dell'ultimo **autotest**, riavvii | il servizio chiama `GET /status` su se stesso ogni 15 s |
| **Chiamate dal browser** | ultima chiamata (metodo, percorso, esito, ms dall'arrivo della richiesta, origine), richieste **in corso** da quanto, connessioni aperte **senza richiesta**, totale connessioni ricevute | ogni connessione che arriva al server (l'autotest è escluso) |
| **Bluetooth e stampante** | Bluetooth acceso, stampante scelta e accoppiata, esito dell'ultima connessione | stato di Android + ultima stampa o **Prova Bluetooth** |

- **Autoriparazione**: se il server non è in ascolto, o l'autotest fallisce due
  volte di seguito, il servizio lo chiude e lo riapre da solo, di norma entro circa
  un minuto (il riavvio finisce nel registro). Dopo tre riavvii senza successo
  riprova una volta al minuto. **Riavvia server** fa lo stesso a mano.
- **Come leggere un caricamento infinito**: con la pagina appesa, apri l'app.
  Se in «Chiamate dal browser» compare *in corso: GET /status da N s*, la richiesta
  è arrivata e il server non risponde. Se compare *connessioni aperte senza
  richiesta*, Chrome ha aperto la connessione ma non ha mandato la richiesta. Se il
  totale delle connessioni ricevute non cambia, la richiesta non è arrivata all'app.
  Una riga *Watchdog fermo per N s* nel registro indica che l'app è stata sospesa.
- **Prova Bluetooth** apre e chiude la connessione SPP senza stampare: dice se la
  stampante è accesa e raggiungibile.
- Il **registro** conserva le ultime 300 righe anche quando l'app non è visibile:
  tornando nell'app si vedono le chiamate arrivate mentre si era in Chrome
  (`HTTP GET /status -> 200 (8 ms) da nb-camelot.github.io`). Il testo si può
  selezionare e copiare.
- La **notifica** riporta lo stato reale (`API ok · stampante pronta`, oppure
  `API NON risponde: riavvio automatico`) invece di un testo fisso.
- Gli stessi dati sono in `GET /status` (campi `version`, `server`, `bluetooth`).

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
| GET    | `/`, `/test` | pagina di test servita dall'app (stessa origine: niente LNA né CORS) |
| GET    | `/escpos.js` | il client web incluso nell'APK (stessa versione dell'app) |
| GET    | `/status` | versione, salute di server e Bluetooth, stampante, configurazione |
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
JSON la può sovrascrivere. La pagina di test è `http://127.0.0.1:8787/` (o
`index.html` su GitHub Pages).

Flusso lato pagina (`escpos.js`):

1. `RawBT.check(timeoutMs)` → `GET /status`: non rifiuta mai e restituisce
   `{ ok: true, ms, status }` oppure `{ ok: false, ms, reason, message }`, con
   `reason` = `timeout` (nessuna risposta in tempo: richiesta appesa nell'app,
   ferma in Chrome o in attesa del permesso), `network` (rifiutata o bloccata dal
   browser) o `response` (ha risposto qualcosa che non è l'app: manca `"app": true`).
   `RawBT.ping()` resta per compatibilità (stato oppure `null`).
2. `RawBT.sendReceipt(spec)` → `POST /receipt` con JSON;
3. in alternativa `RawBT.sendApi(bytes)` → `POST /print` con ESC/POS già pronto;
4. `RawBT.send(bytes)` prova l'API. Se la connessione viene **rifiutata subito**
   (app chiusa, permesso negato) **ripiega** sullo scheme `rawbtprint:` aprendo
   l'app e restituisce `{ ok: true, fallback: true, confirmed: false, error }`: la
   stampa passa all'app ma la pagina non ne conosce l'esito, quindi non va
   ritentata. Dopo un **timeout** non ripiega (`{ ok: false, timeout: true, error }`):
   la richiesta potrebbe essere già in stampa e Chrome aprirebbe l'app solo con un
   nuovo tocco dell'utente, per esempio un pulsante «Stampa tramite l'app» che
   chiama `RawBT.navigate(RawBT.url(bytes))`. `{ fallback: false }` disattiva il ripiego.

Tutte le chiamate hanno un timeout (`{ timeoutMs }`, 0 = nessuno). I default sono
5 s per `check`, 40 s per `sendApi`, 60 s per `sendReceipt` (l'app può scaricare
il logo e poi stampare), 10 s per la configurazione (45 s se c'è `logoUrl`). Il
timeout scatta anche dove `fetch` ignora l'abort: una richiesta appesa non blocca
più la pagina.

Tutte le chiamate usano `cache: 'no-store'`. Chrome mette in coda le GET identiche
dietro una ancora in corso (lock della cache HTTP): senza questa opzione una sola
`/status` appesa, per esempio in attesa del prompt LNA, bloccherebbe tutte le
successive, da qualunque scheda. Vale anche per chi apre
`http://127.0.0.1:8787/status` a mano: se resta in caricamento, chiudi le altre
schede che puntano a `127.0.0.1:8787` (pagine vecchie con il client fino alla
1.6.x) e riprova.

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

> Nota: le pagine di test non dipendono più dalla CDN. Quella servita dall'app carica
> `/escpos.js` dall'app stessa (funziona anche senza Internet ed è sempre la versione
> dell'APK); `index.html` su Pages carica `escpos.js` dalla radice del repo. La copia
> in `android/app/src/main/assets/escpos.js` deve restare uguale a `escpos.js`: la
> CI fallisce se non lo è.

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
  o manualmente da `main`, e pubblica la Release. Sulle **pull request** verso
  `main` compila e firma un APK di prova (versione `<v>-pr<N>`, scaricabile dagli
  artifact della run) **senza** creare Release: si prova sul tablet prima del merge.
  Prima della build controlla anche la sintassi di `escpos.js` e degli script
  delle pagine, e che la copia negli asset dell'app sia allineata. La versione è letta da
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

