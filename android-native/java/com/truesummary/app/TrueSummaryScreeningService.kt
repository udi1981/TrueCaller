package com.truesummary.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import androidx.annotation.RequiresApi

/**
 * CallScreeningService — requires ROLE_CALL_SCREENING granted by the user.
 *
 * Why this exists alongside CallService:
 *   1. Android 12+ TelephonyCallback does NOT pass the phone number for privacy reasons.
 *      This service provides the accurate number via callDetails.handle.
 *   2. It detects OUTGOING calls, which TelephonyCallback doesn't expose directly.
 *
 * CRITICAL: respondToCall() MUST be called within 5 seconds or Android rejects the call.
 * All heavy work (DB lookups, network) must happen OUTSIDE this method.
 * We only emit a lightweight event here and respond immediately.
 *
 * This service is also responsible for showing the incoming-call overlay and heads-up
 * notification with the REAL phone number + last call summary, since CallService's
 * TelephonyCallback does not receive the phone number on API 31+.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class TrueSummaryScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val direction = when (callDetails.callDirection) {
            Call.Details.DIRECTION_INCOMING -> "incoming"
            Call.Details.DIRECTION_OUTGOING -> "outgoing"
            else                            -> "incoming"
        }

        val phoneNumber = callDetails.handle?.schemeSpecificPart ?: ""

        // Notify JS — this is fast (just puts data on an event bus)
        CallDetectorPlugin.instance?.get()
            ?.notifyCallScreened(phoneNumber, direction)

        // Save phone number so CallService can use it even if the screening role is revoked later.
        // TelephonyCallback on API 31+ never provides the number, so this SharedPreference is
        // the only reliable way to get the real caller number into CallService.
        if (phoneNumber.isNotBlank()) {
            applicationContext.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
                .edit()
                .putString("lastIncomingPhoneNumber", phoneNumber)
                .putLong("lastIncomingPhoneNumberTimeMs", System.currentTimeMillis())
                .apply()
        }

        // For incoming calls: show overlay + heads-up notification with real phone number.
        // CallService's TelephonyCallback fires AFTER this and won't have the phone number
        // on API 31+, so this is the authoritative place to show the summary.
        if (direction == "incoming" && phoneNumber.isNotBlank()) {
            OverlayManager.showIncomingCallOverlay(applicationContext, phoneNumber)
            postIncomingCallNotification(phoneNumber)
        }

        // MUST respond immediately — never block, never reject
        respondToCall(
            callDetails,
            CallResponse.Builder()
                .setDisallowCall(false)
                .setRejectCall(false)
                .setSkipCallLog(false)
                .setSkipNotification(false)
                .build()
        )
    }

    // ── Heads-up notification ─────────────────────────────────────────────────

    private fun postIncomingCallNotification(phoneNumber: String) {
        val nm = getSystemService(NotificationManager::class.java) ?: return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                INCOMING_CHANNEL_ID,
                "TrueSummary – שיחה נכנסת",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                enableVibration(false)
                setSound(null, null)
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }

        val summary = OverlayManager.getLastSummaryForNumber(applicationContext, phoneNumber)
        val contactName = OverlayManager.getContactName(applicationContext, phoneNumber)
        val displayTitle = if (contactName != null) "📞  $contactName" else "📞  $phoneNumber"
        val displaySubtext = if (contactName != null) "$phoneNumber · $summary" else summary

        // Tap / full-screen intent → open the app so the React overlay shows
        val launchIntent = Intent(applicationContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            applicationContext, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, INCOMING_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }

        builder
            .setContentTitle(displayTitle)
            .setContentText(displaySubtext)
            .setStyle(Notification.BigTextStyle().bigText(displaySubtext))
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setAutoCancel(false)
            .setOngoing(false)
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true)   // opens app on screen-on / lock screen

        nm.notify(INCOMING_NOTIF_ID, builder.build())
    }

    companion object {
        const val INCOMING_CHANNEL_ID = "truesummary_incoming_call"
        const val INCOMING_NOTIF_ID   = 1002
    }
}
