# Information architecture: Asael companion

**Implementation structure, 3 October 2026.** Current URLs remain compatible; new URLs below remain planned additions. ATLAS is selected. Implementation is authorized after the operational follow-ups, and current work is preparation only. Route definitions remain unchanged at `origin/main` `89f65c2f`.

## Navigation model

Use five everyday destinations on desktop: **Assistant, Work, Activity, Memory, Capabilities**. Global Capture, Search and Voice are actions, not three more competing workspaces. A More menu and searchable navigation expose Accounts, Meetings, Markets, Agents, Results and Payments. Settings and Administration remain explicit utilities, with permission-aware access.

On phones, use Assistant, Work, Capture, Activity and More as the five primary anchors. Memory and Capabilities are one step into More. Keep labels visible. Native macOS uses the same conceptual grouping in its labelled sidebar rather than copying the mobile bottom bar.

Activity is the human-facing account of work. Monitoring remains the technical health/incident domain. Customer Accounts are not connection accounts. Library is a view of source files, captures and outputs within Memory/Work, not a new storage subsystem.

## Site map and URL strategy

| Area | Canonical entry and views | Compatibility |
|---|---|---|
| Assistant | Existing /app/command; primary conversation, history, context, results and voice overlay | Preserve agent, run, thread, mission, project, context and prompt query bindings; do not place sensitive new content in URLs |
| Today | Existing /app; brief, priorities, reminders, agenda | Retain as a named secondary view. Returning-user default can prefer Assistant through a persisted preference; do not silently remove Today data/actions |
| Work | Existing /app/projects; overview, execution, build; linked Results | Preserve view, project, artifact and work links. Goals are an outcome-oriented projection of existing work, not a new task ledger |
| Ongoing responsibilities | Proposed /app/responsibilities and /app/responsibilities/[id], grouped under Work | New contract and capability; existing schedules remain in Capabilities. Offer a clear link between responsibility and its procedure/runs |
| Activity | Proposed /app/activity with Working, Needs you, Updates and History filters | Aggregate safe run progress, approvals and delivery evidence. Existing /app/approvals and notification deep links still work |
| Memory and Library | Existing /app/memory with remembered facts, knowledge/sources and files views | Preserve existing memory subviews and APIs. Source files, citations and outputs retain their canonical identities |
| Capabilities | Existing /app/automation | Preserve overview/automations/skills/connections/plugins/advanced and compatible /app/workflows, /app/connectors, /app/tools entries; existing query value `plugins` is labelled Extensions in the UI |
| Specialist work | Existing meetings, accounts, markets, agents, payments and results routes | Discoverable through More, search, pinned shortcuts and contextual links |
| Administration | Existing evaluations, observability, security, settings routes | Keep safe status summaries readable and detailed operator controls behind role-aware navigation |
| Access/public/lifecycle | All current public, login, redirect, demo and offline routes | Visual consistency without enabling public signup or exposing private data |

Existing aliases must map an allowlisted set of supported query parameters, selected entity and return destination. Do not forward arbitrary strings or silently discard required context. The current web mission list is already an alias except its explicit legacy view; mission detail/history remains reachable until its own parity/removal gate is met. Native has different path shapes; use an explicit deep-link mapping rather than string substitution.

## Content priority

- **Assistant:** conversation and composer → immediate decision/result → compact actual activity → history/context/evidence on demand. ATLAS shrinks after the first interaction.
- **Work:** next action and outcome → progress/blocker → tasks and evidence → controls/history → technical receipts.
- **Activity:** action required and urgency → plain-language progress/change → original work/conversation link → evidence and resolved history.
- **Memory:** remembered claim or source → provenance and freshness → use/scope → correction/forget/re-index controls.
- **Capabilities:** what is usable and needs attention → connection/skill/automation selection → exact configuration/version/permissions → advanced tools and operations.
- **Operational pages:** focused list/table → selected detail → relevant action → audit history. Do not turn them into large mascot landing screens.

## Key flows

### Start, supervise and finish work

Open Assistant → type/speak/attach context → inspect selected source/model/target when relevant → send → queued or working state → optional clarification/approval → verified result inline → open evidence or continue. The same run can be opened from Work or Activity without losing its conversation.

### Voice

Activate voice → microphone permission and actual listening state → live transcription → editable review/send using the existing governed flow → response playback and interruption → switch to text with the same thread/context → end voice. Interrupting speech does not cancel a run or undo an effect. Device/network loss retains recoverable text and explains the next action.

### Ongoing responsibility

Describe the responsibility → review purpose, sources, cadence, duration, budget and notification rule → activate a bounded read-only watcher → retain accepted evidence and comparison history → send one meaningful update when justified → inspect evidence → pause/end from any linked surface. A proposed external action goes through its separate exact review.

### Memory correction

Open remembered fact/source from the response or Memory → inspect provenance and access scope → correct or request forgetting → preview affected record and confirm where required → durable result updates all linked surfaces. A saved source is not automatically a trusted claim.

### Capture and reuse

Capture note/file/audio, or a shared link as note text → see transfer/extraction/indexing states appropriate to the item → open the Library item → select exact file/version as conversation context → use it with evidence. Unsupported and partially indexed items remain visible with recovery actions. Arbitrary URL fetching/indexing is not implied by the current shared-link behavior.

### First-use and personalization

Private sign-in → optional protected setup sheet → select appearance, ATLAS intensity and voice output → connect only a source needed for a first task → complete that task. Preserve the existing signup/onboarding redirects; this is a proposed in-app setup experience, not new open registration.

## Terms

| Term | Meaning |
|---|---|
| Asael | Product and primary assistant identity |
| ATLAS | Selected original eagle companion; energetic quick wit and expressive timing. Presentation does not replace the versioned executing Agent, including the existing Supervisor named Atlas |
| Agent | Actual versioned specialist identity and executing principal context |
| Goal | A desired outcome presented from existing canonical work |
| Project | Finite durable work and its tasks/artifacts |
| Responsibility | New ongoing purpose spanning bounded checks and results |
| Automation | Reviewed repeatable procedure, trigger and run history |
| Activity | User-facing work, decisions and meaningful updates |
| Monitoring | Technical health, diagnostics and incidents |
| Library | Unified view over authorized files, source revisions, captures and outputs |
| Account | Customer/business account; connection accounts are labelled with their provider |

## Growing collections and continuity

Use search, filters, bounded pagination and archive/history views. Load graphs by bounded neighborhoods and expensive detail only when selected. Preserve selection, scroll and drafts on refresh, with stale indicators instead of empty resets. The server owns work and conversation state; platform preferences may choose a default destination but never create a competing ledger. Cross-device handoff restores the same thread/run/evidence references and independently checks current authorization.
