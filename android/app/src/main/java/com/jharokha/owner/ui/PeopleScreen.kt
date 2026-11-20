package com.jharokha.owner.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import com.jharokha.owner.data.Device
import com.jharokha.owner.data.Hub
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val HHMM = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

/** The laptop's Access card: who can connect, safety switches, devices, audit log. */
@Composable
fun PeopleScreen() {
    val a by Hub.access.collectAsState()
    val j by Hub.join.collectAsState()
    val me by Hub.me.collectAsState()
    var ask by remember { mutableStateOf<Pair<String, () -> Unit>?>(null) }
    val x = a ?: run { Section { Muted("Waiting for the laptop…") }; return }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Section("Who can connect") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = x.netMode == "wifi", onClick = { Hub.setNetMode("wifi") }, label = { Text("Same Wi-Fi only") })
                FilterChip(selected = x.netMode == "anywhere", onClick = { Hub.setNetMode("anywhere") }, label = { Text("Anywhere") })
            }
            Muted(if (x.netMode == "wifi") "Phones must be on the room's Wi-Fi; mobile data is refused. Owners (this phone) always get in."
            else "People you approved can use the room from any network. New people still need the QR.")
            val t = j
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Internet sharing")
                    Muted(when (t?.tunnelStatus) {
                        "on" -> "On: phones reach the laptop through a Cloudflare link"
                        "starting" -> "Starting…"
                        "unavailable" -> "Not installed on the laptop (npm run tunnel:install)"
                        else -> t?.tunnelError ?: "Off: phones must reach the laptop over Wi-Fi"
                    })
                }
                Switch(
                    checked = t?.tunnelWanted == true,
                    onCheckedChange = { on ->
                        if (on) ask = "Turn on a public internet link to the laptop? Strangers can only reach the join page, and the Same Wi-Fi rule still applies." to { Hub.setTunnel(true) }
                        else ask = "Turn off internet sharing? If this phone is connected through it, it will go offline until it's back on Wi-Fi." to { Hub.setTunnel(false) }
                    },
                )
            }
        }

        Section("Safety") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(if (x.kill) "Owner-only mode is ON" else "Kill switch", color = if (x.kill) Jhk.bad else Jhk.ink, fontWeight = FontWeight.Medium)
                    Muted(if (x.kill) "Guests are blocked and disconnected." else "Kicks everyone except owners.")
                }
                Switch(checked = x.kill, onCheckedChange = { on ->
                    if (on) ask = "Kick every guest off and refuse new ones until you turn it off?" to { Hub.setKill(true) } else Hub.setKill(false)
                })
            }
            HorizontalDivider(color = Jhk.line)
            QuietHours(x.quietEnabled, x.quietStart, x.quietEnd, x.quietNow)
        }

        val approved = x.devices.filter { it.status == "approved" }
        Section("Devices", trailing = { Muted("${approved.size + x.pending} / ${x.max}") }) {
            if (approved.isEmpty()) Muted("No one has joined yet.")
            approved.forEach { d -> DeviceRow(d, self = d.id == me?.id) { ask = "Remove ${d.name}? They are signed out at once." to { Hub.decide(d.id, "revoke") } } }
        }

        Section("Audit log") {
            val fmt = remember { SimpleDateFormat("HH:mm", Locale.getDefault()) }
            x.audit.take(15).forEach { e ->
                Row {
                    Muted(fmt.format(Date(e.at)), Modifier.weight(0.15f))
                    Text(
                        "${e.actor} ${e.action}" + (e.target?.let { " · $it" } ?: "") + (e.detail?.let { " · $it" } ?: ""),
                        modifier = Modifier.weight(0.85f),
                    )
                }
            }
        }
    }
    ask?.let { (q, yes) -> Confirm("Are you sure?", q, "Yes", yes) { ask = null } }
}

@Composable
private fun DeviceRow(d: Device, self: Boolean, onKick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(d.name + if (self) "  (this phone)" else "", fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            if (!self) SmallKey("Kick out", onClick = onKick)
        }
        Muted("${d.ua ?: "?"} · seen ${ago(d.lastSeen)}")
        if (!self) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("owner" to "Owner", "collaborator" to "Collaborator", "viewer" to "Viewer").forEach { (r, l) ->
                FilterChip(selected = d.role == r, onClick = { if (d.role != r) Hub.decide(d.id, "role", r) }, label = { Text(l) })
            }
        }
        HorizontalDivider(color = Jhk.line)
    }
}

@Composable
private fun QuietHours(enabled: Boolean, start: String, end: String, now: Boolean) {
    var s by remember { mutableStateOf(start) }
    var e by remember { mutableStateOf(end) }
    LaunchedEffect(start, end) { s = start; e = end }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Quiet hours")
            Muted(if (now) "Now: friends are read-only" else "Friends become read-only in this window")
        }
        Switch(checked = enabled, onCheckedChange = { Hub.setQuiet(enabled = it) })
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(s, { s = it.take(5) }, singleLine = true, isError = !HHMM.matches(s), label = { Text("From") }, modifier = Modifier.weight(1f))
        OutlinedTextField(e, { e = it.take(5) }, singleLine = true, isError = !HHMM.matches(e), label = { Text("To") }, modifier = Modifier.weight(1f))
        SmallKey("Save", enabled = HHMM.matches(s) && HHMM.matches(e) && (s != start || e != end)) { Hub.setQuiet(start = s, end = e) }
    }
}
