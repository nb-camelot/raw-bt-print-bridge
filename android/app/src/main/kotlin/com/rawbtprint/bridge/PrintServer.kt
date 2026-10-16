package com.rawbtprint.bridge

import android.util.Base64
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class PrintServer(private val port: Int) {

    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null

    val url: String get() = "http://127.0.0.1:$port/print"

    fun start() {
        if (running) return
        running = true
        thread(name = "print-server") {
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
                serverSocket = ss
                Printer.log("Server locale in ascolto su 127.0.0.1:$port")
                while (running) {
                    val client = try {
                        ss.accept()
                    } catch (t: Throwable) {
                        if (running) continue else break
                    }
                    thread(name = "print-conn") { handle(client) }
                }
            } catch (t: Throwable) {
                Printer.log("Server locale non avviato: ${t.message}")
            }
        }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Throwable) {
        }
        serverSocket = null
    }

    private fun handle(client: Socket) {
        try {
            client.soTimeout = 30_000
            val input = client.getInputStream()
            val output = client.getOutputStream()
            val head = readHead(input) ?: return
            val lines = head.split("\r\n")
            val first = lines.firstOrNull() ?: return
            val parts = first.split(" ")
            val method = parts.getOrElse(0) { "" }
            val path = parts.getOrElse(1) { "/" }.substringBefore('?')

            var contentLength = 0
            for (l in lines) {
                if (l.startsWith("Content-Length:", ignoreCase = true)) {
                    contentLength = l.substringAfter(":").trim().toIntOrNull() ?: 0
                }
            }
            val body = if (contentLength > 0) readN(input, contentLength) else ByteArray(0)

            when {
                method == "OPTIONS" -> respond(output, 204, "application/json", ByteArray(0))

                method == "GET" && path == "/status" -> respond(output, 200, "application/json", statusJson())

                method == "GET" && path == "/config" -> respond(output, 200, "application/json", configJson())

                method == "POST" && path == "/config" -> {
                    val json = String(body, Charsets.UTF_8)
                    try {
                        applyConfig(json)
                        respond(output, 200, "application/json", configJson())
                    } catch (t: Throwable) {
                        respond(output, 400, "application/json", errJson("config non valida: ${t.message}"))
                    }
                }

                method == "POST" && path == "/receipt" -> {
                    val json = String(body, Charsets.UTF_8)
                    try {
                        val spec = Receipt.parse(json)
                        val ctx = Printer.context()
                            ?: throw IllegalStateException("app non inizializzata")
                        val bytes = Receipt.render(ctx, spec)
                        val res = Printer.print(bytes, "receipt", spec.printerMac)
                        respond(output, 200, "application/json", printJson(res, spec))
                    } catch (t: Throwable) {
                        respond(output, 400, "application/json", errJson(t.message ?: "scontrino non valido"))
                    }
                }

                method == "POST" && path == "/print" -> {
                    val text = String(body, Charsets.US_ASCII).trim()
                    val bytes: ByteArray = try {
                        if (text.isNotEmpty()) Base64.decode(text, Base64.DEFAULT) else body
                    } catch (t: Throwable) {
                        body
                    }
                    if (bytes.isEmpty()) {
                        respond(output, 400, "application/json", errJson("payload vuoto"))
                    } else {
                        val res = Printer.print(bytes, "web")
                        respond(output, 200, "application/json", printJson(res, null))
                    }
                }

                else -> respond(output, 404, "application/json", errJson("not found"))
            }
        } catch (t: Throwable) {
            Printer.log("Errore richiesta locale: ${t.message}")
        } finally {
            try {
                client.close()
            } catch (_: Throwable) {
            }
        }
    }

    private fun statusJson(): String {
        val base =
            "{\"app\":true,\"port\":$port," +
                "\"state\":\"" + escape(Printer.lastState) + "\"," +
                "\"detail\":\"" + escape(Printer.lastDetail) + "\"," +
                "\"device\":\"" + escape(Printer.deviceLabel()) + "\","
        return base + configJson().substring(1)
    }

    private fun configJson(): String =
        "{\"paperWidth\":${AppConfig.paperWidth()}," +
            "\"paperPixels\":${AppConfig.paperPixels()}," +
            "\"logoMode\":\"" + escape(AppConfig.logoMode()) + "\"," +
            "\"logo\":\"" + escape(AppConfig.logoLabel()) + "\"," +
            "\"printer\":\"" + escape(Printer.selectedMac() ?: "") + "\"," +
            "\"api\":{\"status\":\"http://127.0.0.1:$port/status\"," +
            "\"config\":\"http://127.0.0.1:$port/config\"," +
            "\"receipt\":\"http://127.0.0.1:$port/receipt\"," +
            "\"print\":\"http://127.0.0.1:$port/print\"}}"

    private fun applyConfig(json: String) {
        val o = org.json.JSONObject(json)
        if (o.has("paperWidth")) AppConfig.setPaperWidth(o.getInt("paperWidth"))
        if (o.has("logoMode")) {
            val mode = o.optString("logoMode", AppConfig.MODE_NONE)
            if (mode == AppConfig.MODE_NONE) {
                AppConfig.clearLogo()
                LogoStore.delete(Printer.context() ?: return)
            } else {
                AppConfig.setLogo(mode, if (o.isNull("logoValue")) null else o.optString("logoValue", null))
            }
        }
        if (o.has("printer")) {
            val mac = o.optString("printer", "")
            val name = if (o.has("printerName")) o.optString("printerName", null) else null
            if (mac.isNotEmpty()) Printer.remember(mac, name ?: Printer.selectedName())
        }
        if (o.has("logoUrl")) {
            val url = o.optString("logoUrl", "")
            val ctx = Printer.context() ?: throw IllegalStateException("app non inizializzata")
            if (url.isNotEmpty()) {
                LogoStore.downloadFromUrl(ctx, url)
                AppConfig.setLogo(AppConfig.MODE_URL, url)
            }
        }
        Printer.log("Config aggiornata: ${AppConfig.paperWidth()} colonne, logo ${AppConfig.logoLabel()}")
    }

    private fun printJson(res: Printer.Result, spec: Receipt.Spec?): String {
        val ok = res.ok
        val summary = spec?.let { ",\"summary\":\"" + escape(Receipt.summary(it)) + "\"" } ?: ""
        return if (ok) {
            "{\"ok\":true,\"bytes\":${res.bytes}$summary}"
        } else {
            "{\"ok\":false,\"error\":\"" + escape(res.error ?: "errore") + "\"}"
        }
    }

    private fun errJson(msg: String): String =
        "{\"ok\":false,\"error\":\"" + escape(msg) + "\"}"

    private fun readHead(input: InputStream): String? {
        val sb = StringBuilder()
        var b = input.read()
        if (b < 0) return null
        while (b >= 0 && sb.length < 32_768) {
            sb.append(b.toChar())
            val n = sb.length
            if (n >= 4 && sb[n - 4] == '\r' && sb[n - 3] == '\n' && sb[n - 2] == '\r' && sb[n - 1] == '\n') {
                return sb.toString()
            }
            b = input.read()
        }
        return sb.toString()
    }

    private fun readN(input: InputStream, length: Int): ByteArray {
        val buf = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(buf, read, length - read)
            if (n < 0) break
            read += n
        }
        return if (read == length) buf else buf.copyOf(read)
    }

    private fun respond(output: OutputStream, code: Int, contentType: String, body: String) {
        respond(output, code, contentType, body.toByteArray(Charsets.UTF_8))
    }

    private fun respond(output: OutputStream, code: Int, contentType: String, body: ByteArray) {
        val status = when (code) {
            200 -> "200 OK"
            204 -> "204 No Content"
            400 -> "400 Bad Request"
            404 -> "404 Not Found"
            else -> "$code"
        }
        val headers = buildString {
            append("HTTP/1.1 ").append(status).append("\r\n")
            append("Content-Type: ").append(contentType).append("; charset=utf-8\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            append("Access-Control-Allow-Origin: *\r\n")
            append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
            append("Access-Control-Allow-Headers: Content-Type\r\n")
            append("Access-Control-Allow-Private-Network: true\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(headers.toByteArray(Charsets.US_ASCII))
        if (body.isNotEmpty()) output.write(body)
        output.flush()
    }

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ")
}
