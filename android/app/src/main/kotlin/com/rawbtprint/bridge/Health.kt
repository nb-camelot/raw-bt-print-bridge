package com.rawbtprint.bridge

import android.content.Context
import android.os.Build
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Stato di salute dei tre tratti del bridge, condiviso nello stesso processo tra
 * servizio, server, stampante e Activity:
 *  1. server API su 127.0.0.1 (in ascolto? risponde? lo verifica l'autotest del servizio)
 *  2. chiamate in arrivo dal browser (arrivano? con che esito e in quanto tempo?)
 *  3. Bluetooth / stampante (acceso? accoppiata? esito dell'ultima stampa o prova)
 */
object Health {

    enum class Level { OK, WARN, ERROR, UNKNOWN }

    class Line(val level: Level, val text: String)

    // ── 1. Server API ────────────────────────────────────────────────────────
    val serverRestarts = AtomicInteger(0)

    // Autotest: il servizio chiama periodicamente GET /status su se stesso.
    @Volatile var selfTestAt = 0L
    @Volatile var selfTestOk: Boolean? = null
    @Volatile var selfTestMs = 0L
    @Volatile var selfTestError: String? = null
    val selfTestFailures = AtomicInteger(0)

    // ── 2. Chiamate in arrivo (escluso l'autotest) ───────────────────────────
    val requests = AtomicLong(0)
    val activeConnections = AtomicInteger(0)
    @Volatile var lastRequestAt = 0L
    @Volatile var lastRequest = ""

    // ── 3. Bluetooth / stampa ────────────────────────────────────────────────
    @Volatile var lastPrintAt = 0L
    @Volatile var lastPrintOk: Boolean? = null
    @Volatile var lastPrintDetail = ""

    fun recordSelfTest(ok: Boolean, ms: Long, error: String?) {
        selfTestAt = System.currentTimeMillis()
        selfTestOk = ok
        selfTestMs = ms
        selfTestError = error
        if (ok) selfTestFailures.set(0) else selfTestFailures.incrementAndGet()
    }

    fun recordRequest(summary: String) {
        requests.incrementAndGet()
        lastRequestAt = System.currentTimeMillis()
        lastRequest = summary
    }

    fun recordPrint(ok: Boolean, detail: String) {
        lastPrintAt = System.currentTimeMillis()
        lastPrintOk = ok
        lastPrintDetail = detail
    }

    fun server(): Line {
        val srv = PrintServer.current ?: return Line(Level.ERROR, "server non avviato")
        if (!srv.bound) {
            return Line(Level.ERROR, "NON in ascolto: " + (srv.lastError ?: "avvio in corso"))
        }
        val since = "in ascolto da " + duration(System.currentTimeMillis() - srv.since)
        val restarts = serverRestarts.get().let { if (it > 0) " · riavvii: $it" else "" }
        val ok = selfTestOk
        return when {
            ok == null -> Line(Level.UNKNOWN, "$since · autotest in attesa$restarts")
            ok -> Line(Level.OK, "$since · autotest OK ${selfTestMs} ms alle ${clock(selfTestAt)}$restarts")
            else -> Line(
                Level.ERROR,
                "$since · autotest FALLITO alle ${clock(selfTestAt)}: ${selfTestError ?: "?"}$restarts"
            )
        }
    }

    fun calls(): Line {
        val n = requests.get()
        val active = activeConnections.get().let { if (it > 0) " · connessioni aperte: $it" else "" }
        if (n == 0L) {
            return Line(Level.UNKNOWN, "nessuna chiamata ricevuta da quando il server e' partito$active")
        }
        return Line(Level.OK, "ultima alle ${clock(lastRequestAt)} (${ago(lastRequestAt)}): $lastRequest · totale $n$active")
    }

    fun bluetooth(): Line {
        val bt = Printer.btCheck()
        val ok = lastPrintOk ?: return bt
        val last = (if (ok) "ultima connessione OK" else "ultima connessione FALLITA") +
            " alle ${clock(lastPrintAt)}: $lastPrintDetail"
        val level = when {
            bt.level == Level.ERROR -> Level.ERROR
            !ok -> Level.WARN
            else -> bt.level
        }
        return Line(level, bt.text + " · " + last)
    }

    fun appVersion(ctx: Context?): String = try {
        ctx?.packageManager?.getPackageInfo(ctx.packageName, 0)?.versionName ?: "?"
    } catch (_: Throwable) {
        "?"
    }

    @Suppress("DEPRECATION")
    fun appVersionCode(ctx: Context?): Long = try {
        val info = ctx?.packageManager?.getPackageInfo(ctx.packageName, 0)
        when {
            info == null -> 0L
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> info.longVersionCode
            else -> info.versionCode.toLong()
        }
    } catch (_: Throwable) {
        0L
    }

    fun clock(ms: Long): String =
        if (ms <= 0L) "-" else SimpleDateFormat("HH:mm:ss", Locale.ITALY).format(Date(ms))

    fun ago(ms: Long): String = if (ms <= 0L) "-" else duration(System.currentTimeMillis() - ms) + " fa"

    fun duration(ms: Long): String {
        val s = (ms / 1000L).coerceAtLeast(0L)
        return when {
            s < 60L -> "$s s"
            s < 3600L -> "${s / 60L} min"
            else -> "${s / 3600L} h ${(s % 3600L) / 60L} min"
        }
    }
}
