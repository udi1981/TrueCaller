# Android APK Build Setup Guide

Follow these steps **in order** after the web-side files have been created.

---

## Step 1 — Install dependencies

```bash
cd TrueCaller-main   # project root with package.json
npm install
```

This installs `@capacitor/core`, `@capacitor/android`, `@capacitor/preferences`,
`@capacitor-community/sqlite`, and `@capacitor/cli`.

---

## Step 2 — Initialize Capacitor

```bash
npx cap init TrueSummary com.truesummary.app --web-dir dist
```

> Answer "No" if asked to overwrite `capacitor.config.ts` — it already exists.

---

## Step 3 — Add Android platform

```bash
npx cap add android
```

This creates the `android/` project at `android/app/src/main/`.

---

## Step 3b — Generate app icon

```bash
mkdir -p resources
cp public/icon.png resources/icon.png
npm run generate-icons
```

This writes all `mipmap-*` density variants into `android/app/src/main/res/`.

---

## Step 4 — Copy native Kotlin files

Copy the contents of `android-native/java/com/truesummary/app/` into the generated Android package:

```
android/app/src/main/java/com/truesummary/app/
```

**Files to copy:**
| Source (android-native/…)                          | Destination (android/…)                                             |
|----------------------------------------------------|---------------------------------------------------------------------|
| `java/com/truesummary/app/CallDetectorPlugin.kt`   | `app/src/main/java/com/truesummary/app/CallDetectorPlugin.kt`       |
| `java/com/truesummary/app/CallService.kt`          | `app/src/main/java/com/truesummary/app/CallService.kt`              |
| `java/com/truesummary/app/TrueSummaryScreeningService.kt` | `app/src/main/java/com/truesummary/app/TrueSummaryScreeningService.kt` |
| `java/com/truesummary/app/OverlayManager.kt`       | `app/src/main/java/com/truesummary/app/OverlayManager.kt`           |
| `java/com/truesummary/app/BootReceiver.kt`         | `app/src/main/java/com/truesummary/app/BootReceiver.kt`             |
| `java/com/truesummary/app/MainActivity.kt`         | `app/src/main/java/com/truesummary/app/MainActivity.kt` (**replace**) |
| `java/com/truesummary/app/SamsungRecordingReader.kt` | `app/src/main/java/com/truesummary/app/SamsungRecordingReader.kt`   |

---

## Step 5 — Update AndroidManifest.xml

Open `android/app/src/main/AndroidManifest.xml` and:

1. Add all `<uses-permission>` tags from `android-native/AndroidManifest_additions.xml`
   **before** the `<application>` tag.

2. Add the `<service>` and `<receiver>` tags from that file
   **inside** the `<application>` tag.

---

## Step 6 — Set minSdkVersion

Open `android/variables.gradle` and change:

```gradle
minSdkVersion = 22
```
to:
```gradle
minSdkVersion = 26
```

---

## Step 7 — Add CapacitorSQLite dependency

Open `android/app/build.gradle` and add inside `dependencies {}`:

```gradle
implementation "com.github.capacitor-community:sqlite:7.0.0"
```

Also make sure the `jitpack.io` repository is listed in `android/build.gradle`:

```gradle
allprojects {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://jitpack.io' }
    }
}
```

---

## Step 8 — Build the web assets and sync

```bash
npm run build          # Vite → dist/
npx cap sync android   # copies dist/ + Capacitor plugins → android/
```

---

## Step 9 — Build APK in Android Studio

```bash
npx cap open android
```

Inside Android Studio:
1. Wait for Gradle sync to finish.
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. APK will be at:
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

---

## Step 10 — Install on device

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

Or use Android Studio's **Run** button with your phone connected via USB
(enable USB Debugging in Developer Options).

---

## Step 11 — First launch setup

1. Open **TrueSummary** on the phone.
2. A settings gear icon appears in the top-right — tap it.
3. Enter your **Gemini API key** (from Google AI Studio) and tap **שמור**.
4. Tap **"הרשאת Overlay"** → grant "Draw over other apps".
5. Tap **"תפקיד סינון שיחות"** → select TrueSummary as the call screening app.
6. Android will also prompt for microphone and phone state permissions — allow all.
7. If prompted for **"Files and media"** permission — grant it (needed for Samsung call recordings).

---

## Verification

```bash
# Check the database after a test call
adb shell run-as com.truesummary.app \
  sqlite3 databases/truesummary "SELECT id, caller_name, summary FROM calls LIMIT 3;"
```

---

## Known Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| Android 9+ blocks `VOICE_CALL` audio source | Only your microphone recorded, not the other party | Use speakerphone — mic picks up both sides |
| Android 12+ TelephonyCallback omits number | No number unless Call Screening role is granted | Grant the role in Settings |
| Overlay may not cover native dialer UI on all ROMs | Summary appears beside/before the native screen | Best-effort; grant SYSTEM_ALERT_WINDOW |
| CallScreeningService must respond in 5 s | No blocking work inside `onScreenCall()` | Already handled — only event emission there |

---

## npm run dev (web testing)

`npm run dev` still works — `server.ts` is unchanged.
On web, the app uses Express API calls instead of Capacitor plugins.
The simulation button at the bottom works for testing the full recording + AI flow.
