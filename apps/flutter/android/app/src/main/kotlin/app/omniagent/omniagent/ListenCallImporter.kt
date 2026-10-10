package app.omniagent.omniagent

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Reads only the user-selected folder. Samsung originals are never changed or deleted. */
object ListenCallImporter {
    private data class Source(val uri: Uri, val name: String, val size: Long, val modified: Long)
    fun scan(context: Context, store: ListenStore, cancelled: () -> Boolean) {
        val settings = store.settings()
        if (!settings.optBoolean("callsEnabled")) return
        val tree = Uri.parse(settings.getString("callFolderUri"))
        check(context.contentResolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission }) { "folder_access_required" }
        val since = settings.getLong("callsSince")
        val known = store.sessions().map { it.optString("sourceKey") }.toMutableSet()
        val sources = mutableListOf<Source>()
        var visited = 0
        fun visit(documentId: String, depth: Int) {
            if (depth > 5 || cancelled()) return
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
            context.contentResolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    check(++visited <= 10_000) { "folder_too_large" }
                    val id = cursor.getString(0)
                    val type = cursor.getString(2) ?: ""
                    if (type == DocumentsContract.Document.MIME_TYPE_DIR) visit(id, depth + 1)
                    else {
                        val name = cursor.getString(1) ?: "Call recording"
                        val size = cursor.getLong(3); val modified = cursor.getLong(4)
                        val supportedName = name.substringAfterLast('.', "").lowercase() in setOf("m4a", "mp4", "aac", "3gp", "mp3", "wav", "ogg", "amr")
                        if ((type.startsWith("audio/") || supportedName) && size > 0 && modified >= since && modified <= System.currentTimeMillis() - 120_000) {
                            sources.add(Source(DocumentsContract.buildDocumentUriUsingTree(tree, id), name, size, modified))
                        }
                    }
                }
            }
        }
        visit(DocumentsContract.getTreeDocumentId(tree), 0)
        var imported = 0; var unsupported = 0
        for (source in sources.sortedBy { it.modified }) {
            if (cancelled() || ListenStore.active(context)?.scope != store.scope) break
            // Cheap metadata receipts avoid rereading yesterday's recordings; digest remains the cross-file identity.
            val receiptKey = ListenStore.digest("${source.uri}:${source.size}:${source.modified}".toByteArray())
            val receipts = store.settings().optJSONObject("callReceipts") ?: JSONObject()
            if (receipts.has(receiptKey)) continue
            if (source.size > ListenStore.MAX_BYTES) { unsupported++; continue }
            val digest = MessageDigest.getInstance("SHA-256")
            context.contentResolver.openInputStream(source.uri)?.use { input ->
                val buffer = ByteArray(64 * 1024); var count: Int; var read = 0L
                while (input.read(buffer).also { count = it } > 0) {
                    if (cancelled()) return
                    read += count; check(read <= ListenStore.MAX_BYTES) { "recording_too_large" }; digest.update(buffer, 0, count)
                }
            } ?: continue
            val sourceKey = "call-" + digest.digest().joinToString("") { "%02x".format(it) }
            if (!unchanged(context, source)) continue
            if (known.contains(sourceKey)) {
                receipt(store, receiptKey, sourceKey); continue
            }
            val session = store.newSession(source.name.substringBeforeLast('.').take(180).ifBlank { "Call recording" }, "call", settings.optString("callCategory", "unfiled"),
                settings.optString("callProjectId").takeIf { it.isNotBlank() }, sourceKey, Instant.ofEpochMilli(source.modified).toString())
            val id = session.getString("sessionId")
            try {
                split(context, store, source.uri, id, cancelled)
                check(!cancelled() && unchanged(context, source)) { "recording_changed" }
                check(store.session(id).getJSONArray("segments").length() > 0) { "empty_recording" }
                store.updateSession(id) {
                    // Samsung closes the file when the call ends; duration gives a better conversation start than its final write time.
                    it.put("startedAt", Instant.ofEpochMilli((source.modified - it.optLong("durationMs")).coerceAtLeast(0)).toString())
                        .put("state", "queued").put("finished", true)
                }
                receipt(store, receiptKey, sourceKey); known.add(sourceKey); imported++
                ListenWork.enqueueUpload(context)
            } catch (error: Exception) {
                store.deleteSession(id)
                // Failed source remains eligible on the next scan; no successful import receipt is written.
                store.updateSession(id) { it.put("sourceKey", "incomplete-$id").put("state", "error")
                    .put("message", if (error.message == "storage_full") "Phone storage is full. Upload queued conversations before importing this call." else "This call could not be imported yet. Its original recording is unchanged.") }
                unsupported++
            }
        }
        store.updateSettings { it.put("lastScanAt", ListenStore.now()).put("scanState", "idle")
            .put("scanMessage", if (unsupported > 0) "$imported calls imported. $unsupported recordings need another attempt or a supported audio format." else if (imported > 0) "$imported calls saved for processing." else "No new completed call recordings were found.") }
    }
    private fun receipt(store: ListenStore, key: String, source: String) = store.updateSettings {
        val value = it.optJSONObject("callReceipts") ?: JSONObject()
        value.put(key, source); it.put("callReceipts", value)
    }
    private fun unchanged(context: Context, source: Source): Boolean = context.contentResolver.query(source.uri,
        arrayOf(DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use {
        it.moveToFirst() && it.getLong(0) == source.size && it.getLong(1) == source.modified
    } ?: false

    private fun split(context: Context, store: ListenStore, uri: Uri, id: String, cancelled: () -> Boolean) {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(context, uri, null)
            val track = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: error("unsupported_audio")
            val format = extractor.getTrackFormat(track)
            extractor.selectTrack(track)
            if (format.getString(MediaFormat.KEY_MIME) == "audio/mp4a-latm") remuxAac(context, store, extractor, format, id, cancelled)
            else decodeToWav(store, extractor, format, id, cancelled)
        } finally { extractor.release() }
    }
    private fun remuxAac(context: Context, store: ListenStore, extractor: MediaExtractor, format: MediaFormat, id: String, cancelled: () -> Boolean) {
        val cache = File(context.cacheDir, "listen-remux").apply { mkdirs() }
        // Plain source audio exists only in this bounded temporary muxing file; durable files are encrypted.
        val buffer = ByteBuffer.allocate(512 * 1024)
        val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        while (extractor.sampleTime >= 0 && !cancelled()) {
            val file = File(cache, "${UUID.randomUUID()}.m4a")
            var muxer: MediaMuxer? = null
            try {
                muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                val track = muxer.addTrack(format); muxer.start()
                val first = extractor.sampleTime
                var last = first; var total = 0
                while (extractor.sampleTime >= 0 && !cancelled()) {
                    val time = extractor.sampleTime
                    buffer.clear(); val count = extractor.readSampleData(buffer, 0)
                    if (count < 0) break
                    check(count <= buffer.capacity()) { "unsupported_audio" }
                    val info = MediaCodec.BufferInfo().apply { set(0, count, time - first, extractor.sampleFlags) }
                    muxer.writeSampleData(track, buffer, info)
                    total += count; last = time
                    extractor.advance()
                    if (total >= 2_300_000 || last - first >= 120_000_000) break
                }
                muxer.stop(); muxer.release(); muxer = null
                check(!cancelled()) { "cancelled" }
                store.addSegment(id, file.readBytes(), (last - first) / 1000 + 1_024_000 / sampleRate, "audio/mp4")
            } finally { runCatching { muxer?.release() }; file.delete() }
        }
    }
    private fun decodeToWav(store: ListenStore, extractor: MediaExtractor, format: MediaFormat, id: String, cancelled: () -> Boolean) {
        val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME) ?: error("unsupported_audio"))
        try {
            decoder.configure(format, null, null, 0); decoder.start()
            var inputEnded = false; var outputEnded = false
            var sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            var phase = 0L
            var idle = 0
            val pcm = java.io.ByteArrayOutputStream(32_000)
            var segmentBytes = 0
            val info = MediaCodec.BufferInfo()
            while (!outputEnded && !cancelled()) {
                if (!inputEnded) {
                    val index = decoder.dequeueInputBuffer(10_000)
                    if (index >= 0) {
                        val data = decoder.getInputBuffer(index)!!
                        val size = extractor.readSampleData(data, 0)
                        if (size < 0) { decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true }
                        else { decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0); extractor.advance() }
                    }
                }
                val index = decoder.dequeueOutputBuffer(info, 10_000)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val out = decoder.outputFormat
                    sampleRate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    check(!out.containsKey(MediaFormat.KEY_PCM_ENCODING) || out.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_16BIT) { "unsupported_audio" }
                } else if (index >= 0) {
                    idle = 0
                    val data = decoder.getOutputBuffer(index)!!.duplicate().order(java.nio.ByteOrder.LITTLE_ENDIAN)
                    data.position(info.offset); data.limit(info.offset + info.size)
                    while (data.remaining() >= channels * 2) {
                        var mono = 0
                        repeat(channels) { mono += data.short.toInt() }
                        mono /= channels
                        phase += 16_000
                        while (phase >= sampleRate) { pcm.write(mono and 255); pcm.write((mono shr 8) and 255); phase -= sampleRate }
                        if (pcm.size() >= 32_000) {
                            store.appendFrame(id, pcm.toByteArray()); segmentBytes += pcm.size(); pcm.reset()
                            if (segmentBytes >= 60 * 32_000) { store.finishFrames(id); segmentBytes = 0 }
                        }
                    }
                    outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    decoder.releaseOutputBuffer(index, false)
                } else check(++idle < 5_000) { "unsupported_audio" }
            }
            check(!cancelled()) { "cancelled" }
            if (pcm.size() > 0) store.appendFrame(id, pcm.toByteArray())
            store.finishFrames(id)
        } finally { runCatching { decoder.stop() }; decoder.release() }
    }
}
