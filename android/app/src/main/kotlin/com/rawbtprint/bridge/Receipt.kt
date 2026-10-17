package com.rawbtprint.bridge

import android.content.Context
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object Receipt {

    private const val DEFAULT_FEED = 3
    private const val QR_MODULE = 6
    private const val QR_EC = 0x31
    private const val DATE_PATTERN_FALLBACK = "dd/MM/yyyy HH:mm"

    class Spec {
        var shop = ""
        var title = ""
        var subtitle = ""
        var code = ""
        var date = true
        var lines: MutableList<String> = mutableListOf()
        var items: MutableList<Item> = mutableListOf()
        var total = ""
        var qr = ""
        var qrText = ""
        var footer = ""
        var logo = false
        var width = AppConfig.DEFAULT_WIDTH
        var cut = true
        var feed = DEFAULT_FEED
        var printerMac: String? = null
        var labelCode: String? = null
        var labelTotal: String? = null
    }

    class Item(val desc: String, val qty: Double, val price: Double)

    fun parse(json: String): Spec {
        val o = JSONObject(json)
        val s = Spec()
        s.shop = o.optString("shop", "")
        s.title = o.optString("title", "")
        s.subtitle = o.optString("subtitle", "")
        s.code = o.optString("code", "")
        s.date = o.optBoolean("date", true)
        s.total = o.optString("total", "")
        s.qr = o.optString("qr", "")
        s.qrText = o.optString("qrText", "")
        s.footer = o.optString("footer", "")
        s.logo = o.optBoolean("logo", false)
        s.width = o.optInt("width", AppConfig.paperWidth()).coerceIn(16, 64)
        s.cut = o.optBoolean("cut", true)
        s.feed = o.optInt("feed", DEFAULT_FEED).coerceIn(0, 20)
        s.printerMac = if (o.isNull("printer")) null else o.optString("printer", null)
        o.optJSONObject("labels")?.let { l ->
            s.labelCode = if (l.isNull("code")) null else l.optString("code", null)
            s.labelTotal = if (l.isNull("total")) null else l.optString("total", null)
        }
        o.optJSONArray("lines")?.let { arr ->
            for (i in 0 until arr.length()) s.lines.add(arr.optString(i, ""))
        }
        o.optJSONArray("items")?.let { arr ->
            for (i in 0 until arr.length()) {
                val it = arr.optJSONObject(i) ?: continue
                s.items.add(
                    Item(
                        it.optString("desc", ""),
                        it.optDouble("qty", 1.0),
                        it.optDouble("price", 0.0)
                    )
                )
            }
        }
        return s
    }

    fun render(context: Context, spec: Spec): ByteArray {
        val width = spec.width
        val loc = Tr.locale()
        val p = EscPos()
        p.init().codepage(0x10)

        if (spec.logo) {
            val bmp = LogoStore.loadBitmap(context, AppConfig.paperPixels())
            if (bmp != null) {
                p.align("center")
                p.image(LogoStore.rasterize(bmp, AppConfig.paperPixels()))
                bmp.recycle()
                p.line("")
            } else {
                Printer.log(Tr.s(R.string.receipt_log_logo_missing))
            }
        }

        if (spec.shop.isNotEmpty()) {
            p.align("center").bold(true).size(2, 2).line(spec.shop).size(1, 1).bold(false)
        }
        if (spec.title.isNotEmpty()) {
            p.align("center").bold(true).size(2, 1).line(spec.title).size(1, 1).bold(false)
        }

        p.align("left").rule(width)

        if (spec.code.isNotEmpty()) p.line(codeLine(spec))
        if (spec.date) p.line(now(loc))
        if (spec.subtitle.isNotEmpty()) p.line(spec.subtitle)

        if (spec.lines.isNotEmpty() || spec.items.isNotEmpty() || spec.code.isNotEmpty() || spec.date) {
            p.rule(width)
        }

        for (l in spec.lines) p.line(l)

        var sum = 0.0
        for (it in spec.items) {
            val value = it.qty * it.price
            sum += value
            p.line(pad(it.desc, String.format(loc, "%.2f", value), width))
        }

        if (spec.items.isNotEmpty()) p.rule(width)

        val totalValue = if (spec.total.isNotEmpty()) spec.total
        else if (spec.items.isNotEmpty()) String.format(loc, "%.2f", sum)
        else ""

        if (totalValue.isNotEmpty()) {
            val totalLabel = spec.labelTotal ?: Tr.s(R.string.receipt_label_total)
            p.bold(true).size(1, 2).line(pad(totalLabel, totalValue, width)).size(1, 1).bold(false)
        }

        if (spec.qr.isNotEmpty()) {
            p.feed(1).align("center")
            p.qr(spec.qr, QR_MODULE, QR_EC)
            p.line(if (spec.qrText.isNotEmpty()) spec.qrText else spec.qr)
        } else if (spec.qrText.isNotEmpty()) {
            p.feed(1).align("center").line(spec.qrText)
        }

        if (spec.footer.isNotEmpty()) {
            p.feed(1).align("center").line(spec.footer)
        }

        p.feed(spec.feed)
        if (spec.cut) p.cut(false)
        return p.bytes()
    }

    // The label (labels.code or the resource one), one space, the number.
    private fun codeLine(spec: Spec): String {
        val label = (spec.labelCode ?: Tr.s(R.string.receipt_label_code)).trimEnd()
        return if (label.isEmpty()) spec.code else label + " " + spec.code
    }

    private fun now(loc: Locale): String {
        val pattern = Tr.s(R.string.receipt_date_pattern).ifEmpty { DATE_PATTERN_FALLBACK }
        return SimpleDateFormat(pattern, loc).format(Date())
    }

    private fun pad(left: String, right: String, width: Int): String {
        val space = width - right.length
        val l = if (space <= 1) "" else if (left.length >= space) left.take(space - 1) else left
        val filler = (space - l.length).coerceAtLeast(0)
        return l + " ".repeat(filler) + right
    }

    fun summary(spec: Spec): String =
        listOfNotNull(
            spec.shop.ifEmpty { null },
            spec.code.ifEmpty { null },
            if (spec.items.isNotEmpty()) Tr.s(R.string.receipt_summary_items, spec.items.size) else null,
            spec.qr.ifEmpty { null }
        ).joinToString(" | ").ifEmpty { Tr.s(R.string.receipt_summary_default) }
}
