package com.jharokha.owner.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jharokha.owner.data.Hub
import org.json.JSONObject

/** TV-style remote for the Netflix / YouTube tab on the laptop (needs the Jharokha Remote extension there). */
@Composable
fun RemoteScreen() {
    val helper by Hub.appHelper.collectAsState()
    val a by Hub.appState.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Section {
            if (!helper) {
                Text("The Jharokha Remote extension isn't connected", color = Jhk.amber, fontWeight = FontWeight.Medium)
                Muted("On the laptop: chrome://extensions → Developer mode → Load unpacked → Linux files/jharokha/extension. It stays loaded after that.")
            } else {
                val x = a
                Text(x?.title?.ifEmpty { null } ?: x?.site?.ifEmpty { null } ?: "No streaming tab open", fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Muted(listOfNotNull(x?.site?.ifEmpty { null }, if (x?.blocked == true) "this site blocks remote control" else null, if (x?.typing == true) "a text box is focused" else null).joinToString(" · ").ifEmpty { "Use Open on laptop (Wall tab) to start Netflix or YouTube" })
            }
        }
        DPad(enabled = helper)
        Touchpad(enabled = helper)
        Player(enabled = helper)
        Typing(enabled = helper)
    }
}

@Composable
private fun DPad(enabled: Boolean) {
    Section {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            BigKey("▲", Modifier.width(88.dp), enabled = enabled) { Hub.app("nav", "up") }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
            BigKey("◀", Modifier.width(88.dp), enabled = enabled) { Hub.app("nav", "left") }
            BigKey("OK", Modifier.width(88.dp), on = true, enabled = enabled) { Hub.app("ok") }
            BigKey("▶", Modifier.width(88.dp), enabled = enabled) { Hub.app("nav", "right") }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            BigKey("▼", Modifier.width(88.dp), enabled = enabled) { Hub.app("nav", "down") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BigKey("Back", Modifier.weight(1f), enabled = enabled) { Hub.app("back") }
            BigKey("Home", Modifier.weight(1f), enabled = enabled) { Hub.app("home") }
            BigKey("Browse", Modifier.weight(1f), enabled = enabled) { Hub.app("browse") }
        }
    }
}

/** Drag = move the pointer, tap = click; the strip on the right scrolls the page. */
@Composable
private fun Touchpad(enabled: Boolean) {
    val tick = rememberTick()
    Section("Touchpad") {
        Row(Modifier.fillMaxWidth().height(200.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(
                color = Jhk.bg, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, Jhk.line),
                modifier = Modifier.weight(1f).height(200.dp)
                    .pointerInput(enabled) {
                        if (!enabled) return@pointerInput
                        detectTapGestures(onTap = { tick(); Hub.app("click") })
                    }
                    .pointerInput(enabled) {
                        if (!enabled) return@pointerInput
                        var ax = 0f; var ay = 0f; var last = 0L
                        detectDragGestures(onDragEnd = { if (ax != 0f || ay != 0f) Hub.move(ax.toInt(), ay.toInt()); ax = 0f; ay = 0f }) { ch, d ->
                            ch.consume()
                            ax += d.x * SPEED; ay += d.y * SPEED
                            val now = System.currentTimeMillis()
                            if (now - last >= 16 && (kotlin.math.abs(ax) >= 1 || kotlin.math.abs(ay) >= 1)) {
                                Hub.move(ax.toInt(), ay.toInt()); ax -= ax.toInt(); ay -= ay.toInt(); last = now
                            }
                        }
                    },
            ) { Box(contentAlignment = Alignment.Center) { Muted(if (enabled) "drag to move · tap to click" else "—") } }
            Surface(
                color = Jhk.bg, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, Jhk.line),
                modifier = Modifier.width(48.dp).height(200.dp).pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    var acc = 0f
                    detectVerticalDragGestures(onDragEnd = { acc = 0f }) { ch, dy ->
                        ch.consume(); acc += dy * 3
                        if (kotlin.math.abs(acc) >= 20) { Hub.scroll(acc.toInt()); acc = 0f }
                    }
                },
            ) { Box(contentAlignment = Alignment.Center) { Muted("↕") } }
        }
    }
}

private const val SPEED = 1.6f

@Composable
private fun Player(enabled: Boolean) {
    val a by Hub.appState.collectAsState()
    val v = a?.video
    Section("Player") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            BigKey("−10", Modifier.weight(1f), enabled = enabled) { Hub.app("seek", -10) }
            BigKey(if (v?.playing == true) "❚❚" else "▶", Modifier.weight(1.4f), on = true, enabled = enabled) { Hub.app("toggle") }
            BigKey("+10", Modifier.weight(1f), enabled = enabled) { Hub.app("seek", 10) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallKey("Full screen", enabled = enabled) { Hub.app("fullscreen") }
            SmallKey(a?.skip ?: "Skip", enabled = enabled && a?.skip != null) { Hub.app("skip") }
            SmallKey("Close tab", enabled = enabled) { Hub.app("close") }
        }
        if (v != null) {
            if (v.d > 0) Muted("${fmtClock(v.t)} / ${fmtClock(v.d)}")
            VolumeSlider(v.vol, v.muted, onMute = { Hub.app("mute") }) { Hub.app("volume", it) }
        }
    }
}

@Composable
private fun Typing(enabled: Boolean) {
    var text by remember { mutableStateOf("") }
    Section("Type / search") {
        OutlinedTextField(
            text, { text = it.take(200) }, singleLine = true, enabled = enabled, modifier = Modifier.fillMaxWidth(),
            label = { Text("Text for the focused box") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send(text, true); text = "" }),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallKey("Type", enabled = enabled && text.isNotEmpty()) { send(text, false); text = "" }
            SmallKey("Type + Enter", enabled = enabled && text.isNotEmpty()) { send(text, true); text = "" }
            SmallKey("Search", enabled = enabled && text.isNotBlank()) { Hub.app("search", text.trim()); text = "" }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("⌫" to "backspace", "Enter" to "enter", "Space" to "space", "Esc" to "escape", "Tab" to "tab").forEach { (l, k) ->
                SmallKey(l, enabled = enabled) { Hub.app("key", k) }
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}

private fun send(text: String, enter: Boolean) {
    if (text.isNotEmpty()) Hub.app("type", JSONObject().put("text", text).put("enter", enter))
}
