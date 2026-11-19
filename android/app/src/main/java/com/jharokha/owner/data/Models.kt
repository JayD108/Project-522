package com.jharokha.owner.data

import org.json.JSONArray
import org.json.JSONObject

// Mirrors of the server's JSON (app/src/room/roomClient.ts, server/access.mjs, server/index.mjs vitals()).
// Only the fields this app shows. Unknown fields are ignored, missing ones get safe defaults. Money is integer paise.

private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k, "").ifEmpty { null }
private fun JSONObject.lng(k: String): Long? = if (has(k) && !isNull(k)) optLong(k) else null
private inline fun <T> JSONArray?.map(f: (JSONObject) -> T): List<T> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }

data class Me(val id: String?, val name: String?, val role: String?, val status: String, val owner: Boolean) {
    companion object {
        fun from(j: JSONObject) = Me(j.str("id"), j.str("name"), j.str("role"), j.optString("status", "none"), j.optBoolean("owner"))
    }
}

data class Vitals(
    val uptimeS: Long, val reqPerS: Double, val wsClients: Int, val activeClients: Int,
    val load1: Double, val cpus: Int, val memAvailMB: Int, val memTotalMB: Int,
    val diskFreeGB: Double?, val rssMB: Int, val errors: Int, val thermal: String, val thermalGuard: Boolean,
) {
    companion object {
        fun from(j: JSONObject): Vitals {
            val mem = j.optJSONObject("mem")
            return Vitals(
                uptimeS = j.optLong("uptimeS"), reqPerS = j.optDouble("reqPerS", 0.0),
                wsClients = j.optInt("wsClients"), activeClients = j.optInt("activeClients60s"),
                load1 = j.optJSONArray("load")?.optDouble(0, 0.0) ?: 0.0, cpus = j.optInt("cpus", 1),
                memAvailMB = mem?.optInt("availMB") ?: 0, memTotalMB = mem?.optInt("totalMB") ?: 0,
                diskFreeGB = j.optJSONObject("disk")?.optDouble("freeGB"), rssMB = j.optInt("rssMB"),
                errors = j.optInt("errors"), thermal = j.optString("thermal", "n/a"), thermalGuard = j.optBoolean("thermalGuard"),
            )
        }
    }
}

/** Where the laptop says phones should go; source "tunnel" = the internet link. */
data class JoinInfo(val url: String, val source: String, val tunnelStatus: String, val tunnelWanted: Boolean, val tunnelError: String?) {
    companion object {
        fun from(j: JSONObject?) = j?.let {
            val t = it.optJSONObject("tunnel") ?: JSONObject()
            JoinInfo(it.optString("url"), it.optString("source"), t.optString("status", "off"), t.optBoolean("wanted"), t.str("error"))
        }
    }
}

data class Device(
    val id: String, val name: String, val role: String?, val status: String,
    val createdAt: Long, val lastSeen: Long?, val ip: String?, val ua: String?,
)

data class AuditLine(val at: Long, val actor: String, val action: String, val target: String?, val detail: String?)

data class AccessState(
    val devices: List<Device>, val pending: Int, val kill: Boolean,
    val quietEnabled: Boolean, val quietStart: String, val quietEnd: String, val quietNow: Boolean,
    val max: Int, val audit: List<AuditLine>, val netMode: String,
) {
    companion object {
        fun from(a: JSONObject): AccessState {
            val q = a.optJSONObject("quiet") ?: JSONObject()
            return AccessState(
                devices = a.optJSONArray("devices").map {
                    Device(it.optString("id"), it.optString("name"), it.str("role"), it.optString("status"),
                        it.optLong("createdAt"), it.lng("lastSeen"), it.str("ip"), it.str("ua"))
                },
                pending = a.optInt("pending"), kill = a.optBoolean("kill"),
                quietEnabled = q.optBoolean("enabled"), quietStart = q.optString("start", "00:30"),
                quietEnd = q.optString("end", "07:00"), quietNow = q.optBoolean("now"),
                max = a.optInt("max", 20),
                audit = a.optJSONArray("audit").map {
                    AuditLine(it.optLong("at"), it.optString("actor"), it.optString("action"), it.str("target"), it.str("detail"))
                },
                netMode = a.optJSONObject("net")?.optString("mode", "wifi") ?: "wifi",
            )
        }
    }
}

data class Wallpaper(val id: String, val name: String)

