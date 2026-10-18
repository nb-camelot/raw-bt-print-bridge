<!-- Research notes behind the Phomemo M02 / M02 Pro driver in escpos.js. Collected on 2026-10-18 from open-source projects; every byte the driver sends is listed here with its source. -->

# Phomemo M02 Pro: print job over Web Bluetooth (checked against sources)

**Tags.** `[verified: X]` = I re-opened X at the commit listed in `sources`, the bytes or value are there, and X ran on a real M02 Pro. `[source: X]` = re-opened, but X did not test an M02 Pro (it tested a sibling model or nothing). `[relayed: X]` = taken from the research pass; I did not re-open it. `[unverified]` = no source supports it, or it is only my inference.

**Main caveat [unverified]:** no source shows a Chrome Web Bluetooth page printing on real M02 Pro hardware. Two implementations were tested on an M02 Pro, and both are native apps:
- **s04/phomemo @80d1d35**: Python with the bleak library, firmware 2.0.6. Its README L19 says "Tested: printing, cancel, print-complete signal, status".
- **danielgormly/phomo @96058e2**: Swift on macOS CoreBluetooth. It printed real pages (HANDOFF.md L9-25) and includes a PacketLogger capture of the vendor iOS app.

ryo-endo (BLE) targets the M02 Pro but its README says it is "still under development". The web pages that list the M02 Pro (Unoriginal02, momir, phomymo, ScryPrint) do not say they were tested on one.

## 1. Model facts
| Item | Value | Tag |
|---|---|---|
| Resolution | 300 dpi | [verified: phomemo.com product JSON body_html, "Achieve 300dpi high-definition printing at speeds of 10-15mm/s"; s04 README L26-27; phomo HANDOFF L18-21 measured a 384-dot strip at 32.5 mm, which is 384/300 in] |
| Paper | 53 mm; 25 mm and 15 mm rolls also supported | [official JSON] |
| Print speed | 10-15 mm/s. At 72 B/row this is 118-177 rows/s, or 8.5-12.8 KB/s of raster (my arithmetic) | [official JSON] |
| Printable width | **Disputed.** 576 dots / 72 B per row [verified: s04 m02.py L43 `Model("Phomemo M02 Pro", 576, 300, ...)`, PROTOCOL.md L27-28, README L26-27 "covers the middle 48mm (576 dots at 300 dpi)"]. 624 dots / 78 B per row [verified: phomo HANDOFF L18-24, AGENTS.md L253-280]. Other values seen: 560, 567, 583, 600 [relayed]. Use **576 as the default and make bytes-per-row a runtime parameter**, then calibrate on the unit (section 8). | see §Contradictions |
| Bit format | 1 bit per dot, MSB first = leftmost pixel, 1 = black, 0 = white | [verified: s04 PROTOCOL.md L28, m02.py L69-70 (PIL bytes are inverted); source: sgrankin PROTOCOL.md L95-98; vivier tools/phomemo-filter.py L41-42] |
| Plain M02, for comparison | 384 dots, 48 B, 203.2 dpi | [source: vivier README L462-466, from a capture of the Android app] |
| USB | The USB-C port only charges, so BLE is the only path | [verified: s04 PROTOCOL.md L19] |
| BLE module | ISSC BT5050. Device Information Service: 2A29 "ISSC", 2A24 "BT5050", 2A27 "5050_SPP" | [verified: phomo AGENTS.md L227-247] |

## 2. Turning the Canvas into bytes (host side; not part of the protocol)
1. Read the `ImageData` of a canvas `W × H` px, where `W = bytesPerRow × 8` (576 by default). Pad the right edge with white, or scale to fit. Draw onto a white background first, because the luma step ignores alpha.
2. Compute grey as `0.299R + 0.587G + 0.114B` [relayed: Unoriginal02 tp/index.html L439-468, ScryPrint]. Any luma formula works.
3. Apply 1-bit Floyd–Steinberg: threshold 128; error weights 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right [relayed: Unoriginal02]. s04 dithers photos with PIL FLOYDSTEINBERG and thresholds text at `v >= 160` [verified: s04 render.py L200-204]. sgrankin recommends error diffusion [source: PROTOCOL.md L163-164].
4. Pack the bits: for a black pixel, `buf[y*bpr + (x>>3)] |= 0x80 >> (x & 7)`.

