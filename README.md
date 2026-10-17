# Raw BT Print Bridge

Ponte generico tra una pagina web e una stampante termica **Bluetooth Classic
(SPP)** su Android. La pagina chiama l'API locale dell'app (`127.0.0.1:8787`) con
uno scontrino JSON o con ESC/POS già pronto (testo, logo, QR); l'app apre il socket
SPP e scrive i byte sulla stampante. In alternativa la pagina può aprire l'app con
lo scheme `rawbtprint:`.

L'app non è legata a un marchio: il **logo in testa agli scontrini** si sceglie
nell'app (file o URL) oppure via API (`POST /config`), e il logo incluso è quello
neutro di Print Bridge.

Progetto ispirato a [vibe-maribit/simple_order_manager](https://github.com/vibe-maribit/simple_order_manager).

> **Prima di tutto, sul tablet:** disattiva l'ottimizzazione batteria per l'app
> (vedi [Batteria e sospensione in background](#batteria-e-sospensione-in-background-importante)).
> Senza, Android può sospendere l'app quando passi al browser e le stampe dalla
> pagina restano in attesa finché non riapri l'app.

## Contenuto

- `android/` — app Android nativa minimale (`com.rawbtprint.bridge`):
  riceve `rawbtprint:base64,<dati>`, sceglie la stampante accoppiata e stampa.
- `escpos.js` — libreria ESC/POS lato web (testo, logo raster, QR nativo) con
  trasporto `RawBT` configurabile.
- `index.html` — pagina di test pubblicata su GitHub Pages. È identica a
  `android/app/src/main/assets/test.html` (che l'app serve su
  `http://127.0.0.1:8787/`) salvo il percorso di `escpos.js`; la CI lo verifica.
- `print-logo-receipt.ps1` — test locale dal PC verso `COM9` (ricevuta di prova con il logo neutro di `assets/logo.png`; `-Code` e `-Url` per il QR).
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
- Pulsanti: **Scegli stampante**, **Prova stampa (via API)**, **Dimentica stampante**,
  **Torna al browser**; nel pannello di stato **Autotest completo**, **Riavvia
  server**, **Prova Bluetooth** e, se serve, **Risolvi** per la batteria.

La schermata è divisa in card: intestazione con il marchio dell'app e la versione,
**Stato del bridge**, **Stampante**, **Indirizzi di prova**, **Carta e logo dello
scontrino** e **Registro** (copiabile con un tocco).

#### Stato del bridge

In cima all'app un pannello mostra, aggiornato ogni 2 secondi, lo stato dei
quattro tratti del ponte (pallino verde / ambra / rosso / grigio):

| Tratto | Cosa dice | Da dove viene |
|---|---|---|
| **Server API** | in ascolto da quanto, esito e durata dell'ultimo **autotest**, riavvii | il servizio chiama `GET /status` su se stesso ogni 15 s |
| **Chiamate dal browser** | ultima chiamata (metodo, percorso, esito, ms dall'arrivo della richiesta, origine), richieste **in corso** da quanto, connessioni aperte **senza richiesta**, totale connessioni ricevute | ogni connessione che arriva al server (l'autotest è escluso) |
| **Bluetooth e stampante** | Bluetooth acceso, stampante scelta e accoppiata, esito dell'ultima connessione | stato di Android + ultima stampa o **Prova Bluetooth** |
| **Batteria e sospensione in background** | ottimizzazione batteria, limitazione in background, sospensione delle app in cache, risparmio energetico | impostazioni di Android, rilette in background |

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
  `API NON risponde: riavvio automatico`), e avvisa se l'app rischia di essere
  sospesa in background.
- Gli stessi dati sono in `GET /status` (campi `version`, `server`, `calls`,
  `bluetooth`, `power`).

#### Batteria e sospensione in background (importante)

Il server dell'app gira in un servizio in primo piano, ma alcune ROM (verificato su
LineageOS 18.1 / Android 11) sospendono comunque l'app quando non è davanti. Il
sintomo è preciso: dal browser la stampa (o `http://127.0.0.1:8787/status`) resta in
**caricamento infinito** e parte da sola appena si riapre l'app. Per evitarlo:

1. **Impostazioni → App → Raw BT Print Bridge → Batteria**: ottimizzazione batteria
   su **Non ottimizzare** (o «Senza restrizioni») e nessuna limitazione in background.
2. Se le **Opzioni sviluppatore** sono attive: **«Sospendi esecuzione per app
   memorizzate nella cache»** su disattivato. Su Android 11 il valore predefinito è
   spento; da Android 12 di solito è acceso.
3. Da Android 12: nelle impostazioni dell'app, **«Sospendi attività app se non in
   uso»** disattivato.
4. **Risparmio energetico** spento mentre si usa la stampante.

L'app controlla da sola i punti 1-4:
- la riga **Batteria e sospensione in background** diventa rossa per i problemi che
  bloccano l'app, ambra per quelli che possono farlo (valore predefinito della
  sospensione su Android 12+, «Sospendi attività app se non in uso», risparmio
  energetico);
- conta anche il **sintomo**: se il controllo periodico del servizio si ferma per
  più di 45 s con il tablet acceso, l'app è stata sospesa. Il registro lo scrive
  («App sospesa dal sistema per N s con il tablet acceso») e la riga resta rossa per
  mezz'ora, anche su ROM con impostazioni proprie del produttore. Lo schermo spento
  non conta: il confronto è fatto sul tempo di sistema che non avanza nel sonno
  profondo;
