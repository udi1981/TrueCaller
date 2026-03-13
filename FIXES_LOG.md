# FIXES LOG

This file tracks every fix, change, or improvement made to the codebase.
Before making any change, check here first to avoid duplicating work.
Append new entries at the bottom with date and description.

---

## Format
```
### [YYYY-MM-DD] — Short title
**Files changed:** list of files
**Problem:** what was wrong
**Fix:** what was done
**Status:** DONE / PARTIAL / REVERTED
```

---

## Session 1 — Initial bug fixes

### [2025-xx-xx] — Wrong Gemini model name
**Files changed:** `server.ts`, `src/services/geminiClient.ts`
**Problem:** Model was set to `gemini-3-flash-preview` which does not exist
**Fix:** Changed to `gemini-2.0-flash`
**Status:** DONE

### [2025-xx-xx] — Wrong table name in server.ts
**Files changed:** `server.ts`
**Problem:** Query referenced table `callers` but schema creates table `calls`
**Fix:** All queries updated to use `calls`
**Status:** DONE

### [2025-xx-xx] — Socket.io memory leak
**Files changed:** `src/App.tsx`
**Problem:** Socket.io listeners added on every render without cleanup
**Fix:** Moved to `callHistoryRef` pattern; listeners cleaned up properly
**Status:** DONE

### [2025-xx-xx] — Gemini API key exposed client-side
**Files changed:** `server.ts`, `src/services/geminiClient.ts`
**Problem:** API key was being sent to the frontend
**Fix:** All Gemini calls moved server-side for web mode; key stays in `.env` / server process
**Status:** DONE

### [2025-xx-xx] — Unused constants in App.tsx
**Files changed:** `src/App.tsx`
**Problem:** Dead constants cluttering the component
**Fix:** Removed
**Status:** DONE

---

## Session 2 — Android APK conversion

### [2025-xx-xx] — Capacitor setup + package.json restructure
**Files changed:** `package.json`
**Problem:** App was web-only; no Capacitor support
**Fix:** Added `@capacitor/core`, `@capacitor/android`, `@capacitor/preferences`, `@capacitor-community/sqlite`; moved server deps to devDependencies; added `build:android` script
**Status:** DONE

### [2025-xx-xx] — Vite base path for Capacitor WebView
**Files changed:** `vite.config.ts`
**Problem:** Asset paths were absolute, breaking Capacitor WebView
**Fix:** Added `base: './'`
**Status:** DONE

### [2025-xx-xx] — Socket.io removed from App.tsx on Android
**Files changed:** `src/App.tsx`
**Problem:** Socket.io not available in Capacitor native context
**Fix:** Replaced with Capacitor CallDetector plugin events; Settings modal added; stable refs pattern applied throughout
**Status:** DONE

### [2025-xx-xx] — New service files created
**Files changed:** `src/services/database.ts` (NEW), `src/services/geminiClient.ts` (NEW), `capacitor.config.ts` (NEW)
**Problem:** No abstraction layer for dual web/native operation
**Fix:** Each service checks `Capacitor.isNativePlatform()` and routes to plugin or fetch accordingly
**Status:** DONE

### [2025-xx-xx] — Android Kotlin native files created
**Files changed:** `android-native/` directory (NEW)
**Problem:** No native Android call detection, overlay, or recording
**Fix:** Created CallDetectorPlugin.kt, CallService.kt, TrueSummaryScreeningService.kt, OverlayManager.kt, BootReceiver.kt, MainActivity.kt + SETUP.md
**Status:** DONE

---

## Session 3 — Samsung recording + app icon

### [2025-xx-xx] — Samsung call recording support
**Files changed:** `android-native/java/com/truesummary/app/SamsungRecordingReader.kt` (NEW), `android-native/java/com/truesummary/app/CallDetectorPlugin.kt`, `android-native/java/com/truesummary/app/CallService.kt`, `src/App.tsx`, `android-native/AndroidManifest_additions.xml`
**Problem:** App could only record via microphone; Samsung devices auto-record calls to MediaStore
**Fix:** SamsungRecordingReader queries MediaStore for recordings after OFFHOOK time; CallService tracks `callAnsweredTimeMs`; App.tsx skips mic on Android and uses `getLatestRecording()` on IDLE
**Status:** DONE

### [2025-xx-xx] — App icon generation
**Files changed:** `package.json`
**Problem:** No app icon for Android
**Fix:** Added `@capacitor/assets` devDep + `generate-icons` script; SETUP.md updated with Step 3b
**Status:** DONE

---

## Session 4 (2026-02-26) — CLAUDE.md + FIXES_LOG.md created

### [2026-02-26] — CLAUDE.md created
**Files changed:** `CLAUDE.md` (NEW)
**Problem:** No guidance file for Claude Code instances
**Fix:** Created with commands, architecture overview, dual-mode design, Kotlin file table, key patterns, AI prompt locations
**Status:** DONE

### [2026-02-26] — FIXES_LOG.md created
**Files changed:** `FIXES_LOG.md` (NEW)
**Problem:** No persistent log of changes to prevent duplicate work across sessions
**Fix:** Created this file; all prior session fixes backfilled from memory
**Status:** DONE

---

<!-- APPEND NEW ENTRIES BELOW THIS LINE -->

---

## Session 18 (2026-03-02) — Fix: no popup on incoming call + missed calls never summarized

### [2026-03-02] — Root cause analysis via logcat + MediaStore
**Finding:** Son's call recording `יותמי_260302_141259.m4a` (324 KB) exists in MediaStore but was never processed. App started 7 seconds AFTER the call ended → CallService was not running → no RINGING/OFFHOOK/IDLE events → `pendingCallAnsweredTimeMs` never written → `checkPendingCall()` found nothing. 21 other calls from today also unprocessed (CallService killed by Samsung battery optimizer throughout the day).
**Status:** DIAGNOSED

### [2026-03-02] — Fix 1: CallService RINGING notification now shows on lock screen
**Files changed:** `android/app/.../CallService.kt`, `android-native/java/.../CallService.kt`
**Problem:** `showIncomingCallNotification()` had no `setFullScreenIntent` → notification only showed as heads-up banner when screen was on; invisible on locked screen.
**Fix:** Added `PendingIntent` (opens MainActivity) + `.setContentIntent()` + `.setFullScreenIntent(pendingIntent, true)`. Added `import android.app.PendingIntent`.
**Status:** DONE

