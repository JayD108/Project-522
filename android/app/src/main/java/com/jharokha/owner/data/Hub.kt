package com.jharokha.owner.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.UnknownHostException
import kotlin.math.min

sealed interface Conn {
    data object Unpaired : Conn
    data object Connecting : Conn
    data object Online : Conn
    /** [relocate] = the address itself seems gone (internet link changed): scanning the room QR fixes it. */
    data class Offline(val why: String, val relocate: Boolean = false) : Conn
}

/** Things worth a notification when the app isn't on screen (see LinkService). */
sealed interface HubEvent {
    data class JoinRequest(val id: String, val name: String, val ua: String?) : HubEvent
    data class CastRequest(val id: String, val by: String, val title: String) : HubEvent
    data class Ding(val kind: String, val label: String) : HubEvent
    /** These requests are no longer waiting (approved / denied elsewhere): drop their notifications. */
    data class Settled(val ids: Set<String>) : HubEvent
}

/** Whatever is playing that the phone can control: the streaming tab on the laptop, else a cast on the wall. */
data class NowPlaying(val title: String, val sub: String, val playing: Boolean, val pos: Double, val dur: Double, val onWall: Boolean)

/**
 * The one live link to the laptop: `/ws` for pushes and quick commands, [Api] for everything else.
 * App-wide singleton (the remote, notifications and the UI all share it).
 */
object Hub {
    private lateinit var store: Store
    lateinit var api: Api
        private set
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val conn = MutableStateFlow<Conn>(Conn.Unpaired)
    val me = MutableStateFlow<Me?>(null)
    val vitals = MutableStateFlow<Vitals?>(null)
    val join = MutableStateFlow<JoinInfo?>(null)
    val access = MutableStateFlow<AccessState?>(null)
    val screen = MutableStateFlow<ScreenState?>(null)
    val media = MutableStateFlow<MediaState?>(null)
    val appHelper = MutableStateFlow(false)
    val appState = MutableStateFlow<AppState?>(null)
    val door = MutableStateFlow<Door?>(null)
    val fun_ = MutableStateFlow<FunState?>(null)
    val tools = MutableStateFlow<ToolsState?>(null)
    val serverApi = MutableStateFlow<Int?>(null)

    private val _toasts = MutableSharedFlow<String>(extraBufferCapacity = 8)
    /** Short messages for the user (errors, "dashboard isn't open", timer done…). */
    val toasts: SharedFlow<String> = _toasts

    private val _events = MutableSharedFlow<HubEvent>(extraBufferCapacity = 32)
    val events: SharedFlow<HubEvent> = _events
    private val seenRequests = mutableSetOf<String>()

    val baseUrl: String? get() = store.baseUrl
    val deviceName: String get() = store.deviceName

    private var ws: WebSocket? = null
    private var wanted = false
    private var attempt = 0
    private var retryJob: Job? = null

    fun init(context: Context) {
        if (::store.isInitialized) return
        store = Store(context.applicationContext)
        api = Api({ store.baseUrl }, { store.token })
        conn.value = if (store.paired) Conn.Offline("Not connected yet") else Conn.Unpaired
    }

    fun toast(msg: String) { _toasts.tryEmit(msg) }

    // ------------------------------------------------------------------ lifecycle
    // Who needs the link: "ui" (an activity on screen), "service" (background alerts), "share" (share sheet).
    private val holders = mutableSetOf<String>()
    val uiVisible: Boolean @Synchronized get() = "ui" in holders
    val paired: Boolean get() = store.paired

    var background: Boolean
        get() = store.background
        set(v) { store.background = v }

    @Synchronized fun hold(who: String) { holders += who; start() }
    @Synchronized fun release(who: String) { holders -= who; if (holders.isEmpty()) stop() }

    /** "Retry now": drop the current attempt and dial again at once. */
    @Synchronized fun retryNow() {
        retryJob?.cancel(); ws?.cancel(); ws = null; attempt = 0
        if (holders.isNotEmpty()) start()
    }

    @Synchronized private fun start() {
        wanted = true
        if (!store.paired) { conn.value = Conn.Unpaired; return }
        if (ws == null && retryJob?.isActive != true) connect()
    }

    @Synchronized private fun stop() {
        wanted = false
        retryJob?.cancel()
        ws?.close(1000, "app in background")
        ws = null
    }

