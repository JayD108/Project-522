package com.jharokha.owner

import com.jharokha.owner.data.Api
import com.jharokha.owner.data.ApiException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The HTTP side of the app against a fake laptop (MockWebServer): cookie, JSON, pairing, Drop Zone upload. */
class ApiTest {
    private lateinit var srv: MockWebServer
    private var token: String? = "tok123"
    private lateinit var api: Api

    @Before fun up() { srv = MockWebServer(); srv.start(); api = Api({ srv.url("/").toString().trimEnd('/') }, { token }) }
    @After fun down() = srv.shutdown()

    @Test fun ownerTokenRidesInTheCookieAndPostsAreJson() = runBlocking {
        srv.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.post("/api/door", org.json.JSONObject().put("status", "Busy"))
        val r = srv.takeRequest()
        assertEquals("jhk_dev=tok123", r.getHeader("Cookie"))
        assertTrue(r.getHeader("Content-Type")!!.startsWith("application/json"))
        assertEquals("""{"status":"Busy"}""", r.body.readUtf8())
    }

    @Test fun serverErrorsBecomeReadableExceptions() = runBlocking {
        srv.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"not-on-room-wifi"}"""))
        try { api.get("/api/vitals"); fail("should throw") } catch (e: ApiException) {
            assertEquals(403, e.code); assertTrue(e.message!!.contains("Wi-Fi"))
        }
    }

    @Test fun pairingSendsNoCookieAndReadsTheTokenFromSetCookie() = runBlocking {
        srv.enqueue(MockResponse().setBody("""{"ok":true}""").addHeader("Set-Cookie", "jhk_dev=newtoken; Path=/; HttpOnly; SameSite=Strict"))
        val t = api.pair(srv.url("/").toString().trimEnd('/'), "a".repeat(32), "OPPO")
        val r = srv.takeRequest()
        assertEquals("newtoken", t)
        assertEquals(null, r.getHeader("Cookie"))
        assertEquals("/api/pair", r.path)
    }

    @Test fun uploadStreamsTheRawFileWithNameInTheQuery() = runBlocking {
        srv.enqueue(MockResponse().setBody("""{"ok":true,"id":"d1","name":"room photo.jpg","bytes":5,"mime":"image/jpeg"}"""))
        val bytes = byteArrayOf(1, 2, 3, 4, 5)
        val j = api.putFile("room photo.jpg", "image/jpeg", bytes.size.toLong()) { bytes.inputStream() }
        val r = srv.takeRequest()
        assertEquals("PUT", r.method)
        assertEquals("/api/drops?name=room+photo.jpg&type=image%2Fjpeg", r.path)
        assertEquals("application/octet-stream", r.getHeader("Content-Type"))
        assertEquals("5", r.getHeader("Content-Length"))
        assertEquals("jhk_dev=tok123", r.getHeader("Cookie"))
        assertTrue(r.body.readByteArray().contentEquals(bytes))
        assertEquals("d1", j.optString("id"))
    }

    @Test fun uploadQuotaErrorIsShown() = runBlocking {
        srv.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":"Over your 500 MB drop quota"}"""))
        try { api.putFile("big.mp4", "video/mp4", 3) { byteArrayOf(1, 2, 3).inputStream() }; fail() } catch (e: ApiException) {
            assertEquals(413, e.code); assertTrue(e.message!!.contains("quota"))
        }
    }
}
