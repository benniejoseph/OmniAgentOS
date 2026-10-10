# NeoSapien research and Asael mobile conversation memory

Researched 10 October 2026. Bennie selected **phone microphone first**. This document contains public-source research, a read-only assessment of Asael at revision `26b03ed5140ddb8b199505e84edc6e280e90f132`, and a proposed implementation. No NeoSapien hardware or account was used. No microphone was started, application code changed, tests or audits run, or release deployed for this research.

**Recommendation**

Build a mobile **Listen** experience that turns permitted conversations into useful, source-linked context for ATLAS. Begin with dependable meeting-length recording on the Samsung phone, including screen-lock continuation and offline saving. Extend that foundation to a day of automatically grouped conversations. Reuse Asael's existing recording processing, Knowledge retrieval, Work, and Today capabilities.

The product target is a continuous experience: start listening once, stay in the conversation, then find the important decisions, commitments, and context where they are useful. Recording everything indefinitely is not a useful definition of success. A forgotten task should become easier to recover; the user should not acquire another inbox full of irrelevant snippets.

**What NeoSapien publicly documents**

| Part | Verified description and qualification |
| --- | --- |
| Capture | Neo 1 pairs with the mobile app; active/sleep controls govern capture. The company advertises a 20g wearable, Bluetooth LE, about 2m pickup, and 2–3 days of battery. These are advertised specifications, not measurements made here. [Product page](https://neosapien.ai/shop), [homepage](https://neosapien.ai/) |
| Offline operation | Its FAQ says capture can continue without internet while the wearable remains connected to the phone; processing happens after connectivity returns. That does not establish standalone capture without the phone. [Product explanation](https://neosapien.ai/b/what-is-neosapien) |
| Phone microphone | iOS release 1.3.10 introduced App Mode on 24 July 2025, describing phone capture as a backup interrupted by calls/media. Android feature parity and unbundled account access are not established by that release note. [Developer release history](https://apps.apple.com/in/app/neosapien/id6740624306) |
| Memory editing and recall | The release history documents titles, participants, tags, filters, transcript corrections/custom vocabulary, linked source memories, scoped questions, merge/unmerge, AI rewriting, and broader multi-memory reasoning. [Developer release history](https://apps.apple.com/in/app/neosapien/id6740624306) |
| Follow-through | Extracted reminders, assignees/dates, calendar integration, Outlook, and configurable recap email appear in release notes. The homepage advertises daily and weekly summaries. [Release history](https://apps.apple.com/in/app/neosapien/id6740624306), [homepage](https://neosapien.ai/) |
| Other devices and AI | Its desktop page advertises laptop audio capture without a meeting bot, a unified timeline, and calendar events. The current download page lists macOS 14.2+ on Intel/Apple Silicon and Windows 10+, differing from an older FAQ. Its homepage advertises memories in ChatGPT/Claude; public integration details remain limited. [Desktop](https://neosapien.ai/desktop/), [homepage](https://neosapien.ai/) |
| Price | The live page showed a ₹11,699 promotion against ₹15,999 MRP. Although the shop promises no subscriptions, its terms reserve future subscription changes with notice and agreement. Do not treat a marketing lifetime promise as our own operating-cost model. [Shop](https://neosapien.ai/shop), [terms](https://neosapien.ai/terms) |

The publicly described operating chain is **capture → phone connection/buffering → transcription and cloud processing → conversation memories → recall and follow-ups**. NeoSapien does not publish enough technical detail to establish its exact models, segmentation thresholds, embedding/index design, retry strategy, or speaker-matching implementation. Its “infinite memory” wording is not evidence of unlimited context-window size, storage, or processing. I found no official evidence that it controls arbitrary phone apps in the way ATLAS is intended to.

**What actual use appears to involve**

A 10 September 2026 hands-on review describes four areas—Home, Ask Neo, Memories, and Reminders—plus voice enrolment. It reports cloud processing taking a few minutes, suggested reminders users can accept, and conversational breaks creating separate memories that can be merged. The reviewer found structured meetings more useful than all-day chatter, which required cleanup, and reported roughly a day's battery during continuous use. This is one reviewer's experience, not a performance guarantee. [91mobiles hands-on review](https://www.91mobiles.com/reviews/neosapien-neo1-review/amp/)

My design interpretation: the difficult part is selecting and organizing useful context. Asael should make corrections, regrouping, and deletion easy and avoid promoting every captured remark into permanent personal memory. The absence of manual note-taking should not be replaced by constant manual filing.

**Data handling and uncertainties**

NeoSapien's policy says raw audio is deleted after processing while transcripts/summaries remain; it describes cloud/AI providers, encryption in transit and at rest, international processing, conversation deletion, and no model training without opt-in. Encryption here is not a claim of end-to-end encryption against the processing service. Its wording about identifying only the user's voice sits awkwardly beside broader speaker-recognition marketing; the precise treatment of other participants' identities is not clear. Provider identities, operational guarantees, and processing limits are insufficiently documented for firm conclusions. [Privacy policy](https://neosapien.ai/policies)

For Asael, give the user separate, readable choices for audio retention, conversation deletion, and forgetting derived memories. If audio is deleted, preserve transcript citations and clearly remove the playback affordance. Do not imply that deleting a memory automatically deletes its original source unless the deletion flow actually does that.

**Where Asael stands today**

These findings describe code, not fresh production verification.

| Capability | Existing implementation | Work needed |
| --- | --- | --- |
| Phone recording | Short 16kHz mono WAV notes default to two minutes; the limit discards unfinished recording. Attachments have a 5MB cap. [Recorder](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/apps/flutter/lib/features/capture/capture_recording.dart:363), [limits](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/apps/flutter/lib/features/capture/capture_models.dart:5) | A dedicated long recorder that finalizes durable chunks continuously. Simply lifting the timer does not repair its lifecycle. |
| Recording with screen locked | The existing Android voice/control lease expires at 30 minutes and stops on screen-off/lock. [Bridge](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/apps/flutter/android/app/src/main/kotlin/app/omniagent/omniagent/AndroidDeviceBridge.kt:80) | A separate listening service/session. Preserve the stricter phone-control lock boundary. |
| Long-recording backend | Web recording uploads chunks; server bounds include 1,440 segments and 24h/1GB. These limits do not prove continuous recording reliability. [Web recorder](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/components/capture/long-recording-studio.tsx:396), [recordings](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/capture/recordings.ts:43) | Native create/upload/complete/read/delete contracts and mobile integration. Current native support processes an already-linked recording. |
| Offline saving | Encrypted draft outbox exists, limited to 25 attachments/64MB and explicit retry/sync. [Outbox](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/apps/flutter/lib/features/capture/capture_outbox.dart:15) | A larger recording spool with per-chunk acknowledgements, resumable upload, storage limits, and duplicate prevention. |
| Transcripts and speakers | Server transcription provides timestamped speaker turns. Speaker mappings require confirmation, but merging independent chunks by the same label does not prove that the same person spoke. [Transcription](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/capture/transcription.ts:94), [merge](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/capture/media-jobs.ts:470) | Stable speaker handling across chunks, uncertain identity labels, and correction propagation. Voice identity must not be guessed from “Speaker 1.” |
| Notes and follow-ups | Structured summaries, chapters, actions, and decisions have transcript citations. Extraction currently takes only the first 1,200 turns/500KB. [Extraction](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/capture/media-extraction.ts:279) | Process every window, then merge with coverage accounting. An all-day summary must not silently ignore the end of the day. |
| Useful mobile evidence | Meetings already shows notes, turns, and review controls. Its citation widget lacks source-audio playback and exposes turn IDs. [Mobile detail](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/apps/flutter/lib/features/meetings/meetings_detail_body.dart:606) | “Listen at 12:34,” readable people/client labels, and corrected transcript handling. |
| Work and ATLAS context | Meetings can link projects; commands include selected CSM client and role notes. Processed material becomes searchable Knowledge. [Context](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/command/context-reference-runtime.ts:139), [Knowledge ingestion](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/capture/media-jobs.ts:396) | Reviewable client linking, personal/work boundaries, conversation filters, and promotion of supported facts into durable memory. Searchable text alone is not a complete memory system. |
| Today | Briefs, tasks, meetings, and commitments already exist. [Brief](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/today/briefs.ts:548) | Recent conversation takeaways, unresolved promises, and relevant pre-meeting context. |
| Imports and retention | File import exists; Android share-sheet intake does not. Native recording processing currently fixes retention to retain. Scheduled audio expiry was not found. [Manifest](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/apps/flutter/android/app/src/main/AndroidManifest.xml:44), [retention contract](/Users/benniejoseph/.codex/worktrees/web-search-reliability/OmniAgent/src/lib/capture/meeting-recording-native-contracts.ts:34) | Large-media/shared-file intake, selectable retention, expiry execution, and clear deletion of sources versus derived memory. |

**Proposed phone experience**

Use two clear entry points: **Talk to ATLAS** for a live conversation with the agent and **Listen** for capturing real-world context. A compact recording strip should show the actual capture state, elapsed time, and chosen context. Pause and Stop must remain available from the phone notification.

Before starting, choose **Personal** or a **Work client**. Make a title optional. For spontaneous conversation, allow “Choose later” and offer a suggested client afterward. Never silently file ambiguous material into another client's context.

After a conversation, show a readable card: what was discussed, decisions, promises, open questions, and suggested next steps. Let the user rename it, correct names, change its client, merge/split conversations, and delete it. Suggested tasks should show the person, due date if actually stated, and the supporting sentence. A missing due date remains missing.

The user should be able to ask:

- “What did I promise this client last week?”
- “What changed since the previous meeting?”
- “Which follow-ups are still waiting on me?”
- “Prepare me for tomorrow's client call.”
- “Find the idea I mentioned on my walk.”

Answers should cite the conversation and relevant time. ATLAS should retrieve the relevant sources for each question; stuffing every transcript into every prompt would be expensive, distracting, and poor isolation between clients.

**Proposed architecture — this is our design, not a claim about NeoSapien's internals**

```mermaid
flowchart LR
    A[Start Listen on phone] --> B[Native recording service]
    B --> C[Encrypted audio chunks]
    C --> D[Durable upload queue]
    D --> E[Transcript and speaker turns]
    E --> F[Conversation notes and cited commitments]
    F --> G[Personal or client Knowledge]
    G --> H[ATLAS recall and Today]
    H --> I[Reviewed tasks and governed actions]
```

1. **Capture independently of the screen.** Kotlin owns the recording session, file rotation, interruption callbacks, and visible controls. Flutter observes state through a typed bridge. Closing a widget must not lose a meeting.
2. **Save before relying on the network.** Each chunk gets a stable session/sequence identity, timing, checksum, and upload acknowledgement. App restart resumes saved uploads without duplicating conversations. Disk pressure produces an explicit warning or stop, never silent loss.
3. **Detect speech and group conversations.** Lightweight local speech detection reduces silence sent for transcription. Physical audio chunks and meaningful conversations are different objects. Silence, context, time, and user boundaries can propose groups; merge/split remains reversible. Exact thresholds require tuning.
4. **Process the whole session.** Extract notes from every window and combine them using source references. Track which intervals are processed, skipped, interrupted, or failed. Resolve speaker identity conservatively and let corrections update downstream notes.
5. **Keep three layers of context.** Preserve the conversation as evidence; create a concise conversation summary; separately promote useful, supported facts/preferences/commitments into memory. Contradictions retain dates and evidence. A one-off comment must not become a permanent preference automatically.
6. **Connect actions deliberately.** Conversation statements can suggest tasks. Explicit commands to ATLAS use the governed executor. A participant saying “send this to everyone” during a meeting is recorded content, not permission for an agent to send messages.

Microphone ownership also needs coordination: ambient capture and live ATLAS voice should not run competing recorders. For the initial release, pause listening during a live voice session and resume according to the user's session setting. Exclude ATLAS's synthesized replies from captured customer context.

**Android feasibility and limits**

A user-started microphone foreground service can continue recording in the background, including with the screen locked. Android imposes start-time microphone eligibility and background-start rules; ordinary apps cannot automatically start this service from boot. Sideloading does not remove those restrictions. [Service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [background-start rules](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)

Calls and competing apps can interrupt or silence microphone input. Capturing actual call uplink/downlink is not an ordinary third-party permission. Other-app playback capture is a separate, user-approved mechanism with restrictions imposed by the originating app; it is not universal meeting/call recording. [Audio input sharing](https://developer.android.com/media/platform/sharing-audio-input), [playback capture](https://developer.android.com/media/platform/av-capture)

Provide a visible recording notification and honest interruption messages. On Android 13+, notification permission affects whether foreground-service controls appear in the notification drawer. On Android 16, upload jobs still face scheduling quotas, so recording must not depend on repeated background-job restarts. [Notifications](https://developer.android.com/develop/ui/compose/notifications/notification-permission), [Android 16 changes](https://developer.android.com/develop/background-work/services/fgs/changes)

The first scope should cover room conversations and spoken notes that the phone can hear. For meetings conducted inside restricted work apps, retain transcript/document import and approved desktop capture as separate input routes. Use only work material and meetings the user is permitted to capture; Salesforce org connectivity is not required for this design.

**How this becomes useful for Bennie's CSM role**

Suppose a client says adoption is blocked by incomplete enablement, a colleague will arrange a specialist session, and Bennie promises to share a Success Path draft. The conversation should produce three separate things: a client concern with evidence, a colleague-owned follow-up, and Bennie's commitment. It should not turn all three into tasks assigned to Bennie.

That client concern belongs with the client's goals, previous discussions, documents, and stakeholders. The agent's interpretation should also use Bennie's maintained role context: secondary or lead CSM, advocacy, coordination, and the resources he can involve. Role context remains distinct from client facts.

Before the next call, Today could show the unresolved commitment, what changed since the previous meeting, and two useful questions. ATLAS could draft the follow-up or prepare research when asked. External sending retains the application's existing approval rules. Personal conversations use the same capture flow but remain in their own context.

**Cost and retention choices**

Use the realtime voice model for talking with ATLAS. Ambient listening should use local recording, selective transcription, and batched extraction rather than a live reasoning session all day.

At a proposed 24 kbps audio bitrate, the audio payload is approximately 10.8MB/hour or 86.4MB over eight hours. At 16kHz mono 16-bit PCM, it is approximately 115.2MB/hour before overhead. These are arithmetic estimates, not measurements or a guarantee that a particular compression setting preserves transcription quality.

Track speech minutes processed, remaining queued minutes, storage, and actual model usage. Transcription cost depends on processed minutes; note generation and recall depend on model calls and retrieved context. Report measured cost after the first real session before setting an all-day budget.

Proposed default: retain audio only for a short, clearly selected review period, with “Keep this recording” for exceptions. Implement expiry before promising it. Provide local-only queued status while offline; cloud recall and summaries require processing unless a separate local inference capability is built. Deleting a conversation must invalidate derived search entries and memory references according to the displayed deletion scope.

**Delivery sequence**

| Stage | Concrete result | Condition to move forward |
| --- | --- | --- |
| 1. A dependable recorded conversation | Phone start/pause/stop, screen-lock continuation, durable offline chunks, native upload contracts, summary/actions, client linking, transcript citations, selected retention | Complete a normal meeting and recover its recording through a network interruption; no dropped tail or fabricated completion. |
| 2. Useful memory throughout the day | Automatic conversation grouping, merge/split, vocabulary corrections, cross-chunk speaker handling, whole-session extraction, useful-fact promotion, interruption reporting | The first and last conversations are represented accurately; repeated processing does not create duplicate tasks or memories. |
| 3. Proactive ATLAS | Daily recap, unresolved commitments, pre-meeting briefs, evidence-backed follow-up drafting, imports/share-sheet support, cross-device continuity | Relevant context appears for the correct client and actions retain their intended approval boundaries. |

These are implementation milestones and later focused live acceptance checks, not tests run during this research. Begin with Stage 1; extending the existing two-minute recorder alone would leave the important reliability and context problems unresolved. A credible all-day battery/latency estimate requires a working build on this Samsung first.

The main remaining product decisions are the audio-review retention period, how aggressively useful facts are promoted into memory, and whether new follow-ups enter a review inbox or are created automatically as drafts. These do not prevent beginning the capture foundation. The user's device choice is already resolved: **phone microphone first**.
