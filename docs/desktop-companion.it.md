<!-- Note di progetto per una possibile app desktop nativa di Print Bridge (Windows, macOS, Linux). Scritte il 2026-10-18; i fatti presi dal web sono stati verificati quel giorno sulle fonti indicate. Niente di quanto descritto è implementato. Traduzione italiana di desktop-companion.md. -->

# Print Bridge su un computer: progetto di un'app desktop

**Stato:** proposta, niente di implementato. **English:** [desktop-companion.md](desktop-companion.md).

Questo documento dice che cosa dovrebbe fare un'app nativa per Windows, macOS e Linux, perché, quanto costerebbe e quali decisioni richiede. Tutto il resto di Print Bridge su un computer (pagina iniziale, pagine in inglese e italiano, Web Bluetooth, Web Serial) funziona senza installare niente; questa sarebbe la prima parte da installare.

**Etichette.** `[fonte]` = ho aperto la pagina indicata il 2026-10-18 e dice questo. `[secondaria]` = lo dice la pagina di un fornitore, una notizia o un forum; la fonte primaria non è stata controllata o non si è caricata. `[non verificato]` = una mia deduzione, una conoscenza generale che non ho ricontrollato, o un punto che le fonti non chiariscono. `[stima]` = un numero approssimativo mio. I link sono raccolti nella [sezione 18](#18-fonti).

## Indice

1. [Sintesi](#1-sintesi)
2. [Cosa raggiungono oggi i browser su un computer](#2-cosa-raggiungono-oggi-i-browser-su-un-computer)
3. [Cosa i browser non raggiungono](#3-cosa-i-browser-non-raggiungono)
4. [A chi serve questa app](#4-a-chi-serve-questa-app)
5. [Il contratto: la stessa API locale usata su Android](#5-il-contratto-la-stessa-api-locale-usata-su-android)
6. [Cosa cambia su un computer](#6-cosa-cambia-su-un-computer)
7. [Trasporti](#7-trasporti)
8. [Sicurezza](#8-sicurezza)
9. [Esecuzione in background: tray, avvio automatico, sospensione](#9-esecuzione-in-background-tray-avvio-automatico-sospensione)
10. [Aggiornamenti](#10-aggiornamenti)
11. [Pacchetti e firma del codice](#11-pacchetti-e-firma-del-codice)
12. [Confronto delle tecnologie e raccomandazione](#12-confronto-delle-tecnologie-e-raccomandazione)
13. [Fasi e impegno indicativo](#13-fasi-e-impegno-indicativo)
14. [Matrice di test](#14-matrice-di-test)
15. [Rischi](#15-rischi)
16. [Decisioni aperte per il responsabile](#16-decisioni-aperte-per-il-responsabile)
17. [Modifiche facoltative in altre parti del repository](#17-modifiche-facoltative-in-altre-parti-del-repository)
18. [Fonti](#18-fonti)

## 1. Sintesi

- **Cosa.** Una piccola app per Windows, macOS e Linux che risponde alla stessa API HTTP dell'app Android su `http://127.0.0.1:8787` (`/status`, `/config`, `/selftest`, `/receipt`, `/print`, `/`, `/escpos.js`) e scrive i byte su stampanti che un browser non raggiunge: stampanti installate nel sistema operativo (stampanti di Windows, code CUPS), stampanti di rete sulla porta TCP 9100 grezza, e stampanti seriali o Bluetooth SPP per i browser senza Web Serial. `escpos.js` e le pagine parlano già questa API (`RawBT.check`, `sendApi`, `sendReceipt`, `printLayout` con `via: 'app'`), quindi non vanno modificati.
- **Perché non è urgente.** Su un computer Chrome ed Edge stampano già senza installare niente: stampanti BLE via Web Bluetooth (Windows, macOS; Linux solo con un flag), stampanti USB-seriali e stampanti Bluetooth Classic accoppiate via Web Serial (Chrome 89 e 117). Firefox su un computer ha Web Serial dalla versione 151, dopo un componente aggiuntivo con i permessi del sito che Firefox propone. `escpos.js` copre tutto questo con `RawBT.ble` e `RawBT.serial`.
- **Quando conviene.** Stampanti di scontrini USB installate con il driver del produttore, stampanti Ethernet o Wi-Fi, utenti Safari, chioschi che stampano senza che una persona scelga una porta, più schede o programmi che condividono una stampante.
- **Raccomandazione.** Se il responsabile decide di costruirla: un programma in **Go**, un eseguibile per sistema, con un'icona nell'area di notifica (tray) e, come interfaccia, la pagina di test esistente servita dal programma stesso. Versione 1: porte seriali/COM (USB-seriale e SPP), lo spooler del sistema in modalità RAW, TCP 9100, approvazione dei siti che possono stampare. BLE più avanti, e solo se gli utenti lo chiedono. Electron è l'alternativa quando riusare `escpos.js` byte per byte conta più delle dimensioni; Tauri se qualcuno scrive Rust. Vedi la [sezione 12](#12-confronto-delle-tecnologie-e-raccomandazione).
- **Costo.** Circa 7-10 settimane-persona fino a una versione 1 firmata sui tre sistemi, senza BLE `[stima]`; poi 99 USD l'anno (Apple) e circa 120 USD l'anno (Azure Artifact Signing, se si ha diritto) oppure 150-300 USD l'anno (certificato OV) per la firma del codice `[fonte]`.
- **Prima di cominciare** il responsabile dovrebbe prendere le decisioni della [sezione 16](#16-decisioni-aperte-per-il-responsabile), prima di tutto se ci sono utenti reali che ne hanno bisogno.

## 2. Cosa raggiungono oggi i browser su un computer

| Via | Chrome / Edge, Windows | Chrome / Edge, macOS | Chrome, Linux | Firefox | Safari | In Print Bridge |
|---|---|---|---|---|---|---|
| Web Bluetooth (BLE GATT) | sì, Windows 10 (Creators Update), Chrome 70 | sì | «partially implemented and not supported», dietro un flag | no | no | `RawBT.ble`, driver per immagini, `ble.html` |
| Web Serial, porte USB-seriali | sì, Chrome 89 | sì, Chrome 89 | sì, Chrome 89 | sì dalla 151 (desktop), dopo un componente aggiuntivo con i permessi del sito che Firefox propone («add-on gating») | no | `RawBT.serial` |
| Web Serial, Bluetooth Classic SPP (RFCOMM) | sì, Chrome 117 su desktop (la fonte non elenca i sistemi uno per uno) | idem | idem | non dichiarato | no | `RawBT.serial` (UUID SPP consentito) |
| WebUSB verso una stampante USB | bloccata dal driver di stampa del sistema | ha funzionato in una segnalazione | bloccata in una segnalazione | no | no | non usata |
| App locale su `127.0.0.1` | sì, con un permesso da Chrome 142 | idem | idem | sì, richiesta di permesso in distribuzione | incerto (contenuto misto) | `RawBT.check`, `sendApi`, `sendReceipt` |

- **Web Bluetooth.** Lo stato di implementazione del Web Bluetooth CG indica l'API GATT come distribuita senza flag in Chrome su Android, ChromeOS, macOS e Windows 10 (Chrome 70; la pagina cita sia Windows 10 1703 sia 1706). Per Linux dice «Linux is partially implemented and not supported» e richiede `chrome://flags/#enable-experimental-web-platform-features`. Firefox e Safari: non supportata; Edge: dalla 79 `[fonte: implementation status]`. Una nota più recente dice che da Chromium 100 su Linux basta il flag più ristretto `#enable-web-bluetooth` `[secondaria: CircuitPython code editor]`; non ho controllato quale flag serva al Chrome attuale.
- **Web Serial.** «The Web Serial API is available on all desktop platforms (ChromeOS, Linux, macOS, and Windows) in Chrome 89» `[fonte: documentazione Chrome]`. Da Chrome 117 su desktop apre anche i servizi RFCOMM dei dispositivi Bluetooth Classic accoppiati, Serial Port Profile compreso, «even if the operating system has not created a device node»; gli altri UUID sulla base UUID Bluetooth sono bloccati, SPP escluso `[fonte: Serial over Bluetooth]`. Chrome 138 ha portato «Web Serial API over Bluetooth RFCOMM» su Android; la seriale USB via cavo su Android è rimandata a un rilascio futuro `[fonte: note di rilascio di Chrome 138]`.
- **Firefox.** «Starting in Firefox 151 for Desktop» Web Serial è disponibile, dietro l'«add-on gating»: la prima volta Firefox propone un componente aggiuntivo con i permessi del sito, il passaggio di spiegazione e consenso usato la prima volta per Web MIDI; la policy aziendale `DefaultSerialGuardSetting` lo controlla `[fonte: Mozilla Hacks, 2026-05-21]`. L'articolo non dice se offre anche le porte Bluetooth RFCOMM `[non verificato]`. Firefox non ha Web Bluetooth `[fonte: implementation status]`.
- **Safari.** Niente Web Serial, niente Web Bluetooth. Le posizioni di WebKit su entrambe erano negative nel 2023-2024 `[secondaria: mailing list W3C]`.
- I selettori di porta e di dispositivo (`requestPort`, `requestDevice`) si aprono solo in risposta a un gesto dell'utente `[fonte: documentazione Chrome]`; per questo `RawBT.printLayout` li apre nello stesso tocco.
- **WebUSB e stampanti.** In una discussione del forum sviluppatori Zebra, `open()` fallisce con «Access denied» su Windows 10/11 e su Ubuntu, mentre la stessa pagina funziona su macOS; l'unico rimedio trovato è sostituire il driver con lo strumento Zadig `[secondaria: forum Zebra]`. Un produttore di software per cassa documenta la stessa sostituzione con WinUSB, da ripetere dopo gli aggiornamenti di Windows o del produttore `[secondaria: Storepass]`. Un intent di Chromium osserva che le sostituzioni WinUSB tramite INF per le classi di dispositivo standard sono un rimedio noto che il filtro per classe di interfaccia renderebbe impossibile `[secondaria: blink-dev]`. Sostituire il driver toglie inoltre la stampante a tutti gli altri programmi. Print Bridge non usa WebUSB e questo documento non la propone.

## 3. Cosa i browser non raggiungono

1. **Stampanti di rete su TCP grezzo.** La maggior parte delle stampanti di scontrini Ethernet e Wi-Fi accetta ESC/POS sulla porta TCP 9100: «AppSocket printing normally happens over port 9100 and uses the `socket` backend», e AppSocket «offers no security» `[fonte: CUPS, stampanti di rete]`. Una pagina web non può aprire un socket TCP: i Direct Sockets sono «restricted to Isolated Web Apps (IWAs)» `[fonte: Chrome Direct Sockets]`, e un avviso di giugno 2026 su blink-dev indica le Isolated Web Apps come solo ChromeOS `[secondaria: PSA su blink-dev, estratto di ricerca]`.
2. **Stampanti installate nel sistema operativo.** Una stampante di scontrini USB installata con il driver del produttore diventa una stampante di Windows o una coda CUPS. Nessuna API web manda byte grezzi a una coda dello spooler. `window.print()` passa la pagina attraverso il driver e una finestra di stampa: la stampante riceve un'immagine della pagina, non ESC/POS, quindi niente QR nativo, niente comando di taglio, niente cassetto `[non verificato: conoscenza generale]`.
3. **Dispositivi USB di classe stampante.** Non sono porte seriali, quindi Web Serial non li elenca, e WebUSB non li apre finché il driver del sistema li tiene ([sezione 2](#2-cosa-raggiungono-oggi-i-browser-su-un-computer)): su Windows il driver di classe per stampanti USB, `usbprint.sys` `[non verificato: nome da conoscenza generale; la discussione Zebra non lo nomina]`, su Linux il driver del kernel `usblp` `[non verificato]`. Li raggiungono solo lo spooler o un programma che parla con il dispositivo.
4. **Browser senza le API.** Safari non ha né Web Serial né Web Bluetooth. Firefox non ha Web Bluetooth e ha Web Serial solo dalla 151 su un computer, dopo un componente aggiuntivo con i permessi del sito; Firefox per Android non ha né l'uno né l'altro. Chrome su Linux richiede un flag per BLE. Qualunque browser che dalla pagina possa chiamare `http://127.0.0.1` può usare un'app locale; Safari potrebbe bloccare anche questo ([sezione 8.6](#86-safari)).
5. **Stampare senza una persona davanti alla pagina.** Web Serial e Web Bluetooth richiedono un tocco la prima volta su ogni sito, e la connessione vive dentro la scheda: chiusa la scheda, si chiude la porta. Un'app locale tiene la stampante per tutte le schede e tutti i siti e stampa una richiesta senza alcun gesto. Stampare quando *non c'è nessuna pagina aperta* (lavori inviati da un server) non lo fa neanche l'app Android; sarebbe una funzione nuova, con l'app che preleva i lavori da un server (decisione D10).
6. **Una stampante, molte schede.** Una porta seriale aperta da una scheda non può essere aperta da un'altra nello stesso momento `[non verificato: comportamento dell'implementazione seriale di Chrome]`. Un'app locale mette in coda i lavori di tutte le schede e di tutti i programmi.

## 4. A chi serve questa app

| Situazione | Senza l'app | Con l'app |
|---|---|---|
| Stampante BLE, Chrome o Edge su Windows o macOS | stampa (`ble.html`, `RawBT.ble`) | non serve |
| Stampante USB-seriale o SPP accoppiata, Chrome o Edge | stampa (Web Serial, `RawBT.serial`) | facoltativa: niente tocco, condivisa tra le schede |
| Stampante di scontrini USB installata con un driver | non stampa ESC/POS | stampa (spooler, RAW) |
| Stampante Ethernet o Wi-Fi sulla porta 9100 | non stampa | stampa (TCP) |
| Safari su macOS | non stampa | stampa, se Safari lascia raggiungere 127.0.0.1 alla pagina (incerto) |
| Firefox su un computer | Web Serial dalla 151 (dopo un componente aggiuntivo con i permessi del sito), niente BLE | stampa su tutti i trasporti dell'app |
| Linux con una stampante BLE | solo con un flag di Chrome | stampa se l'app ottiene il BLE (fase 4) |
| Chiosco, stampa senza operatore | un tocco per sito e stampante | nessun tocco |

## 5. Il contratto: la stessa API locale usata su Android

Ricavato da `android/app/src/main/kotlin/com/rawbtprint/bridge/PrintServer.kt`, `Printer.kt`, `Receipt.kt`, `AppConfig.kt`, `SelfTest.kt`, dalla sezione del README [API HTTP locale dell'app](../README.it.md#api-http-locale-dellapp) e da `escpos.js`. L'app desktop deve comportarsi allo stesso modo; tutto ciò che aggiunge devono essere campi facoltativi che i client esistenti ignorano.

### 5.1 Endpoint

| Metodo | Percorso | Richiesta | Risposta | Note |
|---|---|---|---|---|
| OPTIONS | qualsiasi | – | 204, corpo vuoto | preflight CORS: le POST JSON verso `/config` e `/receipt` lo inviano |
| GET | `/status` | – | 200, JSON del [5.2](#52-campi-di-status-letti-dalle-pagine) | deve contenere `"app": true`: `RawBT.check()` tratta qualsiasi altro JSON come «non è l'app» |
| GET | `/config` | – | 200, JSON della configurazione | |
| POST | `/config` | JSON: `paperWidth`, `logoMode`, `logoValue`, `logoUrl`, `printer`, `printerName` | 200 con la configurazione, oppure 400 `{ok:false, error}` | con `logoUrl` il logo viene scaricato prima della risposta (`escpos.js` aspetta fino a 45 s) |
| GET | `/selftest` | – | 200 `{ok, level, summary, ms, version, versionCode, device, items:[{name, level, detail}]}`; 503 se non inizializzata | non stampa; può durare qualche secondo |
| POST | `/receipt` | JSON dello scontrino (README) | 200 `{ok:true, bytes, summary}`; 200 `{ok:false, error}` se la stampante non riesce; 400 `{ok:false, error}` per JSON non valido | impaginato dall'app; `width` 16-64 colonne, `printer` sostituisce la stampante scelta, `labels` fissa le etichette di «numero» e «totale» |
| POST | `/print` | ESC/POS in base64 come testo (`escpos.js` invia `Content-Type: text/plain`); un corpo che non è base64 viene stampato così com'è | 200 `{ok:true, bytes}` o `{ok:false, error}`; corpo vuoto 400 | `text/plain` la mantiene una «simple request» CORS: niente preflight |
| GET | `/`, `/test` | – | la pagina di test (`app.html` con `<script src="escpos.js">`) | stessa origine: niente permesso Local Network Access, niente CORS |
| GET | `/escpos.js` | – | il client incluso, della stessa versione | |
| GET, HEAD | `/receipt`, `/print` | – | 405 con l'indicazione di usare POST | |
| qualsiasi altro | | | 404 `{"ok":false,"error":"not found"}` | |

Header di ogni risposta (`respond()` in `PrintServer.kt`):

```
Content-Type: <type>; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Private-Network: true
Cache-Control: no-store
Connection: close
```

### 5.2 Campi di `/status` letti dalle pagine

- Configurazione: `paperWidth` (colonne, 16-64, predefinito 32), `paperPixels` (colonne × 12), `logoMode` (`none`, `asset`, `file`, `url`), `logo` (etichetta), `printer`, `api` (i quattro URL).
- App: `app: true`, `port`, `version`, `versionCode`, `state`, `detail`, `device`.
- Oggetti di salute, ciascuno `{level, message}` con `level` tra `ok`, `warn`, `error`, `unknown`: `server` (più `bound`, `uptimeS`, `restarts`, `requests`), `calls` (più `inFlight`, `waiting`), `bluetooth`, `power`. `app.html` mostra tutte e quattro le righe, quindi l'app desktop deve inviarli tutti e quattro, anche `power` quando non ha niente da dire (livello `ok`, messaggio «non applicabile su questo computer», oppure lo stato di sospensione).
- `/status` non aspetta mai il Bluetooth o una stampante: l'app Android risponde con valori in cache. L'app desktop deve fare lo stesso, perché `RawBT.check()` rinuncia dopo 5 s e Chrome mette in coda le GET identiche dietro una rimasta appesa (README, [Funzioni di `RawBT`](../README.it.md#funzioni-di-rawbt)).

### 5.3 Comportamenti da mantenere

- **Un lavoro alla volta per stampante.** Android rifiuta un secondo lavoro con `{ok:false, error}` (occupata) mentre uno è in corso. Un computer può invece metterlo in coda, ma deve rispondere prima che `escpos.js` rinunci (`sendApi` 40 s, `sendReceipt` 60 s): altrimenti la pagina segnala un timeout per un lavoro che poi esce, e un nuovo tentativo lo stampa due volte. Attesa in coda al massimo 20 s circa, poi risposta «occupata» `[stima]`.
- **Invio cadenzato.** Scritture da 256 byte con pause di 25 ms verso le stampanti Bluetooth SPP: le stampanti economiche hanno tra la radio e la CPU una seriale senza controllo di flusso e perdono byte (commento in `Printer.kt`). `RawBT.serial` usa gli stessi numeri. Vanno mantenuti per seriale e SPP; TCP e spooler non dovrebbero averne bisogno `[non verificato per tutte le stampanti]`.
- **Timeout.** Connessione 8 s; timeout di scrittura `max(15 s, 5 s + byte × 50 ms / 256)`, come in `Printer.kt`.
- **Messaggi nella lingua dell'utente.** `message`, `detail`, `summary`, `error` seguono la lingua dell'app (inglese o italiano); i nomi dei campi e i valori di `level` non cambiano mai (README, [Lingua dell'app](../README.it.md#lingua-dellapp)).
- **Un client lento non blocca niente.** Timeout del socket di 30 s, limite di 32 KB per gli header, `Connection: close`, un thread per connessione.

### 5.4 Cosa si aspetta `escpos.js` (nessuna modifica)

- `localJson()` chiama con `targetAddressSpace: 'loopback'` e `cache: 'no-store'`; timeout predefiniti: `check` 5 s, `sendApi` 40 s, `sendReceipt` 60 s, `selftest` 30 s, configurazione 10 s (45 s con `logoUrl`).
- `RawBT.apiPort` è 8787. Una pagina può cambiarla, nessuna delle nostre lo fa: l'app desktop deve ascoltare sulla 8787.
- `RawBT.chooseVia` sceglie `app` quando `RawBT.lastCheck.ok` è vero (l'app ha risposto a `check()`), dopo una stampante BLE accoppiata nella scheda e una porta seriale aperta nella scheda. Una pagina che chiama `RawBT.check()` al caricamento e poi `RawBT.printLayout` stampa attraverso l'app desktop senza modifiche.

## 6. Cosa cambia su un computer

### 6.1 Come si identifica la stampante

Su Android `printer` è un indirizzo MAC Bluetooth. Un computer ha più tipi di stampante, quindi l'app desktop memorizza un URI:

| URI | Significato |
|---|---|
| `serial:COM5?baud=9600`, `serial:/dev/ttyUSB0?baud=19200` | porta seriale: USB-seriale, o la porta COM virtuale di una stampante SPP accoppiata |
| `bt:5A:4A:D5:BC:47:08` | Bluetooth Classic SPP per indirizzo: l'app trova la sua porta virtuale o apre il canale RFCOMM |
| `spool:EPSON TM-T20II Receipt` | coda di stampa del sistema, RAW |
| `tcp:192.168.1.50:9100` | stampante di rete |
| `ble:<id>` | stampante BLE (fase 4) |

Un MAC semplice in `printer` (quello che mandano le pagine esistenti e `/receipt`) si legge come `bt:<MAC>`. `/config` e `/status` possono restituire campi facoltativi in più (`printerUri`, un elenco `printers`, `platform`); i client esistenti li ignorano.

### 6.2 `/status` e `/selftest`

- Nuovo campo facoltativo `platform`: `windows`, `macos`, `linux` (e `android` nell'app, più avanti), così le pagine possono formulare i suggerimenti per il sistema giusto.
- `bluetooth`: stato dell'adattatore Bluetooth quando la stampante è Bluetooth, altrimenti lo stato del trasporto in uso (porta presente, coda presente, host raggiungibile).
- `power`: su macOS, se App Nap o la sospensione possono ritardare i lavori; altrove `ok`.
- Voci dell'autotest: server in ascolto su 127.0.0.1:8787; stampante configurata; trasporto pronto (la porta esiste e si apre, la coda esiste e accetta RAW, connessione TCP entro 3 s); permessi (gruppo della seriale su Linux, Bluetooth e Rete locale su macOS); avvio all'accesso attivo; versione e canale di aggiornamento.

### 6.3 Impaginazione dello scontrino (`POST /receipt`)

Due strade, entrambe accettabili:

1. **Portare `Receipt.kt` ed `EscPos.kt`** (circa 260 righe di Kotlin) nel linguaggio dell'app desktop. Il logo segue `LogoStore.rasterize`: adattato a larghezza carta × righe massime, grigio = 0,299 R + 0,587 G + 0,114 B composto su bianco, soglia, raster `GS v 0`.
2. **Eseguire `escpos.js`** (`PrintBridge.render('receipt', spec)`) dentro l'app desktop: gratis con Electron (Node o renderer) e con Tauri (webview); in Go o .NET serve un motore JavaScript incorporato (goja, Jint; non approfonditi). I byte sono allora identici a quelli del client web. Nella 1.12.0 il layout `receipt` di `escpos.js` riproduceva solo lo scontrino italiano e ignorava `labels`; dalla 1.13.0 segue `labels` e la lingua come `Receipt.kt`. Prende la lingua da `RawBT.language()`, non dall'app, quindi un'app desktop che lo esegue deve prima chiamare `RawBT.setLanguage` con la lingua dell'app.

In entrambi i casi `test/layout-test.js` decodifica già l'ESC/POS e confronta lo scontrino di `escpos.js` con un modello di `Receipt.kt`: le stesse prove possono verificare i byte dell'app desktop.

### 6.4 La pagina servita su `/`

Distribuire `app.html` ed `escpos.js` con l'app desktop, come la build Android include `assets/test.html`. Alcuni testi della pagina parlano dell'app Android e della batteria: con `platform` in `/status` la pagina può nascondere quelle righe (modifica facoltativa della pagina, [sezione 17](#17-modifiche-facoltative-in-altre-parti-del-repository)).

### 6.5 Lo scheme `rawbtprint:`

`RawBT.send()` (non `sendApi`, non `printLayout`) apre `rawbtprint:base64,<dati>` quando l'API rifiuta la connessione entro 3 s, e restituisce `{ok:true, fallback:true, confirmed:false}`. Dalla 1.13.0 lo fa solo su Android: altrove oggi nessuno gestisce quello scheme, quindi restituisce `{ok:false, error}` (la 1.12.0 apriva lo scheme anche su un computer, e la pagina credeva di aver passato il lavoro mentre non si stampava niente). L'app desktop potrebbe registrare lo scheme per avviarsi (Windows `HKCU\Software\Classes\rawbtprint`, macOS `CFBundleURLTypes`, Linux `MimeType=x-scheme-handler/rawbtprint` nel file `.desktop`) `[non verificato: non provato]`. Su Windows non può essere un trasporto: una riga di comando è lunga al massimo 32.767 caratteri `[fonte: CreateProcessW]`, e il solo base64 del raster di un logo occupa diversi KB `[stima]`. Va usato solo per avviare l'app, e il contenuto si stampa solo quando ci sta. Perché una pagina ci arrivi, `RawBT.send` dovrebbe anche sapere che su quel computer c'è un gestore, perché ora ripiega solo su Android.

### 6.6 La porta 8787 e gli utenti multipli

- Se la porta 8787 è occupata, l'app lo dice nel tray e nel registro; non deve spostarsi in silenzio su un'altra porta, perché le pagine chiamano la 8787.
- Su Windows con più sessioni (cambio rapido utente, Desktop remoto) l'interfaccia di loopback è una sola per macchina `[non verificato]`: una sola app può ascoltare, e le pagine dell'utente B raggiungerebbero l'app e la stampante dell'utente A. Possibilità: un'app per macchina, un rifiuto con un messaggio chiaro, o porte per utente con un'impostazione nella pagina (decisione D7).

## 7. Trasporti

### 7.1 Porte seriali e COM (USB-seriale, Bluetooth SPP)

- Nomi: `COMn` (Windows); `/dev/cu.*` (macOS; `cu.` anziché `tty.` per le connessioni in uscita `[non verificato]`); `/dev/ttyUSB*`, `/dev/ttyACM*` (Linux).
- Impostazioni: 9600-115200 baud, 8N1, nessun controllo di flusso. `serve.ps1` e `print-logo-receipt.ps1` alzano anche DTR e RTS, che servono ad alcuni adattatori `[non verificato per ogni adattatore]`.
- **SPP su Windows:** accoppiando una stampante che offre SPP si crea una porta COM virtuale in uscita, elencata in *Altre impostazioni Bluetooth → Porte COM* e in Gestione dispositivi `[secondaria: Juniper Systems]`. `serve.ps1` stampa già così (COM9).
- **SPP su macOS:** i dispositivi SPP accoppiati possono comparire come `/dev/cu.<nome>`; non ho trovato documentazione attuale e le segnalazioni sono discordanti `[non verificato]`. L'alternativa diretta è un canale RFCOMM tramite il framework IOBluetooth di Apple `[non verificato, non approfondito]`.
- **SPP su Linux:** lo strumento `rfcomm` (`rfcomm bind`) è distribuito in pacchetti chiamati `bluez-deprecated` / `bluez-deprecated-tools` `[fonte: man page di openSUSE]`; i programmi possono aprire direttamente un socket RFCOMM, `socket(PF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM)` `[fonte: rfcomm(7)]`.
- Chrome apre già le stampanti SPP senza un nodo di dispositivo del sistema ([sezione 2](#2-cosa-raggiungono-oggi-i-browser-su-un-computer)), quindi l'RFCOMM diretto è possibile sui tre sistemi; resta da vedere se una libreria lo fa nel linguaggio scelto ([sezione 12](#12-confronto-delle-tecnologie-e-raccomandazione)).
- **Apri, scrivi, chiudi a ogni lavoro** con SPP, come fa `Printer.kt`: una stampante SPP accetta una sola connessione, quindi tenerla aperta bloccherebbe telefoni e altri computer. Con l'USB-seriale tenere aperta la porta è più veloce e innocuo.
- Linux: l'utente deve appartenere al gruppo proprietario dei dispositivi seriali (`dialout` su Debian, Ubuntu e Fedora; `uucp` su Arch) `[non verificato per ogni distribuzione]`. L'app dovrebbe riconoscere l'errore di permesso e mostrare il comando esatto. Un Flatpak ha bisogno di `--device=all` `[fonte: Flatpak]`.

### 7.2 Spooler del sistema, RAW

- **Windows:** `OpenPrinter` → `StartDocPrinter` con `DOC_INFO_1.pDatatype = "RAW"` → `StartPagePrinter` → `WritePrinter` → `EndPagePrinter` → `EndDocPrinter` → `ClosePrinter` `[fonte: Send data directly to a GDI printer]`. `WritePrinter` «is a blocking or synchronous function and might not return immediately» (va chiamata fuori dal thread dell'interfaccia) e «only supports GDI printing and must not be used for XPS printing» `[fonte: WritePrinter]`. Una coda con un driver solo XPS (v4) può quindi rifiutare o alterare i lavori RAW `[non verificato]`; la configurazione sicura è il driver v3 del produttore o il driver «Generic / Text Only» sulla porta della stampante `[non verificato]`. Le code si elencano con `EnumPrinters`.
- **Cambiamenti nella stampa di Windows.** Dal 2026-01-15 niente nuovi driver di stampa di terze parti su Windows Update per Windows 11+; dal 2026-07-01 viene preferito sempre il driver di classe IPP incluso nel sistema; dal 2027-07-01 niente aggiornamenti dei driver di terze parti salvo correzioni di sicurezza; i driver esistenti si possono ancora installare dal pacchetto del produttore `[fonte: end of servicing plan]`. La modalità di stampa protetta di Windows (Windows protected print mode) usa solo Windows Ready Print (stampanti Mopria); si attiva dalle Impostazioni («highly recommended») o con un criterio di gruppo, e all'attivazione «printers that use third-party drivers are uninstalled» `[fonte: Windows protected print mode]`. Le stampanti di scontrini ESC/POS raramente sono certificate Mopria `[secondaria: SAPinsider]`. La via dello spooler potrebbe complicarsi col tempo; seriale, TCP e USB diretta non ne dipendono.
- **macOS e Linux (CUPS):** una coda raw (`lpadmin -p NOME -E -v URI -m raw`) passa i byte senza modificarli; i lavori si inviano con `lp -d NOME -o raw FILE` o via IPP `[non verificato: -o raw non compare nella pagina attuale di lp su cups.org]`. CUPS dice «Models other than "everywhere" are deprecated and will not be supported in a future version of CUPS», e che i driver di stampa sono deprecati `[fonte: man page di lpadmin]`; non ho trovato una data di rimozione `[non verificato]`. Conviene prevedere anche una via diretta: TCP per le stampanti di rete; per le stampanti USB su Linux il dispositivo di stampa del kernel `/dev/usb/lp0` `[non verificato]`, su macOS l'acquisizione con libusb dell'interfaccia di stampa, che nessun driver del sistema tiene, come suggerisce la segnalazione su WebUSB `[non verificato]`.
- Il successo sullo spooler significa «lo spooler ha accettato il lavoro», non «la carta è uscita».

### 7.3 Stampanti di rete, TCP 9100

- Aprire una connessione TCP verso `host:9100` (`socket://` nei termini di CUPS), scrivere, chiudere; niente cifratura, niente autenticazione `[fonte: CUPS, stampanti di rete]`. Timeout di connessione 3-5 s `[stima]`.
- Ricerca: per cominciare un indirizzo IP scritto dall'utente; la ricerca Bonjour/mDNS più avanti (il tipo di servizio della porta 9100 grezza è `_pdl-datastream._tcp` `[non verificato]`).
- **macOS 15 e successivi:** una connessione TCP in uscita verso un indirizzo della rete locale richiede il privilegio Rete locale, e il sistema lo chiede la prima volta; restare in ascolto di connessioni in entrata non lo richiede; i daemon di launchd e i processi eseguiti come root sono esenti, gli agent di launchd no (impostano `AssociatedBundleIdentifiers`); l'app dichiara `NSLocalNetworkUsageDescription`; deve essere firmata con un'identità rilasciata da Apple, altrimenti il tracciamento del privilegio può comportarsi male; l'MDM non può preconfigurare il privilegio `[fonte: TN3179]`.
- Possono essere destinazioni solo le stampanti configurate dall'utente: l'app non si collega mai a un host o a una porta inviati da una pagina ([sezione 8.7](#87-altri-limiti)).

### 7.4 BLE (facoltativo, fase 4)

- I browser stampano già in BLE su Windows e macOS. Un'app desktop aggiungerebbe il BLE per gli utenti di Safari, Firefox e Linux.
- Librerie: btleplug (Rust; Windows 10, macOS, Linux, iOS, Android; solo ruolo central; «DOES NOT SUPPORT BLUETOOTH 2/CLASSIC») `[fonte]`; tinygo-org/bluetooth (Go; Linux central e peripheral, macOS central, Windows tramite WinRT; niente Classic) `[fonte]`; universal_ble (Flutter; Android, iOS, macOS, Windows, Linux, web) `[fonte]`; Electron offre Web Bluetooth alle sue pagine e lascia scegliere il dispositivo al programma in un gestore `select-bluetooth-device` al posto del selettore di Chrome `[fonte: Electron, accesso ai dispositivi]`.
- Il lavoro: portare da `escpos.js` i profili BLE, le dimensioni dei pacchetti, le modalità di scrittura e i driver Phomemo (`PrintBridge.drivers`, flusso a crediti), oppure eseguire `escpos.js` stesso (Electron). macOS chiede il permesso Bluetooth `[fonte: README di btleplug]`.

### 7.5 Stampanti USB senza coda

Non nella versione 1. Su Windows il dispositivo appartiene al driver di stampa ([sezione 2](#2-cosa-raggiungono-oggi-i-browser-su-un-computer)); sostituirlo con WinUSB rompe tutti gli altri programmi. Per macOS e Linux vedi il [7.2](#72-spooler-del-sistema-raw).

## 8. Sicurezza

**Modello delle minacce.** Ogni pagina aperta in qualsiasi browser dell'utente può inviare richieste a `127.0.0.1:8787`; lo può fare anche ogni programma locale e, sulle macchine condivise, gli altri utenti. Una pagina ostile potrebbe stampare testo inutile od offensivo, sprecare carta, aprire il cassetto (impulso ESC/POS `ESC p`), leggere la stampante configurata e l'URL del logo, far scaricare un URL all'app (`logoUrl`) e, se le è permesso, farla collegare a host della rete locale. L'app Android oggi ha la stessa esposizione, ridotta dalla richiesta di permesso Local Network Access di Chrome.

### 8.1 Ascolto solo su loopback

Ascoltare solo su `127.0.0.1`, come fa `PrintServer.kt` (`InetAddress.getByAddress(127, 0, 0, 1)`), mai su `0.0.0.0` o `::`. Su Windows un ascolto su loopback non dovrebbe far comparire la richiesta del firewall `[non verificato]`; su macOS l'ascolto non richiede il privilegio Rete locale `[fonte: TN3179]`.

### 8.2 Header Host

Accettare solo `Host: 127.0.0.1:8787` (e `localhost:8787`). Questo ferma il DNS rebinding, in cui un dominio ostile si risolve in 127.0.0.1 e la sua pagina diventa «stessa origine» dell'app `[non verificato: se Local Network Access da solo lo blocchi già]`.

### 8.3 CORS e Private Network Access

- Mantenere gli header del [5.1](#51-endpoint) (`*`), oppure restituire l'`Origin` dei siti approvati. CORS non impedisce la consegna: una `POST /print` cross-origin con `text/plain` è una simple request, arriva al server, alla pagina viene nascosta solo la risposta. **L'app deve controllare `Origin` prima di stampare, non affidarsi a CORS.**
- `Access-Control-Allow-Private-Network: true`: i preflight Private Network Access di Chrome «are not currently enforced», la loro introduzione «is currently on hold» da ottobre 2024 `[fonte: PNA on hold]`; Local Network Access li sostituisce con un permesso `[fonte: Chrome LNA]`. Mantenere l'header non costa niente.

### 8.4 Permessi Local Network Access (Chrome, Edge, Firefox)

- Da Chrome 142 una pagina pubblica ha bisogno del permesso dell'utente per raggiungere indirizzi locali o di loopback, e 127.0.0.0/8 conta come loopback `[fonte: Chrome LNA]`; Chrome 142 è uscito il 2025-10-28 `[secondaria: Dynamsoft]`. Da Chrome 145 il permesso è diviso in due: `loopback-network`, «App sul dispositivo» (quello che serve a Print Bridge), e `local-network`, «Rete locale»; la policy aziendale `LocalNetworkAccessAllowedForUrls` preautorizza i siti `[secondaria: Dynamsoft]`. Chrome 147 lo applica ai WebSocket, e Chrome 156 rimuove la policy temporanea di esclusione, prevista per il 2026-10-20 `[secondaria: Visualware, Supercharge Browser]`. `escpos.js` invia già `targetAddressSpace: 'loopback'`, e `RawBT.localAccess()` legge lo stato del permesso.
- Firefox mostra una richiesta simile (un sito «wants to access other apps and services on this device»). Le segnalazioni non concordano sulle versioni: prima con la protezione antitracciamento rigida (149), distribuzione dalla 151, predefinita su desktop nella 153, WebSocket nella 154 `[secondaria: estratto di ricerca di Mozilla Support, Cornell IT, CyberInsider; la pagina di Mozilla non si è caricata]`. Policy aziendale `LocalNetworkAccess` (Firefox 153+) `[secondaria: Dynamsoft]`.
- Le pagine servite dall'app stessa (`http://127.0.0.1:8787/`) non richiedono alcun permesso.

### 8.5 Quali siti possono stampare (default consigliato)

- **Approvazione al primo uso.** Una richiesta da un'origine sconosciuta a `/print`, `/receipt`, `POST /config` o `/selftest` riceve `403 {ok:false, error:"<sito> non è autorizzato: approvalo in Print Bridge"}`, e il tray mostra «Consentire a <sito> di stampare?». Le origini approvate sono elencate, e si possono rimuovere, nel menu del tray e nella pagina di stato. `GET /status` risponde sempre (alle pagine serve per trovare l'app) ma nasconde il nome della stampante e l'URL del logo alle origini non approvate e aggiunge `allowed: false`.
- Funziona con `escpos.js` invariato: la pagina mostra il testo dell'errore.
- Le richieste senza `Origin` (curl, programmi locali) sono consentite per default: girano già come l'utente (decisione D6).
- **Token di abbinamento (più forte, più avanti).** Un segreto mostrato dall'app, memorizzato dalla pagina e inviato in un header. Richiede una modifica di `escpos.js` e trasforma `POST /print` in una richiesta con preflight. Solo su scelta esplicita.

### 8.6 Safari

WebKit non considera affidabile in ogni caso `http://127.0.0.1` chiamato da una pagina https. Il bug 279249 (Safari 18 che bloccava contenuti localhost nelle pagine https) è stato corretto a marzo 2025, ma i bug più vecchi sul considerare sicuro il loopback (171934, 218623) «are not fixed» `[fonte: bug WebKit 279249]`. Se una pagina ospitata su GitHub Pages riesca a raggiungere l'app nel Safari attuale va provato prima di promettere il supporto a Safari. Safari non ha una richiesta di permesso simile a Local Network Access `[non verificato]`.

### 8.7 Altri limiti

- Limiti al corpo della richiesta (per esempio 4 MB), agli header e alle connessioni; limite di frequenza per origine `[stima]`. Il server Android alloca tutto il `Content-Length` prima di leggere: l'app desktop non dovrebbe farlo (segnalato a parte).
- `logoUrl`: solo https (http solo per le origini approvate), solo immagini, limite di dimensione (per esempio 1 MB), timeout, nessun reindirizzamento verso indirizzi privati o di loopback; altrimenti qualsiasi pagina può usare l'app per sondare la rete locale.
- `printer` in `/receipt` e `/config` deve indicare una stampante configurata dall'utente, mai un host o una porta liberi.
- Un filtro facoltativo per `ESC p` (cassetto), salvo che l'utente lo abiliti (proposta di progetto).
- Il registro conserva origine, dimensione, esito e ora, non il contenuto degli scontrini, che può contenere dati personali.

## 9. Esecuzione in background: tray, avvio automatico, sospensione

- **Processo.** Un'app per utente avviata all'accesso, con un'icona nel tray. Non un servizio di sistema: l'accoppiamento Bluetooth, le stampanti per utente e il tray appartengono alla sessione dell'utente `[non verificato per ogni sistema]`.
- **Avvio automatico.** Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, oppure un'attività di avvio per un pacchetto MSIX `[non verificato]`. macOS: `SMAppService` (macOS 13+) per elementi di login e agent `[non verificato: la pagina di Apple non si è caricata]`; gli agent hanno bisogno di `AssociatedBundleIdentifiers` per il privilegio Rete locale ([7.3](#73-stampanti-di-rete-tcp-9100)). Linux: un file `.desktop` di avvio automatico XDG o un'unità `systemd --user` `[non verificato]`.
- **Tray.** Area di notifica di Windows; barra dei menu di macOS; StatusNotifierItem/AppIndicator su Linux, che GNOME Shell mostra tramite l'estensione AppIndicator (Ubuntu la include) `[fonte: README dell'estensione; che GNOME di base ne abbia bisogno non è verificato]`. Senza tray basta la pagina di stato su `http://127.0.0.1:8787/`.
- **Menu:** stato (server, stampante, ultimo lavoro), Apri pagina di stato, Stampa pagina di prova, Stampante…, Siti autorizzati…, Avvia all'accesso, Lingua (English/Italiano), Controlla aggiornamenti, Esci.
- **Sospensione e rallentamenti.** Dopo la sospensione, riaprire porte e Bluetooth al lavoro successivo. App Nap di macOS rallenta timer e I/O delle app in background; un'app che tiene un'asserzione di attività di `ProcessInfo` non va in App Nap `[fonte: App Nap]`: prenderne una per la durata di ogni lavoro. La modalità efficienza di Windows non è stata approfondita `[non verificato]`.
- **Watchdog,** come `BridgeService` e `Health` su Android: se il ciclo di accept muore, rimettersi in ascolto; una sola istanza.
- **Lingua:** inglese e italiano, secondo il sistema, con la possibilità di cambiarla; riusare i testi di `android/app/src/main/res/values*/strings.xml` perché i messaggi dell'API coincidano con quelli dell'app.

## 10. Aggiornamenti

- Aggiornamenti firmati da GitHub Releases via HTTPS, controllati all'avvio e una volta al giorno, mai installati durante un lavoro; l'API HTTP resta compatibile con le versioni precedenti.
- Strumenti: l'updater di Tauri («needs a signature … This cannot be disabled»; file JSON statico o server) `[fonte]`; Velopack (Windows, macOS, Linux; aggiornamenti differenziali; utilizzabile da Go, Rust, C#/.NET, Electron, Tauri) `[fonte]`; Sparkle e WinSparkle non approfonditi.
- I canali degli store si aggiornano da soli: Microsoft Store, winget (`winget upgrade`), Homebrew (`brew upgrade`), repository Flatpak, apt e dnf.

## 11. Pacchetti e firma del codice

### 11.1 Windows

- **Formati:** MSIX tramite il Microsoft Store (lo Store rifirma il pacchetto gratis; l'account sviluppatore è gratuito) `[fonte: code signing options]`; un installer MSI/EXE, che lo Store accetta ma che va firmato in proprio con un certificato di una CA attendibile `[fonte]`; un manifest winget che punta all'installer su GitHub Releases (validazione automatica e scansione antimalware; 7 giorni per correggere una pull request rimandata dal bot) `[secondaria: pagina del repository winget, estratto di ricerca]`.
- **Firma fuori dallo Store** `[fonte: code signing options, 2026-08-29]`:
  - Azure Artifact Signing (prima Trusted Signing): circa 9,99 USD al mese; organizzazioni in USA, Canada, UE e Regno Unito, sviluppatori individuali solo in USA e Canada.
  - Certificato OV: 150-300 USD l'anno; da giugno 2023 la chiave privata deve stare su un HSM o un token hardware.
  - Certificato EV: oltre 400 USD l'anno; dal 2024 non salta più SmartScreen.
  - SignPath Foundation: gratuito per i progetti open source che ne hanno i requisiti.
  - In ogni caso SmartScreen avvisa sui file nuovi finché la reputazione non cresce con i download sotto un'identità di firma costante; i file non firmati ricevono uno «strong SmartScreen block» e le aziende possono bloccarli del tutto.

### 11.2 macOS

- Apple Developer Program: «99 USD per membership year» `[fonte: Apple enroll]`; l'iscrizione comprende il certificato Developer ID e la notarizzazione `[secondaria: forum sviluppatori Apple]`. Firmare con hardened runtime, notarizzare con `notarytool`, applicare il ticket con staple `[non verificato: la pagina di Apple sulla notarizzazione non si è caricata]`.
- Eseguibile universale (arm64 + x86_64). `Info.plist`: `NSLocalNetworkUsageDescription` per TCP 9100 `[fonte: TN3179]`, e il testo d'uso del Bluetooth se si usa il Bluetooth.
- Distribuzione: DMG o ZIP su GitHub Releases; cask di Homebrew. Homebrew 5.0.0 ha deprecato `--no-quarantine` e annunciato «We will disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026» `[fonte: Homebrew 5.0.0]`; non ho controllato com'è andata `[non verificato]`. In pratica anche Homebrew richiede un'app notarizzata. Mac App Store: non considerato (sandbox, revisione) `[non verificato]`.

### 11.3 Linux

- AppImage (un solo file, qualsiasi distribuzione), `.deb` (Debian, Ubuntu), `.rpm` (Fedora, openSUSE), Flatpak: nella sandbox `--device=all` dà accesso ai dispositivi e `--allow=bluetooth` ai socket `AF_BLUETOOTH` `[fonte: Flatpak]`; l'accesso a BlueZ via D-Bus lì non è trattato `[non verificato]`. Snap non approfondito.
- Nessun controllo all'avvio da parte del sistema: firmare repository e pacchetti con GPG; documentare il gruppo della seriale e, per le stampanti USB, le regole udev.

## 12. Confronto delle tecnologie e raccomandazione

Due domande decidono quasi tutto: (a) il programma può riusare `escpos.js` per `/receipt` e per il BLE, e (b) per ogni trasporto esiste una libreria che ho potuto verificare. «Non approfondito» vuol dire che non ho cercato; non vuol dire che la libreria manchi.

| | Go | Tauri 2 (Rust) | Electron (Node + Chromium) | Flutter (Dart) | .NET |
|---|---|---|---|---|---|
| Server HTTP su 127.0.0.1 | libreria standard | un crate Rust (non approfondito) | `http` di Node | `dart:io` `[non verificato]` | Kestrel o HttpListener `[non verificato]` |
| Seriale | go.bug.st/serial; elenco con VID/PID USB; cgo necessario su macOS `[fonte]` | serialport-rs: Linux, macOS, Windows; libudev per default su Linux `[fonte]` | Node SerialPort, Linux, Mac, Windows, funziona in Electron `[fonte]`; oppure Web Serial nella finestra (`select-serial-port`) `[fonte]` | flutter_libserialport (libserialport; Linux, macOS, Windows, Android; ultimo rilascio circa 14 mesi fa) `[fonte]` | System.IO.Ports (pacchetto NuGet) `[fonte]`; supporto Linux e macOS non ricontrollato `[non verificato]` |
| Spooler di Windows, RAW | alexbrainman/printer: `StartRawDocument`, `Write` `[fonte]` | il crate `windows` espone `WritePrinter` `[fonte]` | modulo nativo o programma ausiliario (non approfondito) | il pacchetto `win32` espone `WritePrinter` `[fonte]` | P/Invoke verso winspool `[non verificato]` |
| CUPS | eseguire `lp`, oppure IPP | idem | idem | idem | idem |
| TCP 9100 | libreria standard | libreria standard | `net` di Node | `dart:io` | `System.Net.Sockets` |
| BLE | tinygo-org/bluetooth `[fonte]` | btleplug, niente Classic `[fonte]` | Web Bluetooth nella finestra, `select-bluetooth-device` `[fonte]`: esegue `RawBT.ble` e i driver così come sono | universal_ble `[fonte]` | 32feet / InTheHand: Windows, macOS, Android, iOS; Linux non citato `[fonte]` |
| RFCOMM Classic senza porta COM | non trovato | non trovato | Web Serial nella finestra (Chromium fa RFCOMM dalla 117) `[non verificato in Electron]` | non trovato | 32feet `InTheHand.Net.Bluetooth`, piattaforme non confermate `[non verificato]` |
| Riuso di `escpos.js` | serve un motore JS (goja, non approfondito) | nella webview `[non verificato]` | sì, così com'è | serve un motore JS | serve un motore JS (Jint, non approfondito) |
| Interfaccia | tray + pagina servita | tray + finestra webview | tray + finestra Chromium | widget nativi | tray (Avalonia, non approfondito) |
| Aggiornamenti | Velopack `[fonte]` | updater di Tauri `[fonte]` | Velopack `[fonte]`; electron-updater non approfondito | pacchetti della comunità, non approfonditi | Velopack `[fonte]` |
| Dimensioni | un eseguibile statico, piccolo `[non verificato: non misurato]` | «very small binaries» `[fonte]`, usa la webview del sistema | grandi: include Chromium e Node `[non verificato: non misurato]` | medie `[non verificato]` | medie, più piccole con trimming o AOT `[non verificato]` |
| Build | compilazione incrociata facile, salvo macOS (cgo) | una build per sistema | una build per sistema | una build per sistema | una build per sistema |
| Manutenzione di sicurezza | bassa | bassa | alta: seguire i rilasci di Chromium | media | media |
| Impegno per la versione 1 `[stima]` | da basso a medio | medio (Rust) | basso, grazie al riuso del codice di scontrino e BLE; manutenzione alta | medio | medio |

Considerato anche: **Kotlin sulla JVM** riuserebbe `Receipt.kt` ed `EscPos.kt` quasi tali e quali e resterebbe vicino al codice Android; include un runtime Java e le sue opzioni BLE su desktop sembrano scarse `[non verificato, non approfondito]`.

**Raccomandazione.**

1. **Go per la versione 1**, se il responsabile accetta un piccolo porting di `Receipt.kt`. L'app è soprattutto un server HTTP e dei canali di byte; Go ha HTTP e TCP nella libreria standard e librerie verificate per le porte seriali e lo spooler RAW di Windows; un eseguibile firmato per sistema, niente webview; l'interfaccia esiste già, è `app.html` servita dall'app. Punti deboli: cgo su macOS (elenco delle seriali, tray), nessun RFCOMM diretto verificato, BLE solo tramite tinygo-org/bluetooth.
2. **Electron** se il riuso byte per byte di `escpos.js` (scontrino, driver BLE, Web Serial con RFCOMM) conta più delle dimensioni e della manutenzione di sicurezza. È la strada più rapida verso BLE e SPP senza codice nativo.
3. **Tauri** se qualcuno nel gruppo scrive Rust: piccolo, con tray, avvio automatico e aggiornamenti firmati; seriale e spooler verificati; BLE tramite btleplug.
4. Flutter e .NET sono possibili ma qui non portano vantaggi: il pacchetto seriale di Flutter è il meno mantenuto tra quelli controllati, e la libreria Bluetooth .NET controllata non cita Linux.

## 13. Fasi e impegno indicativo

`[stima]`, uno sviluppatore esperto.

| Fase | Contenuto | Impegno |
|---|---|---|
| 0. Prova tecnica | `/status` e `/print` verso una porta COM su Windows; verificare se Safari raggiunge l'app dal sito su GitHub Pages; verificare le richieste Local Network Access in Chrome e Firefox | 3-5 giorni |
| 1. Windows, versione 1 | API completa ([5.1](#51-endpoint)) con il porting di `/receipt` e i dati di prova di `test/layout-test.js`, `/config`, `/selftest`; seriale e SPP via COM, spooler RAW, TCP 9100; approvazione dei siti, controllo di Host, limiti; tray, avvio automatico, inglese/italiano; installer firmato | 3-4 settimane |
| 2. macOS e Linux | tty e SPP, CUPS raw, TCP con il privilegio Rete locale, `SMAppService` / avvio automatico XDG, notarizzazione, AppImage/deb/rpm, diagnosi dei permessi | 2-3 settimane |
| 3. Distribuzione | aggiornamenti, winget, cask di Homebrew, Microsoft Store se si vuole, documentazione (sezione del README, una scheda nella pagina iniziale) | 1-2 settimane |
| 4. Facoltativa | trasporto BLE (profili, cadenza, driver Phomemo), RFCOMM diretto per sistema, lavori inviati da un server | 2-6 settimane |

Costi ricorrenti: Apple 99 USD l'anno; firma per Windows circa 120 USD l'anno (Artifact Signing, se si ha diritto) o 150-300 USD l'anno (OV); il tempo per seguire i cambiamenti dei sistemi (stampa di Windows, CUPS, privacy di macOS).

## 14. Matrice di test

**Sistemi:** Windows 10 22H2 e il Windows 11 attuale; macOS 13 (minimo per `SMAppService`) e le due versioni principali più recenti, Apple silicon e Intel; Ubuntu LTS (GNOME con AppIndicator), Fedora (GNOME senza), una distribuzione KDE.

**Trasporti × sistemi** (numero = fase in cui la prova deve passare):

| Trasporto | Windows | macOS | Linux |
|---|---|---|---|
| Adattatore USB-seriale | 1 | 2 | 2 |
| Bluetooth SPP (porta virtuale o RFCOMM) | 1 | 2 | 2 |
| Spooler RAW, driver del produttore | 1 | 2 (CUPS raw) | 2 (CUPS raw) |
| Spooler RAW, Generic / Text Only | 1 | – | – |
| TCP 9100 | 1 | 2 (richiesta Rete locale) | 2 |
| BLE | 4 | 4 | 4 |

**Browser × origine della pagina × permesso:** Chrome, Edge, Firefox, Safari (macOS) × pagina servita dall'app (`http://127.0.0.1:8787/`) e sito pubblico su GitHub Pages (`https://…`) × permesso non ancora chiesto, concesso, negato, preautorizzato da una policy aziendale. Verificare `RawBT.check()`, `RawBT.localAccess()`, `sendApi`, `sendReceipt`, e `printLayout` con `via: 'auto'` e `via: 'app'`.

**Stampanti:** una stampante Bluetooth SPP da 58 mm (quella con cui si prova l'app Android), una stampante USB da 80 mm con il driver del produttore, una stampante Ethernet, una stampante USB-seriale; per la fase 4, una Phomemo (solo BLE).

**Robustezza:** sospensione e ripresa; cavo staccato durante un lavoro; stampante spenta o fuori portata (timeout di connessione di 8 s); stampante SPP occupata da un telefono; due schede che stampano insieme; un raster del logo da 576 punti; una stampante che perde byte senza invio cadenzato; Local Network Access negato; app non in esecuzione (ripieghi di `escpos.js`, `RawBT.send` su un computer); porta 8787 occupata; due utenti Windows connessi; aggiornamento a riposo.

**Colonna di riferimento:** per ogni caso dell'API, confrontare con l'app Android: stessa richiesta, stessa forma del JSON, stessi valori di `level`.

## 15. Rischi

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| Non serve a nessuno: Web Bluetooth e Web Serial coprono gli utenti reali | media | lavoro sprecato | decidere prima su casi reali (D1) |
| Safari non raggiunge 127.0.0.1 dalle pagine https | media | niente supporto a Safari | prova nella fase 0; servire la pagina dall'app |
| I cambiamenti della stampa di Windows (driver di classe IPP preferito, stampa protetta) rompono lo spooler RAW | media, in crescita | la via dello spooler non funziona | preferire seriale, TCP, USB diretta; documentare Generic / Text Only |
| CUPS elimina le code raw | bassa entro due anni `[stima]` | la via dello spooler su macOS/Linux non funziona | vie TCP e USB diretta |
| Su macOS l'SPP non ha un nodo di dispositivo né una libreria RFCOMM provata | alta | niente SPP su macOS senza codice nativo | il Web Serial di Chrome copre già l'SPP su macOS; IOBluetooth più avanti |
| Identità di firma: Artifact Signing non è aperto agli individui fuori da USA e Canada | alta per un individuo in Italia | avvisi SmartScreen, costi maggiori | account aziendale, certificato OV, o SignPath per l'open source |
| Gli avvisi di SmartScreen e Gatekeeper spaventano gli utenti | media | carico di assistenza | firmare dal primo rilascio, identità costante |
| Pagine ostili stampano o aprono il cassetto | bassa con Local Network Access, più alta in Safari e nei browser vecchi | abusi | approvazione dei siti, filtro del cassetto |
| Conflitti di porta, macchine Windows condivise | bassa | errori poco chiari | messaggio chiaro nel tray; D7 |
| I due prodotti (Android e desktop) divergono | media | scontrini diversi | dati di prova condivisi, stesse prove dell'API |
| Chrome continua a cambiare le regole di Local Network Access | media | richieste di permesso o errori | restare su `fetch` HTTP semplice; seguire i rilasci di Chrome |

## 16. Decisioni aperte per il responsabile

- **D1. Costruirla o no?** Quali utenti reali hanno una stampante USB con driver, una stampante di rete, Safari o Firefox? Senza di loro, meglio continuare a investire in Web Serial e Web Bluetooth.
- **D2. Tecnologia:** Go (consigliato), Electron o Tauri ([sezione 12](#12-confronto-delle-tecnologie-e-raccomandazione)).
- **D3. Trasporti della versione 1:** seriale/SPP, spooler RAW, TCP 9100 (proposti); BLE più avanti o mai.
- **D4. Impaginazione dello scontrino:** portare `Receipt.kt`, oppure eseguire `escpos.js` dentro l'app (dalla 1.13.0 il suo layout `receipt` segue `labels` e la lingua come `Receipt.kt`, [sezione 6.3](#63-impaginazione-dello-scontrino-post-receipt)).
- **D5. Distribuzione e costi:** chi detiene le identità di firma (una persona o un'azienda: Artifact Signing per gli individui è solo USA/Canada), 99 USD l'anno ad Apple, quali canali (Microsoft Store, winget, Homebrew, Flatpak).
- **D6. Sicurezza predefinita:** approvazione dei siti al primo uso (proposta) oppure aperta come l'app Android; richieste senza `Origin`; filtro del cassetto.
- **D7. Macchine Windows condivise:** un'app per macchina, rifiuto, o porte per utente.
- **D8. Nome e identificativi:** «Print Bridge» (marchio neutro), identificativo dell'app (`com.rawbtprint.bridge` come su Android?), nome dell'editore nell'installer (deve coincidere con l'identità di firma).
- **D9. Versioni e repository:** stesso numero di versione dell'app Android o uno proprio; stesso repository (una cartella `desktop/`, CI per sistema) o uno nuovo.
- **D10. Lavori inviati da un server** (stampa senza pagine aperte): fuori ambito o fase successiva.
- **D11. Allineamento con Android:** l'app Android deve adottare gli stessi irrobustimenti (approvazione dei siti, controllo di Host, limite del corpo) per mantenere un solo contratto?

## 17. Modifiche facoltative in altre parti del repository

Non servono perché l'app funzioni; elencate per non dimenticarle.

- `escpos.js`: fatto nella 1.13.0: il layout `receipt` segue `labels` e la lingua come `Receipt.kt`; `RawBT.send()` ripiega sullo scheme `rawbtprint:` solo su Android; i commenti su Web Serial e il messaggio `serialUnsupported` citano Firefox 151 e Chrome 138 su Android. Resta aperto: ripiegare sullo scheme su un computer quando è noto un gestore.
- `app.html` e `android/app/src/main/assets/test.html`: nascondere la riga della batteria e i riferimenti ad Android quando `/status.platform` non è `android`.
- README e pagina iniziale: una scheda «app desktop» con il download, quando l'app esisterà (il README, la pagina iniziale e `serial.html` hanno già il link a questo documento).

## 18. Fonti

Aperte il 2026-10-18 salvo diversa indicazione.

**Capacità dei browser**
- Web Bluetooth CG, implementation status: <https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md>
- Chrome for Developers, Read from and write to a serial port: <https://developer.chrome.com/docs/capabilities/serial>
- Chrome for Developers, Serial over Bluetooth on the web (aggiornato il 2023-10-13): <https://developer.chrome.com/blog/serial-over-bluetooth>
- Note di rilascio di Chrome 138: <https://developer.chrome.com/release-notes/138>
- Mozilla Hacks, Announcing Web Serial support in Firefox (2026-05-21): <https://hacks.mozilla.org/2026/05/web-serial-support-in-firefox/>
- CircuitPython code editor, nota sul flag per Linux (estratto di ricerca): <https://code.circuitpython.org>
- W3C public-web-bluetooth, settembre 2024 (estratto di ricerca): <https://lists.w3.org/Archives/Public/public-web-bluetooth/2024Sep/0002.html>
- W3C public-webapps-github, giugno 2023, posizioni su Web Serial (estratto di ricerca): <https://lists.w3.org/Archives/Public/public-webapps-github/2023Jun/0172.html>
- Forum sviluppatori Zebra, WebUSB «Access denied»: <https://developer.zebra.com/content/domexception-failed-execute-open-usbdevice-access-denied>
- Documentazione Storepass, Zadig e WinUSB (estratto di ricerca): <https://admin.storepass.co/support/documentation/DfLHy7p6Ca>
- blink-dev, Intent to Implement and Ship: WebUSB Interface Class Filtering (estratto di ricerca): <https://groups.google.com/a/chromium.org/g/blink-dev/c/LZXocaeCwDw/m/GLfAffGLAAAJ>
- Chrome for Developers, Direct Sockets (aggiornato il 2025-12-17): <https://developer.chrome.com/docs/iwa/direct-sockets>
- blink-dev, PSA: permission policies for Direct Sockets in Isolated Web Apps (2026, estratto di ricerca): <https://groups.google.com/a/chromium.org/g/blink-dev/c/5cSZjgnJelk/m/K56ic8m_AgAJ>

**Accesso alla rete locale**
- Chrome for Developers, Local Network Access (2025-06-09, aggiornato il 2025-09-29): <https://developer.chrome.com/blog/local-network-access>
- Chrome for Developers, Private Network Access on hold (2024-10-09): <https://developer.chrome.com/blog/pna-on-hold>
- Dynamsoft, Chromium 142 Local Network Access: <https://www.dynamsoft.com/web-twain/docs/faq/chromium-142-local-network-access-issue.html>
- Visualware, Chrome LNA e WebSocket (estratto di ricerca): <https://myconnectionserver.visualware.com/support/v11/userguide/chrome-lna-websocket>
- Supercharge Browser, Chrome 156 Local Network Access (estratto di ricerca): <https://www.superchargebrowser.com/library/chrome-156-local-network-access/>
- Cornell IT, richiesta di rete locale di Firefox: <https://it.cornell.edu/secure-connect/firefoxlocalnetwork>
- CyberInsider, Firefox 154 e WebSocket (2026-08-19): <https://cyberinsider.com/firefox-154-blocks-silent-websocket-access-to-local-network-devices/>
- Mozilla Support, permessi di rete locale (non si è caricata; usato l'estratto di ricerca): <https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox>
- Bug WebKit 279249: <https://bugs.webkit.org/show_bug.cgi?id=279249>
- Apple TN3179, Understanding local network privacy (revisione 2026-10-06): <https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy>

**Stampa**
- CUPS, Network printers: <https://www.cups.org/doc/network.html>
- CUPS, man page di lpadmin: <https://www.cups.org/doc/man-lpadmin.html>
- CUPS, man page di lp: <https://www.cups.org/doc/man-lp.html>
- Microsoft, How To: Send Data Directly to a GDI Printer: <https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer>
- Microsoft, WritePrinter: <https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter>
- Microsoft, End of servicing plan for third-party printer drivers on Windows (aggiornato a maggio 2025): <https://learn.microsoft.com/en-us/windows-hardware/drivers/print/end-of-servicing-plan-for-third-party-printer-drivers-on-windows>
- Microsoft, Windows protected print mode: <https://learn.microsoft.com/en-us/windows/modern-print/windows-protected-print-mode/windows-protected-print-mode>
- SAPinsider, stampanti termiche non Mopria (estratto di ricerca): <https://sapinsider.org/map/lrs-ships-driverless-printing-for-sap-closing-the-windows-protected-print-gap/>
- Juniper Systems, porte COM Bluetooth su Windows (estratto di ricerca): <https://junipersys.com/support/article/14876>
- Man page di openSUSE, rfcomm(7) e rfcomm(1) in bluez-deprecated: <https://manpages.opensuse.org/Tumbleweed/bluez-deprecated/rfcomm.7.en.html>, <https://manpages.opensuse.org/Tumbleweed/bluez-deprecated/rfcomm.1.en.html>
- Microsoft, CreateProcessW: <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw>

**Pacchetti, firma, background**
- Microsoft, Code signing options for Windows app developers (2026-08-29): <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>
- Microsoft, Submit your manifest to the repository (winget; estratto di ricerca): <https://learn.microsoft.com/en-us/windows/package-manager/package/repository>
- Apple, Enroll in the Apple Developer Program: <https://developer.apple.com/programs/enroll/>
- Forum sviluppatori Apple, notarizzazione inclusa nell'iscrizione (estratto di ricerca): <https://developer.apple.com/forums/thread/746992>
- Apple, Notarizing macOS software before distribution (non si è caricata): <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
- Apple, SMAppService (non si è caricata): <https://developer.apple.com/documentation/servicemanagement/smappservice>
- Apple, App Nap: <https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html>
- Homebrew 5.0.0 (2025-11-12): <https://brew.sh/2025/11/12/homebrew-5.0.0>
- Flatpak, Sandbox permissions: <https://docs.flatpak.org/en/latest/sandbox-permissions.html>
- Estensione AppIndicator per GNOME Shell: <https://github.com/ubuntu/gnome-shell-extension-appindicator>

**Librerie**
- go.bug.st/serial: <https://github.com/bugst/go-serial>; enumerator: <https://pkg.go.dev/go.bug.st/serial/enumerator>
- alexbrainman/printer: <https://pkg.go.dev/github.com/alexbrainman/printer>
- tinygo-org/bluetooth: <https://github.com/tinygo-org/bluetooth>
- serialport-rs: <https://github.com/serialport/serialport-rs>
- crate `windows`, WritePrinter: <https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Graphics/Printing/fn.WritePrinter.html>
- btleplug: <https://github.com/deviceplug/btleplug>
- Tauri, dimensioni dell'app: <https://v2.tauri.app/concept/size/>; updater: <https://v2.tauri.app/plugin/updater/>
- Electron, accesso ai dispositivi: <https://www.electronjs.org/docs/latest/tutorial/devices>
- Node SerialPort: <https://serialport.io/docs/>
- flutter_libserialport: <https://pub.dev/packages/flutter_libserialport>
- universal_ble: <https://pub.dev/packages/universal_ble>
- `win32` per Dart, WritePrinter: <https://pub.dev/documentation/win32/latest/win32/WritePrinter.html>
- .NET System.IO.Ports.SerialPort: <https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport>
- 32feet / InTheHand: <https://github.com/inthehand/32feet>
- Velopack: <https://velopack.io/>

**File del repository letti:** `android/app/src/main/kotlin/com/rawbtprint/bridge/PrintServer.kt`, `Printer.kt`, `Receipt.kt`, `AppConfig.kt`, `SelfTest.kt`, `LogoStore.kt`, `EscPos.kt`; `escpos.js`; `app.html`; `README.md`; `serve.ps1`; `print-logo-receipt.ps1`; `test/layout-test.js`.
