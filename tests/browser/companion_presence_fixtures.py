"""Read-only, exact Companion/Command projections. No application effects pass."""

from collections import deque
import copy
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError

from fixtures import Fixtures, STAMP

PREFERENCES_PATH = "/api/companion/preferences"
THREAD_ID = "11111111-1111-4111-8111-111111111111"
HOME_ID = "22222222-2222-4222-8222-222222222222"
RUN_ID = "presence-run-" + "full-source-identity-" * 9
DEFAULTS = {"intensity": "balanced", "visible": True, "motion": "full", "defaultDestination": "assistant", "preferredThreadId": None}


def preferences(*, visible=True, intensity="balanced", motion="full", home_state="available"):
    identity = None if home_state == "not_set" else HOME_ID
    href = f"/app/command?thread={identity}" if home_state == "available" else None
    return {"schemaVersion": 1, "contract": "asael-companion-preferences:1",
            "snapshot": {"revision": 1, "persisted": True, "updatedAt": STAMP,
                         "preferences": {**DEFAULTS, "visible": visible, "intensity": intensity, "motion": motion, "preferredThreadId": identity}},
            "home": {"state": home_state, "preferredThreadId": identity, "href": href, "fallbackHref": "/app/command"},
            "destination": {"href": href or "/app/command", "state": "fallback" if identity and not href else "configured"}}


def terminal_receipt(partial=False):
    results = [{"requirementId": "criterion-a", "requirementKind": "criterion", "requirementLevel": "required",
                "state": "verified", "verificationMethod": "deterministic", "verifierId": "verifier-a", "verificationReceiptId": "verification-a"}]
    if partial:
        results.append({"requirementId": "criterion-b", "requirementKind": "criterion", "requirementLevel": "required",
                        "state": "unverified", "verificationMethod": "deterministic", "verifierId": None, "verificationReceiptId": None})
    return {"schemaVersion": 1, "terminalReceiptId": "receipt-a", "runId": RUN_ID, "outcomeContractId": "contract-a",
            "source": "outcome_evaluator", "legacyStatus": None, "disposition": "partial" if partial else "succeeded",
            "executionMode": "live", "verificationState": "partially_verified" if partial else "verified",
            "reasonCode": "requirements_unmet" if partial else "all_requirements_verified", "requirementResults": results,
            "requiredRequirementCount": len(results), "verifiedRequirementCount": 1, "failedRequirementCount": 0,
            "unverifiedRequirementCount": 1 if partial else 0, "usefulWorkUnitCount": 1,
            "artifactReceiptIds": [], "effectReceiptIds": [], "verifierReceiptIds": ["verification-a"],
            "pendingApprovalIds": [], "blockingDependencyIds": [], "outputSha256": None}