### [2026-03-02] — Fix 2: Batch missed-call scanner (listRecentRecordings + getRecordingAt)
**Files changed:** `android/app/.../SamsungRecordingReader.kt`, `android-native/java/.../SamsungRecordingReader.kt`, `android/app/.../CallDetectorPlugin.kt`, `android-native/java/.../CallDetectorPlugin.kt`, `android/app/.../AndroidManifest.xml`, `android-native/AndroidManifest_additions.xml`, `src/App.tsx`
**Problem:** When CallService was killed mid-day by Samsung, recordings accumulated in MediaStore but were never processed. No way to recover them.
**Fix:**
  1. `SamsungRecordingReader`: added `listRecentRecordings(sinceMs)` (returns metadata list, no base64) and `findRecordingAt(targetDateAddedMs)` (exact ±15s lookup by timestamp).
  2. `CallDetectorPlugin`: added `listRecentRecordings`, `getRecordingAt`, `requestIgnoreBatteryOptimizations` plugin methods.
  3. Manifest: added `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission.
  4. `App.tsx`: added `listRecentRecordings`, `getRecordingAt`, `requestIgnoreBatteryOptimizations` to `CallDetectorPlugin` interface; added `scanMissedCalls()` function (scans last 7 days, skips already-in-DB recordings by timestamp ±90s, processes each one); calls `requestIgnoreBatteryOptimizations()` on init (fire-and-forget); added amber History icon scan button in header (native only).
**Status:** DONE

---

## Session 17 (2026-03-02) — Fix: incoming call always shows "שיחה ראשונה" / no summary

### [2026-03-02] — Normalized phone lookup + DB fallback in incoming call handlers
**Files changed:** `src/App.tsx`
**Problem:** Incoming call overlay always showed "שיחה ראשונה" (first call) and no caller name/summary, even for repeat callers.
Three root causes:
1. `handleCallScreened` used strict equality `c.phone_number === data.phoneNumber` — OS can deliver same number in different formats (`+972521234567` vs `0521234567` vs `052-123-4567`), causing mismatches.
2. No DB fallback: if the caller wasn't in the 50-call in-memory `callHistoryRef`, no SQLite query was attempted.
3. `handleCallStateChange(RINGING)` never looked up the caller at all — so if `TrueSummaryScreeningService` wasn't set as default screener (callScreened event never fires), `selectedCall` stayed null.
**Fix:**
1. Added `normalizePhone(phone: string): string` helper (before `dueBadge`) — strips non-digits, converts `972XX` → `0XX`.
2. `handleCallScreened`: made async; replaced exact-match `find()` with normalized comparison; added `getCallerByPhone()` DB fallback when in-memory miss.
3. `handleCallStateChange(RINGING)`: made handler async; added normalized lookup + DB fallback when `data.phoneNumber` is provided; sets `selectedCall`, `incomingName`, `incomingNumber` directly.
4. `simulateIncomingCall`: changed history lookup to normalized comparison for consistency.
5. Added `getCallerByPhone` to the `database.ts` import.
**Status:** DONE

---

## Session 13b (2026-03-02) — Incoming call popup never showing

### [2026-03-02] — CallService: always show notification on RINGING, even without phone number
**Files changed:** `android/app/src/main/java/.../CallService.kt`, `android-native/java/.../CallService.kt`, `android/app/src/main/java/.../TrueSummaryScreeningService.kt`, `android-native/java/.../TrueSummaryScreeningService.kt`
**Problem:** On Android 12+ (API 31+), `TelephonyCallback.onCallStateChanged()` never provides the phone number. `CallService.handleStateChange(RINGING)` had a guard `if (!phoneNumber.isNullOrBlank())` so it skipped the notification entirely unless the screening role was granted. If `TrueSummaryScreeningService` was not set as the default call screening app (common — requires manual user setup), nothing ever showed on an incoming call.
**Root cause chain:**
  1. No screening role → `TrueSummaryScreeningService.onScreenCall()` never fires
  2. `CallService` gets RINGING with `phoneNumber = null` (API 31+)
  3. Guard prevents any notification → **no popup at all**
**Fix:**
  1. `TrueSummaryScreeningService.onScreenCall()`: immediately writes `phoneNumber` to `SharedPreferences("TrueSummaryPending", "lastIncomingPhoneNumber")` — fires BEFORE `TelephonyCallback`, so the number is available when `CallService.handleStateChange(RINGING)` runs.
  2. `CallService.handleStateChange(RINGING)`: removed the null guard. Now reads `lastIncomingPhoneNumber` from SharedPreferences as fallback when `phoneNumber` is null (API 31+). Then always calls `showIncomingCallNotification()` and `showIncomingCallOverlay()` — even when number is blank, shows generic "מספר לא ידוע" + "שיחה ראשונה".
  3. `CallService.handleStateChange(IDLE)`: clears `lastIncomingPhoneNumber` from SharedPreferences so stale data never leaks to the next call.
**Result:**
  - Screening role set + permission granted: real phone number + last summary shown ✓
  - Screening role NOT set: generic "מספר לא ידוע" popup still appears ✓
  - Overlay still requires SYSTEM_ALERT_WINDOW; notification requires POST_NOTIFICATIONS
**Status:** DONE

---

## Session 12 (2026-03-02) — AI Chat Search + Tasks "My Tasks Only"

### [2026-03-02] — Tasks prompt: user-commitments only
**Files changed:** `src/services/geminiClient.ts`, `server.ts`
**Problem:** Gemini extracted tasks from both parties — the user's commitments AND the caller's promises. Tasks tab was polluted with things the caller said they would do.
**Fix:** Updated `SUMMARY_INSTR` rule #4 to explicitly say: include ONLY things the *user* (phone owner) committed to doing, not promises by the other party. Rule text now says "Include ONLY things the user said they would do".
**Status:** DONE

### [2026-03-02] — askAIAboutCalls: richer context + structured references
**Files changed:** `src/services/geminiClient.ts`, `server.ts`
**Problem:** AI search context only included date, name, summary, transcript — no phone number and no task context per call. AI answers had no way to cite specific calls.
**Fix:**
  1. `askAIAboutCalls` signature extended with `phone_number` and `tasks: string[]` per call.
  2. Context block format now: `[שיחה N — name — phone — date]\nסיכום: ...\nתמלול: ...\nמשימות ממני: ...`
  3. System instruction added: "כאשר אתה מתייחס לשיחה ספציפית, כלול בסוגריים את שם האיש, מספר הטלפון והתאריך"
  4. Same changes mirrored in `server.ts` `/api/ai-search` handler.
**Status:** DONE

### [2026-03-02] — Search tab → persistent AI chat interface
**Files changed:** `src/App.tsx`
**Problem:** Search tab was a plain text input + optional "AI deep search" button — single question/answer only, no history, SQL results cluttered the UX.
**Fix:**
  1. Removed `searchResults`, `aiAnswer` states; removed SQL search debounce `useEffect`.
  2. Removed `searchDebounceRef`; added `chatBottomRef` for auto-scroll.
  3. Added `chatMessages: Array<{ role: 'user' | 'assistant', text: string }>` state.
  4. Replaced `runAiSearch` with `sendChatMessage`: appends user message, clears input, calls `askAIAboutCalls` with ALL calls + matching pending tasks per call, appends AI reply.
  5. Replaced entire search tab JSX with chat UI: scrollable message list, AI/user bubbles, intro message when empty, animated 3-dot loading indicator, textarea input (Enter=send, Shift+Enter=newline), disabled send button while AI responds.
  6. Removed unused `Bell` import; removed unused `searchCalls` import.
**Status:** DONE

### [2026-03-02] — Incoming call popup: move notification + overlay to TrueSummaryScreeningService
**Files changed:** `android/app/src/main/java/.../TrueSummaryScreeningService.kt`, `android-native/java/.../TrueSummaryScreeningService.kt`, `android/app/src/main/java/.../CallService.kt`, `android-native/java/.../CallService.kt`, `android/app/src/main/AndroidManifest.xml`, `android-native/AndroidManifest_additions.xml`
**Problem:** `TelephonyCallback.onCallStateChanged(state)` on Android 12+ does NOT provide the phone number. So `CallService.showIncomingCallNotification("")` and `OverlayManager.showIncomingCallOverlay("", ...)` always looked up an empty number → returned "שיחה ראשונה" for every incoming call regardless of caller history.
**Fix:**
  1. `TrueSummaryScreeningService.onScreenCall()` fires BEFORE `TelephonyCallback` and has the real phone number. Added: call `OverlayManager.showIncomingCallOverlay(phoneNumber)` and `postIncomingCallNotification(phoneNumber)` with the real number + actual last summary from SQLite.
  2. Added `postIncomingCallNotification()` private method in `TrueSummaryScreeningService` — creates `IMPORTANCE_HIGH` channel, reads summary from SQLite, posts heads-up notification. Includes `setContentIntent` + `setFullScreenIntent` to open the app so React overlay shows.
  3. `CallService.handleStateChange(RINGING)`: now skips overlay + notification when `phoneNumber` is null/blank (which is always the case on API 31+). Avoids overwriting the good notification from screening service with "שיחה ראשונה".
  4. Added `USE_FULL_SCREEN_INTENT` permission to both manifests.
**Status:** DONE

### [2026-03-02] — APK rebuilt and installed (chat UI + popup fix)
**Fix:** `npm run build && npx cap sync android && ./gradlew installDebug` — BUILD SUCCESSFUL in 26s, installed to SM-S928B (Android 16)
**Status:** DONE

### [2026-03-02] — Tasks tab: added date to task cards
**Files changed:** `src/App.tsx`
**Problem:** Task cards showed caller name and phone but not when the commitment was made.
**Fix:** Added `· {formatDateTime(task.created_at).date}` to the task card footer line.
**Status:** DONE

### [2026-02-26] — Gemini API key built into app as default
**Files changed:** `src/services/geminiClient.ts`
**Problem:** App required manual key entry in Settings on first launch
**Fix:** Added `BUILT_IN_API_KEY` constant as fallback in `getApiKey()` — key from Preferences is still checked first (Settings override still works); falls back to built-in if nothing saved
**Status:** DONE

---

## Session 5 (2026-02-26) — APK crash fix + icon fix + local dev fix

### [2026-02-26] — better-sqlite3 native binary rebuilt
**Files changed:** none (binary rebuild only)
**Problem:** `better-sqlite3` compiled against Node 14 (MODULE_VERSION 108); machine now runs Node 24 (MODULE_VERSION 137) → server crashed on start
**Fix:** `npm rebuild better-sqlite3` — server now starts correctly with `npm run dev` at http://localhost:3000
**Status:** DONE

### [2026-02-26] — Android crash: foregroundServiceType "phoneCall" → "microphone"
**Files changed:** `android-native/AndroidManifest_additions.xml`, `android/app/src/main/AndroidManifest.xml`, `android-native/java/.../CallService.kt`, `android/app/src/main/java/.../CallService.kt`
**Problem:** Android 14+ (targetSdkVersion=35) + `foregroundServiceType="phoneCall"` requires either an active phone call OR `MANAGE_OWN_CALLS` permission when calling `startForeground()`. The service was started at app launch (no active call) → `ForegroundServiceTypeException` on main thread → instant process crash → "not showing first page"
**Fix:**
  1. Changed `foregroundServiceType` from `phoneCall` → `microphone` in both manifests
  2. Changed permission from `FOREGROUND_SERVICE_PHONE_CALL` → `FOREGROUND_SERVICE_MICROPHONE`
  3. Updated `CallService.startForeground()` to 3-arg version (`FOREGROUND_SERVICE_TYPE_MICROPHONE`) on API 29+
  4. Added `import android.content.pm.ServiceInfo` to both CallService.kt files
**Status:** DONE

### [2026-02-26] — Icon generation fixed
**Files changed:** `package.json`, `resources/icon.png` (NEW), all `android/app/src/main/res/mipmap-*/ic_launcher*.png` regenerated
**Problem:** `resources/` folder didn't exist → `generate-icons` never ran → app showed default Capacitor icon. Also, `npm run generate-icons` script used single-quoted color values (`'#FFFFFF'`) which Windows cmd.exe passes literally (including the quotes), causing `color` library parse error
**Fix:**
  1. Fixed script: changed `'#FFFFFF'` → `white` and `'#000000'` → `black`
  2. Created `resources/` folder and copied `public/icon.png` to `resources/icon.png`
  3. Ran `npm run generate-icons` → generated all 74 Android icon variants + splash screens from the custom TrueSummary icon
**Status:** DONE

### [2026-02-26] — Correct app icon applied (Summmary Caller Icon.png)
**Files changed:** `resources/icon.png`, `public/icon.png`, all mipmap icon variants regenerated
**Problem:** Previous generate-icons run used `public/icon.png` (wrong/placeholder icon). Actual branded icon was at `C:\Users\udi19\Downloads\TrueCaller-main\Summmary Caller Icon.png` (phone + speech bubble, blue-purple gradient)
**Fix:** Copied correct icon to `resources/icon.png` and `public/icon.png`, re-ran `npm run generate-icons`
**Status:** DONE

### [2026-02-26] — APK rebuilt with correct icon + all crash fixes
**Files changed:** `android/app/build/outputs/apk/debug/app-debug.apk` (31 MB)
**Fix:** `npm run build && npx cap sync android && ./gradlew assembleDebug` — BUILD SUCCESSFUL in 3s
**Status:** DONE

### [2026-02-26] — Web assets rebuilt + synced to Android
**Files changed:** `dist/` (rebuilt), `android/app/src/main/assets/public/` (synced)
**Problem:** dist/ was stale; Android assets needed refresh after all changes
**Fix:** `npm run build && npx cap sync android`
**Status:** DONE

---

## Session 6 (2026-03-01) — RecordingWatcherPlugin wiring + dead code removal

### [2026-03-01] — RecordingWatcherPlugin registered in MainActivity
**Files changed:** `android/app/src/main/java/com/truesummary/app/MainActivity.kt`, `android-native/java/com/truesummary/app/MainActivity.kt`
**Problem:** `RecordingWatcherPlugin.kt` existed in both directories but was never registered with the Capacitor Bridge, so it was invisible to the JS layer
**Fix:** Added `registerPlugin(RecordingWatcherPlugin::class.java)` before `super.onCreate()` in both files (same package, no import needed)
**Status:** DONE

### [2026-03-01] — RecordingWatcherPlugin wired in App.tsx (event-driven Samsung recording)
**Files changed:** `src/App.tsx`
**Problem:** No TypeScript interface, no `startWatcher()` call, and no `recordingReady` listener — the event-driven plugin was completely unused; app fell back entirely to the unreliable 2.5s-poll MediaStore approach
**Fix:**
  1. Added `RecordingWatcherPlugin` interface (`startWatcher`, `stopWatcher`, `addListener('recordingReady', ...)`)
  2. Added `RecordingWatcher = registerPlugin<RecordingWatcherPlugin>('RecordingWatcher')`
  3. Added `recordingListenerRef` to track the live listener handle
  4. On `OFFHOOK` (native, both incoming-answered and outgoing): call `startWatcher()` + register `recordingReady` listener → on event: remove listener, stop watcher, call `processCallAutomatically_fromBase64()`
  5. On `IDLE` (native): if listener still active (watcher never fired) → remove + stop + fall back to `processSamsungRecording()`; if listener is null (event already fired) → just stop watcher
  6. Cleanup in `useEffect` return: remove listener + stop watcher
**Status:** DONE

### [2026-03-01] — Deleted dead code src/services/gemini.ts
**Files changed:** `src/services/gemini.ts` (DELETED)
**Problem:** File was never imported anywhere; contained the wrong model name `gemini-3-flash-preview`; caused confusion with the live `geminiClient.ts`
**Fix:** File deleted
**Status:** DONE

### [2026-03-01] — CallService crash when READ_PHONE_STATE denied (Secure Folder / work profile)
**Files changed:** `android/app/src/main/java/com/truesummary/app/CallService.kt`, `android-native/java/com/truesummary/app/CallService.kt`
**Problem:** The app is installed in both the main user (user 0, permissions granted) and Secure Folder (user 95, all permissions denied). When CallService started for user 95, `registerTelephonyCallback()` / `listen()` threw `SecurityException: READ_PHONE_STATE not granted` → unhandled exception crashed the entire app process → "app stopped" dialog on every launch.
**Fix:** Wrapped both `telephonyManager?.registerTelephonyCallback()` and `telephonyManager?.listen()` calls in `try { } catch (_: SecurityException) { }` — service stays alive and running even without READ_PHONE_STATE (call detection is disabled silently in that context)
**Status:** DONE

---

## Session 7 (2026-03-01) — Call summary + Settings UI bug fixes

### [2026-03-01] — SamsungRecordingReader: Remove filename filter, add SIZE check (Fix 1)
**Files changed:** `android-native/java/com/truesummary/app/SamsungRecordingReader.kt`, `android/app/src/main/java/com/truesummary/app/SamsungRecordingReader.kt`
**Problem:** `findLatestCallRecording()` filtered by filename containing "call" or "record". Samsung filenames are `20240615_143022_+821012345678.m4a` — no match. On Android 10+ the `DATA` path column is often empty, so the path fallback also failed. Result: recording always invisible → Gemini never ran → call list always empty.
**Fix:** Removed the `isCallRecording` filename/path check entirely. Added `SIZE` to the projection and skip files < 10 KB (notification sounds) instead. The `DATE_ADDED >= callStartTimeMs/1000 - 5` filter is sufficient — the most recent audio file after OFFHOOK is the call recording.
**Status:** DONE

### [2026-03-01] — RecordingWatcherPlugin: Add .amr extension + MIME type (Fix 2)
**Files changed:** `android-native/java/com/truesummary/app/RecordingWatcherPlugin.kt`, `android/app/src/main/java/com/truesummary/app/RecordingWatcherPlugin.kt`
**Problem:** Extension filter only covered `.m4a`, `.mp3`, `.aac`. Some Samsung devices record in `.amr` format — those files were silently ignored.
**Fix:** Added `.amr` to the extension guard and mapped it to `audio/amr` in the MIME type `when` expression.
**Status:** DONE

### [2026-03-01] — CallService: DATA_SYNC → MICROPHONE foreground service type (Fix 3)
**Files changed:** `android-native/java/com/truesummary/app/CallService.kt`, `android/app/src/main/java/com/truesummary/app/CallService.kt`
**Problem:** Session 5 fixed the manifest to `foregroundServiceType="microphone"` but the code comment and constant were left as `DATA_SYNC`, causing a mismatch between manifest declaration and runtime type.
**Fix:** Changed `FOREGROUND_SERVICE_TYPE_DATA_SYNC` → `FOREGROUND_SERVICE_TYPE_MICROPHONE` in `startForeground()` call; updated comment.
**Status:** DONE

### [2026-03-01] — CallDetectorPlugin: Overlay button always opens settings (Fix 4)
**Files changed:** `android-native/java/com/truesummary/app/CallDetectorPlugin.kt`, `android/app/src/main/java/com/truesummary/app/CallDetectorPlugin.kt`
**Problem:** `requestOverlayPermission()` had a `!Settings.canDrawOverlays()` guard — if permission was already granted, it silently did nothing. User couldn't verify or toggle the permission.
**Fix:** Removed the guard condition. The system settings screen opens unconditionally (on M+), allowing the user to see and change the current state.
**Status:** DONE

### [2026-03-01] — App.tsx: Settings back button icon (Fix 5)
**Files changed:** `src/App.tsx`
**Problem:** Settings modal close button used `<Activity size={24} className="rotate-45" />` — a pulse/waveform icon rotated 45°, which looks like a diagonal line, not a recognizable close button.
**Fix:** Added `X` to lucide-react import; replaced with `<X size={24} />`.
**Status:** DONE

---

## Session 8 (2026-03-01) — CallService never starting + call detection completely broken

### [2026-03-01] — foregroundServiceType mismatch: manifest=dataSync, code=MICROPHONE
**Files changed:** `android/app/src/main/AndroidManifest.xml`, `android-native/AndroidManifest_additions.xml`, `android/app/src/main/java/com/truesummary/app/CallService.kt`, `android-native/java/com/truesummary/app/CallService.kt`
**Problem:** Session 7 Fix 3 changed CallService code to `FOREGROUND_SERVICE_TYPE_MICROPHONE` (0x00000080) but the manifest still declared `foregroundServiceType="dataSync"` (0x00000001). Android requires the runtime type to be a subset of the manifest declaration → `IllegalArgumentException` → crash on every launch.
**Fix:** Reverted code back to `FOREGROUND_SERVICE_TYPE_DATA_SYNC` to match the manifest's `dataSync` declaration. Also reverted manifest permission from `FOREGROUND_SERVICE_MICROPHONE` back to `FOREGROUND_SERVICE_DATA_SYNC`. Kept `dataSync` everywhere — it needs no runtime permissions and works in all user contexts (including Secure Folder).
**Status:** DONE

### [2026-03-01] — MICROPHONE type crashes Secure Folder instance (u95)
**Files changed:** same as above
**Problem:** When the manifest was briefly changed to `foregroundServiceType="microphone"`, the Secure Folder instance (user 95) crashed because `FOREGROUND_SERVICE_TYPE_MICROPHONE` requires `RECORD_AUDIO` to be granted at the moment `startForeground()` is called — Secure Folder denies all runtime permissions.
**Fix:** Same revert to `dataSync` — no runtime permissions required, works everywhere.
**Status:** DONE

### [2026-03-01] — READ_MEDIA_AUDIO never requested → Samsung recording always invisible
**Files changed:** `src/App.tsx`
**Problem:** `RecordingWatcherPlugin` declares `READ_MEDIA_AUDIO` (Android 13+) and `READ_EXTERNAL_STORAGE` (≤12) permissions, but `requestPermissions()` was never called for it. Without `READ_MEDIA_AUDIO`, MediaStore returns zero results for audio files → `SamsungRecordingReader.findLatestCallRecording()` always returns null → "NO_RECORDING_FOUND" → no summaries ever generated.
**Fix:** Added `RecordingWatcher.requestPermissions()` call in `init()`. Later moved to fire-and-forget (see below).
**Status:** DONE

### [2026-03-01] — CRITICAL: requestPermissions() hanging → CallService never started → zero call detection
**Files changed:** `src/App.tsx`
**Problem:** On Samsung, `CallDetector.requestPermissions()` triggers a system permission dialog which pauses the app. The Capacitor Promise never resolved (dialog was dismissed or stuck in Samsung's permission manager lifecycle). Since `startCallDetection()` was `await`-ed after `requestPermissions()` in the same try block, it was never called. `CallService` never started → no RINGING/OFFHOOK/IDLE events → no UI popup, no recording, no summaries, no call list — everything broken.
**Diagnosis:** `dumpsys activity services com.truesummary.app` showed only WebView sandbox processes, no `CallService`. Logcat showed `requestPermissions` callbackId logged but no further plugin calls ever.
**Fix:** Changed both `CallDetector.requestPermissions()` and `RecordingWatcher.requestPermissions()` to fire-and-forget (`.catch(() => {})`), not awaited. `startCallDetection()` now runs immediately at app launch regardless of permission dialog state. If permissions were already granted (most cases after first run), the dialogs don't appear at all.
**Status:** DONE — CallService confirmed running via `dumpsys activity services`

---

## Session 9 (2026-03-02) — Pipeline debug logging + bug fixes

### [2026-03-02] — Bug 1: ViewingCall modal close button icon
**Files changed:** `src/App.tsx`
**Problem:** The Call Detail modal (`viewingCall`) close button used `<Activity size={24} className="rotate-45" />` — a waveform icon rotated 45°, not a recognisable close (×) icon. Session 7 only fixed the Settings modal.
**Fix:** Changed to `<X size={24} />` (X is already imported).
**Status:** DONE

### [2026-03-02] — Bug 2: CallService.kt class-level comment out of date
**Files changed:** `android/app/src/main/java/com/truesummary/app/CallService.kt`, `android-native/java/com/truesummary/app/CallService.kt`
**Problem:** android/ copy still said `foregroundServiceType="microphone"`; android-native/ copy still said `foregroundServiceType="phoneCall"`. Both manifest and code use `dataSync` since Session 8. Misleading comment risked accidental revert.
**Fix:** Updated both comments to accurately describe `dataSync` and why it is used.
**Status:** DONE

### [2026-03-02] — Diagnostic logging: App.tsx pipeline checkpoints
**Files changed:** `src/App.tsx`
**Problem:** No visibility into which stage of the recording → Gemini → save pipeline fails on a real device without adb attached.
**Fix:** Added `console.log("[TrueSummary] ...")` at every pipeline checkpoint: `handleCallStateChange` entry (state, callAnsweredTimeMs, isNativePlatform), after `startWatcher()` success, inside `recordingReady` callback (fileName, mimeType, base64.length), IDLE branch taken (watcher fired vs fallback), `processSamsungRecording` start (callStartTimeMs), `processCallAutomatically_fromBase64` start (base64.length, mimeType), after `processCallAudio` returns (transcript.length, name, role), after `saveCall` succeeds (phone_number, name). Also improved `setStatusMessage` calls with more granular stage labels visible in UI.
**Status:** DONE

### [2026-03-02] — Diagnostic logging: CallService.kt handleStateChange
**Files changed:** `android/app/src/main/java/com/truesummary/app/CallService.kt`, `android-native/java/com/truesummary/app/CallService.kt`
**Fix:** Added `import android.util.Log`; computed `prevStr` before updating `lastState`; added `Log.d("TrueSummary", "CallService: $prevStr → $stateStr, callAnsweredTimeMs=..., phone=...")` after state update.
**Status:** DONE

### [2026-03-02] — Diagnostic logging: RecordingWatcherPlugin.kt handleNewFile
**Files changed:** `android/app/src/main/java/com/truesummary/app/RecordingWatcherPlugin.kt`, `android-native/java/com/truesummary/app/RecordingWatcherPlugin.kt`
**Fix:** Added `import android.util.Log`; log at: received path, extension skip, file exists/size, emit `recordingReady` (filename + base64.length), exception path. Also logs when `startWatcher()` begins watching.
**Status:** DONE

### [2026-03-02] — Diagnostic logging: SamsungRecordingReader.kt findLatestCallRecording
**Files changed:** `android/app/src/main/java/com/truesummary/app/SamsungRecordingReader.kt`, `android-native/java/com/truesummary/app/SamsungRecordingReader.kt`
**Fix:** Added `import android.util.Log`; added `dateAddedCol` to cursor column indices; log at: search start (minDateAddedSec), each cursor row (DISPLAY_NAME, SIZE, DATE_ADDED), skip-small-file, found result (name, mimeType, uri), returning null.
**Status:** DONE

---

## Session 10 (2026-03-02) — Personal CRM: Commitments + Search + Contact Timeline

### [2026-03-02] — tasks table + new DB query functions
**Files changed:** `src/services/database.ts`
**Problem:** No way to store or query commitments extracted from calls.
**Fix:** Added `tasks` table schema (`CREATE_TASKS_SQL`); added `Task`/`TaskInput` interfaces; added `computeDueTs()`, `saveTasks()`, `getPendingTasks()`, `markTaskDone()`, `getCallsByPhone()`, `searchCalls()`. Modified `saveCall()` to return `{ id: number }` (CapacitorSQLite `lastId`; web path returns `{ id: lastInsertRowid }`).
**Status:** DONE

### [2026-03-02] — server.ts: tasks table + 6 new API endpoints
**Files changed:** `server.ts`
**Problem:** Web dev mode had no endpoints for tasks/search/AI-search.
**Fix:** Added `tasks` table DDL; `computeDueTs()` helper; endpoints: `GET /api/tasks`, `POST /api/save-tasks`, `POST /api/task-done`, `GET /api/calls-by-phone/:phone`, `GET /api/search`, `POST /api/ai-search`. Updated `POST /api/save-call` to return `{ id }`. Updated `POST /api/process-call` to parse and return `tasks[]` from Gemini JSON.
**Status:** DONE

### [2026-03-02] — Gemini prompt extended with commitment extraction
**Files changed:** `src/services/geminiClient.ts`, `server.ts`
**Problem:** Gemini only returned `{ name, role, summary }` — no action items.
**Fix:** Extended `SUMMARY_INSTR` with rule #4 (tasks array, Hebrew 5-10 words each, `due_category`). Updated `processCallAudio()` return type to include `tasks: TaskInput[]`. Added defensive parsing (filter malformed, default `no_deadline`). Added `askAIAboutCalls(question, transcripts[])` for AI deep-search on call history.
**Status:** DONE

### [2026-03-02] — Kotlin: NotificationSchedulerPlugin + NotificationReceiver
**Files changed:** `android-native/java/.../NotificationSchedulerPlugin.kt` (NEW), `android-native/java/.../NotificationReceiver.kt` (NEW), `android/app/src/main/java/.../NotificationSchedulerPlugin.kt` (NEW), `android/app/src/main/java/.../NotificationReceiver.kt` (NEW), both `MainActivity.kt`, both `AndroidManifest*.xml`
**Problem:** No way to schedule OS task-reminder notifications from JS.
**Fix:** `NotificationSchedulerPlugin` exposes `scheduleNotification(id, title, body, triggerAtMs)` (inexact `AlarmManager.set`) and `cancelNotification(id)`. `NotificationReceiver` creates channel `truesummary_tasks` and posts the notification. Registered in `MainActivity` and declared in both manifests.
**Status:** DONE

### [2026-03-02] — Session 11: Incoming call heads-up notification
**Files changed:** `android/app/src/main/java/com/truesummary/app/OverlayManager.kt`, `android-native/java/com/truesummary/app/OverlayManager.kt`, `android/app/src/main/java/com/truesummary/app/CallService.kt`, `android-native/java/com/truesummary/app/CallService.kt`
**Problem:** The existing overlay (`OverlayManager`) requires `SYSTEM_ALERT_WINDOW` (manual permission grant in Settings) and is hidden behind Samsung's native dialer screen on many devices. Users couldn't see the last call summary when a call arrived.
**Fix:**
  1. `OverlayManager.getLastSummaryForNumber()`: changed visibility `private` → `internal` so `CallService` can call it directly.
  2. `CallService`: added `INCOMING_CHANNEL_ID`/`INCOMING_NOTIF_ID` constants.
  3. `CallService.createNotificationChannel()`: registers a second `IMPORTANCE_HIGH` channel (`truesummary_incoming_call`) — silent (no vibration/sound), no badge; heads-up banner appears over the Samsung dialer screen automatically.
  4. `CallService.showIncomingCallNotification(phoneNumber)`: reads last summary from SQLite via `OverlayManager.getLastSummaryForNumber()`, posts a `BigTextStyle` heads-up notification with caller number + summary.
  5. `CallService.cancelIncomingCallNotification()`: cancels notification ID 1002.
  6. `CallService.handleStateChange()`: RINGING → show overlay + heads-up; OFFHOOK → cancel heads-up; IDLE → hide overlay + cancel heads-up.
  No manifest changes needed — `POST_NOTIFICATIONS` already declared.
**Status:** DONE

---

### [2026-03-02] — Tasks tab: Show completed tasks + Restore (undo done)
**Files changed:** `src/services/database.ts`, `server.ts`, `src/App.tsx`
**Problem:** Once a task was marked done it disappeared permanently — no undo.
**Fix:**
  1. `database.ts`: added `getCompletedTasks()` (done=1, newest-50) and `markTaskUndone()` (sets done=0).
  2. `server.ts`: added `GET /api/tasks-done` and `POST /api/task-undone` routes.
  3. `App.tsx`: added `doneTasks` state + `loadDoneTasks()` helper; called at init, visibility-change, after every processed call, and on the header Refresh button. `handleMarkTaskDone` now also refreshes done list. Added `handleRestoreTask`. Done section renders below the pending list (only when non-empty): gray divider "בוצעו (N)", cards with `opacity-60` + strikethrough text + RotateCcw "החזר" restore button.
**Status:** DONE

### [2026-03-02] — App.tsx: Tab bar + Tasks tab + Search tab + Contact Timeline
**Files changed:** `src/App.tsx`
**Problem:** App had only a calls list with no CRM features.
**Fix:**
  1. Added `NotificationScheduler` plugin interface via `registerPlugin`.
  2. Added state: `activeTab`, `tasks`, `searchQuery`, `searchResults`, `aiAnswer`, `isAiSearching`, `contactView`, `contactCalls`.
  3. Added tab bar (שיחות / משימות / חיפוש) with red badge on Tasks when pending.
  4. Caller name in Calls tab is now clickable → opens Contact Timeline modal.
  5. Tasks tab: cards with colored due badge (היום/מחר/השבוע/ללא מועד), "סמן כבוצע" button → `markTaskDone()` + cancel notification.
  6. Search tab: debounced (300ms) SQL search; "AI חיפוש עמוק" button calls `askAIAboutCalls()` → AI answer card.
  7. Contact Timeline modal: all calls with that person, tap to open detail.
  8. `processCallAutomatically_fromBase64` and `processCallAutomatically` both now call `saveTasks()` + `scheduleNotification()` after saving the call.
  9. `loadTasks()` called on init, visibility change, and after every processed call.
**Status:** DONE

---

## Session 13 (2026-03-02) — Call direction, phone visibility, card→timeline, full summaries

### [2026-03-02] — call_type field: incoming/outgoing tracking
**Files changed:** `src/services/database.ts`, `server.ts`, `src/App.tsx`
**Problem:** No way to distinguish incoming vs outgoing calls; phone number was too faint; tapping a call card opened single-call detail instead of contact timeline; contact timeline truncated summaries.
**Fix:**
  1. `database.ts`: added `call_type: 'incoming' | 'outgoing'` to `Call` interface; added column to `CREATE_CALLS_SQL`; added ALTER TABLE migration after `db.open()` for upgrade; added `call_type` param to `saveCall()` + native INSERT.
  2. `server.ts`: added `call_type` column to CREATE TABLE DDL; added `try { ALTER TABLE ... } catch {}` migration; updated `/api/save-call` to accept and insert `call_type`.
  3. `App.tsx`:
     - Added `PhoneOutgoing` to lucide-react import.
     - Added `callDirectionRef` (ref, default `'incoming'`).
     - Set `callDirectionRef.current = 'incoming'` on OFFHOOK←RINGING; `'outgoing'` on OFFHOOK←IDLE; reset to `'incoming'` in cleanup paths of both `processCallAutomatically_fromBase64` and `processCallAutomatically`.
     - `simulateIncomingCall`: sets `callDirectionRef.current = 'incoming'`.
     - Both save paths pass `call_type: callDirectionRef.current` to `saveCall()`.
     - Calls tab card: whole card click now opens contact timeline (was: opens single-call detail); simulate button still works via `e.stopPropagation()`.
     - Phone number: changed from `text-xs text-gray-500` → `text-sm text-gray-300 font-medium` (clearly visible).
     - Direction icon: green `PhoneIncoming` / blue `PhoneOutgoing` shown before caller name in card.
     - Call Detail Modal header: direction badge added (נכנסת/יוצאת); phone number changed to `text-gray-300`.
     - Contact Timeline: removed `line-clamp-2` → full summaries shown; added direction badge (נכנסת/יוצאת) per call entry.
**Status:** DONE

---

## Session 14 (2026-03-02) — Tasks tab: sub-tabs + caller number visibility

### [2026-03-02] — Tasks tab: "לביצוע" / "בוצעו" sub-tabs + caller name layout
**Files changed:** `src/App.tsx`
**Problem:** Tasks tab showed pending and done tasks in one scrolling list (done tasks below a divider with opacity-60). Caller name + phone were crammed into one tiny `text-xs text-gray-500` line.
**Fix:**
  1. Added `taskSubTab` state (`'todo' | 'done'`, default `'todo'`).
  2. Replaced the single Tasks `<section>` with a sub-tab bar + two conditional panels.
  3. Sub-tab bar: pill toggle with blue active state; badge shows pending count on "לביצוע", done count on "בוצעו".
  4. Todo panel: same task cards; caller info now two lines — name on `text-sm text-gray-300 font-medium`, phone + date on `text-xs text-gray-500`.
  5. Done panel: cards with `opacity-70` + strikethrough; caller info similarly two-line but muted; "החזר" button calls `handleRestoreTask`.
  6. Empty states for both panels.
**Status:** DONE

---

## Session 15 (2026-03-02) — Fix Contact Timeline showing all callers instead of one

### [2026-03-02] — `openContactView`: replace async DB query with in-memory filter
**Files changed:** `src/App.tsx`
**Problem:** Contact Timeline modal showed calls from all callers instead of only the tapped caller. Root cause: `getCallsByPhone(phone)` CapacitorSQLite parameterized query returned all rows on this device. Also a stale-state window — `setContactView` opened the modal before the async query resolved, briefly showing data from a previous caller.
**Fix:** Replaced `openContactView` (async, DB call) with a synchronous in-memory filter of `callHistoryRef.current`. `setContactCalls(filtered)` now runs before `setContactView(...)` so the modal always opens with the correct data. Removed `async`/`await`/try-catch.
**Status:** DONE

---

## Session 16 (2026-03-02) — Task card: collapsible "סיבת המשימה" dropdown

### [2026-03-02] — Task cards: show parent call summary with keyword highlight
**Files changed:** `src/services/database.ts`, `server.ts`, `src/App.tsx`
**Problem:** Task cards showed no context for why a task was created. The `Task` object had no `summary` field — only fields from the `tasks` table.
**Fix:**
  1. `database.ts`: Added `summary?: string` to `Task` interface. Updated `getPendingTasks` and `getCompletedTasks` native queries to LEFT JOIN `calls c ON t.call_id = c.id` and select `c.summary as summary`.
  2. `server.ts`: Updated `/api/tasks` and `/api/tasks-done` queries to the same LEFT JOIN pattern.
  3. `App.tsx`:
     - Added `ChevronDown`, `ChevronUp` to lucide-react imports.
     - Added `expandedTaskId: number | null` state (single-open accordion).
     - Added `renderHighlightedSummary(summary, taskText)` helper: splits summary into sentences, extracts keywords (>2 chars) from task text, renders matching sentences with `bg-amber-500/15 text-amber-200` highlight, others as `text-gray-400`.
     - Todo and done task cards: changed outer wrapper from `p-6 space-y-4` to `overflow-hidden` with inner `p-6 space-y-4` div; added `border-t` divider + chevron toggle button ("סיבת המשימה") + collapsible summary block with `border-r-2 border-amber-500/40` left accent. Toggle only shown when `task.summary` is truthy.
**Status:** DONE

---

## Session 17 (2026-03-02) — Header UI rearrangement

### [2026-03-02] — Move Settings to top-left, remove Refresh, move Scan button to Calls tab
**Files changed:** `src/App.tsx`
**Problem:** User requested three layout changes after scan/history button was added to header in previous session.
**Fix:**
  1. Removed the entire right-side button group from the header (`<div className="flex items-center gap-3">`).
  2. Removed `justify-between` from `<header>` — now just `gap-5`.
  3. Added Settings button as the **first** child of the header (top-left), before the phone icon.
  4. Deleted the Refresh button (`RefreshCw`) entirely — redundant alongside scan.
  5. Removed `RefreshCw` from lucide-react imports.
  6. Added the scan button (`scanMissedCalls`) inside `activeTab === 'calls'` section, above the `<div className="grid gap-5">`, wrapped in `Capacitor.isNativePlatform()` guard. Renders as a full-width amber button.
**Status:** DONE

---

## Session 18 (2026-03-02) — Phone number display + recording filter + contact view fix

### [2026-03-02] — Show phone number next to name; filter Samsung recordings to calls only; fix contact view
**Files changed:** `src/App.tsx`, `android-native/java/…/SamsungRecordingReader.kt`, `android/app/src/…/SamsungRecordingReader.kt`

**Fix 1 — Phone number next to name (App.tsx):**
  Moved `call.phone_number` from the second row (date/time row) onto the first row, right after the caller name, as `text-sm text-gray-400 font-mono`. Removed it from the second row. Second row now shows only date • time and duration.

**Fix 2 — Contact timeline always matches exact phone number (App.tsx):**
  `openContactView` previously fell back to name-matching when phone was empty, which could mix calls from different numbers with the same name. Now ALWAYS filters `callHistoryRef.current` by `phone_number === phone` only.

**Fix 3 — Samsung recording reader: only phone call recordings (SamsungRecordingReader.kt):**
  Added `isCallRecording(displayName, relativePath)` helper. Queries `RELATIVE_PATH` (API 29+) and checks:
  - Hard exclusions: paths containing "whatsapp", "telegram", "viber", "music", "podcast", "download", "ringtone", "notification"
  - Inclusion: RELATIVE_PATH or DISPLAY_NAME contains "call" or "record" or "recording"
  Applied to all three functions: `findLatestCallRecording`, `listRecentRecordings`, `findRecordingAt`.
  Both `android-native/` and `android/` copies updated.
**Status:** DONE

---

### [2026-03-02] — Show contact name from phone book + phone number as caller ID
**Files changed:** `android-native/AndroidManifest_additions.xml`, `android-native/java/com/truesummary/app/CallDetectorPlugin.kt`, `android-native/java/com/truesummary/app/OverlayManager.kt`, `src/App.tsx`
**Problem:** App had zero contact lookup — `caller_name` was always set from Gemini AI. No `READ_CONTACTS` permission declared. Phone book names were never shown.
**Fix:**
- `AndroidManifest_additions.xml`: added `READ_CONTACTS` permission
- `CallDetectorPlugin.kt`: added `READ_CONTACTS` to `@CapacitorPlugin` annotation, added `ContactsContract` import, added new `@PluginMethod lookupContactName(phone)` that queries `ContactsContract.PhoneLookup` on a background thread and returns `{ name }` if found
- `OverlayManager.kt`: added `getContactName(context, phoneNumber)` helper; lock-screen overlay header now shows "📞 Dad" instead of "📞 +972501234567"
- `src/App.tsx`: added `lookupContactName` to `CallDetectorPlugin` interface; added `contactNameRef`; added `lookupContactName()` async helper; RINGING handler now looks up contact name and uses it as display name (with DB name as fallback); `scanMissedCalls` loop resets `contactNameRef` and looks up contact name after phone extraction; `processCallAutomatically_fromBase64` saves `contactNameRef.current || detectedName` so contact names take priority over AI-detected names
**Status:** DONE

---

### [2026-03-02] — Fix call history mix, phone number display, and incoming caller lookup
**Files changed:** `src/App.tsx`, `src/services/database.ts`
**Problem:** Three related bugs all caused by `scanMissedCalls` never setting `incomingNumberRef.current`, so calls were saved with `phone_number = ""`. This caused: (1) no phone number shown on call cards, (2) tapping any empty-phone call mixed all contacts' histories together (all matched `phone_number === ""`), (3) overlay always said "שיחה ראשונה" because DB lookup found no prior call for the number.
**Fix:**
- `extractPhoneFromFilename()` helper added to `App.tsx` — extracts phone from Samsung recording filename patterns (intl `+972…` and local `05…`)
- `scanMissedCalls` loop now resets `incomingNumberRef/incomingNameRef/selectedCallRef` at top of each iteration, then populates them from filename-extracted phone before calling `processCallAutomatically_fromBase64`
- `openContactView` now uses normalized phone comparison instead of exact `===`; falls back to name-match for legacy empty-phone calls
- `getCallerByPhone` in `database.ts` gains a local `normalizePhone` helper and queries with both raw and normalized variants so `+9720501234567` matches `0501234567`
**Status:** DONE

---

## Session 19 (2026-03-02) — Group call history + fix incoming call contact name

### [2026-03-02] — Call history: grouped by contact with collapsible per-call entries
**Files changed:** `src/App.tsx`
**Problem:** If the same contact called 5 times, the Calls tab showed 5 identical cards. No way to quickly scan who called most recently; repeated cards cluttered the list.
**Fix:**
1. `normalizePhone` moved from inside App component to module level (before `export default function App()`), enabling safe reference inside `useMemo`.
2. Added `useMemo` to React import.
3. Added `expandedContactKey: string | null` state.
4. Added `groupedCalls` useMemo: groups `callHistory` into `Call[][]` arrays keyed by normalized phone; each group is ordered newest-first (matching DB order). Calls with no phone get a unique `__noPhone_<id>` key.
5. Replaced `callHistory.map(...)` in the Calls tab with `groupedCalls.map(...)`:
   - Header card shows latest call's name + phone + direction icon + most recent date/duration.
   - If `group.length > 1`: green badge showing "N שיחות" and a ChevronDown/Up toggle button.
   - Expanded body (when `expandedContactKey === key`): per-call rows with date • time, incoming/outgoing badge, and `line-clamp-3` summary text.
   - Simulate button and contact-view click preserved on group header (uses `group[0]`).
**Status:** DONE

### [2026-03-02] — handleCallScreened: add contact phone-book lookup
**Files changed:** `src/App.tsx`
**Problem:** `handleCallScreened` (fired by `TrueSummaryScreeningService`) correctly received the phone number but never called `lookupContactName`, so the in-app overlay always showed the DB name or "מתקשר לא מזוהה" instead of the contact's actual name from the phone book.
**Fix:** Added `lookupContactName(data.phoneNumber)` call at the top of `handleCallScreened`. Contact name is set immediately if found; DB name is used as fallback only when contact lookup returns empty.
**Status:** DONE

### [2026-03-02] — OverlayManager.kt: show name + phone number stacked on lock-screen overlay
**Files changed:** `android-native/java/com/truesummary/app/OverlayManager.kt`
**Problem:** Overlay showed EITHER the contact name ("📞 Dad") OR the raw phone number ("📞 +972501234567") but never both. When contact was known, the phone number was invisible.
**Fix:** Added a `phoneSubView` (gray, 13sp, indented) that appears below the name line only when `contactName != null`. Layout is now: bold name → gray phone number → summary text.
**Note:** `android/` directory (production copy) is created after `npx cap sync android`; only `android-native/` source template updated here.
**Status:** DONE

---

## Session 10 — Calls tab: card redesign + key fix + auto contact sync

### [2026-03-03] — Fix JSX key bug (expand/collapse broken for name-grouped calls)
**Files changed:** `src/App.tsx`
**Problem:** `groupedCalls.map(...)` computed the card key as `__noPhone_${latest.id}` for calls without a phone number, but the useMemo grouping used `__name_${caller_name}` for named callers. Mismatch meant `expandedContactKey` never matched → chevron expand/collapse did nothing.
**Fix:** Key computation now mirrors useMemo logic exactly: phone → `normalizePhone`, named caller → `__name_${caller_name}`, unknown → `__noPhone_${id}`.
**Status:** DONE

### [2026-03-03] — Redesign call card: add summary preview, clean layout
**Files changed:** `src/App.tsx`
**Problem:** Cards showed name + phone + date only — no summary text visible. Phone number was always shown inline even when empty (empty `<span>`). Layout was cramped in one row.
**Fix:** Replaced card body with 4-row layout: (1) direction icon + bold name, (2) phone number (conditional — hidden when empty), (3) summary preview (line-clamp-2, gray), (4) date + call count badge. Duration removed from main card (still visible in expanded sub-rows).
**Status:** DONE

### [2026-03-03] — Auto-sync contact names silently on every loadCallHistory (native)
**Files changed:** `src/App.tsx`
**Problem:** Contact names from the phonebook were only applied when the user manually tapped "סנכרן אנשי קשר". New calls with a phone number would show AI-detected or unknown names until manual sync.
**Fix:** Added `syncContactNamesSilent()` — same logic as `syncContactNames` but no status messages. Called fire-and-forget inside `loadCallHistory` when on native. Refreshes the call list silently when done.
**Status:** DONE

### [2026-03-03] — Incoming call popup redesign (popup.png style)
**Files changed:** `src/App.tsx`, `android-native/java/com/truesummary/app/OverlayManager.kt`
**Problem:** Both the React calling screen and the native overlay used a different layout — big avatar, 6xl name, truncated single summary card. The desired design is a compact card with a small avatar header, blue badge, full summary text + date, divider, and up to 2 previous calls.
**Fix:**
  1. `src/App.tsx`: Added `incomingCallHistory: Call[]` state. Populated fire-and-forget via `getCallsByPhone()` in both `handleCallStateChange` RINGING handler and `handleCallScreened`. Reset in both `processCallAutomatically_fromBase64` and `processCallAutomatically` cleanup timeouts.
  2. `src/App.tsx` calling screen JSX: Replaced big avatar + 6xl name + rounded summary card with scrollable popup layout — small avatar row (name + phone), blue badge, full summary + date, divider, "שיחות קודמות:" section (up to 2 entries) shown only when >1 call exists.
  3. `android-native/OverlayManager.kt`: Added `OverlayCallRecord` data class, `getRecentCallsForNumber()` (replaces single-call query), `formatCallDate()` (ISO→"HH:mm d.M.yyyy"), `createRoundedBg()`, `createCircleBg()` helpers. Rewrote `showIncomingCallOverlay()` body to match popup layout with RTL layout, avatar circle, name+phone header, blue badge, main summary+date, divider, previous calls section.
**Status:** DONE

---

## Session 10 — Re-summarize + AI Chat with Recording Access

### [2026-03-03] — Feature: Re-summarize call from stored transcript
**Files changed:** `src/services/database.ts`, `src/services/geminiClient.ts`, `server.ts`, `src/App.tsx`
**Problem:** No way to get a detailed, expanded summary from a call that was already processed.
**Fix:**
  1. `database.ts`: Added `recording_timestamp_ms` field to `Call` interface + `ALTER TABLE` migration. Updated `saveCall` to accept and store `recordingTimestampMs`. Added `getCallById()` (GET /api/calls/:id on web, direct SQLite on native) and `updateCallSummary()` (PATCH /api/calls/:id/summary on web, UPDATE SQL on native).
  2. `server.ts`: Added `ALTER TABLE calls ADD COLUMN recording_timestamp_ms`. Updated `/api/save-call` to accept `recording_timestamp_ms`. Added `GET /api/calls/:id`, `PATCH /api/calls/:id/summary`, and `POST /api/resummarize` (calls Gemini with DETAILED_SUMMARY_INSTR prompt).
  3. `geminiClient.ts`: Added `DETAILED_SUMMARY_INSTR` constant. Added `resummmarizeCall(transcript)` — POST /api/resummarize on web, direct Gemini on native.
  4. `App.tsx`: Added `resummmarizingId` state. Added `handleResummarize()` handler. Added RotateCcw button (amber) on each call card header that spins while re-summarizing — only visible when `call.transcript` is non-empty.
**Status:** DONE

### [2026-03-03] — Feature: AI Chat with deep single-call analysis + recording access
**Files changed:** `src/services/geminiClient.ts`, `server.ts`, `src/App.tsx`, `android-native/…/SamsungRecordingReader.kt`, `android-native/…/CallDetectorPlugin.kt`
**Problem:** AI chat answered from summaries only; no way to ask detailed questions about a specific call using its raw audio/transcript.
**Fix:**
  1. `geminiClient.ts`: Added `askAboutSpecificCall()` (sends audio inlineData if available, otherwise stored transcript + fallback note). Added `identifyCallFromQuestion()` (fast Gemini call to determine if question targets a single call; returns call ID or null).
  2. `server.ts`: Added `POST /api/ask-about-call` endpoint (accepts question + call data + optional audioBase64/mimeType, calls Gemini, returns answer).
  3. `App.tsx`: Rewrote `sendChatMessage()` as two-step flow — Step 1: identifyCallFromQuestion(); Step 2a: if specific call identified, shows "מחפש הקלטה...", fetches recording via getRecordingByTimeRange(), calls askAboutSpecificCall(); Step 2b: falls back to general askAIAboutCalls(). Added `getRecordingByTimeRange` to CallDetectorPlugin TypeScript interface. Both saveCall() calls now pass `recordingTimestampMs`.
  4. `SamsungRecordingReader.kt`: Added `findRecordingInRange(context, startMs, endMs)` — MediaStore query with DATE_ADDED BETWEEN (startMs/1000 - 10) AND (endMs/1000 + 120), same filtering logic as existing methods.
  5. `CallDetectorPlugin.kt`: Added `getRecordingByTimeRange(@PluginMethod)` — calls findRecordingInRange, reads as Base64, resolves with {base64, mimeType}.
**Status:** DONE


### [2026-03-03] — Fix: AI Chat plain text + focused answers; move re-summarize button into contact modal
**Files changed:** `src/services/geminiClient.ts`, `server.ts`, `src/App.tsx`
**Problem:**
  1. AI Chat (askAIAboutCalls + askAboutSpecificCall) and re-summarize output markdown formatting (##, **, bullet lists) — ugly in plain-text chat UI. Also, specific questions caused the entire summary to be dumped instead of a focused answer.
  2. Re-summarize button was on the call card list — wrong place; it belongs inside the contact detail modal per-call entry.
**Fix:**
  1. `geminiClient.ts` + `server.ts`: Updated 3 system instructions — no-markdown, conversational, focused answers.
  2. `App.tsx`: Removed RotateCcw button from call card list. Added re-summarize button inside contactCalls.map() below each call summary. handleResummarize() now also updates contactCalls in-place.
**Status:** DONE

---

## Session 11 (2026-03-03) — Bug fixes + delete features

### [2026-03-03] — Fix checkPendingCall stale closure bug
**Files changed:** `src/App.tsx`
**Problem:** `checkPendingCall` used `isProcessing` state directly, but it's captured in useEffect/visibilitychange handlers — stale closure means it always reads the initial `false` value, so it could trigger duplicate processing.
**Fix:** Changed to `isProcessingRef.current`.
**Status:** DONE

### [2026-03-03] — Fix getCallsByPhone phone normalization (native + server)
**Files changed:** `src/services/database.ts`
**Problem:** Native SQLite query did exact match `phone_number = ?`, so +972501234567 wouldn't match 0501234567. The incoming call history ("שיחות קודמות") section and contact timeline would miss calls stored with a different phone format.
**Fix:** Added normalizePhone + query with both raw and normalized variants (same pattern as `getCallerByPhone`).
**Status:** DONE

### [2026-03-03] — Fix updateCallerNameByPhone normalization
**Files changed:** `src/services/database.ts`
**Problem:** `updateCallerNameByPhone` did exact match on phone_number. If DB stored +972501234567 but sync passed 0501234567, the contact name update wouldn't match.
**Fix:** Added normalizePhone + UPDATE with IN clause for both variants.
**Status:** DONE

### [2026-03-03] — Fix processCallAutomatically (web) missing guards
**Files changed:** `src/App.tsx`
**Problem:** `processCallAutomatically` (web blob version) didn't check/set `isProcessingRef` like the `_fromBase64` version. Could cause double processing on web. Also missing `contactNameRef` reset in cleanup, so stale contact name could bleed into next call.
**Fix:** Added `isProcessingRef.current` guard at top and reset in both success and error cleanup timeouts. Added `contactNameRef.current = ''` reset.
**Status:** DONE

### [2026-03-03] — Fix triple-m typo: resummmarize → resummarize
**Files changed:** `src/App.tsx`, `src/services/geminiClient.ts`
**Problem:** Function and state names had three m's: `resummmarizeCall`, `resummmarizingId`, `setResummmarizingId`.
**Fix:** Renamed all to two m's: `resummarizeCall`, `resummarizingId`, `setResummarizingId`.
**Status:** DONE

### [2026-03-03] — Throttle syncContactNamesSilent
**Files changed:** `src/App.tsx`
**Problem:** `syncContactNamesSilent` ran on every `loadCallHistory` call, including every `visibilitychange` event. This caused excessive contact-book lookups when switching between apps.
**Fix:** Added `lastContactSyncRef` timestamp; now runs at most once per 5 minutes.
**Status:** DONE

### [2026-03-03] — Fix server phone normalization (3 endpoints)
**Files changed:** `server.ts`
**Problem:** Server endpoints `/api/callers/:phone` and `/api/calls-by-phone/:phone` did exact match on phone_number. Web mode lookups would fail when phone formats differed between DB and request.
**Fix:** Added `normalizePhone` helper to server.ts. Updated both endpoints to query with IN clause using both raw and normalized variants.
**Status:** DONE

### [2026-03-03] — Feature: Delete call from history
**Files changed:** `server.ts`, `src/services/database.ts`, `src/App.tsx`
**Problem:** No way to delete a call from the history — calls with bad recordings or test entries were permanent.
**Fix:**
  1. `server.ts`: Added `DELETE /api/calls/:id` endpoint (cascades to associated tasks).
  2. `database.ts`: Added `deleteCall(id)` function (DELETE on tasks + calls for native, fetch for web).
  3. `App.tsx`: Added `handleDeleteCall` handler, Trash2 icon import, red delete button in contact timeline modal per-call entry (next to re-summarize button).
**Status:** DONE

### [2026-03-03] — Feature: Delete task permanently
**Files changed:** `server.ts`, `src/services/database.ts`, `src/App.tsx`
**Problem:** Tasks could only be marked done/undone — no way to permanently delete irrelevant tasks.
**Fix:**
  1. `server.ts`: Added `DELETE /api/tasks/:id` endpoint.
  2. `database.ts`: Added `deleteTask(id)` function.
  3. `App.tsx`: Added `handleDeleteTask` handler, trash icon button on completed tasks (next to restore button). Also cancels any scheduled notification for the task.
**Status:** DONE

---

## Session 12 (2026-03-03) — Overlay polish + notification improvements + cleanup

### [2026-03-03] — Fix OverlayManager phone normalization
**Files changed:** `android-native/java/.../OverlayManager.kt`
**Problem:** `getRecentCallsForNumber` did exact match on phone_number. If DB stores `0501234567` but call arrives as `+972501234567`, overlay shows "שיחה ראשונה" instead of real summary.
**Fix:** Added `normalizePhone()` helper. Query now uses IN clause with both raw and normalized variants.
**Status:** DONE

### [2026-03-03] — Fix OverlayManager: 0 corner radius → 24dp
**Files changed:** `android-native/java/.../OverlayManager.kt`
**Problem:** Overlay container used `createRoundedBg("#E81C1C1E", 0f)` — flat rectangle.
**Fix:** Changed corner radius to `dp(context, 24).toFloat()` for a modern card look.
**Status:** DONE

### [2026-03-03] — Add overlay auto-dismiss + close button
**Files changed:** `android-native/java/.../OverlayManager.kt`
**Problem:** If overlay gets stuck (e.g., call to voicemail without IDLE), it stays on screen forever. No way to manually dismiss it.
**Fix:**
  1. Added `autoDismissRunnable` field — posts a 45-second delayed hide. Cancelled when overlay is hidden normally.
  2. Added "✕" close button in header row (top-right), calls `hideOverlay` on tap.
**Status:** DONE

### [2026-03-03] — Show contact name in incoming call notifications
**Files changed:** `android-native/java/.../TrueSummaryScreeningService.kt`, `android-native/java/.../CallService.kt`
**Problem:** Heads-up notification showed raw phone number (`📞 +972501234567`) even when contact name is available in the phone book.
**Fix:** Both `postIncomingCallNotification` and `showIncomingCallNotification` now call `OverlayManager.getContactName()`. Notification title shows `📞 Dad` when contact found, falls back to phone number. Phone number appears in content text when contact name is used.
**Status:** DONE

### [2026-03-03] — Remove unused useCallback import
**Files changed:** `src/App.tsx`
**Problem:** `useCallback` was imported but never used.
**Fix:** Removed from import statement.
**Status:** DONE

### [2026-03-03] — Auto-close contact modal when all calls deleted
**Files changed:** `src/App.tsx`
**Problem:** If user deleted all calls for a contact in the timeline modal, it showed empty "אין שיחות" with no useful action.
**Fix:** `handleDeleteCall` now checks if remaining calls are empty after filtering, and auto-closes the contact modal if so.
**Status:** DONE

### [2026-03-03] — Add side margins to overlay (floating card look)
**Files changed:** `android-native/java/.../OverlayManager.kt`
**Problem:** Overlay stretched edge-to-edge (MATCH_PARENT, x=0) looking like a plain banner.
**Fix:** Wrapped container in a FrameLayout with 12dp side margins. WindowManager adds the wrapper, giving the overlay a floating card appearance.
**Status:** DONE

---

## Session 13 (2026-03-03) — Design fixes + phone number display

### [2026-03-03] — Always show phone number on call cards
**Files changed:** `src/App.tsx`
**Problem:** Phone row hidden entirely when `phone_number` is empty — card looks incomplete.
**Fix:** Always render the phone row; show "מספר לא זוהה" (italic, gray-600) as fallback.
**Status:** DONE

### [2026-03-03] — Fix empty phone in call detail modal
**Files changed:** `src/App.tsx`
**Problem:** `viewingCall.phone_number` renders blank line when empty.
**Fix:** Show "מספר לא זוהה" fallback span when phone is empty.
**Status:** DONE

### [2026-03-03] — Fix empty phone in contact timeline modal
**Files changed:** `src/App.tsx`
**Problem:** `contactView.phone` renders empty in modal header.
**Fix:** Show "מספר לא זוהה" fallback when phone is empty.
**Status:** DONE

### [2026-03-03] — Fix task cards dangling separator when phone is missing
**Files changed:** `src/App.tsx`
**Problem:** `{task.phone_number} · {date}` renders ` · 2026-03-03` when phone is empty.
**Fix:** Only render phone + separator when `phone_number` is non-empty (both todo and done tabs).
**Status:** DONE

### [2026-03-03] — Standardize task card border radius
**Files changed:** `src/App.tsx`
**Problem:** Task cards used `rounded-[28px]` while call cards used `rounded-[32px]`.
**Fix:** Changed both todo and done task cards to `rounded-[32px]`.
**Status:** DONE

### [2026-03-03] — Standardize direction icon size in modals
**Files changed:** `src/App.tsx`
**Problem:** Call detail modal and contact timeline modal used `size={11}` for direction icons while main cards use `size={13}`.
**Fix:** Changed to `size={13}` in both modals.
**Status:** DONE

### [2026-03-03] — Fix footer and settings text color consistency
**Files changed:** `src/App.tsx`
**Problem:** Footer used `text-gray-600` while other secondary labels use `text-gray-500`. Settings modal disclaimer also used `text-gray-600`.
**Fix:** Changed both to `text-gray-500`.
**Status:** DONE

### [2026-03-03] — Remove redundant dir="rtl" on incoming call screen
**Files changed:** `src/App.tsx`
**Problem:** Three child elements had `dir="rtl"` when root `<div>` at line 1119 already sets it globally.
**Fix:** Removed redundant `dir="rtl"` from header, summary, and previous-calls divs on the incoming call screen.
**Status:** DONE

---

## Session 14 — Missed calls scan: limit 10, phone dedup, dashboard sync indicator

### [2026-03-03] — Limit missed call scan to 10 most recent recordings
**Files changed:** `src/App.tsx`
**Problem:** Scan fetched all recordings from the last 7 days, which could be excessive and waste Gemini API calls.
**Fix:** After fetching, sort by `dateAddedMs` descending and take only the 10 most recent recordings before filtering.
**Status:** DONE

### [2026-03-03] — Deduplicate recordings by phone number before processing
**Files changed:** `src/App.tsx`
**Problem:** Multiple recordings from the same caller were processed individually, wasting Gemini API calls.
**Fix:** After the time-based dedup filter, group unprocessed recordings by extracted phone number (via `extractPhoneFromFilename` + `normalizePhone`). For each phone, keep only the most recent recording. Recordings with no extractable phone stay as-is.
**Status:** DONE

### [2026-03-03] — Add sync status indicator on dashboard
**Files changed:** `src/App.tsx`
**Problem:** `statusMessage` was only rendered on the live call screen footer. Pressing the scan button from the Calls tab showed zero feedback.
**Fix:** Added an amber animated status bar between the scan buttons and the call cards grid, visible when `statusMessage` is non-empty. Uses `animate-pulse` bars with staggered delays.
**Status:** DONE

---

## Session 15 — Incoming call popup fix + database resilience

### [2026-03-03] — Incoming call popup not showing (core feature broken)
**Files changed:** `src/App.tsx`
**Problem:** `handleCallScreened` fires from `TrueSummaryScreeningService` **before** the RINGING event from `CallService`. It loads caller data (contact name, DB lookup, call history) but never calls `setIsIncomingCall(true)` — so the UI stays on the Dashboard instead of switching to the Live Call Screen.
**Fix:**
1. Added `setIsIncomingCall(true)` and `setStatusMessage('שיחה נכנסת...')` to `handleCallScreened` for incoming calls, plus `setIncomingCallHistory([])` to reset stale state.
2. In the RINGING handler, skip resetting name/number/selectedCall if `callScreened` already loaded data (`incomingNumberRef.current` is set). Prefer phone from `callScreened` over RINGING event. Skip duplicate DB/contact lookups if `selectedCallRef.current` is already populated.
**Status:** DONE

### [2026-03-03] — "Database not initialized" crashes cascade
**Files changed:** `src/services/database.ts`
**Problem:** If `initDatabase()` fails at startup, `db` stays `null`. Then 16 functions throw `Error('Database not initialized')` instead of returning safe defaults, causing cascading failures in the UI.
**Fix:**
1. Added `ensureDb()` helper that retries `initDatabase()` once if `db` is null, then returns `db` or `null`.
2. Replaced all 16 `if (!db) throw` patterns with `const conn = await ensureDb(); if (!conn) return <safe_default>;` — functions return `[]`, `null`, `{ id: 0 }`, or `void` as appropriate.
**Status:** DONE

### [2026-03-03] — Caller cards not displaying on dashboard (Session 15 regression)
**Files changed:** `src/App.tsx`
**Problem:** Session 15's fix added `setIsIncomingCall(true)` to `handleCallScreened` and gated the RINGING handler with `if (!incomingNumberRef.current)`. This caused two regressions:
1. `isIncomingCall` gets stuck at `true` — if `handleCallScreened` sets it but no RINGING→IDLE or OFFHOOK→IDLE transition fires (e.g. call rejected by system), the dashboard never returns.
2. `incomingNumberRef.current` never cleared after RINGING→IDLE — next call's RINGING handler sees stale ref, skips reset logic, causing data bleed between calls.
**Fix:**
1. **RINGING handler**: Reverted to unconditional reset (removed `if (!incomingNumberRef.current)` guard and `if (!selectedCallRef.current)` guard). Always resets state and re-does lookups even if `callScreened` already fired — duplicate lookup is harmless, prevents stale data.
2. **RINGING→IDLE handler**: Added ref cleanup (`incomingNumberRef`, `incomingNameRef`, `selectedCallRef`, `contactNameRef` all cleared to empty/null) so next call starts fresh.
**Status:** DONE

### [2026-03-03] — Contact names, scan limit, and call order fixes
**Files changed:** `src/App.tsx`
**Problem:** Four UI/data issues after DB encryption fix:
1. Caller names don't match phone contacts (race condition: `contactNameRef` empty when `processCallAutomatically_fromBase64` runs)
2. Scan button only processes 10 calls (user wants 20)
3. Call display order not guaranteed newest-first
4. Date/time on cards too small to read (`text-[10px] text-gray-600`)
**Fix:**
1. **Contact name fallback**: Added `lookupContactName()` call inside `processCallAutomatically_fromBase64` right before `saveCall()` — if `contactNameRef` is still empty and we have a number, try one more lookup. After save, retroactively update older calls with the same number via `updateCallerNameByPhone()`.
2. **Scan limit**: Changed `slice(0, 10)` → `slice(0, 20)` in `scanMissedCalls`.
3. **Sort order**: Added explicit `.sort()` after `Array.from(map.values())` in `groupedCalls` useMemo — sorts by `b[0].created_at` descending (newest group first).
4. **Timestamp readability**: Changed date/time span from `text-[10px] text-gray-600` to `text-xs text-gray-400` for better visibility.
**Status:** DONE

### [2026-03-03] — Phone numbers missing from call cards (Call Log fallback)
**Files changed:** `CallDetectorPlugin.kt` (android + android-native), `src/App.tsx`
**Problem:** Samsung recording filenames use the contact name (not phone number) for saved contacts. Neither `extractPhoneFromFilename()` nor call screening events reliably provide the number → all cards show "מספר לא זוהה".
**Fix:**
1. **New Kotlin method `getCallLogNumber(dateMs)`**: Queries `CallLog.Calls.CONTENT_URI` with ±90s window around the recording timestamp to find the matching call log entry and return its phone number. `READ_CALL_LOG` permission was already declared.
2. **Scan path fallback**: In `scanMissedCalls`, when `extractPhoneFromFilename()` returns empty, calls `getCallLogNumber({ dateMs: rec.dateAddedMs })` to get the number from the call log.
3. **Processing path fallback**: In `processCallAutomatically_fromBase64`, if `incomingNumberRef.current` is still empty before Gemini processing, calls `getCallLogNumber({ dateMs: callStartTimeMsRef.current })` as last resort.
4. **TypeScript type**: Added `getCallLogNumber` to `CallDetectorPlugin` interface.
**Status:** DONE

### [2026-03-04] — Fix incoming call overlay (7 bugs)
**Files changed:** `OverlayManager.kt` (android-native + android)
**Problem:** Overlay was broken — never showed caller data. Multiple root causes:
**Fix:**
1. **Bug 0 — Wrong DB filename**: `"truesummary"` → `"truesummarySQLite.db"` (CapacitorSQLite appends `SQLite.db`). DB was never found → always showed empty data.
2. **Bug 1 — Overlay behind dialer**: Changed `gravity` from `Gravity.TOP` + `y=dp(48)` to `Gravity.CENTER` + `y=0`. Now appears mid-screen, not hidden behind native call UI.
3. **Bug 2 — No caller name/role from DB**: Expanded `OverlayCallRecord` data class to include `callerName` + `callerRole`. SQL now selects `caller_name, caller_role, summary, created_at`. Name priority: Android Contact → DB caller_name → phone number. Role shown as blue subtitle.
4. **Bug 3 — Date parsing fails**: Parser expected ISO `T` separator but DB stores space separator. Now tries `"yyyy-MM-dd HH:mm:ss"` first, then `"yyyy-MM-dd'T'HH:mm:ss"` fallback. Removed hardcoded UTC timezone.
5. **Bug 4 — Missing UI elements**: Added manual recording button ("התחל הקלטה ידנית") that launches MainActivity with `start_recording` intent extra.
6. **Bug 5 — Phone number matching**: Added `+972` variant generation from `05...` numbers for more reliable DB matching.
7. **Diagnostics**: Added `Log.d` for DB path, caller info, and record count; `Log.e` for DB errors.
**Status:** DONE

### [2026-03-04] — CallService: add CallLog fallback + grant Call Screening role
**Files changed:** `CallService.kt` (android-native + android)
**Problem:** On API 31+ (device is API 36), `TelephonyCallback` does NOT provide the phone number. `TrueSummaryScreeningService` is supposed to provide it, but the `CALL_SCREENING` role was never granted → screening service never fired → overlay always showed empty data.
**Fix:**
1. **Granted screening role**: `adb shell cmd role add-role-holder android.app.role.CALL_SCREENING com.truesummary.app 0` — this is the critical fix. Without this role, no phone number is available at RINGING time on API 31+.
2. **CallLog fallback in CallService**: Added `queryCallLogForRecentIncoming()` method + `retryResolveNumber()` with 3 delayed retries (300ms, 800ms, 2000ms) that check SharedPrefs + CallLog. This is a safety net in case the screening role is revoked.
3. **Note**: CallLog entries are NOT written during RINGING on Samsung — they're written after IDLE. So the CallLog fallback only helps for edge cases, not as a primary mechanism.
**Status:** DONE

---

## Session 10 — API Key Security + Phone Number Mixing Fix + Share Feature

### [2026-03-13] — Remove hardcoded Gemini API key
**Files changed:** `src/services/geminiClient.ts`, `src/App.tsx`
**Problem:** Google Cloud alerted that the Gemini API key was exposed in the GitHub repo (hardcoded as `BUILT_IN_API_KEY`)
**Fix:**
1. Removed `BUILT_IN_API_KEY` constant from `geminiClient.ts`; `getApiKey()` now returns empty string when no key in Preferences
2. Added amber warning banner in App.tsx when no API key is configured (native mode)
3. Amended git commit and force-pushed to purge key from all git history
**Status:** DONE

### [2026-03-13] — Normalize phone numbers on INSERT
**Files changed:** `src/services/database.ts`, `server.ts`
**Problem:** Same person stored with different phone formats (`052-4455667`, `0524455667`, `+972524455667`) causing fragile grouping
**Fix:**
1. `saveCall()` in database.ts: normalize phone_number before INSERT
2. `saveTasks()` in database.ts: normalize phone param before INSERT
3. `save-call` endpoint in server.ts: normalize before INSERT
4. `save-tasks` endpoint in server.ts: normalize before INSERT
5. One-time migration in `initDatabase()`: SELECT all calls/tasks with non-normalized phones, UPDATE to normalized form
6. Same migration in server.ts for web-mode DB
**Status:** DONE

### [2026-03-13] — Fix empty phone number grouping (prevent cross-person mixing)
**Files changed:** `src/App.tsx`
**Problem:** When phone_number is empty, calls were grouped by AI-detected `caller_name`. If Gemini detected "דוד" for two unrelated callers, their summaries merged
**Fix:**
1. Removed `__name_` fallback in `groupedCalls` useMemo — calls without phone number always get unique keys (`__noPhone_${call.id}`)
2. `openContactView()`: removed name-based fallback filter; no phone = show single call only
**Status:** DONE

### [2026-03-13] — Fix ref race condition in processCallAutomatically_fromBase64
**Files changed:** `src/App.tsx`
**Problem:** `contactNameRef.current` and `callDirectionRef.current` read mid-function could be overwritten by a new incoming call
**Fix:** Capture ALL refs into local `const` at function entry: `capturedContact`, `capturedDir`. Use locals throughout instead of re-reading refs. Applied same fix to web-mode `processCallAutomatically()`
**Status:** DONE

### [2026-03-13] — Tighten CallLog fallback window (90s → 30s)
**Files changed:** `android-native/CallDetectorPlugin.kt`
**Problem:** ±90 second window in `getCallLogNumber()` could return wrong number if two calls happened within 90s
**Fix:** Reduced window to 30s. Also changed from taking first result to finding closest match by timestamp (`bestDiff`)
**Status:** DONE

### [2026-03-13] — Fix SharedPrefs staleness
**Files changed:** `android-native/CallDetectorPlugin.kt`, `android-native/CallService.kt`, `android-native/TrueSummaryScreeningService.kt`
**Problem:** `last_screened_phone` and `lastIncomingPhoneNumber` in SharedPrefs could be stale from a previous call
**Fix:**
1. `notifyCallScreened()`: store `last_screened_phone_time_ms` alongside phone number
2. `TrueSummaryScreeningService`: store `lastIncomingPhoneNumberTimeMs` alongside phone number
3. `CallService` RINGING: validate SharedPrefs timestamp is < 30s old before using stored number
4. `CallService` IDLE: clear both `TrueSummaryPending` and `TrueSummary` SharedPrefs stores
**Status:** DONE

### [2026-03-13] — Add Share feature for call summaries
**Files changed:** `src/App.tsx`, `package.json`
**Problem:** No way to share call summaries
**Fix:**
1. Installed `@capacitor/share` dependency
2. Added Share button in Contact Timeline Modal header
3. Share mode: shows checkboxes on each call summary for multi-select
4. "שתף (N)" button appears when ≥1 calls selected
5. Builds text payload with contact name, phone, and selected summaries with dates
6. Native: uses `@capacitor/share` Share API; Web: uses `navigator.share()` or clipboard fallback
**Status:** DONE
