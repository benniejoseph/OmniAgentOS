# Native MCP rediscovery protocol v1

Protocol freeze for the implementation on accepted PR75/main `e69d6a53c4d7320d7043f589d99b4db62cb1a7c1`. This document defines the new slice; it does not claim implementation, validation or rollout completion. Native contract 46, schema 243 and Mac68 remain subject to root integration. Existing v40–v45 wire meanings and browser discovery behavior remain unchanged.

## User boundary

One visibly confirmed attempt discovers the complete catalog of one existing **disabled**, supported Streamable HTTP MCP connector. All existing MCP auth modes are supported: `none`, current deployer-bound `bearer_env`, and configured/origin-matched `bearer_vault`. Admission and publication require current management authority and the complete original connector/configuration/credential/catalog/policy pin. The endpoint and resolved credentials remain server-side.

Success atomically replaces the complete catalog, retains disabled status and credential version, preserves policy for unchanged contracts, holds changed/new contracts as `pending_review`, and removes disappeared tools. Zero tools is a valid completed empty catalog. More than 200 tools, duplicate/non-round-trippable tool identities, retired tools, or an unreviewable complete projection reject the entire result without changing the previous catalog. No tool call, activation, policy reset, GitHub upgrade or credential change is included. MCP initialize/list/SSE/session termination may contact the provider; one attempt does not mean one HTTP request or no provider-side logging/billing.

## Routes, service receipts and transport

All responses use the existing literal `asael-connector-control-read:1`, exact `ConnectorNativeScope`, private/no-store HTTP headers and a strict service receipt. No operation accepts a Future union. Existing exact `GET /api/connectors/native/mcp/{id}/review` is reused unchanged.

| Route | Service operation | Receipt action / access mode | NativePaths symbol |
|---|---|---|---|
| `POST /api/connectors/native/mcp-discoveries` | `app.connectors.native.mcpDiscoveries.submit` | `manage.connector` / `mutation` | `connectorsNativeMcpDiscoveriesSubmit` |
| `GET /api/connectors/native/mcp-discoveries/{keySha256}` | `app.connectors.native.mcpDiscoveries.read` | `read` / `read` | `connectorsNativeMcpDiscoveriesRead(keySha256)` |
| `POST /api/connectors/native/mcp-discoveries/{keySha256}/close` | `app.connectors.native.mcpDiscoveries.close` | `read` / `mutation` | `connectorsNativeMcpDiscoveriesClose(keySha256)` |

Capability is `connectors.mcp.discover`, prospective floor 46. Receipt resource type is `connector_native_discovery`. Both mutation receipts use `connector-native-mcp-discovery-events.v1`; GET uses `read_only:no_domain_mutation`. Submit execution purpose is `api.connectors.native.mcp_discovery`; close purpose is `api.connectors.native.mcp_discovery_close`; both bind causation to the original connector ID. Close is exact active original-owner cleanup and remains possible after management permission loss; it cannot publish or undo a catalog. GET requires current exact active owner access but no mutation execution scope.

Submit has `maxDuration = 60`, one-shot client timeout 55 seconds and a durable database-clock attempt deadline exactly 45,000 ms after admission. No automatic POST retry. JSON submit limit is 8,192 UTF-8 bytes; close limit is 16,384 bytes. Both require the original bounded Idempotency-Key. GET never fetches the provider, mutates state or expires a row.

Submit/close response: `{contract, scope, discovery, replayed, serviceReceipt}`. GET response: `{contract, scope, discovery: DiscoveryRead|null, serviceReceipt}`. `resourceCount` is 1 for evidence and 0 for null. Outcome SHA binds the entire envelope excluding serviceReceipt. Mutation receipt key digest must equal `discovery.intent.keySha256`; all receipt scope/authority bindings use the accepted v45 conventions.

## Exact public schemas

Every object is strict. `Scope`, `Pin`, `Sha`, `Id`, canonical JSON and instant syntax are the existing connector-native primitives. Key digest is the existing tenant-bound `connectorNativeKeySha256(scope,key)`. Safe intent contains no endpoint, credential, tool names, schemas, provider instructions or exception text.

