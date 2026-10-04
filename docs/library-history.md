# Library history and current entity choices

Library history exposes retained immutable metadata through authenticated,
private/no-store GET routes:

- `/api/library/{id}/versions`: `limit` from 1–100, default 40. Continuing
  requires both the exact `before` version and its `currentVersionId` pin.
- `/api/library/{id}/versions/{versionId}`: one exact retained version, with
  an optional current-head pin.

Each read reauthorizes the current source and binds the historical row to its
owner, connection, adapter, provider item, permissions, purposes and retention.
Both the current and historical revision must remain readable. Changed head or
cursor authority returns 409 and requires a fresh read. Missing or inaccessible
history returns 404; failed reads remain unavailable rather than empty success.

Entries include exact source/revision/content hashes, timestamps, media type,
byte count and citations. `ordinal` is null because retained row counts do not
establish historical chronology. `coverageBasis` distinguishes compatible
retained revisions from sources exposing only their known current version.
List totals are unknown; the bounded page explicitly reports its continuation.

`contentAvailability: metadata_only` and
`historicalAttachmentAuthority: none` are deliberate limits. Immutable metadata
does not preserve deleted bytes. Capture transcript supersession removes old
Knowledge documents; retained source revision metadata is still inspectable
only under current Capture/source authority. Command attachments must resolve
the current Library selection again and cannot use a historical receipt as
attachment authority. Mission artifacts remain outside these history routes.

`GET /api/entities/options` is a separate actor-private current projection of
active person, organization, account and project entities. It accepts `limit`
from 1–100 (default 40) and one exact `after` ID. Scope/state/type filters run
before the limit plus one-row lookahead; C ordering keeps ID pagination stable.
It exposes full IDs and labels without aliases, history, lineage or mutation
authority. Every page rechecks current rows, so a retired entity disappears.
The development JSON fallback bounds its response after reading its existing
ledger; it does not claim bounded storage scanning.

These endpoints introduce no migration, native capability, provider operation
or automatic effect. Their web/native consumers and typed native publication
are separately delivered.
