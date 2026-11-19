package com.jharokha.owner

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.jharokha.owner.data.Hub

/** Buttons on the notifications (not exported: only this app's PendingIntents reach it). */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val id = i.getStringExtra(EXTRA_ID)
        when (i.action) {
            APPROVE -> id?.let { Hub.decide(it, "approve", i.getStringExtra(EXTRA_ROLE) ?: "viewer") }
            DENY -> id?.let { Hub.decide(it, "deny") }
            CAST_OK -> id?.let { Hub.castDecide(it, true) }
            CAST_NO -> id?.let { Hub.castDecide(it, false) }
            TOGGLE -> Hub.playPause()
            BACK10 -> Hub.seekBy(-10)
            FWD10 -> Hub.seekBy(10)
            STOP -> {
                Hub.background = false
                ctx.stopService(Intent(ctx, LinkService::class.java))
                Hub.toast("Background link off. Turn it on again in ⋯ settings.")
            }
        }
        if (id != null) ctx.getSystemService(NotificationManager::class.java).cancel(LinkService.reqId(id))
    }

    companion object {
        const val APPROVE = "com.jharokha.owner.APPROVE"
        const val DENY = "com.jharokha.owner.DENY"
        const val CAST_OK = "com.jharokha.owner.CAST_OK"
        const val CAST_NO = "com.jharokha.owner.CAST_NO"
        const val TOGGLE = "com.jharokha.owner.TOGGLE"
        const val BACK10 = "com.jharokha.owner.BACK10"
        const val FWD10 = "com.jharokha.owner.FWD10"
        const val STOP = "com.jharokha.owner.STOP"
        private const val EXTRA_ID = "id"
        private const val EXTRA_ROLE = "role"

        fun pending(ctx: Context, action: String, id: String? = null, role: String? = null): PendingIntent {
            val i = Intent(ctx, ActionReceiver::class.java).setAction(action)
                .apply { id?.let { putExtra(EXTRA_ID, it) }; role?.let { putExtra(EXTRA_ROLE, it) } }
            // A distinct request code per (action, id, role) so the extras of one button never overwrite another's.
            val code = (action + (id ?: "") + (role ?: "")).hashCode()
            return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
