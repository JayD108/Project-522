package com.jharokha.owner.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The dashboard's tokens (app/src/styles.css :root), so the phone matches the wall.
object Jhk {
    val bg = Color(0xFF0D0C0B)
    val card = Color(0xFF1A1815)
    val line = Color(0xFF322D27)
    val ink = Color(0xFFF1E9DC)
    val muted = Color(0xFF9A9083)
    val accent = Color(0xFFE0A458)
    val good = Color(0xFF8CC58C)
    val amber = Color(0xFFE0B458)
    val bad = Color(0xFFE0705A)
}

private val scheme = darkColorScheme(
    primary = Jhk.accent, onPrimary = Color(0xFF1A1206),
    primaryContainer = Color(0xFF3A2A16), onPrimaryContainer = Jhk.ink,
    secondary = Jhk.good, onSecondary = Color(0xFF0B1A0B),
    secondaryContainer = Color(0xFF2A2620), onSecondaryContainer = Jhk.ink,
    background = Jhk.bg, onBackground = Jhk.ink,
    surface = Jhk.bg, onSurface = Jhk.ink,
    surfaceVariant = Jhk.card, onSurfaceVariant = Jhk.muted,
    surfaceContainer = Jhk.card, surfaceContainerHigh = Color(0xFF221F1B), surfaceContainerLow = Color(0xFF15130F),
    outline = Color(0xFF6A6056), outlineVariant = Jhk.line,   // outline: switch tracks and borders that must stay visible
    error = Jhk.bad, onError = Color(0xFF1A0806),
)

@Composable
fun JhkTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
}
