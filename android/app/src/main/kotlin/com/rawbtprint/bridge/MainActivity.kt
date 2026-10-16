package com.rawbtprint.bridge

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import java.io.IOException
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class MainActivity : Activity() {

    companion object {
        private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val PREFS = "bridge"
        private const val KEY_DEVICE = "mac"
        private const val KEY_NAME = "name"
        private const val REQ_CONNECT = 4212
        private const val CONNECT_TIMEOUT_MS = 8_000L
        private const val WRITE_TIMEOUT_MS = 15_000L
    }

    private var pendingPayload: ByteArray? = null
    private var pendingSource: String = "browser"
    private val printing = AtomicBoolean(false)

    private lateinit var deviceText: TextView
    private lateinit var stateText: TextView
    private lateinit var detailText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var btnTest: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        deviceText = findViewById(R.id.device)
        stateText = findViewById(R.id.state)
        detailText = findViewById(R.id.detail)
        logText = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)
        btnTest = findViewById(R.id.btnTest)

        findViewById<TextView>(R.id.version).text = "v" + appVersion() + "  ·  scheme rawbtprint"
        findViewById<Button>(R.id.btnPick).setOnClickListener { showPicker() }
        findViewById<Button>(R.id.btnTest).setOnClickListener { printJob(testPayload(), "prova") }
        findViewById<Button>(R.id.btnForget).setOnClickListener { forgetPrinter() }
        findViewById<Button>(R.id.btnBack).setOnClickListener { finish() }

        refreshDeviceUi()
        log("App avviata. In ascolto.")
        handleIntent(intent)
        ensurePermission()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data
        val data = uri?.schemeSpecificPart ?: intent?.dataString
        if (uri == null || data.isNullOrEmpty()) return
        val bytes = decode(data)
        if (bytes == null || bytes.isEmpty()) {
            setState("Errore", "payload vuoto o non valido")
            log("ERRORE: payload ricevuto non valido")
            return
        }
        pendingPayload = bytes
        pendingSource = "browser"
        log("Ricevuti ${bytes.size} byte dal browser")
        if (!hasConnectPermission()) {
            setState("Permesso richiesto", "concedi l'accesso Bluetooth e riprova")
            return
        }
        processPending()
    }

    private fun processPending() {
        val bytes = pendingPayload ?: return
        pendingPayload = null
        if (prefs().getString(KEY_DEVICE, null).isNullOrEmpty()) {
            log("Nessuna stampante scelta: apro il selettore")
            showPicker(bytes)
            return
        }
        printJob(bytes, pendingSource)
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

    private fun printJob(bytes: ByteArray, source: String) {
        val mac = prefs().getString(KEY_DEVICE, null)
        if (mac.isNullOrEmpty()) {
            setState("Nessuna stampante", "scegli la stampante Bluetooth accoppiata")
            showPicker(bytes)
            return
        }
        if (!printing.compareAndSet(false, true)) {
            log("Stampa già in corso: richiesta ignorata")
            return
        }
        btnTest.isEnabled = false
        setState("Connessione...", "apertura socket SPP verso $mac")
        log("--- nuova stampa ($source) → $mac, ${bytes.size} byte ---")

        thread {
            var socket: BluetoothSocket? = null
            var error: String? = null
            try {
                val adapter = btAdapter() ?: throw IOException("Bluetooth non disponibile")
                if (!adapter.isEnabled) throw IOException("Bluetooth disattivato")
                try { adapter.cancelDiscovery() } catch (_: Throwable) {}
                val device = adapter.getRemoteDevice(mac)
                if (adapter.bondedDevices?.none { it.address == mac } == true) {
                    throw IOException("Stampante $mac non più accoppiata: raccoppiala dalle impostazioni Android")
                }
                runOnUiThread { setState("Connessione...", "in attesa della stampante (max ${CONNECT_TIMEOUT_MS / 1000}s)") }
                socket = device.createInsecureRfcommSocketToServiceRecord(SPP)
                connectWithTimeout(socket, CONNECT_TIMEOUT_MS)
                log("Connesso a ${safeName(device)} [${device.address}]")
                runOnUiThread { setState("Stampo...", "${bytes.size} byte in uscita") }
                writeWithTimeout(socket.outputStream, bytes, WRITE_TIMEOUT_MS)
                log("Inviati ${bytes.size} byte")
            } catch (t: Throwable) {
                error = t.message ?: t.javaClass.simpleName
            } finally {
                try { socket?.close() } catch (_: Throwable) {}
                try { socket?.outputStream?.close() } catch (_: Throwable) {}
                printing.set(false)
            }
            runOnUiThread {
                btnTest.isEnabled = true
                if (error == null) {
                    setState("Stampato", "$source · ${bytes.size} byte inviati")
                    log("OK: stampa completata")
                } else {
                    setState("Errore", error)
                    log("ERRORE: $error")
                    if (error.contains("non più accoppiata", ignoreCase = true) ||
                        error.contains("not bonded", ignoreCase = true)
                    ) {
                        forgetPrinter()
                    }
                }
            }
        }
    }

    private fun connectWithTimeout(socket: BluetoothSocket, timeoutMs: Long) {
        val done = AtomicBoolean(false)
        val t = thread {
            try {
                socket.connect()
                done.set(true)
            } catch (_: Throwable) {
            }
        }
        t.join(timeoutMs)
        if (!done.get()) {
            try { socket.close() } catch (_: Throwable) {}
            t.join(1_000)
            throw IOException(
                "Timeout connessione dopo ${timeoutMs / 1000}s. " +
                    "La stampante SPP ammette una sola connessione alla volta: " +
                    "libera COM9 sul PC o chiudi l'app precedentemente usata."
            )
        }
    }

    private fun writeWithTimeout(out: OutputStream, bytes: ByteArray, timeoutMs: Long) {
        val t = thread {
            try {
                out.write(bytes)
                out.flush()
            } catch (_: Throwable) {
            }
        }
        t.join(timeoutMs)
        if (t.isAlive) {
            throw IOException("Timeout in scrittura dopo ${timeoutMs / 1000}s (carta esaurita?)")
        }
    }

    private fun showPicker(bytes: ByteArray? = null) {
        if (!hasConnectPermission()) { ensurePermission(); return }
        val bonded: List<BluetoothDevice> = try {
            btAdapter()?.bondedDevices?.sortedBy { it.name ?: "" } ?: emptyList()
        } catch (t: Throwable) {
            emptyList()
        }
        if (bonded.isEmpty()) {
            setState("Nessuna stampante", "nessun dispositivo accoppiato a Android")
            log("ERRORE: nessun dispositivo Bluetooth accoppiato")
            AlertDialog.Builder(this)
                .setTitle("Nessuna stampante accoppiata")
                .setMessage("Vai su Impostazioni → Bluetooth, accoppia la stampante termica e poi premi Scegli stampante.")
                .setPositiveButton("OK", null)
                .show()
            return
        }
        val labels = bonded.map { "${safeName(it)}\n${it.address}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Scegli la stampante")
            .setItems(labels) { _, which ->
                val dev = bonded[which]
                prefs().edit().putString(KEY_DEVICE, dev.address).putString(KEY_NAME, dev.name).apply()
                log("Stampante impostata: ${safeName(dev)} [${dev.address}]")
                refreshDeviceUi()
                if (bytes != null) printJob(bytes, pendingSource) else setState("Pronto", "in attesa di stampa")
            }
            .setNegativeButton("Annulla", null)
            .setCancelable(false)
            .show()
    }

    private fun forgetPrinter() {
        prefs().edit().remove(KEY_DEVICE).remove(KEY_NAME).apply()
        log("Stampante dimenticata: al prossimo print verrai chiesto di risceltela")
        refreshDeviceUi()
        setState("Nessuna stampante", "scegli la stampante Bluetooth accoppiata")
    }

    private fun refreshDeviceUi() {
        val mac = prefs().getString(KEY_DEVICE, null)
        val name = prefs().getString(KEY_NAME, null)
        deviceText.text = if (mac.isNullOrEmpty()) "nessuna" else "$name  [$mac]"
    }

    private fun setState(title: String, detail: String) {
        stateText.text = title
        detailText.text = detail
    }

    private fun log(msg: String) {
        val ts = SimpleDateFormat("HH:mm:ss", Locale.ITALY).format(Date())
        logText.append("[$ts] $msg\n")
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun testPayload(): ByteArray =
        ("\u001B@" + "PRINT BRIDGE OK\n" + "prova dallo smartphone\n\n\n" + "\u001DV\u0000")
            .toByteArray(Charsets.UTF_8)

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

    private fun btAdapter(): BluetoothAdapter? =
        (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    private fun ensurePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasConnectPermission()) {
            setState("Permesso richiesto", "concedi l'accesso Bluetooth per vedere le stampanti")
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), REQ_CONNECT)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CONNECT) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            log("Permesso Bluetooth concesso")
            setState("Pronto", "in attesa di stampa")
            processPending()
        } else {
            log("ERRORE: permesso Bluetooth negato")
            setState("Errore", "permesso Bluetooth negato")
        }
    }
}
