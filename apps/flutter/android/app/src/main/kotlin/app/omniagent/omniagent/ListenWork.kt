package app.omniagent.omniagent

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.time.Duration
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID
import java.util.concurrent.TimeUnit

object ListenWork {
    private const val TAG = "asael-listen"
    internal val uploadLock = Any()
    internal val scanLock = Any()
    fun nextScan(): ZonedDateTime {
        val now = ZonedDateTime.now(ZoneId.of("Asia/Kolkata"))
        val tonight = now.withHour(23).withMinute(30).withSecond(0).withNano(0)
        return if (tonight.isAfter(now)) tonight else tonight.plusDays(1)
    }
    fun schedule(context: Context) {
        val store = ListenStore.active(context) ?: return
        if (!store.settings().optBoolean("callsEnabled")) { WorkManager.getInstance(context).cancelUniqueWork("listen-nightly-${store.scope}"); return }
        val request = PeriodicWorkRequestBuilder<ListenCallWorker>(24, TimeUnit.HOURS)
            .setInitialDelay(Duration.between(ZonedDateTime.now(ZoneId.of("Asia/Kolkata")), nextScan()).toMillis(), TimeUnit.MILLISECONDS)
            .setInputData(Data.Builder().putString("scope", store.scope).build()).addTag(TAG)
            .setConstraints(Constraints.Builder().setRequiresStorageNotLow(true).setRequiresBatteryNotLow(true).build()).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("listen-nightly-${store.scope}", ExistingPeriodicWorkPolicy.KEEP, request)
    }
    fun enqueueScan(context: Context) {
        val scope = ListenStore.active(context)?.scope ?: return
        WorkManager.getInstance(context).enqueueUniqueWork("listen-scan-$scope", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<ListenCallWorker>().setInputData(Data.Builder().putString("scope", scope).build()).addTag(TAG).build())
    }
    fun enqueueUpload(context: Context) {
        val scope = ListenStore.active(context)?.scope ?: return
        WorkManager.getInstance(context).enqueueUniqueWork("listen-upload-$scope", ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<ListenUploadWorker>().setInputData(Data.Builder().putString("scope", scope).build()).addTag(TAG)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 1, TimeUnit.MINUTES).build())
    }
    fun cancel(context: Context) { WorkManager.getInstance(context).cancelAllWorkByTag(TAG) }
}

class ListenCallWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = synchronized(ListenWork.scanLock) {
        val store = ListenStore.active(applicationContext) ?: return@synchronized Result.success()
        if (store.scope != inputData.getString("scope") || !store.settings().optBoolean("callsEnabled")) return@synchronized Result.success()
        val stopped = { isStopped || ListenStore.active(applicationContext)?.scope != store.scope || !store.settings().optBoolean("callsEnabled") }
        store.updateSettings { it.put("scanState", "scanning").put("scanMessage", "Checking completed call recordings…") }
        ListenBridge.changed(applicationContext)
        try {
            // A prior process may have died while muxing. These bounded temporary files are never used as receipts.
            java.io.File(applicationContext.cacheDir, "listen-remux").listFiles()?.forEach { it.delete() }
            store.recoverImports()
            ListenCallImporter.scan(applicationContext, store, stopped)
            ListenWork.enqueueUpload(applicationContext)
            Result.success()
        } catch (error: Exception) {
            store.updateSettings { it.put("scanState", "error").put("scanMessage", when (error.message) {
                "folder_access_required" -> "Choose the call recordings folder again to restore access."
                "folder_too_large" -> "Choose the specific Call folder so Asael can check it efficiently."
                else -> "The call check could not finish. Your original recordings are unchanged; Asael will try again."
            }) }
            if (error is SecurityException || error.message in setOf("folder_access_required", "folder_too_large")) Result.success() else Result.retry()
        } finally { ListenBridge.changed(applicationContext) }
    }
}

private class ListenHttpError(val status: Int) : Exception("listen_http_$status")

class ListenUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = synchronized(ListenWork.uploadLock) {
        val store = ListenStore.active(applicationContext) ?: return@synchronized Result.success()
        if (store.scope != inputData.getString("scope")) return@synchronized Result.success()
        fun valid() = !isStopped && ListenStore.active(applicationContext)?.scope == store.scope && store.grantReady()
        if (!valid()) {
            store.updateSettings { it.put("uploadState", "needs_access").put("uploadMessage", "Open Listen in Asael to renew processing access. Your saved audio is safe.") }
            ListenBridge.changed(applicationContext); return@synchronized Result.success()
        }
        var pending = false
        store.updateSettings { it.put("uploadState", "uploading").put("uploadMessage", "Saving your conversations for processing…") }
        ListenBridge.changed(applicationContext)
        try {
            for (snapshot in store.sessions().reversed()) {
                if (!valid()) break
                val id = snapshot.getString("sessionId")
                if (snapshot.optString("state") in setOf("deleted", "ready", "importing", "error")) continue
                val segments = snapshot.getJSONArray("segments")
                if (segments.length() == 0) {
                    if (snapshot.optBoolean("finished")) store.updateSession(id) { it.put("state", "error").put("message", "No audio was saved. Start a new conversation when you are ready.") }
                    continue
                }
                var recordingId = snapshot.optString("recordingId")
                try {
                    if (recordingId.isBlank()) {
                        val start = JSONObject().put("action", "start").put("sourceKey", snapshot.getString("sourceKey"))
                            .put("sourceKind", snapshot.getString("sourceKind")).put("title", snapshot.getString("title"))
                            .put("recordedAt", snapshot.getString("startedAt")).put("timeZone", "Asia/Kolkata")
                            .put("contextCategory", snapshot.optString("contextCategory", "unfiled"))
                        snapshot.optString("projectId").takeIf { it.isNotBlank() }?.let { start.put("projectId", it) }
                        val response = request(store, start.toString().toByteArray(), "application/json", ::valid)
                        recordingId = response.getString("recordingId")
                        store.updateSession(id) { it.put("recordingId", recordingId) }
                    }
                    for (index in 0 until segments.length()) {
                        if (!valid()) break
                        if (store.session(id).optString("state") == "deleted") break
                        if (segments.getJSONObject(index).optBoolean("uploaded")) continue
                        val segment = segments.getJSONObject(index)
                        val bytes = store.segmentBytes(id, index)
                        val boundary = "asael-${UUID.randomUUID()}"
                        val body = ByteArrayOutputStream()
                        fun field(name: String, value: String) { body.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray()) }
                        field("action", "segment"); field("recordingId", recordingId); field("segmentIndex", index.toString())
                        field("durationMs", segment.getLong("durationMs").toString()); field("sha256", segment.getString("sha256"))
                        val mime = segment.getString("mime"); val ext = if (mime == "audio/wav") "wav" else "m4a"
                        body.write("--$boundary\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"segment.$ext\"\r\nContent-Type: $mime\r\n\r\n".toByteArray())
                        body.write(bytes); body.write("\r\n--$boundary--\r\n".toByteArray())
                        request(store, body.toByteArray(), "multipart/form-data; boundary=$boundary", ::valid)
                        store.acknowledgeSegment(id, index); ListenBridge.changed(applicationContext)
                    }
                    val current = store.session(id)
                    if (current.optString("state") == "deleted" || !valid()) continue
                    val all = current.getJSONArray("segments")
                    if (current.optBoolean("finished") && (0 until all.length()).all { all.getJSONObject(it).optBoolean("uploaded") }) {
                        val response = request(store, JSONObject().put("action", if (current.optBoolean("completedRemote")) "status" else "complete")
                            .put("recordingId", recordingId).apply { if (!current.optBoolean("completedRemote")) put("segmentCount", all.length()) }.toString().toByteArray(), "application/json", ::valid)
                        val state = response.optString("status", "processing")
                        store.updateSession(id) {
                            it.put("completedRemote", true).put("state", when (state) { "ready", "completed" -> "ready"; "failed", "error" -> "error"; else -> "processing" })
                            if (state in setOf("failed", "error")) it.put("message", "Processing needs attention. Open the conversation in Asael to retry.") else it.remove("message")
                        }
                        if (state !in setOf("ready", "completed", "failed", "error")) pending = true
                    }
                } catch (error: ListenHttpError) {
                    if (error.status == 410) {
                        store.deleteSession(id)
                        continue
                    }
                    if (error.status in setOf(400, 409, 413, 415, 422)) {
                        store.updateSession(id) { it.put("state", "error").put("message", "This conversation could not be accepted for processing. Saved audio remains on this phone.") }
                        continue
                    }
                    throw error
                }
            }
            if (!valid()) {
                store.updateSettings { it.put("uploadState", "needs_access").put("uploadMessage", "Processing access paused. Your saved audio remains on this phone.") }
                return@synchronized Result.success()
            }
            // Capture can finalize a tail while this worker is sending its earlier snapshot.
            pending = pending || store.sessions().any { session ->
                val chunks = session.optJSONArray("segments")
                session.optString("state") !in setOf("deleted", "ready", "error", "importing") && chunks != null && chunks.length() > 0 &&
                    ((0 until chunks.length()).any { !chunks.getJSONObject(it).optBoolean("uploaded") } || (session.optBoolean("finished") && !session.optBoolean("completedRemote")))
            }
            store.updateSettings { it.put("uploadState", "idle").put("uploadMessage", if (pending) "Your saved conversations are being uploaded or processed." else "Saved audio is up to date.") }
            if (pending) Result.retry() else Result.success()
        } catch (error: Exception) {
            val needsAccess = error is ListenHttpError && error.status in setOf(401, 403)
            if (needsAccess) store.clearGrant()
            store.updateSettings { it.put("uploadState", if (needsAccess) "needs_access" else "error")
                .put("uploadMessage", if (needsAccess) "Open Listen in Asael to renew processing access. Your saved audio is safe." else "Saved on this phone. Upload will retry when the connection is available.") }
            if (needsAccess || isStopped) Result.success() else Result.retry()
        } finally { ListenBridge.changed(applicationContext) }
    }
    private fun request(store: ListenStore, bytes: ByteArray, contentType: String, valid: () -> Boolean): JSONObject {
        check(valid()) { "access_required" }
        val grant = store.grant()
        val uri = URI(grant.getString("ingestUrl"))
        check(uri.scheme == "https" && uri.rawUserInfo == null && uri.path == "/api/mobile/listen/ingest" && uri.query == null && uri.fragment == null) { "invalid_endpoint" }
        val connection = uri.toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"; connection.connectTimeout = 20_000; connection.readTimeout = 60_000
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Listen ${grant.getString("token")}")
            connection.setRequestProperty("Content-Type", contentType)
            connection.setFixedLengthStreamingMode(bytes.size)
            check(valid()) { "access_required" }
            connection.outputStream.use { it.write(bytes) }
            val code = connection.responseCode
            if (code !in 200..299) throw ListenHttpError(code)
            val response = connection.inputStream.use { input ->
                val buffer = ByteArrayOutputStream(); val chunk = ByteArray(8192); var count: Int
                while (input.read(chunk).also { count = it } > 0) { check(buffer.size() + count <= 1_000_000); buffer.write(chunk, 0, count) }
                JSONObject(buffer.toString("UTF-8"))
            }
            return response.optJSONObject("result") ?: response
        } finally { connection.disconnect() }
    }
}
