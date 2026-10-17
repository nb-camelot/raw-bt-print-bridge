package com.rawbtprint.bridge

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothDevice
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : Activity(), Printer.Listener {

    companion object {
        private const val REQ_PERM = 4212
        private const val REQ_LOGO = 4213
    }

    private var pendingPayload: ByteArray? = null

    private lateinit var deviceText: TextView
    private lateinit var stateText: TextView
    private lateinit var detailText: TextView
    private lateinit var apiText: TextView
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
        apiText = findViewById(R.id.api)
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

        findViewById<TextView>(R.id.version).text = "v" + appVersion()
        apiText.text = "Pagina di test: apri http://127.0.0.1:${BridgeService.PORT}/ in Chrome"

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
    }

    private fun showHealth(dot: TextView, text: TextView, line: Health.Line) {
        val color = when (line.level) {
            Health.Level.OK -> 0xFF2E7D32.toInt()
            Health.Level.WARN -> 0xFFF9A825.toInt()
            Health.Level.ERROR -> 0xFFC62828.toInt()
            Health.Level.UNKNOWN -> 0xFF90A4AE.toInt()
        }
        dot.setTextColor(color)
        text.text = line.text
    }

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
                val body = apiPost("/receipt", testSpec().toString())
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

    private fun testSpec(): JSONObject {
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
        spec.put("qr", "https://github.com/nb-camelot/raw-bt-print-bridge")
        spec.put("qrText", "raw-bt-print-bridge")
        spec.put("footer", "Test completato")
        spec.put("logo", AppConfig.logoMode() != AppConfig.MODE_NONE)
        spec.put("cut", true)
        return spec
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
                if (p != null) printAsync(p, "browser") else setStatus("Pronto", "in attesa di stampa")
            }
            .setNegativeButton("Annulla", null)
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
