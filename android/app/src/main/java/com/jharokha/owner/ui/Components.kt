package com.jharokha.owner.ui

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.jharokha.owner.data.Hub

@Composable
fun Section(title: String? = null, trailing: (@Composable () -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = Jhk.card, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Jhk.line),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (title != null || trailing != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (title != null) Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    trailing?.invoke()
                }
            }
            content()
        }
    }
}

@Composable
fun Muted(text: String, modifier: Modifier = Modifier, center: Boolean = false) =
    Text(text, color = Jhk.muted, fontSize = 13.sp, modifier = modifier, textAlign = if (center) TextAlign.Center else null)

/** One haptic tick, like a TV remote button. */
@Composable
fun rememberTick(): () -> Unit {
    val view = LocalView.current
    return { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }
}

/** A big square-ish remote key; [on] = the mode it toggles is active right now. */
@Composable
fun BigKey(label: String, modifier: Modifier = Modifier, on: Boolean = false, enabled: Boolean = true, sub: String? = null, onClick: () -> Unit) {
    val tick = rememberTick()
    val colors = if (on) ButtonDefaults.buttonColors(containerColor = Jhk.accent, contentColor = Color(0xFF1A1206))
    else ButtonDefaults.buttonColors(containerColor = Color(0xFF26221D), contentColor = Jhk.ink)
    Button(
        onClick = { tick(); onClick() }, enabled = enabled, colors = colors, shape = RoundedCornerShape(14.dp),
        contentPadding = PaddingValues(8.dp), modifier = modifier.heightIn(min = 64.dp),
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, fontSize = 17.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
            if (sub != null) Text(sub, fontSize = 11.sp, textAlign = TextAlign.Center)
        }
    }
}

@Composable
fun SmallKey(label: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val tick = rememberTick()
    OutlinedButton(
        onClick = { tick(); onClick() }, enabled = enabled, modifier = modifier,
        border = BorderStroke(1.dp, Jhk.line), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
    ) { Text(label, color = if (enabled) Jhk.ink else Jhk.muted) }
}

@Composable
fun Confirm(title: String, text: String, yes: String, onYes: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) }, text = { Text(text) },
        confirmButton = { TextButton(onClick = { onDismiss(); onYes() }) { Text(yes, color = Jhk.accent) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Jhk.muted) } },
        containerColor = Jhk.card,
    )
}

/** Google's QR scanner (no CAMERA permission for this app; Play services shows the camera). */
@Composable
fun rememberQrScanner(onResult: (String) -> Unit): () -> Unit {
    val ctx = LocalContext.current
    return {
        val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(ctx, opts).startScan()
            .addOnSuccessListener { b -> b.rawValue?.let(onResult) }
            .addOnFailureListener { e -> Hub.toast("Scanner unavailable: ${e.message}. Paste the link instead.") }
    }
}

fun fmtUptime(s: Long): String = when {
    s < 3600 -> "${s / 60} min"
    s < 86400 -> "${s / 3600} h ${(s % 3600) / 60} min"
    else -> "${s / 86400} d ${(s % 86400) / 3600} h"
}

fun fmtClock(sec: Double): String {
    val s = sec.toLong().coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s % 3600) / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

fun ago(t: Long?): String {
    if (t == null || t == 0L) return "—"
    val s = (System.currentTimeMillis() - t) / 1000
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600} h ago"
        else -> "${s / 86400} d ago"
    }
}