class PresenceFixtures(Fixtures):
    def __init__(self, origin, tenant_id, actor_id):
        super().__init__(origin)
        self.tenant_id, self.actor_id = tenant_id, actor_id
        self.preferences = preferences()
        self.run_mode = "verified"
        self.preference_plans, self.home_plans = deque(), deque()
        self.preference_hold = None
        self.requests, self.releases, self.held = [], [], {}
        self.asset_failure = False

    def thread(self, identity=THREAD_ID):
        return {"id": identity, "tenantId": self.tenant_id, "actorId": self.actor_id,
                "title": "Owned home conversation" if identity == HOME_ID else "Original conversation",
                "mode": "orchestrate", "createdAt": STAMP, "updatedAt": STAMP}

    def run(self):
        status = self.run_mode if self.run_mode in ("queued", "running", "failed", "canceled") else "completed"
        row = {"id": RUN_ID, "threadId": THREAD_ID, "agentId": "atlas", "mode": "orchestrate", "status": status,
               "prompt": "Synthetic saved request", "response": "Saved synthetic response. No provider was called.",
               "startedAt": STAMP, "grounding": {"status": "not_required"}}
        if status in ("completed", "failed", "canceled"):
            row["completedAt"] = STAMP
        if self.run_mode in ("verified", "partial", "mismatched"):
            row["terminalReceipt"] = terminal_receipt(self.run_mode == "partial")
            if self.run_mode == "mismatched":
                row["terminalReceipt"]["runId"] = "another-run"
        if self.run_mode == "legacy":
            # A success-like public projection without a full bound receipt is
            # deliberately insufficient for the Companion completion state.
            row["canonicalStatus"] = {"status": "succeeded", "verificationState": "verified"}
        return row

    def plan_preferences(self, *, body=None, status=200, hold=None):
        self.preference_plans.append({"body": copy.deepcopy(self.preferences if body is None else body), "status": status, "hold": hold})

    def plan_home(self, *, body=None, status=200, hold=None):
        self.home_plans.append({"body": body or {"thread": self.thread(HOME_ID), "turns": [], "summaries": []}, "status": status, "hold": hold})

    def answer(self, route, plan):
        if plan.get("hold"):
            name = plan["hold"]
            suffix = 1
            while name in self.held:
                name = f'{plan["hold"]}-{suffix}'
                suffix += 1
            self.held[name] = (route, copy.deepcopy(plan["body"]), plan["status"])
            return
        return self.fulfill(route, plan["body"], plan["status"])

    def release(self, name):
        route, body, status = self.held.pop(name)
        try:
            self.fulfill(route, body, status)
            result = "fulfilled"
        except PlaywrightError:
            result = "client_canceled"
        self.releases.append({"name": name, "disposition": result})

    def release_preferences(self):
        plan, self.preference_hold = self.preference_hold, None
        for name in list(self.held):
            if name == plan["hold"] or name.startswith(plan["hold"] + "-"):
                self.release(name)

    def abort_held(self):
        for route, _, _ in self.held.values():
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.held.clear()

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        path = parsed.path
        if path.startswith(("/api/auth/google", "/api/voice")):
            self.unexpected.append({"kind": "forbidden_effect_route", "path": path})
            return self.fulfill(route, {"error": "OAuth and voice effects are blocked."}, 503)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return super().route(route)
        if path == "/companion/atlas-v1/manifest.json":
            # This suite proves the approved neutral fallback independently of
            # any later reviewed production-art publication.
            return route.fulfill(status=404, content_type="text/plain", body="Synthetic production artwork unavailable")
        if path == "/companion/atlas-neutral.png" and self.asset_failure:
            return route.fulfill(status=404, content_type="text/plain", body="Synthetic portrait unavailable")
        allowed = (PREFERENCES_PATH, "/api/threads", f"/api/threads/{THREAD_ID}", f"/api/threads/{HOME_ID}", f"/api/runs/{RUN_ID}")
        if path not in allowed:
            return super().route(route)
        query = parse_qs(parsed.query)
        if request.method != "GET" or (query and not (path == "/api/threads" and query == {"limit": ["100"]})) or len(self.requests) >= 250:
            self.unexpected.append({"kind": "unexpected_read", "path": path, "query": query})
            return self.fulfill(route, {"error": "Unexpected read shape."}, 400)
        self.requests.append({"path": path, "query": query, "runMode": self.run_mode})
        self.reads.add(path)
        if path == PREFERENCES_PATH:
            if self.preference_hold:
                return self.answer(route, self.preference_hold)
            return self.answer(route, self.preference_plans.popleft()) if self.preference_plans else self.fulfill(route, self.preferences)
        if path == "/api/threads":
            return self.fulfill(route, {"threads": [self.thread(), self.thread(HOME_ID)]})
        if path == f"/api/runs/{RUN_ID}":
            return self.fulfill(route, {"run": self.run(), "mediaArtifacts": [], "fileArtifacts": [], "fileArtifactState": "none", "workspaceArtifacts": [], "workspaceArtifactState": "none"})
        if path == f"/api/threads/{HOME_ID}" and self.home_plans:
            return self.answer(route, self.home_plans.popleft())
        identity = HOME_ID if path.endswith(HOME_ID) else THREAD_ID
        turns = [] if identity == HOME_ID else [{"id": "saved-turn", "role": "assistant", "content": "Saved synthetic response.", "runId": RUN_ID, "createdAt": STAMP}]
        return self.fulfill(route, {"thread": self.thread(identity), "turns": turns, "summaries": []})

    def mutation(self, route, path):
        self.unexpected.append({"kind": "write", "path": path, "method": route.request.method})
        return self.fulfill(route, {"error": "Every application mutation is blocked in the presence suite."}, 503)
