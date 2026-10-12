package app.omniagent.omniagent

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/** No broad login credential crosses this boundary. Only a separately revocable Listen grant is stored. */
object ListenBridge {
    private const val CHANNEL = "app.omniagent.omniagent/listen"
    private const val PERMISSIONS = 4414
    private const val FOLDER = 4415
    private val main = Handler(Looper.getMainLooper())
    private var activity = WeakReference<MainActivity>(null)
    private var app: Context? = null
    private var resumed = false
    private var engine: FlutterEngine? = null
    private var events: EventChannel.EventSink? = null
    private var pendingPermission: MethodChannel.Result? = null
    private var pendingFolder: MethodChannel.Result? = null
    private var pickerScope: String? = null
    private var recovered = false

    fun attach(host: MainActivity, flutterEngine: FlutterEngine) {
        activity = WeakReference(host); app = host.applicationContext
        if (engine !== flutterEngine) {
            engine = flutterEngine
            MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler(::handle)
            EventChannel(flutterEngine.dartExecutor.binaryMessenger, "$CHANNEL/events").setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, sink: EventChannel.EventSink) { events = sink; changed(host) }
                override fun onCancel(arguments: Any?) { events = null }
            })
        }
        if (!recovered && ListenRecordingService.current == null) {
            recovered = true
            runCatching { ListenStore.active(host)?.recoverInterrupted() }
        }
        ListenWork.schedule(host)
    }
    fun activityResumed(host: MainActivity) { activity = WeakReference(host); resumed = true; changed(host) }
    fun activityPaused(host: MainActivity) { if (activity.get() === host) resumed = false }
    fun detach(host: MainActivity) { if (activity.get() === host) { activity.clear(); resumed = false } }
    fun changed(context: Context) {
        main.post { runCatching { events?.success(status(context.applicationContext)) } }
    }
    fun permissionResult(requestCode: Int) {
        if (requestCode != PERMISSIONS) return
        pendingPermission?.success(status(requireNotNull(app))); pendingPermission = null
        app?.let(::changed)
    }
    fun activityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != FOLDER) return
        val context = app ?: return
        val reply = pendingFolder; pendingFolder = null
        try {
            val store = ListenStore.active(context)
            check(store != null && store.scope == pickerScope) { "access_required" }
            if (resultCode == Activity.RESULT_OK && data?.data != null) {
                val uri = data.data!!
                require(uri.scheme == "content")
                context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                val name = DocumentsContract.getTreeDocumentId(uri).substringAfterLast('/').substringAfterLast(':').ifBlank { "Call recordings" }
                store.updateSettings { it.put("callFolderUri", uri.toString()).put("callFolderName", name.take(150)).put("scanState", "idle") }
            }
            reply?.success(status(context)); changed(context)
        } catch (_: Exception) { reply?.error("folder_access_required", "Choose the Call recordings folder and allow read access.", null) }
        pickerScope = null
    }
    private fun visible(): MainActivity { check(resumed) { "visible_start_required" }; return activity.get() ?: error("visible_start_required") }
    private fun store(): ListenStore = ListenStore.active(requireNotNull(app)) ?: error("access_required")
    private fun arguments(call: MethodCall): Map<*, *> = call.arguments as? Map<*, *> ?: emptyMap<String, Any>()
    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        val context = app ?: run { result.error("unavailable", "Open Asael to use Listen.", null); return }
        try {
            val args = arguments(call)
            when (call.method) {
                "getStatus" -> Unit
                "requestPermissions" -> {
                    val host = visible()
                    check(pendingPermission == null) { "setup_in_progress" }
                    val requested = mutableListOf<String>()
                    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) requested.add(Manifest.permission.RECORD_AUDIO)
                    if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requested.add(Manifest.permission.POST_NOTIFICATIONS)
                    if (requested.isNotEmpty()) { pendingPermission = result; host.requestPermissions(requested.toTypedArray(), PERMISSIONS); return }
                }
                "configureAccessGrant" -> {
                    visible()
                    val scope = ListenStore.scopeFor(args)
                    val token = args["token"] as? String ?: error("access_required")
                    require(token.length in 20..16_000 && !token.contains('\n'))
                    val expires = args["expiresAt"] as? String ?: error("access_required")
                    require(Instant.parse(expires).isAfter(Instant.now()))
                    val ingest = URI(args["ingestUrl"] as? String ?: error("invalid_endpoint"))
                    val deployment = URI(args["deploymentId"] as? String ?: error("invalid_endpoint"))
                    check(ingest.scheme == "https" && ingest.rawUserInfo == null && ingest.path == "/api/mobile/listen/ingest" && ingest.query == null && ingest.fragment == null &&
                        ingest.scheme == deployment.scheme && ingest.host == deployment.host && ingest.port == deployment.port) { "invalid_endpoint" }
                    val previous = ListenStore.active(context)
                    if (previous != null && previous.scope != scope) {
                        ListenStore.activate(context, null); previous.clearGrant(); ListenWork.cancel(context)
                        ListenRecordingService.current?.stopRecording("Listening stopped because the signed-in workspace changed.")
                    }
                    val bound = ListenStore(context, scope)
                    val scopeJson = JSONObject()
                    listOf("ownerId", "tenantId", "actorId", "role", "deviceId", "deploymentId", "canonicalUserId").forEach { if (args[it] is String) scopeJson.put(it, args[it]) }
                    bound.saveGrant(JSONObject().put("token", token).put("expiresAt", expires).put("ingestUrl", ingest.toString()).put("scope", scopeJson))
                    ListenStore.activate(context, scope)
                    if (ListenRecordingService.current == null) bound.recoverInterrupted()
                    ListenWork.schedule(context); ListenWork.enqueueUpload(context)
                }
                "clearOwner" -> {
                    val previous = ListenStore.active(context)
                    ListenStore.activate(context, null); previous?.clearGrant(); ListenWork.cancel(context)
                    ListenRecordingService.current?.stopRecording("Listening stopped because your account access changed. Saved audio remains on this phone.")
                }
                "chooseCallFolder" -> {
                    val host = visible(); val owner = store()
                    check(pendingFolder == null) { "setup_in_progress" }
                    pickerScope = owner.scope; pendingFolder = result
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
                    if (Build.VERSION.SDK_INT >= 26) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse("content://com.android.externalstorage.documents/document/primary%3ARecordings%2FCall"))
                    @Suppress("DEPRECATION") host.startActivityForResult(intent, FOLDER)
                    return
                }
                "removeCallFolder" -> {
                    visible(); val owner = store(); val old = owner.settings().optString("callFolderUri")
                    owner.updateSettings { it.put("callsEnabled", false).remove("callFolderUri"); it.remove("callFolderName") }
                    if (old.isNotBlank()) runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(old), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    ListenWork.schedule(context)
                }
                "configureCalls" -> {
                    visible(); val owner = store(); val enabled = args["enabled"] as? Boolean ?: error("invalid_arguments")
                    check(args["timeZone"] == null || args["timeZone"] == "Asia/Kolkata") { "invalid_schedule" }
                    check(args["hour"] == null || args["hour"] == 23) { "invalid_schedule" }
                    check(args["minute"] == null || args["minute"] == 30) { "invalid_schedule" }
                    val category = args["contextCategory"] as? String ?: "unfiled"
                    require(category in setOf("personal", "work", "unfiled"))
                    if (enabled) {
                        check(owner.grantReady()) { "access_required" }
                        check(owner.settings().optString("callFolderUri").isNotBlank()) { "folder_access_required" }
                    }
                    owner.updateSettings {
                        if (enabled && !it.optBoolean("callsEnabled")) it.put("callsSince", ZonedDateTime.now(ZoneId.of("Asia/Kolkata")).toLocalDate().atStartOfDay(ZoneId.of("Asia/Kolkata")).toInstant().toEpochMilli())
                        it.put("callsEnabled", enabled).put("callCategory", category).put("callProjectId", args["projectId"])
                    }
                    ListenWork.schedule(context)
                }
                "scanCallsNow" -> { visible(); check(store().settings().optBoolean("callsEnabled")) { "calls_disabled" }; ListenWork.enqueueScan(context) }
                "startListen" -> {
                    val host = visible(); val owner = store()
                    check(owner.grantReady()) { "access_required" }
                    check(ListenRecordingService.current?.sessionId == null && owner.sessions().none { it.optString("state") == "listening" }) { "already_listening" }
                    check(!AndroidDeviceBridge.voiceActive) { "voice_active" }
                    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "microphone_required" }
                    check(Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) { "notifications_required" }
                    val category = args["contextCategory"] as? String ?: "unfiled"
                    require(category in setOf("personal", "work", "unfiled"))
                    val session = owner.newSession((args["title"] as? String)?.ifBlank { "Conversation" } ?: "Conversation", "listen", category, args["projectId"] as? String)
                    val intent = Intent(host, ListenRecordingService::class.java).setAction(ListenRecordingService.START).putExtra("sessionId", session.getString("sessionId"))
                    if (Build.VERSION.SDK_INT >= 26) host.startForegroundService(intent) else host.startService(intent)
                }
                "pauseListen" -> { ListenRecordingService.current?.pause() }
                "resumeListen" -> { visible(); ListenRecordingService.current?.resume() ?: error("session_required") }
                "stopListen" -> { ListenRecordingService.current?.stopRecording() }
                "uploadNow" -> { visible(); check(store().grantReady()) { "access_required" }; ListenWork.enqueueUpload(context) }
                "deleteLocalSession" -> {
                    visible(); val id = args["sessionId"] as? String ?: error("session_required")
                    check(ListenRecordingService.current?.sessionId != id) { "finish_first" }
                    store().deleteSession(id)
                }
                else -> { result.notImplemented(); return }
            }
            result.success(status(context)); changed(context)
        } catch (error: Exception) {
            val code = error.message?.takeIf { it.matches(Regex("[a-z_]{1,80}")) } ?: "listen_unavailable"
            result.error(code, when (code) {
                "access_required" -> "Open Listen and renew processing access. Saved audio remains on your phone."
                "microphone_required", "notifications_required" -> "Allow the microphone and notifications to start listening with visible controls."
                "folder_access_required" -> "Choose your Call recordings folder first."
                "voice_active" -> "Finish your ATLAS voice conversation before starting Listen."
                "storage_full" -> "Upload saved conversations to free listening storage."
                "visible_start_required" -> "Open Asael to start or resume listening."
                else -> "Listen could not finish that action. Your saved audio is unchanged."
            }, null)
        }
    }
    private fun status(context: Context): Map<String, Any?> {
        val owner = ListenStore.active(context)
        val settings = owner?.settings() ?: JSONObject()
        val sessions = owner?.sessions()?.filter { it.optString("state") != "deleted" }?.take(100)?.map { session ->
            val segments = session.getJSONArray("segments")
            mapOf("sessionId" to session.getString("sessionId"), "title" to session.optString("title"), "sourceKind" to session.optString("sourceKind"),
                "state" to session.optString("state"), "startedAt" to session.optString("startedAt"), "durationMs" to session.optLong("durationMs"),
                "segmentCount" to segments.length(), "uploadedSegments" to (0 until segments.length()).count { segments.getJSONObject(it).optBoolean("uploaded") },
                "recordingId" to session.optString("recordingId").takeIf { it.isNotBlank() }, "message" to session.optString("message").takeIf { it.isNotBlank() })
        } ?: emptyList()
        val activeId = ListenRecordingService.current?.sessionId
        val active = sessions.firstOrNull { it["sessionId"] == activeId }?.toMutableMap()?.apply {
            put("elapsedMs", ListenRecordingService.current?.capturedDurationMs() ?: get("durationMs")); put("reason", get("message"))
        }
        val folder = settings.optString("callFolderUri")
        val folderReady = folder.isNotBlank() && context.contentResolver.persistedUriPermissions.any { it.uri.toString() == folder && it.isReadPermission }
        return mapOf("schemaVersion" to 1, "supported" to true,
            "scope" to owner?.grant()?.optJSONObject("scope")?.asMap(),
            "microphoneGranted" to (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED),
            "notificationsGranted" to (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED),
            "accessReady" to (owner?.grantReady() ?: false), "accessExpiresAt" to owner?.grant()?.optString("expiresAt"),
            "callsEnabled" to settings.optBoolean("callsEnabled"), "callFolderSelected" to folderReady, "callFolderName" to settings.optString("callFolderName"),
            "nextScanAt" to if (settings.optBoolean("callsEnabled")) ListenWork.nextScan().toInstant().toString() else null,
            "lastScanAt" to settings.optString("lastScanAt"), "scanState" to settings.optString("scanState", "idle"), "scanMessage" to settings.optString("scanMessage"),
            "activeSession" to active, "sessions" to sessions, "queuedBytes" to (owner?.queuedBytes() ?: 0L),
            "uploadState" to settings.optString("uploadState", "idle"), "uploadMessage" to settings.optString("uploadMessage"))
    }
}
