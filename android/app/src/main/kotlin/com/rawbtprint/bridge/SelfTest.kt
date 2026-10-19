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
 * Full self-test of the bridge: service, server, API, test page, web client, Bluetooth,
 * printer, battery and notifications (plus an optional test print). The HTTP calls
 * really go through 127.0.0.1 like the browser's, marked as self-test.
 * Does network and Bluetooth I/O: call it off the main thread.
 */
object SelfTest {

    class Item(val name: String, val level: Health.Level, val detail: String)

    class Report(
        val items: List<Item>,
        val ms: Long,
        val version: String = "?",
        val versionCode: Long = 0L,
        val device: String = "",
    ) {
        val level: Health.Level
            get() = when {
                items.any { it.level == Health.Level.ERROR } -> Health.Level.ERROR
                items.any { it.level == Health.Level.WARN } -> Health.Level.WARN
                items.any { it.level == Health.Level.UNKNOWN } -> Health.Level.UNKNOWN
                else -> Health.Level.OK
            }

        fun count(l: Health.Level): Int = items.count { it.level == l }

        fun title(): String = when (level) {
            Health.Level.OK -> Tr.s(R.string.selftest_title_ok)
            Health.Level.WARN -> Tr.s(R.string.selftest_title_warn)
            Health.Level.ERROR -> Tr.s(R.string.selftest_title_error)
            Health.Level.UNKNOWN -> Tr.s(R.string.selftest_title_unknown)
        }

        fun summary(): String =
            Tr.s(
                R.string.selftest_summary,
                count(Health.Level.OK), count(Health.Level.WARN), count(Health.Level.ERROR), ms
            )

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
            root.put("version", version)
            root.put("versionCode", versionCode)
            root.put("device", device)
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

    /** Test receipt used by the self-test and by the "Test print (via API)" button. */
    fun testReceipt(): JSONObject {
        val spec = JSONObject()
        spec.put("shop", Tr.s(R.string.selftest_receipt_shop))
        spec.put("title", Tr.s(R.string.selftest_receipt_title))
        spec.put("subtitle", Tr.s(R.string.selftest_receipt_subtitle, BridgeService.PORT.toString()))
        spec.put("date", true)
        spec.put("lines", JSONArray().apply {
            put(Tr.s(R.string.selftest_receipt_line1))
            put(Tr.s(R.string.selftest_receipt_line2))
            put(Tr.s(R.string.selftest_receipt_line3))
        })
        spec.put("qr", "http://127.0.0.1:${BridgeService.PORT}/")
        spec.put("qrText", Tr.s(R.string.selftest_receipt_qr_text))
        spec.put("footer", Tr.s(R.string.selftest_receipt_footer))
        spec.put("logo", AppConfig.logoMode() != AppConfig.MODE_NONE)
        spec.put("cut", true)
        return spec
    }

    fun run(ctx: Context, includePrint: Boolean): Report {
        if (!running.compareAndSet(false, true)) {
            return Report(
                listOf(Item(Tr.s(R.string.selftest_name_selftest), Health.Level.WARN, Tr.s(R.string.selftest_already_running))),
                0L
            )
        }
        val t0 = System.currentTimeMillis()
        val items = ArrayList<Item>()
        val version = Health.appVersion(ctx)
        val versionCode = Health.appVersionCode(ctx)
        val device = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · " +
            "${Build.MANUFACTURER} ${Build.MODEL} · ${Build.DISPLAY}"
        try {
            // First entry: for whoever reads the summary pasted into a bug report.
            items.add(
                Item(
                    Tr.s(R.string.selftest_name_app), Health.Level.OK,
                    Tr.s(R.string.selftest_app_detail, version, versionCode, device)
                )
            )

            items.add(
                when {
                    BridgeService.running -> Item(Tr.s(R.string.selftest_name_service), Health.Level.OK, Tr.s(R.string.selftest_service_active))
                    !Printer.hasConnectPermission() -> Item(
                        Tr.s(R.string.selftest_name_service), Health.Level.ERROR,
                        Tr.s(R.string.selftest_service_no_permission)
                    )
                    else -> Item(Tr.s(R.string.selftest_name_service), Health.Level.ERROR, Tr.s(R.string.selftest_service_inactive))
                }
            )

            val srv = PrintServer.current
            items.add(
                when {
                    srv == null -> Item(Tr.s(R.string.selftest_name_server), Health.Level.ERROR, Tr.s(R.string.selftest_server_not_started))
                    !srv.bound -> Item(
                        Tr.s(R.string.selftest_name_server), Health.Level.ERROR,
                        Tr.s(R.string.selftest_server_not_listening, srv.lastError ?: Tr.s(R.string.selftest_server_starting))
                    )
                    else -> Item(
                        Tr.s(R.string.selftest_name_server), Health.Level.OK,
                        Tr.s(
                            R.string.selftest_server_listening,
                            BridgeService.PORT.toString(),
                            Health.duration(System.currentTimeMillis() - srv.since)
                        )
                    )
                }
            )

            val status = http("GET", "/status", null)
            items.add(
                when {
                    status.error != null -> Item(Tr.s(R.string.selftest_name_api_status), Health.Level.ERROR, status.error)
                    status.code != 200 -> Item(Tr.s(R.string.selftest_name_api_status), Health.Level.ERROR, Tr.s(R.string.selftest_http_status, status.code))
                    !status.body.contains("\"app\":true") -> Item(Tr.s(R.string.selftest_name_api_status), Health.Level.ERROR, Tr.s(R.string.selftest_status_unexpected))
                    else -> Item(Tr.s(R.string.selftest_name_api_status), Health.Level.OK, Tr.s(R.string.selftest_status_ok, status.ms))
                }
            )

            val page = http("GET", "/", null)
            items.add(
                when {
                    page.error != null -> Item(Tr.s(R.string.selftest_name_test_page), Health.Level.ERROR, page.error)
                    page.code != 200 || !page.body.contains("<html") -> Item(Tr.s(R.string.selftest_name_test_page), Health.Level.ERROR, Tr.s(R.string.selftest_http_status, page.code))
                    else -> Item(Tr.s(R.string.selftest_name_test_page), Health.Level.OK, Tr.s(R.string.selftest_page_ok, BridgeService.PORT.toString()))
                }
            )

            val js = http("GET", "/escpos.js", null)
            items.add(
                when {
                    js.error != null -> Item(Tr.s(R.string.selftest_name_web_client), Health.Level.ERROR, js.error)
                    js.code != 200 || !js.body.contains("RawBT") -> Item(Tr.s(R.string.selftest_name_web_client), Health.Level.ERROR, Tr.s(R.string.selftest_http_status, js.code))
                    else -> Item(Tr.s(R.string.selftest_name_web_client), Health.Level.OK, Tr.s(R.string.selftest_js_ok, js.body.length / 1024))
                }
            )

            val bt = Printer.btCheck()
            Health.btLine = bt
            items.add(Item(Tr.s(R.string.selftest_name_bluetooth), bt.level, bt.text))

            val noPrinter = Printer.selectedMac().isNullOrEmpty()
            if (noPrinter) {
                items.add(Item(Tr.s(R.string.selftest_name_printer), Health.Level.WARN, Tr.s(R.string.selftest_printer_none)))
            } else if (bt.level == Health.Level.ERROR) {
                items.add(Item(Tr.s(R.string.selftest_name_printer), Health.Level.ERROR, Tr.s(R.string.selftest_printer_bt_first)))
            } else if (includePrint) {
                // The test print below already opens the connection: many printers would refuse
                // two SPP connections in a row.
                items.add(Item(Tr.s(R.string.selftest_name_printer), Health.Level.OK, Tr.s(R.string.selftest_printer_by_print)))
            } else if (Printer.isBusy()) {
                // Do not take the SPP link while someone else is printing: their print would be refused.
                items.add(Item(Tr.s(R.string.selftest_name_printer), Health.Level.WARN, Tr.s(R.string.selftest_printer_busy)))
            } else {
                val p0 = System.currentTimeMillis()
                val res = Printer.probe()
                val pms = System.currentTimeMillis() - p0
                items.add(
                    if (res.ok) {
                        Item(
                            Tr.s(R.string.selftest_name_printer), Health.Level.OK,
                            Tr.s(R.string.selftest_printer_ok, Printer.selectedName() ?: Tr.s(R.string.selftest_printer_fallback_name), pms)
                        )
                    } else {
                        Item(
                            Tr.s(R.string.selftest_name_printer),
                            if (res.busy) Health.Level.WARN else Health.Level.ERROR,
                            res.error ?: Tr.s(R.string.selftest_printer_failed)
                        )
                    }
                )
            }

            val power = Power.check(ctx)
            Health.powerLine = power
            items.add(Item(Tr.s(R.string.selftest_name_power), power.level, power.text))

            notificationsItem(ctx)?.let { items.add(it) }

            if (includePrint) {
                if (noPrinter || bt.level == Health.Level.ERROR) {
                    items.add(Item(Tr.s(R.string.selftest_name_test_print), Health.Level.ERROR, Tr.s(R.string.selftest_print_not_tried)))
                } else {
                    val printed = http("POST", "/receipt", testReceipt().toString())
                    items.add(
                        when {
                            printed.error != null -> Item(Tr.s(R.string.selftest_name_test_print), Health.Level.ERROR, printed.error)
                            printed.body.contains("\"ok\":true") -> Item(Tr.s(R.string.selftest_name_test_print), Health.Level.OK, Tr.s(R.string.selftest_print_ok, printed.ms))
                            else -> Item(Tr.s(R.string.selftest_name_test_print), Health.Level.ERROR, errorOf(printed.body))
                        }
                    )
                }
            }
        } catch (t: Throwable) {
            items.add(Item(Tr.s(R.string.selftest_name_selftest), Health.Level.ERROR, Tr.s(R.string.selftest_interrupted, t.message ?: t.javaClass.simpleName)))
        } finally {
            running.set(false)
        }
        val report = Report(items, System.currentTimeMillis() - t0, version, versionCode, device)
        Printer.log(Tr.s(R.string.selftest_log_done, report.summary()))
        for (it in items) {
            if (it.level != Health.Level.OK) Printer.log("  ${symbol(it.level)} ${it.name}: ${it.detail}")
        }
        return report
    }

    /** null on Android 6, where the notification state cannot be read (so the entry does not lower the result). */
    private fun notificationsItem(ctx: Context): Item? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return null
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        val enabled = try {
            nm?.areNotificationsEnabled()
        } catch (_: Throwable) {
            null
        }
        // From Android 8 the service channel alone can be turned off too, and the battery warning with it.
        val channelOff = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                nm?.getNotificationChannel(BridgeService.CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE
            } catch (_: Throwable) {
                false
            }
        } else {
            false
        }
        val name = Tr.s(R.string.selftest_name_notifications)
        return when {
            enabled == false -> Item(name, Health.Level.WARN, Tr.s(R.string.selftest_notifications_off))
            channelOff -> Item(
                name, Health.Level.WARN,
                Tr.s(R.string.selftest_notifications_channel_off, Tr.s(R.string.service_channel_name))
            )
            enabled == true -> Item(name, Health.Level.OK, Tr.s(R.string.selftest_notifications_on))
            else -> Item(name, Health.Level.UNKNOWN, Tr.s(R.string.selftest_notifications_unknown))
        }
    }

    private fun errorOf(body: String): String = try {
        JSONObject(body).optString("error", Tr.s(R.string.selftest_error_unknown))
    } catch (_: Throwable) {
        Tr.s(R.string.selftest_response_invalid)
    }

    private class HttpResult(val code: Int, val body: String, val ms: Long, val error: String?)

    // NO_PROXY: a Wi-Fi proxy would be applied to 127.0.0.1 too.
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
            HttpResult(
                0, "", System.currentTimeMillis() - t0,
                Tr.s(R.string.selftest_http_failed, t.message ?: t.javaClass.simpleName, System.currentTimeMillis() - t0)
            )
        }
    }
}
