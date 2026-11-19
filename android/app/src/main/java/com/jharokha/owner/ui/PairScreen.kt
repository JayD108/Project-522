package com.jharokha.owner.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jharokha.owner.data.Hub

@Composable
fun PairScreen() {
    val busy by Hub.pairing.collectAsState()
    val err by Hub.pairError.collectAsState()
    var name by remember { mutableStateOf(Hub.deviceName) }
    var link by remember { mutableStateOf("") }
    val scan = rememberQrScanner { Hub.onScan(it, name) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text("Jharokha", fontSize = 34.sp, fontWeight = FontWeight.Light, color = Jhk.accent)
        Text("Owner controller", style = MaterialTheme.typography.titleMedium)
        Section("Pair this phone") {
            Text("1. On the laptop, open the dashboard → Room tab → Access card.")
            Text("2. Press \"Pair my phone (Android app)\". A QR appears for 10 minutes.")
            Text("3. Scan it here. This phone becomes an owner. It stays signed in as long as you open it at least once a month.")
            Muted("The phone must be on the room's Wi-Fi while pairing. After that it works from anywhere the laptop allows.")
            OutlinedTextField(
                value = name, onValueChange = { name = it.take(32) }, singleLine = true,
                label = { Text("This phone's name (shown on the laptop)") }, modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = scan, enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Text("Scan the pairing QR")
            }
        }
        Section("Or paste the link") {
            OutlinedTextField(
                value = link, onValueChange = { link = it }, singleLine = true,
                label = { Text("jharokha://pair?u=…&c=…") }, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(onClick = { Hub.onScan(link, name) }, enabled = !busy && link.isNotBlank()) { Text("Pair") }
        }
        if (busy) Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(); Muted("Talking to the laptop…")
        }
        err?.let { Text(it, color = Jhk.bad) }
    }
}