## 3. Byte stream for one card
### 3.1 Initialise: 9 bytes [verified: s04 PROTOCOL.md L24-26; m02.py L43 `extra_init = 1F 11 02 04`, L85]
```
1B 40          ESC @   initialise
1F 11 02 04    vendor init parameter (the vendor app uses 04; phomo ESCPOS.swift L18)
1B 61 01       ESC a 1 centre   (or 1B 61 00 = left; use 00 while calibrating the width)
```
- **Other orders that also work:**
  - `1B 40 1B 61 01 1F 11 02 04` [source: vivier README L424-432 and tools/phomemo-filter.py L15, M02].
  - `1B 40 1B 61 00 1F 11 02 NN` [verified: phomo ESCPOS.swift L9-20, L36-38].
- **Alignment does affect raster data on the M02 Pro.** With `ESC a 1`, phomo's unit centred a raster that was narrower than the head [verified: phomo AGENTS.md L308-318]. This also shows the printer honours the `xL xH` width field for narrower rows.
- **Density** is the NN byte of `1F 11 02 NN`. Only `04` was tested on M02 Pro hardware.
  - phomo's 1-15 range is a guess that was never calibrated (HANDOFF L76-78).
  - TiMini's recipe, derived from the vendor app and not hardware-tested, maps levels 1-4 to `1F 11 02 NN 1F 11 37 CC` with (NN, CC) = (01,64), (02,64), (04,64), (04,96) [source: TiMini compact.py L14-21, L46-54].
  - Keep NN in {01, 02, 04} until calibrated. [unverified beyond 04]
- **Speed:** no command exists for the M02 family in any source [unverified]. `1B 4E 0D n` is for the M110/M120/M220 only (vivier README L484-487). Do not send a speed command.
- **Optional extras, not tested on an M02 Pro:** `1F 11 37 CC`, `1F 11 0B` (continuous media) and `1F 11 35 00` (uncompressed) [source: TiMini compact.py L14-21].
  - Unoriginal02 tp/index.html L391-397 contains a vendor-app capture with the payload `1B 40 1F 11 02 04 1F 11 37 72 1F 11 0B 1F 11 35 00`.
  - It sits inside what I decode as an HCI-ACL / L2CAP / RFCOMM frame of a Classic SPP session [unverified decoding, but the lengths are consistent: ACL 0x1A = 26, L2CAP 0x16 = 22, RFCOMM length byte 0x23 gives 17 payload bytes, FCS 0x86].
  - Never send the wrapper bytes.

### 3.2 Raster blocks [verified: s04 m02.py L59-79; phomo ESCPOS.swift L21-28, L53-67]
```
1D 76 30 00  xL xH  yL yH  <(xL + 256·xH) × rows bytes>
```
- `xL xH`: bytes per row as a little-endian u16. `48 00` = 72 bytes (default); `4E 00` = 78 bytes (alternative).
- `yL yH`: the **exact** number of rows in this block, 1 to 255, so `yH` is always `00`.
- Split taller images into blocks of at most 255 rows and send them back to back. vivier says "max is 255" [source: vivier README L444-447; cups/filter/rastertopm02_t02.py L113-118].
- Mode byte `00`.
- There is no `1F 11` wrapper, no length, no checksum and no compression.
- **0x0A → 0x14 substitution: optional, off by default.**
  - s04's hardware-tested path sends raw bytes (m02.py L70) and prints dithered photos (render.py L203; README L150 troubleshoots "photos look muddy").
  - phomo substitutes (ESCPOS.swift L30-34), but it cites vivier rather than its own observation.
  - Need on the M02 Pro: [unverified].

### 3.3 Feed [verified: s04 m02.py L95-96, default n = 3 at L125]
```
1B 64 03       ESC d n; n is a u8, sources use 2-4
```
- After a cancel, s04 feeds n+3 (m02.py L130-131).
- **Optional vivier footer:** `1B 64 02 1B 64 02 1F 11 08 1F 11 0E 1F 11 07 1F 11 09`. The last four commands are status queries (battery, timer, firmware, serial), not a flush [source: vivier README L449-460; phomo ESCPOS.swift L42-49 used it on hardware].

### 3.4 Completion [verified: s04 PROTOCOL.md L42-46; m02.py L29, L145, L258-266]
- Stay connected until `1A 0F 0C` arrives on ff03. It comes about 1.5-3 s after the card's data, once per `ESC @ … ESC d` sequence.
- Timeout: 10 + rows/25 s.
- Start waiting only after the last write. A stale `1A 0F 0C` left over from an earlier job can arrive early [source: dsappet M02-NOTES.md L98, M02L].
- Disconnecting early can drop the last rows.

