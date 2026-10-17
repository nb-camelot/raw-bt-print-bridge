package com.rawbtprint.bridge

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Autotest completo del bridge: servizio, server, API, pagina di test, client web, Bluetooth,
 * stampante, batteria e notifiche (piu una stampa di prova facoltativa). Le chiamate HTTP
 * passano davvero da 127.0.0.1 come quelle del browser, marcate come autotest.
 * Fa I/O di rete e Bluetooth: va chiamato fuori dal thread principale.
 */
object SelfTest {

    class Item(val name: String, val level: Health.Level, val detail: String)

    class Report(val items: List<Item>, val ms: Long) {
        val level: Health.Level
            get() = when {
                items.any { it.level == Health.Level.ERROR } -> Health.Level.ERROR
                items.any { it.level == Health.Level.WARN } -> Health.Level.WARN
                items.any { it.level == Health.Level.UNKNOWN } -> Health.Level.UNKNOWN
                else -> Health.Level.OK
            }

        fun count(l: Health.Level): Int = items.count { it.level == l }

        fun title(): String = when (level) {
            Health.Level.OK -> "Autotest: tutto a posto"
            Health.Level.WARN -> "Autotest: da controllare"
            Health.Level.ERROR -> "Autotest: problemi trovati"
            Health.Level.UNKNOWN -> "Autotest: esito incompleto"
        }

        fun summary(): String =
            "${count(Health.Level.OK)} OK · ${count(Health.Level.WARN)} avvisi · " +
                "${count(Health.Level.ERROR)} errori · ${ms} ms"

        fun text(): String = items.joinToString("\n") { "${symbol(it.level)} ${it.name}: ${it.detail}" } +
            "\n\n" + summary()

        fun json(): String {
            val arr = JSONArray()
            for (it in items) {
                val o = JSONObject()
                o.put("name", it.name)
                o.put("level", it.level.name.lowercase())
                o.put("detail", it.detail)
                arr.put(o)
            }
            val root = JSONObject()
            root.put("ok", level != Health.Level.ERROR)
            root.put("level", level.name.lowercase())
            root.put("summary", summary())
            root.put("ms", ms)
            root.put("items", arr)
            return root.toString()
        }
    }

    private const val TIMEOUT_MS = 4_000
    private val running = AtomicBoolean(false)

    fun symbol(level: Health.Level): String = when (level) {
        Health.Level.OK -> "✓"
        Health.Level.WARN -> "⚠"
        Health.Level.ERROR -> "✗"
        Health.Level.UNKNOWN -> "?"
    }

    /** Scontrino di prova usato dall'autotest e dal pulsante "Prova stampa (via API)". */
    fun testReceipt(): JSONObject {
        val spec = JSONObject()
        spec.put("shop", "PRINT BRIDGE")
        spec.put("title", "TEST API")
        spec.put("subtitle", "via 127.0.0.1:${BridgeService.PORT}/receipt")
        spec.put("date", true)
        spec.put("lines", JSONArray().apply {
            put("Se leggi questo testo la catena")
            put("pagina -> API -> app -> Bluetooth")
            put("funziona correttamente.")
        })
        spec.put("qr", "https://nb-camelot.github.io/raw-bt-print-bridge/")
        spec.put("qrText", "Pagina di test")
        spec.put("footer", "Test completato")
        spec.put("logo", AppConfig.logoMode() != AppConfig.MODE_NONE)
        spec.put("cut", true)
        return spec
    }

