package com.rawbtprint.bridge

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Batteria e sospensione in background. Se Android ottimizza la batteria dell'app (o la
 * sospende quando non e in primo piano) il server su 127.0.0.1 accetta le connessioni ma
 * non risponde finche l'app non torna davanti: le stampe dal browser restano in attesa.
 * Verificato su LineageOS 18.1: disattivando ottimizzazione e sospensione funziona.
 *
 * Oltre alle impostazioni, conta il sintomo: se il controllo periodico del servizio si e
 * fermato con il tablet acceso (Health.lastStallAt), l'app e stata sospesa davvero.
 */
object Power {

    class State(
        val ignoringOptimizations: Boolean?,
        val backgroundRestricted: Boolean?,
        val powerSave: Boolean?,
        // "enabled" / "disabled" / "device_default" o null (mai impostata).
        val cachedAppsFreezer: String?,
        // Android 12+: false = l'app puo essere ibernata se non usata («Sospendi attivita app se non in uso»).
        val hibernationExempt: Boolean?,
    )

    // Chiave di sistema della voce "Sospendi esecuzione per app memorizzate nella cache".
    private const val FREEZER_SETTING = "cached_apps_freezer"

    // Una sospensione rilevata resta segnalata per mezz'ora.
    private const val STALL_WINDOW_MS = 30L * 60L * 1000L

    fun read(ctx: Context): State {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val ignoring = try {
            pm?.isIgnoringBatteryOptimizations(ctx.packageName)
        } catch (_: Throwable) {
            null
        }
        val restricted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                (ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.isBackgroundRestricted
            } catch (_: Throwable) {
                null
            }
        } else {
            null
        }
        val powerSave = try {
            pm?.isPowerSaveMode
        } catch (_: Throwable) {
            null
        }
        val freezer = try {
            Settings.Global.getString(ctx.contentResolver, FREEZER_SETTING)
        } catch (_: Throwable) {
            null
        }
        val hibernation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                ctx.packageManager.isAutoRevokeWhitelisted
            } catch (_: Throwable) {
                null
            }
        } else {
            null
        }
        return State(ignoring, restricted, powerSave, freezer, hibernation)
    }

    /**
     * true / false se si sa, null se dipende dal default del dispositivo. Su Android 11 il
     * default e spento; da Android 12 di solito e acceso.
     */
    fun freezerOn(s: State): Boolean? = when (s.cachedAppsFreezer) {
        "enabled" -> true
        "disabled" -> false
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) null else false
    }

    private fun stallText(): String? {
        val at = Health.lastStallAt
        if (at <= 0L || System.currentTimeMillis() - at > STALL_WINDOW_MS) return null
        return "sospensione rilevata: l'app è rimasta ferma ${Health.lastStallS} s alle ${Health.clock(at)} " +
            "con il tablet acceso"
    }

    /** Stato per il pannello, /status e l'autotest. */
    fun check(ctx: Context?): Health.Line {
        if (ctx == null) return Health.Line(Health.Level.UNKNOWN, "verifica in corso")
        val s = read(ctx)
        val problems = ArrayList<String>()
        var level = Health.Level.OK
        fun raise(l: Health.Level) {
            if (l == Health.Level.ERROR || level == Health.Level.OK) level = l
        }
        if (s.ignoringOptimizations == false) {
            raise(Health.Level.ERROR)
            problems.add("ottimizzazione batteria attiva: Android può sospendere l'app quando passi al browser")
        }
        if (s.backgroundRestricted == true) {
            raise(Health.Level.ERROR)
            problems.add("attività in background limitata per questa app")
        }
        when (freezerOn(s)) {
            true -> {
                raise(Health.Level.ERROR)
                problems.add("«Sospendi esecuzione per app memorizzate nella cache» attivo nelle Opzioni sviluppatore")
            }
            null -> {
                raise(Health.Level.WARN)
                problems.add("«Sospendi esecuzione per app memorizzate nella cache» sul valore predefinito, " +
                    "di solito attivo: disattivalo nelle Opzioni sviluppatore")
            }
            false -> {}
        }
        if (s.hibernationExempt == false) {
            raise(Health.Level.WARN)
            problems.add("«Sospendi attività app se non in uso» attivo per questa app")
        }
        if (s.powerSave == true) {
            raise(Health.Level.WARN)
            problems.add("risparmio energetico attivo")
        }
        val stall = stallText()
        if (stall != null) {
            raise(Health.Level.ERROR)
            problems.add(
                if (problems.isEmpty()) "$stall: le impostazioni sembrano a posto, controlla quelle del produttore"
                else stall
            )
        }
        if (problems.isEmpty()) {
            val known = s.ignoringOptimizations == true
            return Health.Line(
                if (known) Health.Level.OK else Health.Level.UNKNOWN,
                if (known) "ottimizzazione batteria disattivata e nessuna sospensione: l'app resta attiva in background"
                else "stato dell'ottimizzazione batteria non disponibile: controllalo nelle impostazioni dell'app"
            )
        }
        return Health.Line(level, problems.joinToString(" · "))
    }

    /** Testo del pulsante «Risolvi», coerente con il primo intent di [fixIntents]. */
    fun fixLabel(s: State): String = when {
        s.ignoringOptimizations == false -> "Risolvi: disattiva l’ottimizzazione batteria"
        s.backgroundRestricted == true -> "Risolvi: togli la limitazione in background"
        freezerOn(s) != false -> "Risolvi: apri le Opzioni sviluppatore"
        s.hibernationExempt == false -> "Risolvi: disattiva «sospendi se non in uso»"
        s.powerSave == true -> "Risolvi: disattiva il risparmio energetico"
        else -> "Apri le impostazioni dell’app"
    }

    /** Impostazioni da aprire per risolvere il primo problema trovato, con i ripieghi. */
    fun fixIntents(ctx: Context): List<Intent> {
        val s = read(ctx)
        val pkg = Uri.parse("package:" + ctx.packageName)
        val out = ArrayList<Intent>()
        when {
            s.ignoringOptimizations == false -> {
                out.add(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg))
                out.add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
            s.backgroundRestricted == true -> out.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
            freezerOn(s) != false -> out.add(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
            s.hibernationExempt == false && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ->
                out.add(Intent(Intent.ACTION_AUTO_REVOKE_PERMISSIONS, pkg))
            s.powerSave == true -> out.add(Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS))
        }
        out.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
        return out
    }
}
