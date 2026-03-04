package com.truesummary.app

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.FileObserver
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.io.File
import java.io.FileInputStream

/**
 * Watches the Samsung built-in recorder output folder.
 * When a new .m4a file is written after a call, reads it, base64-encodes it,
 * and emits a "recordingReady" event to the JS layer for Gemini processing.
 *
 * Samsung Galaxy saves call recordings to:
 *   /storage/emulated/0/Recordings/Call/
 * Filename format (unknown number):
 *   20240615_143022_+821012345678.m4a
 *   0501234567_20240615_143022.m4a
 */
@CapacitorPlugin(
    name = "RecordingWatcher",
    permissions = [
        Permission(strings = [Manifest.permission.READ_MEDIA_AUDIO],    alias = "readMediaAudio"),
        Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "readExternalStorage"),
    ]
)
class RecordingWatcherPlugin : Plugin() {

    private var fileObserver: FileObserver? = null

    companion object {
        const val RECORDINGS_PATH = "/storage/emulated/0/Recordings/Call"
        const val PREFS_NAME     = "TrueSummary"
        const val PREFS_KEY_PHONE = "last_screened_phone"
    }

    @PluginMethod
    fun startWatcher(call: PluginCall) {
        val dir = File(RECORDINGS_PATH)
        if (!dir.exists()) {
            // Folder may not exist until first recording is made
            dir.mkdirs()
        }

        fileObserver?.stopWatching()

        fileObserver = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            object : FileObserver(dir, CLOSE_WRITE) {
                override fun onEvent(event: Int, path: String?) = handleNewFile(path)
            }
        } else {
            @Suppress("DEPRECATION")
            object : FileObserver(RECORDINGS_PATH, CLOSE_WRITE) {
                override fun onEvent(event: Int, path: String?) = handleNewFile(path)
            }
        }

        fileObserver!!.startWatching()
        Log.d("TrueSummary", "RecordingWatcher: startWatcher watching $RECORDINGS_PATH")
        call.resolve()
    }

    @PluginMethod
    fun stopWatcher(call: PluginCall) {
        fileObserver?.stopWatching()
        fileObserver = null
        call.resolve()
    }

    private fun handleNewFile(path: String?) {
        Log.d("TrueSummary", "RecordingWatcher handleNewFile: path=$path")
        if (path == null) return
        val lower = path.lowercase()
        if (!lower.endsWith(".m4a") && !lower.endsWith(".mp3") && !lower.endsWith(".aac") && !lower.endsWith(".amr")) {
            Log.d("TrueSummary", "RecordingWatcher: skipping $path (extension not audio)")
            return
        }

        // CLOSE_WRITE means file is already closed — short delay as safety buffer
        Thread.sleep(200)

        val file = File(RECORDINGS_PATH, path)
        Log.d("TrueSummary", "RecordingWatcher: file exists=${file.exists()}, size=${file.length()} bytes")
        if (!file.exists() || file.length() == 0L) return

        try {
            val bytes = FileInputStream(file).use { it.readBytes() }
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

            val mimeType = when {
                lower.endsWith(".m4a") -> "audio/mp4"
                lower.endsWith(".mp3") -> "audio/mpeg"
                lower.endsWith(".amr") -> "audio/amr"
                else                   -> "audio/aac"
            }

            // Phone number: try to parse from Samsung filename, fall back to SharedPrefs
            val phoneNumber =
                extractPhoneNumber(path)
                    ?: context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(PREFS_KEY_PHONE, "") ?: ""

            Log.d("TrueSummary", "RecordingWatcher: emitting recordingReady: fileName=$path, mimeType=$mimeType, base64.length=${base64.length}")

            val result = JSObject()
            result.put("base64",      base64)
            result.put("mimeType",    mimeType)
            result.put("phoneNumber", phoneNumber)
            result.put("fileName",    path)

            notifyListeners("recordingReady", result)

        } catch (e: Exception) {
            Log.e("TrueSummary", "RecordingWatcher handleNewFile error: ${e.message}", e)
            val err = JSObject()
            err.put("error", e.message ?: "Failed to read recording")
            notifyListeners("recordingError", err)
        }
    }

    /**
     * Samsung One UI filename formats:
     *   20240615_143022_+821012345678.m4a  → phone at end
     *   +821012345678_20240615_143022.m4a  → phone at start
     *   0501234567_20240615_143022.m4a     → digits-only at start
     */
    private fun extractPhoneNumber(filename: String): String? {
        val nameWithoutExt = filename.substringBeforeLast(".")
        val phonePattern   = Regex("^[+]?[0-9]{7,15}$")
        for (part in nameWithoutExt.split("_")) {
            val cleaned = part.replace(Regex("[\\s\\-()]"), "")
            if (phonePattern.matches(cleaned)) return cleaned
        }
        return null
    }

    override fun handleOnDestroy() {
        fileObserver?.stopWatching()
        fileObserver = null
    }
}
