package com.jharokha.owner

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.jharokha.owner.data.Conn
import com.jharokha.owner.data.Hub
import androidx.compose.material3.Surface
import com.jharokha.owner.ui.App
import com.jharokha.owner.ui.Jhk
import com.jharokha.owner.ui.JhkTheme
import com.jharokha.owner.ui.Tab

class MainActivity : ComponentActivity() {
    /** Volume keys drive the laptop only while the Wall or Remote tab is on screen. */
    @Volatile private var tab: Tab = Tab.Home
    private var swallowUp = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleLink(intent)
        setContent {
            JhkTheme {
                // Sets the text colour for screens outside the Scaffold (the pair screen).
                Surface(color = Jhk.bg, contentColor = Jhk.ink) { App(onTab = { tab = it }) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    /** jharokha://pair?… from the phone's own camera app or a pasted link. */
    private fun handleLink(i: Intent?) {
        val data = i?.data ?: return
        if (data.scheme == "jharokha") Hub.onScan(data.toString())
        setIntent(Intent(i).setData(null))           // don't pair again on rotation
    }

    // Connected only while the app is on screen (Phase 2 adds a foreground service for notifications).
    override fun onStart() { super.onStart(); Hub.start() }
    override fun onStop() { super.onStop(); Hub.stop() }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val k = event.keyCode
        if ((k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN) && (tab == Tab.Wall || tab == Tab.Remote) && Hub.conn.value == Conn.Online) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (Hub.volumeStep(if (k == KeyEvent.KEYCODE_VOLUME_UP) VOLUME_STEP else -VOLUME_STEP)) { swallowUp = true; return true }
            } else if (event.action == KeyEvent.ACTION_UP && swallowUp) { swallowUp = false; return true }
        }
        return super.dispatchKeyEvent(event)
    }

    private companion object { const val VOLUME_STEP = 5 }
}
