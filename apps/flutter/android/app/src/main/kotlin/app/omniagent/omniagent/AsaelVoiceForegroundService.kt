package app.omniagent.omniagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** A visible, non-restarting lease; it never captures audio or grants access itself. */
class AsaelVoiceForegroundService : Service() {
    companion object {
        const val START = "app.omniagent.omniagent.PHONE_SESSION_START"
        private const val MUTE = "app.omniagent.omniagent.PHONE_SESSION_MUTE"
        private const val STOP = "app.omniagent.omniagent.PHONE_SESSION_STOP"
        private const val CHANNEL = "asael_live_phone_session_v1"
        private const val NOTIFICATION = 4319
        var current: AsaelVoiceForegroundService? = null
            private set
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        current = this
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Active ATLAS session", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Mute, stop or return to the voice or phone-control session you started."
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
            )
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            STOP -> AndroidDeviceBridge.stopAll("user_stop")
            MUTE -> AndroidDeviceBridge.setMuted(!AndroidDeviceBridge.voiceMuted)
            START -> {
                if (AndroidDeviceBridge.locked() || (!AndroidDeviceBridge.voiceActive && !AndroidDeviceBridge.enabled)) {
                    AndroidDeviceBridge.foregroundFailed()
                    stopSelf()
                } else {
                    refreshNotification()
                }
            }
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    fun refreshNotification() {
        if (!AndroidDeviceBridge.voiceActive && !AndroidDeviceBridge.enabled) { stopSelf(); return }
        try {
            val notification = notification()
            if (Build.VERSION.SDK_INT >= 29) {
                var type = 0
                if (AndroidDeviceBridge.voiceActive) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (AndroidDeviceBridge.enabled && Build.VERSION.SDK_INT >= 34) {
                    type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                }
                startForeground(NOTIFICATION, notification, type)
            } else {
                startForeground(NOTIFICATION, notification)
            }
            AndroidDeviceBridge.foregroundStarted()
        } catch (_: Exception) {
            AndroidDeviceBridge.foregroundFailed()
            stopSelf()
        }
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this, 4320,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = action(STOP, 4321)
        val muted = AndroidDeviceBridge.voiceMuted
        val voice = AndroidDeviceBridge.voiceActive
        val title = if (voice) {
            if (muted) "ATLAS microphone muted" else "ATLAS voice is active"
        } else "ATLAS phone control is on"
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        builder.setSmallIcon(R.drawable.ic_stat_asael)
            .setContentTitle(title)
            .setContentText(if (AndroidDeviceBridge.enabled) "This phone is available for your requests." else "Your voice conversation is continuing.")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setCategory(Notification.CATEGORY_SERVICE)
        if (voice) {
            builder.addAction(Notification.Action.Builder(
                null, if (muted) "Unmute" else "Mute", action(MUTE, 4322),
            ).build())
        }
        builder.addAction(Notification.Action.Builder(null, "Stop", stop).build())
        builder.addAction(Notification.Action.Builder(null, "Return", open).build())
        return builder.build()
    }
    private fun action(name: String, id: Int): PendingIntent = PendingIntent.getService(
        this, id, Intent(this, AsaelVoiceForegroundService::class.java).setAction(name),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    override fun onTaskRemoved(rootIntent: Intent?) {
        AndroidDeviceBridge.stopAll("app_closed")
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }
    override fun onDestroy() {
        if (current === this) current = null
        AndroidDeviceBridge.foregroundDestroyed()
        super.onDestroy()
    }
}