    @Synchronized private fun connect() {
        if (!wanted || ws != null || !store.paired) return
        conn.value = Conn.Connecting
        ws = api.http.newWebSocket(api.wsRequest(), Listener())
    }

    @Synchronized private fun reconnectSoon(ms: Long? = null) {
        ws = null
        if (!wanted) return
        val wait = ms ?: min(15_000L, 1000L shl min(attempt, 4))
        attempt++
        retryJob?.cancel()
        retryJob = scope.launch { delay(wait); connect() }
    }

    private class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempt = 0
            conn.value = Conn.Online
            webSocket.send(JSONObject().put("t", "iam").put("role", "room").toString())
            scope.launch { runCatching { serverApi.value = api.get("/api/version").optInt("api") } }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val m = runCatching { JSONObject(text) }.getOrNull() ?: return
            runCatching { handle(m) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket !== ws) return
            when (code) {
                4401 -> scope.launch { checkStillPaired() }
                4000 -> reconnectSoon(200)                       // role changed: come straight back
                4403 -> { conn.value = Conn.Offline("The laptop refused this phone"); reconnectSoon(15_000) }
                else -> { if (wanted) conn.value = Conn.Offline("Connection closed"); reconnectSoon() }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (webSocket !== ws) return
            val code = response?.code
            val why = when {
                t is UnknownHostException -> Conn.Offline("Can't find the laptop's address. If the laptop restarted, scan the room QR.", relocate = true)
                code == 530 || code == 502 || code == 404 -> Conn.Offline("The internet link changed. Scan the room QR on the wall.", relocate = true)
                code == 403 -> Conn.Offline(Api.errorOf(response.peekBody(2048).string(), 403))
                code != null -> Conn.Offline("Laptop answered HTTP $code")
                else -> Conn.Offline("Laptop not reachable (${t.javaClass.simpleName})", relocate = store.baseUrl?.startsWith("https://") == true && attempt >= 3)
            }
            if (code == 403) scope.launch { checkStillPaired() } else { conn.value = why; reconnectSoon() }
        }
    }

    /** /ws closed with "not approved": was this phone removed, or is it just a hiccup? */
    private suspend fun checkStillPaired() {
        val m = runCatching { Me.from(api.get("/api/me")) }.getOrNull()
        if (m != null && m.status == "none") {
            store.forget()
            clearState()
            conn.value = Conn.Unpaired
            toast("This phone was removed from the room. Pair it again from the laptop.")
            synchronized(this) { ws = null }
            return
        }
        conn.value = Conn.Offline(if (m?.owner == false) "This phone is no longer an owner" else "Reconnecting…")
        reconnectSoon(5_000)
    }

    private fun clearState() {
        me.value = null; vitals.value = null; access.value = null; screen.value = null; media.value = null
        appState.value = null; appHelper.value = false; door.value = null; fun_.value = null; tools.value = null
    }

    private fun handle(m: JSONObject) {
        when (m.optString("t")) {
            "hello" -> me.value = m.optJSONObject("me")?.let(Me::from)
            "vitals" -> {
                m.optJSONObject("v")?.let { vitals.value = Vitals.from(it) }
                JoinInfo.from(m.optJSONObject("join"))?.let { join.value = it }
            }
            "access" -> m.optJSONObject("a")?.let { a ->
                val st = AccessState.from(a); access.value = st
                val pending = st.devices.filter { it.status == "pending" }
                pending.filter { seenRequests.add(it.id) }.forEach { _events.tryEmit(HubEvent.JoinRequest(it.id, it.name, it.ua)) }
                settle()
            }
            "screen" -> m.optJSONObject("s")?.let { screen.value = ScreenState.from(it) }
            "media-state" -> media.value = m.optJSONObject("s")?.let(MediaState::from)
            "app-helper" -> appHelper.value = m.optBoolean("on")
            "app-state" -> appState.value = m.optJSONObject("s")?.let(AppState::from)
            "door" -> m.optJSONObject("door")?.let { door.value = Door.from(it) }
            "fun" -> m.optJSONObject("fun")?.let { f ->
                val st = FunState.from(f); fun_.value = st
                st.casts.filter { seenRequests.add(it.id) }.forEach { _events.tryEmit(HubEvent.CastRequest(it.id, it.by, it.title)) }
                settle()
            }
            "tools" -> m.optJSONObject("tools")?.let { tools.value = ToolsState.from(it) }
            "tools-ding" -> {
                val kind = m.optString("kind"); val label = m.optString("label")
                if (uiVisible) toast(if (kind == "event") "Reminder: $label" else "$label is done")
                _events.tryEmit(HubEvent.Ding(kind, label))
            }
            "remote-ack" -> {
                if (m.optString("error") == "read-only") toast("Read-only right now")
                else if (m.optInt("delivered", 1) == 0) toast(
                    if (m.optString("cmd") == "app") "The Jharokha Remote extension isn't connected on the laptop"
                    else "The laptop dashboard isn't open"
                )
            }
            "denied" -> { /* the close (4401) that follows is handled in onClosed */ }
        }
    }

    /** Requests we notified about that are no longer waiting. */
    private fun settle() {
        val waiting = (access.value?.devices?.filter { it.status == "pending" }?.map { it.id }.orEmpty() +
            fun_.value?.casts?.map { it.id }.orEmpty()).toSet()
        val gone = seenRequests.filter { it !in waiting }.toSet()
        if (gone.isNotEmpty()) { seenRequests.removeAll(gone); _events.tryEmit(HubEvent.Settled(gone)) }
    }

    // ------------------------------------------------------------------ pairing
    val pairing = MutableStateFlow(false)
    val pairError = MutableStateFlow<String?>(null)

    /** A scanned QR, a pasted link or a jharokha:// deep link. */
    fun onScan(raw: String, name: String? = null) {
        when (val s = Pairing.parse(raw)) {
            is Scan.Pair -> when {
                store.wasUsed(s.code) && store.paired -> Unit          // the same link handed back by Android: nothing to do
                store.wasUsed(s.code) -> pairError.value = "This pairing QR was already used. Make a new one on the laptop."
                else -> scope.launch {
                    pairing.value = true; pairError.value = null
                    try {
                        pair(s.base, s.code, (name ?: store.deviceName).ifBlank { "Owner phone" })
                        store.markUsed(s.code)
                        toast("Paired. This phone is now an owner.")
                    } catch (e: Exception) {
                        if (e is ApiException && e.code in 400..499) store.markUsed(s.code)   // the laptop said no: the code is spent
                        pairError.value = e.message ?: "Pairing failed"
                    } finally { pairing.value = false }
                }
            }
            is Scan.Relocate ->
                if (store.paired) { relocate(s.base); toast("Laptop address updated") }
                else pairError.value = "That's the room's join QR. On the laptop open Access → \"Pair my phone\" and scan that one."
            is Scan.Invalid -> if (store.paired) toast(s.why) else pairError.value = s.why
        }
    }

    suspend fun pair(base: String, code: String, name: String) {
        val token = api.pair(base, code, name)
        stop()
        store.baseUrl = base
        store.deviceName = name
        store.token = token
        clearState()
        start()
    }

    /** New address for the same laptop (from the room QR); the token stays. */
    fun relocate(base: String) {
        stop()
        store.baseUrl = base
        attempt = 0
        start()
    }

    suspend fun unpair() {
        runCatching { api.post("/api/leave") }
        stop()
        store.forget()
        clearState()
        conn.value = Conn.Unpaired
    }

    // ------------------------------------------------------------------ quick commands over /ws
    private fun send(o: JSONObject): Boolean {
        val ok = ws?.send(o.toString()) ?: false
        if (!ok) toast("Not connected to the laptop")
        return ok
    }

    /** Dashboard (W-A): swap | cinema | night | showcase | stack | wallpaper (next|prev|id) | scene (key). */
    fun remote(cmd: String, arg: Any? = null) = send(JSONObject().put("t", "remote").put("cmd", cmd).put("arg", arg ?: JSONObject.NULL))

    /** A cast on the wall: toggle | play | pause | seek (±s) | seekTo | volume (0–100) | mute | unmute | stop. */
    fun media(cmd: String, arg: Number? = null) = send(JSONObject().put("t", "media").put("cmd", cmd).apply { if (arg != null) put("arg", arg) })

    /** The Netflix / YouTube tab (via the extension); see server appArg() for the shapes. */
    fun app(cmd: String, arg: Any? = null) = send(JSONObject().put("t", "app").put("cmd", cmd).apply { if (arg != null) put("arg", arg) })

    fun move(dx: Int, dy: Int) = ws?.send(JSONObject().put("t", "app").put("cmd", "move").put("arg", JSONObject().put("dx", dx).put("dy", dy)).toString())
    fun scroll(dy: Int) = ws?.send(JSONObject().put("t", "app").put("cmd", "scroll").put("arg", JSONObject().put("dx", 0).put("dy", dy)).toString())

    /**
     * Hardware volume keys while a remote screen is open: the streaming tab if it has a video, else a cast on the wall.
     * Returns false when there is nothing to control (the phone's own volume changes as usual).
     */
    fun volumeStep(delta: Int): Boolean {
        val a = appState.value?.video
        if (appHelper.value && a != null) {
            val v = (a.vol + delta).coerceIn(0, 100)
            appState.value = appState.value?.copy(video = a.copy(vol = v))
            return app("volume", v)
        }
        val md = media.value
        if (md != null && fun_.value?.casting != null) {
            val v = (md.vol + delta).coerceIn(0, 100)
            media.value = md.copy(vol = v)
            return media("volume", v)
        }
        return false
    }

    fun nowPlaying(): NowPlaying? {
        val a = appState.value
        if (appHelper.value && a?.video != null) {
            return NowPlaying(a.title.ifEmpty { a.site }, "${a.site} on the laptop", a.video.playing, a.video.t, a.video.d, onWall = false)
        }
        val c = fun_.value?.casting
        val md = media.value
        if (c != null && md != null) return NowPlaying(c.title.ifEmpty { "On the wall" }, "On the wall" + (c.by?.let { " · by $it" } ?: ""), md.playing, md.t, md.d, onWall = true)
        return null
    }

    fun playPause(play: Boolean? = null) {
        val n = nowPlaying() ?: return
        val cmd = when (play) { true -> "play"; false -> "pause"; null -> "toggle" }
        if (n.onWall) media(cmd) else app(cmd)
    }

    fun seekBy(sec: Int) { val n = nowPlaying() ?: return; if (n.onWall) media("seek", sec) else app("seek", sec) }
    fun seekTo(sec: Double) { val n = nowPlaying() ?: return; if (n.onWall) media("seekTo", sec) else app("seekTo", sec) }

    // ------------------------------------------------------------------ REST actions (errors become toasts)
    fun act(what: String, block: suspend Api.() -> Unit) {
        scope.launch {
            try { api.block() } catch (e: Exception) { toast("$what: ${e.message ?: e.javaClass.simpleName}") }
        }
    }

    fun decide(id: String, action: String, role: String? = null) =
        act("Access") { post("/api/devices/$id/$action", JSONObject().apply { if (role != null) put("role", role) }) }
    fun setKill(on: Boolean) = act("Kill switch") { post("/api/kill", JSONObject().put("on", on)) }
    fun setQuiet(enabled: Boolean? = null, start: String? = null, end: String? = null) = act("Quiet hours") {
        post("/api/quiet", JSONObject().apply { enabled?.let { put("enabled", it) }; start?.let { put("start", it) }; end?.let { put("end", it) } })
    }
    fun setNetMode(mode: String) = act("Who can connect") { post("/api/netguard", JSONObject().put("mode", mode)) }
    fun setTunnel(on: Boolean) = act("Internet sharing") { post("/api/tunnel", JSONObject().put("on", on)) }
    fun setDoor(status: String, note: String) = act("Door sign") { post("/api/door", JSONObject().put("status", status).put("note", note)) }
    fun castDecide(id: String, approve: Boolean) = act("Cast") { post("/api/fun/cast/$id/${if (approve) "approve" else "deny"}") }
    fun castStop() = act("Stop cast") { post("/api/fun/cast/stop") }
    fun castLink(url: String) = act("Cast") { post("/api/fun/cast", JSONObject().put("url", url)) }
    fun openOnPc(url: String, title: String = "") = send(JSONObject().put("t", "open-request").put("url", url).put("title", title.take(60)))
    fun setAlarm(a: JSONObject) = act("Alarm") { post("/api/tools/alarm", a) }
    fun alarmAction(action: String) = act("Alarm") { post("/api/tools/alarm/$action") }
    fun startTimer(label: String, minutes: Int) = act("Timer") { post("/api/tools/timer", JSONObject().put("label", label).put("minutes", minutes)) }
    fun cancelTimer(id: String) = act("Timer") { delete("/api/tools/timer/$id") }
    fun snapshotNow() = act("Snapshot") { post("/api/system/backups"); toast("Snapshot saved on the laptop") }
}
