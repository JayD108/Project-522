package com.jharokha.owner.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jharokha.owner.data.Door
import com.jharokha.owner.data.Hub

@Composable
fun HomeScreen() {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Requests()
        OnTheWall()
        DoorSign()
        LaptopHealth()
    }
}

/** Join requests and cast requests waiting for the owner (same as the laptop's approval tray). */
@Composable
private fun Requests() {
    val a by Hub.access.collectAsState()
    val f by Hub.fun_.collectAsState()
    val pending = a?.devices?.filter { it.status == "pending" }.orEmpty()
    val casts = f?.casts.orEmpty()
    if (pending.isEmpty() && casts.isEmpty()) return
    Section("Waiting for you") {
        pending.forEach { d ->
            Text("${d.name} wants to join", fontWeight = FontWeight.Medium)
            Muted("${d.ua ?: "phone"} · ${d.ip ?: ""} · ${ago(d.createdAt)}")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { Hub.decide(d.id, "approve", "collaborator") }) { Text("Collaborator") }
                SmallKey("Viewer") { Hub.decide(d.id, "approve", "viewer") }
                SmallKey("✕") { Hub.decide(d.id, "deny") }
            }
        }
        casts.forEach { c ->
            Text("${c.by} wants to show “${c.title}” on the wall", fontWeight = FontWeight.Medium)
            Muted(c.site)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { Hub.castDecide(c.id, true) }) { Text("Show on wall") }
                SmallKey("✕") { Hub.castDecide(c.id, false) }
            }
        }
    }
}

@Composable
private fun OnTheWall() {
    val f by Hub.fun_.collectAsState()
    val m by Hub.media.collectAsState()
    val c = f?.casting ?: return
    Section("On the wall now", trailing = { TextButton(onClick = { Hub.castStop() }) { Text("Stop", color = Jhk.bad) } }) {
        Text(c.title.ifEmpty { "Something" }, fontWeight = FontWeight.Medium)
        Muted(listOfNotNull(c.kind.ifEmpty { null }, c.by?.let { "by $it" }).joinToString(" · "))
        m?.let { MediaRow(it) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DoorSign() {
    val d by Hub.door.collectAsState()
    var note by remember { mutableStateOf("") }
    LaunchedEffect(d?.note) { note = d?.note.orEmpty() }
    Section("Door sign") {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Door.OPTIONS.forEach { o ->
                FilterChip(selected = d?.status == o, onClick = { Hub.setDoor(o, note) }, label = { Text(o) })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(note, { note = it.take(80) }, singleLine = true, label = { Text("Note") }, modifier = Modifier.weight(1f))
            SmallKey("Set") { Hub.setDoor(d?.status ?: "Come in", note) }
        }
    }
}

@Composable
private fun LaptopHealth() {
    val v by Hub.vitals.collectAsState()
    val s by Hub.screen.collectAsState()
    val j by Hub.join.collectAsState()
    Section("Laptop") {
        val x = v ?: run { Muted("Waiting for the laptop…"); return@Section }
        val memPct = if (x.memTotalMB > 0) 100 - x.memAvailMB * 100 / x.memTotalMB else 0
        Stat("Up", fmtUptime(x.uptimeS))
        Stat("RAM", "$memPct% used · ${x.memAvailMB} MB free of ${x.memTotalMB}", warn = memPct >= 90)
        Stat("CPU load", "%.2f on %d cores".format(x.load1, x.cpus), warn = x.load1 > x.cpus)
        x.diskFreeGB?.let { Stat("Disk free", "%.1f GB".format(it), warn = it < 5) }
        Stat("Live links", "${x.wsClients} open now · ${x.activeClients} device${if (x.activeClients == 1) "" else "s"} in the last minute")
        Stat("Heat", x.thermal + if (x.thermalGuard) " · wallpaper paused to cool down" else "", warn = x.thermalGuard)
        if (x.errors > 0) Stat("Server errors", "${x.errors} since start", warn = true)
        s?.let { Stat("Screens", (if (it.dual) "two screens" else "one screen") + (it.current?.let { w -> " · ${w.name}" } ?: "")) }
        j?.let { Stat("Phones join via", if (it.source == "tunnel") "internet link" else "Wi-Fi (${it.source})") }
    }
}

@Composable
fun Stat(label: String, value: String, warn: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
        Muted(label, Modifier.weight(0.35f))
        Text(value, color = if (warn) Jhk.amber else Jhk.ink, modifier = Modifier.weight(0.65f))
    }
}
