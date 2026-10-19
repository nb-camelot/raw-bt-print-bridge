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
import java.util.concurrent.Executors
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

    /** [busy] is true when the request was refused because another print or probe holds the SPP link. */
    class Result(val ok: Boolean, val error: String?, val bytes: Int, val busy: Boolean = false)

    /** The selected printer is no longer bonded: print() forgets it. */
    private class NotBondedException(message: String) : IOException(message)

    private val listeners = CopyOnWriteArrayList<Listener>()
    private val printing = AtomicBoolean(false)

    // Latest log lines: available even if the Activity was not open
    // (for example the calls that arrived while the user was in Chrome).
    private val history = ArrayDeque<String>()

    @Volatile
    private var appContext: Context? = null

    // null until the first setState: lastState then shows the translated "starting" text.
    @Volatile
    private var currentState: String? = null

    val lastState: String
        get() = currentState ?: Tr.s(R.string.printer_state_starting)

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

    /** Registers the listener and atomically returns the log lines already written. */
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
        currentState = state
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
        // The last connection result was about another printer (or none).
        Health.clearPrint()
        refreshBtAsync()
    }

    fun deviceLabel(): String {
        val mac = selectedMac() ?: return Tr.s(R.string.printer_device_none)
        val name = selectedName() ?: "?"
        return "$name [$mac]"
    }

    fun forget() {
        prefs()?.edit()?.remove(KEY_DEVICE)?.remove(KEY_NAME)?.apply()
        Health.clearPrint()
        refreshBtAsync()
        log(Tr.s(R.string.printer_log_forgotten))
        setState(Tr.s(R.string.printer_state_no_printer), Tr.s(R.string.printer_detail_choose_printer))
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

    // The Bluetooth and battery checks make binder calls to system services: they run on
    // a dedicated thread, one at a time, and the result goes to Health.btLine / Health.powerLine.
    private val btRefreshing = AtomicBoolean(false)
    private val btExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "bt-check").apply { isDaemon = true }
    }

    /** Refreshes Bluetooth and battery in the background; queues nothing if a check is already running. */
    fun refreshBtAsync() {
        if (!btRefreshing.compareAndSet(false, true)) return
        try {
            btExecutor.execute {
                try {
                    Health.btLine = btCheck()
                    Health.powerLine = Power.check(appContext)
                    appContext?.let { Health.powerFixLabel = Power.fixLabel(Power.read(it)) }
                } catch (_: Throwable) {
                } finally {
                    btRefreshing.set(false)
                }
            }
        } catch (_: Throwable) {
            btRefreshing.set(false)
        }
    }

    /** Status of the Bluetooth segment without opening connections: adapter, permission, pairing. */
    fun btCheck(): Health.Line {
        val adapter = btAdapter() ?: return Health.Line(Health.Level.ERROR, Tr.s(R.string.printer_bt_unavailable))
        val enabled = try {
            adapter.isEnabled
        } catch (_: Throwable) {
            false
        }
        if (!enabled) return Health.Line(Health.Level.ERROR, Tr.s(R.string.printer_bt_off))
        if (!hasConnectPermission()) return Health.Line(Health.Level.ERROR, Tr.s(R.string.printer_bt_permission_missing))
        val mac = selectedMac()
            ?: return Health.Line(Health.Level.WARN, Tr.s(R.string.printer_bt_on_no_printer))
        val label = selectedName() ?: mac
        val bonded: Boolean? = try {
            adapter.bondedDevices?.any { it.address == mac }
        } catch (_: Throwable) {
            null
        }
        return when (bonded) {
            true -> Health.Line(Health.Level.OK, Tr.s(R.string.printer_bt_on_paired, label))
            false -> Health.Line(Health.Level.ERROR, Tr.s(R.string.printer_bt_not_paired, label))
            null -> Health.Line(Health.Level.UNKNOWN, Tr.s(R.string.printer_bt_on_pairing_unknown))
        }
    }

    /** true while a print or a Bluetooth probe is running (SPP accepts a single connection). */
    fun isBusy(): Boolean = printing.get()

    fun testPayload(): ByteArray =
        ("\u001B@" + "PRINT BRIDGE OK\n" + Tr.s(R.string.printer_test_payload_line) + "\n\n\n" + "\u001DV\u0000")
            .toByteArray(Charsets.UTF_8)

    fun print(bytes: ByteArray, source: String, macOverride: String? = null): Result {
        val mac = if (!macOverride.isNullOrEmpty()) macOverride else selectedMac()
        if (mac.isNullOrEmpty()) {
            // Not a Bluetooth fault: btCheck() already reports the "no printer chosen" state.
            setState(Tr.s(R.string.printer_state_no_printer), Tr.s(R.string.printer_detail_choose_printer))
            log(Tr.s(R.string.printer_log_error, Tr.s(R.string.printer_err_no_printer)))
            return Result(false, Tr.s(R.string.printer_err_no_printer), 0)
        }
        if (bytes.isEmpty()) {
            return Result(false, Tr.s(R.string.printer_err_empty_payload), 0)
        }
        if (!printing.compareAndSet(false, true)) {
            log(Tr.s(R.string.printer_log_busy_ignored))
            return Result(false, Tr.s(R.string.printer_err_busy), 0, busy = true)
        }

        var socket: BluetoothSocket? = null
        var error: String? = null
        var notBonded = false
        log(Tr.s(R.string.printer_log_print_start, source, mac, bytes.size))
        try {
            socket = connect(mac)
            setState(Tr.s(R.string.printer_state_printing), Tr.s(R.string.printer_detail_bytes_out, bytes.size))
            // With paced sending the time grows with the size: so does the timeout.
            val writeTimeout = maxOf(WRITE_TIMEOUT_MS, 5_000L + bytes.size.toLong() * WRITE_PAUSE_MS * 2L / WRITE_CHUNK)
            writeWithTimeout(socket.outputStream, bytes, writeTimeout)
            log(Tr.s(R.string.printer_log_bytes_sent, bytes.size))
        } catch (t: Throwable) {
            error = t.message ?: t.javaClass.simpleName
            notBonded = t is NotBondedException
        } finally {
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
            printing.set(false)
        }

        Health.btLine = btCheck()
        return if (error == null) {
            setState(Tr.s(R.string.printer_state_printed), Tr.s(R.string.printer_detail_printed, source, bytes.size))
            log(Tr.s(R.string.printer_log_print_ok))
            Health.recordPrint(true, Tr.s(R.string.printer_health_print_ok, source, bytes.size))
            Result(true, null, bytes.size)
        } else {
            setState(Tr.s(R.string.printer_state_error), error)
            log(Tr.s(R.string.printer_log_error, error))
            Health.recordPrint(false, error)
            if (notBonded ||
                error.contains("not bonded", ignoreCase = true)
            ) {
                forget()
            }
            Result(false, error, 0)
        }
    }

    /** Opens and closes the SPP connection to the chosen printer, without sending any bytes. */
    fun probe(): Result {
        val mac = selectedMac()
        if (mac.isNullOrEmpty()) {
            log(Tr.s(R.string.printer_log_probe_no_printer))
            return Result(false, Tr.s(R.string.printer_err_no_printer), 0)
        }
        if (!printing.compareAndSet(false, true)) {
            log(Tr.s(R.string.printer_log_probe_busy))
            return Result(false, Tr.s(R.string.printer_err_busy), 0, busy = true)
        }
        val t0 = System.currentTimeMillis()
        var socket: BluetoothSocket? = null
        var error: String? = null
        log(Tr.s(R.string.printer_log_probe_start, mac))
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
        Health.btLine = btCheck()
        return if (error == null) {
            setState(Tr.s(R.string.printer_state_ready), Tr.s(R.string.printer_detail_reachable, ms))
            log(Tr.s(R.string.printer_log_probe_ok, ms))
            Health.recordPrint(true, Tr.s(R.string.printer_health_probe_ok, ms))
            Result(true, null, 0)
        } else {
            setState(Tr.s(R.string.printer_state_error), error)
            log(Tr.s(R.string.printer_log_probe_failed, error))
            Health.recordPrint(false, error)
            Result(false, error, 0)
        }
    }

    private fun connect(mac: String): BluetoothSocket {
        val adapter = btAdapter() ?: throw IOException(Tr.s(R.string.printer_bt_unavailable))
        if (!adapter.isEnabled) throw IOException(Tr.s(R.string.printer_err_bt_disabled))
        try {
            adapter.cancelDiscovery()
        } catch (_: Throwable) {
        }
        val device = adapter.getRemoteDevice(mac)
        if (adapter.bondedDevices?.none { it.address == mac } == true) {
            throw NotBondedException(Tr.s(R.string.printer_err_not_paired, mac))
        }
        setState(
            Tr.s(R.string.printer_state_connecting),
            Tr.s(R.string.printer_detail_waiting_printer, CONNECT_TIMEOUT_MS / 1000)
        )
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
        log(Tr.s(R.string.printer_log_connected, safeName(device), device.address))
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
            throw IOException(Tr.s(R.string.printer_err_connect_timeout, timeoutMs / 1000))
        }
        if (done.get()) return
        val e = failure.get()
        throw IOException(
            Tr.s(
                R.string.printer_err_connect_refused,
                e?.message ?: e?.javaClass?.simpleName ?: Tr.s(R.string.printer_err_unknown)
            )
        )
    }

    // Paced sending: many cheap printers have a serial link without flow control between
    // the Bluetooth module and the CPU. A raster of many KB sent all at once fills its
    // buffer, some bytes are lost and the rest is printed as text.
    private const val WRITE_CHUNK = 256
    private const val WRITE_PAUSE_MS = 25L

    private fun writeWithTimeout(out: OutputStream, bytes: ByteArray, timeoutMs: Long) {
        val failure = AtomicReference<Throwable?>(null)
        val t = thread(name = "bt-write") {
            try {
                var off = 0
                while (off < bytes.size) {
                    val n = minOf(WRITE_CHUNK, bytes.size - off)
                    out.write(bytes, off, n)
                    out.flush()
                    off += n
                    if (off < bytes.size) Thread.sleep(WRITE_PAUSE_MS)
                }
            } catch (e: Throwable) {
                failure.set(e)
            }
        }
        t.join(timeoutMs)
        if (t.isAlive) {
            throw IOException(Tr.s(R.string.printer_err_write_timeout, timeoutMs / 1000))
        }
        val e = failure.get()
        if (e != null) throw IOException(Tr.s(R.string.printer_err_write_failed, e.message ?: e.javaClass.simpleName))
    }

    private fun safeName(device: BluetoothDevice): String = try {
        device.name ?: Tr.s(R.string.printer_device_no_name)
    } catch (t: Throwable) {
        Tr.s(R.string.printer_device_name_unreadable)
    }

    private fun btAdapter(): BluetoothAdapter? =
        (appContext?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
}
