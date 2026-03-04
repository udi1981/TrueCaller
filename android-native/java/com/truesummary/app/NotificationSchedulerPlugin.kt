package com.truesummary.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "NotificationScheduler")
class NotificationSchedulerPlugin : Plugin() {

    @PluginMethod
    fun scheduleNotification(call: PluginCall) {
        val id          = call.getInt("id") ?: return call.reject("Missing id")
        val title       = call.getString("title") ?: "TrueSummary"
        val body        = call.getString("body") ?: ""
        val triggerAtMs = call.getLong("triggerAtMs") ?: return call.reject("Missing triggerAtMs")

        val context = context ?: return call.reject("No context")
        val intent  = makeIntent(context, id, title, body)
        val pending = PendingIntent.getBroadcast(
            context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Inexact alarm — no SCHEDULE_EXACT_ALARM permission needed
        alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pending)

        call.resolve()
    }

    @PluginMethod
    fun cancelNotification(call: PluginCall) {
        val id      = call.getInt("id") ?: return call.reject("Missing id")
        val context = context ?: return call.reject("No context")
        val intent  = makeIntent(context, id, "", "")
        val pending = PendingIntent.getBroadcast(
            context, id, intent,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        ) ?: return call.resolve() // already cancelled

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pending)
        pending.cancel()
        call.resolve()
    }

    private fun makeIntent(context: Context, id: Int, title: String, body: String): Intent {
        return Intent(context, NotificationReceiver::class.java).apply {
            action = "com.truesummary.app.NOTIFY"
            putExtra("notification_id", id)
            putExtra("title", title)
            putExtra("body", body)
        }
    }
}
