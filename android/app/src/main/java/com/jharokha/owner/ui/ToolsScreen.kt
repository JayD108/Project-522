package com.jharokha.owner.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jharokha.owner.data.Alarm
import com.jharokha.owner.data.Hub
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

private val HHMM = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
private val DAY_NAMES = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")   // JS getDay(): 0 = Sunday

@Composable
fun ToolsScreen() {
    val t by Hub.tools.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val x = t
        if (x == null) Section { Muted("Waiting for the laptop…") }
        else {
            AlarmCard(x.alarm)
            Timers()
        }
        Section("Laptop data") {
            Muted("A copy of the room database is saved every night at 03:30. Take one now before big changes.")
            SmallKey("Snapshot now") { Hub.snapshotNow() }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AlarmCard(a: Alarm) {
    var on by remember { mutableStateOf(a.on) }
    var time by remember { mutableStateOf(a.time) }
    var days by remember { mutableStateOf(a.days.toSet()) }
    var ramp by remember { mutableStateOf(a.rampMin) }
    var sound by remember { mutableStateOf(a.sound) }
    LaunchedEffect(a) { on = a.on; time = a.time; days = a.days.toSet(); ramp = a.rampMin; sound = a.sound }
    val dirty = on != a.on || time != a.time || days != a.days.toSet() || ramp != a.rampMin || sound != a.sound

    Section("Sunrise alarm", trailing = { Switch(checked = on, onCheckedChange = { on = it }) }) {
        Muted("The wall slowly brightens before the time, then chimes.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(time, { time = it.take(5) }, singleLine = true, isError = !HHMM.matches(time), label = { Text("Time (HH:MM)") }, modifier = Modifier.weight(1f))
            Row(verticalAlignment = Alignment.CenterVertically) { Text("Sound "); Switch(checked = sound, onCheckedChange = { sound = it }) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            DAY_NAMES.forEachIndexed { i, n ->
                FilterChip(selected = i in days, onClick = { days = if (i in days) days - i else days + i }, label = { Text(n) })
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.Center) {
            Muted("Sunrise over ")
            listOf(5, 10, 15, 20, 30).forEach { m -> FilterChip(selected = ramp == m, onClick = { ramp = m }, label = { Text("$m min") }) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = dirty && HHMM.matches(time), onClick = {
                Hub.setAlarm(JSONObject().put("on", on).put("time", time).put("days", JSONArray(days.sorted())).put("rampMin", ramp).put("sound", sound))
            }) { Text("Save") }
            SmallKey("I'm up") { Hub.alarmAction("dismiss") }
            SmallKey("Snooze 9 min") { Hub.alarmAction("snooze") }
            SmallKey("Test") { Hub.alarmAction("test") }
        }
    }
}

@Composable
private fun Timers() {
    val t by Hub.tools.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    var label by remember { mutableStateOf("Washer") }
    val serverNow = t?.serverTime(now) ?: now

    Section("Laundry timers") {
        val list = t?.timers.orEmpty()
        if (list.isEmpty()) Muted("No timers running.")
        list.forEach { x ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(x.label, fontWeight = FontWeight.Medium)
                    val left = (x.endsAt - serverNow) / 1000
                    Muted(if (x.done || left <= 0) "done · by ${x.by}" else "%d:%02d left · by %s".format(left / 60, left % 60, x.by))
                }
                SmallKey(if (x.done) "Clear" else "Cancel") { Hub.cancelTimer(x.id) }
            }
        }
        OutlinedTextField(label, { label = it.take(40) }, singleLine = true, label = { Text("What") }, modifier = Modifier)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf(30, 45, 60, 90).forEach { m -> SmallKey("$m min", enabled = label.isNotBlank()) { Hub.startTimer(label.trim(), m) } }
        }
    }
}
