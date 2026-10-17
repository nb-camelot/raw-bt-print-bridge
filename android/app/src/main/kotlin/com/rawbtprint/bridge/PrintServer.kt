package com.rawbtprint.bridge

import android.util.Base64
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.concurrent.thread

class PrintServer(private val port: Int) {

    companion object {
        /** Ultimo server avviato dal servizio: lo leggono /status, l'autotest e il pannello dell'app. */
        @Volatile
        var current: PrintServer? = null

        /** Header con cui l'autotest del servizio marca le proprie richieste (non finiscono nel registro). */
        const val SELF_TEST_HEADER = "X-Bridge-Selftest"
    }

    @Volatile
    private var running = false

    @Volatile
    private var serverSocket: ServerSocket? = null

    /** true solo dopo un bind riuscito e finche il ciclo di accept e vivo. */
    @Volatile
    var bound = false
        private set

    @Volatile
    var since = 0L
        private set

    @Volatile
    var lastError: String? = null
        private set

    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "print-conn").apply { isDaemon = true }
    }

    val url: String get() = "http://127.0.0.1:$port/print"

    fun start() {
        if (running) return
        running = true
        current = this
        thread(name = "print-server") {
            var listening = false
            try {
                val ss = ServerSocket()
                serverSocket = ss
                try {
                    ss.reuseAddress = true
                    ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
                    since = System.currentTimeMillis()
                    lastError = null
                    bound = true
                    listening = true
                    Printer.log("Server locale in ascolto su 127.0.0.1:$port")
                    acceptLoop(ss)
                } finally {
                    // Mai lasciare la porta aperta senza nessuno che accetta: il browser
                    // resterebbe appeso invece di ricevere "connessione rifiutata".
                    bound = false
                    try {
                        ss.close()
                    } catch (_: Throwable) {
                    }
                }
            } catch (t: Throwable) {
                lastError = t.message ?: t.javaClass.simpleName
                if (listening) {
                    Printer.log("Server locale fermato da un errore: $lastError")
                } else {
                    Printer.log("Server locale non avviato: $lastError")
                }
            }
        }
    }

    private fun acceptLoop(ss: ServerSocket) {
        var lastAcceptError = ""
        while (running) {
            val client = try {
                ss.accept()
            } catch (t: Throwable) {
                if (!running) return
                val msg = t.message ?: t.javaClass.simpleName
                lastError = "accept: $msg"
                if (msg != lastAcceptError) {
                    Printer.log("Server locale: errore in accept ($msg), riprovo")
                    lastAcceptError = msg
                }
                try {
                    Thread.sleep(250)
                } catch (_: InterruptedException) {
                    return
                }
                continue
            }
            try {
                pool.execute { handle(client) }
            } catch (t: Throwable) {
                Printer.log("Server locale: richiesta scartata (${t.message ?: t.javaClass.simpleName})")
                try {
                    client.close()
                } catch (_: Throwable) {
                }
            }
        }
    }

    fun stop() {
        running = false
        bound = false
        try {
            serverSocket?.close()
        } catch (_: Throwable) {
        }
        serverSocket = null
        pool.shutdown()
        if (current === this) current = null
    }

    private fun handle(client: Socket) {
        val t0 = System.currentTimeMillis()
        var method = ""
        var path = ""
        var origin = ""
        var selfTest = false
        var code = 0
        Health.activeConnections.incrementAndGet()
        try {
            client.soTimeout = 30_000
            val input = client.getInputStream()
            val output = client.getOutputStream()
            val head = readHead(input) ?: return
            val lines = head.split("\r\n")
            val first = lines.firstOrNull() ?: return
            val parts = first.split(" ")
            method = parts.getOrElse(0) { "" }
            path = parts.getOrElse(1) { "/" }.substringBefore('?')

            var contentLength = 0
            for (l in lines) {
                val name = l.substringBefore(':').trim()
                val value = l.substringAfter(':', "").trim()
                when {
                    name.equals("Content-Length", ignoreCase = true) -> contentLength = value.toIntOrNull() ?: 0
                    name.equals("Origin", ignoreCase = true) -> origin = value
                    name.equals(SELF_TEST_HEADER, ignoreCase = true) -> selfTest = true
                }
            }
            val body = if (contentLength > 0) readN(input, contentLength) else ByteArray(0)
            code = route(method, path, body, output)
        } catch (t: Throwable) {
            if (!selfTest) {
                val ms = System.currentTimeMillis() - t0
                val what = if (method.isEmpty()) "connessione aperta senza richiesta" else "$method $path"
                Printer.log("Errore richiesta locale ($what, dopo $ms ms): ${t.message ?: t.javaClass.simpleName}")
            }
        } finally {
            try {
                client.close()
            } catch (_: Throwable) {
            }
            Health.activeConnections.decrementAndGet()
            if (!selfTest && method.isNotEmpty()) {
                val ms = System.currentTimeMillis() - t0
                val from = if (origin.isEmpty()) "" else " da " + origin.removePrefix("https://").removePrefix("http://")
                val result = if (code > 0) code.toString() else "nessuna risposta"
                val summary = "$method $path -> $result ($ms ms)$from"
                Health.recordRequest(summary)
                Printer.log("HTTP $summary")
            }
        }
    }

    private fun route(method: String, path: String, body: ByteArray, output: OutputStream): Int = when {
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

        method == "GET" && (path == "/" || path == "/test") -> {
            val h = asset("test.html")
            if (h != null) respond(output, 200, "text/html", h) else respond(output, 200, "application/json", rootJson())
        }

        method == "GET" && path == "/escpos.js" -> {
            val js = asset("escpos.js")
            if (js != null) {
                respond(output, 200, "application/javascript", js)
            } else {
                respond(output, 404, "application/json", errJson("escpos.js non incluso nell'app"))
            }
        }

        (method == "GET" || method == "HEAD") && (path == "/receipt" || path == "/print") ->
            respond(output, 405, "application/json", errJson("usa POST $path " +
                (if (path == "/receipt") "(corpo JSON)" else "(base64 ESC/POS)")))

        else -> respond(output, 404, "application/json", errJson("not found"))
    }

    private fun rootJson(): String =
        "{\"app\":\"raw-bt-print-bridge\",\"port\":$port," +
            "\"endpoints\":{" +
            "\"status\":\"GET /status\"," +
            "\"config\":\"GET/POST /config\"," +
            "\"receipt\":\"POST /receipt (JSON)\"," +
            "\"print\":\"POST /print (base64 ESC/POS)\"," +
            "\"client\":\"GET /escpos.js\"}}"

    private fun statusJson(): String {
        val ctx = Printer.context()
        val o = JSONObject(configJson())
        o.put("app", true)
        o.put("port", port)
        o.put("version", Health.appVersion(ctx))
        o.put("versionCode", Health.appVersionCode(ctx))
        o.put("state", Printer.lastState)
        o.put("detail", Printer.lastDetail)
        o.put("device", Printer.deviceLabel())

        val srv = Health.server()
        val server = JSONObject()
        server.put("level", srv.level.name.lowercase())
        server.put("message", srv.text)
        server.put("bound", bound)
        server.put("uptimeS", if (bound) (System.currentTimeMillis() - since) / 1000L else 0L)
        server.put("restarts", Health.serverRestarts.get())
        server.put("requests", Health.requests.get())
        o.put("server", server)

        val bt = Health.bluetooth()
        val bluetooth = JSONObject()
        bluetooth.put("level", bt.level.name.lowercase())
        bluetooth.put("message", bt.text)
        o.put("bluetooth", bluetooth)
        return o.toString()
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

    private fun respond(output: OutputStream, code: Int, contentType: String, body: String): Int =
        respond(output, code, contentType, body.toByteArray(Charsets.UTF_8))

    private fun respond(output: OutputStream, code: Int, contentType: String, body: ByteArray): Int {
        val status = when (code) {
            200 -> "200 OK"
            204 -> "204 No Content"
            400 -> "400 Bad Request"
            404 -> "404 Not Found"
            405 -> "405 Method Not Allowed"
            500 -> "500 Internal Server Error"
            503 -> "503 Service Unavailable"
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
        return code
    }

    private fun asset(name: String): ByteArray? = try {
        Printer.context()?.assets?.open(name)?.use { it.readBytes() }
    } catch (_: Throwable) {
        null
    }

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ")
}
