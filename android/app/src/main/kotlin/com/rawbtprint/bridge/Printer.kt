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
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

object Printer {

    private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private const val PREFS = "bridge"
    const val KEY_DEVICE = "mac"
    const val KEY_NAME = "name"
    const val CONNECT_TIMEOUT_MS = 8_000L
    const val WRITE_TIMEOUT_MS = 15_000L
    private const val HISTORY_MAX = 300

    interface Listener {
        fun onStatus(state: String, detail: String)
        fun onLog(line: String)
    }

    class Result(val ok: Boolean, val error: String?, val bytes: Int)

    private val listeners = CopyOnWriteArrayList<Listener>()
    private val printing = AtomicBoolean(false)

    // Ultime righe di registro: restano disponibili anche se l'Activity non era aperta
    // (per esempio le chiamate arrivate mentre l'utente era in Chrome).
    private val history = ArrayDeque<String>()

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

    fun context(): Context? = appContext

    fun addListener(l: Listener) {
        if (!listeners.contains(l)) listeners.add(l)
    }

    /** Registra il listener e restituisce, in modo atomico, le righe di registro gia scritte. */
    fun addListenerWithHistory(l: Listener): List<String> = synchronized(history) {
        if (!listeners.contains(l)) listeners.add(l)
        history.toList()
    }

    fun removeListener(l: Listener) {
        listeners.remove(l)
    }

    fun history(): List<String> = synchronized(history) { history.toList() }

