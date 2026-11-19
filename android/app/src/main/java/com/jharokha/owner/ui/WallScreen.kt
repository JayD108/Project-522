package com.jharokha.owner.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jharokha.owner.data.Hub
import com.jharokha.owner.data.MediaState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun WallScreen() {
    val s by Hub.screen.collectAsState()
    val f by Hub.fun_.collectAsState()
    val m by Hub.media.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Section("Screens") {
            val x = s
            if (x == null) {
                Muted("The dashboard on the laptop hasn't reported yet. Is it open (npm run show)?")
            } else {
                Muted(
                    listOfNotNull(
                        if (x.dual) "Two screens" else "One screen",
                        x.scene?.let { "scene: $it" },
                        x.thermal?.takeIf { it != "n/a" && it != "nominal" }?.let { "heat: $it" },
                    ).joinToString(" · ")
                )
            }
            val started = x != null
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BigKey("⇄ Swap", Modifier.weight(1f), enabled = started && x?.cinema != true && x?.night != true) { Hub.remote("swap") }
                BigKey("Cinema", Modifier.weight(1f), on = x?.cinema == true, enabled = started) { Hub.remote("cinema") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BigKey("Night", Modifier.weight(1f), on = x?.night == true, enabled = started) { Hub.remote("night") }
                BigKey("Showcase", Modifier.weight(1f), on = x?.showcase == true, enabled = started) { Hub.remote("showcase") }
            }
            if (x?.dual == true) {
                BigKey(if (x.stacked) "Layers stacked: tap to show/hide" else "Stack both layers", Modifier.fillMaxWidth(), on = x.stacked) { Hub.remote("stack") }
            }
        }

        Section("Wallpaper") {
            val x = s
            val walls = x?.wallpapers.orEmpty()
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BigKey("◀", Modifier.weight(0.25f), enabled = walls.isNotEmpty()) { Hub.remote("wallpaper", "prev") }
                Text(
                    x?.current?.name ?: "—", Modifier.weight(0.5f), textAlign = TextAlign.Center,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium,
                )
                BigKey("▶", Modifier.weight(0.25f), enabled = walls.isNotEmpty()) { Hub.remote("wallpaper", "next") }
            }
            if (walls.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                walls.forEach { w ->
                    FilterChip(selected = w.id == x?.currentId, onClick = { Hub.remote("wallpaper", w.id) }, label = { Text(w.name, maxLines = 1) })
                }
            }
        }

        val c = f?.casting
        if (c != null) Section("Cast on the wall") {
            Text(c.title.ifEmpty { "Something" }, fontWeight = FontWeight.Medium)
            m?.let { MediaRow(it) } ?: Muted("No player state yet")
            SmallKey("Stop cast") { Hub.castStop() }
        }

        Section("Send a link") {
            var url by remember { mutableStateOf("") }
            OutlinedTextField(url, { url = it.trim() }, singleLine = true, label = { Text("https://…") }, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SmallKey("Show on the wall", enabled = url.startsWith("https://")) { Hub.castLink(url); url = "" }
                SmallKey("Open on laptop", enabled = url.startsWith("https://")) { Hub.openOnPc(url); url = "" }
            }
            Muted("YouTube and pictures play on the wall. Netflix, Prime, Hotstar… open in Chrome on the laptop; then use the Remote tab.")
        }
    }
}

/** Play / pause, ±10 s, a position line and a volume slider for a cast on the wall. */
@Composable
fun MediaRow(m: MediaState) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        SmallKey("−10 s") { Hub.media("seek", -10) }
        BigKey(if (m.playing) "❚❚" else "▶", Modifier.weight(1f)) { Hub.media("toggle") }
        SmallKey("+10 s") { Hub.media("seek", 10) }
    }
    if (m.d > 0) Muted("${fmtClock(m.t)} / ${fmtClock(m.d)}")
    VolumeSlider(m.vol, m.muted, onMute = { Hub.media(if (m.muted) "unmute" else "mute") }) { Hub.media("volume", it) }
}

@Composable
fun VolumeSlider(vol: Int, muted: Boolean, onMute: () -> Unit, onSet: (Int) -> Unit) {
    var drag by remember { mutableFloatStateOf(-1f) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SmallKey(if (muted) "Unmute" else "Mute", onClick = onMute)
        Slider(
            value = if (drag >= 0) drag else vol.toFloat(), valueRange = 0f..100f,
            onValueChange = { drag = it }, onValueChangeFinished = { onSet(drag.toInt()); drag = -1f },
            colors = SliderDefaults.colors(thumbColor = Jhk.accent, activeTrackColor = Jhk.accent),
            modifier = Modifier.weight(1f),
        )
        Text("${if (drag >= 0) drag.toInt() else vol}")
    }
    Muted("Tip: the phone's volume buttons work too while this tab is open.")
}
