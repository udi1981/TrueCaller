package com.truesummary.app

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.content.Intent
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class OverlayCallRecord(
    val callerName: String?,
    val callerRole: String?,
    val summary: String,
    val createdAt: String
)

/**
 * Draws a floating overlay panel on top of the lock screen when a call arrives.
 *
 * Requires SYSTEM_ALERT_WINDOW permission (granted by the user via settings screen).
 *
 * Limitation: On some ROMs (Samsung, Xiaomi, etc.) the native dialer's incoming-call
 * screen may cover this overlay. It always appears before / alongside the dialer UI.
 */
object OverlayManager {

    private var overlayView: View? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var autoDismissRunnable: Runnable? = null

    // ── Public ────────────────────────────────────────────────────────────────

    fun showIncomingCallOverlay(context: Context, phoneNumber: String) {
        if (!Settings.canDrawOverlays(context)) return

        mainHandler.post {
            // Remove any existing overlay first
            hideOverlayInternal(context)

            val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val contactName   = getContactName(context, phoneNumber)
            val calls         = getRecentCallsForNumber(context, phoneNumber)
            // Name priority: Android Contact → DB caller_name → phone number
            val dbName        = calls.firstOrNull()?.callerName?.takeIf { it.isNotBlank() }
            val displayName   = contactName ?: dbName
            val dbRole        = calls.firstOrNull()?.callerRole?.takeIf { it.isNotBlank() }

            Log.d("TrueSummary", "OverlayManager: phone=$phoneNumber contact=$contactName dbName=$dbName dbRole=$dbRole calls=${calls.size}")

            // ── Outer container ──
            val container = LinearLayout(context).apply {
                orientation     = LinearLayout.VERTICAL
                background      = createRoundedBg("#E81C1C1E", dp(context, 24).toFloat())
                setPadding(dp(context, 20), dp(context, 16), dp(context, 20), dp(context, 16))
                layoutDirection = View.LAYOUT_DIRECTION_RTL
            }

            // ── Header row (avatar + name + phone + close button) ──
            val headerRow = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity     = Gravity.CENTER_VERTICAL
            }

            val avatar = View(context).apply { background = createCircleBg("#3A3A3C") }
            val avatarLp = LinearLayout.LayoutParams(dp(context, 40), dp(context, 40)).apply {
                marginEnd = dp(context, 12)
            }

            val nameStack = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
            val nameView = TextView(context).apply {
                text = displayName ?: phoneNumber
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
                typeface = Typeface.DEFAULT_BOLD
            }
            nameStack.addView(nameView)
            // Show role as blue subtitle
            if (dbRole != null) {
                val roleView = TextView(context).apply {
                    text = dbRole
                    setTextColor(Color.parseColor("#60A5FA"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                }
                nameStack.addView(roleView)
            }
            // Show phone number below name when a name is available
            if (displayName != null) {
                val phoneView = TextView(context).apply {
                    text = phoneNumber
                    setTextColor(Color.parseColor("#888888"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                }
                nameStack.addView(phoneView)
            }

            val closeButton = TextView(context).apply {
                text = "✕"
                setTextColor(Color.parseColor("#6B7280"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                gravity = Gravity.CENTER
                setPadding(dp(context, 8), dp(context, 4), dp(context, 8), dp(context, 4))
                setOnClickListener { hideOverlay(context) }
            }

            headerRow.addView(avatar, avatarLp)
            headerRow.addView(nameStack, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            headerRow.addView(closeButton)
            container.addView(headerRow)

            // ── Blue badge ──
            val badge = TextView(context).apply {
                text = "סיכום שיחה אחרונה"
                setTextColor(Color.parseColor("#60A5FA"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                typeface = Typeface.DEFAULT_BOLD
                background = createRoundedBg("#1E3A5F", dp(context, 20).toFloat())
                setPadding(dp(context, 12), dp(context, 5), dp(context, 12), dp(context, 5))
            }
            val badgeLp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(context, 12) }
            container.addView(badge, badgeLp)

            // ── Main summary + date ──
            val mainSummary = if (calls.isNotEmpty()) calls[0].summary else "שיחה ראשונה"
            val summaryView = TextView(context).apply {
                text = mainSummary
                setTextColor(Color.parseColor("#CCCCCC"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                setPadding(0, dp(context, 10), 0, 0)
                setLineSpacing(dp(context, 2).toFloat(), 1f)
            }
            container.addView(summaryView)

            if (calls.isNotEmpty()) {
                val dateView = TextView(context).apply {
                    text = formatCallDate(calls[0].createdAt)
                    setTextColor(Color.parseColor("#6B7280"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    setPadding(0, dp(context, 4), 0, 0)
                }
                container.addView(dateView)
            }

            // ── Divider + previous calls (only when >1 call exists) ──
            if (calls.size > 1) {
                val divider = View(context).apply {
                    setBackgroundColor(Color.parseColor("#2C2C2E"))
                }
                val divLp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(context, 1)
                ).apply { topMargin = dp(context, 12); bottomMargin = dp(context, 12) }
                container.addView(divider, divLp)

                val prevHeader = TextView(context).apply {
                    text = "שיחות קודמות:"
                    setTextColor(Color.parseColor("#6B7280"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    typeface = Typeface.DEFAULT_BOLD
                    setPadding(0, 0, 0, dp(context, 6))
                }
                container.addView(prevHeader)

                for (prev in calls.drop(1).take(2)) {
                    val ps = TextView(context).apply {
                        text = prev.summary
                        setTextColor(Color.parseColor("#9CA3AF"))
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                        setLineSpacing(dp(context, 1).toFloat(), 1f)
                    }
                    val pd = TextView(context).apply {
                        text = formatCallDate(prev.createdAt)
                        setTextColor(Color.parseColor("#6B7280"))
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                        setPadding(0, dp(context, 2), 0, dp(context, 8))
                    }
                    container.addView(ps)
                    container.addView(pd)
                }
            }

            // ── Manual recording button ──
            val recBtnDivider = View(context).apply {
                setBackgroundColor(Color.parseColor("#2C2C2E"))
            }
            val recBtnDivLp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(context, 1)
            ).apply { topMargin = dp(context, 12); bottomMargin = dp(context, 12) }
            container.addView(recBtnDivider, recBtnDivLp)

            val recordButton = TextView(context).apply {
                text = "🔴  התחל הקלטה ידנית"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                background = createRoundedBg("#C62828", dp(context, 12).toFloat())
                setPadding(dp(context, 16), dp(context, 10), dp(context, 16), dp(context, 10))
                setOnClickListener {
                    try {
                        val intent = Intent(context, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            putExtra("start_recording", true)
                        }
                        context.startActivity(intent)
                    } catch (_: Exception) { }
                }
            }
            val recBtnLp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            container.addView(recordButton, recBtnLp)

            @Suppress("DEPRECATION")
            val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                WindowManager.LayoutParams.TYPE_PHONE

            // Wrap container in a FrameLayout with side margins so it looks like a floating card
            val wrapper = FrameLayout(context)
            val wrapperLp = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                marginStart = dp(context, 12)
                marginEnd   = dp(context, 12)
            }
            wrapper.addView(container, wrapperLp)

            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                layoutType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.CENTER
                x = 0
                y = 0
            }

            try {
                windowManager.addView(wrapper, params)
                overlayView = wrapper
                // Auto-dismiss after 45 seconds in case IDLE never fires
                autoDismissRunnable?.let { mainHandler.removeCallbacks(it) }
                val dismissRunnable = Runnable { hideOverlayInternal(context) }
                autoDismissRunnable = dismissRunnable
                mainHandler.postDelayed(dismissRunnable, 45_000L)
            } catch (e: Exception) {
                // Window already attached or permission revoked
            }
        }
    }

    fun hideOverlay(context: Context) {
        mainHandler.post { hideOverlayInternal(context) }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private fun hideOverlayInternal(context: Context) {
        autoDismissRunnable?.let { mainHandler.removeCallbacks(it) }
        autoDismissRunnable = null
        overlayView?.let { view ->
            try {
                val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                wm.removeView(view)
            } catch (_: Exception) { /* already removed */ }
            overlayView = null
        }
    }

    /**
     * Looks up the display name for [phoneNumber] in Android Contacts.
     * Returns null if not found or permission not granted.
     */
    internal fun getContactName(context: Context, phoneNumber: String): String? {
        if (phoneNumber.isBlank()) return null
        return try {
            val uri = android.net.Uri.withAppendedPath(
                android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                android.net.Uri.encode(phoneNumber)
            )
            context.contentResolver.query(
                uri,
                arrayOf(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME),
                null, null, null
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: Exception) { null }
    }

    /**
     * Normalizes an Israeli phone number: +972501234567 → 0501234567
     */
    private fun normalizePhone(phone: String): String {
        val digits = phone.replace(Regex("\\D"), "")
        return if (digits.startsWith("972") && digits.length >= 11) "0" + digits.substring(3)
        else digits
    }

    /**
     * Returns up to [limit] recent calls for [phoneNumber] directly from SQLite.
     * Normalizes phone to match both +972... and 05... variants.
     */
    private fun getRecentCallsForNumber(context: Context, phoneNumber: String, limit: Int = 3): List<OverlayCallRecord> {
        if (phoneNumber.isBlank()) return emptyList()
        return try {
            val dbFile = context.getDatabasePath("truesummarySQLite.db")
            Log.d("TrueSummary", "OverlayManager DB path: ${dbFile.absolutePath} exists=${dbFile.exists()}")
            if (!dbFile.exists()) return emptyList()
            val db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
            val norm = normalizePhone(phoneNumber)
            // Also generate +972 variant from 05... numbers
            val intl = if (norm.startsWith("0") && norm.length >= 10) "+972" + norm.substring(1) else null
            val variants = (setOf(phoneNumber, norm) + listOfNotNull(intl)).filter { it.isNotBlank() }
            val placeholders = variants.joinToString(", ") { "?" }
            val cursor = db.rawQuery(
                "SELECT caller_name, caller_role, summary, created_at FROM calls WHERE phone_number IN ($placeholders) ORDER BY created_at DESC LIMIT ?",
                (variants + limit.toString()).toTypedArray()
            )
            val records = mutableListOf<OverlayCallRecord>()
            while (cursor.moveToNext()) {
                records.add(OverlayCallRecord(
                    callerName = cursor.getString(0),
                    callerRole = cursor.getString(1),
                    summary = cursor.getString(2),
                    createdAt = cursor.getString(3)
                ))
            }
            cursor.close()
            db.close()
            Log.d("TrueSummary", "OverlayManager: found ${records.size} records for variants=$variants")
            records
        } catch (e: Exception) {
            Log.e("TrueSummary", "OverlayManager DB error", e)
            emptyList()
        }
    }

    /**
     * Reads the last summary for [phoneNumber] directly from the SQLite database.
     * Kept for compatibility — prefer getRecentCallsForNumber.
     */
    internal fun getLastSummaryForNumber(context: Context, phoneNumber: String): String {
        return getRecentCallsForNumber(context, phoneNumber, 1)
            .firstOrNull()?.summary ?: "שיחה ראשונה"
    }

    private fun formatCallDate(isoString: String): String {
        return try {
            // Try space-separated first (SQLite datetime() format), then ISO T-separated
            val formats = listOf("yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss")
            var date: Date? = null
            for (fmt in formats) {
                try {
                    date = SimpleDateFormat(fmt, Locale.getDefault()).parse(isoString)
                    if (date != null) break
                } catch (_: Exception) { }
            }
            if (date != null) SimpleDateFormat("HH:mm d.M.yyyy", Locale.getDefault()).format(date)
            else isoString
        } catch (_: Exception) { isoString }
    }

    private fun createRoundedBg(colorHex: String, cornerPx: Float): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(Color.parseColor(colorHex))
            cornerRadius = cornerPx
        }

    private fun createCircleBg(colorHex: String): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor(colorHex))
        }

    private fun dp(context: Context, dp: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, dp.toFloat(), context.resources.displayMetrics
        ).toInt()
}
