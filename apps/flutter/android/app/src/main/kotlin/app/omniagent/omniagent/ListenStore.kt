package app.omniagent.omniagent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyStore
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** App-private, owner-bound encrypted manifests, credentials and independently durable audio frames. */
class ListenStore(context: Context, val scope: String) {
    companion object {
        const val MAX_BYTES = 512L * 1024 * 1024
        private const val ALIAS = "asael_listen_v1"
        internal val lock = Any()
        fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun scopeFor(args: Map<*, *>): String = digest(listOf("ownerId", "tenantId", "actorId", "role", "deviceId", "deploymentId").joinToString("\n") {
            (args[it] as? String)?.takeIf { value -> value.isNotBlank() && value.length <= 500 } ?: error("invalid_scope")
        }.toByteArray())
        fun active(context: Context): ListenStore? = context.getSharedPreferences("asael_listen_scope", 0).getString("active", null)?.let { ListenStore(context, it) }
        fun activate(context: Context, scope: String?) {
            context.getSharedPreferences("asael_listen_scope", 0).edit().apply { if (scope == null) remove("active") else putString("active", scope) }.commit()
        }
        fun now(): String = Instant.now().toString()
    }

    private val root = File(context.noBackupFilesDir, "listen-v1/$scope").apply { mkdirs() }
    private fun key(): SecretKey = synchronized(lock) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    private fun seal(bytes: ByteArray, label: String): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD("$scope:$label".toByteArray())
        return cipher.iv + cipher.doFinal(bytes)
    }
    private fun open(bytes: ByteArray, label: String): ByteArray {
        require(bytes.size >= 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD("$scope:$label".toByteArray())
        return cipher.doFinal(bytes, 12, bytes.size - 12)
    }
    private fun atomic(file: File, bytes: ByteArray) {
        val pending = File(file.parentFile, "${file.name}.pending")
        FileOutputStream(pending).use { it.write(bytes); it.fd.sync() }
        check(pending.renameTo(file)) { "storage_unavailable" }
    }
    private fun readJson(file: File): JSONObject = if (file.exists()) JSONObject(String(open(file.readBytes(), file.name))) else JSONObject()
    private fun writeJson(file: File, value: JSONObject) = atomic(file, seal(value.toString().toByteArray(), file.name))
    fun settings(): JSONObject = synchronized(lock) { readJson(File(root, "settings.enc")) }
    fun updateSettings(edit: (JSONObject) -> Unit): JSONObject = synchronized(lock) {
        settings().also { edit(it); writeJson(File(root, "settings.enc"), it) }
    }
    fun grant(): JSONObject = synchronized(lock) { readJson(File(root, "grant.enc")) }
    fun saveGrant(value: JSONObject) = synchronized(lock) { writeJson(File(root, "grant.enc"), value) }
    fun clearGrant() = synchronized(lock) {
        // Keep the nonsecret binding so Flutter can recognize and renew this
        // owner's paused queue without ever displaying another owner's data.
        val binding = grant().optJSONObject("scope")
        writeJson(File(root, "grant.enc"), JSONObject().put("scope", binding))
    }
    fun grantReady(): Boolean = runCatching { Instant.parse(grant().optString("expiresAt")).toEpochMilli() > System.currentTimeMillis() + 30_000 }.getOrDefault(false)
    private fun sessionFile(id: String): File { require(id.matches(Regex("[a-zA-Z0-9_-]{1,100}"))); return File(root, "$id.session.enc") }
    fun session(id: String): JSONObject = synchronized(lock) { readJson(sessionFile(id)) }
    fun saveSession(value: JSONObject) = synchronized(lock) { writeJson(sessionFile(value.getString("sessionId")), value) }
    fun updateSession(id: String, edit: (JSONObject) -> Unit): JSONObject = synchronized(lock) { session(id).also { edit(it); saveSession(it) } }
    fun sessions(): List<JSONObject> = synchronized(lock) {
        root.listFiles()?.filter { it.name.endsWith(".session.enc") }?.mapNotNull { runCatching { readJson(it) }.getOrNull() }
            ?.sortedByDescending { it.optString("startedAt") } ?: emptyList()
    }
    fun newSession(title: String, kind: String, category: String, projectId: String?, sourceKey: String? = null, startedAt: String = now()): JSONObject {
        val id = UUID.randomUUID().toString()
        return JSONObject().put("sessionId", id).put("title", title.take(200)).put("sourceKind", kind)
            .put("sourceKey", sourceKey ?: id).put("contextCategory", category).put("projectId", projectId)
            .put("startedAt", startedAt).put("state", if (kind == "listen") "listening" else "importing")
            .put("durationMs", 0).put("segments", JSONArray()).put("finished", false).also(::saveSession)
    }
    fun queuedBytes(): Long = root.listFiles()?.sumOf { if (it.name.endsWith(".audio.enc") || it.name.endsWith(".frames")) it.length() else 0 } ?: 0
    fun appendFrame(id: String, pcm: ByteArray) = synchronized(lock) {
        check(queuedBytes() + pcm.size + 64 < MAX_BYTES) { "storage_full" }
        val bytes = seal(pcm, "$id.frames")
        val target = File(root, "$id.frames")
        val newJournal = !target.exists() || target.length() == 0L
        FileOutputStream(target, true).use { file ->
            DataOutputStream(file).apply {
                if (newJournal) writeUTF(UUID.randomUUID().toString())
                writeInt(bytes.size); write(bytes); flush()
            }
            file.fd.sync()
        }
    }
    fun finishFrames(id: String): Boolean = synchronized(lock) {
        val file = File(root, "$id.frames")
        if (!file.exists() || file.length() == 0L) return@synchronized false
        val pcm = ByteArrayOutputStream()
        var journalId = ""
        DataInputStream(file.inputStream().buffered()).use { input ->
            if (input.available() < 38) { file.delete(); return@synchronized false }
            journalId = input.readUTF()
            while (input.available() >= 4) {
                val size = input.readInt()
                if (size !in 28..128_000 || input.available() < size) break // A killed process may leave one partial frame.
                val bytes = ByteArray(size).also(input::readFully)
                pcm.write(open(bytes, "$id.frames"))
            }
        }
        if (pcm.size() > 0) {
            val previous = session(id).getJSONArray("segments")
            if ((0 until previous.length()).any { previous.getJSONObject(it).optString("journalId") == journalId }) {
                file.delete(); return@synchronized true
            }
            val sound = pcm.toByteArray()
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray()).putInt(sound.size + 36).put("WAVEfmt ".toByteArray()).putInt(16)
                .putShort(1).putShort(1).putInt(16_000).putInt(32_000).putShort(2).putShort(16)
                .put("data".toByteArray()).putInt(sound.size)
            addSegment(id, header.array() + sound, sound.size.toLong() * 1000 / 32_000, "audio/wav", journalId)
        }
        file.delete()
        pcm.size() > 0
    }
    fun addSegment(id: String, bytes: ByteArray, durationMs: Long, mime: String, journalId: String? = null) = synchronized(lock) {
        require(bytes.size in 1..3_000_000 && durationMs > 0)
        check(queuedBytes() + bytes.size <= MAX_BYTES) { "storage_full" }
        val value = session(id)
        val segments = value.getJSONArray("segments")
        require(segments.length() < 1440 && value.optLong("durationMs") + durationMs <= 86_400_000) { "recording_limit" }
        val index = segments.length()
        val file = File(root, "$id-$index.audio.enc")
        atomic(file, seal(bytes, file.name))
        segments.put(JSONObject().put("index", index).put("durationMs", durationMs).put("mime", mime)
            .put("sha256", digest(bytes)).put("byteLength", bytes.size).put("uploaded", false).put("journalId", journalId))
        value.put("durationMs", value.optLong("durationMs") + durationMs)
        saveSession(value)
    }
    fun segmentBytes(id: String, index: Int): ByteArray = synchronized(lock) {
        val file = File(root, "$id-$index.audio.enc"); open(file.readBytes(), file.name)
    }
    fun acknowledgeSegment(id: String, index: Int) = synchronized(lock) {
        updateSession(id) { it.getJSONArray("segments").getJSONObject(index).put("uploaded", true) }
        File(root, "$id-$index.audio.enc").delete()
    }
    fun deleteSession(id: String) = synchronized(lock) {
        val value = session(id)
        // Retain a tombstone so the same call is not silently imported again.
        if (value.length() > 0) saveSession(value.put("state", "deleted").put("finished", true).put("segments", JSONArray()))
        root.listFiles()?.filter { it.name.startsWith("$id-") || it.name == "$id.frames" }?.forEach { it.delete() }
    }
    fun recoverInterrupted(includeImports: Boolean = false) = synchronized(lock) {
        sessions().filter { it.optString("state") in (if (includeImports) setOf("listening", "paused", "importing") else setOf("listening", "paused")) }.forEach { session ->
            val id = session.getString("sessionId")
            finishFrames(id)
            if (session.optString("state") == "importing") {
                // Incomplete call imports restart from their unchanged original at the next scan.
                deleteSession(id)
                updateSession(id) { it.put("sourceKey", "interrupted-$id") }
            } else updateSession(id) {
                it.put("state", "queued").put("finished", true)
                    .put("message", "Listening was interrupted. Audio already saved is ready to process.")
            }
        }
    }
    fun recoverImports() = synchronized(lock) {
        sessions().filter { it.optString("state") == "importing" }.forEach {
            val id = it.getString("sessionId")
            deleteSession(id)
            updateSession(id) { value -> value.put("sourceKey", "interrupted-$id") }
        }
    }
}

internal fun JSONObject.asMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
    when (val value = opt(key)) {
        null, JSONObject.NULL -> null
        is JSONObject -> value.asMap()
        is JSONArray -> (0 until value.length()).map { index -> (value.opt(index) as? JSONObject)?.asMap() ?: value.opt(index) }
        else -> value
    }
}
