package com.jharokha.owner.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * What the app remembers: the laptop's address and this phone's owner token.
 * The token is encrypted with an AES-256-GCM key that lives in the Android Keystore and never leaves it,
 * so the prefs file alone is useless (and it is excluded from backups). Never log the token.
 */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("jharokha", Context.MODE_PRIVATE)

    /** e.g. "https://quiet-river.trycloudflare.com" or "http://192.168.1.23:8080" (no trailing slash). */
    var baseUrl: String?
        get() = prefs.getString(K_BASE, null)
        set(v) = prefs.edit().putString(K_BASE, v?.trimEnd('/')).apply()

    var deviceName: String
        get() = prefs.getString(K_NAME, null) ?: android.os.Build.MODEL.take(32)
        set(v) = prefs.edit().putString(K_NAME, v.take(32)).apply()

    var token: String?
        get() = prefs.getString(K_TOKEN, null)?.let { runCatching { Vault.decrypt(it) }.getOrNull() }
        set(v) {
            if (v == null) prefs.edit().remove(K_TOKEN).apply()
            else prefs.edit().putString(K_TOKEN, Vault.encrypt(v)).apply()
        }

    val paired: Boolean get() = baseUrl != null && token != null

    /**
     * Pairing codes work once. Android can hand the same jharokha://pair link back (task restored from recents,
     * reinstall), so remember a hash of the last code the laptop answered (yes or no) and skip repeats.
     */
    fun wasUsed(code: String) = prefs.getString(K_LAST_CODE, null) == sha256(code)
    fun markUsed(code: String) = prefs.edit().putString(K_LAST_CODE, sha256(code)).apply()

    private fun sha256(s: String) = java.security.MessageDigest.getInstance("SHA-256")
        .digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    fun forget() = prefs.edit().remove(K_TOKEN).apply()

    private companion object {
        const val K_BASE = "base"
        const val K_NAME = "name"
        const val K_TOKEN = "token.v1"
        const val K_LAST_CODE = "lastPairCode"
    }
}

/** AES-GCM with a non-exportable Keystore key. Output = base64(iv ‖ ciphertext+tag). */
private object Vault {
    private const val ALIAS = "jharokha-owner-token"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    fun decrypt(enc: String): String {
        val all = Base64.decode(enc, Base64.NO_WRAP)
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all, 0, 12))
        return String(c.doFinal(all, 12, all.size - 12), Charsets.UTF_8)
    }
}
