package com.rawbtprint.bridge

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothDevice
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : Activity(), Printer.Listener {

    companion object {
        private const val REQ_PERM = 4212
        private const val REQ_LOGO = 4213
        const val PAGES_URL = "https://nb-camelot.github.io/raw-bt-print-bridge/"

        // L'avviso sulla batteria si mostra una volta per avvio dell'app, non a ogni ritorno.
        private var powerDialogShown = false
    }

    private var pendingPayload: ByteArray? = null
    private var pendingSelfTestPrint = false

    private lateinit var deviceText: TextView
    private lateinit var stateText: TextView
    private lateinit var detailText: TextView
    private lateinit var paperValueText: TextView
    private lateinit var logoStatusText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var btnTest: Button
    private lateinit var btnProbe: Button
    private lateinit var healthServerDot: TextView
    private lateinit var healthServerText: TextView
    private lateinit var healthCallsDot: TextView
    private lateinit var healthCallsText: TextView
    private lateinit var healthBtDot: TextView
    private lateinit var healthBtText: TextView
    private lateinit var healthPowerDot: TextView
    private lateinit var healthPowerText: TextView
    private lateinit var btnFixPower: Button
    private lateinit var btnSelfTest: Button

    // Aggiorna il pannello "Stato del bridge" ogni 2 s mentre l'app e visibile.
    private val healthHandler = Handler(Looper.getMainLooper())
    private val healthTick = object : Runnable {
        override fun run() {
            renderHealth()
            healthHandler.postDelayed(this, 2_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        deviceText = findViewById(R.id.device)
        stateText = findViewById(R.id.state)
        detailText = findViewById(R.id.detail)
        paperValueText = findViewById(R.id.paperValue)
        logoStatusText = findViewById(R.id.logoStatus)
        logText = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)
        btnTest = findViewById(R.id.btnTest)
        btnProbe = findViewById(R.id.btnProbeBt)
        healthServerDot = findViewById(R.id.healthServerDot)
        healthServerText = findViewById(R.id.healthServerText)
        healthCallsDot = findViewById(R.id.healthCallsDot)
        healthCallsText = findViewById(R.id.healthCallsText)
        healthBtDot = findViewById(R.id.healthBtDot)
        healthBtText = findViewById(R.id.healthBtText)
        healthPowerDot = findViewById(R.id.healthPowerDot)
        healthPowerText = findViewById(R.id.healthPowerText)
        btnFixPower = findViewById(R.id.btnFixPower)
        btnSelfTest = findViewById(R.id.btnSelfTest)

        findViewById<TextView>(R.id.version).text = "v" + appVersion() + " · 127.0.0.1:${BridgeService.PORT}"
        buildUrlList()

        btnFixPower.setOnClickListener { fixPower() }
        btnSelfTest.setOnClickListener { askSelfTest() }
        findViewById<Button>(R.id.btnCopyLog).setOnClickListener {
            copy("Registro Print Bridge", Printer.history().joinToString("\n"))
        }
        findViewById<Button>(R.id.btnRestartServer).setOnClickListener {
            if (Printer.hasConnectPermission()) {
                BridgeService.restartServer(this)
            } else {
                log("Riavvio server: serve prima il permesso Bluetooth")
                ensurePermissions()
            }
        }
        btnProbe.setOnClickListener { probeBluetooth() }
        findViewById<Button>(R.id.btnPick).setOnClickListener { showPicker(pendingPayload) }
        findViewById<Button>(R.id.btnTest).setOnClickListener { runTest() }
        findViewById<Button>(R.id.btnForget).setOnClickListener { forgetPrinter() }
        findViewById<Button>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<Button>(R.id.paper58).setOnClickListener { setPaper(32) }
        findViewById<Button>(R.id.paper80).setOnClickListener { setPaper(48) }
        findViewById<Button>(R.id.btnLogoUrl).setOnClickListener { askLogoUrl() }
        findViewById<Button>(R.id.btnLogoFile).setOnClickListener { pickLogoFile() }
        findViewById<Button>(R.id.btnLogoClear).setOnClickListener { clearLogo() }

        Printer.init(applicationContext)
        AppConfig.init(applicationContext)
        refreshDeviceUi()
        refreshConfigUi()

        // Listener, registro e servizio partono in onStart, che segue sempre onCreate.
        log("App avviata")

        handleIntent(intent)
        ensurePermissions()
    }

    private fun startServiceIfAllowed() {
        if (Printer.hasConnectPermission()) {
            BridgeService.start(this)
        } else {
            log("In attesa del permesso Bluetooth per avviare il servizio locale")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        // Il registro include anche quanto e successo mentre l'app non era visibile
        // (per esempio le chiamate arrivate dal browser).
        val past = Printer.addListenerWithHistory(this)
        logText.text = if (past.isEmpty()) "" else past.joinToString("\n", postfix = "\n")
        scrollLogToEnd()
        stateText.text = Printer.lastState
        detailText.text = Printer.lastDetail
        refreshDeviceUi()
        startServiceIfAllowed()
        healthHandler.removeCallbacks(healthTick)
        healthHandler.post(healthTick)
        maybeWarnAboutBattery()
    }

    override fun onStop() {
        healthHandler.removeCallbacks(healthTick)
        Printer.removeListener(this)
        super.onStop()
    }

    // ── Printer.Listener ─────────────────────────────────────────────────────
    override fun onStatus(state: String, detail: String) {
        runOnUiThread {
            stateText.text = state
            detailText.text = detail
        }
    }

    override fun onLog(line: String) {
        runOnUiThread {
            if (logText.length() > 60_000) {
                logText.text = Printer.history().joinToString("\n", postfix = "\n")
            } else {
                logText.append(line + "\n")
            }
            scrollLogToEnd()
        }
    }

    // scrollTo e non fullScroll: fullScroll sposta il focus sul registro e lo ScrollView
    // esterno salterebbe in fondo, nascondendo il pannello di stato.
    private fun scrollLogToEnd() {
        logScroll.post { logScroll.scrollTo(0, logText.height) }
    }

    private fun log(line: String) = Printer.log(line)

    // ── Stato del bridge ─────────────────────────────────────────────────────
    private fun renderHealth() {
        Printer.refreshBtAsync()
        showHealth(healthServerDot, healthServerText, Health.server())
        showHealth(healthCallsDot, healthCallsText, Health.calls())
        showHealth(healthBtDot, healthBtText, Health.bluetooth())
        val power = Health.power()
        showHealth(healthPowerDot, healthPowerText, power)
        btnFixPower.visibility =
            if (power.level == Health.Level.ERROR || power.level == Health.Level.WARN) View.VISIBLE else View.GONE
        // L'etichetta dice cosa apre davvero (stesso ordine di Power.fixIntents).
        btnFixPower.text = Health.powerFixLabel
    }

    private fun showHealth(dot: TextView, text: TextView, line: Health.Line) {
        dot.setTextColor(getColor(levelColor(line.level)))
        text.text = line.text
    }

    private fun levelColor(level: Health.Level): Int = when (level) {
        Health.Level.OK -> R.color.status_ok
        Health.Level.WARN -> R.color.status_warn
        Health.Level.ERROR -> R.color.status_error
        Health.Level.UNKNOWN -> R.color.status_unknown
    }

    // ── Batteria e sospensione ───────────────────────────────────────────────
    private fun maybeWarnAboutBattery() {
        if (powerDialogShown) return
        // Aperta per stampare (intent dal browser): l'avviso aspetta il prossimo avvio normale.
        if (intent?.data != null) return
        val p = Power.check(this)
        if (p.level != Health.Level.ERROR) return
        powerDialogShown = true
        AlertDialog.Builder(this)
            .setTitle("L’app può essere sospesa in background")
            .setMessage(
                "Problema trovato: ${p.text}.\n\n" +
                    "Quando Android sospende l'app, le stampe dalla pagina web restano in attesa finché " +
                    "non la riapri. Per stampare sempre dal browser disattiva l'ottimizzazione batteria " +
                    "per ${getString(R.string.app_name)} e, se usi le Opzioni sviluppatore, anche " +
                    "«Sospendi esecuzione per app memorizzate nella cache»."
            )
            .setPositiveButton("Risolvi ora") { _, _ -> fixPower() }
            .setNegativeButton("Non ora", null)
            .show()
    }

    /** Apre l'impostazione giusta per il primo problema di batteria trovato. */
    private fun fixPower() {
        for (intent in Power.fixIntents(this)) {
            try {
                startActivity(intent)
                return
            } catch (_: Throwable) {
            }
        }
        log("Impossibile aprire le impostazioni della batteria: cercale a mano in Impostazioni > App")
    }

    // ── Autotest completo ────────────────────────────────────────────────────
    private fun askSelfTest() {
        AlertDialog.Builder(this)
            .setTitle("Autotest completo")
            .setMessage(
                "Controlla servizio, server, API, pagina di test, client web, Bluetooth, connessione " +
                    "alla stampante, batteria e notifiche. Puoi aggiungere una stampa di prova che " +
                    "passa dall'API come quelle del browser."
            )
            .setPositiveButton("Esegui") { _, _ -> runSelfTest(false) }
            .setNeutralButton("Esegui e stampa") { _, _ -> runSelfTest(true) }
            .setNegativeButton("Annulla", null)
            .show()
    }

    private fun runSelfTest(withPrint: Boolean) {
        if (withPrint && Printer.selectedMac().isNullOrEmpty()) {
            // Dopo la scelta della stampante l'autotest con stampa riparte da solo.
            pendingSelfTestPrint = true
            showPicker(null)
            return
        }
        btnSelfTest.isEnabled = false
        btnSelfTest.text = "Autotest in corso..."
        thread {
            val report = SelfTest.run(applicationContext, withPrint)
            runOnUiThread {
                btnSelfTest.isEnabled = true
                btnSelfTest.text = "Autotest completo"
                renderHealth()
                if (isFinishing || isDestroyed) return@runOnUiThread
                AlertDialog.Builder(this)
                    .setTitle(report.title())
                    .setMessage(report.text())
                    .setPositiveButton("OK", null)
                    .setNeutralButton("Copia") { _, _ -> copy("Autotest Print Bridge", report.text()) }
                    .show()
            }
        }
    }

    // ── Indirizzi di prova ───────────────────────────────────────────────────
    private fun buildUrlList() {
        val list = findViewById<LinearLayout>(R.id.urlList)
        list.removeAllViews()
        val base = "http://127.0.0.1:${BridgeService.PORT}"
        val version = appVersion()
        // Le build di prova (es. 1.7.1-pr3) non sono su npm: per loro si indica l'ultima versione.
        val cdnVersion = if (version.contains('-') || version == "?") "latest" else version
        val urls = listOf(
            "Pagina di test servita dall’app (consigliata)" to "$base/",
            "Stato del bridge (JSON)" to "$base/status",
            "Autotest completo (JSON)" to "$base/selftest",
            "Pagina di test su GitHub Pages" to PAGES_URL,
            "Client web da includere nelle tue pagine" to
                "https://cdn.jsdelivr.net/npm/@nb-camelot/rawbt-print@$cdnVersion/escpos.js",
        )
        for ((label, url) in urls) list.addView(urlRow(label, url))
    }

    private fun urlRow(label: String, url: String): View {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.VERTICAL
        row.setPadding(0, dp(10), 0, 0)

        val title = TextView(this)
        title.text = label
        title.setTextColor(getColor(R.color.ink_muted))
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        row.addView(title)

        val box = LinearLayout(this)
        box.orientation = LinearLayout.HORIZONTAL
        box.gravity = Gravity.CENTER_VERTICAL
        box.setBackgroundResource(R.drawable.bg_url)
        box.setPadding(dp(10), dp(6), dp(6), dp(6))
        val boxParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        boxParams.topMargin = dp(4)
        row.addView(box, boxParams)

        val text = TextView(this)
        text.text = url
        text.typeface = Typeface.MONOSPACE
        text.setTextColor(getColor(R.color.ink))
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        text.setTextIsSelectable(true)
        box.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val copyBtn = Button(this, null, 0, R.style.BridgeButtonSmall)
        copyBtn.text = "Copia"
        copyBtn.setOnClickListener { copy(label, url) }
        val copyParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        copyParams.marginStart = dp(6)
        box.addView(copyBtn, copyParams)

        val openBtn = Button(this, null, 0, R.style.BridgeButtonSmallSecondary)
        openBtn.text = "Apri"
        openBtn.setOnClickListener { openUrl(url) }
        val openParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        openParams.marginStart = dp(6)
        box.addView(openBtn, openParams)
        return row
    }

    private fun copy(label: String, text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (cm == null) {
            log("Appunti non disponibili")
            return
        }
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, "Copiato negli appunti", Toast.LENGTH_SHORT).show()
    }

    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (t: Throwable) {
            log("Impossibile aprire $url: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

    private fun probeBluetooth() {
        if (!Printer.hasConnectPermission()) {
            ensurePermissions()
            return
        }
        if (Printer.selectedMac().isNullOrEmpty()) {
            showPicker(null)
            return
        }
        btnProbe.isEnabled = false
        thread {
            Printer.probe()
            runOnUiThread {
                btnProbe.isEnabled = true
                renderHealth()
            }
        }
    }

    // ── Intenti (fallback: pagina web che apre l'app) ────────────────────────
    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        val data = uri.schemeSpecificPart ?: intent.dataString ?: return
        if (data.isEmpty()) return
        val bytes = decode(data)
        if (bytes == null || bytes.isEmpty()) {
            log("ERRORE: payload ricevuto non valido")
            return
        }
        log("Ricevuti ${bytes.size} byte dall'app")
        pendingPayload = bytes
        if (!Printer.hasConnectPermission()) {
            ensurePermissions()
            return
        }
        if (Printer.selectedMac().isNullOrEmpty()) {
            log("Nessuna stampante scelta: apro il selettore")
            showPicker(bytes)
            return
        }
        printAsync(bytes, "browser")
    }

    private fun decode(data: String): ByteArray? {
        var body = if (data.contains(':')) data.substringAfter(':') else data
        body = body.trim()
        if (body.startsWith("base64,", ignoreCase = true)) {
            return try {
                Base64.decode(body.substring(7), Base64.DEFAULT)
            } catch (t: Throwable) {
                null
            }
        }
        return body.toByteArray(Charsets.UTF_8)
    }

    // ── Azioni ────────────────────────────────────────────────────────────────
    private fun runTest() {
        if (!Printer.hasConnectPermission()) {
            ensurePermissions()
            return
        }
        if (Printer.selectedMac().isNullOrEmpty()) {
            showPicker(null)
            return
        }
        btnTest.isEnabled = false
        thread {
            try {
                val body = apiPost("/receipt", SelfTest.testReceipt().toString())
                val ok = body.contains("\"ok\":true")
                runOnUiThread { if (ok) log("Test API: OK -> $body") else log("Test API: $body") }
            } catch (t: Throwable) {
                runOnUiThread { log("ERRORE test API: ${t.message}") }
            } finally {
                runOnUiThread { btnTest.isEnabled = true }
            }
        }
        pendingPayload = null
    }

    private fun apiPost(path: String, json: String): String {
        val conn = URL("http://127.0.0.1:${BridgeService.PORT}$path").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.connectTimeout = 5_000
        conn.readTimeout = 30_000
        try {
            conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            return stream?.bufferedReader()?.use { it.readText() } ?: ""
        } finally {
            conn.disconnect()
        }
    }

    private fun printAsync(bytes: ByteArray, source: String) {
        pendingPayload = null
        btnTest.isEnabled = false
        thread {
            Printer.print(bytes, source)
            runOnUiThread { btnTest.isEnabled = true }
        }
    }

    private fun showPicker(bytes: ByteArray?) {
        pendingPayload = bytes
        if (!Printer.hasConnectPermission()) {
            ensurePermissions()
            return
        }
        val bonded: List<BluetoothDevice> = Printer.bondedDevices()
        if (bonded.isEmpty()) {
            setStatus("Nessuna stampante", "nessun dispositivo accoppiato a Android")
            log("ERRORE: nessun dispositivo Bluetooth accoppiato")
            AlertDialog.Builder(this)
                .setTitle("Nessuna stampante accoppiata")
                .setMessage("Vai su Impostazioni, Bluetooth, accoppia la stampante termica e riprova.")
                .setPositiveButton("OK", null)
                .show()
            return
        }
        val labels = bonded.map { "${safeName(it)}\n${it.address}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Scegli la stampante")
            .setItems(labels) { _, which ->
                val dev = bonded[which]
                Printer.remember(dev.address, safeName(dev))
                log("Stampante impostata: ${safeName(dev)} [${dev.address}]")
                refreshDeviceUi()
                val p = pendingPayload
                pendingPayload = null
                when {
                    p != null -> printAsync(p, "browser")
                    pendingSelfTestPrint -> {
                        pendingSelfTestPrint = false
                        runSelfTest(true)
                    }
                    else -> setStatus("Pronto", "in attesa di stampa")
                }
            }
            .setNegativeButton("Annulla") { _, _ -> pendingSelfTestPrint = false }
            .setCancelable(false)
            .show()
    }

    private fun forgetPrinter() {
        Printer.forget()
        refreshDeviceUi()
    }

    private fun refreshDeviceUi() {
        deviceText.text = Printer.deviceLabel()
    }

    private fun refreshConfigUi() {
        val w = AppConfig.paperWidth()
        paperValueText.text = if (w >= 48) "$w colonne (80 mm)" else "$w colonne (58 mm)"
        logoStatusText.text = AppConfig.logoLabel()
    }

    private fun setPaper(chars: Int) {
        AppConfig.setPaperWidth(chars)
        refreshConfigUi()
        log("Larghezza carta: $chars colonne")
    }

    private fun askLogoUrl() {
        val input = EditText(this)
        input.hint = "https://.../logo.png"
        input.setText(AppConfig.logoValue() ?: "")
        AlertDialog.Builder(this)
            .setTitle("Logo da URL")
            .setView(input)
            .setPositiveButton("Carica") { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) logoFromUrl(url)
            }
            .setNegativeButton("Annulla", null)
            .show()
    }

    private fun logoFromUrl(url: String) {
        log("Scarico logo: $url")
        thread {
            try {
                LogoStore.downloadFromUrl(applicationContext, url)
                AppConfig.setLogo(AppConfig.MODE_URL, url)
                runOnUiThread {
                    refreshConfigUi()
                    setStatus("Pronto", "logo aggiornato")
                    log("Logo impostato da URL")
                }
            } catch (t: Throwable) {
                runOnUiThread { log("ERRORE logo: ${t.message}") }
            }
        }
    }

    private fun pickLogoFile() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
        }
        try {
            startActivityForResult(intent, REQ_LOGO)
        } catch (t: Throwable) {
            log("ERRORE apertura file: ${t.message}")
        }
    }

    private fun clearLogo() {
        AppConfig.clearLogo()
        LogoStore.delete(applicationContext)
        refreshConfigUi()
        log("Logo rimosso")
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_LOGO || resultCode != RESULT_OK) return
        val uri: Uri = data?.data ?: return
        try {
            LogoStore.saveFromUri(applicationContext) { contentResolver.openInputStream(uri) }
            AppConfig.setLogo(AppConfig.MODE_FILE, uri.toString())
            refreshConfigUi()
            log("Logo impostato da file")
        } catch (t: Throwable) {
            log("ERRORE logo file: ${t.message}")
        }
    }

    private fun setStatus(state: String, detail: String) {
        stateText.text = state
        detailText.text = detail
    }

    private fun safeName(device: BluetoothDevice): String = try {
        device.name ?: "(senza nome)"
    } catch (t: Throwable) {
        "(nome non leggibile)"
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (t: Throwable) {
        "?"
    }

    private fun ensurePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), REQ_PERM)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERM) return
        val connectGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || Printer.hasConnectPermission()
        if (connectGranted) {
            log("Permesso Bluetooth concesso")
            setStatus("Pronto", "in attesa di stampa")
            startServiceIfAllowed()
            val p = pendingPayload
            if (p != null) printAsync(p, "browser")
        } else {
            log("ERRORE: permesso Bluetooth negato")
            setStatus("Errore", "permesso Bluetooth negato")
        }
    }
}
