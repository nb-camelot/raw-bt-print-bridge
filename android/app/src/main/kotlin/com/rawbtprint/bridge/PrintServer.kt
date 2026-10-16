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
    private var acceptThread: Thread? = null

    val url: String get() = "http://127.0.0.1:$port/print"

    fun start() {
        if (running) return
        running = true
        acceptThread = thread(name = "print-server") {
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

                method == "GET" && path == "/status" -> {
                    val json = "{\"app\":true,\"port\":$port," +
                        "\"state\":\"" + escape(Printer.lastState) + "\"," +
                        "\"detail\":\"" + escape(Printer.lastDetail) + "\"," +
                        "\"device\":\"" + escape(Printer.deviceLabel()) + "\"}"
                    respond(output, 200, "application/json", json.toByteArray())
                }

                method == "POST" && path == "/print" -> {
                    val text = String(body, Charsets.US_ASCII).trim()
                    val bytes: ByteArray = try {
                        if (text.isNotEmpty()) Base64.decode(text, Base64.DEFAULT) else body
                    } catch (t: Throwable) {
                        body
                    }
                    if (bytes.isEmpty()) {
                        respond(output, 400, "application/json", "{\"ok\":false,\"error\":\"payload vuoto\"}".toByteArray())
                    } else {
                        val res = Printer.print(bytes, "web")
                        val json = if (res.ok) {
                            "{\"ok\":true,\"bytes\":${res.bytes}}"
                        } else {
                            "{\"ok\":false,\"error\":\"" + escape(res.error ?: "errore") + "\"}"
                        }
                        respond(output, 200, "application/json", json.toByteArray())
                    }
                }

                else -> respond(output, 404, "application/json", "{\"ok\":false,\"error\":\"not found\"}".toByteArray())
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
            append("Content-Type: ").append(contentType).append("\r\n")
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
