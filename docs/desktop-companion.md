<!-- Design notes for a possible native desktop companion of Print Bridge (Windows, macOS, Linux). Written on 2026-10-18; the web facts were checked on that date at the linked sources. Nothing described here is implemented. Italian translation: desktop-companion.it.md. -->

# Print Bridge on a computer: design of a desktop companion app

**Status:** proposal, nothing implemented. **Italiano:** [desktop-companion.it.md](desktop-companion.it.md).

This document says what a native companion app for Windows, macOS and Linux would have to do, why, what it would cost, and which decisions it needs. Everything else in Print Bridge on a computer (landing page, English/Italian pages, Web Bluetooth, Web Serial) works without installing anything; this would be the first piece that has to be installed.

**Tags.** `[source]` = I opened the linked page on 2026-10-18 and it says this. `[secondary]` = a vendor, news or forum page says it; the primary source was not checked or did not load. `[unverified]` = my inference, general knowledge I did not re-check, or a point the sources do not settle. `[estimate]` = a rough number of mine. Links are collected in [section 18](#18-sources).

## Contents

1. [Summary](#1-summary)
2. [What browsers already reach on a computer](#2-what-browsers-already-reach-on-a-computer)
3. [What browsers cannot reach](#3-what-browsers-cannot-reach)
4. [Who needs the companion](#4-who-needs-the-companion)
5. [The contract: the same local API as the Android app](#5-the-contract-the-same-local-api-as-the-android-app)
6. [What changes on a computer](#6-what-changes-on-a-computer)
7. [Transports](#7-transports)
8. [Security](#8-security)
9. [Running in the background: tray, autostart, sleep](#9-running-in-the-background-tray-autostart-sleep)
10. [Updates](#10-updates)
11. [Packaging and code signing](#11-packaging-and-code-signing)
12. [Technology comparison and recommendation](#12-technology-comparison-and-recommendation)
13. [Phases and rough effort](#13-phases-and-rough-effort)
14. [Test matrix](#14-test-matrix)
15. [Risks](#15-risks)
16. [Open decisions for the owner](#16-open-decisions-for-the-owner)
17. [Optional changes elsewhere in the repository](#17-optional-changes-elsewhere-in-the-repository)
18. [Sources](#18-sources)

## 1. Summary

- **What.** A small app for Windows, macOS and Linux that answers the same HTTP API as the Android app on `http://127.0.0.1:8787` (`/status`, `/config`, `/selftest`, `/receipt`, `/print`, `/`, `/escpos.js`) and writes the bytes to printers that a browser cannot reach: printers installed in the operating system (Windows printers, CUPS queues), network printers on raw TCP port 9100, and serial or Bluetooth SPP printers for browsers without Web Serial. `escpos.js` and the pages already speak this API (`RawBT.check`, `sendApi`, `sendReceipt`, `printLayout` with `via: 'app'`), so they need no change.
- **Why it is not urgent.** On a computer, Chrome and Edge already print without installing anything: BLE printers over Web Bluetooth (Windows, macOS; Linux only behind a flag), USB-serial printers and paired Bluetooth Classic printers over Web Serial (Chrome 89 and 117). Firefox has Web Serial since version 151. `escpos.js` covers all of this with `RawBT.ble` and `RawBT.serial`.
- **When it pays off.** USB receipt printers installed with a vendor driver, Ethernet or Wi-Fi printers, Safari users, kiosks that print without a person choosing a port, several tabs or programs sharing one printer.
- **Recommendation.** If the owner decides to build it: a **Go** program, one binary per system, with a tray icon and the existing test page as its user interface, served by the program itself. Version 1: serial/COM ports (USB-serial and SPP), the system spooler in RAW mode, TCP 9100, approval of the sites that may print. BLE later, and only if users ask for it. Electron is the alternative when reusing `escpos.js` byte for byte matters more than size; Tauri if someone writes Rust. See [section 12](#12-technology-comparison-and-recommendation).
- **Cost.** About 7-10 person-weeks to a signed version 1 on three systems, without BLE `[estimate]`; then 99 USD a year (Apple) and about 120 USD a year (Azure Artifact Signing, if eligible) or 150-300 USD a year (OV certificate) for code signing `[source]`.
- **Before starting**, the owner should take the decisions in [section 16](#16-open-decisions-for-the-owner), first of all whether real users need it.

## 2. What browsers already reach on a computer

| Path | Chrome / Edge, Windows | Chrome / Edge, macOS | Chrome, Linux | Firefox | Safari | In Print Bridge |
|---|---|---|---|---|---|---|
| Web Bluetooth (BLE GATT) | yes, Windows 10 (Creators Update), Chrome 70 | yes | "partially implemented and not supported", behind a flag | no | no | `RawBT.ble`, image drivers, `ble.html` |
| Web Serial, USB-serial ports | yes, Chrome 89 | yes, Chrome 89 | yes, Chrome 89 | yes from 151 (desktop), with add-on gating | no | `RawBT.serial` |
| Web Serial, Bluetooth Classic SPP (RFCOMM) | yes, Chrome 117 on desktop (the source does not list the systems one by one) | same | same | not stated | no | `RawBT.serial` (SPP UUID allowed) |
| WebUSB to a USB printer | blocked by the printer driver of the system | worked in one report | blocked in one report | no | no | not used |
| Local app on `127.0.0.1` | yes, with a permission from Chrome 142 | same | same | yes, permission prompt being rolled out | uncertain (mixed content) | `RawBT.check`, `sendApi`, `sendReceipt` |

- **Web Bluetooth.** The Web Bluetooth CG implementation status lists the GATT API as shipped without a flag in Chrome on Android, ChromeOS, macOS and Windows 10 (Chrome 70; the page names both Windows 10 1703 and 1706). For Linux it says "Linux is partially implemented and not supported" and needs `chrome://flags/#enable-experimental-web-platform-features`. Firefox and Safari: not supported; Edge: since 79 `[source: implementation status]`. A newer note says that from Chromium 100 the narrower `#enable-web-bluetooth` flag is enough on Linux `[secondary: CircuitPython code editor]`; I did not check which flag current Chrome needs.
- **Web Serial.** "The Web Serial API is available on all desktop platforms (ChromeOS, Linux, macOS, and Windows) in Chrome 89" `[source: Chrome docs]`. Since Chrome 117 on desktop it also opens RFCOMM services of paired Bluetooth Classic devices, the Serial Port Profile included, "even if the operating system has not created a device node"; other UUIDs on the Bluetooth base UUID are blocked, SPP excepted `[source: Serial over Bluetooth]`. Chrome 138 brought "Web Serial API over Bluetooth RFCOMM" to Android; wired USB serial on Android is left for a future launch `[source: Chrome 138 release notes]`.
- **Firefox.** "Starting in Firefox 151 for Desktop", Web Serial is available, behind "add-on gating", the explanation and consent step first used for Web MIDI; the enterprise policy `DefaultSerialGuardSetting` controls it `[source: Mozilla Hacks, 2026-05-21]`. The post does not say whether Bluetooth RFCOMM ports are offered `[unverified]`. Firefox has no Web Bluetooth `[source: implementation status]`.
- **Safari.** No Web Serial, no Web Bluetooth. WebKit's signals on both were negative in 2023-2024 `[secondary: W3C mailing lists]`.
- The port and device choosers (`requestPort`, `requestDevice`) open only in response to a user gesture `[source: Chrome docs]`; this is why `RawBT.printLayout` opens them in the same tap.
- **WebUSB and printers.** In a Zebra developer forum thread, `open()` fails with "Access denied" on Windows 10/11 and on Ubuntu while the same page works on macOS; the only workaround found was replacing the driver with the Zadig tool `[secondary: Zebra forum]`. A point-of-sale vendor documents the same swap to WinUSB, to be repeated after Windows or vendor updates `[secondary: Storepass]`. A Chromium intent notes that INF-based WinUSB overrides for standard device classes are a known workaround that interface class filtering would make impossible `[secondary: blink-dev]`. Swapping the driver also takes the printer away from every other program. Print Bridge does not use WebUSB and this document does not propose it.

## 3. What browsers cannot reach

1. **Network printers on raw TCP.** Most Ethernet and Wi-Fi receipt printers accept ESC/POS on TCP port 9100: "AppSocket printing normally happens over port 9100 and uses the `socket` backend", and AppSocket "offers no security" `[source: CUPS network printers]`. A web page cannot open a TCP socket: Direct Sockets are "restricted to Isolated Web Apps (IWAs)" `[source: Chrome Direct Sockets]`, and a June 2026 notice on blink-dev lists Isolated Web Apps as ChromeOS only `[secondary: blink-dev PSA, search excerpt]`.
2. **Printers installed in the operating system.** A USB receipt printer installed with the vendor driver becomes a Windows printer or a CUPS queue. No web API sends raw bytes to a spooler queue. `window.print()` renders the page through the driver and a print dialog: the printer receives a picture of the page, not ESC/POS, so no native QR code, no cut command, no cash drawer `[unverified: general knowledge]`.
3. **USB printer-class devices.** They are not serial ports, so Web Serial does not list them, and WebUSB cannot open them while the system driver holds them ([section 2](#2-what-browsers-already-reach-on-a-computer)): on Windows the USB printer class driver, `usbprint.sys` `[unverified: name from general knowledge; the Zebra thread does not name it]`, on Linux the `usblp` kernel driver `[unverified]`. Only the spooler, or a program that talks to the device, reaches them.
4. **Browsers without the APIs.** Safari has neither Web Serial nor Web Bluetooth. Firefox has no Web Bluetooth and has Web Serial only from 151, with an extra consent step. Chrome on Linux needs a flag for BLE. Any browser that can call `http://127.0.0.1` from the page can use a companion; Safari may block even that ([section 8.6](#86-safari)).
5. **Printing without a person at the page.** Web Serial and Web Bluetooth need a tap the first time on each site, and the connection lives inside the tab: when the tab closes, the port closes. A companion keeps the printer for every tab and every site and prints a request without any gesture. Printing when *no page is open at all* (jobs pushed by a server) is not covered by the Android app either; it would be a new feature, the companion pulling jobs from a server (decision D10).
6. **One printer, many tabs.** A serial port opened by one tab cannot be opened by another at the same time `[unverified: behaviour of Chrome's serial implementation]`. A companion queues the jobs of all tabs and programs.

## 4. Who needs the companion

| Situation | Without the companion | With the companion |
|---|---|---|
| BLE printer, Chrome or Edge on Windows or macOS | prints (`ble.html`, `RawBT.ble`) | not needed |
| USB-serial or paired SPP printer, Chrome or Edge | prints (Web Serial, `RawBT.serial`) | optional: no tap, shared by tabs |
| USB receipt printer installed with a driver | does not print ESC/POS | prints (spooler, RAW) |
| Ethernet or Wi-Fi printer on port 9100 | does not print | prints (TCP) |
| Safari on macOS | does not print | prints, if Safari lets the page reach 127.0.0.1 (uncertain) |
| Firefox | Web Serial from 151, no BLE | prints on every transport of the companion |
| Linux with a BLE printer | only with a Chrome flag | prints if the companion gets BLE (phase 4) |
| Kiosk, unattended printing | one tap per site and printer | no tap |

## 5. The contract: the same local API as the Android app

Read from `android/app/src/main/kotlin/com/rawbtprint/bridge/PrintServer.kt`, `Printer.kt`, `Receipt.kt`, `AppConfig.kt`, `SelfTest.kt`, the README section "API HTTP locale dell'app" and `escpos.js`. The companion must behave the same way; anything it adds must be optional fields that existing clients ignore.

### 5.1 Endpoints

| Method | Path | Request | Answer | Notes |
|---|---|---|---|---|
| OPTIONS | any | – | 204, empty body | CORS preflight: the JSON POSTs to `/config` and `/receipt` send one |
| GET | `/status` | – | 200, JSON of [5.2](#52-status-fields-the-pages-read) | must contain `"app": true`: `RawBT.check()` treats any other JSON as "not the app" |
| GET | `/config` | – | 200, configuration JSON | |
| POST | `/config` | JSON: `paperWidth`, `logoMode`, `logoValue`, `logoUrl`, `printer`, `printerName` | 200 with the configuration, or 400 `{ok:false, error}` | with `logoUrl` the logo is downloaded before the answer (`escpos.js` waits up to 45 s) |
| GET | `/selftest` | – | 200 `{ok, level, summary, ms, version, versionCode, device, items:[{name, level, detail}]}`; 503 if not initialised | no printing; may take seconds |
| POST | `/receipt` | receipt JSON (README) | 200 `{ok:true, bytes, summary}`; 200 `{ok:false, error}` when the printer fails; 400 `{ok:false, error}` for invalid JSON | rendered by the app; `width` 16-64 columns, `printer` replaces the chosen printer, `labels` fixes the "code" and "total" labels |
| POST | `/print` | ESC/POS in base64 as text (`escpos.js` sends `Content-Type: text/plain`); a body that is not base64 is printed as it is | 200 `{ok:true, bytes}` or `{ok:false, error}`; empty body 400 | `text/plain` keeps it a CORS "simple request": no preflight |
| GET | `/`, `/test` | – | the test page (`app.html` with `<script src="escpos.js">`) | same origin: no Local Network Access permission, no CORS |
| GET | `/escpos.js` | – | the bundled client, same version | |
| GET, HEAD | `/receipt`, `/print` | – | 405 with a hint to use POST | |
| anything else | | | 404 `{"ok":false,"error":"not found"}` | |

Headers on every answer (`respond()` in `PrintServer.kt`):

```
Content-Type: <type>; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Private-Network: true
Cache-Control: no-store
Connection: close
```

### 5.2 `/status` fields the pages read

- Configuration: `paperWidth` (columns, 16-64, default 32), `paperPixels` (columns × 12), `logoMode` (`none`, `asset`, `file`, `url`), `logo` (label), `printer`, `api` (the four URLs).
- App: `app: true`, `port`, `version`, `versionCode`, `state`, `detail`, `device`.
- Health objects, each `{level, message}` with `level` among `ok`, `warn`, `error`, `unknown`: `server` (plus `bound`, `uptimeS`, `restarts`, `requests`), `calls` (plus `inFlight`, `waiting`), `bluetooth`, `power`. `app.html` shows all four rows, so the companion must send all four, `power` included when it has nothing to say (level `ok`, message "not applicable on this computer", or the sleep state).
- `/status` never waits for Bluetooth or a printer: the Android app answers from cached values. The companion must do the same, because `RawBT.check()` gives up after 5 s and Chrome queues identical GET requests behind one that hangs (README, "Funzioni di RawBT").

### 5.3 Behaviour to keep

- **One job at a time per printer.** Android refuses a second job with `{ok:false, error}` (busy) while one is running. A computer can queue instead, but must answer before `escpos.js` gives up (`sendApi` 40 s, `sendReceipt` 60 s): otherwise the page reports a timeout for a job that prints later, and a retry prints it twice. Wait in the queue at most about 20 s, then answer busy `[estimate]`.
- **Pacing.** 256-byte writes with 25 ms pauses towards Bluetooth SPP printers: cheap printers have a serial link without flow control between the radio and the CPU and drop bytes (comment in `Printer.kt`). `RawBT.serial` uses the same numbers. Keep them for serial and SPP; TCP and the spooler should not need them `[unverified for every printer]`.
- **Timeouts.** Connection 8 s; write timeout `max(15 s, 5 s + bytes × 50 ms / 256)`, as in `Printer.kt`.
- **Messages in the user's language.** `message`, `detail`, `summary`, `error` follow the app language (English or Italian); field names and `level` values never change (README, "Lingua dell'app").
- **A slow client blocks nothing.** 30 s socket timeout, 32 KB header limit, `Connection: close`, one thread per connection.

### 5.4 What `escpos.js` expects (no change needed)

- `localJson()` calls with `targetAddressSpace: 'loopback'` and `cache: 'no-store'`; default timeouts: `check` 5 s, `sendApi` 40 s, `sendReceipt` 60 s, `selftest` 30 s, configuration 10 s (45 s with `logoUrl`).
- `RawBT.apiPort` is 8787. A page can change it, none of ours does: the companion must listen on 8787.
- `RawBT.chooseVia` picks `app` when `RawBT.lastCheck.ok` is true (the companion answered `check()`), after a BLE printer paired in the tab and a serial port open in the tab. A page that calls `RawBT.check()` when it loads and then `RawBT.printLayout` prints through the companion without changes.

## 6. What changes on a computer

### 6.1 Printer identity

On Android `printer` is a Bluetooth MAC address. A computer has more kinds of printers, so the companion stores a URI:

| URI | Meaning |
|---|---|
| `serial:COM5?baud=9600`, `serial:/dev/ttyUSB0?baud=19200` | serial port: USB-serial, or the virtual COM port of a paired SPP printer |
| `bt:5A:4A:D5:BC:47:08` | Bluetooth Classic SPP by address: the companion finds its virtual port or opens the RFCOMM channel |
| `spool:EPSON TM-T20II Receipt` | system printer queue, RAW |
| `tcp:192.168.1.50:9100` | network printer |
| `ble:<id>` | BLE printer (phase 4) |

A bare MAC in `printer` (what existing pages and `/receipt` send) is read as `bt:<MAC>`. `/config` and `/status` may return extra optional fields (`printerUri`, a `printers` list, `platform`); existing clients ignore them.

### 6.2 `/status` and `/selftest`

- New optional field `platform`: `windows`, `macos`, `linux` (and `android` in the app, later), so pages can word their hints for the right system.
- `bluetooth`: Bluetooth adapter state when the printer is Bluetooth, otherwise the state of the transport in use (port present, queue present, host reachable).
- `power`: on macOS, whether App Nap or sleep could delay jobs; elsewhere `ok`.
- Self-test items: server listening on 127.0.0.1:8787; printer configured; transport ready (port exists and opens, queue exists and accepts RAW, TCP connection within 3 s); permissions (Linux serial group, macOS Bluetooth and Local Network); start at login enabled; version and update channel.

### 6.3 Receipt rendering (`POST /receipt`)

Two ways, both acceptable:

1. **Port `Receipt.kt` and `EscPos.kt`** (about 260 lines of Kotlin) to the companion's language. The logo follows `LogoStore.rasterize`: scale into paper width × maximum rows, grey = 0.299 R + 0.587 G + 0.114 B composited on white, threshold, `GS v 0` raster.
2. **Run `escpos.js`** (`PrintBridge.render('receipt', spec)`) inside the companion: free in Electron (Node or renderer) and in Tauri (webview); in Go or .NET it needs an embedded JavaScript engine (goja, Jint; not researched). The bytes are then identical to the web client's. **But today the `receipt` layout of `escpos.js` reproduces only the Italian receipt** ("Ricevuta n.", "TOTALE EUR", `dd/MM/yyyy`) and ignores `labels`, while `Receipt.kt` follows the app language and `labels`: it must be fixed first (reported separately).

Either way, `test/layout-test.js` already decodes ESC/POS and compares the `escpos.js` receipt with a model of `Receipt.kt`: the same fixtures can check the companion's bytes.

### 6.4 The page served at `/`

Ship `app.html` and `escpos.js` with the companion, as the Android build ships `assets/test.html`. Some texts of the page speak of the Android app and of the battery: with `platform` in `/status` the page can hide those rows (optional page change, [section 17](#17-optional-changes-elsewhere-in-the-repository)).

### 6.5 The `rawbtprint:` scheme

`RawBT.send()` (not `sendApi`, not `printLayout`) opens `rawbtprint:base64,<data>` when the API refuses the connection within 3 s, and returns `{ok:true, fallback:true, confirmed:false}`. On a computer nothing handles that scheme today, so the page believes the job was handed over while nothing prints (reported separately). The companion could register the scheme to start itself (Windows `HKCU\Software\Classes\rawbtprint`, macOS `CFBundleURLTypes`, Linux `MimeType=x-scheme-handler/rawbtprint` in the `.desktop` file) `[unverified: not tested]`. It cannot be a transport on Windows: a command line is at most 32,767 characters `[source: CreateProcessW]`, and the base64 of a logo raster alone is several KB `[estimate]`. Use it only to start the companion, and print the payload only when it fits.

### 6.6 Port 8787 and several users

- If port 8787 is taken, the companion says so in the tray and in its log; it must not move silently to another port, because pages call 8787.
- On Windows with several sessions (fast user switching, Remote Desktop) the loopback interface is one per machine `[unverified]`: only one companion can listen, and the pages of user B would reach user A's companion and printer. Options: one companion per machine, a refusal with a clear message, or per-user ports with a page setting (decision D7).

## 7. Transports

### 7.1 Serial and COM ports (USB-serial, Bluetooth SPP)

- Names: `COMn` (Windows); `/dev/cu.*` (macOS; `cu.` rather than `tty.` for outgoing connections `[unverified]`); `/dev/ttyUSB*`, `/dev/ttyACM*` (Linux).
- Settings: 9600-115200 baud, 8N1, no flow control. `serve.ps1` and `print-logo-receipt.ps1` also raise DTR and RTS, which some adapters need `[unverified per adapter]`.
- **SPP on Windows:** pairing a printer that offers SPP creates an outgoing virtual COM port, listed in *More Bluetooth settings → COM Ports* and in Device Manager `[secondary: Juniper Systems]`. `serve.ps1` already prints this way (COM9).
- **SPP on macOS:** paired SPP devices may appear as `/dev/cu.<name>`; I found no current documentation and the reports are mixed `[unverified]`. The direct alternative is an RFCOMM channel through Apple's IOBluetooth framework `[unverified, not researched]`.
- **SPP on Linux:** the `rfcomm` tool (`rfcomm bind`) ships in packages named `bluez-deprecated` / `bluez-deprecated-tools` `[source: openSUSE man pages]`; programs can open an RFCOMM socket directly, `socket(PF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM)` `[source: rfcomm(7)]`.
- Chrome already opens SPP printers without a device node of the system ([section 2](#2-what-browsers-already-reach-on-a-computer)), so direct RFCOMM is possible on all three systems; whether a library does it for the chosen language is open ([section 12](#12-technology-comparison-and-recommendation)).
- **Open, write, close for each job** with SPP, as `Printer.kt` does: an SPP printer accepts one connection, so keeping it open would block phones and other computers. With USB-serial, keeping the port open is faster and harmless.
- Linux: the user must belong to the group that owns serial devices (`dialout` on Debian, Ubuntu and Fedora; `uucp` on Arch) `[unverified per distribution]`. The companion should recognise the permission error and show the exact command. A Flatpak needs `--device=all` `[source: Flatpak]`.

### 7.2 System spooler, RAW

- **Windows:** `OpenPrinter` → `StartDocPrinter` with `DOC_INFO_1.pDatatype = "RAW"` → `StartPagePrinter` → `WritePrinter` → `EndPagePrinter` → `EndDocPrinter` → `ClosePrinter` `[source: Send data directly to a GDI printer]`. `WritePrinter` "is a blocking or synchronous function and might not return immediately" (call it away from the UI thread) and "only supports GDI printing and must not be used for XPS printing" `[source: WritePrinter]`. A queue with an XPS-only (v4) driver may therefore refuse or alter RAW jobs `[unverified]`; the safe setup is the vendor's v3 driver or the "Generic / Text Only" driver on the printer's port `[unverified]`. Queues are listed with `EnumPrinters`.
- **Changes in Windows printing.** From 2026-01-15 no new third-party printer drivers on Windows Update for Windows 11+; from 2026-07-01 the inbox IPP class driver is always preferred; from 2027-07-01 no third-party driver updates except security fixes; existing drivers can still be installed from the vendor's package `[source: end of servicing plan]`. Windows protected print mode uses only Windows Ready Print (Mopria printers); it is turned on in Settings ("highly recommended") or by group policy, and "printers that use third-party drivers are uninstalled" when it is enabled `[source: Windows protected print mode]`. ESC/POS receipt printers are rarely Mopria certified `[secondary: SAPinsider]`. The spooler path may get harder over time; serial, TCP and direct USB do not depend on it.
- **macOS and Linux (CUPS):** a raw queue (`lpadmin -p NAME -E -v URI -m raw`) passes the bytes unchanged; jobs go with `lp -d NAME -o raw FILE` or over IPP `[unverified: -o raw is not on the current cups.org lp page]`. CUPS says "Models other than "everywhere" are deprecated and will not be supported in a future version of CUPS", and that printer drivers are deprecated `[source: lpadmin man page]`; I found no removal date `[unverified]`. Plan a direct path too: TCP for network printers; for USB printers on Linux the kernel printer device `/dev/usb/lp0` `[unverified]`, on macOS a libusb claim of the printer interface, which no system driver holds as the WebUSB report suggests `[unverified]`.
- Success on the spooler means "the spooler accepted the job", not "the paper came out".

### 7.3 Network printers, TCP 9100

- Open TCP to `host:9100` (`socket://` in CUPS terms), write, close; no encryption, no authentication `[source: CUPS network printers]`. Connection timeout 3-5 s `[estimate]`.
- Discovery: start with an IP address typed by the user; Bonjour/mDNS browsing later (the service type of raw port 9100 is `_pdl-datastream._tcp` `[unverified]`).
- **macOS 15 and later:** an outgoing TCP connection to an address of the local network needs the Local Network privilege, and the system asks the first time; listening for incoming connections does not need it; launchd daemons and processes running as root are exempt, launchd agents are not (they set `AssociatedBundleIdentifiers`); the app declares `NSLocalNetworkUsageDescription`; it must be signed with an Apple-issued identity or the privilege tracking may misbehave; MDM cannot preconfigure the privilege `[source: TN3179]`.
- Only printers configured by the user may be targets: the companion never connects to a host or port sent by a page ([section 8.7](#87-other-limits)).

### 7.4 BLE (optional, phase 4)

- Browsers already print to BLE on Windows and macOS. A companion would add BLE for Safari, Firefox and Linux users.
- Libraries: btleplug (Rust; Windows 10, macOS, Linux, iOS, Android; central role only; "DOES NOT SUPPORT BLUETOOTH 2/CLASSIC") `[source]`; tinygo-org/bluetooth (Go; Linux central and peripheral, macOS central, Windows through WinRT; no Classic) `[source]`; universal_ble (Flutter; Android, iOS, macOS, Windows, Linux, web) `[source]`; Electron exposes Web Bluetooth to its pages and lets the program pick the device in a `select-bluetooth-device` handler instead of Chrome's chooser `[source: Electron device access]`.
- The work: port from `escpos.js` the BLE profiles, chunk sizes, write modes and the Phomemo drivers (`PrintBridge.drivers`, credit flow), or run `escpos.js` itself (Electron). macOS asks for the Bluetooth permission `[source: btleplug README]`.

### 7.5 USB printers without a queue

Not in version 1. On Windows the device belongs to the printer driver ([section 2](#2-what-browsers-already-reach-on-a-computer)); replacing it with WinUSB breaks every other program. For macOS and Linux see [7.2](#72-system-spooler-raw).

## 8. Security

**Threat model.** Every page open in any browser of the user can send requests to `127.0.0.1:8787`; so can every local program and, on shared machines, other users. A hostile page could print rubbish or offensive text, waste paper, open the cash drawer (ESC/POS `ESC p` pulse), read the configured printer and logo URL, make the companion download a URL (`logoUrl`) and, if allowed, connect to hosts of the local network. The Android app has the same exposure today, reduced by Chrome's Local Network Access prompt.

### 8.1 Listen on loopback only

Listen on `127.0.0.1` only, as `PrintServer.kt` does (`InetAddress.getByAddress(127, 0, 0, 1)`), never on `0.0.0.0` or `::`. On Windows a loopback listener should not trigger the firewall prompt `[unverified]`; on macOS listening needs no Local Network privilege `[source: TN3179]`.

### 8.2 Host header

Accept only `Host: 127.0.0.1:8787` (and `localhost:8787`). This stops DNS rebinding, where a hostile domain resolves to 127.0.0.1 and its page becomes "same origin" as the companion `[unverified: whether Local Network Access alone already blocks it]`.

### 8.3 CORS and Private Network Access

- Keep the headers of [5.1](#51-endpoints) (`*`), or echo the `Origin` of approved sites. CORS does not stop delivery: a cross-origin `POST /print` with `text/plain` is a simple request, it reaches the server, only the answer is hidden from the page. **The companion must check `Origin` before printing, not rely on CORS.**
- `Access-Control-Allow-Private-Network: true`: Chrome's Private Network Access preflights "are not currently enforced", their rollout "is currently on hold" since October 2024 `[source: PNA on hold]`; Local Network Access replaces them with a permission `[source: Chrome LNA]`. Keeping the header costs nothing.

### 8.4 Local Network Access prompts (Chrome, Edge, Firefox)

- From Chrome 142 a public page needs the user's permission to reach local or loopback addresses, and 127.0.0.0/8 counts as loopback `[source: Chrome LNA]`; Chrome 142 shipped on 2025-10-28 `[secondary: Dynamsoft]`. From Chrome 145 the permission is split in two: `loopback-network`, "Apps on device" (the one Print Bridge needs), and `local-network`, "Local Network"; the enterprise policy `LocalNetworkAccessAllowedForUrls` pre-allows sites `[secondary: Dynamsoft]`. Chrome 147 applies it to WebSockets, and Chrome 156 removes the temporary opt-out policy, scheduled for 2026-10-20 `[secondary: Visualware, Supercharge Browser]`. `escpos.js` already sends `targetAddressSpace: 'loopback'`, and `RawBT.localAccess()` reads the permission state.
- Firefox shows a similar prompt (a site "wants to access other apps and services on this device"). Reports disagree on the versions: first for strict tracking protection (149), rolled out from 151, default on desktop in 153, WebSockets in 154 `[secondary: Mozilla Support search excerpt, Cornell IT, CyberInsider; the Mozilla page itself did not load]`. Enterprise policy `LocalNetworkAccess` (Firefox 153+) `[secondary: Dynamsoft]`.
- The pages served by the companion itself (`http://127.0.0.1:8787/`) need no prompt.

### 8.5 Which sites may print (recommended default)

- **Approval at first use.** A request from an unknown origin to `/print`, `/receipt`, `POST /config` or `/selftest` gets `403 {ok:false, error:"<site> is not allowed: approve it in Print Bridge"}`, and the tray shows "Allow <site> to print?". Approved origins are listed, and can be removed, in the tray menu and on the status page. `GET /status` always answers (pages need it to find the companion) but hides printer name and logo URL from unapproved origins and adds `allowed: false`.
- It works with `escpos.js` unchanged: the page shows the error text.
- Requests without `Origin` (curl, local programs) are allowed by default: they already run as the user (decision D6).
- **Pairing token (stronger, later).** A secret shown by the companion, stored by the page and sent in a header. It needs an `escpos.js` change and makes `POST /print` a preflighted request. Opt-in only.

### 8.6 Safari

WebKit does not treat `http://127.0.0.1` called from an https page as trustworthy in every case. Bug 279249 (Safari 18 blocking localhost content on https pages) was fixed in March 2025, but the older bugs about treating loopback as secure (171934, 218623) "are not fixed" `[source: WebKit bug 279249]`. Whether a page hosted on GitHub Pages can reach the companion in current Safari must be tested before Safari support is promised. Safari has no prompt like Local Network Access `[unverified]`.

### 8.7 Other limits

- Limits on request body (for example 4 MB), headers and connections; rate limit per origin `[estimate]`. The Android server allocates the whole `Content-Length` before reading: the companion should not (reported separately).
- `logoUrl`: https only (http only for approved origins), images only, size limit (for example 1 MB), timeouts, no redirects to private or loopback addresses; otherwise any page can use the companion to probe the local network.
- `printer` in `/receipt` and `/config` must name a printer the user configured, never a free host or port.
- An optional filter for `ESC p` (cash drawer) unless the user enables it (design proposal).
- Logs keep origin, size, result and time, not the content of receipts, which may contain personal data.

## 9. Running in the background: tray, autostart, sleep

- **Process.** A per-user app started at login, with a tray icon. Not a system service: Bluetooth pairing, per-user printers and the tray belong to the user session `[unverified for every system]`.
- **Autostart.** Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, or a startup task for an MSIX package `[unverified]`. macOS: `SMAppService` (macOS 13+) for login items and agents `[unverified: Apple's page did not load]`; agents need `AssociatedBundleIdentifiers` for the Local Network privilege ([7.3](#73-network-printers-tcp-9100)). Linux: an XDG autostart `.desktop` file or a `systemd --user` unit `[unverified]`.
- **Tray.** Windows notification area; macOS menu bar; Linux StatusNotifierItem/AppIndicator, which GNOME Shell shows through the AppIndicator extension (Ubuntu ships it) `[source: extension README; that plain GNOME needs it is unverified]`. Without a tray, the status page at `http://127.0.0.1:8787/` is enough.
- **Menu:** state (server, printer, last job), Open status page, Print test page, Printer…, Allowed sites…, Start at login, Language (English/Italiano), Check for updates, Quit.
- **Sleep and throttling.** After sleep, reopen ports and Bluetooth at the next job. macOS App Nap throttles timers and I/O of background apps; an app that holds a `ProcessInfo` activity assertion is not napped `[source: App Nap]`: take one for the length of each job. Windows efficiency mode was not researched `[unverified]`.
- **Watchdog,** like `BridgeService` and `Health` on Android: if the accept loop dies, listen again; one instance only.
- **Language:** English and Italian, following the system, with an override; reuse the texts of `android/app/src/main/res/values*/strings.xml` so that API messages match the app.

## 10. Updates

- Signed updates from GitHub Releases over HTTPS, checked at start and once a day, never installed during a job; the HTTP API stays backward compatible.
- Tools: the Tauri updater ("needs a signature … This cannot be disabled"; static JSON file or server) `[source]`; Velopack (Windows, macOS, Linux; delta updates; usable from Go, Rust, C#/.NET, Electron, Tauri) `[source]`; Sparkle and WinSparkle were not researched.
- Store channels update by themselves: Microsoft Store, winget (`winget upgrade`), Homebrew (`brew upgrade`), Flatpak, apt and dnf repositories.

## 11. Packaging and code signing

### 11.1 Windows

- **Formats:** MSIX through the Microsoft Store (the Store re-signs the package for free; the developer account is free) `[source: code signing options]`; an MSI/EXE installer, which the Store also accepts but which you sign yourself with a certificate from a trusted CA `[source]`; a winget manifest pointing to the installer on GitHub Releases (automatic validation and malware scan; 7 days to fix a pull request the bot sends back) `[secondary: winget repository page, search excerpt]`.
- **Signing outside the Store** `[source: code signing options, 2026-08-29]`:
  - Azure Artifact Signing (formerly Trusted Signing): about 9.99 USD/month; organisations in the USA, Canada, EU and UK, individual developers only in the USA and Canada.
  - OV certificate: 150-300 USD/year; since June 2023 the private key must sit on an HSM or hardware token.
  - EV certificate: 400+ USD/year; since 2024 no longer bypasses SmartScreen.
  - SignPath Foundation: free for qualifying open-source projects.
  - In every case SmartScreen warns about new files until reputation builds with downloads under a constant signing identity; unsigned files get a "strong SmartScreen block" and enterprises may block them entirely.

### 11.2 macOS

- Apple Developer Program: "99 USD per membership year" `[source: Apple enroll]`; membership includes the Developer ID certificate and notarization `[secondary: Apple developer forum]`. Sign with the hardened runtime, notarize with `notarytool`, staple the ticket `[unverified: Apple's notarization page did not load]`.
- Universal binary (arm64 + x86_64). `Info.plist`: `NSLocalNetworkUsageDescription` for TCP 9100 `[source: TN3179]`, and the Bluetooth usage text if Bluetooth is used.
- Distribution: DMG or ZIP on GitHub Releases; Homebrew cask. Homebrew 5.0.0 deprecated `--no-quarantine` and announced "We will disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026" `[source: Homebrew 5.0.0]`; I did not check how that went `[unverified]`. In practice Homebrew needs a notarized app too. Mac App Store: not considered (sandbox, review) `[unverified]`.

### 11.3 Linux

- AppImage (one file, any distribution), `.deb` (Debian, Ubuntu), `.rpm` (Fedora, openSUSE), Flatpak: in the sandbox `--device=all` gives device access and `--allow=bluetooth` gives `AF_BLUETOOTH` sockets `[source: Flatpak]`; access to BlueZ over D-Bus is not covered there `[unverified]`. Snap was not researched.
- No gatekeeper in the system: sign repositories and packages with GPG; document the serial group and, for USB printers, the udev rules.

## 12. Technology comparison and recommendation

Two questions decide most of it: (a) can the program reuse `escpos.js` for `/receipt` and BLE, and (b) is there a library I could verify for each transport. "Not researched" means I did not look; it does not mean the library is missing.

| | Go | Tauri 2 (Rust) | Electron (Node + Chromium) | Flutter (Dart) | .NET |
|---|---|---|---|---|---|
| HTTP server on 127.0.0.1 | standard library | a Rust crate (not researched) | Node `http` | `dart:io` `[unverified]` | Kestrel or HttpListener `[unverified]` |
| Serial | go.bug.st/serial; enumeration with USB VID/PID; cgo required on macOS `[source]` | serialport-rs: Linux, macOS, Windows; libudev by default on Linux `[source]` | Node SerialPort, Linux, Mac, Windows, works in Electron `[source]`; or Web Serial in the window (`select-serial-port`) `[source]` | flutter_libserialport (libserialport; Linux, macOS, Windows, Android; last release about 14 months ago) `[source]` | System.IO.Ports (NuGet package) `[source]`; Linux and macOS support not re-checked `[unverified]` |
| Windows spooler, RAW | alexbrainman/printer: `StartRawDocument`, `Write` `[source]` | the `windows` crate exposes `WritePrinter` `[source]` | native module or helper (not researched) | the `win32` package exposes `WritePrinter` `[source]` | P/Invoke to winspool `[unverified]` |
| CUPS | run `lp`, or IPP | same | same | same | same |
| TCP 9100 | standard library | standard library | Node `net` | `dart:io` | `System.Net.Sockets` |
| BLE | tinygo-org/bluetooth `[source]` | btleplug, no Classic `[source]` | Web Bluetooth in the window, `select-bluetooth-device` `[source]`: runs `RawBT.ble` and the drivers as they are | universal_ble `[source]` | 32feet / InTheHand: Windows, macOS, Android, iOS; Linux not mentioned `[source]` |
| Classic RFCOMM without a COM port | not found | not found | Web Serial in the window (Chromium does RFCOMM since 117) `[unverified in Electron]` | not found | 32feet `InTheHand.Net.Bluetooth`, platforms not confirmed `[unverified]` |
| Reuse of `escpos.js` | needs a JS engine (goja, not researched) | in the webview `[unverified]` | yes, as it is | needs a JS engine | needs a JS engine (Jint, not researched) |
| User interface | tray + served page | tray + webview window | tray + Chromium window | native widgets | tray (Avalonia, not researched) |
| Updates | Velopack `[source]` | Tauri updater `[source]` | Velopack `[source]`; electron-updater not researched | community packages, not researched | Velopack `[source]` |
| Size | one static binary, small `[unverified: not measured]` | "very small binaries" `[source]`, uses the system webview | large: ships Chromium and Node `[unverified: not measured]` | medium `[unverified]` | medium, smaller with trimming or AOT `[unverified]` |
| Builds | cross-compiles easily, except macOS (cgo) | one build per system | one build per system | one build per system | one build per system |
| Security upkeep | low | low | high: follow Chromium releases | medium | medium |
| Effort for version 1 `[estimate]` | low to medium | medium (Rust) | low, thanks to the reuse of receipt and BLE code; upkeep high | medium | medium |

Also considered: **Kotlin on the JVM** would reuse `Receipt.kt` and `EscPos.kt` almost as they are and match the Android code; it ships a Java runtime and its desktop BLE options look thin `[unverified, not researched]`.

**Recommendation.**

1. **Go for version 1**, if the owner accepts a small port of `Receipt.kt`. The companion is mostly an HTTP server and byte pipes; Go has HTTP and TCP in the standard library and verified libraries for serial ports and the Windows RAW spooler; one signed binary per system, no webview; the user interface already exists as the served `app.html`. Weak points: cgo on macOS (serial enumeration, tray), no verified direct RFCOMM, BLE only through tinygo-org/bluetooth.
2. **Electron** if byte-identical reuse of `escpos.js` (receipt, BLE drivers, Web Serial with RFCOMM) matters more than size and security upkeep. It is the quickest route to BLE and SPP without native code.
3. **Tauri** if someone on the team writes Rust: small, with tray, autostart and signed updates; serial and spooler verified; BLE through btleplug.
4. Flutter and .NET are possible but bring no advantage here: the Flutter serial package is the least maintained of those checked, and the .NET Bluetooth library checked does not mention Linux.

## 13. Phases and rough effort

`[estimate]`, one experienced developer.

| Phase | Content | Effort |
|---|---|---|
| 0. Spike | `/status` and `/print` to a COM port on Windows; check Safari reachability from the GitHub Pages site; check the Local Network Access prompts in Chrome and Firefox | 3-5 days |
| 1. Windows, version 1 | full API ([5.1](#51-endpoints)) with the `/receipt` port and fixtures from `test/layout-test.js`, `/config`, `/selftest`; serial and SPP over COM, spooler RAW, TCP 9100; site approval, Host check, limits; tray, autostart, English/Italian; signed installer | 3-4 weeks |
| 2. macOS and Linux | tty and SPP, CUPS raw, TCP with the Local Network privilege, `SMAppService` / XDG autostart, notarization, AppImage/deb/rpm, permission diagnostics | 2-3 weeks |
| 3. Distribution | updates, winget, Homebrew cask, Microsoft Store if wanted, documentation (README section, a card on the landing page) | 1-2 weeks |
| 4. Optional | BLE transport (profiles, pacing, Phomemo drivers), direct RFCOMM per system, jobs pushed by a server | 2-6 weeks |

Running costs: Apple 99 USD/year; Windows signing about 120 USD/year (Artifact Signing, if eligible) or 150-300 USD/year (OV); time to follow system changes (Windows printing, CUPS, macOS privacy).

## 14. Test matrix

**Systems:** Windows 10 22H2 and the current Windows 11; macOS 13 (minimum for `SMAppService`) and the two latest major versions, Apple silicon and Intel; Ubuntu LTS (GNOME with AppIndicator), Fedora (GNOME without it), one KDE distribution.

**Transports × systems** (number = phase in which it must pass):

| Transport | Windows | macOS | Linux |
|---|---|---|---|
| USB-serial adapter | 1 | 2 | 2 |
| Bluetooth SPP (virtual port or RFCOMM) | 1 | 2 | 2 |
| Spooler RAW, vendor driver | 1 | 2 (CUPS raw) | 2 (CUPS raw) |
| Spooler RAW, Generic / Text Only | 1 | – | – |
| TCP 9100 | 1 | 2 (Local Network prompt) | 2 |
| BLE | 4 | 4 | 4 |

**Browsers × page origin × permission:** Chrome, Edge, Firefox, Safari (macOS) × page served by the companion (`http://127.0.0.1:8787/`) and the public GitHub Pages site (`https://…`) × permission not yet asked, granted, denied, pre-allowed by enterprise policy. Check `RawBT.check()`, `RawBT.localAccess()`, `sendApi`, `sendReceipt`, and `printLayout` with `via: 'auto'` and `via: 'app'`.

**Printers:** a 58 mm Bluetooth SPP printer (the one the Android app is tested with), an 80 mm USB printer with the vendor driver, an Ethernet printer, a USB-serial printer; for phase 4, a Phomemo (BLE only).

**Robustness:** sleep and resume; cable pulled during a job; printer off or out of range (8 s connection timeout); SPP printer held by a phone; two tabs printing at the same time; a 576-dot logo raster; a printer that drops bytes without pacing; Local Network Access denied; companion not running (fallbacks of `escpos.js`, `RawBT.send` on a computer); port 8787 taken; two Windows users signed in; update while idle.

**Reference column:** for every API case, compare with the Android app: same request, same JSON shape, same `level` values.

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Nobody needs it: Web Bluetooth and Web Serial cover the real users | medium | wasted effort | decide on real cases first (D1) |
| Safari cannot reach 127.0.0.1 from https pages | medium | no Safari support | phase 0 spike; serve the page from the companion |
| Changes in Windows printing (IPP class driver preferred, protected print mode) break spooler RAW | medium, growing | spooler path fails | prefer serial, TCP, direct USB; document Generic / Text Only |
| CUPS drops raw queues | low within two years `[estimate]` | spooler path on macOS/Linux fails | TCP and direct USB paths |
| On macOS SPP has no device node and no tested RFCOMM library | high | no SPP on macOS without native code | Chrome's Web Serial already covers SPP on macOS; IOBluetooth later |
| Signing identity: Artifact Signing is not open to individuals outside the USA and Canada | high for an individual in Italy | SmartScreen warnings, higher cost | company account, OV certificate, or SignPath for open source |
| SmartScreen and Gatekeeper warnings scare users | medium | support load | sign from the first release, constant identity |
| Hostile pages print or open the cash drawer | low with Local Network Access, higher in Safari and old browsers | abuse | site approval, drawer filter |
| Port conflicts, shared Windows machines | low | confusing failures | clear tray message; D7 |
| Two products (Android and desktop) drift apart | medium | different receipts | shared fixtures, same API tests |
| Chrome keeps changing the Local Network Access rules | medium | prompts or failures | keep plain HTTP `fetch`; follow Chrome releases |

## 16. Open decisions for the owner

- **D1. Build it at all?** Which real users have a USB printer with a driver, a network printer, Safari or Firefox? Without them, keep investing in Web Serial and Web Bluetooth.
- **D2. Technology:** Go (recommended), Electron or Tauri ([section 12](#12-technology-comparison-and-recommendation)).
- **D3. Transports in version 1:** serial/SPP, spooler RAW, TCP 9100 (proposed); BLE later or never.
- **D4. Receipt rendering:** port `Receipt.kt`, or fix the `receipt` layout of `escpos.js` and run `escpos.js` inside the companion.
- **D5. Distribution and money:** who holds the signing identities (a person or a company: Artifact Signing for individuals is USA/Canada only), 99 USD/year to Apple, which channels (Microsoft Store, winget, Homebrew, Flatpak).
- **D6. Default security:** approval of sites at first use (proposed) or open like the Android app; requests without `Origin`; cash drawer filter.
- **D7. Shared Windows machines:** one companion per machine, refusal, or per-user ports.
- **D8. Name and identifiers:** "Print Bridge" (neutral brand), app identifier (`com.rawbtprint.bridge` as on Android?), publisher name in the installer (it must match the signing identity).
- **D9. Versions and repository:** same version number as the Android app or its own; same repository (a `desktop/` folder, CI per system) or a new one.
- **D10. Jobs pushed by a server** (printing with no page open): out of scope or a later phase.
- **D11. Android parity:** should the Android app adopt the same hardening (site approval, Host check, body limit) to keep one contract?

## 17. Optional changes elsewhere in the repository

Not needed for the companion to work; listed so they are not forgotten.

- `escpos.js`: the `receipt` layout should follow `labels` and the language like `Receipt.kt`; `RawBT.send()` should fall back to the `rawbtprint:` scheme only on Android or when a handler is known; the Web Serial comments and the `serialUnsupported` message predate Firefox 151 and Chrome 138 on Android.
- `app.html` and `android/app/src/main/assets/test.html`: hide the battery row and the Android wording when `/status.platform` is not `android`.
- README and landing page: a "desktop app" card and a section that links to this document, once the companion exists.

## 18. Sources

Opened on 2026-10-18 unless noted.

**Browser capabilities**
- Web Bluetooth CG, implementation status: <https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md>
- Chrome for Developers, Read from and write to a serial port: <https://developer.chrome.com/docs/capabilities/serial>
- Chrome for Developers, Serial over Bluetooth on the web (updated 2023-10-13): <https://developer.chrome.com/blog/serial-over-bluetooth>
- Chrome 138 release notes: <https://developer.chrome.com/release-notes/138>
- Mozilla Hacks, Announcing Web Serial support in Firefox (2026-05-21): <https://hacks.mozilla.org/2026/05/web-serial-support-in-firefox/>
- CircuitPython code editor, Linux flag note (search excerpt): <https://code.circuitpython.org>
- W3C public-web-bluetooth, September 2024 (search excerpt): <https://lists.w3.org/Archives/Public/public-web-bluetooth/2024Sep/0002.html>
- W3C public-webapps-github, June 2023, Web Serial positions (search excerpt): <https://lists.w3.org/Archives/Public/public-webapps-github/2023Jun/0172.html>
- Zebra developer forum, WebUSB "Access denied": <https://developer.zebra.com/content/domexception-failed-execute-open-usbdevice-access-denied>
- Storepass documentation, Zadig and WinUSB (search excerpt): <https://admin.storepass.co/support/documentation/DfLHy7p6Ca>
- blink-dev, Intent to Implement and Ship: WebUSB Interface Class Filtering (search excerpt): <https://groups.google.com/a/chromium.org/g/blink-dev/c/LZXocaeCwDw/m/GLfAffGLAAAJ>
- Chrome for Developers, Direct Sockets (updated 2025-12-17): <https://developer.chrome.com/docs/iwa/direct-sockets>
- blink-dev, PSA: permission policies for Direct Sockets in Isolated Web Apps (2026, search excerpt): <https://groups.google.com/a/chromium.org/g/blink-dev/c/5cSZjgnJelk/m/K56ic8m_AgAJ>

**Local network access**
- Chrome for Developers, Local Network Access (2025-06-09, updated 2025-09-29): <https://developer.chrome.com/blog/local-network-access>
- Chrome for Developers, Private Network Access on hold (2024-10-09): <https://developer.chrome.com/blog/pna-on-hold>
- Dynamsoft, Chromium 142 Local Network Access: <https://www.dynamsoft.com/web-twain/docs/faq/chromium-142-local-network-access-issue.html>
- Visualware, Chrome LNA and WebSockets (search excerpt): <https://myconnectionserver.visualware.com/support/v11/userguide/chrome-lna-websocket>
- Supercharge Browser, Chrome 156 Local Network Access (search excerpt): <https://www.superchargebrowser.com/library/chrome-156-local-network-access/>
- Cornell IT, Firefox local network prompt: <https://it.cornell.edu/secure-connect/firefoxlocalnetwork>
- CyberInsider, Firefox 154 and WebSockets (2026-08-19): <https://cyberinsider.com/firefox-154-blocks-silent-websocket-access-to-local-network-devices/>
- Mozilla Support, local network permissions (did not load; search excerpt used): <https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox>
- WebKit bug 279249: <https://bugs.webkit.org/show_bug.cgi?id=279249>
- Apple TN3179, Understanding local network privacy (revision 2026-10-06): <https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy>

**Printing**
- CUPS, Network printers: <https://www.cups.org/doc/network.html>
- CUPS, lpadmin man page: <https://www.cups.org/doc/man-lpadmin.html>
- CUPS, lp man page: <https://www.cups.org/doc/man-lp.html>
- Microsoft, How To: Send Data Directly to a GDI Printer: <https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer>
- Microsoft, WritePrinter: <https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter>
- Microsoft, End of servicing plan for third-party printer drivers on Windows (updated May 2025): <https://learn.microsoft.com/en-us/windows-hardware/drivers/print/end-of-servicing-plan-for-third-party-printer-drivers-on-windows>
- Microsoft, Windows protected print mode: <https://learn.microsoft.com/en-us/windows/modern-print/windows-protected-print-mode/windows-protected-print-mode>
- SAPinsider, non-Mopria thermal printers (search excerpt): <https://sapinsider.org/map/lrs-ships-driverless-printing-for-sap-closing-the-windows-protected-print-gap/>
- Juniper Systems, Bluetooth COM ports on Windows (search excerpt): <https://junipersys.com/support/article/14876>
- openSUSE man pages, rfcomm(7) and rfcomm(1) in bluez-deprecated: <https://manpages.opensuse.org/Tumbleweed/bluez-deprecated/rfcomm.7.en.html>, <https://manpages.opensuse.org/Tumbleweed/bluez-deprecated/rfcomm.1.en.html>
- Microsoft, CreateProcessW: <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw>

**Packaging, signing, background**
- Microsoft, Code signing options for Windows app developers (2026-08-29): <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>
- Microsoft, Submit your manifest to the repository (winget; search excerpt): <https://learn.microsoft.com/en-us/windows/package-manager/package/repository>
- Apple, Enroll in the Apple Developer Program: <https://developer.apple.com/programs/enroll/>
- Apple developer forum, notarization included in the membership (search excerpt): <https://developer.apple.com/forums/thread/746992>
- Apple, Notarizing macOS software before distribution (did not load): <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
- Apple, SMAppService (did not load): <https://developer.apple.com/documentation/servicemanagement/smappservice>
- Apple, App Nap: <https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html>
- Homebrew 5.0.0 (2025-11-12): <https://brew.sh/2025/11/12/homebrew-5.0.0>
- Flatpak, Sandbox permissions: <https://docs.flatpak.org/en/latest/sandbox-permissions.html>
- GNOME Shell AppIndicator extension: <https://github.com/ubuntu/gnome-shell-extension-appindicator>

**Libraries**
- go.bug.st/serial: <https://github.com/bugst/go-serial>; enumerator: <https://pkg.go.dev/go.bug.st/serial/enumerator>
- alexbrainman/printer: <https://pkg.go.dev/github.com/alexbrainman/printer>
- tinygo-org/bluetooth: <https://github.com/tinygo-org/bluetooth>
- serialport-rs: <https://github.com/serialport/serialport-rs>
- `windows` crate, WritePrinter: <https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Graphics/Printing/fn.WritePrinter.html>
- btleplug: <https://github.com/deviceplug/btleplug>
- Tauri, app size: <https://v2.tauri.app/concept/size/>; updater: <https://v2.tauri.app/plugin/updater/>
- Electron, device access: <https://www.electronjs.org/docs/latest/tutorial/devices>
- Node SerialPort: <https://serialport.io/docs/>
- flutter_libserialport: <https://pub.dev/packages/flutter_libserialport>
- universal_ble: <https://pub.dev/packages/universal_ble>
- Dart `win32`, WritePrinter: <https://pub.dev/documentation/win32/latest/win32/WritePrinter.html>
- .NET System.IO.Ports.SerialPort: <https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport>
- 32feet / InTheHand: <https://github.com/inthehand/32feet>
- Velopack: <https://velopack.io/>

**Repository files read:** `android/app/src/main/kotlin/com/rawbtprint/bridge/PrintServer.kt`, `Printer.kt`, `Receipt.kt`, `AppConfig.kt`, `SelfTest.kt`, `LogoStore.kt`, `EscPos.kt`; `escpos.js`; `app.html`; `README.md`; `serve.ps1`; `print-logo-receipt.ps1`; `test/layout-test.js`.