## 4. Web Bluetooth transport
### 4.1 Discovery
```js
navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'M02' }], optionalServices: [0xff00] })
```
- **Name:** the advertised name is `M02 Pro` [verified: s04 PROTOCOL.md L9; source: ryo-endo PhomemoM02Pro_constants.py L2]. Aliases `M02PRO` and `sandymaro` [relayed: TiMini catalogue]. The filter `namePrefix: 'M02'` does not match `sandymaro`.
- **Do not filter on `services: [0xff00]`.** The M02 Pro advertises `FEE7` alone, so a service filter on FF00 finds nothing [verified: phomo AGENTS.md L205-211, BLE.swift L290-301]. `0xff00` must still be listed in `optionalServices`.
- **Not blocked by Chrome:** ff00, ff02 and ff03 are absent from Chromium's GATT blocklist (I checked a local copy of `gatt_blocklist.txt`). That list does block 0x1812 (HID).
- **One connection at a time:** close the Phomemo app first [verified: s04 README L44].

### 4.2 GATT layout
| UUID | Properties | Use | Tag |
|---|---|---|---|
| `0000ff00-0000-1000-8000-00805f9b34fb` | service | | [verified: phomo BLE.swift L11, AGENTS.md GATT dump L227-247; source: TiMini bluetooth_profiles.py] |
| `0000ff02-0000-1000-8000-00805f9b34fb` | write, write-without-response | commands and raster | [verified: s04 PROTOCOL.md L16, m02.py L27; phomo GATT dump] |
| `0000ff03-0000-1000-8000-00805f9b34fb` | notify | replies, credits, completion | [verified: s04 PROTOCOL.md L17, m02.py L28; phomo BLE.swift L13] |
| `0000ff01-…` | read (s04 L15) **or** notify (phomo dump L234) | not needed | conflict |

Call `startNotifications()` on ff03 **before** the first write.

### 4.3 Events on ff03 [verified: s04 PROTOCOL.md L36-46]
- `02 B6 00` right after connecting and the first write. s04 reads it as "probably" the maximum packet size: 0xB6 = 182 bytes of write payload.
- `01 01` after roughly every written packet (77 for 76 packets).
- `1A 0F 0C` when printing is complete.

### 4.4 Write mode
- Use `writeValueWithoutResponse` when the characteristic offers it [verified: s04 m02.py L234-241; phomo BLE.swift L184-194]. Fall back to `writeValueWithResponse` if it does not.
- ryo-endo writes everything with response [source: main.py]. dsappet (M02L, noble on macOS) lost packets with unpaced without-response writes; with-response worked at about 5.7 KB/s [source: M02-NOTES.md L85-87].

### 4.5 Chunk size and pacing
- **Maximum chunk: 182 B.** This comes from the `02 B6 00` frame and from sgrankin (MTU 185 gives 182; PROTOCOL.md L43-44). s04 uses `max(20, min(max_write_without_response_size, 244))` (m02.py L235).
  - Web Bluetooth does not expose the MTU.
  - The spec rejects writes over 512 B (spec source L3712).
  - Chrome on Android calls `requestMtu(517)` on connect (ChromeBluetoothDevice.java L223, local copy, commit not recorded).
- **Baseline, tested on an M02 Pro: 128 B chunks with a 20 ms wait after each.**
  - Sources: phomo HANDOFF L25 (a 260 KB job with nothing dropped); s04 `chunk_delay` default 0.02 s (m02.py L105, L215, L242-243); TiMini Phomemo profile 128/20.
  - Throughput is about 6.4 KB/s, roughly 7 mm/s. This is below head speed, so the head stops and restarts; phomo saw line-by-line stutter (HANDOFF L125-127; BLE.swift L34-37).
- **Recommended: credit pacing.** Tested natively by phomo; untested in Chrome.
  1. Seed 4 credits.
  2. Send one chunk of at most 182 B per credit.
  3. Add a credit for each 2-byte `01 01` received on ff03. Ignore 3-byte frames.
  4. If no credit arrives within 1.5 s, fall back to the 20 ms delay.
  - This gave about 9.5 KB/s with clean dense prints (HANDOFF L91-118; BLE.swift L41-46, L80-89, L196-265).
  - In a page, the pacing runs on `characteristicvaluechanged` events.
- **The requested 20-60 B chunks at 15-20 ms:** safe against overflow, but 1-4 KB/s is only about 1.2-4.7 mm/s, slower than the 128/20 baseline that already stutters. A 576×1000 image (72,000 B) takes about 72 s at 20 B per 20 ms. 20 B is the floor only when the ATT MTU stays at the default 23.

## 5. Status queries [verified: s04 PROTOCOL.md L48-66, m02.py L273-303]
Send `1F 11 NN`. The reply comes on ff03 as `01 01`, then `1A TT VV…`.

