package app.omniagent.omniagent

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.io.ByteArrayOutputStream
import java.time.Instant

/** Explicit microphone capture; unlike phone control this remains valid while the screen is locked. */
class ListenRecordingService : Service() {
    companion object {
        const val START = "app.omniagent.omniagent.LISTEN_START"
        const val PAUSE = "app.omniagent.omniagent.LISTEN_PAUSE"
        const val RESUME = "app.omniagent.omniagent.LISTEN_RESUME"
        const val STOP = "app.omniagent.omniagent.LISTEN_STOP"
        private const val CHANNEL = "asael_listen_v1"
        private const val NOTIFICATION = 4410
        @Volatile var current: ListenRecordingService? = null
            private set
    }
    private val main = Handler(Looper.getMainLooper())
    private var store: ListenStore? = null
    var sessionId: String? = null
        private set
    private var recorder: AudioRecord? = null
    @Volatile private var capturing = false
    private var thread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var stopping = false
    private var capturingSince = 0L
    fun capturedDurationMs(): Long {
        val saved = sessionId?.let { store?.session(it)?.optLong("durationMs") } ?: 0L
        return saved + if (capturing) (android.os.SystemClock.elapsedRealtime() - capturingSince).coerceIn(0, 60_000) else 0
    }
    private var callback: AudioManager.AudioRecordingCallback? = null
    private val maximum = Runnable { stopRecording("The 24-hour listening limit was reached. Your audio has been saved.") }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); current = this
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Conversation listening", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Pause or finish the listening session you started."
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                setShowBadge(false)
            },
        )
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            when (intent?.action) {
                START -> {
                    check(sessionId == null) { "already_listening" }
                    store = ListenStore.active(this) ?: error("access_required")
                    check(store!!.grantReady()) { "access_required" }
                    sessionId = intent.getStringExtra("sessionId") ?: error("session_required")
                    refreshNotification()
                    val elapsed = System.currentTimeMillis() - Instant.parse(store!!.session(sessionId!!).getString("startedAt")).toEpochMilli()
                    main.postDelayed(maximum, (24 * 60 * 60 * 1000L - elapsed).coerceAtLeast(0))
                    resume()
                }
                PAUSE -> pause("Paused by you.")
                RESUME -> resume()
                STOP -> stopRecording()
                else -> stopSelf()
            }
        } catch (_: Exception) { stopRecording("Listening could not start. Open Asael to check microphone access.") }
        return START_NOT_STICKY // Never open the microphone silently after process death or reboot.
    }
    @Synchronized fun resume() {
        if (capturing) return
        check(thread?.isAlive != true) { "saving_audio" }
        check(!AndroidDeviceBridge.voiceActive) { "voice_active" }
        check(checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "microphone_required" }
        val ownerStore = store ?: error("session_required")
        val id = sessionId ?: error("session_required")
        check(ListenStore.active(this)?.scope == ownerStore.scope) { "access_required" }
        check(ownerStore.queuedBytes() < ListenStore.MAX_BYTES - 4_000_000) { "storage_full" }
        val minimum = AudioRecord.getMinBufferSize(16_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val audio = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(16_000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
            .setBufferSizeInBytes(maxOf(minimum * 4, 32_000)).build()
        check(audio.state == AudioRecord.STATE_INITIALIZED) { "microphone_unavailable" }
        recorder = audio
        if (Build.VERSION.SDK_INT >= 29) {
            callback = object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    if (configs.any { it.clientAudioSessionId == audio.audioSessionId && it.isClientSilenced }) {
                        pause("Another app is using the microphone. Tap Resume when it is available.")
                    }
                }
            }.also { getSystemService(AudioManager::class.java).registerAudioRecordingCallback(it, main) }
        }
        audio.startRecording()
        check(audio.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "microphone_unavailable" }
        capturing = true
        capturingSince = android.os.SystemClock.elapsedRealtime()
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Asael:Listen").apply { acquire(24 * 60 * 60 * 1000L) }
        ownerStore.updateSession(id) { it.put("state", "listening").remove("message") }
        refreshNotification(); ListenBridge.changed(this)
        thread = Thread({
            val frame = ByteArrayOutputStream(32_000)
            val buffer = ByteArray(3_200)
            var segmentBytes = 0
            var failure: String? = null
            try {
                while (capturing) {
                    val count = audio.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (count <= 0) { if (capturing) error("microphone_interrupted") else break }
                    frame.write(buffer, 0, count)
                    if (frame.size() >= 32_000) {
                        ownerStore.appendFrame(id, frame.toByteArray()); segmentBytes += frame.size(); frame.reset()
                        if (segmentBytes >= 60 * 32_000) {
                            ownerStore.finishFrames(id); segmentBytes = 0
                            capturingSince = android.os.SystemClock.elapsedRealtime()
                            ListenWork.enqueueUpload(this); ListenBridge.changed(this)
                        }
                    }
                }
            } catch (error: Exception) {
                failure = if (error.message == "storage_full") "Phone storage for listening is full. Connect to upload, then tap Resume." else "The microphone was interrupted. Audio already saved is safe."
            } finally {
                runCatching {
                    if (frame.size() > 0) ownerStore.appendFrame(id, frame.toByteArray())
                    ownerStore.finishFrames(id)
                }.onFailure { failure = "Audio storage is unavailable. Previously saved audio is safe." }
                ListenWork.enqueueUpload(this)
                if (failure != null) main.post { if (!stopping) pause(failure) }
            }
        }, "AsaelListenRecorder").apply { start() }
    }
    @Synchronized fun pause(reason: String = "Paused by you.") {
        capturing = false
        runCatching { recorder?.stop() }
        if (Thread.currentThread() !== thread) thread?.join(2500)
        if (thread?.isAlive != true) thread = null
        runCatching { recorder?.release() }; recorder = null
        callback?.let { getSystemService(AudioManager::class.java).unregisterAudioRecordingCallback(it) }; callback = null
        if (wakeLock?.isHeld == true) wakeLock?.release(); wakeLock = null
        sessionId?.let { id -> store?.updateSession(id) { it.put("state", "paused").put("message", reason) } }
        refreshNotification(); ListenBridge.changed(this)
    }
    @Synchronized fun stopRecording(reason: String? = null) {
        if (stopping) return
        stopping = true
        pause(reason ?: "Listening finished.")
        sessionId?.let { id -> store?.updateSession(id) {
            it.put("finished", true).put("state", "queued")
            if (reason != null) it.put("message", reason) else it.remove("message")
            if (it.getJSONArray("segments").length() == 0) it.put("state", "error").put("message", "No audio was saved. Start a new conversation when you are ready.")
        } }
        main.removeCallbacks(maximum)
        ListenWork.enqueueUpload(this)
        ListenBridge.changed(this)
        sessionId = null
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    private fun refreshNotification() {
        if (sessionId == null) return
        val open = PendingIntent.getActivity(this, 4411, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fun action(name: String, request: Int) = PendingIntent.getService(this, request, Intent(this, ListenRecordingService::class.java).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val notice = builder.setSmallIcon(R.drawable.ic_stat_asael).setContentTitle(if (capturing) "Asael is listening" else "Listening paused")
            .setContentText("Your conversation is saved privately on this phone until uploaded.")
            .setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(open)
            .addAction(Notification.Action.Builder(null, if (capturing) "Pause" else "Resume", action(if (capturing) PAUSE else RESUME, 4412)).build())
            .addAction(Notification.Action.Builder(null, "Finish", action(STOP, 4413)).build()).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(NOTIFICATION, notice)
    }
    override fun onDestroy() {
        if (!stopping) stopRecording("Listening was interrupted. Saved audio will be processed when access is available.")
        main.removeCallbacks(maximum)
        if (current === this) current = null
        super.onDestroy()
    }
}
