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
 */
object Power {

    class State(
        val ignoringOptimizations: Boolean?,
        val backgroundRestricted: Boolean?,
        val powerSave: Boolean?,
        val cachedAppsFreezer: String?,
    )

    // Chiave di sistema della voce "Sospendi esecuzione per app memorizzate nella cache".
    private const val FREEZER_SETTING = "cached_apps_freezer"

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
        return State(ignoring, restricted, powerSave, freezer)
    }

    /** Stato per il pannello, /status e l'autotest. */
    fun check(ctx: Context?): Health.Line {
        if (ctx == null) return Health.Line(Health.Level.UNKNOWN, "verifica in corso")
        val s = read(ctx)
        val problems = ArrayList<String>()
        var level = Health.Level.OK
        if (s.ignoringOptimizations == false) {
            level = Health.Level.ERROR
            problems.add("ottimizzazione batteria attiva: Android può sospendere l'app quando passi al browser")
        }
        if (s.backgroundRestricted == true) {
            level = Health.Level.ERROR
            problems.add("attività in background limitata per questa app")
        }
        if (s.cachedAppsFreezer == "enabled") {
            level = Health.Level.ERROR
            problems.add("«Sospendi esecuzione per app memorizzate nella cache» attivo nelle Opzioni sviluppatore")
        }
        if (s.powerSave == true) {
            if (level == Health.Level.OK) level = Health.Level.WARN
            problems.add("risparmio energetico attivo")
        }
        if (problems.isEmpty()) {
            val known = s.ignoringOptimizations == true
            return Health.Line(
                if (known) Health.Level.OK else Health.Level.UNKNOWN,
                if (known) "ottimizzazione batteria disattivata: l'app resta attiva in background"
                else "stato dell'ottimizzazione batteria non disponibile"
            )
        }
        return Health.Line(level, problems.joinToString(" · "))
    }

    /** Impostazioni da aprire per risolvere il primo problema trovato, in ordine di utilita. */
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
            s.cachedAppsFreezer == "enabled" -> out.add(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
            s.powerSave == true -> out.add(Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS))
        }
        out.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
        return out
    }
}
