"""Synthetic Agents presentation contracts and eight exact local effect receipts.

No Agent execution, provider, Moltbook or production grant operation is forwarded.
The isolated authentication session is real; all family data below is synthetic.
"""
from collections import defaultdict, deque
import copy
import json
import re
from urllib.parse import parse_qs, quote, unquote, urlsplit
from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

A = "11111111-aaaa-4111-8111-111111111111"
B = "22222222-bbbb-4222-8222-222222222222"
SKILL = "33333333-cccc-4333-8333-333333333333"
TASK, OTHER_TASK = "delegation-execution:synthetic-exact-one", "delegation-execution:synthetic-exact-two"
RUN = "synthetic-agent-run-exact"
OWNER = "actor:11111111-1111-4111-8111-111111111111"
LONG = "Exact returned evidence " + "identity_" * 16
TEXT = "Synthetic untrusted source evidence.\n  Preserve spacing, the complete citation, and every returned identity. " + LONG
ADAPTATION = "agent-adaptation:" + "d" * 64
GRANT = "context:synthetic-exact-grant"


def agent_path(identity=A, suffix=""):
    return "/api/agents/" + quote(identity, safe="") + suffix


def definition(version): return f"definition:custom:{A}:v{version}"


def evaluated(release):
    next_value = copy.deepcopy(release)
    receipt = {"schemaVersion": 1, "version": "p7.5-agent-release-evaluation:1", "evaluationId": "agent-release-evaluation:" + "e" * 64,
        "agentId": A, "definitionId": "definition:custom:" + A, "definitionVersion": 2, "definitionVersionId": definition(2), "definitionSha256": "a" * 64,
        "baselineDefinitionVersion": 1, "baselineDefinitionVersionId": definition(1), "baselineDefinitionSha256": "b" * 64,
        "policyVersionId": "agent-release-policy:1", "direction": "promotion", "changedFields": ["instructions"],
        "checks": {key: True for key in ("exactOwnerBinding", "versionTransition", "immutableDefinitionDigest", "personaContract", "skillPins", "authorityExcluded", "materialChange")},
        "verdict": "passed", "evaluatedAt": STAMP, "evaluationSha256": "c" * 64}
    next_value["evaluations"] = [receipt]
    next_value["candidateEvaluation"] = receipt
    return next_value


class AgentFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.tenant = session["context"]["tenantId"]
        self.actor = session["context"].get("actorId") or session.get("user", {}).get("email") or "synthetic-owner"
        self.mode = "ready"
        self.plans, self.effects, self.held = defaultdict(deque), deque(), {}
        self.requests, self.releases = [], []
        self.agents = [self.agent(A, "Synthetic Agent A"), self.agent(B, "Synthetic Agent B", manageable=False)]
        self.skill = {"id": SKILL, "tenantId": self.tenant, "actorId": self.actor, "slug": "synthetic-skill", "name": "Synthetic exact Skill", "description": LONG,
            "instructions": TEXT, "category": "research", "status": "active", "version": 1, "toolIds": ["knowledge.search"], "tags": ["synthetic", "review"], "knowledgeTags": [],
            "selectable": True, "manageable": True, "createdAt": STAMP, "updatedAt": STAMP}
        self.release_record = {"schemaVersion": 1, "agentId": A, "state": "active", "releaseRevision": 1, "activeDefinitionVersion": 1, "activeDefinitionVersionId": definition(1),
            "previousDefinitionVersion": None, "previousDefinitionVersionId": None, "latestDefinitionVersion": 2, "latestDefinitionVersionId": definition(2), "candidateEvaluation": None,
            "updatedAt": STAMP, "retiredAt": None, "versions": [{"definitionVersion": n, "definitionVersionId": definition(n), "publishedAt": STAMP, "active": n == 1} for n in (1, 2)], "evaluations": []}
        principal = f"agent:{A}:0123456789abcdef"
        self.grants = [{"explanation": "Exact scoped context grant · " + LONG, "manageable": True, "record": {
            "schemaVersion": 1, "tenantId": self.tenant, "grantKind": "context", "grantId": GRANT, "grantGeneration": 1, "granteeKind": "agent", "granteeId": principal,
            "granteePrincipalGeneration": 2, "purposeId": "memory.retrieve.v1", "target": {"visibility": "agent_private", "ownerActorId": OWNER, "ownerAgentId": principal,
                "ownerAgentPrincipalGeneration": 2, "workspaceId": None, "projectId": None, "missionId": None, "resourceIds": ["memory:" + "exact_" * 20]},
            "notBefore": STAMP, "expiresAt": "2027-10-03T12:00:00.000Z", "state": "active", "lifecycleRevision": 1, "createdByActorId": OWNER,
            "activatedByActorId": OWNER, "revokedByActorId": None, "createdAt": STAMP, "activatedAt": STAMP, "revokedAt": None, "updatedAt": STAMP,
            "operationIds": None, "maxItems": 24, "maxBytes": 48000, "maxInvocations": None, "maxCostMicrousd": None, "maxDurationMs": None}}]
        self.adaptations = [{"schemaVersion": 1, "version": "p7.6-agent-adaptation:1", "adaptationId": ADAPTATION, "agentId": A, "ownerBindingSha256": "a" * 64,
            "observedDefinitionVersion": 1, "state": "observed", "lifecycleRevision": 0, "evidence": [{"evidenceId": "evidence:" + "exact_" * 20,
                "kind": "run_feedback", "sourceId": "run:" + "evidence_" * 20, "sourceSha256": "b" * 64, "verdict": "needs_work", "groundingStatus": "verified", "observedAt": STAMP}],
            "evidenceSha256": "c" * 64, "confidence": .9, "effect": {"kind": "instruction_guidance", "guidance": TEXT, "guidanceSha256": "d" * 64,
                "authorityImpact": "none", "effectSha256": "e" * 64}, "evaluation": None, "activationVersion": None, "activatedAt": None, "rolledBackAt": None, "createdAt": STAMP, "updatedAt": STAMP}]
        self.task_state, self.task_revision = "working", 3
        self.adaptation_definition = 1

    def agent(self, identity, name, manageable=True):
        return {"id": identity, "tenantId": self.tenant, "actorId": self.actor, "slug": name.lower().replace(" ", "-"), "name": name, "role": "Evidence specialist",
            "description": LONG, "instructions": TEXT, "persona": {"schemaVersion": 1, "charter": "Review exact evidence and retain uncertainty. " + LONG,
                "operatingStyle": TEXT, "voice": "Direct and careful.", "visualIdentity": "Synthetic neutral Agent identity.", "allowedDomains": ["Research", "Source review"],
                "escalationBehavior": "Request review before expanding authority.", "successMeasures": ["Evidence remains traceable.", "Exact identities are retained."]},
            "status": "ready", "accent": "emerald", "modelPolicy": "auto", "autonomy": "governed", "approvalPolicy": "risk_based", "memoryScope": "session",
            "skillIds": [SKILL], "toolIds": ["knowledge.search"], "createdAt": STAMP, "updatedAt": STAMP, "selectable": manageable, "manageable": manageable,
            "releaseState": "active", "activeDefinitionVersion": 1, "latestDefinitionVersion": 2}

    def council(self, empty=False):
        cost = {"authority": "ai_usage_ledger_v1", "state": "exact", "receiptCount": 1, "unknownCostReceiptCount": 0, "totalTokens": 420, "knownEstimatedCostMicrousd": 1250}
        identity = {"agentId": A, "name": "Synthetic Agent A", "role": "Evidence specialist", "charter": LONG, "visualIdentity": "Neutral synthetic identity", "definitionVersion": 1, "source": "agent_definition"}
        member = {"taskId": TASK, "delegationId": "delegation:exact-synthetic", "identity": identity, "state": self.task_state, "lifecycleRevision": self.task_revision,
            "canCancel": self.task_state == "working", "runtime": None, "currentWork": TEXT, "updatedAt": STAMP,
            "authority": {"source": "delegation_grants", "receiptSha256": "a" * 64, "contractSha256": "b" * 64, "purpose": "Review synthetic evidence only.",
                "scope": {"workspaceId": "workspace:synthetic", "projectId": None, "missionId": None}, "context": {"state": "granted", "grantCount": 1},
                "capabilities": {"state": "granted", "grantCount": 1}, "tools": {"state": "granted", "ids": ["knowledge.search"]},
                "budgets": {"modelTurns": 2, "tokens": 1000, "costMicrousd": 10000, "wallTimeMs": 60000, "toolCalls": 2, "browserActions": 0}},
            "messages": {"state": "available", "items": [{"messageId": "message:" + "exact_" * 20, "kind": "evidence", "body": TEXT, "direction": "received", "createdAt": STAMP, "trust": "untrusted_shared_content"}]},
            "outputs": {"state": "shared", "items": [{"artifactId": "artifact:" + "exact_" * 20, "title": LONG, "kind": "report", "mediaType": "text/plain", "content": TEXT, "createdAt": STAMP, "trust": "untrusted_shared_content"}], "proposalReceiptSha256": None},
            "cost": cost, "confidence": .91, "verifier": {"identity": {**identity, "agentId": "sentinel", "name": "Sentinel", "role": "Critic"},
                "runtime": None, "acceptanceThreshold": .8, "method": "deterministic_schema_and_evidence", "verdict": "pending", "score": None}}
        second = copy.deepcopy(member)
        second.update({"taskId": OTHER_TASK, "delegationId": "delegation:second", "identity": {**identity, "agentId": B, "name": "Synthetic Agent B"}, "canCancel": False, "state": "waiting"})
        rows = [] if empty else [{"parentExecutionId": RUN, "href": "/app/command?run=" + quote(RUN, safe=""), "status": "running", "currentWork": "Synthetic delegated review", "startedAt": STAMP, "updatedAt": STAMP, "members": [member, second], "verifierCost": cost}]
        return {"version": "p11.5-agent-council-map:1", "authority": "canonical_delegation_ledger", "generatedAt": STAMP, "state": "empty" if empty else "ready",
            "summary": {"executionCount": len(rows), "memberCount": 0 if empty else 2, "activeMemberCount": 0 if empty else (2 if self.task_state == "working" else 1), "waitingMemberCount": 0 if empty else 1, "acceptedMemberCount": 0, "knownEstimatedCostMicrousd": 0 if empty else 3750}, "executions": rows}

    def authority(self, task=TASK):
        return {"task": {"executionId": task, "delegateAgentId": A if task == TASK else B, "authority": {"immutable": True, "contractSha256": "b" * 64,
            "grantRequestSha256": "c" * 64, "validation": {"status": "current", "category": "all_grants", "validatedAt": STAMP},
            "nativeReadTools": [{"toolId": "knowledge.search", "managementHref": "/app/automation"}],
            "skills": [{"capabilityGrantId": "capability:" + "exact_" * 20, "skillId": SKILL, "skillVersion": 1, "skillVersionId": "skill-version:" + "pin_" * 30, "skillSha256": "d" * 64, "managementHref": "/app/automation?view=skills"}],
            "plugins": [], "mcpServers": []}}}

    def body(self, key, identity=None):
        empty = self.mode == "empty"
        if key == "agents": return {"agents": [] if empty else self.agents, "builtIns": [{"id": "atlas", "name": "Atlas"}]}
        if key == "skills": return {"skills": [] if empty else [self.skill]}
        if key == "tools": return {"tools": [{"id": "knowledge.search", "name": "Search knowledge", "category": "knowledge", "riskLevel": 0}]}
        if key == "performance": return {"agents": [] if empty else [{"agentId": "scout", "primaryAssignments": 4, "collaborations": 2, "completed": 3, "failed": 1, "completionRate": .75, "verifiedAnswers": 2, "memoriesFormed": 1, "usefulOutcomes": 2, "needsWorkOutcomes": 1, "userApprovalRate": 2/3, "lastActiveAt": STAMP}]}
        if key == "council": return {"map": self.council(empty)}
        if key == "learning": return {"learning": {"schemaVersion": 1, "version": "agent-daily-learning-status:1", "agentId": identity, "definitionVersion": 1, "projectedAt": STAMP, "availability": "ready", "latestCompletedDay": None, "pendingReviewedAdaptationCount": 0, "contentIncluded": False, "privateReasoningIncluded": False, "authorityImpact": "none"}}
        if key == "release": return {"release": self.release_record}
        if key == "grants": return {"grants": self.grants if identity == A else []}
        if key == "adaptations": return {"definitionVersion": self.adaptation_definition, "adaptations": self.adaptations if identity == A else []}
        if key == "task": return self.authority(identity)
        raise AssertionError(key)

    def plan(self, key, *, identity=None, hold=None, body=None, status=200):
        self.plans[(key, identity)].append({"hold": hold, "body": copy.deepcopy(body), "status": status})

    def expect_effect(self, path, method, body, reply, *, hold=None):
        self.effects.append({"path": path, "method": method, "body": copy.deepcopy(body), "reply": copy.deepcopy(reply), "hold": hold})

    def mutation(self, route, path):
        request = route.request
        try: body = request.post_data_json
        except Exception: body = None
        expected = self.effects[0] if self.effects else None
        key = request.headers.get("idempotency-key", "")
        if expected and len(self.writes) < 8 and not urlsplit(request.url).query and request.headers.get("content-type", "").startswith("application/json") and request.method == expected["method"] and path == expected["path"] and body == expected["body"] and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", key):
            self.effects.popleft()
            self.writes.append({"path": path, "method": request.method, "body": body, "idempotencyKey": key, "disposition": "wholly_intercepted_synthetic_receipt"})
            if expected["hold"]: self.held[expected["hold"]] = (route, expected["reply"], 200); return
            return self.fulfill(route, expected["reply"])
        self.unexpected.append({"kind": "write", "path": path, "method": request.method, "body": body})
        return self.fulfill(route, {"error": "Unexpected Agent action blocked."}, 503)

    def route(self, route):
        p = urlsplit(route.request.url)
        if f"{p.scheme}://{p.netloc}" != self.origin: return super().route(route)
        if route.request.resource_type == "media":
            self.unexpected.append({"kind": "media_bytes", "path": p.path}); return route.abort()
        if route.request.method != "GET" and p.path.startswith("/api/"): return self.mutation(route, p.path)
        path, query, identity = unquote(p.path), parse_qs(p.query), None
        if path == "/api/agents": key, expected = "agents", {"ownerScope": ["readable"]}
        elif path in ("/api/skills", "/api/tools", "/api/agents/performance"): key, expected = path.rsplit("/", 1)[-1], {}
        elif path == "/api/agents/council": key, expected = "council", {"limit": ["60"]}
        elif path.startswith("/api/agents/tasks/"):
            key, identity, expected = "task", path.removeprefix("/api/agents/tasks/"), {}
            if identity not in (TASK, OTHER_TASK): self.unexpected.append({"kind": "unknown_task", "path": path}); return self.fulfill(route, {"error": "Unknown fixture task"}, 400)
        else:
            match = re.fullmatch(r"/api/agents/([^/]+)/(learning|release|grants|adaptations)", path)
            if not match: return super().route(route)
            identity, key = match.groups(); expected = {}
            if identity not in (A, B, "atlas", "scout", "forge", "sentinel", "memory"):
                self.unexpected.append({"kind": "unknown_agent", "path": path}); return self.fulfill(route, {"error": "Unknown fixture Agent"}, 400)
        if query != expected or len(self.requests) >= 500:
            self.unexpected.append({"kind": "read_budget_or_shape", "path": path, "query": query}); return self.fulfill(route, {"error": "Unexpected bounded read"}, 400)
        self.requests.append({"key": key, "identity": identity, "query": query})
        plan = self.plans[(key, identity)].popleft() if self.plans[(key, identity)] else {}
        status, body = plan.get("status", 200), plan.get("body")
        if body is None:
            if self.mode == "error": status, body = 503, {"error": f"Synthetic {key} unavailable."}
            else: body = self.body(key, identity)
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