- il pulsante **Risolvi** dice cosa apre e porta all'impostazione giusta (la
  richiesta di esenzione dall'ottimizzazione batteria, i dettagli dell'app, le
  Opzioni sviluppatore, la voce «sospendi se non in uso» o il risparmio energetico);
- all'avvio, se c'è un problema che blocca l'app, un avviso spiega quale e propone
  di risolverlo. Non compare quando l'app è stata aperta dal browser per stampare;
- la notifica mette l'avviso in testa, e `GET /status` (campo `power`) riporta lo
  stesso stato, che la pagina di test mostra in evidenza.

#### Autotest completo

**Autotest completo** (nell'app, o `GET /selftest`, o il pulsante nella pagina di
test) controlla in un colpo solo, con ✓ / ⚠ / ✗ per ogni voce:

| Voce | Cosa verifica |
|---|---|
| Servizio in primo piano | il servizio che tiene vivo il server è attivo |
| Server locale | il server è in ascolto su `127.0.0.1:8787` |
| API /status | una chiamata HTTP vera su `127.0.0.1` risponde, e in quanto tempo |
| Pagina di test | `GET /` restituisce la pagina |
| Client web (escpos.js) | `GET /escpos.js` restituisce il client incluso nell'app |
| Bluetooth | adattatore acceso, permesso, stampante scelta e accoppiata |
| Connessione stampante | apre e chiude la connessione SPP (senza stampare) |
| Batteria e sospensione | nessuna ottimizzazione o sospensione che blocchi l'app in background |
| Notifiche | le notifiche dell'app sono attive |
| Stampa di prova via API | solo dall'app, con «Esegui e stampa»: uno scontrino passa da `POST /receipt` |

Il risultato si può copiare (dall'app) per allegarlo a una segnalazione. `GET
/selftest` restituisce `{ ok, level, summary, ms, items: [{ name, level, detail }] }`
e non stampa mai.

#### Indirizzi di prova

La card **Indirizzi di prova** elenca, ognuno con **Copia** e **Apri**:
- la pagina di test servita dall'app, `http://127.0.0.1:8787/` (consigliata: stessa
  origine, niente permesso LNA, funziona anche offline);
- lo stato in JSON, `http://127.0.0.1:8787/status`;
- l'autotest in JSON, `http://127.0.0.1:8787/selftest`;
- la pagina di test su GitHub Pages;
- l'URL CDN del client web da includere nelle proprie pagine (versione dell'app).

#### Marchio e logo dello scontrino

L'app ha un marchio proprio (**Print Bridge**: una stampante termica con lo
scontrino in uscita e il simbolo Bluetooth), usato per l'icona, la notifica e la
pagina di test. Non è legata ad alcun cliente:
- il **logo in testa agli scontrini** si imposta nell'app (**Da file** o **Da URL**)
  oppure via API con `POST /config`: `{"logoMode":"url","logoUrl":"https://…/logo.png"}`,
  `{"logoMode":"asset"}` per il logo incluso, `{"logoMode":"none"}` per toglierlo;
- il **logo incluso** è il logo neutro «Print Bridge», in bianco e nero;
- i PNG con **sfondo trasparente** vanno bene: la trasparenza diventa bianco della
  carta, non un blocco nero.

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
| GET    | `/status` | versione, salute di server, chiamate, Bluetooth e batteria, stampante, configurazione |
| GET    | `/selftest` | autotest completo (senza stampa), con esito per ogni voce |
| GET    | `/config` | legge la configurazione corrente |
| POST   | `/config` | aggiorna configurazione (larghezza carta, logo, stampante) |
| POST   | `/receipt`| **JSON scontrino**, l'app genera l'ESC/POS |
| POST   | `/print`  | ESC/POS grezzo in base64 (escape hatch) |

Esempio `POST /receipt`:

```json
{
  "v": 1,
  "shop": "NEGOZIO DEMO",
  "title": "RICEVUTA",
  "subtitle": "Ordine 42",
  "code": "ABC123",
  "date": true,
  "lines": ["Buono regalo", "Uso entro 12 mesi"],
  "items": [{ "desc": "Caffe", "qty": 2, "price": 1.20 }],
  "total": "",
  "qr": "https://example.com/r/ABC123",
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
5. `RawBT.selftest()` → `GET /selftest`: autotest completo dell'app, senza stampa,
   `{ ok, level, summary, ms, version, versionCode, device, items: [{ name, level,
   detail }] }`. Con un'app precedente alla 1.8.1 risponde `{ ok: false, error:
   "not found" }`. Mentre gira occupa per qualche secondo la connessione SPP (prova
   della stampante): non lanciarlo insieme a una stampa.

Tutte le chiamate hanno un timeout (`{ timeoutMs }`, 0 = nessuno). I default sono
5 s per `check`, 40 s per `sendApi`, 60 s per `sendReceipt` (l'app può scaricare
il logo e poi stampare), 30 s per `selftest`, 10 s per la configurazione (45 s se
c'è `logoUrl`). Il
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
    shop: "NEGOZIO DEMO", title: "RICEVUTA", code: "ABC123",
    items: [{ desc: "Caffe", qty: 2, price: 1.20 }],
    qr: "https://example.com/r/ABC123", footer: "Grazie"
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

Apri `http://<ip-del-pc>:8000/` dal tablet o dal PC: `serve.ps1` serve `index.html`, la stessa pagina di test di Pages. Le API qui sotto
mostrano lo **stato della stampante sul PC** e permettono di stampare direttamente
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

