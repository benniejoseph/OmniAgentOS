package app.omniagent.omniagent

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors

/** Empty destination choice is separate from the later, explicit private save. */
object PrivateFileExportBridge {
    private const val CHANNEL = "app.omniagent.omniagent/file_export"
    private const val REQUEST = 4420
    private const val MAX_BYTES = 32 * 1024 * 1024
    private const val LIFETIME_MS = 20 * 60 * 1000L
    private var activity = WeakReference<MainActivity>(null)
    private var engine: FlutterEngine? = null
    private var resumed = false
    private var choosing: Choice? = null
    private var prepared: Destination? = null
    private val writer = Executors.newSingleThreadExecutor()

    private data class Choice(val scope: String, val filename: String, val reply: MethodChannel.Result)
    private data class Destination(val scope: String, val filename: String, val displayName: String, val uri: Uri, val handle: String, val expires: Long)

    fun attach(host: MainActivity, flutterEngine: FlutterEngine) {
        activity = WeakReference(host)
        if (engine !== flutterEngine) {
            engine = flutterEngine
            MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler(::handle)
        }
    }
    fun activityResumed(host: MainActivity) { activity = WeakReference(host); resumed = true }
    fun activityPaused(host: MainActivity) { if (activity.get() === host) resumed = false }
    fun detach(host: MainActivity) {
        if (activity.get() === host) { activity.clear(); resumed = false }
    }
    private fun visible(): MainActivity {
        val host = activity.get() ?: error("unavailable")
        check(resumed && !host.isFinishing && !host.isDestroyed)
        check(!(host.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked)
        return host
    }
    private fun current(scope: String): Destination? {
        val value = prepared ?: return null
        if (SystemClock.elapsedRealtime() > value.expires) { prepared = null; return null }
        return value.takeIf { it.scope == scope }
    }
    private fun handle(call: MethodCall, reply: MethodChannel.Result) {
        try {
            val args = call.arguments as? Map<*, *> ?: error("invalid_request")
            val scope = args["scopeKey"] as? String ?: error("invalid_scope")
            require(scope.length in 1..4096)
            when (call.method) {
                "chooseDestination" -> {
                    val host = visible()
                    check(choosing == null)
                    val filename = args["filename"] as? String ?: error("invalid_name")
                    require(filename.length in 1..240 && !filename.contains('/') && !filename.contains('\\') && !filename.contains('\u0000'))
                    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(filename.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
                    prepared = null
                    choosing = Choice(scope, filename, reply)
                    try {
                        host.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = mime
                            putExtra(Intent.EXTRA_TITLE, filename)
                            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                        }, REQUEST)
                    } catch (failure: Exception) { choosing = null; throw failure }
                }
                "preparedDestination" -> {
                    visible()
                    val value = current(scope)
                    reply.success(value?.let { mapOf("handle" to it.handle, "filename" to it.displayName, "requestedFilename" to it.filename) })
                }
                "writePrepared" -> {
                    val host = visible()
                    val value = current(scope) ?: error("destination_expired")
                    check(value.handle == args["handle"])
                    val bytes = args["bytes"] as? ByteArray ?: error("invalid_bytes")
                    require(bytes.size <= MAX_BYTES)
                    prepared = null // Admit this handle once, even when a write fails.
                    val resolver = host.applicationContext.contentResolver
                    writer.execute {
                        val saved = runCatching {
                            resolver.openOutputStream(value.uri, "wt").use { stream ->
                                check(stream != null)
                                stream.write(bytes)
                                stream.flush()
                            }
                        }.isSuccess
                        bytes.fill(0)
                        host.runOnUiThread {
                            if (saved) reply.success(null)
                            else reply.error("save_failed", "The selected file could not be saved. Choose a location again.", null)
                        }
                    }
                }
                else -> reply.notImplemented()
            }
        } catch (_: Exception) {
            reply.error("export_unavailable", "Unlock Asael and choose a save location again.", null)
        }
    }
    fun activityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST) return
        val choice = choosing ?: return
        choosing = null
        val uri = data?.data
        if (resultCode == Activity.RESULT_OK && uri != null && uri.scheme == "content") {
            val name = runCatching {
                activity.get()?.contentResolver?.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0)?.take(240) else null
                }
            }.getOrNull()?.takeIf { it.isNotBlank() } ?: choice.filename
            prepared = Destination(choice.scope, choice.filename, name, uri, UUID.randomUUID().toString(), SystemClock.elapsedRealtime() + LIFETIME_MS)
        }
        // Choice completes with no bytes, authorization, or private content.
        choice.reply.success(null)
    }
}
