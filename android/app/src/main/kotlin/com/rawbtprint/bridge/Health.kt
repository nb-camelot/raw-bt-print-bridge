package com.rawbtprint.bridge

import android.content.Context
import android.os.Build
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Health of the bridge's three segments, shared within the same process by the
 * service, server, printer and Activity:
 *  1. API server on 127.0.0.1 (listening? answering? checked by the service self-test)
 *  2. calls coming from the browser (do they arrive? do they hang? with what result, how fast?)
 *  3. Bluetooth / printer (on? paired? result of the last print or probe)
 *
 * Nothing here makes slow system calls: /status and the panel only read these fields.
 */
object Health {

    enum class Level { OK, WARN, ERROR, UNKNOWN }

    class Line(val level: Level, val text: String)

    class InFlight(val what: String, val since: Long)

    // ── 1. Server API ────────────────────────────────────────────────────────
    val serverRestarts = AtomicInteger(0)

    @Volatile var lastServerStartError: String? = null

    // Self-test: the service periodically calls GET /status on itself.
    @Volatile var selfTestAt = 0L
    @Volatile var selfTestOk: Boolean? = null
    @Volatile var selfTestMs = 0L
    @Volatile var selfTestError: String? = null
    val selfTestFailures = AtomicInteger(0)

    // ── 2. Incoming calls ────────────────────────────────────────────────────
    private val connectionIds = AtomicLong(0)
    val accepted = AtomicLong(0)            // all accepted connections, self-test included
    val selfTestConnections = AtomicLong(0) // the self-test ones
    val emptyConnections = AtomicLong(0)    // closed or timed out without sending a request
    val waitingHead = AtomicInteger(0)      // accepted, waiting for the request
    val inFlight = ConcurrentHashMap<Long, InFlight>() // requests received, response not sent yet
    @Volatile var lastAcceptAt = 0L

    val requests = AtomicLong(0)
    @Volatile var lastRequestAt = 0L
    @Volatile var lastRequest = ""
    @Volatile var lastRequestCode = 0
    @Volatile var lastRequestMs = 0L

    // ── 3. Bluetooth / printing ──────────────────────────────────────────────
    // Last result of Printer.btCheck(), refreshed in the background (binder calls to the
    // Bluetooth process): so /status never depends on how fast the BT stack is.
    // Default texts are read at use time: Tr may not be ready when this object is created.
    @Volatile private var btLineValue: Line? = null
    var btLine: Line
        get() = btLineValue ?: Line(Level.UNKNOWN, Tr.s(R.string.health_bt_checking))
        set(value) {
            btLineValue = value
        }
    @Volatile var lastPrintAt = 0L
    @Volatile var lastPrintOk: Boolean? = null
    @Volatile var lastPrintDetail = ""

    // ── 4. Battery and background suspension (see Power) ─────────────────────
    @Volatile private var powerLineValue: Line? = null
    var powerLine: Line
        get() = powerLineValue ?: Line(Level.UNKNOWN, Tr.s(R.string.health_power_checking))
        set(value) {
            powerLineValue = value
        }
    @Volatile private var powerFixLabelValue: String? = null
    var powerFixLabel: String
        get() = powerFixLabelValue ?: Tr.s(R.string.health_power_fix)
        set(value) {
            powerFixLabelValue = value
        }

    // Last time the service noticed it had been stopped while the tablet was on.
    @Volatile var lastStallAt = 0L
    @Volatile var lastStallS = 0L

    fun recordStall(ms: Long) {
        lastStallAt = System.currentTimeMillis()
        lastStallS = ms / 1000L
    }

    @Volatile private var versionName: String? = null
    @Volatile private var versionCode = -1L

    fun nextConnectionId(): Long = connectionIds.incrementAndGet()

    fun recordSelfTest(ok: Boolean, ms: Long, error: String?) {
        selfTestAt = System.currentTimeMillis()
        selfTestOk = ok
        selfTestMs = ms
        selfTestError = error
        if (ok) selfTestFailures.set(0) else selfTestFailures.incrementAndGet()
    }

    /** After a restart, the previous self-test result does not apply to the new server. */
    fun resetSelfTest() {
        selfTestOk = null
        selfTestAt = 0L
        selfTestMs = 0L
        selfTestError = null
        selfTestFailures.set(0)
    }

    fun recordRequest(summary: String, code: Int, ms: Long) {
        requests.incrementAndGet()
        lastRequestAt = System.currentTimeMillis()
        lastRequest = summary
        lastRequestCode = code
        lastRequestMs = ms
    }

    fun recordPrint(ok: Boolean, detail: String) {
        lastPrintAt = System.currentTimeMillis()
        lastPrintOk = ok
        lastPrintDetail = detail
    }

    fun clearPrint() {
        lastPrintAt = 0L
        lastPrintOk = null
        lastPrintDetail = ""
    }

