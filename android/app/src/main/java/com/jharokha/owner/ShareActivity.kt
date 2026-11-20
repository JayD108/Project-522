package com.jharokha.owner

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.jharokha.owner.data.Conn
import com.jharokha.owner.data.Hub
import com.jharokha.owner.ui.Jhk
import com.jharokha.owner.ui.JhkTheme
import com.jharokha.owner.ui.Muted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * "Share → Jharokha" from any app: a link goes on the wall, opens on the laptop, or joins the watch queue;
 * a photo / video is uploaded to the Drop Zone and shown on the wall.
 */
class ShareActivity : ComponentActivity() {
    private var busy by mutableStateOf<String?>(null)
    private var failed by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
        @Suppress("DEPRECATION")
        val file: Uri? = if (intent.type?.startsWith("text/") == true) null else intent.getParcelableExtra(Intent.EXTRA_STREAM)
        val url = URL.find(text)?.value?.trimEnd('.', ',', ')', '"', '\'')
        val title = subject.trim().take(60)       // empty: the laptop looks up the real title (YouTube oEmbed)

        setContent {
            JhkTheme {
                AlertDialog(
                    onDismissRequest = { if (busy == null) finish() }, containerColor = Jhk.card,
                    title = { Text("Send to the room") },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            when {
                                !Hub.paired -> Text("Pair this phone first: open the Jharokha Owner app.")
                                file != null -> FileChoices(file)
                                url != null -> LinkChoices(url, title)
                                else -> Text("There's no link in what you shared.")
                            }
                            busy?.let { Muted(it); LinearProgressIndicator(Modifier.fillMaxWidth()) }
                            failed?.let { Text(it, color = Jhk.bad) }
                        }
                    },
                    confirmButton = { TextButton(onClick = { finish() }, enabled = busy == null) { Text("Close", color = Jhk.muted) } },
                )
            }
        }
    }

    override fun onStart() { super.onStart(); Hub.hold("share") }
    override fun onStop() { super.onStop(); Hub.release("share"); if (!isChangingConfigurations) finish() }

    @androidx.compose.runtime.Composable
    private fun LinkChoices(url: String, title: String) {
        Text(url, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Jhk.ink)
        val on = busy == null
        Button(onClick = { run("Putting it on the wall…") { post("/api/fun/cast", JSONObject().put("url", url).put("title", title)); "On the wall" } }, enabled = on, modifier = Modifier.fillMaxWidth()) {
            Text("Show on the wall")
        }
        OutlinedButton(onClick = { run("Opening on the laptop…") { openOnLaptop(url, title) } }, enabled = on, modifier = Modifier.fillMaxWidth()) {
            Text("Open on the laptop (Netflix, Prime…)")
        }
        OutlinedButton(onClick = { run("Adding…") { post("/api/fun/queue", JSONObject().put("url", url).put("title", title)); "Added to the watch queue" } }, enabled = on, modifier = Modifier.fillMaxWidth()) {
            Text("Add to the watch queue")
        }
    }

    @androidx.compose.runtime.Composable
    private fun FileChoices(uri: Uri) {
        val (name, size) = meta(uri)
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Jhk.ink)
        Muted(if (size > 0) "%.1f MB · stays on the laptop for 7 days".format(size / 1048576.0) else "stays on the laptop for 7 days")
        val on = busy == null
        Button(onClick = { run("Uploading…") { val id = upload(uri, name, size); post("/api/fun/cast/drop/$id"); "On the wall" } }, enabled = on, modifier = Modifier.fillMaxWidth()) {
            Text("Show on the wall")
        }
        OutlinedButton(onClick = { run("Uploading…") { upload(uri, name, size); "Saved in the Drop Zone" } }, enabled = on, modifier = Modifier.fillMaxWidth()) {
            Text("Just save it on the laptop")
        }
    }

    private fun run(what: String, block: suspend com.jharokha.owner.data.Api.() -> String) {
        busy = what; failed = null
        lifecycleScope.launch {
            val msg = try { Hub.api.block() } catch (e: Exception) { "Failed: ${e.message ?: e.javaClass.simpleName}" }
            busy = null
            if (msg.startsWith("Failed")) failed = msg       // stays in the dialog so it can be read and retried
            else { Toast.makeText(this@ShareActivity, msg, Toast.LENGTH_LONG).show(); finish() }
        }
    }

    /** "Open on PC" is a /ws message: wait (briefly) for the link, then send it. */
    private suspend fun openOnLaptop(url: String, title: String): String {
        if (!url.startsWith("https://")) return "Failed: only https links can open on the laptop"
        withTimeoutOrNull(8000) { Hub.conn.first { it == Conn.Online } } ?: return "Failed: can't reach the laptop"
        return if (Hub.openOnPc(url, title)) "Sent to the laptop" else "Failed: not connected"
    }

    private suspend fun com.jharokha.owner.data.Api.upload(uri: Uri, name: String, size: Long): String {
        val type = contentResolver.getType(uri) ?: "application/octet-stream"
        val r = putFile(name, type, size) { contentResolver.openInputStream(uri) ?: error("can't read the file") }
        return r.optString("id").ifEmpty { error("the laptop didn't keep the file") }
    }

    private fun meta(uri: Uri): Pair<String, Long> {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val n = c.getString(0) ?: "shared-file"
                val s = if (c.isNull(1)) -1L else c.getLong(1)
                return n to s
            }
        }
        return (uri.lastPathSegment ?: "shared-file") to -1L
    }

    private companion object { val URL = Regex("https?://\\S+") }
}
