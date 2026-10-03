"""Bounded synthetic Accounts reads and exact, locally fulfilled reviewed effects.

These are presentation fixtures, not evidence of CRM/provider execution. Server
schema/authorization correctness is covered separately by the real unit suites.
"""
from collections import defaultdict, deque
import copy
import hashlib
import json
import re
from urllib.parse import parse_qs, quote, unquote, urlsplit
from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

BASE = "/api/customer-accounts"
A, B, CREATED = ["customer-account:" + char * 64 for char in "abc"]
WORKSPACE = "workspace:browser-accounts"
LONG = "Exact customer source evidence " + "identity_" * 19
KINDS = ("organization", "contact", "stakeholder", "product", "opportunity", "case", "usage", "project", "interaction", "health", "risk", "renewal")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def seal(value, key):
    return {**value, key: digest(value)}


class AccountsFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.tenant = session["context"]["tenantId"]
        self.actor = session["context"].get("actorId") or session.get("user", {}).get("email") or "current-actor"
        self.context = {"scope": "workspace", "workspaceId": WORKSPACE, "accessLevel": "manager", "canWrite": True, "authoritySha256": "d" * 64}
        self.accounts = [self.account(A, "Synthetic customer A · " + LONG), self.account(B, "Synthetic customer B")]
        self.mode = "ready"
        self.plans, self.held, self.effects = defaultdict(deque), {}, deque()
        self.requests, self.releases = [], []
        self.scores, self.runs = {}, defaultdict(list)
        self.pack = [{"workflowId": "onboarding", "name": "Synthetic onboarding", "description": "Review customer evidence and create only an internal project.",
                      "definitionSha256": "e" * 64, "acceptanceCriteria": ["Review the exact account revision."],
                      "artifacts": [{"title": "Customer evidence review", "required": True}],
                      "evidenceRequirements": [{"title": "Exact account source", "required": True}]}]

    def account(self, identity, name, revision=1, lifecycle="active", owner=None):
        return seal({"schemaVersion": 1, "contractVersion": "p10.9-customer-account-360:1", "ontologyVersionId": "asael-ontology:1", "tenantId": self.tenant,
            "workspaceId": WORKSPACE, "accountId": identity, "accountEntityId": identity, "organizationEntityId": None,
            "revisionId": f"{identity}:v{revision}", "revision": revision, "previousRevisionId": None if revision == 1 else f"{identity}:v{revision-1}",
            "mutationId": "customer-mutation:" + "f" * 64, "name": name, "lifecycle": lifecycle,
            "accountOwner": owner or {"ownerKind": "actor", "ownerId": self.actor, "displayName": "Synthetic owner"},
            "crmPermissions": {"readScope": "workspace_members", "writeScope": "account_owner", "externalWriteState": "disabled",
                               "customerDataPurposeIds": ["customer_success.account.manage", "customer_success.account.read"]},
            "ownerActorId": "actor:11111111-1111-4111-8111-111111111111", "revisedByActorId": "actor:11111111-1111-4111-8111-111111111111", "revisedAt": STAMP}, "accountSha256")

    def selected(self, identity=A):
        return next(value for value in self.accounts if value["accountId"] == identity)

    def dossier(self, identity):
        account = self.selected(identity)
        values = []
        if identity == A:
            for index in range(7):
                fact_id = "customer-fact:" + digest([identity, index])
                value = {"kind": "renewal", "renewalId": "renewal:exact/" + str(index), "status": "planning", "renewalAt": "2027-01-01T00:00:00.000Z", "amountMinor": 10000 + index, "currency": "USD"}
                source = {"sourceKind": "manual", "sourceId": f"source:{index}", "sourceRevisionId": f"source:{index}:v1/" + "long_" * 30,
                          "sourceRevisionSha256": digest(["source", index]), "sourceLabel": LONG, "providerId": None, "providerObjectType": None, "providerObjectIdSha256": None,
                          "permissionBasis": "operator_assertion", "allowedPurposeIds": ["customer_success.account.read"], "observedAt": STAMP, "ingestedAt": STAMP}
                fact = seal({"schemaVersion": 1, "contractVersion": "p10.9-customer-account-360:1", "ontologyVersionId": "asael-ontology:1", "tenantId": self.tenant, "workspaceId": WORKSPACE,
                    "accountId": identity, "factId": fact_id, "factRevisionId": fact_id + ":v1", "revision": 1, "previousFactRevisionId": None, "mutationId": "customer-mutation:" + digest(index),
                    "factKey": "renewal.primary", "kind": "renewal", "value": value, "source": source, "owner": account["accountOwner"], "confidenceBasisPoints": 7500,
                    "validFrom": STAMP, "staleAfter": None, "recordedByActorId": account["ownerActorId"], "recordedAt": STAMP}, "factSha256")
                values.append({"fact": fact, "freshness": {"status": "fresh", "observedAt": STAMP, "staleAfter": None, "evaluatedAt": STAMP},
                    "conflict": {"state": "conflicting", "conflictingFactIds": ["customer-fact:" + digest([identity, (index+1) % 7])]}})
        return {"account": account, "facts": values, "factsByKind": {kind: [v for v in values if v["fact"]["kind"] == kind] for kind in KINDS},
                "historyCount": len(values) + account["revision"], "conflictCount": len(values), "staleCount": 0, "evaluatedAt": STAMP}

    def recommendation(self, identity):
        return {"title": "Review current source evidence", "reason": LONG, "action": "evaluate_health", "workflowId": None,
            "confidenceBasisPoints": 0, "freshness": {"status": "unknown", "evaluatedAt": STAMP, "oldestObservedAt": None},
            "suggested": True, "authoritative": False, "uncertainty": ["No current evaluation establishes account health."],
            "evidence": [{"kind": "account_revision", "refId": identity, "revisionId": self.selected(identity)["revisionId"], "sha256": self.selected(identity)["accountSha256"], "observedAt": STAMP, "label": LONG}]}

    def portfolio_item(self, identity):
        account = self.selected(identity)
        return {"accountId": identity, "accountRevisionId": account["revisionId"], "accountSha256": account["accountSha256"], "attention": "watch", "nextBestAction": self.recommendation(identity)}

    def intelligence(self, identity):
        return seal({"generatedAt": STAMP, "portfolio": self.portfolio_item(identity), "nextBestAction": self.recommendation(identity), "risks": [], "commitments": [],
            "approvals": [{"kind": "tool", "approvalId": "approval:account/+exact", "title": "Synthetic customer approval", "status": "approval_required", "riskLevel": 2, "createdAt": STAMP}],
            "timeline": [{"eventId": "customer-success-timeline:" + digest(index), "title": f"Exact source update {index}", "summary": LONG, "occurredAt": STAMP} for index in range(7)]}, "projectionSha256")

    def response(self, source, identity=None):
        if source == "list":
            return {"context": self.context, "accounts": [] if self.mode == "empty" else self.accounts}
        if source == "portfolio":
            values = [] if self.mode == "empty" else [self.portfolio_item(item["accountId"]) for item in self.accounts]
            return {"context": self.context, "portfolio": seal({"generatedAt": STAMP, "accounts": values, "counts": {"total": len(values), "urgent": 0, "attention": len(values), "pendingApprovals": len(values), "overdueCommitments": 0}}, "projectionSha256")}
        if source == "salesforce":
            return {"context": self.context, "health": {"workspaceId": WORKSPACE, "configured": True, "connected": True, "connectionId": "connection:synthetic/" + "identity"*20,
                "status": "degraded", "accessMode": "read_only", "objectScope": ["Account"], "cursor": None, "lagSeconds": None, "evaluatedAt": STAMP,
                "actionableError": {"message": "Synthetic Salesforce read is delayed. " + LONG, "action": "retry"}},
                "findings": [], "authorizeUrl": f"/api/oauth/salesforce/authorize?returnTo=%2Fapp%2Faccounts&workspaceId={quote(WORKSPACE, safe='')}", "webhook": {"configured": False},
                "writes": {"configured": False, "enabled": False, "mode": "approval_required", "createObjects": [], "updateObjects": [], "operations": []}}
        if source == "detail": return {"context": self.context, "account": self.dossier(identity)}
        if source == "health": return {"context": self.context, "policy": {"policyVersion": "asael-customer-health:1"}, "score": self.scores.get(identity), "history": [self.scores[identity]] if identity in self.scores else []}
        if source == "workflows": return {"context": self.context, "pack": self.pack, "runs": self.runs[identity]}
        if source == "intelligence": return {"context": self.context, "intelligence": self.intelligence(identity)}
        raise AssertionError(source)

    def plan(self, source, *, identity=None, hold=None, body=None, status=200):
        self.plans[(source, identity)].append({"hold": hold, "body": copy.deepcopy(body), "status": status})

    def expect_effect(self, path, method, body, reply, *, hold=None, status=200):
        self.effects.append({"path": path, "method": method, "body": copy.deepcopy(body), "reply": copy.deepcopy(reply), "hold": hold, "status": status})

    def mutation(self, route, path):
        request = route.request
        try: body = request.post_data_json
        except Exception: body = None
        expected = self.effects[0] if self.effects else None
        key = request.headers.get("idempotency-key", "")
        if (expected and len(self.writes) < 5 and path == expected["path"] and request.method == expected["method"] and body == expected["body"]
                and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", key)):
            self.effects.popleft()
            self.writes.append({"path": path, "method": request.method, "body": body, "idempotencyKey": key, "disposition": "wholly_intercepted_synthetic_receipt"})
            if expected["hold"]:
                self.held[expected["hold"]] = (route, expected["reply"], expected["status"])
                return
            return self.fulfill(route, expected["reply"], expected["status"])
        self.unexpected.append({"kind": "write", "path": path, "method": request.method, "body": body})
        return self.fulfill(route, {"error": "Unexpected Accounts mutation blocked."}, 503)

    def route(self, route):
        parsed = urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin or not parsed.path.startswith(BASE):
            return super().route(route)
        if route.request.method != "GET": return self.mutation(route, parsed.path)
        path, query = unquote(parsed.path), parse_qs(parsed.query)
        identity = None
        if path == BASE: source, expected = "list", {"limit": ["200"]}
        elif path == BASE + "/portfolio": source, expected = "portfolio", {"limit": ["200"]}
        elif path == BASE + "/salesforce": source, expected = "salesforce", {}
        else:
            matched = re.fullmatch(re.escape(BASE) + r"/(customer-account:[abc]{64})(?:/(health|workflows|intelligence))?", path)
            if not matched: self.unexpected.append({"kind": "unexpected_account_read", "path": path}); return self.fulfill(route, {"error": "Unexpected account identity"}, 400)
            identity, suffix = matched.groups(); source = suffix or "detail"
            expected = {"health": {"historyLimit": ["20"]}, "workflows": {"limit": ["50"]}, "intelligence": {"historyLimit": ["100"], "timelineLimit": ["100"]}, "detail": {}}[source]
        if query != expected or len(self.requests) >= 180:
            self.unexpected.append({"kind": "unbounded_account_read", "path": path, "query": query})
            return self.fulfill(route, {"error": "Unexpected read shape"}, 400)
        self.requests.append({"source": source, "identity": identity, "query": query})
        plan = self.plans[(source, identity)].popleft() if self.plans[(source, identity)] else {}
        status = plan.get("status", 200)
        body = plan.get("body")
        if body is None:
            if self.mode == "error": body, status = {"error": f"Synthetic {source} unavailable."}, 503
            else: body = self.response(source, identity)
        if plan.get("hold"):
            self.held[plan["hold"]] = (route, copy.deepcopy(body), status); return
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
