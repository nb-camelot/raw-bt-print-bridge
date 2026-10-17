package com.rawbtprint.bridge

import android.content.Context
import java.util.Locale

/**
 * User-visible text (UI, notification, log, API messages, receipt labels) comes from the
 * string resources: values/ is English, values-it/ is Italian. Android picks the language
 * of the device, or the per-app language on Android 13+ (res/xml/locales_config.xml).
 *
 * Machine-readable values (JSON keys, levels, error codes the web client compares) stay
 * literal in the code and are never translated.
 */
object Tr {

    @Volatile
    private var appContext: Context? = null

    fun init(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    /**
     * The string [id] formatted with [args] in [locale]; empty before [init] (never throws).
     * Formatting in the language of the resources, not the device's first locale, keeps
     * Latin digits: a device set to Arabic or Persian falls back to English text and must
     * not print digits that a Windows-1252 printer cannot show.
     */
    fun s(id: Int, vararg args: Any?): String {
        val ctx = appContext ?: return ""
        return try {
            val text = ctx.getString(id)
            if (args.isEmpty()) text else String.format(locale(), text, *args)
        } catch (t: Throwable) {
            // A wrong format string must not take down the server or the service.
            try {
                ctx.getString(id) + " " + args.joinToString(" ")
            } catch (_: Throwable) {
                args.joinToString(" ")
            }
        }
    }

    /** The locale of the resources being shown (en or it), for numbers and dates. */
    fun locale(): Locale {
        val ctx = appContext ?: return Locale.ENGLISH
        return try {
            Locale.forLanguageTag(ctx.getString(R.string.locale_tag))
        } catch (_: Throwable) {
            Locale.ENGLISH
        }
    }
}