    fun log(msg: String) {
        val line = "[" + SimpleDateFormat("HH:mm:ss", Locale.ITALY).format(Date()) + "] " + msg
        Log.i("RawBT", msg)
        val targets = synchronized(history) {
            history.addLast(line)
            while (history.size > HISTORY_MAX) history.removeFirst()
            listeners.toList()
        }
        for (l in targets) {
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

    /** Stato del tratto Bluetooth senza aprire connessioni: adattatore, permesso, accoppiamento. */
    fun btCheck(): Health.Line {
        val adapter = btAdapter() ?: return Health.Line(Health.Level.ERROR, "Bluetooth non disponibile")
        val enabled = try {
            adapter.isEnabled
        } catch (_: Throwable) {
            false
        }
        if (!enabled) return Health.Line(Health.Level.ERROR, "Bluetooth spento")
        if (!hasConnectPermission()) return Health.Line(Health.Level.ERROR, "permesso Bluetooth mancante")
        val mac = selectedMac()
            ?: return Health.Line(Health.Level.WARN, "Bluetooth acceso · nessuna stampante scelta")
        val label = selectedName() ?: mac
        val bonded: Boolean? = try {
            adapter.bondedDevices?.any { it.address == mac }
        } catch (_: Throwable) {
            null
        }
        return when (bonded) {
            true -> Health.Line(Health.Level.OK, "Bluetooth acceso · $label accoppiata")
            false -> Health.Line(Health.Level.ERROR, "$label non piu accoppiata: raccoppiala in Android")
            null -> Health.Line(Health.Level.UNKNOWN, "Bluetooth acceso · accoppiamento non verificabile")
        }
    }

    fun testPayload(): ByteArray =
        ("\u001B@" + "PRINT BRIDGE OK\n" + "prova dallo smartphone\n\n\n" + "\u001DV\u0000")
            .toByteArray(Charsets.UTF_8)

    fun print(bytes: ByteArray, source: String, macOverride: String? = null): Result {
        val mac = if (!macOverride.isNullOrEmpty()) macOverride else selectedMac()
        if (mac.isNullOrEmpty()) {
            setState("Nessuna stampante", "scegli la stampante Bluetooth accoppiata")
            log("ERRORE: nessuna stampante selezionata")
            Health.recordPrint(false, "nessuna stampante selezionata")
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
            socket = connect(mac)
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
            Health.recordPrint(true, "stampa $source, ${bytes.size} byte")
            Result(true, null, bytes.size)
        } else {
            setState("Errore", error)
            log("ERRORE: $error")
            Health.recordPrint(false, error)
            if (error.contains("non piu accoppiata", ignoreCase = true) ||
                error.contains("not bonded", ignoreCase = true)
            ) {
                forget()
            }
            Result(false, error, 0)
        }
    }

    /** Apre e chiude la connessione SPP con la stampante scelta, senza inviare byte. */
    fun probe(): Result {
        val mac = selectedMac()
        if (mac.isNullOrEmpty()) {
            log("Prova Bluetooth: nessuna stampante scelta")
            Health.recordPrint(false, "nessuna stampante scelta")
            return Result(false, "nessuna stampante selezionata", 0)
        }
        if (!printing.compareAndSet(false, true)) {
            log("Prova Bluetooth: stampa in corso, riprova tra poco")
            return Result(false, "stampa gia in corso", 0)
        }
        val t0 = System.currentTimeMillis()
        var socket: BluetoothSocket? = null
        var error: String? = null
        log("--- prova Bluetooth -> $mac ---")
        try {
            socket = connect(mac)
        } catch (t: Throwable) {
            error = t.message ?: t.javaClass.simpleName
        } finally {
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
            printing.set(false)
        }
        val ms = System.currentTimeMillis() - t0
        return if (error == null) {
            setState("Pronto", "stampante raggiungibile (connessione in $ms ms)")
            log("Prova Bluetooth OK: connessione in $ms ms")
            Health.recordPrint(true, "connessione in $ms ms, nessun byte inviato")
            Result(true, null, 0)
        } else {
            setState("Errore", error)
            log("Prova Bluetooth FALLITA: $error")
            Health.recordPrint(false, error)
            Result(false, error, 0)
        }
    }

    private fun connect(mac: String): BluetoothSocket {
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
        val socket = device.createInsecureRfcommSocketToServiceRecord(SPP)
        try {
            connectWithTimeout(socket, CONNECT_TIMEOUT_MS)
        } catch (t: Throwable) {
            try {
                socket.close()
            } catch (_: Throwable) {
            }
            throw t
        }
        log("Connesso a ${safeName(device)} [${device.address}]")
        return socket
    }

    private fun connectWithTimeout(socket: BluetoothSocket, timeoutMs: Long) {
        val done = AtomicBoolean(false)
        val failure = AtomicReference<Throwable?>(null)
        val t = thread(name = "bt-connect") {
            try {
                socket.connect()
                done.set(true)
            } catch (e: Throwable) {
                failure.set(e)
            }
        }
        t.join(timeoutMs)
        if (done.get()) return
        if (t.isAlive) {
            try {
                socket.close()
            } catch (_: Throwable) {
            }
            t.join(1_000)
            throw IOException(
                "Timeout connessione dopo ${timeoutMs / 1000}s: stampante spenta, fuori portata " +
                    "o gia connessa a un altro dispositivo (la SPP accetta una sola connessione)"
            )
        }
        if (done.get()) return
        val e = failure.get()
        throw IOException("Connessione rifiutata: " + (e?.message ?: e?.javaClass?.simpleName ?: "errore sconosciuto"))
    }

    private fun writeWithTimeout(out: OutputStream, bytes: ByteArray, timeoutMs: Long) {
        val failure = AtomicReference<Throwable?>(null)
        val t = thread(name = "bt-write") {
            try {
                out.write(bytes)
                out.flush()
            } catch (e: Throwable) {
                failure.set(e)
            }
        }
        t.join(timeoutMs)
        if (t.isAlive) {
            throw IOException("Timeout in scrittura dopo ${timeoutMs / 1000}s (carta esaurita?)")
        }
        val e = failure.get()
        if (e != null) throw IOException("Scrittura fallita: " + (e.message ?: e.javaClass.simpleName))
    }

    private fun safeName(device: BluetoothDevice): String = try {
        device.name ?: "(senza nome)"
    } catch (t: Throwable) {
        "(nome non leggibile)"
    }

    private fun btAdapter(): BluetoothAdapter? =
        (appContext?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
}