```text
DiscoveryRequest = {
  contract: "asael-connector-lifecycle-action:1",
  kind: "mcp", connectorId: Id, action: "discover", review: Pin, preview: null
}
# review.kind == "mcp"; review.connectorId == connectorId

DiscoveryIntent = {
  contract: "asael-connector-action-intent:1", scope: Scope,
  keySha256: Sha, request: DiscoveryRequest
}

DiscoveryAttempt = {
  contract: "asael-mcp-discovery-attempt:1",
  id: "mcp-discovery-attempt:" + Sha,
  scope: Scope, keySha256: Sha, intentSha256: Sha,
  kind: "mcp", connectorId: Id, reviewSha256: Sha,
  startedAt: Instant, expiresAt: Instant, attemptSha256: Sha
}
# id suffix = canonicalJsonSha256({family:"mcp-discovery-attempt:1",scope,keySha256})
# intentSha256 = canonicalJsonSha256(original intent)
# reviewSha256 = original request.review.reviewSha256
# expiresAt - startedAt == 45000; attemptSha256 hashes all other attempt fields

DiscoverySettlement = {
  contract: "asael-mcp-discovery-settlement:1",
  attemptId: DiscoveryAttempt.id, attemptSha256: Sha,
  settledAt: Instant, result: CompleteResult|FailedResult, settlementSha256: Sha
}
CompleteResult = {
  status: "complete", kind: "mcp", connectorId: Id,
  connectorStatus: "disabled", contractCount: Integer[0..200],
  pendingCount: Integer[0..contractCount], credentialVersion: NonnegativeInteger,
  review: Pin
}
# credentialVersion == original review.credentialVersion == result.review.credentialVersion
# result.review binds exact persisted prospective connector/catalog/configuration
# settledAt >= startedAt and, for complete only, settledAt < expiresAt
FailedResult = {
  status: "failed", kind: "mcp", connectorId: Id,
  failureCode: "discovery_failed"|"catalog_unreviewable"|"target_changed"|"deadline_exceeded"
}
# Failure makes no claim about current catalog/state. No raw exception message.
# settlementSha256 hashes all other settlement fields.

DiscoveryClosure = {
  contract: "asael-mcp-discovery-closure:1", scope: Scope,
  keySha256: Sha, intentSha256: Sha,
  attemptId: DiscoveryAttempt.id|null, attemptSha256: Sha|null,
  closedAt: Instant, closureSha256: Sha
}
# Both attempt fields null together only for a genuine absent-key tombstone.
# Otherwise they equal the one admitted attempt; closedAt >= startedAt.
# closureSha256 hashes all other closure fields.

DiscoveryRead =
  {state:"pending", intent:DiscoveryIntent, attempt:DiscoveryAttempt}
| {state:"expired", intent:DiscoveryIntent, attempt:DiscoveryAttempt}
| {state:"settled", intent:DiscoveryIntent, attempt:DiscoveryAttempt,
   settlement:DiscoverySettlement}
| {state:"closed", intent:DiscoveryIntent, attempt:DiscoveryAttempt|null,
   closure:DiscoveryClosure}

DiscoveryCloseRequest = {
  contract:"asael-mcp-discovery-close:1", intent:DiscoveryIntent
}
```

Every read branch binds identical scope/key/target/intent/attempt evidence. Settlement and closure are immutable. `expired` is only a read projection of an admitted pending attempt; it is not a settlement or authority to start another attempt. Close responses are only `closed` or the original `settled` branch if publication won the serialization race. Repeating a visibly reconfirmed close with the same original intent/key is allowed, including after a lost close response; it never redispatches discovery. Unknown/null never grants successor authority.

## Durable transitions and publication fence

Use a dedicated `omni_native_mcp_discoveries` family with owner-private forced RLS and immutable tenant/owner/canonical/key/request identity; do not broaden old action/receipt parsers. One pending reservation per tenant/connector (not per actor) prevents overlapping native attempts. Persist a private random publication token with the admitted attempt; never include it in public evidence. Native family IDs/key space are explicitly separate from old connector-action rows.

