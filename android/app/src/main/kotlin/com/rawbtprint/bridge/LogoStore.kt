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

    // Maximum logo height in dots (240 = about 3 cm at 203 dpi): a square full-width logo
    // would be 5 cm tall and heavy to transmit.
    const val MAX_LOGO_ROWS = 240

    // Rows per GS v 0 command. Many Chinese firmwares read the height as a single byte:
    // with more than 255 rows they print the remaining pixels as text and commands, and hang.
    const val BAND_ROWS = 128
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
        Printer.log(Tr.s(R.string.logo_log_unavailable, t.message))
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
            if (!target.exists() || target.length() == 0L) throw RuntimeException(Tr.s(R.string.logo_error_empty_file))
            return target.absolutePath
        } finally {
            conn.disconnect()
        }
    }

    fun saveFromUri(context: Context, open: () -> InputStream?): String {
        val input = open() ?: throw RuntimeException(Tr.s(R.string.logo_error_file_unreadable))
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
        // Dimensions first: a very large logo from a URL, decoded at full resolution,
        // would take tens of MB just to print 384 dots of it.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        val opts = scaledOptions(pixelWidth)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= pixelWidth * 2 && bounds.outHeight / (sample * 2) >= MAX_LOGO_ROWS * 2) {
            sample *= 2
        }
        opts.inSampleSize = sample
        return BitmapFactory.decodeFile(file.absolutePath, opts)
    }

    private fun decodeStream(input: InputStream, pixelWidth: Int): Bitmap? =
        BitmapFactory.decodeStream(input, null, scaledOptions(pixelWidth))

    private fun scaledOptions(pixelWidth: Int): BitmapFactory.Options =
        BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inScaled = false
        }

    /**
     * Logo as an ESC/POS raster: as wide as the paper, at most [MAX_LOGO_ROWS] dots tall,
     * centered on a white background and split into GS v 0 commands of at most [BAND_ROWS] rows.
     */
    fun rasterize(bmp: Bitmap, pixelWidth: Int): ByteArray {
        val paperW = (pixelWidth and 0x7.inv()).coerceAtLeast(8)
        val srcW = bmp.width.coerceAtLeast(1)
        val srcH = bmp.height.coerceAtLeast(1)
        // Fit the logo inside paperW x MAX_LOGO_ROWS, keeping the aspect ratio.
        var w = paperW
        var h = (srcH * (w.toFloat() / srcW)).toInt().coerceAtLeast(1)
        if (h > MAX_LOGO_ROWS) {
            h = MAX_LOGO_ROWS
            w = (srcW * (h.toFloat() / srcH)).toInt().coerceIn(1, paperW)
        }
        val scaled = Bitmap.createScaledBitmap(bmp, w, h, true)
        val pixels = IntArray(w * h)
        scaled.getPixels(pixels, 0, w, 0, 0, w, h)
        if (scaled !== bmp) scaled.recycle()

        // The raster stays as wide as the paper: a narrower logo is centered with white
        // margins, without relying on the printer's alignment.
        val offset = (paperW - w) / 2
        val bytesPerRow = paperW shr 3
        val bands = (h + BAND_ROWS - 1) / BAND_ROWS
        val out = ByteArrayOutputStream(bytesPerRow * h + 8 * bands)
        var y0 = 0
        while (y0 < h) {
            val rows = minOf(BAND_ROWS, h - y0)
            out.write(0x1D)
            out.write(0x76)
            out.write(0x30)
            out.write(0x00)
            out.write(bytesPerRow and 0xFF)
            out.write((bytesPerRow shr 8) and 0xFF)
            out.write(rows and 0xFF)
            out.write((rows shr 8) and 0xFF)
            for (y in y0 until y0 + rows) {
                for (col in 0 until bytesPerRow) {
                    var value = 0
                    for (bit in 0 until 8) {
                        val sx = col * 8 + bit - offset
                        if (sx < 0 || sx >= w) continue
                        val p = pixels[y * w + sx]
                        val a = (p ushr 24) and 0xFF
                        val r = (p shr 16) and 0xFF
                        val g = (p shr 8) and 0xFF
                        val bl = p and 0xFF
                        // A transparent pixel is white paper: blend onto white before the threshold,
                        // otherwise a PNG with a transparent background prints as a black block.
                        val lum = (0.299 * r + 0.587 * g + 0.114 * bl) * a / 255.0 + 255.0 * (255 - a) / 255.0
                        if (lum < THRESHOLD) value = value or (1 shl (7 - bit))
                    }
                    out.write(value)
                }
            }
            y0 += rows
        }
        return out.toByteArray()
    }
}
