package app.omniagent.omniagent

import android.Manifest
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.lang.ref.WeakReference
import java.time.Instant

/** The in-process, credential-free device boundary. Flutter owns server authority. */
object AndroidDeviceBridge {
    const val NOTIFICATION_PERMISSION_REQUEST = 4318
    private const val CHANNEL = "app.omniagent.omniagent/android-device"
    private const val SESSION_MILLIS = 30 * 60 * 1000L
    private val handler = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var retainedEngine: FlutterEngine? = null
    private var activity = WeakReference<MainActivity>(null)
    private var resumed = false
    private var events: EventChannel.EventSink? = null
    private val pendingEvents = ArrayDeque<Map<String, Any>>()
    private var permissionReply: MethodChannel.Result? = null
    private var serviceReply: MethodChannel.Result? = null
    private var executionReply: MethodChannel.Result? = null
    private var executionId: String? = null
    private var snapshotRunId: String? = null
    private var executionExpiresAt = 0L
    private val dispatched = LinkedHashSet<String>()
    private var generation = 0L
    private var stoppingAll = false
    private var controlExpiry: Runnable? = null
    private var voiceExpiry: Runnable? = null
    private var controlExpiresAt = 0L
    private var voiceExpiresAt = 0L
    internal var enabled = false
        private set
    internal var voiceActive = false
        private set
    internal var voiceMuted = false
        private set
    internal var foregroundServiceReady = false
        private set
    internal var accessibility: AsaelAccessibilityService? = null
        private set