    fun run(ctx: Context, includePrint: Boolean): Report {
        if (!running.compareAndSet(false, true)) {
            return Report(listOf(Item("Autotest", Health.Level.WARN, "un autotest è già in corso, riprova tra poco")), 0L)
        }
        val t0 = System.currentTimeMillis()
        val items = ArrayList<Item>()
        try {
            items.add(
                if (BridgeService.running) {
                    Item("Servizio in primo piano", Health.Level.OK, "attivo, con notifica")
                } else {
                    Item("Servizio in primo piano", Health.Level.ERROR, "non attivo: apri l'app per avviarlo")
                }
            )

            val srv = PrintServer.current
            items.add(
                when {
                    srv == null -> Item("Server locale", Health.Level.ERROR, "non avviato")
                    !srv.bound -> Item("Server locale", Health.Level.ERROR, "non in ascolto: ${srv.lastError ?: "avvio in corso"}")
                    else -> Item(
                        "Server locale", Health.Level.OK,
                        "in ascolto su 127.0.0.1:${BridgeService.PORT} da ${Health.duration(System.currentTimeMillis() - srv.since)}"
                    )
                }
            )

            val status = http("GET", "/status", null)
            items.add(
                when {
                    status.error != null -> Item("API /status", Health.Level.ERROR, status.error)
                    status.code != 200 -> Item("API /status", Health.Level.ERROR, "HTTP ${status.code}")
                    !status.body.contains("\"app\":true") -> Item("API /status", Health.Level.ERROR, "risposta inattesa")
                    else -> Item("API /status", Health.Level.OK, "risponde in ${status.ms} ms")
                }
            )

            val page = http("GET", "/", null)
            items.add(
                when {
                    page.error != null -> Item("Pagina di test", Health.Level.ERROR, page.error)
                    page.code != 200 || !page.body.contains("<html") -> Item("Pagina di test", Health.Level.ERROR, "HTTP ${page.code}")
                    else -> Item("Pagina di test", Health.Level.OK, "servita su http://127.0.0.1:${BridgeService.PORT}/")
                }
            )

            val js = http("GET", "/escpos.js", null)
            items.add(
                when {
                    js.error != null -> Item("Client web (escpos.js)", Health.Level.ERROR, js.error)
                    js.code != 200 || !js.body.contains("RawBT") -> Item("Client web (escpos.js)", Health.Level.ERROR, "HTTP ${js.code}")
                    else -> Item("Client web (escpos.js)", Health.Level.OK, "incluso nell'app (${js.body.length / 1024} KB)")
                }
            )

            val bt = Printer.btCheck()
            Health.btLine = bt
            items.add(Item("Bluetooth", bt.level, bt.text))

            if (Printer.selectedMac().isNullOrEmpty()) {
                items.add(Item("Connessione stampante", Health.Level.WARN, "nessuna stampante scelta: premi «Scegli stampante»"))
            } else if (bt.level == Health.Level.ERROR) {
                items.add(Item("Connessione stampante", Health.Level.ERROR, "non provata: prima risolvi il Bluetooth"))
            } else {
                val p0 = System.currentTimeMillis()
                val res = Printer.probe()
                val pms = System.currentTimeMillis() - p0
                items.add(
                    if (res.ok) {
                        Item("Connessione stampante", Health.Level.OK, "${Printer.selectedName() ?: "stampante"} risponde (${pms} ms)")
                    } else {
                        Item(
                            "Connessione stampante",
                            if (res.error == "stampa gia in corso") Health.Level.WARN else Health.Level.ERROR,
                            res.error ?: "connessione fallita"
                        )
                    }
                )
            }

            val power = Power.check(ctx)
            Health.powerLine = power
            items.add(Item("Batteria e sospensione", power.level, power.text))

            items.add(notificationsItem(ctx))

            if (includePrint) {
                val printed = http("POST", "/receipt", testReceipt().toString())
                items.add(
                    when {
                        printed.error != null -> Item("Stampa di prova via API", Health.Level.ERROR, printed.error)
                        printed.body.contains("\"ok\":true") -> Item("Stampa di prova via API", Health.Level.OK, "stampata in ${printed.ms} ms")
                        else -> Item("Stampa di prova via API", Health.Level.ERROR, errorOf(printed.body))
                    }
                )
            }
        } catch (t: Throwable) {
            items.add(Item("Autotest", Health.Level.ERROR, "interrotto: ${t.message ?: t.javaClass.simpleName}"))
        } finally {
            running.set(false)
        }
        val report = Report(items, System.currentTimeMillis() - t0)
        Printer.log("Autotest completo: ${report.summary()}")
        for (it in items) {
            if (it.level != Health.Level.OK) Printer.log("  ${symbol(it.level)} ${it.name}: ${it.detail}")
        }
        return report
    }

    private fun notificationsItem(ctx: Context): Item {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return Item("Notifiche", Health.Level.UNKNOWN, "non verificabili su questa versione di Android")
        }
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        val enabled = try {
            nm?.areNotificationsEnabled()
        } catch (_: Throwable) {
            null
        }
        return when (enabled) {
            true -> Item("Notifiche", Health.Level.OK, "attive: lo stato del servizio è visibile")
            false -> Item("Notifiche", Health.Level.WARN, "disattivate: il servizio funziona ma il suo stato non si vede")
            null -> Item("Notifiche", Health.Level.UNKNOWN, "non verificabili")
        }
    }

    private fun errorOf(body: String): String = try {
        JSONObject(body).optString("error", "errore sconosciuto")
    } catch (_: Throwable) {
        "risposta non valida"
    }

    private class HttpResult(val code: Int, val body: String, val ms: Long, val error: String?)

    // NO_PROXY: un proxy Wi-Fi verrebbe applicato anche a 127.0.0.1.
    private fun http(method: String, path: String, json: String?): HttpResult {
        val t0 = System.currentTimeMillis()
        return try {
            val conn = URL("http://127.0.0.1:${BridgeService.PORT}$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection
            try {
                conn.requestMethod = method
                conn.connectTimeout = TIMEOUT_MS
                conn.readTimeout = if (json != null) 60_000 else TIMEOUT_MS
                conn.useCaches = false
                conn.setRequestProperty(PrintServer.SELF_TEST_HEADER, "1")
                if (json != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                HttpResult(code, body, System.currentTimeMillis() - t0, null)
            } finally {
                conn.disconnect()
            }
        } catch (t: Throwable) {
            HttpResult(0, "", System.currentTimeMillis() - t0, "${t.message ?: t.javaClass.simpleName} (dopo ${System.currentTimeMillis() - t0} ms)")
        }
    }
}
