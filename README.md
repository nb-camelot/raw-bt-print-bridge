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

## App Android

- **Nome**: Raw BT Print Bridge
- **Package**: `com.rawbtprint.bridge`
- **Scheme**: `rawbtprint`
- API `minSdk 23`, `targetSdk 35`.

Dalla web: `rawbtprint:base64,<payload-base64>` (vedi `escpos.js` → `RawBT.url`).
La prima volta l'app chiede quale stampante accoppiata usare e la memorizza.

## CI/CD

- `.github/workflows/build-apk.yml` — compila l'APK release ad ogni push su
  `main`/`master` (path `android/**`), oppure manualmente / su tag `v*`, e
  pubblica la Release con l'APK.
- `.github/workflows/opencode.yml` — flusso di sviluppo agentico autonomo
  **issue → plan → build → review → merge → publish**. Vedi sotto.

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
6. **Publish** — il merge avvia `build-apk.yml` → APK nella Release.

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
