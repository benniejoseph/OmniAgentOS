"""Exact synthetic Advanced Settings contracts. All application effects stay local.

The real isolated login/session is retained. No provider, push transport, archive
restore, Trash operation, Agent grant or secret issuance reaches the server.
"""
from collections import defaultdict, deque
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
from urllib.parse import parse_qs, quote, unquote, urlsplit
from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

LONG = "synthetic-full-identity-" + "longreference" * 15
PROVIDER = "provider:synthetic/exact+identity"
RETAINED = "provider:retained/" + LONG
KEY = "00000000-0000-4000-8000-000000000123"
TRASH_A = "trash:00000000-0000-4000-8000-000000000001"
TRASH_B = "trash:00000000-0000-4000-8000-000000000002"
SCOPES = ["mcp:discover", "mcp:tools:list"]
EVIDENCE = "Exact synthetic metadata <script>window.untrustedSettingsRan=true</script>\n" + LONG
SECTIONS = ["knowledge", "memories", "threads", "today", "projects", "connections", "skills", "agents", "assets"]


def canonical(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
def sha(value): return hashlib.sha256(canonical(value).encode()).hexdigest()
def sha_text(value): return hashlib.sha256(value.encode()).hexdigest()
def signed(body, name): return {**copy.deepcopy(body), name: sha(body)}
def path(prefix, identity, suffix=""): return "/api/" + prefix + "/" + quote(identity, safe="") + suffix
def now(): return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AdvancedSettingsFixtures(Fixtures):
    max_effects = 11

    def __init__(self, origin, session):
        super().__init__(origin)
        self.tenant, self.actor = session["context"]["tenantId"], session["context"]["actorId"]
        self.mode = "ready"
        self.plans, self.effects, self.held = defaultdict(deque), deque(), {}
        self.requests, self.releases, self.clipboard, self.local_downloads = [], [], [], []
        self.providers = [self.provider(), self.provider(RETAINED, "Retained provider " + LONG, owner="retained-actor", manageable=False), self.provider("provider:anthropic", "Synthetic Anthropic", provider="anthropic")]
        self.providers.append({**self.provider("provider:environment", "Deployment provider", provider="google"), "source": "deployment_environment", "manageable": False, "runtimeReadiness": "active_environment_fallback"})
        self.assignments = [self.assignment()]
        self.keys = [self.key("key:retained/" + LONG, "Retained service key " + LONG, manageable=False)]
        self.mcp = {"tenantId": self.tenant, "actorId": self.actor, "enabled": False, "serverName": "Synthetic MCP", "allowedScopes": SCOPES, "defaultApprovalMode": "governed", "exposeResources": False, "endpointPath": "/api/mcp", "readiness": "disabled", "createdAt": STAMP, "updatedAt": STAMP, "manageable": True}
        self.trash_items = [self.trash(TRASH_A, "Synthetic recoverable skill"), self.trash(TRASH_B, "Synthetic purgeable connector")]
        self.trash_original = {item["trashId"]: copy.deepcopy(item) for item in self.trash_items}
        self.targets = {"schemaVersion": 1, "registrations": [{"id": "registration:" + LONG, "deviceId": "device:" + LONG, "platform": "macos", "provider": "apns", "environment": "sandbox", "lastRegisteredAt": STAMP, "lastDeliveredAt": None}], "providers": {"apns": "configured", "fcm": "configuration_required"}}
        self.archive = self.portable_archive()
        tenant_segment = base64.urlsafe_b64encode(self.tenant.encode()).decode().rstrip("=")
        self.token = "asael_sk_" + tenant_segment + "." + KEY + ".SyntheticOnlySecretNeverIssuedabcd"

    def provider(self, identity=PROVIDER, label="Synthetic OpenAI", provider="openai", owner=None, manageable=True):
        return {"id": identity, "tenantId": self.tenant, "actorId": owner or self.actor, "provider": provider, "label": label, "source": "tenant_vault", "status": "connected", "enabled": True, "credentialVersion": 1, "credentialFingerprint": "fingerprint:" + LONG, "configuredFields": ["apiKey"], "runtimeReadiness": "active_tenant_runtime", "runtimeNote": EVIDENCE, "lastValidatedAt": STAMP, "catalogRefreshedAt": STAMP, "createdAt": STAMP, "updatedAt": STAMP, "manageable": manageable}

    def assignment(self, revision=1, model="synthetic-model-a", fallback=False):
        value = {"id": "assignment:" + LONG, "tenantId": self.tenant, "actorId": self.actor, "scope": "main_agent", "provider": "openai", "modelId": model, "displayModelId": model, "allowCrossProviderFallback": fallback, "runtimeReadiness": "active", "runtimeNote": "No actual model call is implied by this saved route. " + EVIDENCE, "contractVersion": "p11.8-model-assignment:1", "revision": revision, "configurationSha256": str(revision) * 64, "validatedAt": STAMP, "createdAt": STAMP, "updatedAt": STAMP, "manageable": True}
        if fallback: value.update({"fallbackProvider": "anthropic", "fallbackModelId": "synthetic-claude", "displayFallbackModelId": "synthetic-claude"})
        return value

    def key(self, identity=KEY, name="Synthetic UI key", manageable=True):
        return {"id": identity, "tenantId": self.tenant, "actorId": self.actor if manageable else "retained-actor", "name": name, "tokenPrefix": "asael_sk_synthetic…", "tokenLastFour": "abcd", "scopes": SCOPES, "status": "active", "createdAt": STAMP, "updatedAt": STAMP, "manageable": manageable}

    def snapshot(self):
        empty = self.mode == "empty"
        models = [{"id": "catalog:" + model, "tenantId": self.tenant, "actorId": self.actor, "provider": provider, "modelId": model, "displayModelId": model, "displayName": model + " " + LONG, "capabilities": ["text", "tools"], "lifecycle": "available", "discoveredAt": STAMP, "updatedAt": STAMP, "selectable": True} for provider, model in [("openai", "synthetic-model-a"), ("openai", "synthetic-model-b"), ("anthropic", "synthetic-claude")]]
        return {"requestReadContracts": {"providerConnections": "readable_v1", "modelAssignments": "readable_v1", "mcpExportConfiguration": "readable_v1"}, "platform": {"authEnforced": True, "bootstrapConfigured": False, "databaseConfigured": True, "storageBackend": "postgres", "releaseRevision": "release:" + LONG}, "vault": {"configured": True, "activeKeyId": "keyring:" + LONG, "message": "Synthetic independent vault. " + EVIDENCE}, "providers": [] if empty else copy.deepcopy(self.providers), "models": [] if empty else models, "assignments": [] if empty else copy.deepcopy(self.assignments), "apiKeys": [] if empty else copy.deepcopy(self.keys), "mcp": copy.deepcopy(self.mcp), "runtime": {"contractVersion": "p11.8-functional-model-routing:1", "tenantAssignmentsConsumed": True, "activeScopes": [] if empty else ["main_agent"], "configurationOnlyScopes": [], "receipts": [], "message": "Configuration is available; no runtime call receipt is present."}}

    def trash(self, identity, label):
        return signed({"version": "p9.3-trash-item:1", "trashId": identity, "tenantId": self.tenant, "ownerActorId": self.actor, "resourceType": "agent_skill", "resourceId": "resource:" + identity, "displayLabel": label, "targetSha256": "a" * 64, "snapshotSha256": "b" * 64, "compensation": {"kind": "exact_restore", "handlerId": "synthetic.restore", "limitation": "Exact synthetic metadata only. " + LONG}, "state": "retained", "lifecycleRevision": 1, "trashedAt": STAMP, "restoreUntil": "2035-10-11T10:00:00.000Z", "restoredAt": None, "purgedAt": None}, "itemSha256")

    def preview_body(self, identity, action):
        item = self.trash_original[identity]
        instant = datetime.now(timezone.utc)
        preview = signed({"version": "p9.3-trash-preview:1", "action": action, "trashId": identity, "resourceType": item["resourceType"], "resourceId": item["resourceId"], "lifecycleRevision": 1, "targetSha256": item["targetSha256"], "effectSummary": ("Restore " if action == "restore" else "Permanently purge ") + item["displayLabel"] + ". " + EVIDENCE, "reversible": action == "restore", "issuedAt": instant.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "expiresAt": (instant + timedelta(minutes=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")}, "previewSha256")
        return {"item": copy.deepcopy(item), "preview": preview, "permanent": action == "purge"}

    def trash_receipt(self, preview):
        action, identity = preview["action"], preview["trashId"]
        item = {key: value for key, value in self.trash_original[identity].items() if key != "itemSha256"}
        item.update({"state": "restored" if action == "restore" else "purged", "lifecycleRevision": 2, "restoredAt" if action == "restore" else "purgedAt": now()})
        receipt = signed({"version": "p9.3-trash-effect-receipt:1", "action": action, "trashId": identity, "resourceType": item["resourceType"], "resourceId": item["resourceId"], "targetSha256": preview["targetSha256"], "previewSha256": preview["previewSha256"], "beforeState": "retained", "afterState": item["state"], "beforeRevision": 1, "afterRevision": 2, "outcome": "applied", "affectedResourceIds": [item["resourceId"]], "occurredAt": now()}, "receiptSha256")
        return {"trash": signed(item, "itemSha256"), "effectReceipt" if action == "restore" else "finalDeletionReceipt": receipt, **({"restoredResourceIds": [item["resourceId"]], "limitation": "Synthetic fixture only"} if action == "restore" else {})}

    def portable_archive(self):
        data = {name: [] for name in SECTIONS}
        sections = {name: {"includedCount": 0, "excludedCount": 0, "contentSha256": sha([]), "restoreDisposition": "reauthorization_required" if name == "connections" else "not_included" if name == "assets" else "restore"} for name in SECTIONS}
        manifest = signed({"schemaVersion": 1, "contractId": "asael.portable.archive.v2", "sections": sections, "exclusions": [], "totals": {"includedCount": 0, "excludedCount": 0}, "secretsExcluded": True, "connectorCredentialsExcluded": True, "connectorsRequireReauthorization": True}, "manifestSha256")
        return signed({"format": "asael-portable-archive", "version": 2, "exportedAt": STAMP, "provenance": {"sourceOwnerActorIdSha256": sha_text(self.actor), "sourceTenantIdSha256": sha_text(self.tenant), "exporterId": "asael"}, "assetEncryption": None, "data": data, "manifest": manifest}, "archiveSha256")

    def portable_receipt(self):
        counts, hashes = {name: 0 for name in SECTIONS}, {name: sha([]) for name in SECTIONS}
        verification = signed({"schemaVersion": 1, "contractId": "asael.portable.restore.v1", "archiveSha256": self.archive["archiveSha256"], "manifestSha256": self.archive["manifest"]["manifestSha256"], "sourceOwnerActorIdSha256": sha_text(self.actor), "sourceTenantIdSha256": sha_text(self.tenant), "targetOwnerActorIdSha256": sha_text(self.actor), "targetTenantIdSha256": sha_text(self.tenant), "ownershipRebound": True, "provenancePreserved": True, "archiveIntegrityVerified": True, "countsVerified": True, "hashesVerified": True, "declaredCounts": counts, "restoredCounts": {**counts, "turns": 0}, "declaredSectionSha256": hashes, "restoredInputSha256": hashes, "connectionsReauthorizationRequired": 0, "verifiedAt": now()}, "receiptSha256")
        return {"restored": {**counts, "turns": 0, "connectionsReauthorizationRequired": 0, "verification": verification}}

    def body(self, key):
        if key == "settings": return self.snapshot()
        if key == "push": return {**self.targets, "registrations": []} if self.mode == "empty" else copy.deepcopy(self.targets)
        if key == "trash": return {"items": [] if self.mode == "empty" else copy.deepcopy(self.trash_items)}
        if key == "agents": return {"agents": [], "builtIns": [{"id": "atlas", "name": "ATLAS"}]}
        if key == "adaptations": return {"definitionVersion": 1, "adaptations": []}
        if key == "export": return copy.deepcopy(self.archive)
        raise AssertionError(key)

    def plan(self, key, **kwargs): self.plans[key].append(copy.deepcopy(kwargs))
    def effect(self, endpoint, method, body, reply, *, key=False, hold=None, status=200):
        self.effects.append({"path": endpoint, "method": method, "body": copy.deepcopy(body), "reply": copy.deepcopy(reply), "key": key, "hold": hold, "status": status})

    def route(self, route):
        request = route.request; parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin: return super().route(route)
        if request.resource_type == "media": self.unexpected.append({"kind": "media_bytes", "path": parsed.path}); return route.abort()
        if parsed.path.startswith("/api/") and request.method != "GET": return self.mutation(route, parsed.path)
        sources = {"settings": ("/api/settings", {"ownerScope": ["readable"]}), "push": ("/api/mobile/push/canary", {}), "trash": ("/api/trash", {"state": ["retained"], "limit": ["100"]}), "agents": ("/api/agents", {"ownerScope": ["readable"]}), "adaptations": ("/api/agents/atlas/adaptations", {}), "export": ("/api/data/export", {})}
        key = next((name for name, (endpoint, query) in sources.items() if parsed.path == endpoint and parse_qs(parsed.query) == query), None)
        preview = re.fullmatch(r"/api/trash/([^/]+)/(restore|purge)", parsed.path)
        if preview and not parsed.query and unquote(preview[1]) in self.trash_original:
            key = "preview:" + unquote(preview[1]) + ":" + preview[2]
            reply = self.preview_body(unquote(preview[1]), preview[2])
        elif key is not None: reply = self.body(key)
        else:
            if parsed.path.startswith(("/api/settings", "/api/trash", "/api/data/", "/api/mobile/push/canary")):
                self.unexpected.append({"kind": "unplanned_family_read", "path": parsed.path, "query": parsed.query}); return self.fulfill(route, {"error": "Unplanned read blocked"}, 503)
            return super().route(route)
        if len(self.requests) >= 160:
            self.unexpected.append({"kind": "read_budget"}); return self.fulfill(route, {"error": "Read budget exhausted"}, 503)
        self.requests.append({"key": key, "path": parsed.path, "query": parsed.query})
        plan = self.plans[key].popleft() if self.plans[key] else {}
        status = plan.get("status", 503 if self.mode == "error" and key in ("settings", "push", "trash") else 200)
        reply = plan.get("body", reply if status == 200 else {"error": "Synthetic settings source unavailable. " + EVIDENCE})
        if plan.get("hold"): self.held[plan["hold"]] = (route, copy.deepcopy(reply), status); return
        return self.fulfill(route, reply, status)

    def mutation(self, route, endpoint):
        request = route.request
        try: body = request.post_data_json
        except Exception: body = None
        plan = self.effects[0] if self.effects else None
        key = request.headers.get("idempotency-key", "")
        exact = plan and request.method == plan["method"] and endpoint == plan["path"] and not urlsplit(request.url).query and body == plan["body"] and len(self.writes) < self.max_effects and not request.headers.get("x-idempotency-key")
        if body is not None: exact = exact and request.headers.get("content-type", "").startswith("application/json")
        pattern = r"settings-push-canary-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}" if endpoint == "/api/mobile/push/canary" else r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
        exact = exact and (bool(re.fullmatch(pattern, key)) if plan and plan["key"] else not key)
        if not exact:
            self.unexpected.append({"kind": "blocked_write", "path": endpoint, "method": request.method, "body": body}); return self.fulfill(route, {"error": "Unexpected settings effect blocked"}, 503)
        self.effects.popleft(); self.writes.append({"method": request.method, "path": endpoint, "body": body, "idempotencyKey": key or None, "disposition": "wholly_intercepted_held" if plan["hold"] else "wholly_intercepted_fulfilled", "status": plan["status"]})
        if plan["hold"]: self.held[plan["hold"]] = (route, plan["reply"], plan["status"]); return
        return self.fulfill(route, plan["reply"], plan["status"])

    def release(self, name):
        route, body, status = self.held.pop(name)
        try: self.fulfill(route, body, status); disposition = "fulfilled_or_client_canceled"
        except PlaywrightError: disposition = "client_canceled"
        self.releases.append({"name": name, "disposition": disposition})

    def abort_held(self):
        for name, (route, _, _) in list(self.held.items()):
            try: route.abort()
            except PlaywrightError: pass
            self.releases.append({"name": name, "disposition": "teardown_abort"})
        self.held.clear()
