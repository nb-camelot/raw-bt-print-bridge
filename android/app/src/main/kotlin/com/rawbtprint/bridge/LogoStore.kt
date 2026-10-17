package com.rawbtprint.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

object LogoStore {

    private const val FILE_NAME = "logo_custom.png"
    private const val THRESHOLD = 140
    private const val CONNECT_TIMEOUT = 10_000
    private const val READ_TIMEOUT = 15_000

    fun fileFor(context: Context): File = File(context.filesDir, FILE_NAME)

    fun loadBitmap(context: Context, pixelWidth: Int): Bitmap? = try {
        when (AppConfig.logoMode()) {
            AppConfig.MODE_ASSET -> decodeAsset(context, pixelWidth)
            AppConfig.MODE_FILE -> decodeFile(context, pixelWidth)
            AppConfig.MODE_URL -> loadFromUrl(context, pixelWidth)
            else -> null
        }
    } catch (t: Throwable) {
        Printer.log("Logo non disponibile: ${t.message}")
        null
    }

    fun downloadFromUrl(context: Context, url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT
        conn.readTimeout = READ_TIMEOUT
        conn.instanceFollowRedirects = true
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode}")
            val input: InputStream = conn.inputStream
            val target = fileFor(context)
            FileOutputStream(target).use { out ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                }
                out.flush()
            }
            input.close()
            if (!target.exists() || target.length() == 0L) throw RuntimeException("file vuoto")
            return target.absolutePath
        } finally {
            conn.disconnect()
        }
    }

    fun saveFromUri(context: Context, open: () -> InputStream?): String {
        val input = open() ?: throw RuntimeException("file non leggibile")
        val target = fileFor(context)
        input.use { inn ->
            FileOutputStream(target).use { out ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = inn.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                }
                out.flush()
            }
        }
        return target.absolutePath
    }

    fun delete(context: Context) {
        try {
            fileFor(context).delete()
        } catch (_: Throwable) {
        }
    }

    private fun loadFromUrl(context: Context, pixelWidth: Int): Bitmap? {
        val local = fileFor(context)
        if (!local.exists()) {
            val url = AppConfig.logoValue()
            if (url.isNullOrEmpty()) return null
            downloadFromUrl(context, url)
        }
        return decodeLocal(local, pixelWidth)
    }

    private fun decodeAsset(context: Context, pixelWidth: Int): Bitmap? =
        context.assets.open("logo.png").use { decodeStream(it, pixelWidth) }

    private fun decodeFile(context: Context, pixelWidth: Int): Bitmap? {
        val local = fileFor(context)
        if (!local.exists()) return null
        return decodeLocal(local, pixelWidth)
    }

    private fun decodeLocal(file: File, pixelWidth: Int): Bitmap? {
        if (!file.exists() || file.length() == 0L) return null
        return BitmapFactory.decodeFile(file.absolutePath, scaledOptions(pixelWidth))
    }

    private fun decodeStream(input: InputStream, pixelWidth: Int): Bitmap? =
        BitmapFactory.decodeStream(input, null, scaledOptions(pixelWidth))

    private fun scaledOptions(pixelWidth: Int): BitmapFactory.Options =
        BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inScaled = false
        }

    fun rasterize(bmp: Bitmap, pixelWidth: Int): ByteArray {
        val w = (pixelWidth and 0x7.inv()).coerceAtLeast(8)
        val h = (bmp.height * (w.toFloat() / bmp.width)).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(bmp, w, h, true)
        val bytesPerRow = w shr 3
        val out = ByteArrayOutputStream(bytesPerRow * h + 8)
        out.write(0x1D)
        out.write(0x76)
        out.write(0x30)
        out.write(0x00)
        out.write(bytesPerRow and 0xFF)
        out.write((bytesPerRow shr 8) and 0xFF)
        out.write(h and 0xFF)
        out.write((h shr 8) and 0xFF)
        val pixels = IntArray(w * h)
        scaled.getPixels(pixels, 0, w, 0, 0, w, h)
        for (y in 0 until h) {
            for (col in 0 until bytesPerRow) {
                var value = 0
                for (bit in 0 until 8) {
                    val p = pixels[(y * w) + (col * 8) + bit]
                    val a = (p ushr 24) and 0xFF
                    val r = (p shr 16) and 0xFF
                    val g = (p shr 8) and 0xFF
                    val bl = p and 0xFF
                    // Un pixel trasparente e carta bianca: si compone sul bianco prima della
                    // soglia, altrimenti un PNG con sfondo trasparente esce come blocco nero.
                    val lum = (0.299 * r + 0.587 * g + 0.114 * bl) * a / 255.0 + 255.0 * (255 - a) / 255.0
                    if (lum < THRESHOLD) value = value or (1 shl (7 - bit))
                }
                out.write(value)
            }
        }
        if (scaled !== bmp) scaled.recycle()
        return out.toByteArray()
    }
}
