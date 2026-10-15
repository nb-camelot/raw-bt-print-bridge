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
import android.widget.Toast
import java.util.UUID
import kotlin.concurrent.thread

class MainActivity : Activity() {

    companion object {
        private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val PREFS = "bridge"
        private const val KEY_DEVICE = "mac"
        private const val REQ_CONNECT = 4212
    }

    private var pendingPayload: ByteArray? = null
    private var forcePicker = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data
        val data = uri?.schemeSpecificPart ?: intent?.dataString
        if (uri == null || data.isNullOrEmpty()) {
            pendingPayload = testPayload()
            forcePicker = true
            proceed()
            return
        }
        val bytes = decode(data)
        if (bytes == null || bytes.isEmpty()) {
            toast("Payload non valido")
            finish()
            return
        }
        pendingPayload = bytes
        proceed()
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

    private fun proceed() {
        if (!hasConnectPermission()) {
            requestConnectPermission()
            return
        }
        val adapter = btAdapter
        if (adapter == null) {
            toast("Bluetooth non disponibile")
            finish()
            return
        }
        if (!adapter.isEnabled) {
            toast("Attiva il Bluetooth e riprova")
            try {
                startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
            } catch (_: Throwable) {
            }
            finish()
            return
        }
        val mac = prefs().getString(KEY_DEVICE, null)
        if (forcePicker || mac.isNullOrEmpty()) {
            showPicker()
            return
        }
        print(pendingPayload ?: return)
    }

    private fun print(bytes: ByteArray) {
        val mac = prefs().getString(KEY_DEVICE, null) ?: return
        val adapter = btAdapter ?: return
        toast("Invio ${bytes.size} byte...")
        thread {
            var error: String? = null
            try {
                val device = adapter.getRemoteDevice(mac)
                val socket: BluetoothSocket = device.createInsecureRfcommSocketToServiceRecord(SPP)
                socket.use {
                    try {
                        adapter.cancelDiscovery()
                    } catch (_: Throwable) {
                    }
                    it.connect()
                    it.outputStream.write(bytes)
                    it.outputStream.flush()
                }
            } catch (t: Throwable) {
                error = t.message ?: t.javaClass.simpleName
            }
            runOnUiThread {
                if (error == null) {
                    toast("Stampato (${bytes.size} byte)")
                } else {
                    toast("Errore: $error")
                    prefs().edit().remove(KEY_DEVICE).apply()
                }
                finish()
            }
        }
    }

    private fun showPicker() {
        val bonded: List<BluetoothDevice> = try {
            btAdapter?.bondedDevices?.sortedBy { it.name ?: "" } ?: emptyList()
        } catch (t: Throwable) {
            emptyList()
        }
        if (bonded.isEmpty()) {
            toast("Nessuna stampante Bluetooth accoppiata")
            finish()
            return
        }
        val labels = bonded.map { "${it.name ?: "(senza nome)"}  [${it.address}]" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Scegli la stampante")
            .setItems(labels) { _, which ->
                val dev = bonded[which]
                forcePicker = false
                prefs().edit().putString(KEY_DEVICE, dev.address).apply()
                print(pendingPayload ?: testPayload())
            }
            .setNegativeButton("Annulla") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }

    private fun testPayload(): ByteArray {
        val text = "\u001B@" + "PRINT BRIDGE OK\n\n\n" + "\u001DV\u0000"
        return text.toByteArray(Charsets.UTF_8)
    }

    private fun btAdapter(): BluetoothAdapter? =
        (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    private fun requestConnectPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), REQ_CONNECT)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CONNECT) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                proceed()
            } else {
                toast("Permesso Bluetooth negato")
                finish()
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
