"""Bounded Capabilities/Connections contracts; every declared effect is fulfilled locally."""

import copy
import hashlib
import json
import re
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
GRANT = "11111111-1111-4111-8111-111111111111"
MCP = "22222222-2222-4222-8222-222222222222"
REST = "33333333-3333-4333-8333-333333333333"
SCHEDULE = "schedule-browser-evidence"
INSTALLATION = "plugin-installation-browser-evidence"
LONG = "ExactIdentity_" + "x" * 160
MARKUP = "<script>window.untrustedCapabilityRan=true</script>"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def manifest():
    return {"schemaVersion": 1, "pluginId": "browser.evidence", "version": "1.0.0", "name": "Fixture evidence extension",
            "description": "A declarative source-reading method. " + MARKUP, "publisher": {"id": "browser.publisher", "name": "Synthetic publisher"}, "license": "MIT",
            "skills": [{"key": "read-evidence", "name": "Read evidence", "description": "Read exact evidence", "instructions": "Read and cite the exact source without claiming execution authority. " + LONG,
                        "category": "research", "toolIds": [], "tags": [], "knowledgeTags": []}], "mcpTemplates": [], "workflowTemplates": []}


def plugin_preview(expired=False):
    created = datetime.now(timezone.utc) - timedelta(minutes=30 if expired else 0)
    body = {"schemaVersion": 1, "previewId": "plugin-preview-browser-evidence", "pluginId": manifest()["pluginId"], "pluginVersion": "1.0.0", "manifestSha256": digest(manifest()),
            "name": manifest()["name"], "publisherName": "Synthetic publisher", "componentCounts": {"skills": 1, "mcpTemplates": 0, "workflowTemplates": 0},
            "effects": ["Record this exact declarative manifest for the current tenant and actor.", "Install declared Skills while the Extension is enabled."],
            "limitations": ["MCP entries require separate credentials, discovery and contract review.", "Workflow templates are metadata only and grant no execution authority."],
            "createdAt": created.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "expiresAt": (created + timedelta(minutes=15)).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    return {"preview": {**body, "previewSha256": digest(body)}, "manifest": manifest()}


def plugin_installation(state="enabled", revision=1):
    data = manifest()
    body = {"schemaVersion": 1, "installationId": INSTALLATION, "pluginId": data["pluginId"], "pluginVersion": data["version"], "manifestSha256": digest(data),
            "name": data["name"], "description": data["description"], "publisher": data["publisher"], "state": state, "revision": revision,
            "components": {"skills": [{"key": "read-evidence", "name": "Read evidence", "state": "active" if state == "enabled" else "disabled"}], "mcpTemplates": [], "workflowTemplates": []},
            "installedAt": STAMP, "updatedAt": STAMP}
    return {"installation": {**body, "installationSha256": digest(body)}, "manifest": data,
            "activation": {"pluginEnabled": state == "enabled", "skillsActive": state == "enabled", "activeSkillCount": 1 if state == "enabled" else 0,
                           "mcpConnected": False, "mcpContractsReviewed": False, "workflowTemplatesExecutable": False, "explanation": "Separate setup and exact execution authority remain required."}}


def plugin_catalog(installed=None):
    data = manifest()
    record = {"pluginId": data["pluginId"], "name": data["name"], "description": data["description"], "version": data["version"], "publisher": data["publisher"], "manifest": data,
              "manifestSha256": digest(data), "componentCounts": {"skills": 1, "mcpTemplates": 0, "workflowTemplates": 0}, "catalogSource": "builtin", "installed": False, "status": "available", "updateRequiresUninstall": False}
    if installed:
        record.update({"installed": installed["state"] != "uninstalled", "status": installed["state"], "installationId": installed["installationId"], "revision": installed["revision"],
                       "installedVersion": installed["pluginVersion"], "installedManifestSha256": installed["manifestSha256"]})
    return {"plugins": [record]}


def schedule(submitted=None, state="active"):
    value = submitted or {"name": "Fixture daily review", "procedureId": "browser.read-procedure", "agentId": "atlas", "timezone": "UTC", "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=10;BYMINUTE=0", "startsAt": "2030-10-04T10:00:00.000Z", "maxOccurrences": 7, "missedPolicy": "skip", "authorityMode": "read_only", "failureLimit": 3}
    config = {"schemaVersion": 1, "timezone": value["timezone"], "rrule": value["rrule"], "startsAt": value["startsAt"], "maxOccurrences": value["maxOccurrences"], "missedPolicy": value["missedPolicy"], "failureLimit": value["failureLimit"], "authorityMode": value["authorityMode"],
              "procedurePin": {"procedureId": value["procedureId"], "snapshotSha256": digest("procedure"), "reviewedSnapshotSha256": digest("review")},
              "agentIdentityPin": {"logicalAgentId": value["agentId"], "pinSha256": digest("agent")}, "policyPinSha256": digest("policy"), "occurrenceBudget": {}}
    config["configSha256"] = digest(config)
    return {"id": SCHEDULE, "name": value["name"].strip(), "triggerKind": "schedule", "status": state, "procedureId": value["procedureId"], "agentId": value["agentId"],
            "createdAt": STAMP, "updatedAt": STAMP, "schedule": {"config": config, "state": {"nextDueAt": value["startsAt"], "occurrenceCount": 2, "consecutiveFailureCount": 0, "circuitState": "closed", "shadowOccurrenceCount": 0}},
            **({"replacesTriggerId": value["replacesTriggerId"]} if "replacesTriggerId" in value else {})}


def schedule_detail(record=None):
    record = record or schedule()
    occurrence = {"id": "occurrence-browser-a", "triggerId": SCHEDULE, "status": "failed", "scheduledFor": STAMP, "failureCode": "agent_identity_changed", "authoritySha256": digest("authority")}
    return {"trigger": record, "preview": {"triggerId": SCHEDULE, "configurationSha256": record["schedule"]["config"]["configSha256"], "occurrences": ["2030-10-04T10:00:00.000Z"], "timezone": "UTC", "status": record["status"], "circuitState": "closed", "authorityMode": "read_only", "readOnlyCanary": True},
            "occurrences": [occurrence], "receipts": [{"triggerId": SCHEDULE, "occurrenceId": occurrence["id"], "stateSha256": digest("state"), "receiptSha256": digest("receipt")}],
            "policyLeases": {"version": "scheduled-policy-lease-outcomes:1", "available": False, "outcomes": [], "contentIncluded": False}}


def connector(identity=MCP, **changes):
    result = {"id": identity, "name": "Fixture MCP server", "endpoint": "https://example.com/mcp", "authType": "bearer_vault", "status": "disabled", "defaultRiskLevel": 2, "approvalRequired": True,
              "toolCount": 1, "credentialConfigured": True, "credentialOriginMatch": True, "credentialVersion": 1, "credentialProviderOrigin": "https://example.com", "lastDiscoveredAt": STAMP, "createdAt": STAMP, "updatedAt": STAMP,
              "review": {"pendingCount": 1, "fingerprint": digest("mcp-contracts"), "contracts": [{"name": "read_fixture", "change": "new", "operationClass": "read_only", "riskLevel": 0}]}}
    result.update(changes)
    return result


def tool(connector_id=MCP):
    return {"id": "browser.mcp.read", "connectorId": connector_id, "name": "read_fixture", "description": "Read synthetic content. " + MARKUP,
            "status": "pending_review", "riskLevel": 0, "approvalRequired": False, "operationClass": "read_only", "inputSchema": {"type": "object", "properties": {"sourceId": {"type": "string", "description": LONG}}}, "contractHash": digest("tool")}


def oauth():
    scopes = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/drive.readonly"]
    return {"providers": [{"id": "google", "label": "Google", "configured": True, "authorizeUrl": "/api/oauth/google/authorize", "scopes": scopes, "accounts": [{"purpose": "personal", "label": "Fixture account", "email": "fixture@example.com"}]}],
            "grants": [{"id": GRANT, "provider": "google", "accountEmail": "fixture@example.com", "connectionLabel": "Fixture account", "connectionPurpose": "personal", "scopes": scopes, "status": "active", "syncStatus": "healthy", "manageable": True, "createdAt": STAMP, "updatedAt": STAMP}],
            "requestReadContracts": {"oauthGrants": "readable_v1"}}


def trash_receipts(record, operations):
    target = {"kind": "mcp", "connector": record, "operationIds": sorted(item["id"] for item in operations)}
    stamp = datetime.now(timezone.utc)
    at = lambda date: date.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    body = {"version": "p9.3-trash-preview:1", "action": "trash", "trashId": None, "resourceType": "mcp_connector", "resourceId": record["id"], "lifecycleRevision": 0,
            "targetSha256": digest(target), "effectSummary": "Move the exact synthetic connector and contracts to reversible Trash.", "reversible": True, "issuedAt": at(stamp), "expiresAt": at(stamp + timedelta(minutes=15))}
    preview = {**body, "previewSha256": digest(body)}
    item = {"version": "p9.3-trash-item:1", "trashId": "trash:44444444-4444-4444-8444-444444444444", "tenantId": "browser-review", "ownerActorId": "synthetic-owner", "resourceType": "mcp_connector", "resourceId": record["id"],
            "displayLabel": record["name"], "targetSha256": digest(target), "snapshotSha256": digest("restorable"), "compensation": {"kind": "exact_restore", "handlerId": "connector.restore", "limitation": None}, "state": "retained", "lifecycleRevision": 1,
            "trashedAt": at(stamp), "restoreUntil": at(stamp + timedelta(days=30)), "restoredAt": None, "purgedAt": None}
    receipt = {"version": "p9.3-trash-effect-receipt:1", "action": "trash", "trashId": item["trashId"], "resourceType": "mcp_connector", "resourceId": record["id"], "targetSha256": digest(target), "previewSha256": preview["previewSha256"],
               "beforeState": None, "afterState": "retained", "beforeRevision": 0, "afterRevision": 1, "outcome": "applied", "affectedResourceIds": [record["id"]], "occurredAt": at(stamp)}
    return ({"target": target, "targetSha256": digest(target), "preview": preview, "reversible": True},
            {"movedToTrash": True, "trash": {**item, "itemSha256": digest(item)}, "effectReceipt": {**receipt, "receiptSha256": digest(receipt)}, "target": target, "targetSha256": digest(target)})


def overview(empty=False):
    installed = {"id": "gmail:" + GRANT, "name": "Gmail", "kind": "google_service", "adapter": "native", "category": "communication", "installation": "installed", "state": "degraded", "configured": True, "connected": True, "manageable": True,
                 "account": {"connectionId": GRANT, "email": "fixture@example.com", "label": "Fixture account", "purpose": "personal"},
                 "permissions": {"mode": "read_only", "granted": ["Read mail and message metadata"], "missing": [], "activeOperations": 1, "pendingReviewOperations": 0, "disabledOperations": 0, "approvalRequiredOperations": 0},
                 "sync": {"supported": True, "status": "partial", "coverage": "unknown", "coverageDetail": "Current source coverage is not measured. " + LONG, "cursor": {"state": "unknown", "detail": "No raw provider cursor is included.", "rawValueIncluded": False}, "lastSuccessfulAt": STAMP, "freshness": {"state": "unavailable", "ageSeconds": None, "staleAfterSeconds": None}},
                 "failure": {"state": "unknown", "code": None, "message": "Current source status is unconfirmed.", "recovery": "Refresh current source status."},
                 "cost": {"periodDays": 30, "state": "unknown", "knownEstimatedCostMicrousd": None, "knownCalls": 0, "unknownCalls": 1, "detail": "No priced usage receipt is available."},
                 "nextAction": "Check current source coverage.", "updatedAt": STAMP, "manageHref": "/app/connectors#personal-sources"}
    data = {"version": "p11.7-truthful-integrations:1", "generatedAt": STAMP, "state": "empty" if empty else "partial",
            "disclosure": {"catalogSuggestions": "separate_from_installed", "credentialValuesIncluded": False, "rawCursorValuesIncluded": False, "providerContentIncluded": False, "costBasis": "recorded_attributable_usage_only"},
            "summary": {"installed": 0 if empty else 1, "working": 0, "degraded": 0 if empty else 1, "actionRequired": 0, "unavailable": 0, "suggestions": 1},
            "inventory": {key: {"state": "ready", "detail": "Fixture bounded inventory loaded."} for key in ("oauth", "mcp", "openapi", "salesforce", "usage")},
            "installed": [] if empty else [installed], "suggestions": [{"id": "fixture-suggestion", "name": "Future fixture system", "adapter": "openapi", "category": "data", "state": "configuration_required", "capabilities": ["Read metadata"], "installed": False, "detail": "A catalog suggestion grants no access."}]}
    return {"overview": data}


class CapabilityFixtures(Fixtures):
    def __init__(self, origin, max_effects=20):
        super().__init__(origin)
        self.plans, self.defaults, self.actions = defaultdict(deque), {}, deque()
        self.held, self.requests, self.releases = {}, [], []
        self.max_effects, self.installed, self.schedule = max_effects, None, schedule()
        self.mcp, self.tools, self.oauth = [connector()], [tool()], oauth()
        self.openapi, self.operations = [], []
        self.empty = False

    def plan(self, key, body, status=200, hold=None):
        self.plans[key].append({"body": copy.deepcopy(body), "status": status, "hold": hold})

    def fail(self, *keys):
        for key in keys:
            self.defaults[key] = {"body": {"error": "Synthetic " + key + " unavailable."}, "status": 503}

    def serve(self, route, key, body):
        if len(self.requests) >= 300:
            return self.reject(route, "read_budget")
        plan = self.plans[key].popleft() if self.plans[key] else self.defaults.get(key, {})
        body, status = copy.deepcopy(plan.get("body", body)), plan.get("status", 200)
        self.requests.append({"key": key, "url": route.request.url, "status": status})
        if plan.get("hold"):
            name = plan["hold"]
            if name in self.held:
                name += ":" + str(len(self.requests))
            self.held[name] = (route, body, status)
            return
        return self.fulfill(route, body, status)

    def release(self, name):
        route, body, status = self.held.pop(name)
        try:
            self.fulfill(route, body, status)
            disposition = "fulfilled"
        except PlaywrightError:
            disposition = "already_aborted"
        self.releases.append({"name": name, "disposition": disposition})

    def abort_held(self):
        for route, _, _ in self.held.values():
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.held.clear()

    def expect_action(self, path, body, result, *, method="POST", key="uuid", status=200, hold=None, after=None):
        self.actions.append({"path": path, "body": body, "result": result, "method": method, "key": key, "status": status, "hold": hold, "after": after})

    def mutation(self, route, path):
        request = route.request
        request_path = path + ("?" + urlsplit(request.url).query if urlsplit(request.url).query else "")
        try:
            body = request.post_data_json
        except Exception:
            body = None
        plan = self.actions[0] if self.actions else None
        key = request.headers.get("idempotency-key", "")
        if not plan or len(self.writes) >= self.max_effects or request.method != plan["method"] or request_path != plan["path"]:
            return self.reject(route, "effect_boundary", {"body": body})
        body_matches = plan["body"](body) if callable(plan["body"]) else body == plan["body"]
        expected_key = plan["key"]
        key_matches = not key if expected_key is None else bool(re.fullmatch(UUID if expected_key == "uuid" else re.escape(expected_key) + ":" + UUID, key))
        if not body_matches or not key_matches or "x-idempotency-key" in request.headers or (body is not None and not request.headers.get("content-type", "").startswith("application/json")):
            return self.reject(route, "effect_contract", {"body": body, "key": key})
        self.actions.popleft()
        result = plan["result"](body) if callable(plan["result"]) else plan["result"]
        self.writes.append({"path": request_path, "method": request.method, "body": body, "idempotency-key": key, "status": plan["status"], "disposition": "locally_fulfilled"})
        if plan["after"]:
            plan["after"]()
        if plan["hold"]:
            self.held[plan["hold"]] = (route, result, plan["status"])
            return
        return self.fulfill(route, result, plan["status"])

    def reject(self, route, reason, detail=None):
        self.unexpected.append({"kind": reason, "url": route.request.url, "method": route.request.method, "detail": detail})
        return self.fulfill(route, {"error": "Unexpected capability request blocked."}, 503)

    def route(self, route):
        request, parsed = route.request, urlsplit(route.request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return super().route(route) if path == "/__nextjs_original-stack-frames" else self.mutation(route, path)
        if path in ("/api/skills", "/api/tools", "/api/plugins", "/api/connectors", "/api/openapi-connectors", "/api/connection-catalog", "/api/integrations/overview"):
            if query:
                return self.reject(route, "inventory_query")
            bodies = {
                "/api/skills": {"skills": [] if self.empty else [{"id": "browser-skill", "name": "Fixture source method", "description": "Read exact source evidence. " + MARKUP, "status": "active", "category": "research", "builtIn": False, "toolIds": ["browser.read"]}]},
                "/api/tools": {"tools": [] if self.empty else [tool()], "policy": {"defaultBehavior": "Unknown and unreviewed tools remain blocked."}},
                "/api/plugins": {"plugins": []} if self.empty else plugin_catalog(self.installed),
                "/api/connectors": {"connectors": [] if self.empty else self.mcp, "tools": [] if self.empty else self.tools, "stats": {"total": 0 if self.empty else len(self.mcp), "active": 0}, "credentialVault": {"configured": True}},
                "/api/openapi-connectors": {"connectors": self.openapi, "operations": self.operations, "stats": {"total": len(self.openapi)}},
                "/api/connection-catalog": {"connectors": [], "stats": {"total": 0}},
                "/api/integrations/overview": overview(self.empty or not self.oauth["grants"]),
            }
            return self.serve(route, path, bodies[path])
        if path == "/api/oauth":
            if query != {"ownerScope": ["readable"]}:
                return self.reject(route, "oauth_owner_scope")
            return self.serve(route, path, self.oauth)
        if path == "/api/workflows":
            if query != {"limit": ["24"]}:
                return self.reject(route, "workflow_bound")
            return self.serve(route, path, {"runs": []})
        if path == "/api/triggers":
            if query != {"limit": ["48"]}:
                return self.reject(route, "trigger_bound")
            return self.serve(route, path, {"triggers": [] if self.empty else [self.schedule], "events": [], "occurrences": [], "receipts": [], "stats": {},
                "procedures": [{"id": "browser.read-procedure", "schedulable": True, "authorityMode": "read_only", "reviewDigest": digest("read-only"), "mutationBindings": []}], "agents": [{"id": "atlas", "name": "Atlas", "role": "supervisor"}]})
        if path == "/api/triggers/" + SCHEDULE:
            return self.reject(route, "detail_query") if query else self.serve(route, path, schedule_detail(self.schedule))
        if path.startswith(("/api/plugins/", "/api/connectors/", "/api/openapi-connectors/", "/api/oauth/", "/api/triggers/")):
            return self.reject(route, "unexpected_connection_read")
        return super().route(route)
