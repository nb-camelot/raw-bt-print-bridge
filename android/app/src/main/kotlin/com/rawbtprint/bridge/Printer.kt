package com.rawbtprint.bridge

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.io.IOException
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

object Printer {

    private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private const val PREFS = "bridge"
    const val KEY_DEVICE = "mac"
    const val KEY_NAME = "name"
    const val CONNECT_TIMEOUT_MS = 8_000L
    const val WRITE_TIMEOUT_MS = 15_000L

    interface Listener {
        fun onStatus(state: String, detail: String)
        fun onLog(line: String)
    }

    class Result(val ok: Boolean, val error: String?, val bytes: Int)

    private val listeners = CopyOnWriteArrayList<Listener>()
    private val printing = AtomicBoolean(false)

    @Volatile
    private var appContext: Context? = null

    @Volatile
    var lastState: String = "Avvio"
        private set

    @Volatile
    var lastDetail: String = ""
        private set

    fun init(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    fun addListener(l: Listener) {
        if (!listeners.contains(l)) listeners.add(l)
    }

    fun removeListener(l: Listener) {
        listeners.remove(l)
    }

    fun log(msg: String) {
        val line = "[" + SimpleDateFormat("HH:mm:ss", Locale.ITALY).format(Date()) + "] " + msg
        Log.i("RawBT", msg)
        for (l in listeners) {
            try {
                l.onLog(line)
            } catch (_: Throwable) {
            }
        }
    }

    fun setState(state: String, detail: String) {
        lastState = state
        lastDetail = detail
        for (l in listeners) {
            try {
                l.onStatus(state, detail)
            } catch (_: Throwable) {
            }
        }
    }

    private fun prefs(): SharedPreferences? =
        appContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun selectedMac(): String? = prefs()?.getString(KEY_DEVICE, null)

    fun selectedName(): String? = prefs()?.getString(KEY_NAME, null)

    fun remember(mac: String, name: String?) {
        prefs()?.edit()?.putString(KEY_DEVICE, mac)?.putString(KEY_NAME, name)?.apply()
    }

    fun deviceLabel(): String {
        val mac = selectedMac() ?: return "(nessuna)"
        val name = selectedName() ?: "?"
        return "$name [$mac]"
    }

    fun forget() {
        prefs()?.edit()?.remove(KEY_DEVICE)?.remove(KEY_NAME)?.apply()
        log("Stampante dimenticata: verra richiesta alla prossima stampa")
        setState("Nessuna stampante", "scegli la stampante Bluetooth accoppiata")
    }

    fun hasConnectPermission(): Boolean =
        android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S ||
            appContext?.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    fun bondedDevices(): List<BluetoothDevice> = try {
        btAdapter()?.bondedDevices?.sortedBy { it.name ?: "" } ?: emptyList()
    } catch (t: Throwable) {
        emptyList()
    }

    fun testPayload(): ByteArray =
        ("\u001B@" + "PRINT BRIDGE OK\n" + "prova dallo smartphone\n\n\n" + "\u001DV\u0000")
            .toByteArray(Charsets.UTF_8)

    fun print(bytes: ByteArray, source: String): Result {
        val mac = selectedMac()
        if (mac.isNullOrEmpty()) {
            setState("Nessuna stampante", "scegli la stampante Bluetooth accoppiata")
            log("ERRORE: nessuna stampante selezionata")
            return Result(false, "nessuna stampante selezionata", 0)
        }
        if (bytes.isEmpty()) {
            return Result(false, "payload vuoto", 0)
        }
        if (!printing.compareAndSet(false, true)) {
            log("Stampa gia in corso: richiesta ignorata")
            return Result(false, "stampa gia in corso", 0)
        }

        var socket: BluetoothSocket? = null
        var error: String? = null
        log("--- stampa ($source) -> $mac, ${bytes.size} byte ---")
        try {
            val adapter = btAdapter() ?: throw IOException("Bluetooth non disponibile")
            if (!adapter.isEnabled) throw IOException("Bluetooth disattivato")
            try {
                adapter.cancelDiscovery()
            } catch (_: Throwable) {
            }
            val device = adapter.getRemoteDevice(mac)
            if (adapter.bondedDevices?.none { it.address == mac } == true) {
                throw IOException("Stampante $mac non piu accoppiata: raccoppiala nelle impostazioni Android")
            }
            setState("Connessione...", "in attesa della stampante (max ${CONNECT_TIMEOUT_MS / 1000}s)")
            socket = device.createInsecureRfcommSocketToServiceRecord(SPP)
            connectWithTimeout(socket, CONNECT_TIMEOUT_MS)
            log("Connesso a ${safeName(device)} [${device.address}]")
            setState("Stampo...", "${bytes.size} byte in uscita")
            writeWithTimeout(socket.outputStream, bytes, WRITE_TIMEOUT_MS)
            log("Inviati ${bytes.size} byte")
        } catch (t: Throwable) {
            error = t.message ?: t.javaClass.simpleName
        } finally {
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
            printing.set(false)
        }

        return if (error == null) {
            setState("Stampato", "$source, ${bytes.size} byte inviati")
            log("OK: stampa completata")
            Result(true, null, bytes.size)
        } else {
            setState("Errore", error)
            log("ERRORE: $error")
            if (error.contains("non piu accoppiata", ignoreCase = true) ||
                error.contains("not bonded", ignoreCase = true)
            ) {
                forget()
            }
            Result(false, error, 0)
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
            try {
                socket.close()
            } catch (_: Throwable) {
            }
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

    private fun safeName(device: BluetoothDevice): String = try {
        device.name ?: "(senza nome)"
    } catch (t: Throwable) {
        "(nome non leggibile)"
    }

    private fun btAdapter(): BluetoothAdapter? =
        (appContext?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
}
