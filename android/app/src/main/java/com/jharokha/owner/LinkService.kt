package com.jharokha.owner

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.IBinder
import com.jharokha.owner.data.Conn
import com.jharokha.owner.data.Hub
import com.jharokha.owner.data.HubEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Keeps the link to the laptop open while the app is closed (Phase 2 of ANDROID.md):
 * one ongoing notification (status + media controls for whatever is playing) and alerts for
 * join / cast requests, finished timers and calendar reminders. Off switch: ⋯ → "Stay connected".
 */
class LinkService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var nm: NotificationManager
    private lateinit var session: MediaSession

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        nm = getSystemService(NotificationManager::class.java)
        createChannels(this)
        session = MediaSession(this, "jharokha").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = Hub.playPause(true)
                override fun onPause() = Hub.playPause(false)
                override fun onFastForward() = Hub.seekBy(10)
                override fun onRewind() = Hub.seekBy(-10)
                override fun onSkipToNext() = Hub.seekBy(10)
                override fun onSkipToPrevious() = Hub.seekBy(-10)
                override fun onSeekTo(pos: Long) = Hub.seekTo(pos / 1000.0)
            })
        }
        startForeground(ONGOING_ID, ongoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        Hub.hold("service")

        // Status + media notification: refresh when anything it shows changes (at most every 0.5 s).
        @OptIn(kotlinx.coroutines.FlowPreview::class)
        scope.launch {
            // Re-post the notification only when something on it changes (connection, title, play/pause).
            // The position moves every second; posting that often makes Android turn on "notification cooldown".
            // Position goes to the MediaSession instead, which the system player reads without a new post.
            combine(Hub.conn, Hub.appState, Hub.media, Hub.fun_, Hub.appHelper) { c, _, _, _, _ ->
                val n = Hub.nowPlaying()
                updateSession(n, c == Conn.Online)
                listOf(statusText(c), n?.title, n?.sub, n?.playing, n?.onWall)
            }.debounce(300).distinctUntilChanged().collect { nm.notify(ONGOING_ID, ongoing()) }
        }
        scope.launch { Hub.events.collect(::alert) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || !Hub.paired) { stopSelf(); return START_NOT_STICKY }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        Hub.release("service")
        session.release()
        super.onDestroy()
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** The always-there notification: connection status, and play/pause/±10 s when something plays. */
    private fun statusText(c: Conn) = when (c) {
        Conn.Online -> "Connected to the laptop"
        Conn.Connecting -> "Connecting…"
        is Conn.Offline -> c.why
        Conn.Unpaired -> "Not paired"
    }

    /** Title, length, position and play state for the system media player (cheap: no notification post). */
    private fun updateSession(n: com.jharokha.owner.data.NowPlaying?, online: Boolean) {
        if (n == null || !online) { session.isActive = false; return }
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, n.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, n.sub)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, (n.dur * 1000).toLong())
                .build()
        )
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND or PlaybackState.ACTION_SEEK_TO or
                        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS
                )
                .setState(if (n.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, (n.pos * 1000).toLong(), if (n.playing) 1f else 0f)
                .build()
        )
        session.isActive = true
    }

    private fun ongoing(): Notification {
        val c = Hub.conn.value
        val status = statusText(c)
        val b = Notification.Builder(this, CH_LINK)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "Disconnect", ActionReceiver.pending(this, ActionReceiver.STOP)).build())
        val n = Hub.nowPlaying()
        updateSession(n, c == Conn.Online)
        if (n == null || c != Conn.Online) return b.setContentTitle("Jharokha").setContentText(status).build()
        return b.setContentTitle(n.title).setContentText(n.sub)
            .setActions(
                Notification.Action.Builder(null, "−10 s", ActionReceiver.pending(this, ActionReceiver.BACK10)).build(),
                Notification.Action.Builder(null, if (n.playing) "Pause" else "Play", ActionReceiver.pending(this, ActionReceiver.TOGGLE)).build(),
                Notification.Action.Builder(null, "+10 s", ActionReceiver.pending(this, ActionReceiver.FWD10)).build(),
            )
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    private fun alert(e: HubEvent) {
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        when (e) {
            is HubEvent.JoinRequest -> {
                if (Hub.uiVisible) return           // the Home tab shows it already
                nm.notify(reqId(e.id), Notification.Builder(this, CH_REQUESTS)
                    .setSmallIcon(R.drawable.ic_stat).setContentTitle("${e.name} wants to join")
                    .setContentText(e.ua ?: "a phone").setContentIntent(openApp()).setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .addAction(Notification.Action.Builder(null, "Collaborator", ActionReceiver.pending(this, ActionReceiver.APPROVE, e.id, "collaborator")).build())
                    .addAction(Notification.Action.Builder(null, "Viewer", ActionReceiver.pending(this, ActionReceiver.APPROVE, e.id, "viewer")).build())
                    .addAction(Notification.Action.Builder(null, "Deny", ActionReceiver.pending(this, ActionReceiver.DENY, e.id)).build())
                    .build())
            }
            is HubEvent.CastRequest -> {
                if (Hub.uiVisible) return
                nm.notify(reqId(e.id), Notification.Builder(this, CH_REQUESTS)
                    .setSmallIcon(R.drawable.ic_stat).setContentTitle("${e.by} wants to show something on the wall")
                    .setContentText(e.title).setContentIntent(openApp()).setAutoCancel(true)
                    .addAction(Notification.Action.Builder(null, "Show on wall", ActionReceiver.pending(this, ActionReceiver.CAST_OK, e.id)).build())
                    .addAction(Notification.Action.Builder(null, "Deny", ActionReceiver.pending(this, ActionReceiver.CAST_NO, e.id)).build())
                    .build())
            }
            is HubEvent.Ding -> {
                if (Hub.uiVisible) return           // a toast was shown instead
                nm.notify(DING_BASE + (e.label.hashCode() and 0xffff), Notification.Builder(this, CH_DINGS)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(if (e.kind == "event") "Reminder: ${e.label}" else "${e.label} is done")
                    .setContentText(if (e.kind == "event") "From the room calendar" else "Laundry timer").setContentIntent(openApp())
                    .setAutoCancel(true).build())
            }
            is HubEvent.Settled -> e.ids.forEach { nm.cancel(reqId(it)) }
        }
    }

    companion object {
        const val ACTION_STOP = "com.jharokha.owner.STOP_LINK"
        private const val ONGOING_ID = 1
        private const val DING_BASE = 0x20000
        const val CH_LINK = "link"
        const val CH_REQUESTS = "requests"
        const val CH_DINGS = "dings"

        fun reqId(id: String) = 0x10000 + (id.hashCode() and 0xffff)

        fun createChannels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannels(listOf(
                NotificationChannel(CH_LINK, "Connection and media", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shows that the phone is connected, with play/pause for what's on the laptop"
                    setShowBadge(false)
                },
                NotificationChannel(CH_REQUESTS, "Join and cast requests", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Someone wants to join the room or show something on the wall"
                },
                NotificationChannel(CH_DINGS, "Timers and reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Laundry timers and room calendar reminders"
                },
            ))
        }

        /** Start (or keep) the background link if the owner wants it. Call from a visible activity. */
        fun sync(ctx: Context) {
            val i = Intent(ctx, LinkService::class.java)
            if (Hub.paired && Hub.background) ctx.startForegroundService(i)
            else ctx.stopService(i)
        }
    }
}
