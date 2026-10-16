package com.rawbtprint.bridge

class EscPos {

    private val b = ArrayList<Int>(4096)

    fun raw(vararg xs: Int): EscPos {
        for (x in xs) b.add(x and 0xFF)
        return this
    }

    fun init(): EscPos = raw(0x1B, 0x40)

    fun codepage(n: Int): EscPos = raw(0x1B, 0x74, n)

    fun align(a: String): EscPos = raw(0x1B, 0x61, when (a) {
        "center" -> 1
        "right" -> 2
        else -> 0
    })

    fun bold(on: Boolean): EscPos = raw(0x1B, 0x45, if (on) 1 else 0)

    fun underline(on: Boolean): EscPos = raw(0x1B, 0x2D, if (on) 1 else 0)

    fun size(w: Int = 1, h: Int = 1): EscPos =
        raw(0x1B, 0x21, ((w.coerceIn(1, 8) - 1) shl 4) or (h.coerceIn(1, 8) - 1))

    fun text(s: String): EscPos {
        for (x in encode(s)) b.add(x)
        return this
    }

    fun line(s: String): EscPos = text(s).raw(0x0A)

    fun feed(n: Int = 1): EscPos = raw(0x1B, 0x64, n)

    fun cut(partial: Boolean = false): EscPos =
        if (partial) raw(0x1D, 0x56, 0x42, 0x00) else raw(0x1D, 0x56, 0x00)

    fun rule(width: Int): EscPos = line("-".repeat(width.coerceAtLeast(1)))

    fun qr(data: String, moduleSize: Int = 6, ec: Int = 0x31): EscPos {
        val payload = encode(data)
        val len = payload.size + 3
        raw(0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)
        raw(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, moduleSize)
        raw(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, ec)
        raw(0x1D, 0x28, 0x6B, len and 0xFF, (len shr 8) and 0xFF, 0x31, 0x50, 0x30)
        for (x in payload) b.add(x)
        return raw(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30)
    }

    fun image(raster: ByteArray): EscPos {
        for (x in raster) b.add(x and 0xFF)
        return this
    }

    fun bytes(): ByteArray = ByteArray(b.size) { b[it].toByte() }

    companion object {
        private val CP1252_EXTRA = mapOf(
            0x20AC to 0x80, 0x201A to 0x82, 0x0192 to 0x83, 0x201E to 0x84, 0x2026 to 0x85,
            0x2020 to 0x86, 0x2021 to 0x87, 0x02C6 to 0x88, 0x2030 to 0x89, 0x0160 to 0x8A,
            0x2039 to 0x8B, 0x0152 to 0x8C, 0x017D to 0x8E, 0x2018 to 0x91, 0x2019 to 0x92,
            0x201C to 0x93, 0x201D to 0x94, 0x2022 to 0x95, 0x2013 to 0x96, 0x2014 to 0x97,
            0x02DC to 0x98, 0x2122 to 0x99, 0x0161 to 0x9A, 0x203A to 0x9B, 0x0153 to 0x9C,
            0x017E to 0x9E, 0x0178 to 0x9F
        )

        fun encode(s: String): IntArray {
            val out = ArrayList<Int>(s.length)
            for (ch in s) {
                val c = ch.code
                when {
                    c == 0x0A -> out.add(0x0A)
                    c < 0x80 -> out.add(c)
                    CP1252_EXTRA.containsKey(c) -> out.add(CP1252_EXTRA.getValue(c))
                    c in 0xA0..0xFF -> out.add(c)
                    else -> out.add(0x3F)
                }
            }
            return out.toIntArray()
        }
    }
}