- Absent + admitted submit → `pending`: validate active current manager, exact supported disabled connector and full review pin under parent/contract/credential locks; validate current environment binding without a provider request. Reserve row/token/deadline and event atomically. The transaction must commit before discovery starts.
- Same key + identical intent → return original branch with `replayed:true` before any provider work; a different intent is 409. Absent + another pending target reservation is 409, including after logical expiry. No successor automatically retires another attempt.
- Provider discovery runs outside database locks using the remaining absolute attempt budget. DNS admission, initialize/list pagination, body/schema bounds and cleanup retain accepted protections. Browser callers keep their existing behavior through an optional deadline seam. No background worker/resume/refetch is added.
- Publication → `settled`: reacquire the same reservation and target locks, require pending state/private token, current authority, the complete original pin, applicable current credential/binding and a live database-clock deadline. Normalize/preflight the entire prospective policy-preserving catalog and exact native review (0–200 tools; existing 1,048,576-byte complete native projection limit; the MCP client separately limits aggregate discovery schemas to 1,000,000 bytes). Persist connector metadata/catalog, domain event, settlement and native event in one transaction. Connector remains disabled. Never call the browser error-state writer.
- Known provider/unreviewable/deadline/target-drift failure → immutable failed settlement with no connector/catalog writes, only while original-owner/current mutation authority remains valid. Authority loss leaves pending/expired evidence and requires explicit owner close; it is not a fabricated successful cancellation.
- Pending + exact close → `closed`, atomically clear publication token and release the target reservation. Absent + exact close → permanent closed tombstone with `attempt:null`. A delayed original submit/publication can never reopen either form.
- Settled + close → unchanged settled result, `replayed:true`; close never reverses a catalog. Closed + same submit/close → original closed result. Terminal entries cannot be deleted/reopened by app or maintenance roles. A new attempt after durable terminal evidence requires a fresh exact review and a new visible confirmation/key.

The attempt key lock precedes the target lock consistently for submit/publication/close; the partial unique pending-target reservation is a final cross-owner guard. Expired reservations remain until explicit close. A removed/inactive original owner has no cleanup authority: resolving that account/membership state uses existing administration; the protocol must not silently steal another owner's pending attempt.

## Implementation exports and native handshake

Domain module: `src/lib/connectors/native-mcp-discovery-contracts.ts`. Exports `connectorNativeMcpDiscovery{Request,Intent,Attempt,Settlement,Closure,Read,CloseRead,CloseRequest}Schema`, corresponding `ConnectorNativeMcpDiscovery*` types, `buildConnectorNativeMcpDiscoveryIntent(scope,key,request)`, `connectorNativeMcpDiscoveryAttemptId(scope,keySha256)`, and `canDiscoverNativeMcpConnector(review)` (UI eligibility only; server binding/authority remains definitive).

Store module: `src/lib/connectors/native-mcp-discovery-store.ts`. Exports `submitNativeMcpDiscovery({authority,request,idempotencyKey}) -> {discovery:DiscoveryRead,replayed}`, `readNativeMcpDiscovery(authority,keySha256) -> DiscoveryRead|null`, and `closeNativeMcpDiscovery({authority,request,idempotencyKey,keySha256}) -> {discovery:ClosedRead|SettledRead,replayed}`.

Native owns six `connector_mcp_discovery_*` modules and small entry/handoff changes. Persist only original safe intent, exact compact evidence and durable submit/close markers under a separate API/tenant/canonical-owner/device-scoped protected slot with whole-record CAS. Revalidate current visible authority and the exact disabled review immediately before the one-shot submit marker/dispatch. After possible dispatch, recover by exact GET; only an explicit close can fence an uncertain attempt. Hide/replacement/lock clears live schemas/reviews and cannot imply server cancellation. Completion returns directly to original `('mcp', connectorId)` exact review even if the target is absent from the first inventory page. Accepted review promotion still activates the connector and must say so; rediscovery does not.

Fixtures must cover none/version0 and vault/existing-version, pending/expired, zero/nonzero success, each static failure, admitted close, absent-key tombstone and settled-wins-close. Focused validation covers competing owners/windows, late publication after close or drift, current authority loss, forced-RLS role isolation, domain/native event rollback, full catalog bounds/policy preservation, strict TS↔Dart digests and hidden/CAS lifecycle. No live provider request is required for local proof.
