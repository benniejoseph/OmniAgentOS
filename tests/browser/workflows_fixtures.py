"""Bounded synthetic Workflow operations. No scheduler, planner or provider runs.

All effects must match an explicitly queued exact path/body/header plan. Only the
isolated real login/session and normal application documents/assets are forwarded.
"""
from collections import defaultdict, deque
import copy
import json
import re
from urllib.parse import parse_qs, quote, unquote, urlsplit
from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

RUN = "workflow:synthetic/exact+identity"
OTHER = "workflow:synthetic-other"
PLAN = "plan:synthetic-exact"
SCHEDULE = "schedule:synthetic/exact+identity"
MUTATION = "schedule:synthetic-reviewed-changes"
JOB = "job:synthetic-quarantined"
PROCEDURE = "procedure:synthetic-source-review"
LONG = "exact_identity_" * 12
EVIDENCE = "Synthetic untrusted evidence.\n  Preserve every identity, line and source. <script>window.untrustedWorkflowRan=true</script> " + LONG
SOURCES = {"runs": ("/api/workflows", {"limit": ["16"]}), "plans": ("/api/workflows/plan", {"limit": ["12"]}), "triggers": ("/api/triggers", {"limit": ["12"]}), "operations": ("/api/operations", {})}
BUDGET = {"modelTurns": 0, "tokens": 0, "costMicrousd": 0, "wallTimeMs": 60000, "toolCalls": 3, "browserActions": 0, "agents": 1, "fanOut": 0, "retries": 0, "replans": 0}


def path(kind, identity, suffix=""):
    return "/api/" + kind + "/" + quote(identity, safe="") + suffix


