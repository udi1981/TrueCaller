package com.truesummary.app

import android.os.Bundle
import com.getcapacitor.community.database.sqlite.CapacitorSQLitePlugin
import com.getcapacitor.BridgeActivity

/**
 * Main entry-point activity.
 * Registers both CapacitorSQLite and our custom CallDetectorPlugin before
 * the Bridge is initialized so they're available to the WebView JS layer.
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(CapacitorSQLitePlugin::class.java)
        registerPlugin(CallDetectorPlugin::class.java)
        registerPlugin(RecordingWatcherPlugin::class.java)
        registerPlugin(NotificationSchedulerPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
