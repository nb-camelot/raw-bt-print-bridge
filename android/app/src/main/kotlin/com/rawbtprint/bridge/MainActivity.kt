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
        const val PAGES_URL = "https://nb-camelot.github.io/raw-bt-print-bridge/app.html"

        // The battery warning is shown once per app launch, not every time the app comes back.
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

    // Refreshes the "Bridge status" panel every 2 s while the app is visible.
    private val healthHandler = Handler(Looper.getMainLooper())
    private val healthTick = object : Runnable {
        override fun run() {
            renderHealth()
            healthHandler.postDelayed(this, 2_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Tr.init(applicationContext)
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
            copy(getString(R.string.main_clip_log_label), Printer.history().joinToString("\n"))
        }
        findViewById<Button>(R.id.btnRestartServer).setOnClickListener {
            if (Printer.hasConnectPermission()) {
                BridgeService.restartServer(this)
            } else {
                log(getString(R.string.main_log_restart_needs_permission))
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

        // Listener, log and service start in onStart, which always follows onCreate.
        log(getString(R.string.main_log_app_started))

        handleIntent(intent)
        ensurePermissions()
    }

    private fun startServiceIfAllowed() {
        if (Printer.hasConnectPermission()) {
            BridgeService.start(this)
        } else {
            log(getString(R.string.main_log_waiting_bt_permission))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        // The log also includes what happened while the app was not visible
        // (for example the calls that came from the browser).
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

    // scrollTo, not fullScroll: fullScroll moves the focus to the log and the outer
    // ScrollView would jump to the bottom, hiding the status panel.
    private fun scrollLogToEnd() {
        logScroll.post { logScroll.scrollTo(0, logText.height) }
    }

    private fun log(line: String) = Printer.log(line)

    // ── Bridge status ────────────────────────────────────────────────────────
    private fun renderHealth() {
        Printer.refreshBtAsync()
        showHealth(healthServerDot, healthServerText, Health.server())
        showHealth(healthCallsDot, healthCallsText, Health.calls())
        showHealth(healthBtDot, healthBtText, Health.bluetooth())
        val power = Health.power()
        showHealth(healthPowerDot, healthPowerText, power)
        btnFixPower.visibility =
            if (power.level == Health.Level.ERROR || power.level == Health.Level.WARN) View.VISIBLE else View.GONE
        // The label says what it actually opens (same order as Power.fixIntents).
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

    // ── Battery and suspension ───────────────────────────────────────────────
    private fun maybeWarnAboutBattery() {
        if (powerDialogShown) return
        // Opened to print (intent from the browser): the warning waits for the next normal launch.
        if (intent?.data != null) return
        val p = Power.check(this)
        if (p.level != Health.Level.ERROR) return
        powerDialogShown = true
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.main_power_dialog_title))
            .setMessage(getString(R.string.main_power_dialog_message, p.text, getString(R.string.app_name)))
            .setPositiveButton(getString(R.string.main_fix_now)) { _, _ -> fixPower() }
            .setNegativeButton(getString(R.string.main_not_now), null)
            .show()
    }

    /** Opens the right setting for the first battery problem found. */
    private fun fixPower() {
        for (intent in Power.fixIntents(this)) {
            try {
                startActivity(intent)
                return
            } catch (_: Throwable) {
            }
        }
        log(getString(R.string.main_log_battery_settings_failed))
    }

    // ── Full self-test ───────────────────────────────────────────────────────
    private fun askSelfTest() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.main_selftest_full))
            .setMessage(getString(R.string.main_selftest_dialog_message))
            .setPositiveButton(getString(R.string.main_run)) { _, _ -> runSelfTest(false) }
            .setNeutralButton(getString(R.string.main_run_and_print)) { _, _ -> runSelfTest(true) }
            .setNegativeButton(getString(R.string.main_cancel), null)
            .show()
    }

    private fun runSelfTest(withPrint: Boolean) {
        if (withPrint && Printer.selectedMac().isNullOrEmpty()) {
            // Once a printer is chosen, the self-test with print starts again by itself.
            pendingSelfTestPrint = true
            showPicker(null)
            return
        }
        btnSelfTest.isEnabled = false
        btnSelfTest.text = getString(R.string.main_selftest_running)
        thread {
            val report = SelfTest.run(applicationContext, withPrint)
            runOnUiThread {
                btnSelfTest.isEnabled = true
                btnSelfTest.text = getString(R.string.main_selftest_full)
                renderHealth()
                if (isFinishing || isDestroyed) return@runOnUiThread
                AlertDialog.Builder(this)
                    .setTitle(report.title())
                    .setMessage(report.text())
                    .setPositiveButton(getString(R.string.main_ok), null)
                    .setNeutralButton(getString(R.string.main_copy)) { _, _ ->
                        copy(getString(R.string.main_clip_selftest_label), report.text())
                    }
                    .show()
            }
        }
    }

    // ── Test addresses ───────────────────────────────────────────────────────
    private fun buildUrlList() {
        val list = findViewById<LinearLayout>(R.id.urlList)
        list.removeAllViews()
        val base = "http://127.0.0.1:${BridgeService.PORT}"
        val version = appVersion()
        // Test builds (e.g. 1.8.0-pr3) are not on npm: for them, point to the latest version.
        val cdnVersion = if (version.contains('-') || version == "?") "latest" else version
        val urls = listOf(
            getString(R.string.main_url_test_page_app) to "$base/",
            getString(R.string.main_url_status_json) to "$base/status",
            getString(R.string.main_url_selftest_json) to "$base/selftest",
            getString(R.string.main_url_test_page_github) to PAGES_URL,
            getString(R.string.main_url_web_client) to
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
        copyBtn.text = getString(R.string.main_copy)
        copyBtn.setOnClickListener { copy(label, url) }
        val copyParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        copyParams.marginStart = dp(6)
        box.addView(copyBtn, copyParams)

        val openBtn = Button(this, null, 0, R.style.BridgeButtonSmallSecondary)
        openBtn.text = getString(R.string.main_open)
        openBtn.setOnClickListener { openUrl(url) }
        val openParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        openParams.marginStart = dp(6)
        box.addView(openBtn, openParams)
        return row
    }

    private fun copy(label: String, text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (cm == null) {
            log(getString(R.string.main_log_clipboard_unavailable))
            return
        }
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, getString(R.string.main_toast_copied), Toast.LENGTH_SHORT).show()
    }

    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (t: Throwable) {
            log(getString(R.string.main_log_open_url_failed, url, t.message ?: t.javaClass.simpleName))
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

    // ── Intents (fallback: web page that opens the app) ──────────────────────
    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        val data = uri.schemeSpecificPart ?: intent.dataString ?: return
        if (data.isEmpty()) return
        val bytes = decode(data)
        if (bytes == null || bytes.isEmpty()) {
            log(getString(R.string.main_log_invalid_payload))
            return
        }
        log(getString(R.string.main_log_received_bytes, bytes.size))
        pendingPayload = bytes
        if (!Printer.hasConnectPermission()) {
            ensurePermissions()
            return
        }
        if (Printer.selectedMac().isNullOrEmpty()) {
            log(getString(R.string.main_log_no_printer_open_picker))
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

    // ── Actions ───────────────────────────────────────────────────────────────
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
                runOnUiThread {
                    if (ok) {
                        log(getString(R.string.main_log_test_api_ok, body))
                    } else {
                        log(getString(R.string.main_log_test_api, body))
                    }
                }
            } catch (t: Throwable) {
                runOnUiThread { log(getString(R.string.main_log_test_api_error, t.message.toString())) }
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
            setStatus(getString(R.string.main_state_no_printer), getString(R.string.main_detail_no_paired_device))
            log(getString(R.string.main_log_no_paired_device))
            AlertDialog.Builder(this)
                .setTitle(getString(R.string.main_no_paired_printer_title))
                .setMessage(getString(R.string.main_no_paired_printer_message))
                .setPositiveButton(getString(R.string.main_ok), null)
                .show()
            return
        }
        val labels = bonded.map { "${safeName(it)}\n${it.address}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.main_choose_printer_title))
            .setItems(labels) { _, which ->
                val dev = bonded[which]
                Printer.remember(dev.address, safeName(dev))
                log(getString(R.string.main_log_printer_set, safeName(dev), dev.address))
                refreshDeviceUi()
                val p = pendingPayload
                pendingPayload = null
                when {
                    p != null -> printAsync(p, "browser")
                    pendingSelfTestPrint -> {
                        pendingSelfTestPrint = false
                        runSelfTest(true)
                    }
                    else -> setStatus(getString(R.string.main_state_ready), getString(R.string.main_detail_waiting_print))
                }
            }
            .setNegativeButton(getString(R.string.main_cancel)) { _, _ -> pendingSelfTestPrint = false }
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
        paperValueText.text =
            if (w >= 48) getString(R.string.main_paper_80, w) else getString(R.string.main_paper_58, w)
        logoStatusText.text = AppConfig.logoLabel()
    }

    private fun setPaper(chars: Int) {
        AppConfig.setPaperWidth(chars)
        refreshConfigUi()
        log(getString(R.string.main_log_paper_width, chars))
    }

    private fun askLogoUrl() {
        val input = EditText(this)
        input.hint = "https://.../logo.png"
        input.setText(AppConfig.logoValue() ?: "")
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.main_logo_url_title))
            .setView(input)
            .setPositiveButton(getString(R.string.main_load)) { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) logoFromUrl(url)
            }
            .setNegativeButton(getString(R.string.main_cancel), null)
            .show()
    }

    private fun logoFromUrl(url: String) {
        log(getString(R.string.main_log_downloading_logo, url))
        thread {
            try {
                LogoStore.downloadFromUrl(applicationContext, url)
                AppConfig.setLogo(AppConfig.MODE_URL, url)
                runOnUiThread {
                    refreshConfigUi()
                    setStatus(getString(R.string.main_state_ready), getString(R.string.main_detail_logo_updated))
                    log(getString(R.string.main_log_logo_set_url))
                }
            } catch (t: Throwable) {
                runOnUiThread { log(getString(R.string.main_log_logo_error, t.message.toString())) }
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
            log(getString(R.string.main_log_file_open_error, t.message.toString()))
        }
    }

    private fun clearLogo() {
        AppConfig.clearLogo()
        LogoStore.delete(applicationContext)
        refreshConfigUi()
        log(getString(R.string.main_log_logo_removed))
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
            log(getString(R.string.main_log_logo_set_file))
        } catch (t: Throwable) {
            log(getString(R.string.main_log_logo_file_error, t.message.toString()))
        }
    }

    private fun setStatus(state: String, detail: String) {
        stateText.text = state
        detailText.text = detail
    }

    private fun safeName(device: BluetoothDevice): String = try {
        device.name ?: getString(R.string.main_device_no_name)
    } catch (t: Throwable) {
        getString(R.string.main_device_name_unreadable)
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
            log(getString(R.string.main_log_bt_permission_granted))
            setStatus(getString(R.string.main_state_ready), getString(R.string.main_detail_waiting_print))
            startServiceIfAllowed()
            val p = pendingPayload
            if (p != null) printAsync(p, "browser")
        } else {
            log(getString(R.string.main_log_bt_permission_denied))
            setStatus(getString(R.string.main_state_error), getString(R.string.main_detail_bt_permission_denied))
        }
    }
}
