# Credential broker v3 migration design

Status: proposed migration, not implemented or deployed. The principal reliability
repair leaves the installed v2 broker, its frozen signature and existing Keychain
ACLs unchanged.

## Current boundary and remaining exposure

The private owner-Mac package freezes the separately signed v2 credential broker
so a host-app rebuild does not change the identity that owns existing Keychain
rows. The v2 manifest freezes a signature without the Hardened Runtime. As
recorded in [ADR 012](adr/012-macos-client.md), that leaves a same-user dynamic
library injection path in the credential process. The host now serializes
owner/session incarnations and rejects stale credential requests before dispatch
and stale responses on return. Those checks prevent multi-window lifecycle races;
they do not harden the old broker against injected code.

Re-signing v2 in place would change its code identity and can break access to the
old rows. Preserving those rows indefinitely alongside a hardened replacement
would also preserve the old exposure. Neither is an acceptable migration plan.

## Transition protocol

1. Build v3 under a new bundle identity and a new Keychain service namespace. Sign
   it with Hardened Runtime and library validation enabled, without the host's
   library-validation exception, debug entitlement, or unsigned executable-memory
   entitlement. Freeze and verify the resulting artifact separately. The v3
   manifest must fail packaging if its runtime flag or designated requirement is
   missing. No production signing key or installed broker changes are needed to
   develop its protocol against isolated synthetic Keychain rows.
2. Use the already frozen v2 executable solely as the old-ACL reader during a
   user-visible migration transaction. Verify its expected bytes/designated
   requirement and strip the launch environment. Do not modify its signature.
   The bridge accepts only the exact allowlisted key names and bounded values;
   never enumerate or copy another application's Keychain entries. Keep secret
   values in process memory and anonymous child pipes, with no logs or temporary
   credential files.
3. Snapshot the authoritative server device/session revocation state and the
   native process incarnation, stop credential mutations for the duration, and
   bind the transaction to the exact owner, installation ID, old store identity,
   and new namespace. Refuse account switching and session writes until the
   transaction commits or is explicitly abandoned. A lock must hide all engines
   without letting a stale unlock complete migration. Remote wipe takes priority.
4. Read only the allowed existing values through v2. Write them through v3 into
   a transaction namespace, then independently read back and compare every
   present value and every expected absence. In particular, verify the capture
   and offline-projection encryption keys by opening an isolated saved ciphertext
   fixture with the migrated key. A fresh login alone is not sufficient evidence
   that encrypted local work survived migration.
5. Publish a durable, versioned cutover marker containing only transaction IDs,
   owner/store fingerprints, exact key inventory, and phases. The marker contains
   no secret bytes or reversible secret representations. Commit only after
   server revocation revalidation and complete readback. Every Flutter engine
   must then select v3; v2 is no longer an ordinary credential fallback.
6. Delete the corresponding old rows through their original v2 identity. Confirm
   each absence with a v2 read, record cleanup receipts, and leave interrupted
   cleanup resumable and visible. Retire the old executable after verified
   cleanup. A cutover whose old secrets still exist is a pending migration, not a
   completed security repair.

## Rollback and interrupted operation

Before cutover, v2 remains the authoritative store. Failed v3 readback deletes
only the incomplete v3 transaction and keeps v2 unchanged. A crash must resume
from the durable phase and compare the exact inventory again; it must not copy
an old snapshot over newer credentials.

After cutover, a client rollback must remain able to use v3. Keep a signed host
rollback package that understands the new marker and v3 namespace before retiring
v2. Do not repopulate v2 as a convenience fallback. If cutover succeeds but old-row
cleanup fails, keep v3 authoritative, retain the cleanup transaction, and expose
that the old exposure remains until cleanup is verified.

A sign-out or remote wipe writes a revocation tombstone that dominates every
migration phase. Recovery must never restore a deleted session, device ID,
encryption key or grant from a pre-wipe snapshot. If authority cannot be
re-established, require a new login and quarantine any encrypted local work whose
key provenance cannot be proven. Never report remote wipe complete before the
old and new namespaces and any transaction staging are erased and read back.

## Required evidence before a separate release

- A real ACL transition using the unchanged v2 binary and independently signed
  hardened v3 against a disposable Keychain with synthetic credentials, under the
  same signing-identity class as the private package. A mock key-value store does
  not establish that macOS will permit the old reads or new access.
- Signature inspection proving runtime and library validation; a bounded
  environment-injection test against the disposable broker that cannot read or
  modify installed credentials.
- Successful exact migration/readback and encrypted-outbox reopening; absent-key,
  conflicting-owner, corrupt-value, unexpected-key, permission-denied and locked
  Keychain scenarios.
- Fault injection after every phase, including after each row write/delete and
  before/after marker publication. Verify idempotent resume and retained originals
  before commit, plus no fallback after commit.
- Simultaneous auxiliary engines, refresh, sign-out, account replacement, system
  lock, process termination and remote wipe; prove stale operations cannot
  publish or resurrect secrets in either namespace.
- Rollback rehearsal with the actual signed fallback host, before and after old
  rows are cleaned. Neither rollback may reopen a revoked session.
- Successful authenticated owner-session use on the candidate, then confirmed
  absence of all copied old rows and retirement of the v2 executable. Only this
  final state closes the recorded exposure.

The current reliability release deliberately does not claim these proofs. It can
ship independently while v3 is developed and rehearsed as its own credential
migration, with the existing owner approval and release process applied to its
concrete signed candidate.
