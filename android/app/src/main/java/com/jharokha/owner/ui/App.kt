package com.jharokha.owner.ui

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jharokha.owner.BuildConfig
import com.jharokha.owner.LinkService
import com.jharokha.owner.data.Conn
import com.jharokha.owner.data.Hub
import kotlinx.coroutines.launch

enum class Tab(val label: String, val glyph: String) {
    Home("Home", "⌂"), Wall("Wall", "▣"), Remote("Remote", "✥"), People("People", "◎"), Tools("Tools", "⏲")
}

/** [onTab] tells the activity which tab is showing (volume keys only control the laptop on Wall / Remote). */
@Composable
fun App(onTab: (Tab) -> Unit) {
    val conn by Hub.conn.collectAsState()
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { Hub.toasts.collect { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show() } }

    if (conn == Conn.Unpaired) { onTab(Tab.Home); PairScreen(); return }

    var tab by rememberSaveable { mutableStateOf(Tab.Home) }
    var settings by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(tab) { onTab(tab) }
    val pending by Hub.access.collectAsState()
    val fun_ by Hub.fun_.collectAsState()
    val waiting = (pending?.pending ?: 0) + (fun_?.casts?.size ?: 0)

    Scaffold(
        containerColor = Jhk.bg,
        topBar = { TopStatus(conn) { settings = true } },
        bottomBar = {
            NavigationBar(containerColor = Jhk.card) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t, onClick = { tab = t },
                        icon = { Text(t.glyph + if (t == Tab.Home && waiting > 0) " $waiting" else "", fontSize = 20.sp) },
                        label = { Text(t.label) },
                        colors = NavigationBarItemDefaults.colors(selectedTextColor = Jhk.accent, indicatorColor = Color(0xFF3A2A16)),
                    )
                }
            }
        },
    ) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OfflineBanner(conn)
            when (tab) {
                Tab.Home -> HomeScreen()
                Tab.Wall -> WallScreen()
                Tab.Remote -> RemoteScreen()
                Tab.People -> PeopleScreen()
                Tab.Tools -> ToolsScreen()
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (settings) SettingsDialog { settings = false }
}

@Composable
private fun TopStatus(conn: Conn, onMenu: () -> Unit) {
    val (dot, text) = when (conn) {
        Conn.Online -> Jhk.good to "Connected"
        Conn.Connecting -> Jhk.amber to "Connecting…"
        is Conn.Offline -> Jhk.bad to "Offline"
        Conn.Unpaired -> Jhk.muted to "Not paired"
    }
    Surface(color = Jhk.bg) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 36.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Jharokha", fontSize = 22.sp, fontWeight = FontWeight.Light, color = Jhk.accent)
            Spacer(Modifier.size(12.dp))
            Box(Modifier.size(9.dp).padding(0.dp)) { Surface(color = dot, shape = CircleShape, modifier = Modifier.fillMaxSize()) {} }
            Spacer(Modifier.size(6.dp))
            Muted(text, Modifier.weight(1f))
            TextButton(onClick = onMenu) { Text("⋯", fontSize = 22.sp, color = Jhk.ink) }
        }
    }
}

@Composable
private fun OfflineBanner(conn: Conn) {
    val off = conn as? Conn.Offline ?: return
    val scan = rememberQrScanner { Hub.onScan(it) }
    Section {
        Text(off.why, color = Jhk.amber)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (off.relocate || Hub.baseUrl?.startsWith("https://") == true) SmallKey("Scan room QR") { scan() }
            SmallKey("Retry now") { Hub.retryNow() }
        }
    }
}

@Composable
private fun SettingsDialog(onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val serverApi by Hub.serverApi.collectAsState()
    val me by Hub.me.collectAsState()
    val scan = rememberQrScanner { Hub.onScan(it); onClose() }
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = onClose, containerColor = Jhk.card,
        title = { Text("This phone") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Stat("Name", me?.name ?: Hub.deviceName)
                Stat("Role", me?.role ?: "?")
                Stat("Laptop", Hub.baseUrl ?: "—")
                Stat("App", "${BuildConfig.VERSION_NAME} · API ${BuildConfig.API_VERSION}")
                Stat("Server API", serverApi?.toString() ?: "?", warn = serverApi != null && serverApi != BuildConfig.API_VERSION)
                if (serverApi != null && serverApi != BuildConfig.API_VERSION) Muted("The app and the laptop speak different API versions; some buttons may not work. Update the one that's older.")
                Spacer(Modifier.height(6.dp))
                var bg by rememberSaveable { mutableStateOf(Hub.background) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Stay connected in the background")
                        Muted("Alerts for join requests and timers, play/pause in the notification shade. Uses a little battery.")
                    }
                    Switch(checked = bg, onCheckedChange = { bg = it; Hub.background = it; LinkService.sync(ctx) })
                }
                SmallKey("Scan room QR (new laptop address)") { scan() }
                SmallKey("Unpair this phone") { confirmUnpair = true }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Close", color = Jhk.accent) } },
    )
    if (confirmUnpair) Confirm(
        "Unpair this phone?", "It stops being an owner and forgets the laptop. To use it again, pair it from the laptop's Access card.", "Unpair",
        onYes = { scope.launch { Hub.unpair(); LinkService.sync(ctx); onClose() } },
    ) { confirmUnpair = false }
}

