package com.jharokha.owner.data

import java.net.URI
import java.net.URLDecoder

/** What a scanned QR (or a pasted link) means to this app. Pure Kotlin so it is unit-tested on the JVM. */
sealed interface Scan {
    /** Laptop dashboard → Access → "Pair my phone": `jharokha://pair?u=<base>&c=<32 hex>`. */
    data class Pair(val base: String, val code: String) : Scan

    /**
     * Any Jharokha room QR (`https://x.trycloudflare.com/join?k=…` or `http://192.168.1.23:8080/join?k=…`).
     * The internet link changes on every laptop restart; an already-paired phone just takes the new address
     * from the wall's QR and keeps its token.
     */
    data class Relocate(val base: String) : Scan

    data class Invalid(val why: String) : Scan
}

object Pairing {
    private val CODE = Regex("^[0-9a-f]{32}$")

    fun parse(raw: String): Scan {
        val text = raw.trim()
        val uri = try { URI(text) } catch (e: Exception) { return Scan.Invalid("That isn't a link") }
        val scheme = uri.scheme?.lowercase()
        if (scheme == "jharokha") {
            if (uri.host != "pair" && uri.authority != "pair") return Scan.Invalid("Unknown Jharokha code")
            val q = query(uri.rawQuery)
            val base = q["u"]?.let { origin(it) } ?: return Scan.Invalid("The code has no laptop address")
            val code = q["c"]?.lowercase() ?: return Scan.Invalid("The code has no pairing key")
            if (!CODE.matches(code)) return Scan.Invalid("The pairing key looks wrong")
            return Scan.Pair(base, code)
        }
        if (scheme == "http" || scheme == "https") {
            val path = uri.rawPath ?: ""
            if (path == "/join" || path.startsWith("/app/room")) {
                return origin(text)?.let { Scan.Relocate(it) } ?: Scan.Invalid("Bad address")
            }
            return Scan.Invalid("This is not a Jharokha QR")
        }
        return Scan.Invalid("This is not a Jharokha QR")
    }

    /** "https://Host:443/anything?x" → "https://host"; only http(s); no user info. */
    fun origin(url: String): String? {
        val u = try { URI(url.trim()) } catch (e: Exception) { return null }
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (u.rawUserInfo != null) return null
        val host = u.host?.lowercase() ?: return null
        val port = when {
            u.port == -1 -> ""
            scheme == "https" && u.port == 443 -> ""
            scheme == "http" && u.port == 80 -> ""
            else -> ":${u.port}"
        }
        return "$scheme://$host$port"
    }

    private fun query(raw: String?): Map<String, String> =
        raw.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
            val i = it.indexOf('=')
            val k = if (i < 0) it else it.substring(0, i)
            val v = if (i < 0) "" else it.substring(i + 1)
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }
}
