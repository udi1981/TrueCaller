package com.truesummary.app

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import android.util.Log

/**
 * Utility object that locates the latest call recording saved by Samsung's
 * built-in call recorder and reads it as a Base64 string for Gemini processing.
 *
 * No Capacitor dependency — can be called from any thread.
 */
object SamsungRecordingReader {

    /**
     * Returns true only if the file looks like a phone call recording.
     *
     * Samsung stores call recordings in paths such as:
     *   "Recordings/Call recordings/"  or  "Call recordings/"
     *
     * WhatsApp voice notes live under "WhatsApp/…" or "Android/media/com.whatsapp/…".
     * Music, podcasts, etc. live under "Music/", "Podcasts/", "Download/", etc.
     *
     * Rules (any one match → true):
     *   • relativePath (lowercased) contains "call"
     *   • relativePath contains "record" AND does NOT contain "whatsapp", "telegram", "viber"
     *   • relativePath is null/empty AND displayName (lowercased) contains "call" or "record"
     *
     * Rules that always reject:
     *   • path contains "whatsapp", "telegram", "viber", "music", "podcast", "download"
     */
    private fun isCallRecording(displayName: String, relativePath: String?): Boolean {
        val nameLower = displayName.lowercase()
        val pathLower = relativePath?.lowercase() ?: ""

        // Hard exclusions — messenger voice notes, music, downloads
        val excluded = listOf("whatsapp", "telegram", "viber", "music", "podcast", "download", "ringtone", "notification")
        if (excluded.any { pathLower.contains(it) || nameLower.contains(it) }) {
            Log.d("TrueSummary", "SamsungRecordingReader: excluded $displayName (non-call path: $relativePath)")
            return false
        }

        // Path-based detection (API 29+)
        if (pathLower.isNotEmpty()) {
            if (pathLower.contains("call")) return true
            if (pathLower.contains("record")) return true
        }

        // Filename fallback (pre-API-29 or unusual Samsung path)
        if (nameLower.contains("call") || nameLower.contains("record")) return true

        // Many Samsung recorders name files as just the phone number + timestamp, e.g.
        // "+972501234567_20240101_120000.m4a" — if path contains "recording" already handled.
        // As last resort, accept if path is a generic "Recordings/" folder (not excluded above).
        if (pathLower.contains("recording")) return true

        Log.d("TrueSummary", "SamsungRecordingReader: rejected $displayName (no call indicator, path=$relativePath)")
        return false
    }

    /**
     * Finds the most recent call recording added to MediaStore after [callStartTimeMs].
     *
     * @param context        Application context.
     * @param callStartTimeMs  Wall-clock millis when the call was answered (OFFHOOK time).
     * @return Pair<contentUri, mimeType> of the newest match, or null if none found.
     */
    fun findLatestCallRecording(context: Context, callStartTimeMs: Long): Pair<Uri, String>? {
        // MediaStore DATE_ADDED is in seconds; subtract 5 s as a safety buffer
        val minDateAddedSec = (callStartTimeMs / 1000L) - 5L
        Log.d("TrueSummary", "SamsungRecordingReader: searching after minDateAddedSec=$minDateAddedSec (callStartTimeMs=$callStartTimeMs)")

        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            @Suppress("DEPRECATION")
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

        val projection = buildList {
            add(MediaStore.Audio.Media._ID)
            add(MediaStore.Audio.Media.DISPLAY_NAME)
            add(MediaStore.Audio.Media.DATA)
            add(MediaStore.Audio.Media.MIME_TYPE)
            add(MediaStore.Audio.Media.DATE_ADDED)
            add(MediaStore.Audio.Media.SIZE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                add(MediaStore.Audio.Media.RELATIVE_PATH)
            }
        }.toTypedArray()

        val selection = "${MediaStore.Audio.Media.DATE_ADDED} >= ?"
        val selectionArgs = arrayOf(minDateAddedSec.toString())
        val sortOrder = "${MediaStore.Audio.Media.DATE_ADDED} DESC"

        context.contentResolver.query(
            collection,
            projection,
            selection,
            selectionArgs,
            sortOrder
        )?.use { cursor ->
            val idCol          = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val nameCol        = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val mimeCol        = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)
            val dateAddedCol   = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
            val sizeCol        = cursor.getColumnIndex(MediaStore.Audio.Media.SIZE)
            val relPathCol     = cursor.getColumnIndex(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.Audio.Media.RELATIVE_PATH else ""
            )

            while (cursor.moveToNext()) {
                val displayName  = cursor.getString(nameCol) ?: "(null)"
                val size         = if (sizeCol >= 0) cursor.getLong(sizeCol) else -1L
                val dateAdded    = cursor.getLong(dateAddedCol)
                val relativePath = if (relPathCol >= 0) cursor.getString(relPathCol) else null
                Log.d("TrueSummary", "SamsungRecordingReader row: name=$displayName size=$size dateAdded=$dateAdded path=$relativePath")

                // Skip tiny files (notification sounds, etc.) — real recordings are > 10 KB
                if (sizeCol >= 0 && size < 10_000L) {
                    Log.d("TrueSummary", "SamsungRecordingReader: skipping $displayName (too small: $size bytes)")
                    continue
                }

                // Skip non-call audio (WhatsApp voice notes, music, etc.)
                if (!isCallRecording(displayName, relativePath)) continue

                val id       = cursor.getLong(idCol)
                val mimeType = cursor.getString(mimeCol) ?: "audio/mp4"
                val uri      = Uri.withAppendedPath(collection, id.toString())
                Log.d("TrueSummary", "SamsungRecordingReader: returning $displayName, mimeType=$mimeType, uri=$uri")
                return Pair(uri, mimeType)
            }
        }

