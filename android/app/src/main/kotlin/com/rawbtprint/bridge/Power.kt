package com.rawbtprint.bridge

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Battery and background suspension. If Android optimizes the app's battery use (or
 * suspends it when it is not in the foreground), the server on 127.0.0.1 accepts connections
 * but does not answer until the app is back in front: browser prints are left waiting.
 * Verified on LineageOS 18.1: it works once optimization and suspension are turned off.
 *
 * Besides the settings, the symptom counts: if the service's periodic check stopped
 * while the tablet was on (Health.lastStallAt), the app really was suspended.
 */
object Power {

    class State(
        val ignoringOptimizations: Boolean?,
        val backgroundRestricted: Boolean?,
        val powerSave: Boolean?,
        // "enabled" / "disabled" / "device_default" or null (never set).
        val cachedAppsFreezer: String?,
        // Android 12+: false = the app can be hibernated when unused ("Pause app activity if unused").
        val hibernationExempt: Boolean?,
    )

    // System key of the "Suspend execution for cached apps" setting.
    private const val FREEZER_SETTING = "cached_apps_freezer"

    // A detected suspension stays reported for half an hour.
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
     * true / false when known, null when it depends on the device default. On Android 11 the
     * default is off; from Android 12 it is usually on.
     */
    fun freezerOn(s: State): Boolean? = when (s.cachedAppsFreezer) {
        "enabled" -> true
        "disabled" -> false
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) null else false
    }

    private fun stallText(): String? {
        val at = Health.lastStallAt
        if (at <= 0L || System.currentTimeMillis() - at > STALL_WINDOW_MS) return null
        return Tr.s(R.string.power_stall_detected, Health.lastStallS, Health.clock(at))
    }

    /** Status for the panel, /status and the self-test. */
    fun check(ctx: Context?): Health.Line {
        if (ctx == null) return Health.Line(Health.Level.UNKNOWN, Tr.s(R.string.power_checking))
        val s = read(ctx)
        val problems = ArrayList<String>()
        var level = Health.Level.OK
        fun raise(l: Health.Level) {
            if (l == Health.Level.ERROR || level == Health.Level.OK) level = l
        }
        if (s.ignoringOptimizations == false) {
            raise(Health.Level.ERROR)
            problems.add(Tr.s(R.string.power_optimization_on))
        }
        if (s.backgroundRestricted == true) {
            raise(Health.Level.ERROR)
            problems.add(Tr.s(R.string.power_background_restricted))
        }
        when (freezerOn(s)) {
            true -> {
                raise(Health.Level.ERROR)
                problems.add(Tr.s(R.string.power_freezer_on))
            }
            null -> {
                raise(Health.Level.WARN)
                problems.add(Tr.s(R.string.power_freezer_default))
            }
            false -> {}
        }
        if (s.hibernationExempt == false) {
            raise(Health.Level.WARN)
            problems.add(Tr.s(R.string.power_hibernation_on))
        }
        if (s.powerSave == true) {
            raise(Health.Level.WARN)
            problems.add(Tr.s(R.string.power_saver_on))
        }
        val stall = stallText()
        if (stall != null) {
            raise(Health.Level.ERROR)
            problems.add(
                if (problems.isEmpty()) Tr.s(R.string.power_stall_settings_ok, stall)
                else stall
            )
        }
        if (problems.isEmpty()) {
            val known = s.ignoringOptimizations == true
            return Health.Line(
                if (known) Health.Level.OK else Health.Level.UNKNOWN,
                if (known) Tr.s(R.string.power_ok)
                else Tr.s(R.string.power_unknown)
            )
        }
        return Health.Line(level, problems.joinToString(" · "))
    }

    /** Text of the "Fix" button, matching the first intent of [fixIntents]. */
    fun fixLabel(s: State): String = when {
        s.ignoringOptimizations == false -> Tr.s(R.string.power_fix_optimization)
        s.backgroundRestricted == true -> Tr.s(R.string.power_fix_restriction)
        freezerOn(s) != false -> Tr.s(R.string.power_fix_developer)
        s.hibernationExempt == false -> Tr.s(R.string.power_fix_hibernation)
        s.powerSave == true -> Tr.s(R.string.power_fix_saver)
        else -> Tr.s(R.string.power_open_app_settings)
    }

    /** Settings to open to fix the first problem found, with fallbacks. */
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
