package com.truesummary.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CallLog
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.concurrent.Executors

/**
 * Foreground service that monitors call state via:
 *   - TelephonyCallback (Android 12+, API 31)
 *   - PhoneStateListener (Android < 12, deprecated but still functional)
 *
 * Returns START_STICKY so the OS restarts it automatically if killed.
 * Declared with android:foregroundServiceType="dataSync" in AndroidManifest.xml.
 * Uses "dataSync" type so it can start at app launch without an active call and
 * without RECORD_AUDIO — works in all user contexts including Secure Folder.
 */
class CallService : Service() {

    private var telephonyManager: TelephonyManager? = null

    // API 31+ callback handle (stored so we can unregister on destroy)
    private var telephonyCallback: TelephonyCallback? = null

    // Legacy listener handle
    @Suppress("DEPRECATION")
    private var legacyListener: PhoneStateListener? = null

    private var lastState = TelephonyManager.CALL_STATE_IDLE
    private var callAnsweredTimeMs: Long = 0L
    private val mainHandler = Handler(Looper.getMainLooper())

    private companion object {
        const val CHANNEL_ID         = "truesummary_call_detector"
        const val NOTIFICATION_ID    = 1001
        const val INCOMING_CHANNEL_ID = "truesummary_incoming_call"
        const val INCOMING_NOTIF_ID   = 1002
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        telephonyManager = getSystemService(TelephonyManager::class.java)
        createNotificationChannel()
        // API 29+ requires the 3-arg version; dataSync needs no runtime permissions — works in Secure Folder too
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
        registerListener()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        unregisterListener()
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "TrueSummary – מזהה שיחות",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description  = "מנטר מצב שיחות לצורך תיעוד אוטומטי"
                setShowBadge(false)
            }
            val incomingChannel = NotificationChannel(
                INCOMING_CHANNEL_ID,
                "TrueSummary – שיחה נכנסת",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description  = "מציג סיכום שיחה אחרונה בזמן שהטלפון מצלצל"
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
            nm.createNotificationChannel(incomingChannel)
        }
    }

    @Suppress("DEPRECATION")
    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("TrueSummary")
            .setContentText("מזהה שיחות...")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()
    }

    // ── Phone-state listener ──────────────────────────────────────────────────

    private fun registerListener() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            registerTelephonyCallback()
        } else {
            registerLegacyListener()
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun registerTelephonyCallback() {
        val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
            override fun onCallStateChanged(state: Int) {
                handleStateChange(state, null)
            }
        }
        telephonyCallback = cb
        try {
            telephonyManager?.registerTelephonyCallback(
                Executors.newSingleThreadExecutor(), cb
            )
        } catch (_: SecurityException) {
            // READ_PHONE_STATE not granted — service stays alive but won't detect calls
        }
    }

    @Suppress("DEPRECATION")
    private fun registerLegacyListener() {
        val listener = object : PhoneStateListener() {
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                handleStateChange(state, phoneNumber)
            }
        }
        legacyListener = listener
        try {
            telephonyManager?.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
        } catch (_: SecurityException) {
            // READ_PHONE_STATE not granted — service stays alive but won't detect calls
        }
    }

    private fun unregisterListener() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            telephonyCallback?.let { telephonyManager?.unregisterTelephonyCallback(it) }
        } else {
            @Suppress("DEPRECATION")
            legacyListener?.let { telephonyManager?.listen(it, PhoneStateListener.LISTEN_NONE) }
        }
    }

    // ── Incoming call heads-up notification ───────────────────────────────────

    private fun showIncomingCallNotification(phoneNumber: String) {
        val summary = OverlayManager.getLastSummaryForNumber(applicationContext, phoneNumber)
        val contactName = OverlayManager.getContactName(applicationContext, phoneNumber)
        val displayTitle = when {
            contactName != null                -> "📞  $contactName"
            phoneNumber.isBlank()              -> "📞  מספר לא ידוע"
            else                               -> "📞  $phoneNumber"
        }
        val displaySubtext = if (contactName != null) "$phoneNumber · $summary" else summary

        val launchIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, INCOMING_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }.setContentTitle(displayTitle)
         .setContentText(displaySubtext)
         .setStyle(Notification.BigTextStyle().bigText(displaySubtext))
         .setSmallIcon(android.R.drawable.ic_menu_call)
         .setAutoCancel(false)
         .setOngoing(false)
         .setContentIntent(pendingIntent)
         .setFullScreenIntent(pendingIntent, true)   // show on lock screen / over dialer
         .build()

        getSystemService(NotificationManager::class.java)
            .notify(INCOMING_NOTIF_ID, notification)
    }

    private fun cancelIncomingCallNotification() {
        getSystemService(NotificationManager::class.java).cancel(INCOMING_NOTIF_ID)
    }

    // ── Phone number resolution (fallback when screening service is unavailable) ──

    /**
     * Queries Android CallLog for the most recent incoming call within the last [windowMs].
     * Works on API 31+ with READ_CALL_LOG permission as a fallback when
     * TelephonyCallback doesn't provide the number and CallScreeningService isn't active.
     */
    private fun queryCallLogForRecentIncoming(windowMs: Long = 10_000): String? {
        return try {
            val cursor = contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER),
                "${CallLog.Calls.TYPE} = ? AND ${CallLog.Calls.DATE} > ?",
                arrayOf(
                    CallLog.Calls.INCOMING_TYPE.toString(),
                    (System.currentTimeMillis() - windowMs).toString()
                ),
                "${CallLog.Calls.DATE} DESC"
            )
            cursor?.use {
                if (it.moveToFirst()) it.getString(0)?.takeIf { n -> n.isNotBlank() } else null
            }
        } catch (e: Exception) {
            Log.w("TrueSummary", "CallService: CallLog query failed", e)
            null
        }
    }

    /**
     * When RINGING arrives without a phone number (API 31+ without screening role),
     * retry up to 3 times at increasing delays to find the number via SharedPrefs
     * (screening service may fire late) or CallLog query.
     */
    private fun retryResolveNumber(attempt: Int) {
        val delays = longArrayOf(300, 800, 2000)
        if (attempt >= delays.size) return
        mainHandler.postDelayed({
            // Abort if call is no longer ringing
            if (lastState != TelephonyManager.CALL_STATE_RINGING) return@postDelayed

            val prefs = applicationContext.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
            val spNumber = prefs.getString("lastIncomingPhoneNumber", "") ?: ""
            val callLogNumber = if (spNumber.isBlank()) queryCallLogForRecentIncoming() else null
            val found = spNumber.ifBlank { callLogNumber ?: "" }

            if (found.isNotBlank()) {
                Log.d("TrueSummary", "CallService: resolved number on retry #$attempt: $found")
                // Also save to SharedPrefs so OFFHOOK/IDLE and JS can use it
                prefs.edit().putString("lastIncomingPhoneNumber", found).apply()
                OverlayManager.showIncomingCallOverlay(applicationContext, found)
                showIncomingCallNotification(found)
                // Also notify JS layer with the resolved number
                CallDetectorPlugin.instance?.get()?.notifyCallState("RINGING", found, callAnsweredTimeMs)
            } else {
                Log.d("TrueSummary", "CallService: retry #$attempt — number still empty, will retry")
                retryResolveNumber(attempt + 1)
            }
        }, delays[attempt])
    }

    // ── State machine ─────────────────────────────────────────────────────────

    private fun handleStateChange(state: Int, phoneNumber: String?) {
        if (state == lastState) return
        val prevStr = when (lastState) {
            TelephonyManager.CALL_STATE_RINGING  -> "RINGING"
            TelephonyManager.CALL_STATE_OFFHOOK  -> "OFFHOOK"
            else                                  -> "IDLE"
        }
        lastState = state

        val stateStr = when (state) {
            TelephonyManager.CALL_STATE_RINGING  -> "RINGING"
            TelephonyManager.CALL_STATE_OFFHOOK  -> "OFFHOOK"
            else                                  -> "IDLE"
        }

        // Track when the call was answered
        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> callAnsweredTimeMs = System.currentTimeMillis()
            TelephonyManager.CALL_STATE_IDLE    -> {
                // Save for JS to pick up when app comes to foreground (JS may be backgrounded)
                if (callAnsweredTimeMs > 0L) {
                    applicationContext.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
                        .edit().putLong("pendingCallAnsweredTimeMs", callAnsweredTimeMs).apply()
                }
                callAnsweredTimeMs = 0L
            }
        }

        Log.d("TrueSummary", "CallService: $prevStr → $stateStr, callAnsweredTimeMs=$callAnsweredTimeMs, phone=${phoneNumber ?: "none"}")

        // Notify JS layer
        CallDetectorPlugin.instance?.get()?.notifyCallState(stateStr, phoneNumber, callAnsweredTimeMs)

        // Show/hide native overlay + heads-up notification
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> {
                // On API 31+ TelephonyCallback does not provide the phone number.
                // TrueSummaryScreeningService saves the real number to SharedPreferences
                // before TelephonyCallback fires, so we read it as a fallback.
                // Validate the timestamp to avoid using stale data from a previous call.
                val prefs = applicationContext.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
                val storedNumber = prefs.getString("lastIncomingPhoneNumber", "") ?: ""
                val storedTimeMs = prefs.getLong("lastIncomingPhoneNumberTimeMs", 0L)
                val isStale = (System.currentTimeMillis() - storedTimeMs) > 30_000L
                val resolvedNumber = if (!phoneNumber.isNullOrBlank()) phoneNumber
                                     else if (storedNumber.isNotBlank() && !isStale) storedNumber
                                     else ""
                OverlayManager.showIncomingCallOverlay(applicationContext, resolvedNumber)
                showIncomingCallNotification(resolvedNumber)
                // If number is still empty, retry with CallLog + SharedPrefs fallback
                if (resolvedNumber.isBlank()) {
                    retryResolveNumber(0)
                }
            }
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                cancelIncomingCallNotification()
            }
            TelephonyManager.CALL_STATE_IDLE    -> {
                OverlayManager.hideOverlay(applicationContext)
                cancelIncomingCallNotification()
                // Clear ALL stored phone data so stale values don't affect the next call
                applicationContext.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
                    .edit()
                    .remove("lastIncomingPhoneNumber")
                    .remove("lastIncomingPhoneNumberTimeMs")
                    .apply()
                applicationContext.getSharedPreferences("TrueSummary", android.content.Context.MODE_PRIVATE)
                    .edit()
                    .remove("last_screened_phone")
                    .remove("last_screened_phone_time_ms")
                    .apply()
            }
        }
    }
}