        Log.d("TrueSummary", "SamsungRecordingReader: no valid recording found, returning null")
        return null
    }

    /**
     * Returns metadata (name, dateAddedMs, sizeBytes) for every call recording
     * added to MediaStore since [sinceMs], sorted oldest-first.
     * Does NOT read file contents — cheap to call.
     */
    fun listRecentRecordings(context: Context, sinceMs: Long): List<Map<String, Any>> {
        val results = mutableListOf<Map<String, Any>>()
        val minDateAddedSec = (sinceMs / 1000L) - 5L
        Log.d("TrueSummary", "SamsungRecordingReader.listRecentRecordings: sinceMs=$sinceMs minSec=$minDateAddedSec")

        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            @Suppress("DEPRECATION") MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

        val projection = buildList {
            add(MediaStore.Audio.Media.DISPLAY_NAME)
            add(MediaStore.Audio.Media.SIZE)
            add(MediaStore.Audio.Media.DATE_ADDED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                add(MediaStore.Audio.Media.RELATIVE_PATH)
            }
        }.toTypedArray()

        val selection  = "${MediaStore.Audio.Media.DATE_ADDED} >= ?"
        val selArgs    = arrayOf(minDateAddedSec.toString())
        val sortOrder  = "${MediaStore.Audio.Media.DATE_ADDED} ASC"

        context.contentResolver.query(collection, projection, selection, selArgs, sortOrder)?.use { cursor ->
            val nameCol     = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val sizeCol     = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
            val dateCol     = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
            val relPathCol  = cursor.getColumnIndex(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.Audio.Media.RELATIVE_PATH else ""
            )

            while (cursor.moveToNext()) {
                val size = cursor.getLong(sizeCol)
                if (size < 10_000L) continue
                val name = cursor.getString(nameCol) ?: ""
                val ext  = name.substringAfterLast('.', "").lowercase()
                if (ext !in setOf("m4a", "mp3", "aac", "amr", "3gp", "wav", "ogg", "opus")) continue
                val relativePath = if (relPathCol >= 0) cursor.getString(relPathCol) else null
                if (!isCallRecording(name, relativePath)) continue
                val dateAddedSec = cursor.getLong(dateCol)
                results.add(mapOf(
                    "name"        to name,
                    "dateAddedMs" to (dateAddedSec * 1000L),
                    "sizeBytes"   to size,
                ))
            }
        }
        Log.d("TrueSummary", "SamsungRecordingReader.listRecentRecordings: found ${results.size} recordings")
        return results
    }

    /**
     * Finds the recording whose DATE_ADDED is within ±15 seconds of [targetDateAddedMs].
     * Use this for exact-recording lookup when scanning missed calls.
     *
     * @return Pair<contentUri, mimeType> or null if not found.
     */
    fun findRecordingAt(context: Context, targetDateAddedMs: Long): Pair<Uri, String>? {
        val targetSec = targetDateAddedMs / 1000L
        Log.d("TrueSummary", "SamsungRecordingReader.findRecordingAt: targetSec=$targetSec")

        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            @Suppress("DEPRECATION") MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

        val projection = buildList {
            add(MediaStore.Audio.Media._ID)
            add(MediaStore.Audio.Media.DISPLAY_NAME)
            add(MediaStore.Audio.Media.MIME_TYPE)
            add(MediaStore.Audio.Media.SIZE)
            add(MediaStore.Audio.Media.DATE_ADDED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                add(MediaStore.Audio.Media.RELATIVE_PATH)
            }
        }.toTypedArray()

        val selection = "${MediaStore.Audio.Media.DATE_ADDED} BETWEEN ? AND ?"
        val selArgs   = arrayOf((targetSec - 15).toString(), (targetSec + 15).toString())
        val sortOrder = "${MediaStore.Audio.Media.DATE_ADDED} ASC"

        context.contentResolver.query(collection, projection, selection, selArgs, sortOrder)?.use { cursor ->
            val idCol      = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val nameCol    = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val mimeCol    = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)
            val sizeCol    = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
            val relPathCol = cursor.getColumnIndex(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.Audio.Media.RELATIVE_PATH else ""
            )

            while (cursor.moveToNext()) {
                val size = cursor.getLong(sizeCol)
                if (size < 10_000L) continue
                val name = cursor.getString(nameCol) ?: ""
                val ext  = name.substringAfterLast('.', "").lowercase()
                if (ext !in setOf("m4a", "mp3", "aac", "amr", "3gp", "wav", "ogg", "opus")) continue
                val relativePath = if (relPathCol >= 0) cursor.getString(relPathCol) else null
                if (!isCallRecording(name, relativePath)) continue
                val id       = cursor.getLong(idCol)
                val mimeType = cursor.getString(mimeCol) ?: "audio/mp4"
                val uri      = Uri.withAppendedPath(collection, id.toString())
                Log.d("TrueSummary", "SamsungRecordingReader.findRecordingAt: found $name")
                return Pair(uri, mimeType)
            }
        }
        Log.d("TrueSummary", "SamsungRecordingReader.findRecordingAt: not found for targetSec=$targetSec")
        return null
    }

    /**
     * Finds a call recording whose DATE_ADDED falls within [startMs]..[endMs] (milliseconds).
     * Use this for looking up a stored call's recording by its saved recording_timestamp_ms.
     *
     * @param startMs  Start of the search window in wall-clock millis.
     * @param endMs    End of the search window in wall-clock millis.
     * @return Pair<contentUri, mimeType> or null if not found.
     */
    fun findRecordingInRange(context: Context, startMs: Long, endMs: Long): Pair<Uri, String>? {
        val startSec = (startMs / 1000L) - 10L   // 10 s buffer before
        val endSec   = (endMs   / 1000L) + 120L  // 2 min buffer after (recording finishes after call)
        Log.d("TrueSummary", "SamsungRecordingReader.findRecordingInRange: startSec=$startSec endSec=$endSec")

        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            @Suppress("DEPRECATION") MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

        val projection = buildList {
            add(MediaStore.Audio.Media._ID)
            add(MediaStore.Audio.Media.DISPLAY_NAME)
            add(MediaStore.Audio.Media.MIME_TYPE)
            add(MediaStore.Audio.Media.SIZE)
            add(MediaStore.Audio.Media.DATE_ADDED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                add(MediaStore.Audio.Media.RELATIVE_PATH)
            }
        }.toTypedArray()

        val selection = "${MediaStore.Audio.Media.DATE_ADDED} BETWEEN ? AND ?"
        val selArgs   = arrayOf(startSec.toString(), endSec.toString())
        val sortOrder = "${MediaStore.Audio.Media.DATE_ADDED} ASC"

        context.contentResolver.query(collection, projection, selection, selArgs, sortOrder)?.use { cursor ->
            val idCol      = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val nameCol    = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val mimeCol    = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)
            val sizeCol    = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
            val relPathCol = cursor.getColumnIndex(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.Audio.Media.RELATIVE_PATH else ""
            )

            while (cursor.moveToNext()) {
                val size = cursor.getLong(sizeCol)
                if (size < 10_000L) continue
                val name = cursor.getString(nameCol) ?: ""
                val ext  = name.substringAfterLast('.', "").lowercase()
                if (ext !in setOf("m4a", "mp3", "aac", "amr", "3gp", "wav", "ogg", "opus")) continue
                val relativePath = if (relPathCol >= 0) cursor.getString(relPathCol) else null
                if (!isCallRecording(name, relativePath)) continue
                val id       = cursor.getLong(idCol)
                val mimeType = cursor.getString(mimeCol) ?: "audio/mp4"
                val uri      = Uri.withAppendedPath(collection, id.toString())
                Log.d("TrueSummary", "SamsungRecordingReader.findRecordingInRange: found $name")
                return Pair(uri, mimeType)
            }
        }

        Log.d("TrueSummary", "SamsungRecordingReader.findRecordingInRange: not found in range [$startSec, $endSec]")
        return null
    }

    /**
     * Opens [uri] via the content resolver and returns its bytes as a Base64 string
     * (NO_WRAP, suitable for JSON / Gemini inline data).
     *
     * @return Base64 string, or null on any I/O error.
     */
    fun readAsBase64(context: Context, uri: Uri): String? {
        return try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                val bytes = stream.readBytes()
                Base64.encodeToString(bytes, Base64.NO_WRAP)
            }
        } catch (e: Exception) {
            android.util.Log.e("SamsungRecordingReader", "readAsBase64 failed: ${e.message}", e)
            null
        }
    }
}
