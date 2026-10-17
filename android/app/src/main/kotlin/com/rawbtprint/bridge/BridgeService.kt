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
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class BridgeService : Service() {

    companion object {
        const val PORT = 8787
        private const val CHANNEL_ID = "rawbt_bridge"
        private const val NOTIFICATION_ID = 1
        const val ACTION_RESTART_SERVER = "com.rawbtprint.bridge.RESTART_SERVER"
        private const val WATCHDOG_PERIOD_S = 15L
        private const val SELF_TEST_TIMEOUT_MS = 3_000

        fun start(context: Context) {
            startWith(context, Intent(context, BridgeService::class.java))
        }

        /** Chiude e riapre il server locale (pulsante "Riavvia server" dell'app). */
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
    private var lastNotificationText = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Printer.init(applicationContext)
        AppConfig.init(applicationContext)
        Printer.log("Servizio avviato")
        createChannel()
        try {
            startForeground(NOTIFICATION_ID, buildNotification("Avvio del server locale..."))
        } catch (t: Throwable) {
            Printer.log("Foreground non avviato: ${t.message}")
            stopSelf()
            return
        }
        startServer()
        val w = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "bridge-watchdog").apply { isDaemon = true }
        }
        w.scheduleWithFixedDelay({ watchdogTick() }, 2L, WATCHDOG_PERIOD_S, TimeUnit.SECONDS)
        watchdog = w
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RESTART_SERVER) {
            // Sullo stesso thread del watchdog: riavvio e autotest non si sovrappongono.
            watchdog?.execute {
                restartServer("richiesta dall'app")
                watchdogTick()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Printer.log("Servizio fermato")
        watchdog?.shutdownNow()
        watchdog = null
        server?.stop()
        server = null
        super.onDestroy()
    }

    @Synchronized
    private fun startServer() {
        server?.stop()
        server = PrintServer(PORT).also { it.start() }
    }

    private fun restartServer(reason: String) {
        Printer.log("Riavvio del server locale: $reason")
        Health.serverRestarts.incrementAndGet()
        Health.selfTestFailures.set(0)
        startServer()
    }

    /**
     * Autotest periodico: il servizio chiama GET /status su se stesso come farebbe il browser.
     * Se il server non e in ascolto, o non risponde due volte di seguito, lo riavvia.
     */
    private fun watchdogTick() {
        try {
            val srv = server
            if (srv == null || !srv.bound) {
                val why = srv?.lastError?.let { "server non in ascolto ($it)" } ?: "server non in ascolto"
                restartServer(why)
                updateNotification()
                return
            }
            val t0 = System.currentTimeMillis()
            var error: String? = null
            try {
                val conn = URL("http://127.0.0.1:$PORT/status").openConnection() as HttpURLConnection
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
            val ms = System.currentTimeMillis() - t0
            Health.recordSelfTest(error == null, ms, error)
            if (error != null) {
                Printer.log("Autotest server FALLITO dopo $ms ms: $error")
                if (Health.selfTestFailures.get() >= 2) {
                    restartServer("autotest fallito due volte di seguito")
                }
            }
            updateNotification()
        } catch (t: Throwable) {
            // Un'eccezione non gestita cancellerebbe le esecuzioni successive del watchdog.
            Printer.log("Watchdog: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private fun updateNotification() {
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
            Health.Level.OK -> "API ok su 127.0.0.1:$PORT"
            Health.Level.ERROR -> "API NON risponde: riavvio automatico"
            else -> "API in verifica"
        }
        val bt = Printer.btCheck()
        val printer = if (bt.level == Health.Level.OK) "stampante pronta" else bt.text
        return "$api · $printer"
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Bridge stampante",
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Mantiene attivo il server locale per la stampa"
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
            .setContentTitle("Raw BT Print Bridge attiva")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()
    }
}
