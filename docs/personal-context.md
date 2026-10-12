# About me

About me is an editable, owner-private profile shared by the web and native apps.
It records a name, role, ways of working, preferences, goals and interests. Each
non-empty field carries its source and update time. The saved view shows exactly
what is stored; edits remain drafts until saved. It starts empty and switched off.
The owner can enable it, update a field, clear a field or clear the whole profile.

This profile is separate from the Companion personality and from saved-memory
retrieval consent. Butler and Playful change delivery. About me supplies selected
personal facts. Neither grants access to a mailbox, a client's systems or a tool.
Personal automatic remains the existing explicitly consented memory-retrieval
mode, and merely enabling a profile does not turn it on.

## Conversation behaviour

Eligible authenticated foreground text runs read the profile fresh and attach it
as untrusted context. A new live voice call receives a bounded profile snapshot;
delegated voice requests reread the current profile through the ordinary agent
path. No profile is attached to background/delegated execution on this account's
behalf without that foreground boundary. A call already in progress can retain
what it previously received; changes apply to a new call and subsequent agent
requests. Clearing a profile cannot erase earlier conversation messages.

An enabled profile accompanies Conversation only, agent, project, workspace,
mission and Personal automatic context. No extra context, Current message only,
Reviewed saved context and an explicit reviewed selection lock exclude it. The
composer explains the distinction between the profile and durable memory.

The profile is descriptive context, never governing instructions. Current user
corrections take precedence. A profile-read outage must not become invented
familiarity: the turn continues without the optional profile, with an unavailable
receipt. Runtime receipts contain only inclusion state, revision, field names and
update time. They never contain the profile values.

## Persistence and control

`GET` and `PUT /api/personal-context/profile` require an authenticated session or
native owner. Writes use a revision and idempotency key; a delayed retry returns
the newest saved state and cannot restore removed facts. Owner hashes narrow
the signed-in identity. Tenant and actor RLS protect both profile and receipt
records. Clients clear private state when identity or deployment changes.

Migration 248 creates `omni_personal_profiles` for the current profile and
`omni_personal_profile_mutations` for content-free save receipts. Removed field
values are not copied into a profile history table. Existing database backup and
conversation retention still apply. No personal profile is bundled in source
code or in a native package.

## Work and connected sources

My CSM role remains the shared CSM playbook, supplied with the selected client's
separate context. The general profile can describe the owner's role without
mixing facts between clients. Client evidence remains subject to its existing
access, relevance and freshness checks.

Due Google connections receive a bounded maintenance pass independent of the
historical tenant cursor. Scheduling reads only connection metadata; actual sync
re-enters the tenant and owner scope and retains existing leases, permissions,
backoff, page bounds and source receipts. The pass has at most two tenant
candidates and one minute of the existing maintenance budget. Progress through a
mail backfill is reported as partial, not as a failure or complete coverage.