    fun server(): Line {
        val srv = PrintServer.current ?: return Line(Level.ERROR, Tr.s(R.string.health_server_not_started))
        if (!srv.bound) {
            val reason = srv.lastError ?: Tr.s(R.string.health_server_starting)
            return Line(Level.ERROR, Tr.s(R.string.health_server_not_listening, reason))
        }
        val now = System.currentTimeMillis()
        val since = Tr.s(R.string.health_server_listening_since, duration(now - srv.since))
        val restarts = serverRestarts.get().let {
            if (it > 0) " · " + Tr.s(R.string.health_server_restarts, it) else ""
        }
        val ok = selfTestOk
        val error = selfTestError ?: "?"
        return when {
            ok == null -> Line(Level.UNKNOWN, since + " · " + Tr.s(R.string.health_selftest_pending) + restarts)
            now - selfTestAt > 45_000L -> Line(
                Level.WARN,
                since + " · " + Tr.s(R.string.health_selftest_stalled, ago(selfTestAt)) + restarts
            )
            ok -> Line(
                Level.OK,
                since + " · " + Tr.s(R.string.health_selftest_ok, selfTestMs, clock(selfTestAt)) + restarts
            )
            selfTestFailures.get() < 2 -> Line(
                Level.WARN,
                since + " · " + Tr.s(R.string.health_selftest_failed_retry, clock(selfTestAt), error) + restarts
            )
            else -> Line(
                Level.ERROR,
                since + " · " +
                    Tr.s(R.string.health_selftest_failed_repeated, selfTestFailures.get(), clock(selfTestAt), error) +
                    restarts
            )
        }
    }

    fun calls(): Line {
        val now = System.currentTimeMillis()
        val parts = ArrayList<String>()
        val n = requests.get()
        var level = Level.UNKNOWN
        if (n > 0L) {
            parts.add(Tr.s(R.string.health_calls_last, clock(lastRequestAt), ago(lastRequestAt), lastRequest))
            level = when {
                lastRequestCode == 0 -> Level.ERROR
                lastRequestCode >= 400 || lastRequestMs > 5_000L -> Level.WARN
                else -> Level.OK
            }
        } else {
            parts.add(Tr.s(R.string.health_calls_none))
        }
        val oldest = inFlight.values.minByOrNull { it.since }
        if (oldest != null) {
            val age = now - oldest.since
            val others = inFlight.size - 1
            val more = if (others > 0) " " + Tr.s(R.string.health_calls_more, others) else ""
            parts.add(Tr.s(R.string.health_calls_in_flight, oldest.what, duration(age)) + more)
            if (age > 10_000L) level = Level.ERROR
        }
        val waiting = waitingHead.get()
        if (waiting > 0) parts.add(Tr.s(R.string.health_calls_waiting, waiting))
        val browser = accepted.get() - selfTestConnections.get()
        val lastAccept = if (lastAcceptAt > 0L) ", " + Tr.s(R.string.health_calls_last_accept, clock(lastAcceptAt)) else ""
        parts.add(Tr.s(R.string.health_calls_totals, n, browser, lastAccept, emptyConnections.get()))
        return Line(level, parts.joinToString(" · "))
    }

    fun bluetooth(): Line {
        val bt = btLine
        val ok = lastPrintOk ?: return bt
        val last = if (ok) {
            Tr.s(R.string.health_bt_last_ok, clock(lastPrintAt), lastPrintDetail)
        } else {
            Tr.s(R.string.health_bt_last_failed, clock(lastPrintAt), lastPrintDetail)
        }
        val level = when {
            bt.level == Level.ERROR -> Level.ERROR
            !ok -> Level.WARN
            else -> bt.level
        }
        return Line(level, bt.text + " · " + last)
    }

    fun power(): Line = powerLine

    fun appVersion(ctx: Context?): String {
        versionName?.let { return it }
        val v = try {
            ctx?.packageManager?.getPackageInfo(ctx.packageName, 0)?.versionName
        } catch (_: Throwable) {
            null
        }
        if (v != null) versionName = v
        return v ?: "?"
    }

    @Suppress("DEPRECATION")
    fun appVersionCode(ctx: Context?): Long {
        if (versionCode >= 0L) return versionCode
        val code = try {
            val info = ctx?.packageManager?.getPackageInfo(ctx.packageName, 0)
            when {
                info == null -> -1L
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> info.longVersionCode
                else -> info.versionCode.toLong()
            }
        } catch (_: Throwable) {
            -1L
        }
        if (code >= 0L) versionCode = code
        return code.coerceAtLeast(0L)
    }

    fun clock(ms: Long): String =
        if (ms <= 0L) "-" else SimpleDateFormat("HH:mm:ss", Locale.ITALY).format(Date(ms))

    fun ago(ms: Long): String =
        if (ms <= 0L) "-" else Tr.s(R.string.health_ago, duration(System.currentTimeMillis() - ms))

    fun duration(ms: Long): String {
        val s = (ms / 1000L).coerceAtLeast(0L)
        return when {
            s < 60L -> "$s s"
            s < 3600L -> "${s / 60L} min"
            else -> "${s / 3600L} h ${(s % 3600L) / 60L} min"
        }
    }
}
