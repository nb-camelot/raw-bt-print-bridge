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
import android.util.Base64
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
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

        findViewById<TextView>(R.id.version).text = "v" + appVersion()
        apiText.text = "Server locale attivo: http://127.0.0.1:${BridgeService.PORT}/receipt"

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
        Printer.addListener(this)
        stateText.text = Printer.lastState
        detailText.text = Printer.lastDetail
        refreshDeviceUi()
        refreshConfigUi()

        startServiceIfAllowed()
        log("App avviata. In ascolto.")

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
        Printer.addListener(this)
    }

    override fun onStop() {
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
            logText.append(line + "\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private fun log(line: String) = onLog(line)

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
            Printer.print(Printer.testPayload(), "prova")
            runOnUiThread { btnTest.isEnabled = true }
        }
        pendingPayload = null
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
