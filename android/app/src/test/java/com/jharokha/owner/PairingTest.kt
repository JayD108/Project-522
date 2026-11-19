package com.jharokha.owner

import com.jharokha.owner.data.Api
import com.jharokha.owner.data.Pairing
import com.jharokha.owner.data.Scan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    private val code = "30eb7ee29a7ada84785061a173f7ea91"

    @Test fun pairQrFromTheLaptop() {
        // Exactly what POST /api/pair/phone puts in the QR (tests/run-all.mjs checks the server side).
        val s = Pairing.parse("jharokha://pair?u=https%3A%2F%2Fquiet-river.trycloudflare.com&c=$code")
        assertEquals(Scan.Pair("https://quiet-river.trycloudflare.com", code), s)
        assertEquals(Scan.Pair("http://192.168.1.23:8080", code), Pairing.parse("jharokha://pair?u=http%3A%2F%2F192.168.1.23%3A8080&c=$code"))
    }

    @Test fun badPairCodesAreRefused() {
        assertTrue(Pairing.parse("jharokha://pair?u=https%3A%2F%2Fx.example&c=deadbeef") is Scan.Invalid)       // too short
        assertTrue(Pairing.parse("jharokha://pair?c=$code") is Scan.Invalid)                                    // no address
        assertTrue(Pairing.parse("jharokha://pair?u=ftp%3A%2F%2Fx.example&c=$code") is Scan.Invalid)          // not http(s)
        assertTrue(Pairing.parse("jharokha://evil?u=https%3A%2F%2Fx.example&c=$code") is Scan.Invalid)
        assertTrue(Pairing.parse("not a link at all") is Scan.Invalid)
    }

    @Test fun roomJoinQrOnlyUpdatesTheAddress() {
        assertEquals(Scan.Relocate("https://new-name.trycloudflare.com"), Pairing.parse("https://new-name.trycloudflare.com/join?k=ab12cd"))
        assertEquals(Scan.Relocate("http://192.168.1.23:8080"), Pairing.parse("http://192.168.1.23:8080/join?k=ab12cd"))
        assertTrue(Pairing.parse("https://example.com/somewhere") is Scan.Invalid)
    }

    @Test fun originDropsPathsDefaultPortsAndUserInfo() {
        assertEquals("https://a.example", Pairing.origin("https://A.example:443/x?y"))
        assertEquals("http://10.0.0.2:8080", Pairing.origin("http://10.0.0.2:8080/join"))
        assertNull(Pairing.origin("https://user:pw@a.example/"))
        assertNull(Pairing.origin("javascript:alert(1)"))
    }

    @Test fun tokenComesFromTheSetCookieHeader() {
        val h = listOf("other=1; Path=/", "jhk_dev=abc123; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure")
        assertEquals("abc123", Api.tokenFrom(h))
        assertNull(Api.tokenFrom(listOf("jhk_dev=; Max-Age=0")))
    }

    @Test fun friendlyErrors() {
        assertTrue(Api.errorOf("""{"error":"not-on-room-wifi"}""", 403).contains("Wi-Fi"))
        assertEquals("Pairing code is wrong", Api.errorOf("""{"error":"Pairing code is wrong"}""", 403))
        assertTrue(Api.errorOf("<html>", 530).contains("room QR"))
    }
}