    fun engine(context: Context): FlutterEngine {
        retainedEngine?.let { return it }
        val application = context.applicationContext
        app = application
        val created = FlutterEngine(application)
        retainedEngine = created
        MethodChannel(created.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler(::handle)
        EventChannel(created.dartExecutor.binaryMessenger, "$CHANNEL/events")
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
                    events = sink
                    while (pendingEvents.isNotEmpty()) sink.success(pendingEvents.removeFirst())
                    emit(mapOf("type" to "status_changed"))
                }
                override fun onCancel(arguments: Any?) { events = null }
            })
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF || locked()) {
                    stopAll("device_locked")
                } else {
                    emit(mapOf("type" to "status_changed"))
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            application.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION") application.registerReceiver(receiver, filter)
        }
        created.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        return created
    }

    fun attachActivity(value: MainActivity) { activity = WeakReference(value) }
    fun activityResumed(value: MainActivity) {
        attachActivity(value)
        resumed = true
        if (locked()) stopAll("device_locked")
        emit(mapOf("type" to "status_changed"))
    }
    fun activityPaused(value: MainActivity) {
        if (activity.get() === value) resumed = false
    }
    fun detachActivity(value: MainActivity) {
        if (activity.get() === value) {
            resumed = false
            activity.clear()
            permissionReply?.error("activity_unavailable", "Return to Asael to finish setup.", null)
            permissionReply = null
        }
    }

    fun permissionResult(requestCode: Int) {
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return
        permissionReply?.success(status())
        permissionReply = null
        emit(mapOf("type" to "status_changed"))
    }

    fun serviceConnected(service: AsaelAccessibilityService) {
        accessibility = service
        emit(mapOf("type" to "status_changed"))
    }
    fun serviceDisconnected(service: AsaelAccessibilityService) {
        if (accessibility !== service) return
        accessibility = null
        stopControl("accessibility_disconnected")
        emit(mapOf("type" to "status_changed"))
    }
    fun locked(): Boolean = app?.getSystemService(KeyguardManager::class.java)
        ?.let { it.isDeviceLocked || it.isKeyguardLocked } ?: true

    private fun notificationsGranted(): Boolean = Build.VERSION.SDK_INT < 33 ||
        app?.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun status(): Map<String, Any?> = mapOf(
        "schemaVersion" to 1,
        "supported" to (Build.VERSION.SDK_INT >= 34),
        "enabled" to enabled,
        "active" to (executionId != null),
        "accessibility" to if (accessibility != null) "granted" else "denied",
        "screenCapture" to if (Build.VERSION.SDK_INT >= 34 && accessibility != null) "granted" else "unavailable",
        "locked" to locked(),
        "voiceActive" to voiceActive,
        "voiceMuted" to voiceMuted,
        "foregroundServiceReady" to foregroundServiceReady,
        "notificationsGranted" to notificationsGranted(),
        "deviceName" to "${Build.MANUFACTURER} ${Build.MODEL}".take(160),
        "androidVersion" to Build.VERSION.RELEASE.take(40),
        "androidApiLevel" to Build.VERSION.SDK_INT,
        "serviceExpiresAt" to maxOf(controlExpiresAt, voiceExpiresAt).takeIf { it > 0 }
            ?.let { Instant.ofEpochMilli(it).toString() },
    )

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "getStatus" -> { require(call.arguments == null); result.success(status()) }
                "requestAccessibilitySettings" -> {
                    require(call.arguments == null)
                    val host = visibleActivity()
                    host.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(status())
                }
                "requestNotificationPermission" -> {
                    require(call.arguments == null)
                    val host = visibleActivity()
                    if (notificationsGranted()) result.success(status())
                    else {
                        check(permissionReply == null) { "setup_in_progress" }
                        permissionReply = result
                        host.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
                    }
                }
                "setEnabled" -> {
                    val args = arguments(call, setOf("enabled", "disclosureAccepted"))
                    val requested = args["enabled"] as? Boolean ?: error("invalid_arguments")
                    if (!requested) { stopControl("user_stop"); result.success(status()) }
                    else {
                        visibleActivity()
                        check(Build.VERSION.SDK_INT >= 34) { "android_version_unsupported" }
                        check(args["disclosureAccepted"] == true) { "disclosure_required" }
                        check(accessibility != null) { "accessibility_required" }
                        check(notificationsGranted()) { "notification_permission_required" }
                        check(!locked()) { "device_locked" }
                        enabled = true
                        controlExpiresAt = System.currentTimeMillis() + SESSION_MILLIS
                        controlExpiry?.let(handler::removeCallbacks)
                        controlExpiry = Runnable { stopControl("session_expired") }.also { handler.postDelayed(it, SESSION_MILLIS) }
                        startForegroundSession(result)
                    }
                }
                "execute" -> execute(call.arguments, result)
                "stop" -> { require(call.arguments == null); stopControl("user_stop"); result.success(status()) }
                "voiceStart" -> {
                    val args = arguments(call, setOf("sessionId"), allowNull = true)
                    check(args["sessionId"] == null || (args["sessionId"] is String && (args["sessionId"] as String).length <= 240)) { "invalid_arguments" }
                    visibleActivity()
                    check(!locked()) { "device_locked" }
                    check(notificationsGranted()) { "notification_permission_required" }
                    check(app?.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "microphone_permission_required" }
                    voiceActive = true
                    voiceExpiresAt = System.currentTimeMillis() + SESSION_MILLIS
                    voiceMuted = false
                    voiceExpiry?.let(handler::removeCallbacks)
                    voiceExpiry = Runnable { stopVoice("session_expired") }.also { handler.postDelayed(it, SESSION_MILLIS) }
                    startForegroundSession(result)
                }
                "voiceSetMuted" -> {
                    val args = arguments(call, setOf("muted"))
                    val muted = args["muted"] as? Boolean ?: error("invalid_arguments")
                    check(voiceActive) { "voice_inactive" }
                    setMuted(muted)
                    result.success(status())
                }
                "voiceStop" -> { require(call.arguments == null); stopVoice("ended"); result.success(status()) }
                else -> result.notImplemented()
            }
        } catch (error: Exception) {
            val code = error.message?.takeIf { it.matches(Regex("[a-z_]{1,80}")) } ?: "android_control_unavailable"
            result.error(code, friendlyError(code), null)
        }
    }

    private fun visibleActivity(): MainActivity {
        check(resumed) { "visible_start_required" }
        return activity.get() ?: error("visible_start_required")
    }
    private fun arguments(call: MethodCall, keys: Set<String>, allowNull: Boolean = false): Map<*, *> {
        if (allowNull && call.arguments == null) return emptyMap<String, Any>()
        val args = call.arguments as? Map<*, *> ?: error("invalid_arguments")
        check(args.keys.all { it is String && it in keys }) { "invalid_arguments" }
        return args
    }

    private fun startForegroundSession(reply: MethodChannel.Result) {
        check(serviceReply == null) { "session_starting" }
        val context = app ?: error("activity_unavailable")
        serviceReply = reply
        try {
            val intent = Intent(context, AsaelVoiceForegroundService::class.java)
                .setAction(AsaelVoiceForegroundService.START)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            handler.postDelayed({
                if (serviceReply === reply) {
                    serviceReply = null
                    stopAll("foreground_service_unavailable")
                    reply.error("foreground_service_unavailable", "Return to Asael and start the session again.", null)
                }
            }, 5000)
        } catch (error: Exception) {
            serviceReply = null
            stopAll("foreground_service_unavailable")
            throw error
        }
    }

    fun foregroundStarted() {
        foregroundServiceReady = true
        serviceReply?.success(status())
        serviceReply = null
        emit(mapOf("type" to "status_changed"))
    }
    fun foregroundFailed() {
        foregroundServiceReady = false
        serviceReply?.error("foreground_service_unavailable", "Return to Asael and start the session again.", null)
        serviceReply = null
        stopAll("foreground_service_unavailable")
    }
    fun foregroundDestroyed() {
        foregroundServiceReady = false
        if (voiceActive || enabled) stopAll("foreground_service_stopped")
    }
    fun setMuted(value: Boolean) {
        if (!voiceActive || voiceMuted == value) return
        voiceMuted = value
        emit(mapOf("type" to "voice_muted", "muted" to value))
        AsaelVoiceForegroundService.current?.refreshNotification()
    }
    fun stopVoice(reason: String) {
        val wasActive = voiceActive
        voiceActive = false
        voiceExpiresAt = 0
        voiceMuted = false
        voiceExpiry?.let(handler::removeCallbacks)
        voiceExpiry = null
        if (wasActive) emit(mapOf("type" to "voice_ended", "reason" to reason))
        updateForeground()
    }
    fun stopControl(reason: String) {
        val wasEnabled = enabled
        enabled = false
        controlExpiresAt = 0
        generation += 1
        controlExpiry?.let(handler::removeCallbacks)
        controlExpiry = null
        accessibility?.clearSnapshot()
        snapshotRunId = null
        val callback = executionReply
        executionReply = null
        executionId = null
        callback?.success(failure("stopped", canceled = true))
        if (wasEnabled) emit(mapOf("type" to "control_stopped", "reason" to reason))
        updateForeground()
    }
    fun stopAll(reason: String) {
        stoppingAll = true
        try {
            stopControl(reason)
            stopVoice(reason)
        } finally {
            stoppingAll = false
            updateForeground()
        }
    }
    private fun updateForeground() {
        if (stoppingAll) return
        if (!voiceActive && !enabled) {
            foregroundServiceReady = false
            app?.stopService(Intent(app, AsaelVoiceForegroundService::class.java))
        } else {
            AsaelVoiceForegroundService.current?.refreshNotification()
        }
        emit(mapOf("type" to "status_changed"))
    }

    private fun execute(value: Any?, reply: MethodChannel.Result) {
        val args = value as? Map<*, *> ?: error("invalid_arguments")
        check(args.keys.all { it in setOf("id", "runId", "executionId", "action", "input", "expiresAt", "authority") }) { "invalid_arguments" }
        val id = args["id"] as? String ?: error("invalid_arguments")
        val runId = args["runId"] as? String ?: error("invalid_arguments")
        val governedExecutionId = args["executionId"] as? String ?: error("invalid_arguments")
        val action = args["action"] as? String ?: error("invalid_arguments")
        val input = args["input"] as? Map<*, *> ?: error("invalid_arguments")
        val expiration = (args["expiresAt"] as? String)?.let { Instant.parse(it).toEpochMilli() } ?: error("invalid_arguments")
        check(id.matches(Regex("local_computer_command_[a-f0-9]{48}"))) { "invalid_arguments" }
        check(runId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}")) &&
            governedExecutionId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}"))) { "invalid_arguments" }
        check(args["authority"] == null || args["authority"] == "task") { "invalid_arguments" }
        if (locked()) { stopAll("device_locked"); reply.success(failure("device_locked")); return }
        if (!enabled || !foregroundServiceReady) { reply.success(failure("control_disabled")); return }
        if (executionId != null) { reply.success(failure("command_busy")); return }
        if (id in dispatched) { reply.success(failure("command_replay_refused")); return }
        if (expiration <= System.currentTimeMillis() || expiration > System.currentTimeMillis() + 10 * 60 * 1000) {
            reply.success(failure("command_expired")); return
        }
        val service = accessibility ?: run { reply.success(failure("accessibility_required")); return }
        if (snapshotRunId != runId) {
            service.clearSnapshot()
            snapshotRunId = runId
        }
        dispatched.add(id)
        while (dispatched.size > 64) dispatched.remove(dispatched.first())
        executionId = id
        executionExpiresAt = expiration
        executionReply = reply
        val acceptedGeneration = generation
        emit(mapOf("type" to "status_changed"))
        service.execute(action, input, args["authority"] == "task", { commandCurrent(id, acceptedGeneration) }) { response ->
            if (executionId != id || generation != acceptedGeneration) return@execute
            executionId = null
            executionReply = null
            reply.success(response)
            emit(mapOf("type" to "status_changed"))
        }
        handler.postDelayed({
            if (executionId == id && generation == acceptedGeneration) {
                generation += 1
                executionId = null
                executionReply = null
                service.clearSnapshot()
                reply.success(failure("command_timeout"))
                emit(mapOf("type" to "status_changed"))
            }
        }, minOf(20000L, expiration - System.currentTimeMillis()).coerceAtLeast(1))
    }
    private fun commandCurrent(id: String, expected: Long): Boolean =
        enabled && foregroundServiceReady && generation == expected && executionId == id &&
            System.currentTimeMillis() < executionExpiresAt && !locked()

    fun emit(value: Map<String, Any>) {
        val sink = events
        if (sink != null) sink.success(value)
        else if (value["type"] != "status_changed") {
            while (pendingEvents.size >= 16) pendingEvents.removeFirst()
            pendingEvents.addLast(value)
        }
    }
    fun failure(code: String, canceled: Boolean = false): Map<String, Any> = mapOf(
        "outcome" to if (canceled) "canceled" else "failed",
        "errorCode" to code,
        "result" to mapOf("summary" to friendlyError(code), "data" to mapOf("effectVerdict" to "unverifiable")),
    )
    private fun friendlyError(code: String): String = when (code) {
        "android_version_unsupported" -> "Phone control needs Android 14 or later."
        "accessibility_required" -> "Enable ATLAS phone control in Android Accessibility settings."
        "notification_permission_required" -> "Allow Asael notifications so Mute and Stop stay available."
        "microphone_permission_required" -> "Allow microphone access to start a voice conversation."
        "visible_start_required" -> "Open Asael to start this session."
        "device_locked" -> "Unlock your phone and start control again."
        "snapshot_stale" -> "The screen changed. Look at the current screen before another action."
        "restricted_target" -> "This screen stays under your control. ATLAS cannot operate it."
        "secure_screen" -> "Android protects this screen. ATLAS cannot read or operate it."
        "control_disabled", "stopped" -> "Phone control is stopped."
        "command_timeout" -> "The action did not return a confirmed result. Check the phone before retrying."
        else -> "Phone control could not confirm this action. Check the phone and try again."
    }
}
