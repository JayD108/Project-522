package com.jharokha.owner.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(val code: Int, message: String) : Exception(message)

/**
 * HTTP to the laptop server. The owner token rides in the same `jhk_dev` cookie the web pages use
 * (the server needs no change for that); the app sets the header itself. There is no logging interceptor on purpose.
 */
class Api(private val store: Store) {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)        // keeps the tunnel and NAT from dropping an idle /ws
        .build()

    private fun request(path: String, base: String? = store.baseUrl, token: String? = store.token): Request.Builder {
        val b = base ?: throw ApiException(0, "This phone isn't paired yet")
        return Request.Builder().url(b + path)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .apply { if (token != null) header("Cookie", "$COOKIE=$token") }
    }

    suspend fun get(path: String): JSONObject = call(request(path).get().build())
    suspend fun post(path: String, body: JSONObject = JSONObject()): JSONObject =
        call(request(path).post(body.toString().toRequestBody(JSON)).build())
    suspend fun delete(path: String): JSONObject = call(request(path).delete().build())

    fun wsRequest(): Request = request("/ws").build()

    /** One-time code from the laptop's "Pair my phone" QR → owner token (from the Set-Cookie header). */
    suspend fun pair(base: String, code: String, name: String): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("code", code).put("name", name).toString().toRequestBody(JSON)
        val req = request("/api/pair", base = base, token = null).post(body).build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(resp.code, errorOf(text, resp.code))
            tokenFrom(resp.headers("Set-Cookie")) ?: throw ApiException(0, "The laptop paired but sent no token")
        }
    }

    private suspend fun call(req: Request): JSONObject = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(resp.code, errorOf(text, resp.code))
            runCatching { JSONObject(text) }.getOrElse { JSONObject() }
        }
    }

    companion object {
        const val COOKIE = "jhk_dev"
        const val USER_AGENT = "JharokhaOwner/0.1 (Android)"
        private val JSON = "application/json".toMediaType()

        fun tokenFrom(setCookies: List<String>): String? = setCookies.firstNotNullOfOrNull { h ->
            val first = h.substringBefore(';').trim()
            if (first.startsWith("$COOKIE=")) first.substringAfter('=').ifEmpty { null } else null
        }

        /** The server's `{error}` text, made friendlier for the cases a phone hits. */
        fun errorOf(body: String, code: Int): String {
            val e = runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty()
            return when {
                e == "not-on-room-wifi" -> "Connect to the room's Wi-Fi first (mobile data is refused until this phone is an owner)"
                e.startsWith("ask to join first") -> "The laptop doesn't know this phone (pairing missing or removed)"
                e.isNotEmpty() -> e
                code == 530 || code == 502 || code == 404 -> "The internet link isn't answering (the laptop restarted?). Scan the room QR to update the address."
                else -> "HTTP $code"
            }
        }
    }
}
