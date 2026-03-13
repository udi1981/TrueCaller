package com.truesummary.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Settings
import com.getcapacitor.JSArray
import android.telecom.TelecomManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.lang.ref.WeakReference

@CapacitorPlugin(
    name = "CallDetector",
    permissions = [
        Permission(strings = [Manifest.permission.READ_PHONE_STATE], alias = "readPhoneState"),
        Permission(strings = [Manifest.permission.READ_CALL_LOG],    alias = "readCallLog"),
        Permission(strings = [Manifest.permission.RECORD_AUDIO],     alias = "recordAudio"),
        Permission(strings = [Manifest.permission.READ_CONTACTS],    alias = "readContacts"),
    ]
)
class CallDetectorPlugin : Plugin() {

    companion object {
        /** Weak reference so CallService can emit events back to JS without leaking the plugin. */
        var instance: WeakReference<CallDetectorPlugin>? = null
        private const val REQUEST_CALL_SCREENING_ROLE = 1001
    }

    override fun load() {
        super.load()
        instance = WeakReference(this)
    }

    // ── Plugin methods exposed to JavaScript ──────────────────────────────────

    @PluginMethod
    fun startCallDetection(call: PluginCall) {
        val intent = Intent(context, CallService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        call.resolve()
    }

    @PluginMethod
    fun stopCallDetection(call: PluginCall) {
        context.stopService(Intent(context, CallService::class.java))
        call.resolve()
    }

    /**
     * Opens the system "Draw over other apps" settings screen so the user can
     * grant SYSTEM_ALERT_WINDOW permission — required for the lock-screen overlay.
     */
    @PluginMethod
    fun requestOverlayPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}")
            ).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
            context.startActivity(intent)
        }
        call.resolve()
    }

    /**
     * Requests the ROLE_CALL_SCREENING role (Android 10+).
     * This gives us accurate phone numbers for incoming calls and lets us
     * observe outgoing calls via TrueSummaryScreeningService.
     */
    @PluginMethod
    fun requestCallScreeningRole(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = context.getSystemService(android.app.role.RoleManager::class.java)
            if (roleManager != null &&
                !roleManager.isRoleHeld(android.app.role.RoleManager.ROLE_CALL_SCREENING)) {
                val roleIntent = roleManager.createRequestRoleIntent(
                    android.app.role.RoleManager.ROLE_CALL_SCREENING
                )
                activity?.startActivityForResult(roleIntent, REQUEST_CALL_SCREENING_ROLE)
            }
        }
        call.resolve()
    }

    // ── Called from native (CallService / TrueSummaryScreeningService) ────────

    /** Emit a call-state-change event to JS. */
    fun notifyCallState(state: String, phoneNumber: String?, callAnsweredTimeMs: Long = 0L) {
        val data = JSObject()
        data.put("state",              state)
        data.put("phoneNumber",        phoneNumber)
        data.put("callAnsweredTimeMs", callAnsweredTimeMs)
        notifyListeners("callStateChanged", data)
    }

    /** Emit a call-screened event (accurate number from CallScreeningService) to JS. */
    fun notifyCallScreened(phoneNumber: String, direction: String) {
        // Persist so RecordingWatcherPlugin can find the number if filename lacks it
        // Also store timestamp so consumers can reject stale values
        context.getSharedPreferences("TrueSummary", android.content.Context.MODE_PRIVATE)
            .edit()
            .putString("last_screened_phone", phoneNumber)
            .putLong("last_screened_phone_time_ms", System.currentTimeMillis())
            .apply()

        val data = JSObject()
        data.put("phoneNumber", phoneNumber)
        data.put("direction",   direction)
        notifyListeners("callScreened", data)
    }

    /**
     * Returns the callAnsweredTimeMs saved by CallService when IDLE fired while
     * JS was backgrounded. Returns 0 if no pending call exists.
     */
    @PluginMethod
    fun getPendingCallTime(call: PluginCall) {
        val prefs = context.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
        val ts = prefs.getLong("pendingCallAnsweredTimeMs", 0L)
        val ret = JSObject()
        ret.put("callAnsweredTimeMs", ts)
        call.resolve(ret)
    }

    @PluginMethod
    fun listRecentRecordings(call: PluginCall) {
        val sinceMs = call.getLong("sinceMs") ?: (System.currentTimeMillis() - 7 * 24 * 3600 * 1000L)
        Thread {
            val recordings = SamsungRecordingReader.listRecentRecordings(context, sinceMs)
            val arr = JSArray()
            for (rec in recordings) {
                val obj = JSObject()
                obj.put("name",        rec["name"] as String)
                obj.put("dateAddedMs", rec["dateAddedMs"] as Long)
                obj.put("sizeBytes",   rec["sizeBytes"] as Long)
                arr.put(obj)
            }
            val ret = JSObject()
            ret.put("recordings", arr)
            call.resolve(ret)
        }.start()
    }

    @PluginMethod
    fun getRecordingAt(call: PluginCall) {
        val dateAddedMs = call.getLong("dateAddedMs") ?: run {
            call.reject("dateAddedMs required"); return
        }
        Thread {
            val result = SamsungRecordingReader.findRecordingAt(context, dateAddedMs)
            if (result == null) {
                call.reject("RECORDING_NOT_FOUND"); return@Thread
            }
            val (uri, mimeType) = result
            val base64 = SamsungRecordingReader.readAsBase64(context, uri)
            if (base64 == null) {
                call.reject("RECORDING_READ_FAILED"); return@Thread
            }
            val data = JSObject()
            data.put("base64",   base64)
            data.put("mimeType", mimeType)
            call.resolve(data)
        }.start()
    }

    @PluginMethod
    fun requestIgnoreBatteryOptimizations(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = context.getSystemService(PowerManager::class.java)
            if (pm != null && !pm.isIgnoringBatteryOptimizations(context.packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${context.packageName}")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                } catch (_: Exception) {
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:${context.packageName}")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                }
            }
        }
        call.resolve()
    }

    /** Clears the pending call timestamp after JS has processed it. */
    @PluginMethod
    fun clearPendingCallTime(call: PluginCall) {
        context.getSharedPreferences("TrueSummaryPending", android.content.Context.MODE_PRIVATE)
            .edit().remove("pendingCallAnsweredTimeMs").apply()
        call.resolve()
    }

    /**
     * Searches MediaStore for the latest call recording that started at or after
     * [callStartTimeMs] and returns it as a Base64 string + MIME type.
     * Runs on a background thread to avoid blocking the main thread.
     */
    @PluginMethod
    fun getLatestRecording(call: PluginCall) {
        val callStartTimeMs = call.getLong("callStartTimeMs", 0L) ?: 0L
        if (callStartTimeMs == 0L) {
            call.reject("callStartTimeMs required")
            return
        }
        Thread {
            val result = SamsungRecordingReader.findLatestCallRecording(context, callStartTimeMs)
            if (result == null) {
                call.reject("NO_RECORDING_FOUND")
                return@Thread
            }
            val (uri, mimeType) = result
            val base64 = SamsungRecordingReader.readAsBase64(context, uri)
            if (base64 == null) {
                call.reject("RECORDING_READ_FAILED")
                return@Thread
            }
            val data = JSObject()
            data.put("base64",   base64)
            data.put("mimeType", mimeType)
            call.resolve(data)
        }.start()
    }

    /**
     * Searches MediaStore for a call recording within a time range [startMs, endMs] (millis).
     * Use this to re-fetch a recording for a previously saved call using its recording_timestamp_ms.
     */
    @PluginMethod
    fun getRecordingByTimeRange(call: PluginCall) {
        val startMs = call.getLong("startMs", 0L) ?: 0L
        val endMs   = call.getLong("endMs", System.currentTimeMillis()) ?: System.currentTimeMillis()
        Thread {
            val result = SamsungRecordingReader.findRecordingInRange(context, startMs, endMs)
            if (result == null) {
                call.reject("RECORDING_NOT_FOUND"); return@Thread
            }
            val (uri, mimeType) = result
            val base64 = SamsungRecordingReader.readAsBase64(context, uri)
            if (base64 == null) {
                call.reject("RECORDING_READ_FAILED"); return@Thread
            }
            val data = JSObject()
            data.put("base64",   base64)
            data.put("mimeType", mimeType)
            call.resolve(data)
        }.start()
    }

    /**
     * Queries the Android Call Log for a call near [dateMs] (±30 s window).
     * Returns the closest match by timestamp to avoid picking the wrong call.
     * Returns { phoneNumber: string } if found, or { phoneNumber: "" } if not.
     */
    @PluginMethod
    fun getCallLogNumber(call: PluginCall) {
        val dateMs = call.getLong("dateMs") ?: run {
            call.resolve(JSObject().apply { put("phoneNumber", "") }); return
        }
        val windowMs = 30_000L
        Thread {
            var phone = ""
            var bestDiff = Long.MAX_VALUE
            try {
                val selection = "${CallLog.Calls.DATE} BETWEEN ? AND ?"
                val args = arrayOf(
                    (dateMs - windowMs).toString(),
                    (dateMs + windowMs).toString()
                )
                context.contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE),
                    selection, args,
                    "${CallLog.Calls.DATE} DESC"
                )?.use { cursor ->
                    val numIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                    val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)
                    while (cursor.moveToNext()) {
                        val num = cursor.getString(numIdx)
                        val callDate = cursor.getLong(dateIdx)
                        val diff = Math.abs(callDate - dateMs)
                        if (!num.isNullOrBlank() && diff < bestDiff) {
                            bestDiff = diff
                            phone = num
                        }
                    }
                }
            } catch (_: Exception) { /* permission not granted */ }
            val ret = JSObject()
            ret.put("phoneNumber", phone)
            call.resolve(ret)
        }.start()
    }

    /**
     * Looks up the display name for [phone] in Android Contacts.
     * Returns { name: string } if found, or {} if not found / permission not granted.
     */
    @PluginMethod
    fun lookupContactName(call: PluginCall) {
        val phone = call.getString("phone") ?: run { call.resolve(JSObject()); return }
        Thread {
            val uri = android.net.Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                android.net.Uri.encode(phone)
            )
            val name: String? = try {
                context.contentResolver.query(
                    uri,
                    arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                    null, null, null
                )?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }
            } catch (_: Exception) { null }
            val ret = JSObject()
            if (name != null) ret.put("name", name)
            call.resolve(ret)
        }.start()
    }


}