/** What the laptop screens are doing (W-A reports it every 1.5 s; owners only). */
data class ScreenState(
    val mode: String, val cinema: Boolean, val night: Boolean, val showcase: Boolean, val stacked: Boolean,
    val currentId: String?, val wallpapers: List<Wallpaper>, val scene: String?, val thermal: String?, val at: Long,
) {
    val dual get() = mode == "dual"
    val current get() = wallpapers.firstOrNull { it.id == currentId }

    companion object {
        fun from(s: JSONObject) = ScreenState(
            mode = s.optString("mode"), cinema = s.optBoolean("cinema"), night = s.optBoolean("night"),
            showcase = s.optBoolean("showcase"), stacked = s.optBoolean("stacked"), currentId = s.str("currentId"),
            wallpapers = s.optJSONArray("wallpapers").map { Wallpaper(it.optString("id"), it.optString("name")) },
            scene = s.str("scene"), thermal = s.optJSONObject("thermal")?.str("state"), at = s.optLong("at"),
        )
    }
}

/** Playback of a cast on the wall (YouTube / video drop). */
data class MediaState(val playing: Boolean, val t: Double, val d: Double, val vol: Int, val muted: Boolean, val kind: String) {
    companion object {
        fun from(s: JSONObject) = MediaState(s.optBoolean("playing"), s.optDouble("t", 0.0), s.optDouble("d", 0.0),
            s.optInt("vol"), s.optBoolean("muted"), s.optString("kind"))
    }
}

/** The Netflix / YouTube tab on the laptop, reported by the Jharokha Remote extension. */
data class AppState(
    val site: String, val title: String, val player: Boolean, val skip: String?, val typing: Boolean,
    val blocked: Boolean, val video: MediaState?,
) {
    companion object {
        fun from(s: JSONObject) = AppState(
            site = s.optString("site"), title = s.optString("title"), player = s.optBoolean("player"),
            skip = s.str("skip"), typing = s.optBoolean("typing"), blocked = s.optBoolean("blocked"),
            video = s.optJSONObject("v")?.let { v ->
                MediaState(v.optBoolean("playing"), v.optDouble("t", 0.0), v.optDouble("d", 0.0), v.optInt("vol"), v.optBoolean("muted"), "app")
            },
        )
    }
}

data class Door(val status: String, val note: String, val by: String?) {
    companion object {
        val OPTIONS = listOf("Come in", "Knock first", "Busy", "Studying", "Sleeping", "Away")
        fun from(j: JSONObject) = Door(j.optString("status", "Come in"), j.optString("note"), j.str("by"))
    }
}

data class CastReq(val id: String, val by: String, val title: String, val site: String)
data class Casting(val title: String, val by: String?, val kind: String)

data class FunState(val casts: List<CastReq>, val casting: Casting?) {
    companion object {
        fun from(f: JSONObject) = FunState(
            casts = f.optJSONArray("casts").map { CastReq(it.optString("id"), it.optString("by"), it.optString("title"), it.optString("site")) },
            casting = (f.optJSONObject("cast") ?: f.optJSONObject("casting"))?.let {
                Casting(it.optString("title"), it.str("by"), it.optString("kind"))
            },
        )
    }
}

data class Timer(val id: String, val label: String, val minutes: Int, val endsAt: Long, val by: String, val done: Boolean)
data class Alarm(val on: Boolean, val time: String, val days: List<Int>, val rampMin: Int, val sound: Boolean, val snoozeUntil: Long)

data class ToolsState(val timers: List<Timer>, val alarm: Alarm, val serverNow: Long, val receivedAt: Long) {
    /** The laptop's clock now (phones and laptops disagree by seconds). */
    fun serverTime(nowMs: Long = System.currentTimeMillis()) = nowMs + (serverNow - receivedAt)

    companion object {
        fun from(t: JSONObject): ToolsState {
            val a = t.optJSONObject("alarm") ?: JSONObject()
            val days = a.optJSONArray("days")
            return ToolsState(
                timers = t.optJSONArray("timers").map {
                    Timer(it.optString("id"), it.optString("label"), it.optInt("minutes"), it.optLong("endsAt"), it.optString("by"), it.optBoolean("done"))
                },
                alarm = Alarm(
                    on = a.optBoolean("on"), time = a.optString("time", "07:00"),
                    days = if (days == null) emptyList() else (0 until days.length()).map { days.optInt(it) },
                    rampMin = a.optInt("rampMin", 15), sound = a.optBoolean("sound", true), snoozeUntil = a.optLong("snoozeUntil"),
                ),
                serverNow = t.optLong("serverNow"), receivedAt = System.currentTimeMillis(),
            )
        }
    }
}
