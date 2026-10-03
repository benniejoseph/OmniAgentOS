"""Exact synthetic Quality/Monitoring/Security reads and eight bounded desktop receipts.

Real isolated authentication only. No evaluation, dispatch, marker, retention,
provider, deletion, or signed-export request is forwarded to the application.
"""
from collections import defaultdict, deque
import copy
import re
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

DIGEST = "a" * 64
LONG = "exact-operational-identity:" + "scope_and_source_" * 14
MESSAGE = "Synthetic untrusted runtime evidence <script>window.operationalInjected=true</script>. " + LONG
RUN, JOB = "run:" + LONG, "job:" + LONG
CLUSTER, PROPOSAL = "cluster:" + "exact_scope_" * 16, "proposal:" + "exact_scope_" * 16
POLICY_KEYS = ("pendingApprovalDays", "pendingAccessRequestDays", "reviewedAccessRequestDays", "episodeMemoryDays", "consolidatedMemoryDays", "retrievalTraceDays", "workflowDays", "triggerEventDays", "operationJobDays", "runContentDays", "toolPayloadDays", "aiUsageDays", "domainEventDays", "observabilityDays", "healthHistoryDays", "evaluationHistoryDays", "graphBuildHistoryDays", "securityAuditDays")
PATHS = {
    "/api/evaluations": ("evaluations", {"limit": ["12"]}),
    "/api/evaluations/failure-feedback": ("feedback", {"limit": ["50"]}),
    "/api/release/evidence": ("release", {}),
    "/api/observability": ("events", {"limit": ["24"]}),
    "/api/observability/slo": ("slo", {}),
    "/api/incidents": ("incidents", {"status": ["active"], "limit": ["12"]}),
    "/api/alerts": ("alerts", {"limit": ["12"]}),
    "/api/security/context": ("context", {}),
    "/api/security/audits": ("audits", {"limit": ["24"]}),
    "/api/security/isolation-report": ("isolation", {}),
    "/api/security/retention": ("retention", {}),
}


class OperationalFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.tenant, self.actor = session["context"]["tenantId"], session["context"]["actorId"]
        self.mode, self.plans, self.effects, self.held = "ready", defaultdict(deque), deque(), {}
        self.requests, self.releases = [], []
        self.policy = {key: 30 for key in POLICY_KEYS}
        self.replay = {"schemaVersion": 1, "lane": "governed_evaluation", "suite": "synthetic-suite", "caseId": "synthetic-case", "caseType": "system", "caseDefinitionSha256": DIGEST, "failureCategory": "verification", "failureSignalSha256": "b" * 64, "inputShape": {"object": {}}, "expectedKeys": ["passed"], "replay": {"selector": "case_id_and_definition_digest", "mutationAuthority": "not_inherited"}}
        self.proposal = {"id": PROPOSAL, "tenantId": self.tenant, "clusterId": CLUSTER, "version": 2, "kind": "evaluation_case", "target": "Synthetic bounded regression", "proposalSha256": DIGEST, "status": "proposed", "proposedBy": self.actor, "proposedAt": STAMP, "createdAt": STAMP, "updatedAt": STAMP, "proposal": {"change": {"operation": "add_regression_assertion", "scope": MESSAGE}, "automaticApplication": False}}

    def job(self, status="queued", identity=JOB):
        return {"id": identity, "type": "evaluation.run", "status": status, "progress": {"stage": status}, "result": {"evalRunId": RUN}, "priority": 10, "attempt": 0, "maxAttempts": 3, "runAt": STAMP, "createdAt": STAMP, "updatedAt": STAMP}

    def slo(self):
        policy = {"id": "policy:" + LONG, "tenantId": self.tenant, "name": "First output latency", "metric": "agentFirstOutputP95Ms", "unit": "ms", "enabled": True}
        measured = {"policy": policy, "value": 0, "breached": False, "margin": 0, "message": "Only two samples were returned; health is unconfirmed for this policy.", "insufficientSamples": {"samples": 2, "minimumSamples": 10}}
        return {"checkedAt": STAMP, "healthy": True, "stats": {}, "agentQuality": {}, "policies": [policy], "evaluations": [measured], "breaches": []}

    def body(self, key):
        empty = self.mode == "empty"
        if key == "evaluations":
            return {"runs": [] if empty else [{"id": RUN, "tenantId": self.tenant, "suite": "Synthetic mixed outcomes", "status": "completed", "summary": {"total": 4, "passed": 2, "failed": 1, "warnings": 1, "averageLatencyMs": 42, "estimatedCostUsd": 0}, "error": MESSAGE, "createdAt": STAMP, "completedAt": STAMP}], "jobs": [] if empty else [self.job()], "cases": [] if empty else [{"id": "synthetic-case", "name": "Synthetic case", "description": MESSAGE, "type": "system", "governance": {"safetyMode": "synthetic", "riskLevel": 1, "writesToDatabase": True, "cleanup": "self_cleaning", "production": {"requiresAdmin": False, "requiresMutationApproval": False}}}], "stats": {"total": 0 if empty else 1}}
        if key == "feedback":
            return {"clusters": [] if empty else [{"id": CLUSTER, "tenantId": self.tenant, "caseId": "synthetic-case", "status": "active", "failureCategory": "verification", "failureCount": 4, "consecutiveFailures": 2, "latestEvalRunId": RUN, "latestResultId": "result:" + LONG, "replayCase": self.replay, "replayCaseSha256": DIGEST, "updatedAt": STAMP}], "proposals": [] if empty else [self.proposal], "summary": {"activeRecurring": 0 if empty else 1, "proposedRules": 0 if empty else 1}}
        if key == "release":
            return {"report": {"tenantId": self.tenant, "checkedAt": STAMP, "deployment": {"provider": "local", "environment": "test", "commitSha": "c" * 40}, "releaseGate": {"status": "blocked", "approved": False, "summary": {"total": 1, "passed": 0, "warnings": 0, "failures": 1}, "reasons": ["Synthetic release evidence is incomplete."], "warnings": []}, "gates": [{"id": "gate:" + LONG, "name": "Synthetic release gate", "status": "fail", "summary": MESSAGE, "details": {}}]}}
        if key == "events":
            return {"events": [] if empty else [{"id": "event:" + LONG, "tenantId": self.tenant, "actorId": self.actor, "level": "warn", "category": "system", "action": "synthetic.runtime", "message": MESSAGE, "route": "/synthetic/" + LONG, "statusCode": 503, "durationMs": 42, "requestId": "request:" + LONG, "correlationId": "correlation:" + LONG, "createdAt": STAMP}], "stats": {"total": 0 if empty else 1}}
        if key == "slo":
            return {"checkedAt": STAMP, "healthy": True, "policies": [], "evaluations": [], "breaches": []} if empty else self.slo()
        if key == "incidents":
            return {"incidents": [] if empty else [{"id": "incident:" + LONG, "tenantId": self.tenant, "title": "Synthetic active incident", "message": MESSAGE, "status": "acknowledged", "severity": "warning", "componentId": "component:" + LONG, "fingerprint": "fingerprint:" + LONG, "occurrenceCount": 3, "firstSeenAt": STAMP, "lastSeenAt": STAMP, "acknowledgedBy": self.actor, "acknowledgementReason": "Synthetic review only."}], "stats": {"active": 0 if empty else 1}}
        if key == "alerts":
            return {"deliveries": [] if empty else [{"id": "delivery:" + LONG, "tenantId": self.tenant, "incidentId": "incident:" + LONG, "targetId": "target:" + LONG, "channel": "webhook", "status": "failed", "attempt": 2, "maxAttempts": 3, "runAt": STAMP, "updatedAt": STAMP, "lastError": MESSAGE}], "stats": {"failed": 0 if empty else 1}}
        if key == "context":
            return {"context": {"tenantId": self.tenant, "actorId": self.actor, "role": "admin"}, "policy": {"rbacRules": {"viewer": ["read"], "operator": ["read", "run.evaluation", "manage.workflow"], "admin": ["read", "read.security", "manage.identity"]}}}
        if key == "audits":
            return {"records": [] if empty else [{"id": "audit:" + LONG, "tenantId": self.tenant, "actorId": self.actor, "actorRole": "admin", "action": "synthetic.audit", "resourceType": "test", "resourceId": "resource:" + LONG, "decision": "deny", "reason": MESSAGE, "createdAt": STAMP}], "stats": {"total": 0 if empty else 1}}
        if key == "isolation":
            return {"report": {"tenantId": self.tenant, "checkedAt": STAMP, "storageBackend": "bounded_local", "databaseConfigured": False, "status": "not_configured", "summary": {"expectedTables": 1, "protectedTables": 0, "failingTables": 1}, "tables": [] if empty else [{"tableName": "synthetic_table_" + LONG, "category": "root", "exists": False, "tenantColumn": False, "rlsEnabled": False, "forceRls": False, "policyPresent": False, "status": "fail"}], "recommendations": ["Synthetic database evidence unavailable."]}}
        if key == "retention": return {"policy": self.policy, "backend": "bounded_local", "automaticSweep": False}
        raise AssertionError(key)

    def plan(self, key, *, body=None, status=200, hold=None):
        self.plans[key].append({"body": copy.deepcopy(body), "status": status, "hold": hold})

    def expect_effect(self, path, body, reply, *, status=200, hold=None):
        self.effects.append({"path": path, "body": copy.deepcopy(body), "reply": copy.deepcopy(reply), "status": status, "hold": hold})

    def mutation(self, route, path):
        request = route.request
        try: body = request.post_data_json
        except Exception: body = None
        expected, key = self.effects[0] if self.effects else None, request.headers.get("idempotency-key", "")
        if expected and len(self.writes) < 8 and request.method == "POST" and not urlsplit(request.url).query and path == expected["path"] and body == expected["body"] and request.headers.get("content-type", "").startswith("application/json") and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", key):
            self.effects.popleft()
            self.writes.append({"path": path, "method": "POST", "body": body, "idempotencyKey": key, "disposition": "wholly_intercepted_synthetic_receipt"})
            if expected["hold"]: self.held[expected["hold"]] = (route, expected["reply"], expected["status"]); return
            return self.fulfill(route, expected["reply"], expected["status"])
        self.unexpected.append({"kind": "write", "path": path, "method": request.method, "body": body})
        return self.fulfill(route, {"error": "Undeclared operational effect blocked."}, 503)

    def route(self, route):
        request, parsed = route.request, urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin: return super().route(route)
        if request.resource_type == "media": self.unexpected.append({"kind": "media", "path": parsed.path}); return route.abort()
        if parsed.path == "/api/security/audits/export":
            self.unexpected.append({"kind": "download", "path": parsed.path}); return self.fulfill(route, {"error": "Signed export delivery is outside this browser suite."}, 503)
        if request.method not in ("GET", "HEAD") and parsed.path.startswith("/api/"): return self.mutation(route, parsed.path)
        if parsed.path not in PATHS: return super().route(route)
        key, expected_query = PATHS[parsed.path]
        if request.method != "GET" or parse_qs(parsed.query) != expected_query or len(self.requests) >= 250:
            self.unexpected.append({"kind": "read_shape_or_budget", "path": parsed.path, "query": parsed.query}); return self.fulfill(route, {"error": "Unexpected operational read."}, 400)
        self.requests.append({"key": key, "path": parsed.path, "query": parsed.query})
        plan = self.plans[key].popleft() if self.plans[key] else {}
        body, status = plan.get("body"), plan.get("status", 200)
        if body is None:
            if self.mode == "error": body, status = {"error": "Synthetic " + key + " unavailable."}, 503
            elif self.mode == "restricted" and key != "context": body, status = {"error": "Synthetic permission restriction for this source."}, 403
            else: body = self.body(key)
        if plan.get("hold"): self.held[plan["hold"]] = (route, copy.deepcopy(body), status); return
        return self.fulfill(route, body, status)

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
