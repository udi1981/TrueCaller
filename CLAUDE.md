# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Change Tracking

All fixes and changes are logged in [`FIXES_LOG.md`](./FIXES_LOG.md).
**Before making any change, read that file** to avoid re-doing completed work.
Append a new entry to `FIXES_LOG.md` for every fix, feature, or refactor applied.

## Commands

```bash
# Web dev (Express + Vite HMR on http://localhost:3000)
npm run dev

# TypeScript type-check (no emit)
npm run lint

# Build web assets to dist/
npm run build

# Build + sync + open Android Studio
npm run build:android

# Generate Android app icons from public/icon.png
npm run generate-icons
```

**Environment:** Create `.env.local` (or `.env`) with `GEMINI_API_KEY=<your-key>`. Required for web dev mode; on Android the key is stored via `@capacitor/preferences` at runtime.

## Architecture

### Dual-Mode Design

The app runs in two modes that share the same React frontend but use different backends:

- **Web dev mode** (`npm run dev`): `server.ts` is the entry point — it starts Express + Socket.io + Vite middleware all in one process. All AI calls go through Express API endpoints; the Gemini API key lives server-side.
- **Android native mode**: Capacitor wraps the Vite-built `dist/` in a WebView. Each service module checks `Capacitor.isNativePlatform()` and either uses Capacitor plugins directly or falls back to Express `fetch` calls.

### Service Layer (`src/services/`)

- `database.ts` — abstraction over `@capacitor-community/sqlite` (native) vs `fetch /api/*` (web). SQLite DB name: `truesummary`.
- `geminiClient.ts` — abstraction over direct `@google/genai` SDK calls (native, key from Preferences) vs `fetch /api/process-call` (web, key server-side).
- `gemini.ts` — **dead code**, kept in project but unused.

### Call Processing Flow

1. **Incoming call detected** → `RINGING` event from `CallDetectorPlugin` → look up caller in DB → show overlay with last summary.
2. **Call answered** → `OFFHOOK` event → on web: start mic recording via `MediaRecorder`; on Android: note `callAnsweredTimeMs`.
3. **Call ended** → `IDLE` event → on web: stop recording + send audio blob; on Android: `getLatestRecording()` queries Samsung MediaStore via `SamsungRecordingReader.kt`.
4. Audio (base64) → `processCallAudio()` → Gemini transcribes → Gemini summarizes → result saved to `calls` table.

### Android Native Kotlin (`android-native/java/com/truesummary/app/`)

These files are **source templates** — after `npx cap add android`, copy them into `android/app/src/main/java/com/truesummary/app/`:

| File | Purpose |
|------|---------|
| `CallDetectorPlugin.kt` | Capacitor bridge; emits `callStateChanged` + `callScreened` events |
| `CallService.kt` | Foreground service; TelephonyCallback (API 31+) or PhoneStateListener |
| `TrueSummaryScreeningService.kt` | `CallScreeningService` for accurate phone numbers + outgoing; must respond in 5 s |
| `OverlayManager.kt` | Lock-screen floating overlay; reads last summary from SQLite directly |
| `SamsungRecordingReader.kt` | Queries MediaStore for call recordings after OFFHOOK time; returns Base64 |
| `BootReceiver.kt` | Restarts `CallService` after device reboot |
| `MainActivity.kt` | Registers CapacitorSQLite + CallDetectorPlugin before Capacitor Bridge init |
| `RecordingWatcherPlugin.kt` | Additional Capacitor plugin for recording file watching |

See `android-native/SETUP.md` for the full step-by-step APK build process (Capacitor init → copy Kotlin files → manifest merge → `minSdkVersion = 26` → Gradle dep → build).

### Key Patterns in `src/App.tsx`

- **Stable refs pattern**: All values used inside Capacitor event listener callbacks are stored in refs (e.g., `callHistoryRef`, `incomingNameRef`) and kept in sync with state via `useEffect`. This avoids stale closures with long-lived listeners.
- Platform detection at feature boundaries: `Capacitor.isNativePlatform()` gates mic recording (web) vs Samsung recording reader (Android).
- Socket.io is web-only and only used to receive `history-updated` / `incoming-call` events from the server. It is not present on Android.

### AI Prompts

Prompts are defined in two places (kept in sync manually):
- `server.ts` — used for web mode (`/api/process-call`)
- `src/services/geminiClient.ts` — used for native mode

Both use `gemini-2.0-flash`. All output is in Hebrew. The summarization step requests JSON with `{ name, role, summary }` and uses `responseMimeType: "application/json"`.
