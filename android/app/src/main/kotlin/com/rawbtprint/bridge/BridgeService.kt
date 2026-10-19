package com.rawbtprint.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class BridgeService : Service() {

    companion object {
        const val PORT = 8787
        const val CHANNEL_ID = "rawbt_bridge"
        private const val NOTIFICATION_ID = 1
        const val ACTION_RESTART_SERVER = "com.rawbtprint.bridge.RESTART_SERVER"
        private const val WATCHDOG_PERIOD_S = 15L
        private const val SELF_TEST_TIMEOUT_MS = 3_000
        private const val BIND_WAIT_MS = 3_000L

        /** true while the service is in the foreground (read by the self-test). */
        @Volatile
        var running = false

        fun start(context: Context) {
            startWith(context, Intent(context, BridgeService::class.java))
        }

        /** Closes and reopens the local server (the app's "Restart server" button). */
        fun restartServer(context: Context) {
            startWith(context, Intent(context, BridgeService::class.java).setAction(ACTION_RESTART_SERVER))
        }

        private fun startWith(context: Context, intent: Intent) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private var server: PrintServer? = null
    private var watchdog: ScheduledExecutorService? = null

    @Volatile
    private var destroyed = false

    @Volatile
    private var lastNotificationText = ""

    // Watchdog state: read and written only by its own thread.
    private var lastTickAt = 0L
    private var lastTickUptime = 0L
    private var restartsWithoutOk = 0
    private var skippedTicks = 0
    private var lastRestartReason = ""
    private var sameReasonCount = 0
    private var lastSelfTestLogged = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Tr.init(applicationContext)
        Printer.init(applicationContext)
        AppConfig.init(applicationContext)
        Printer.log(Tr.s(R.string.service_log_started))
        createChannel()
        try {
            startForeground(NOTIFICATION_ID, buildNotification(Tr.s(R.string.service_notification_starting)))
        } catch (t: Throwable) {
            Printer.log(Tr.s(R.string.service_log_foreground_failed, t.message))
            stopSelf()
            return
        }
        running = true
        startServer()
        Printer.refreshBtAsync()
        val w = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "bridge-watchdog").apply { isDaemon = true }
        }
        w.scheduleWithFixedDelay({ watchdogTick() }, 2L, WATCHDOG_PERIOD_S, TimeUnit.SECONDS)
        watchdog = w
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // On the watchdog thread: restart and self-test never overlap.
        // Every start (including the app coming back to the foreground) asks for an immediate check.
        val restart = intent?.action == ACTION_RESTART_SERVER
        try {
            watchdog?.execute {
                if (restart) restartServer(Tr.s(R.string.service_restart_reason_app), manual = true)
                watchdogTick()
            }
        } catch (_: Throwable) {
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Printer.log(Tr.s(R.string.service_log_stopped))
        running = false
        synchronized(this) {
            destroyed = true
            server?.stop()
            server = null
        }
        watchdog?.shutdownNow()
        watchdog = null
        super.onDestroy()
    }

    @Synchronized
    private fun startServer() {
        if (destroyed) return
        server?.stop()
        server = PrintServer(PORT).also { it.start() }
    }

    /** Watchdog thread only. Waits for the new server's bind result. */
    private fun restartServer(reason: String, manual: Boolean = false) {
        if (destroyed) return
        if (manual) {
            restartsWithoutOk = 0
            skippedTicks = 0
        }
        if (reason == lastRestartReason) {
            sameReasonCount++
            if (sameReasonCount % 20 == 0) {
                Printer.log(Tr.s(R.string.service_log_restart_repeated, reason, sameReasonCount))
            }
        } else {
            lastRestartReason = reason
            sameReasonCount = 1
            Printer.log(Tr.s(R.string.service_log_restart, reason))
        }
        Health.serverRestarts.incrementAndGet()
        Health.resetSelfTest()
        restartsWithoutOk++
        startServer()
        server?.awaitReady(BIND_WAIT_MS)
    }

    /** After three restarts without a successful self-test, retry only one tick in four (about once a minute). */
    private fun restartNowAllowed(): Boolean {
        if (restartsWithoutOk < 3) return true
        skippedTicks++
        if (skippedTicks < 4) return false
        skippedTicks = 0
        return true
    }

    /**
     * Periodic self-test: the service calls GET /status on itself, as the browser would.
     * If the server is not listening, or fails to answer twice in a row, it restarts it.
     */
    private fun watchdogTick() {
        if (destroyed) return
        try {
            val now = System.currentTimeMillis()
            val nowUp = SystemClock.uptimeMillis()
            if (lastTickAt > 0L) {
                // The check should run every 15 s. uptimeMillis does not advance in deep
                // sleep: if it advanced a lot, the tablet was on but the app was stopped,
                // i.e. suspended by the system (the cause of browser prints left waiting).
                val upGap = nowUp - lastTickUptime
                val wallGap = now - lastTickAt
                if (upGap > 45_000L) {
                    Health.recordStall(upGap)
                    Printer.log(Tr.s(R.string.service_log_app_suspended, upGap / 1000L))
                } else if (wallGap > 45_000L) {
                    Printer.log(Tr.s(R.string.service_log_watchdog_stalled, wallGap / 1000L))
                }
            }
            lastTickAt = now
            lastTickUptime = nowUp
            Printer.refreshBtAsync()

            val srv = server
            if (srv != null && !srv.bound) srv.awaitReady(BIND_WAIT_MS)
            if (srv == null || !srv.bound) {
                if (restartNowAllowed()) {
                    val why = srv?.lastError?.let { Tr.s(R.string.service_restart_reason_not_listening_detail, it) }
                        ?: Tr.s(R.string.service_restart_reason_not_listening)
                    restartServer(why)
                }
                updateNotification()
                return
            }

            val t0 = System.currentTimeMillis()
            var error: String? = null
            try {
                // NO_PROXY: a Wi-Fi proxy would be applied to 127.0.0.1 too.
                val conn = URL("http://127.0.0.1:$PORT/status").openConnection(Proxy.NO_PROXY) as HttpURLConnection
                try {
                    conn.connectTimeout = SELF_TEST_TIMEOUT_MS
                    conn.readTimeout = SELF_TEST_TIMEOUT_MS
                    conn.useCaches = false
                    conn.setRequestProperty(PrintServer.SELF_TEST_HEADER, "1")
                    val code = conn.responseCode
                    if (code == 200) {
                        conn.inputStream.use { it.readBytes() }
                    } else {
                        error = "HTTP $code"
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (t: Throwable) {
                error = t.message ?: t.javaClass.simpleName
            }
            if (destroyed) return
            val ms = System.currentTimeMillis() - t0
            Health.recordSelfTest(error == null, ms, error)
            if (error == null) {
                restartsWithoutOk = 0
                skippedTicks = 0
                lastRestartReason = ""
                if (lastSelfTestLogged.isNotEmpty()) {
                    Printer.log(Tr.s(R.string.service_log_selftest_ok_again, ms))
                    lastSelfTestLogged = ""
                }
            } else {
                if (error != lastSelfTestLogged) {
                    Printer.log(Tr.s(R.string.service_log_selftest_failed, ms, error))
                    lastSelfTestLogged = error
                }
                if (Health.selfTestFailures.get() >= 2 && restartNowAllowed()) {
                    restartServer(Tr.s(R.string.service_restart_reason_selftest_failed_twice))
                }
            }
            updateNotification()
        } catch (t: Throwable) {
            // An uncaught exception would cancel all later watchdog runs.
            Printer.log(Tr.s(R.string.service_log_watchdog_error, t.message ?: t.javaClass.simpleName))
        }
    }

    private fun updateNotification() {
        if (destroyed) return
        val text = notificationText()
        if (text == lastNotificationText) return
        lastNotificationText = text
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(text))
        } catch (_: Throwable) {
        }
    }

    private fun notificationText(): String {
        val api = when (Health.server().level) {
            Health.Level.OK -> Tr.s(R.string.service_notification_api_ok, PORT.toString())
            Health.Level.ERROR -> Tr.s(R.string.service_notification_api_error)
            else -> Tr.s(R.string.service_notification_api_checking)
        }
        val bt = Health.btLine
        val printer = if (bt.level == Health.Level.OK) Tr.s(R.string.service_notification_printer_ready) else bt.text
        // The most important warning goes first, so it can be read in the collapsed notification:
        // while the app can be suspended, browser prints wait until it is reopened.
        if (powerAtRisk()) {
            return Tr.s(R.string.service_notification_text_at_risk, api, printer)
        }
        return Tr.s(R.string.service_notification_text, api, printer)
    }

    private fun powerAtRisk(): Boolean = Health.powerLine.level == Health.Level.ERROR

    private fun notificationTitle(): String =
        if (powerAtRisk()) Tr.s(R.string.service_notification_title_at_risk)
        else Tr.s(R.string.service_notification_title_active, getString(R.string.app_name))

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Called on every start: for an existing channel it only updates name and description
        // (in the current language) and keeps the settings the user chose.
        val channel = NotificationChannel(
            CHANNEL_ID,
            Tr.s(R.string.service_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = Tr.s(R.string.service_channel_description)
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(notificationTitle())
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(R.drawable.ic_stat_bridge)
            .setColor(getColor(R.color.brand_teal))
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()
    }
}
