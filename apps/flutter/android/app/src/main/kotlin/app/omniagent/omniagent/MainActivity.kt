package app.omniagent.omniagent

import android.os.Bundle
import android.content.Context
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterFragmentActivity() {
    override fun provideFlutterEngine(context: Context): FlutterEngine =
        AndroidDeviceBridge.engine(context)

    // An explicitly started voice foreground service owns the same engine while
    // the user visits another app. No second isolate receives the login session.
    override fun shouldDestroyEngineWithHost(): Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keeps the workspace out of the recent-apps thumbnail, screenshots, and
        // screen recordings.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        AndroidDeviceBridge.attachActivity(this)
    }

    override fun onResume() {
        super.onResume()
        AndroidDeviceBridge.activityResumed(this)
    }

    override fun onPause() {
        AndroidDeviceBridge.activityPaused(this)
        super.onPause()
    }

    override fun onDestroy() {
        AndroidDeviceBridge.detachActivity(this)
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        AndroidDeviceBridge.permissionResult(requestCode)
    }
}