| NN | Reply | Meaning |
|---|---|---|
| `07` | `1A 07 a b c` | firmware a.b.c (2.0.6 seen) |
| `08` | `1A 04 VV` | battery percent; VV ≥ 0xA1 is unexplained |
| `11` | `1A 06 89` / `88` | paper present / out |
| `12` | `1A 05 98` / `99` | cover closed / open |
| `13` | `1A 03 A8` / `A9` | temperature normal / too hot |

**Never send an opcode NN above 0x14.** Probing higher opcodes bricked an M02X [source: sgrankin PROTOCOL.md L282-291]. The limit applies to the third byte (the opcode), so `1F 11 02 NN` is safe as a command.

## 6. Do not send
- `1F 11 XX` with XX > 0x14, including phomymo's 0x19, 0x20 and 0x33.
- `1B 4E 04 n` (jams the M02X; sgrankin L295-296).
- `1A …` bytes as commands. These are printer-to-host messages (vivier README L468-476); jfsiii sends them by mistake.
- `10 FF FE 01` and `1B 37 07 t 02` (phomymo's M02 path; no hardware-tested source uses them).
- `1F 11 24 00` (purpose unknown).
- The `02 08 00 1A …` capture wrapper from Unoriginal02.
- `1D 76 30 30` (mode byte 0x30).

## 7. Driver parameters (M02 Pro defaults)
| Parameter | Default | Notes |
|---|---|---|
| dpi | 300 | |
| bytesPerRow | 72 | 78 as an option |
| density NN | 04 | |
| align | 01 | 00 while calibrating |
| feed | 3 | |
| maxRowsPerBlock | 255 | |
| sub0A | false | |
| chunk | 128 | up to 182 in credit mode |
| delayMs | 20 | |
| flow | 'credits' | 'delay' as fallback |
| initialCredits | 4 | |
| creditTimeoutMs | 1500 | |
| doneTimeoutS | 10 + rows/25 | |

Write each segment (init, each block, feed) through the chunker. Cancel only between blocks, as s04 does (m02.py L245-256).

## 8. Width calibration
Print a left-justified (`1B 61 00`) ruler at 72 B/row, then at 78 B/row. A tick every 48 dots works: 9 blocks = 576 dots, 9.75 blocks = 624 dots, the same method as phomo Calibration.swift L16, L75-76. Measure which ticks reach the paper edge.

## Example byte stream (two black rows, 72 bytes per row)

Assembled only from verified items:

```
1B 40 1F 11 02 04 1B 61 01 1D 76 30 00 48 00 02 00 FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 1B 64 03
```

## Contradictions between sources

The example is 164 bytes: 9 init + 8 GS v 0 header (72 B/row, 2 rows) + 144 bytes of 0xFF + 3 feed. Each item is taken from s04 m02.py: L43/L85 for the init, L76 for the header, L95-96 for the feed. After writing it, wait for `1A 0F 0C` on ff03.

1. **Width: 576/72 vs 624/78** (others: 560/70 vinayh, 567/71 Unoriginal02 and vivier CUPS geometry, 583/73 TiMini label mode, 600/75 unixway). **Use 576 as the default, with bytes-per-row configurable.**
   - phomo's strip measured 32.5 mm, which is exactly 384/300 in. That fixes the dpi, not the head width.
   - Its 626 → 624 step assumes the head is as wide as the paper (HANDOFF L20).
   - The only observation that distinguishes the two is HANDOFF L24: output "reaches both paper edges at 624".
   - s04 prints centred (`ESC a 1`), so a raster narrower than the head would still look correct. s04 never ran an edge test.
   - A 576 raster fails safe: it prints centred and clean. A 78-byte row on a 576-dot head risks clipping or skew.
   - phomo is inconsistent with itself: AGENTS.md L324 says "Nothing has been printed yet", but the later HANDOFF.md says it printed real pages.

2. **sgrankin's table (PROTOCOL.md L105-113) gives the M02 Pro 203 dpi and 80 mm paper.** Rejected: the official page says 300 dpi on 53 mm paper, and sgrankin tested only the M02X.

3. **Init order.** s04: `1B 40 1F 11 02 04 1B 61 01`. vivier: `1B 40 1B 61 01 1F 11 02 04`. phomo: `1B 40 1B 61 00 1F 11 02 NN`. vivier's CUPS filter sends no `1F 11 02 04` at all. **Prefer s04's order**; all three are reported to work.

4. **ESC a on raster.** sgrankin says it is irrelevant for raster (M02X), and hkeward could not get it to work. On phomo's M02 Pro, centring did apply to a short raster (AGENTS.md L308-318). **Send it; use 00 while calibrating.**

5. **Rows per block.**
   - At most 255 with the exact count: s04, phomo, vivier README and CUPS filter.
   - Declared count = lines − 1 with 256-row blocks: vivier tools/phomemo-filter.py L18-23, L77-86; hkeward.
   - One block for the full height: TiMini (0xFFFF), ryo-endo, sgrankin for the M02X.
   - **Prefer ≤255 with the exact count.**

6. **0x0A → 0x14 substitution.** s04 does not substitute and prints dithered photos on M02 Pro hardware. phomo, vivier tools, hkeward, Yohoa and ScryPrint do. **Prefer no substitution, with an option to enable it.** My untested inference about where it came from: vivier's tools script declares lines − 1 rows but sends `lines` rows. One row per block therefore lands in the command parser, where 0x0A means line feed, which matches the comment "0x0a breaks the rendering".

7. **Footer.** s04 sends only a feed (`1B 64 03`). vivier sends `1B 64 02` twice plus four `1F 11` status queries. **Both are fine.** sgrankin says the M02X needs no footer.

8. **Where replies arrive.** s04, phomo, dsappet and jeffrafter receive them on ff03. sgrankin's generic table says ff01 is "Read / status" and ff03 is "Unknown" (L21-25, L136). FF01 itself shows as read on s04, jeffrafter and dsappet, but as notify on phomo's unit. **Subscribe to ff03.**

9. **Write type.**
   - Without response: s04, phomo, sgrankin.
   - With response: ryo-endo; dsappet on the M02L, where unpaced without-response lost packets.
   - sgrankin's own comparison table says the "M02 family" uses Write Request, which contradicts its text.
   - vinayh claims the M02 Pro ignores data written with response [relayed]; ryo-endo's working with-response code contradicts that.
   - **Prefer without-response with pacing; fall back to with-response.**

10. **Chunk size and delay.** Values seen: 128 B / 20 ms (phomo, TiMini, phomymo); up to 244 B / 20 ms (s04); 182 B gated on credits (vendor app via phomo); 512 B with 50 ms per 2 chunks (momir, ScryPrint); 160 B throttled to 24 KB/s (Unoriginal02); 60 ms (sgrankin M02X); 2 ms (sgrankin generic). **Prefer credit pacing at ≤182 B, with 128/20 as the fallback.**

11. **Meaning of `02 B6 00`.** s04 reads it as the maximum packet size; phomymo decodes it as printer type.

12. **Meaning of `1F 11 02 NN`.** Called density or energy by phomo and croufts, an opaque init byte by s04, and print speed by jfsiii. sgrankin says the M02X needs NN = 02 and ignores 04.

13. **Completion.** s04 waits for `1A 0F 0C`. TiMini deliberately estimates completion locally and does not treat it as an acknowledgement (compact.py L60-61). **Prefer s04, with a timeout.**

14. **Cover status.** phomymo's ble.js reads 0x98 as "open". s04, sgrankin and jeffrafter all read 0x98 as closed. **0x98 = closed.**

15. **Unoriginal02's mode byte 0x30.** Its code carries an AI-generation artefact (`:contentReference[oaicite:4]` at L472), so its 0x30 mode byte and its use of capture-wrapper bytes as an init packet carry little weight. Every other source uses mode 00.

16. **Research pass error.** The "bluetooth" angle called phomo not hardware-tested. HANDOFF L9-25 shows it printed real pages and measured them on an M02 Pro.

## The original request, claim by claim

The pasted request has eight points. I map them to six protocol claims; dithering is treated separately as a host-side practice.

**1. Resolution and bitmap: 300 dpi, 576 px, 72 B/row, 1 bit, 1 = black, 0 = white. Partly confirmed.**
- 300 dpi is confirmed by the official product JSON, s04 and phomo's measurement.
- The bit format (MSB first, 1 = black) is confirmed: s04 m02.py L69-70; sgrankin L95-98.
- 576 px / 72 B is the best-supported width (s04 tested it; ryo-endo, TiMini and Yohoa agree), but phomo measured 624 px / 78 B on its own unit. Not settled; make it configurable.
- **Dithering** (point 2 of the request) is not a protocol claim. Floyd–Steinberg is standard practice: s04 render.py L203, sgrankin L163-164.

**2. Framing with the 0x1F 0x11 prefix. Refuted as framing; the prefix itself is real.**
- `1F 11` starts the vendor init parameter (`1F 11 02 04`) and the status queries (`1F 11 07/08/11/12/13`): s04 PROTOCOL.md L25, L48-58.
- No `1F 11` frame, length or checksum wraps the job. Init, raster and feed are plain ESC/POS.

**3. Initialisation header with speed and density. Partly confirmed.**
- Init is confirmed: `1B 40 1F 11 02 04 1B 61 01` (s04).
- Density: only `1F 11 02 04` was tested on hardware. The range and meaning of NN are unverified; TiMini uses 01/02/04 together with `1F 11 37 64/96`.
- Speed: no command exists for the M02 family in any source. Refuted or unverified.

**4. Raster rows "compressed/packed in the Phomemo row format". Refuted for compression and for any proprietary format.**
- Rows are uncompressed ESC/POS GS v 0 bit data: `1D 76 30 00 48 00 yL yH`, at most 255 rows per block with the exact count (s04 m02.py L59-79; phomo ESCPOS.swift L21-67).
- "Packed" is correct only in the sense of 8 pixels per byte, MSB first.

**5. Final paper feed. Confirmed.**
- `1B 64 n`, with n = 3 in s04 and 2 (sent twice) in vivier.
- Addition: wait for `1A 0F 0C` on ff03 before disconnecting (s04 PROTOCOL.md L42-46).

**6. Web Bluetooth transport: MTU handling, 20-60 B chunks with 15-20 ms delay, writeValueWithoutResponse on the right characteristic. Partly confirmed.**
- The characteristic is confirmed: ff02 in service ff00, which supports write-without-response (s04 PROTOCOL.md L16; phomo GATT dump). Using it is confirmed in s04 m02.py L234-241. No source shows it working in Chrome.
- The 15-20 ms delay matches tested practice (20 ms in s04 and phomo).
- The 20-60 B chunk size appears in no source. It is safe but 2-9 times slower than the tested 128 B and below the speed at which the head runs smoothly.
- "MTU handling" cannot be done in a browser: Web Bluetooth does not expose the MTU. The printer announces 182 (`02 B6 00`), and the spec caps a write at 512 B.
- Better option, shown natively but not in Chrome: pace on the `01 01` credits from ff03 (phomo).
- Filter by name, not by service UUID: the printer advertises FEE7 only.

## Risks and test plan

**Can only be confirmed on the user's own printer:**
1. **Chrome itself.** No source has run a Chrome Web Bluetooth page against an M02 Pro.
2. **Width.** 576 vs 624 dots, and whether a 78-byte row on a 576-dot head gets clipped, skewed or wrapped.
3. **Notifications.** Whether `startNotifications()` on ff03 works without OS-level pairing. jeffrafter's T02 on macOS reported "Encryption is insufficient" until it was paired (README L111-121). Without notifications there are no credits and no `1A 0F 0C`, so the driver needs a timer fallback and a fixed tail wait (s04 uses 2 s for models without the signal, m02.py L260-261).
4. **Credits through Chrome.** Whether the `01 01` credits arrive through `characteristicvaluechanged` in Chrome, and whether every firmware sends them.
5. **Oversized writes.** What Chrome does on each platform when a `writeValueWithoutResponse` payload is larger than MTU − 3 (reject, truncate or fragment). Unverified. Keep chunks at 182 B or less, with 128 B as the default.
6. **Density.** The effect and safe range of NN in `1F 11 02 NN`; only 04 is tested.
7. **0x0A substitution.** Whether it is needed. Tall images in single blocks larger than 255 rows are untested.
8. **Background tabs.** Chrome throttles timers in background tabs [unverified here; general Chrome behaviour]. Delay-based pacing slows down or stalls if the tab is hidden. Credit pacing is event-driven, but keep the tab in the foreground anyway.
9. **Sleep.** The printer sleeps and stops advertising when idle (phomo HANDOFF L46-49) and accepts only one connection at a time.
10. **Missing completion signal.** `1A 0F 0C` and status replies can still arrive when paper is jammed: dsappet M02-NOTES L112 saw "print complete" with the roller stalled.

**Test plan, in order. Each step only goes ahead if the previous one passes.**
1. Connect with `namePrefix: 'M02'` and `optionalServices: [0xff00]`. Get ff02 and ff03, start notifications on ff03, and log every frame. Expect `02 B6 00`. Send `1F 11 07`, `08`, `11`, `12` and `13` one at a time, about 200 ms apart. Expect `01 01` and then `1A 07/04/06/05/03 …`. If notifications fail, pair the printer in the OS and retry.
2. Send the 164-byte example in one write of 164 B or less, or in two chunks. Expect two black rows (two dots tall, so only a thin line), then the paper feed, then `1A 0F 0C`.
3. **Width.** Send a ruler with `1B 61 00` (left), the same image at 72 B/row and then at 78 B/row. Measure where the ticks fall relative to the paper edges. Set `bytesPerRow`.
4. **Density.** Print one swatch each at NN = 01, 02 and 04, each preceded by `1B 40 1F 11 02 NN`. Do not go above 04 until results are known.
5. **Pacing.** Print a dense dithered page about 1000 rows tall: first with 128 B / 20 ms, then with credit pacing (4 seed credits, ≤182 B, 1.5 s fallback). Check for gaps, stutter and dropped tails. Start the completion wait only after the last write.
6. Print a photo without the 0x0A substitution and check for row shifts. Enable the substitution only if shifts appear.
7. Optionally, if the user still wants it, try the 20-60 B / 15-20 ms pacing and compare speed and stutter.

**Safety rules for every test:**
- Never send `1F 11 XX` with XX > 0x14.
- Never send `1B 4E 04 n`, the `1A …` bytes as commands, phomymo's 0x19/0x20/0x33 queries, or `10 FF FE 01`.
- Close the Phomemo app before connecting.
- Run with a charged battery; s04 notes a low battery affects prints.
- Cancel only between raster blocks.

## Sources

- RE-OPENED: https://github.com/s04/phomemo/blob/80d1d355c2f2157ec30f627899e513fecc4a9ce9/PROTOCOL.md (L9-19, L23-30, L36-46, L48-66) -- M02 Pro fw 2.0.6, hardware-tested
- RE-OPENED: https://github.com/s04/phomemo/blob/80d1d355c2f2157ec30f627899e513fecc4a9ce9/src/phomemo/drivers/m02.py (L25-29, L42-47, L59-96, L105, L125-131, L145, L215, L234-266, L273-303)
- RE-OPENED: https://github.com/s04/phomemo/blob/80d1d355c2f2157ec30f627899e513fecc4a9ce9/README.md (L19, L26-29, L44, L150) and src/phomemo/render.py (L200-204)
- RE-OPENED: https://github.com/danielgormly/phomo/blob/96058e2f240824b526ba85245251bd479617c228/HANDOFF.md (L9-27, L76-78, L91-139) -- M02 Pro, macOS CoreBluetooth, hardware-tested + PacketLogger capture of vendor iOS app
- RE-OPENED: https://github.com/danielgormly/phomo/blob/96058e2f240824b526ba85245251bd479617c228/Sources/phomo/ESCPOS.swift (L9-67) and Sources/phomo/BLE.swift (L10-47, L80-89, L184-265, L290-301)
- RE-OPENED: https://github.com/danielgormly/phomo/blob/96058e2f240824b526ba85245251bd479617c228/AGENTS.md (L135-142, L205-211, L227-280, L308-324) and Sources/phomo/Bitmap.swift, Settings.swift L23-25, Calibration.swift L16, L75-76
- RE-OPENED: https://github.com/vivier/phomemo-tools/blob/2b767486d4590676f1ffb61c7ca870984978a980/README.md (L420-476 M02 protocol, L484-487 M110 speed) -- M02, Android app capture
- RE-OPENED: https://github.com/vivier/phomemo-tools/blob/2b767486d4590676f1ffb61c7ca870984978a980/tools/phomemo-filter.py (L13-48, L68-87) and cups/filter/rastertopm02_t02.py (L64-119) and cups/drv/phomemo-m02pro.drv (L35-38)
- RE-OPENED: https://github.com/sgrankin/phomemo/blob/a626a07385c95b6017053991d70eaf74d64a9d9f/PROTOCOL.md (L21-46, L59-123, L125-138, L156-169, L206-303) -- tested on M02X only
- RE-OPENED: https://github.com/Dejniel/TiMini-Print/blob/679fc0650e61c7ab28b44542b9b9ba000e45aa78/timiniprint/protocol/families/phomemo_esc/compact.py (L14-76), core.py (L40-70), timiniprint/devices/bluetooth_profiles.py (PHOMEMO_ESC profile), timiniprint/data/printer_profiles.json (L6466-6506) -- app-derived recipes, hardware test not stated
- RE-OPENED: https://github.com/ryo-endo/phomemo-printer/blob/dc8d6ef725b8c6fb98447d705249acd0458eafea/PhomemoM02Pro_constants.py (L1-7) and main.py (L11-110) -- M02 Pro BLE, 'still under development'
- RE-OPENED: https://github.com/dsappet/pocket-printer/blob/148cf2fc42454a25787f46a5411e1f633fc3c317/M02-NOTES.md (L77-120) -- M02L (384-dot) unit
- RE-OPENED: https://github.com/jeffrafter/phomemo/blob/972f887db835b1437b6a60e6cec2eb6251fb8a7d/README.md (L105-121, encryption for notifications) -- T02
- RE-OPENED (HEAD as of 2026-10-18, no SHA): https://github.com/Unoriginal02/unoriginal02.github.io/blob/HEAD/tp/index.html (L357-397 connect/init capture, L465-540 raster/chunking; AI artefact at L472, L694)
- RE-OPENED (fetched 2026-10-18): https://phomemo.com/products/m02-pro-portable-printer.json (official: 300dpi, 10-15mm/s, 53/25/15 mm paper; no head width)
- RE-OPENED (local copy of the spec source, no commit recorded): https://webbluetoothcg.github.io/web-bluetooth/ (WriteCharacteristicValue: >512 bytes -> InvalidModificationError; writeValueWithoutResponse = response 'never')
- RE-OPENED (local copies, no commit recorded): Chromium device/bluetooth/android/java/src/org/chromium/device/bluetooth/ChromeBluetoothDevice.java (L221-224 requestMtu(517)); Chromium gatt_blocklist.txt (0x1812 blocked; ff00/ff02/ff03 not listed)
- RELAYED (research pass, not re-opened): https://github.com/hkeward/phomemo_printer/blob/086ee95bd0e451827548f51da31585099cf838fb/ (M02 Pro over SPP; 70-byte rows, lines-1 blocks, 0x0A sub)
- RELAYED: https://github.com/Yohoa/phomemo-python-printing/blob/bdc2236e6294c1cd3b9c260586f2091afa8490f8/phomemo_print_image_direct.py (M02 Pro SPP, 72 B rows)
- RELAYED: https://github.com/Devin-Cooper/momir-printer/blob/310f288d14d0c8765502b12afa82ee163a192f52/ (web/index.html Web Bluetooth, M02S profile; 512 B chunks)
- RELAYED: https://github.com/transcriptionstream/phomymo/blob/1f58d3f0e7f941b9143277cda828380149e56855/ (src/web printers.json 78 B for M02 Pro, printer.js, ble.js, constants.js)
- RELAYED: https://github.com/opentlp/opentlp/blob/b21036a918fd2cbf210e588b9456b60679ecc47e/ (phomemo-m02 driver, 624 dots, 'Untested')
- RELAYED: https://github.com/theacodes/phomemo_m02s/blob/dbe985f8f4e8f6a55c42d70e78e6cf865358e724/phomemo_m02s/printer.py (M02S; 1B 4E 04 n, status opcodes)
- RELAYED: https://github.com/hoovercj/ScryPrint/blob/46347f2fe67afab2ca0ad2ebb355d25841c3e484/src/lib/printer/ (printerProfiles.ts, blePrinter.ts)
- RELAYED: https://github.com/vinayh/taskmemo/blob/78f0c314f54f9c13971b320b67a071c8b673e58d/ (phomemo.py, CLAUDE.md; M02 Pro 560 dots, writeWithoutResponse claim)
- RELAYED: https://github.com/unixway/phomemo-print/blob/93fea70649042e61aa67c507eaefd3b538e8d1ad/src/print/m02_constants.rs; https://github.com/jacquesg/phomemo-macos/blob/b123c346970c7556b17f6ad850a8b7d2638c5071/; https://github.com/aperkins1310/phomemo-tools/blob/df988369978e7df0e66164af9fb2c6d782c86fe0/; https://github.com/Tomatio13/phomemo-printer-skill/blob/a76cda4d5af397a65b7324bc8f1137b5a773dcbe/; https://github.com/K0IN/Phomemo-M02-Web/blob/3c0972d0b5b978baea7cbfbc8399398fc5b6a665/; https://github.com/croufts/mini-journal-thermique/blob/fcadbc8d2346c131478edf000bb46ab1ebb62d0f/; https://github.com/Farex-GH/sticker-printer-bot/blob/1b605a18269ced026f47a5880d85849491041cf8/
- RELAYED: https://github.com/acocalypso/Momir-Android (HEAD 2026-10-18, BlePrinterManager.kt); https://github.com/jfsiii/sticker-printer (constants.js, misuse of 1A xx bytes)
- RELAYED: https://github.com/whatwg/bluetooth/issues/383 (no negotiated-MTU API); https://github.com/vivier/phomemo-tools/issues/14 (M02 Pro field report)
