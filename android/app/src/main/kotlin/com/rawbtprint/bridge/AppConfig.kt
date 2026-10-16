package com.rawbtprint.bridge

import android.content.Context
import android.content.SharedPreferences

object AppConfig {

    private const val PREFS = "bridge"
    private const val KEY_PAPER = "paperWidth"
    private const val KEY_LOGO_MODE = "logoMode"
    private const val KEY_LOGO_VALUE = "logoValue"

    const val DEFAULT_WIDTH = 32
    const val MODE_NONE = "none"
    const val MODE_ASSET = "asset"
    const val MODE_FILE = "file"
    const val MODE_URL = "url"

    @Volatile
    private var appContext: Context? = null

    fun init(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    private fun prefs(): SharedPreferences? =
        appContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun paperWidth(): Int = prefs()?.getInt(KEY_PAPER, DEFAULT_WIDTH) ?: DEFAULT_WIDTH

    fun paperPixels(): Int = paperWidth() * 12

    fun setPaperWidth(chars: Int) {
        prefs()?.edit()?.putInt(KEY_PAPER, chars.coerceIn(16, 64))?.apply()
    }

    fun logoMode(): String = prefs()?.getString(KEY_LOGO_MODE, MODE_NONE) ?: MODE_NONE

    fun logoValue(): String? = prefs()?.getString(KEY_LOGO_VALUE, null)

    fun setLogo(mode: String, value: String?) {
        prefs()?.edit()
            ?.putString(KEY_LOGO_MODE, mode)
            ?.putString(KEY_LOGO_VALUE, value)
            ?.apply()
    }

    fun clearLogo() {
        prefs()?.edit()?.remove(KEY_LOGO_MODE)?.remove(KEY_LOGO_VALUE)?.apply()
    }

    fun logoLabel(): String = when (logoMode()) {
        MODE_NONE -> "nessuno"
        MODE_ASSET -> "logo incluso nell'app"
        MODE_FILE -> "file: " + (logoValue()?.substringAfterLast('/') ?: "?")
        MODE_URL -> "url: " + (logoValue() ?: "?")
        else -> logoMode()
    }
}