class WorkflowFixtures(Fixtures):
    max_effects = 12

    def __init__(self, origin, session):
        super().__init__(origin)
        self.tenant, self.actor = session["context"]["tenantId"], session["context"]["actorId"]
        self.mode = "ready"
        self.plans, self.effects, self.held = defaultdict(deque), deque(), {}
        self.requests, self.releases = [], []
        self.run_rows = [self.run_record(), self.run_record(OTHER, "failed", "Synthetic failed run"), self.run_record("workflow:waiting", "waiting_approval", "Synthetic approval gate"), self.run_record("workflow:closed", "completed", "Synthetic unverified completion")]
        self.plan_rows = [self.plan_record()]
        self.triggers = [self.trigger(), self.trigger(MUTATION, mutation=True)]
        self.triggers.append({"id": "trigger:synthetic-webhook", "tenantId": self.tenant, "triggerKind": "webhook", "name": "Synthetic webhook trigger", "source": "synthetic.external-event", "status": "paused", "authMode": "hmac_sha256", "goalTemplate": EVIDENCE, "workflowMode": "orchestrate", "requireApproval": True, "metadata": {"sourceIdentity": LONG}, "triggerCount": 0, "failureCount": 0, "createdAt": STAMP, "updatedAt": STAMP})
        self.quarantine = [{"id": JOB, "type": "workflow.tick", "attempt": 3, "maxAttempts": 3, "leaseLapses": 3, "lastError": EVIDENCE, "updatedAt": STAMP}]
        self.lease_available = False

    def run_record(self, identity=RUN, status="queued", goal="Synthetic exact workflow"):
        return {"id": identity, "tenantId": self.tenant, "workflowType": "goal", "status": status, "goal": goal, "input": {"goal": goal, "mode": "orchestrate", "requireApproval": True,
            "metadata": {"actorId": self.actor, "primaryAgentId": "scout", "agentIdentity": {"definitionVersionId": "agent:scout:definition:" + LONG, "principalId": "agent:scout:principal:" + LONG}}},
            "currentStep": "execute", "attempt": 1, "maxAttempts": 3, "approvalRequired": True, "createdAt": STAMP, "updatedAt": STAMP,
            "error": EVIDENCE if status == "failed" else None, "outcome": None,
            "canonicalStatus": {"schemaVersion": 1, "domain": "workflow_run", "status": {"queued": "waiting", "running": "running", "paused": "waiting", "waiting_approval": "waiting", "completed": "unverified", "failed": "failed", "canceled": "canceled"}[status], "basis": "legacy_status", "source": "legacy_adapter", "sourceStatus": status, "verificationState": "unassessed"}}

    def run_detail(self, identity=RUN, record=None):
        row = copy.deepcopy(record or next(value for value in self.run_rows if value["id"] == identity))
        identity = row["id"]
        return {"run": row, "steps": [{"id": "step:" + identity, "tenantId": self.tenant, "workflowRunId": identity, "stepKey": "execute", "label": "Review exact source evidence", "status": "failed" if row["status"] == "failed" else "pending", "attempt": 1, "maxAttempts": 3, "input": {"source": EVIDENCE}, "output": {"result": "Unverified synthetic output", "reference": LONG}, "createdAt": STAMP, "updatedAt": STAMP}],
            "events": [{"id": "event:" + identity, "tenantId": self.tenant, "workflowRunId": identity, "type": "workflow.created", "payload": {"sourceRef": LONG, "evidence": EVIDENCE}, "createdAt": STAMP}]}

    def plan_record(self, identity=PLAN, goal="Synthetic exact workflow"):
        node = {"id": "node:synthetic", "label": "Inspect exact source", "kind": "tool", "description": EVIDENCE, "dependsOn": [], "toolIds": ["knowledge.search"], "toolInputs": [{"toolId": "knowledge.search", "inputJson": json.dumps({"query": "Synthetic evidence only"})}], "connectorTargets": [], "riskLevel": 0, "approvalRequired": False, "policy": "auto", "acceptanceCriteria": [EVIDENCE], "expectedOutputs": ["Bounded source evidence"]}
        return {"id": identity, "tenantId": self.tenant, "goal": goal, "status": "planned", "planner": "deterministic", "model": "synthetic-only", "highestRiskLevel": 0, "approvalRequired": True, "confidence": .8, "createdAt": STAMP, "updatedAt": STAMP,
            "validation": {"isDag": True, "missingDependencies": [], "unreachableNodes": [], "policyWarnings": ["Synthetic source remains untrusted"]},
            "plan": {"objective": goal, "summary": EVIDENCE, "mode": "orchestrate", "assumptions": [], "constraints": ["Synthetic only"], "risks": [], "acceptanceCriteria": ["Source verified"], "nodes": [node], "edges": [], "selectedToolIds": ["knowledge.search"], "connectorTargets": [], "executionPolicy": {"highestRiskLevel": 0, "requiresApproval": True, "defaultPolicy": "approval_required", "notes": []}, "verificationPlan": ["Inspect exact references"], "memoryPlan": [], "confidence": .8}}

    def trigger(self, identity=SCHEDULE, mutation=False):
        config = {"schemaVersion": 1, "timezone": "Asia/Kolkata", "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0", "startsAt": STAMP, "maxOccurrences": 365, "missedPolicy": "run_once" if mutation else "skip", "procedurePin": {"schemaVersion": 1, "procedureId": PROCEDURE, "snapshotSha256": "a" * 64, "reviewedSnapshotSha256": "b" * 64, "reviewedAt": STAMP},
            "agentIdentityPin": {"schemaVersion": 1, "version": "p7.1-agent-identity-pin:1", "runId": "schedule-preview:synthetic", "tenantId": self.tenant, "actorId": self.actor, "logicalAgentId": "scout", "definitionId": "agent:scout:definition", "definitionVersion": 2, "definitionVersionId": "agent:scout:definition:" + LONG, "definitionSha256": "c" * 64, "personaVersionId": "persona:synthetic:2", "personaSha256": "a" * 64, "modelPolicyVersionId": "model:synthetic:1", "modelPolicySha256": "b" * 64, "promptContractVersionId": "prompt:synthetic:1", "skillPins": [], "principalId": "agent:scout:principal:" + LONG, "principalGeneration": 1, "principalVersionId": "principal:synthetic:1", "principalSha256": "d" * 64, "policyPins": [{"policyId": "policy:" + str(n), "policyVersionId": "policy:" + str(n) + ":1", "policySha256": "e" * 64} for n in range(4)], "pinSha256": "f" * 64}, "policyPinSha256": "d" * 64,
            "occurrenceBudget": BUDGET, "failureLimit": 3, "authorityMode": "reviewed_mutation" if mutation else "read_only", "configSha256": "e" * 64}
        if mutation: config["mutationPolicy"] = {"schemaVersion": 1, "policyKind": "reviewed_static_mutation", "procedureSnapshotSha256": "a" * 64, "agentIdentityPinSha256": "c" * 64, "agentPolicyPinSha256": "d" * 64, "occurrenceBudgetSha256": "f" * 64, "maximumOccurrences": 365, "policySha256": "f" * 64, "bindings": [{"schemaVersion": 1, "bindingIndex": 0, "toolId": "memory.write", "inputSha256": "a" * 64, "targetSha256": "b" * 64, "toolContractSha256": "c" * 64, "riskLevel": 1, "reversible": True, "bindingSha256": "d" * 64}]}
        return {"id": identity, "tenantId": self.tenant, "ownerActorId": self.actor, "triggerKind": "schedule", "name": "Synthetic governed schedule" if mutation else "Synthetic morning schedule", "source": "synthetic.browser", "status": "paused" if mutation else "active", "authMode": "none", "goalTemplate": EVIDENCE, "workflowMode": "orchestrate", "requireApproval": mutation, "metadata": {}, "triggerCount": 2, "failureCount": 3 if mutation else 0, "createdAt": STAMP, "updatedAt": STAMP,
            "schedule": {"config": config, "state": {"nextDueAt": "2026-10-05T03:30:00.000Z", "occurrenceCount": 2, "consecutiveFailureCount": 3 if mutation else 0, "circuitState": "open" if mutation else "closed", "pausedReason": EVIDENCE if mutation else None, "shadowOccurrenceCount": 2}}}

    def occurrence(self, identity=SCHEDULE):
        return {"schemaVersion": 1, "id": "occurrence:" + identity, "tenantId": self.tenant, "ownerActorId": self.actor, "triggerId": identity, "kind": "scheduled", "status": "failed", "scheduledFor": STAMP, "evaluatedThrough": STAMP, "outcome": "due", "occurrencesConsumed": 1, "occurrenceCount": 1, "configurationSha256": "e" * 64, "agentIdentityPinSha256": "c" * 64, "policyPinSha256": "d" * 64, "procedureSnapshotSha256": "a" * 64, "reviewedSnapshotSha256": "b" * 64, "occurrenceBudgetSha256": "f" * 64, "authoritySha256": "a" * 64, "workflowRunId": RUN, "queueJobId": JOB, "failureCode": "workflow_failed", "attemptCount": 1, "createdAt": STAMP, "updatedAt": STAMP}

    def occurrence_receipt(self, identity=SCHEDULE):
        return {"schemaVersion": 1, "id": "receipt:" + identity, "tenantId": self.tenant, "ownerActorId": self.actor, "triggerId": identity, "occurrenceId": "occurrence:" + identity, "status": "failed", "workflowRunId": RUN, "queueJobId": JOB, "failureCode": "workflow_failed", "authoritySha256": "a" * 64, "stateSha256": "b" * 64, "recordedAt": STAMP, "receiptSha256": "c" * 64}

    def schedule_detail(self, identity=SCHEDULE):
        trigger = copy.deepcopy(next(row for row in self.triggers if row["id"] == identity))
        return {"trigger": trigger, "preview": {"triggerId": identity, "status": trigger["status"], "circuitState": trigger["schedule"]["state"]["circuitState"], "timezone": "Asia/Kolkata", "occurrences": ["2026-10-05T03:30:00.000Z", "2026-10-06T03:30:00.000Z"], "configurationSha256": trigger["schedule"]["config"]["configSha256"], "authorityMode": trigger["schedule"]["config"]["authorityMode"]}, "occurrences": [self.occurrence(identity)], "receipts": [self.occurrence_receipt(identity)],
            "policyLeases": {"version": "scheduled-policy-lease-outcomes:1", "available": self.lease_available, "contentIncluded": False, "outcomes": [{"leaseId": "lease:" + LONG, "leaseSha256": "a" * 64, "triggerId": identity, "occurrenceId": "occurrence:" + identity, "workflowRunId": RUN, "executionId": "execution:" + LONG, "bindingIndex": 0, "bindingSha256": "b" * 64, "toolContractSha256": "c" * 64, "toolId": "memory.write", "policySha256": "d" * 64, "influenceManifestSha256": "e" * 64, "status": "consumed", "issuedAt": STAMP, "expiresAt": STAMP, "consumedAt": STAMP, "consumptionReceiptId": "consumption:" + LONG, "consumptionReceiptSha256": "f" * 64, "contentIncluded": False, "leaseGrantsAuthority": False}] if self.lease_available else []}}

    def recovery(self, limit=10):
        return {"mode": "inspect", "inspectedAt": STAMP, "limit": limit, "staleWorkflowMs": 300000, "failAfterMs": 3600000, "expiredLeasesRepaired": 0, "requeuedWorkflows": 0, "failedWorkflows": 0, "skippedWorkflows": 1,
            "runnableJobsBefore": 1, "runnableJobsAfter": 1, "expiredLeasesBefore": 1, "expiredLeasesAfter": 1,
            "staleWorkflows": [{"workflowRunId": RUN, "status": "queued", "currentStep": "execute", "attempt": 1, "maxAttempts": 3, "staleMs": 600000, "ageMs": 900000, "disposition": "inspect", "reason": EVIDENCE, "jobIds": [JOB]}]}

    def body(self, key):
        empty = self.mode == "empty"
        if key == "runs": return {"runs": [] if empty else self.run_rows, "stats": {"active": 0 if empty else 1, "waitingApproval": 0 if empty else 1, "total": 0 if empty else 4}}
        if key == "plans": return {"plans": [] if empty else self.plan_rows}
        if key == "triggers": return {"triggers": [] if empty else self.triggers, "stats": {"total": 0 if empty else len(self.triggers)}, "agents": [{"id": "scout", "name": "Scout", "role": "Research", "status": "ready", "builtIn": True}], "procedures": [{"id": PROCEDURE, "aliases": [LONG], "toolIds": ["knowledge.search"], "schedulable": True, "authorityMode": "read_only", "reviewDigest": "a" * 64, "mutationBindings": []}], "events": [], "occurrences": [] if empty else [self.occurrence()], "receipts": [] if empty else [self.occurrence_receipt()], "scheduleDefaults": {"occurrenceBudget": BUDGET, "failureLimit": 3, "maxOccurrences": 365, "missedPolicy": "skip"}}
        if key == "operations": return {"summary": {name: 0 if empty else 1 for name in ("runnableJobs", "expiredLeases", "staleWorkflows", "quarantinedJobs")}, "latest": {"operationJobs": [], "quarantinedJobs": [] if empty else self.quarantine, "recoveryEvents": []}, "recovery": self.recovery()}
        if key.startswith("run:"): return self.run_detail(key[4:])
        if key.startswith("schedule:"): return self.schedule_detail(key[9:])
        raise AssertionError(key)

    def plan(self, key, **kwargs): self.plans[key].append(copy.deepcopy(kwargs))
    def effect(self, endpoint, body, reply, *, key=False, hold=None, status=200):
        self.effects.append({"path": endpoint, "body": copy.deepcopy(body), "reply": copy.deepcopy(reply), "key": key, "hold": hold, "status": status})

    def route(self, route):
        request = route.request; parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin: return super().route(route)
        if request.resource_type == "media": self.unexpected.append({"kind": "media_bytes", "path": parsed.path}); return route.abort()
        if parsed.path.startswith("/api/") and request.method != "GET": return self.mutation(route, parsed.path)
        key = next((key for key, (endpoint, query) in SOURCES.items() if parsed.path == endpoint and parse_qs(parsed.query) == query), None)
        if key is None and not parsed.query:
            if parsed.path.startswith("/api/workflows/") and unquote(parsed.path[len("/api/workflows/"):]) in {row["id"] for row in self.run_rows}: key = "run:" + unquote(parsed.path[len("/api/workflows/"):])
            if parsed.path.startswith("/api/triggers/") and unquote(parsed.path[len("/api/triggers/"):]) in {row["id"] for row in self.triggers if row["triggerKind"] == "schedule"}: key = "schedule:" + unquote(parsed.path[len("/api/triggers/"):])
        if key is None:
            if parsed.path.startswith(("/api/workflows", "/api/triggers", "/api/operations")):
                self.unexpected.append({"kind": "unplanned_family_read", "path": parsed.path, "query": parsed.query}); return self.fulfill(route, {"error": "Unplanned read blocked"}, 503)
            return super().route(route)
        if len(self.requests) >= 180:
            self.unexpected.append({"kind": "read_budget"}); return self.fulfill(route, {"error": "Read budget exhausted"}, 503)
        self.requests.append({"key": key, "path": parsed.path, "query": parsed.query})
        plan = self.plans[key].popleft() if self.plans[key] else {}
        status = plan.get("status", 503 if self.mode == "error" else 200)
        reply = plan.get("body", {"error": "Synthetic source unavailable. " + LONG} if status != 200 else self.body(key))
        if plan.get("hold"): self.held[plan["hold"]] = (route, copy.deepcopy(reply), status); return
        return self.fulfill(route, reply, status)

    def mutation(self, route, endpoint):
        request = route.request
        try: body = request.post_data_json
        except Exception: body = None
        plan = self.effects[0] if self.effects else None
        key = request.headers.get("idempotency-key", "")
        exact = plan and request.method == "POST" and endpoint == plan["path"] and not urlsplit(request.url).query and body == plan["body"] and len(self.writes) < self.max_effects and request.headers.get("content-type", "").startswith("application/json") and not request.headers.get("x-idempotency-key")
        exact = exact and (bool(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", key)) if plan and plan["key"] else not key)
        if not exact:
            self.unexpected.append({"kind": "blocked_write", "path": endpoint, "method": request.method, "body": body}); return self.fulfill(route, {"error": "Unexpected workflow action blocked"}, 503)
        self.effects.popleft()
        self.writes.append({"method": request.method, "path": endpoint, "body": body, "idempotencyKey": key or None, "disposition": "wholly_intercepted_held" if plan["hold"] else "wholly_intercepted_fulfilled", "status": plan["status"]})
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
