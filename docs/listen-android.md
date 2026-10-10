# Android conversation listening and nightly calls

## Using Listen

Open **Capture → Listen & conversations** on Android to record a conversation.
Choose Personal, Work or Choose later, and optionally select an existing client.
Start once, then use Pause, Resume or Finish in the app or recording notification.
Listen records conversations around the phone; ATLAS Voice remains the separate
two-way assistant conversation.

Open **Settings → Nightly call notes**, choose **Recordings → Call**, and approve
Android's folder request. Enable automatic processing to start with that day's
calls. **Check now** imports eligible new calls immediately; the daily check is
scheduled for 11:30 PM India time. No historical folder-wide import is implied.

Processed conversations appear in mobile and Mac Capture and in the web Capture
workspace's **Conversation notes**. Each has a transcript, summary, topic labels,
supported facts, relationships mentioned, decisions, open questions and follow-ups.
Follow-ups remain source notes with unconfirmed ownership clearly shown; they do
not silently assign every speaker's promise to the user or send messages.

Every transcript window is processed. Long sessions keep resumable extraction
checkpoints rather than summarising only the opening minutes. Private Knowledge
stores the conversation and a condensed, source-linked episode is saved in private
Memory for ATLAS retrieval. This does not turn quoted claims into verified personal
preferences. A selected Work client receives the existing private Library source;
failed client linking is shown in the notes without losing the conversation.

The first version removes uploaded processing audio after successful processing;
Samsung's original call files remain untouched. Citations open transcript evidence,
not retained cloud audio playback. Automatic conversation splitting, vocabulary
correction, editable task promotion and an all-day digest are later capabilities.

## Native implementation

Listen is separate from an ATLAS voice conversation and from phone control. A
user-started `ListenRecordingService` owns the microphone and its visible Pause,
Resume and Finish notification. Screen locking does not stop this recorder.
Starting ATLAS voice pauses Listen first; it remains paused until the user resumes.
Process death and reboot never silently restart the microphone.

The `app.omniagent.omniagent/listen` method channel and `/events` event channel
share a version-1 status snapshot. Flutter supplies only a separately revocable
Listen grant, never a login or refresh token. The encrypted grant is bound to
owner, tenant, actor, role, device and deployment origin. `clearOwner` removes
background authority and stops recording; it retains the previous owner's
encrypted queue in a separate partition. Ordinary screen or biometric locking
does not cancel the background processing the user enabled.

| Method | Arguments |
| --- | --- |
| `getStatus`, `requestPermissions` | none |
| `configureAccessGrant` | `ownerId`, `tenantId`, `actorId`, `role`, `deviceId`, `deploymentId`, optional `canonicalUserId`, `token`, `expiresAt`, `ingestUrl` |
| `clearOwner`, `chooseCallFolder`, `removeCallFolder` | none |
| `configureCalls` | `enabled`, `timeZone: Asia/Kolkata`, `hour: 23`, `minute: 30`, `contextCategory: personal/work/unfiled`, optional `projectId` |
| `scanCallsNow`, `uploadNow` | none |
| `startListen` | `title`, `contextCategory`, optional `projectId` |
| `pauseListen`, `resumeListen`, `stopListen` | none |
| `deleteLocalSession` | `sessionId` |

Status contains permission and access readiness, a nonsecret `scope`, folder
selection, nightly check status, `activeSession`, recent local sessions, queued
bytes and upload progress. Tokens and folder URIs are never included. Deleting a
local session removes the phone's queued copy and retains a deduplication
tombstone; cloud conversation deletion is a separate operation.

Audio is recorded at 16kHz mono PCM16. Each second is encrypted independently
using AndroidKeyStore AES-GCM and appended to an fsynced journal. Finalized
60-second WAV segments are independently decodable and below 3MB. A journal
identity prevents a crash between manifest persistence and journal removal from
duplicating the tail. A torn final frame is ignored; a microphone/process
interruption is shown explicitly. Uploaded chunks are removed locally only after
the server acknowledges their exact index and digest. The spool is capped at
512MiB and sessions at 24 hours / 1,440 segments. With no connection, PCM consumes
about 115MB per hour, so storage bounds normally stop offline listening after
roughly four hours. This is not an all-day offline recording guarantee.

The user grants read-only persistent access to the Samsung `Recordings/Call`
folder through Android's normal picker. No call-log, contacts, broad-storage or
privileged call-recording permission is requested. The first enabled check starts
at midnight that day in India time; later checks include missed and late calls
since enablement. Turning nightly checks off and back on starts at midnight on
the newly enabled day. Original recordings are never modified or deleted.

Files must have stopped changing for at least two minutes, retain the same size
and modification time through import, and match a digest not already imported or
deleted. Metadata receipts avoid repeatedly reading old audio. AAC recordings are
remuxed on sample boundaries into independent M4A chunks, retaining quality.
Other Android-supported audio codecs are decoded to 16kHz WAV. Temporary M4A
muxing files are bounded, app-private cache files removed immediately and swept
before the next scan after a process interruption; the durable spool is encrypted.
Unsupported audio remains in its original folder with a readable import message.

WorkManager schedules the nightly check from **11:30 PM Asia/Kolkata**. Android
may defer it for power, background quotas or device availability. This is
deferrable background work, not an exact alarm. Network-constrained upload retries
and server source/index/digest idempotency allow recovery without duplicate
conversations. HTTP 410 records a deletion tombstone; 401/403 suspends upload until
the user renews access. No background worker refreshes a broad account credential.

Platform references: [foreground microphone services](https://developer.android.com/develop/background-work/services/fgs/service-types),
[persistent folder access](https://developer.android.com/training/data-storage/shared/documents-files),
[WorkManager](https://developer.android.com/jetpack/androidx/releases/work), and
[MediaMuxer](https://developer.android.com/reference/android/media/MediaMuxer).
