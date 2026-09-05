# ADR 007: Tenant-scoped object storage plane

Status: Accepted · 2026-09-05

## Context

Postgres is the durable authority for Asael's scoped records, but database bytes
do not provide the right cost, delivery, or resumability properties for large
files, recordings, images, audio, video, and derived assets. Existing database
bytes and local file fallback must remain readable until an additive migration
proves parity. Moving bytes must not weaken tenant, actor, lineage, retention,
or deletion guarantees.

## Decision

Store durable asset bytes outside Postgres in a private object store. Every
object uses an immutable, versioned key scoped by tenant and owner; a new byte
sequence creates a new key and never overwrites an existing object. Keys use
opaque identifiers and must not contain credentials or private content.

Postgres remains authoritative for asset identity, tenant and owner, checksum,
size, media type, version, source revision and lineage, sensitivity and purpose,
retention, deletion or tombstone state, and the opaque storage locator. Object
existence alone is not a record, permission, or proof of current authority.
Delivery is authorized server-side and uses a short-lived, narrowly scoped
signed application URL redeemed through an authorized server proxy. The proxy
revalidates the current metadata and tombstone on every redemption before it
streams the object. Direct pre-signed bucket URLs are not exposed for governed
delivery, and object-store ACLs are never the application authorization model.

## Canonical authority and compatibility

The database metadata and lineage record decides which immutable object version
is current and whether it may be read. Authorization revalidates the exact
tenant, initiating actor, executing principal, purpose, and applicable grants
before upload or delivery. Backfill and cleanup also record their initiating
actor and executing principal; an internal job uses a named, actor-bound system
principal rather than omitting either coordinate. Correlation and purpose also
remain explicit. Existing Postgres bytes and file-backed assets remain
compatibility representations during migration and are never inferred to have
broader scope than their canonical metadata.

## Migration and cutover

Add the object plane and metadata bindings without changing served reads. Since
Postgres and an object store cannot share one transaction, candidate writes use
a staged-visibility protocol: a database transaction creates a pending metadata
record and transactional-outbox intent; an idempotent worker uploads bytes to an
inaccessible immutable candidate key; and a second database transaction verifies
the exact key, checksum, size, and intent before marking that version ready and
emitting its typed event/outbox record. Neither pending metadata nor an object
without a ready canonical binding can be served. Retries reuse the same intent
and content coordinates, while scoped reconciliation quarantines or removes
orphaned objects with receipts.

New assets are dual-written to the legacy representation and staged immutable
object version; historical bytes are copied by the same resumable, idempotent
protocol. Every candidate version must prove exact checksum and size parity
before it can enter a shadow read comparison. During that window, the adapter
can read both representations for parity while the legacy representation remains
authoritative for serving.

Cut over one persisted tenant rollout generation at a time only after complete
parity, authorization, signed-delivery, interruption, and deletion fixtures
pass. Keep the legacy bytes through the declared rollback window. Retiring or
garbage-collecting a formerly authoritative representation requires a later,
separately reviewed release after that window and must consult canonical lineage
and tombstones. Receipt-producing cleanup may remove only proven orphaned,
never-visible candidate objects before then. Privacy deletion is the exception:
once tombstoned, both legacy and object representations must be scrubbed within
the deletion SLA even though that permanently removes rollback for that asset.

## Rollback

Rollback switches the affected tenant to the legacy reader while preserving the
object copies, metadata, hashes, and audit evidence for diagnosis. It must not
restore a deleted version, relax authorization, or remove a tombstone. Failed or
orphaned object writes remain inaccessible until reconciled and are removed only
by a scoped, receipt-producing cleanup process. Tombstoned bytes remain subject
to the deletion SLA during rollback and are never retained merely for parity or
diagnosis.

## Permanent security floors

- Tenant, owner, initiating actor, executing principal, purpose, correlation,
  and applicable grants are explicit across uploads, delivery decisions,
  backfills, cleanup, metadata, and events.
- The bucket is private; public ACLs and guessable permanent URLs are forbidden.
- Bytes are immutable and integrity-checked before serving; derived assets
  inherit or narrow the source's permissions and retention.
- Signed delivery is short-lived, target-specific, and redeemed only through a
  revocable authorization hop that rechecks current server-side authorization
  and deletion state.
- A lineage tombstone is an immediate query and delivery barrier. Rollback,
  backfill, retry, restore, or re-upload cannot resurrect forgotten content.
- Credentials, encryption keys, and private object content do not enter object
  keys, ordinary events, logs, or model context.

## Consequences

Large assets can use scalable upload, download, and lifecycle facilities while
Postgres continues to provide transactional authority and lineage. The system
must operate dual representations during migration, reconcile incomplete
uploads and orphaned objects, include object manifests in backup and restore
procedures, and pay temporary dual-storage cost. Database restore alone is not a
complete asset restore; declared object versions and hashes must also verify.
