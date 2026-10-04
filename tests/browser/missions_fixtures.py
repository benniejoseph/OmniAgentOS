"""Bounded public legacy Mission projections. Every application mutation is blocked."""

import copy
import re
from collections import defaultdict, deque
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"
TASK = "44444444-4444-4444-8444-444444444444"
ATTEMPT = "55555555-5555-4555-8555-555555555555"
ARTIFACT = "66666666-6666-4666-8666-666666666666"
LONG = "ExactEvidence_" + "x" * 170
LITERAL = "<script>window.untrustedMissionRan=true</script> & <reviewed>"


def canonical(domain, state):
    return {"schemaVersion": 1, "status": {"succeeded": "unverified", "waiting": "waiting", "draft": "preview"}.get(state, state),
            "domain": domain, "basis": "legacy_status", "source": "legacy_adapter", "sourceStatus": state, "verificationState": "unassessed"}


def work(mid, task=None, state="succeeded"):
    return {"version": "p11.4-work-item-surface:1", "projection": {"authority": "canonical_work_item_v1", "sha256": None, "sourceRevisionSha256": None},
            "status": {"schemaVersion": 1, "authority": "canonical_work_item_v1", "persistence": "postgres", "workspaceId": None,
                       "projectId": "mission_project:" + mid, "workItemId": task or "mission_root:" + mid, "kind": "task" if task else "milestone",
                       "sourceAuthority": "legacy_mission_task" if task else "legacy_mission", "sourceId": task or mid,
                       "status": canonical("mission", state)["status"], "sourceStatus": state, "statusRevision": 1, "updatedAt": STAMP},
            "assignment": {"authority": "canonical_work_item_v1", "agents": []},
            "artifacts": {"authority": "canonical_work_item_v1", "count": 1, "items": [{"artifactId": ARTIFACT, "kind": "handoff", "evidenceCount": 1}]},
            "execution": {"authority": "governed_workflow_v1", "availability": "unavailable", "workflowRunId": None, "sourceStatus": None, "currentStep": None, "completedSteps": 0, "totalSteps": 0, "progressPercent": None, "updatedAt": None},
            "cost": {"authority": "ai_usage_ledger_v1", "state": "unknown", "usageReceiptCount": 1, "unknownCostReceiptCount": 1, "totalTokens": 0, "knownEstimatedCostMicrousd": 0}}


def mission(mid=A, title=None):
    state = "waiting" if mid == B else "succeeded"
    wi = work(mid, state=state)
    value = {"id": mid, "title": title or {A: "Archived research " + LONG, B: "Readable legacy summary", C: "Bookmarked outside the returned window"}[mid],
             "objective": "Historical evidence and immutable decisions. " + LITERAL, "status": state, "canonicalStatus": canonical("mission", state),
             "priority": "normal", "source": "synthetic_history", "createdAt": STAMP, "updatedAt": STAMP,
             "detailAvailable": mid != B, "manageable": mid != B, "runnable": False, "workItemStatus": wi["status"], "workItem": wi}
    if state == "succeeded":
        value["terminalAt"] = STAMP
    return value


def detail(mid=A, title=None):
    wi = work(mid, TASK)
    task = {"id": TASK, "missionId": mid, "title": "Reviewed historical task", "instructions": "Read the exact evidence. " + LITERAL,
            "definitionOfDone": "Keep legacy completion unverified unless the canonical receipt verifies it.", "status": "succeeded",
            "canonicalStatus": canonical("mission_task", "succeeded"), "priority": "normal", "position": 0,
            "dependencyIds": [B], "metadata": {"reviewRequired": True, "reviewerName": "Synthetic reviewer", "reviewSummary": LITERAL},
            "createdAt": STAMP, "updatedAt": STAMP, "terminalAt": STAMP, "workItemStatus": wi["status"], "workItem": wi}
    attempt = {"id": ATTEMPT, "missionId": mid, "taskId": TASK, "executorType": "agent_run", "status": "succeeded",
               "canonicalStatus": canonical("mission_attempt", "succeeded"), "agentRunId": "history-run-exact", "workflowRunId": "wf_" + "a" * 40,
               "createdAt": STAMP, "updatedAt": STAMP, "terminalAt": STAMP}
    artifact = {"id": ARTIFACT, "missionId": mid, "taskId": TASK, "attemptId": ATTEMPT, "kind": "handoff", "title": "Exact public evidence " + LONG,
                "uri": "https://example.test/evidence?id=" + LONG, "mimeType": "text/plain", "data": {"summary": LITERAL, "verification": "Unverified legacy result", "artifactIds": [ARTIFACT]},
                "createdAt": STAMP, "updatedAt": STAMP}
    return {"mission": mission(mid, title), "tasks": [task], "attempts": [attempt], "artifacts": [artifact]}


def events(after=0):
    rows = [{"seq": number, "type": "mission.recorded." + str(number), "at": STAMP} for number in range(after + 1, min(after + 25, 28) + 1)]
    return {"cursor": rows[-1]["seq"] if rows else after, "changed": bool(rows), "mission": {"status": "succeeded", "updatedAt": STAMP}, "events": rows}


def replacement_session(session, *, user_id=None, role=None):
    """Keep the real session envelope coherent while replacing only its scope."""
    value = copy.deepcopy(session)
    if user_id is not None:
        value["user"]["id"] = user_id
        value["membership"]["userId"] = user_id
        value["context"]["auth"]["userId"] = user_id
    if role is not None:
        value["membership"]["role"] = role
        value["context"]["role"] = role
    assert value["authEnabled"] is True and value["authenticated"] is True
    assert re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value["user"]["id"])
    assert value["user"]["id"] == value["membership"]["userId"] == value["context"]["auth"]["userId"]
    assert value["tenant"]["id"] == value["membership"]["tenantId"] == value["context"]["tenantId"]
    assert value["context"]["actorId"] and value["user"]["status"] == value["membership"]["status"] == "active"
    assert value["context"]["role"] == value["membership"]["role"] in ("viewer", "operator", "admin", "system")
    return value


class MissionFixtures(Fixtures):
    def __init__(self, origin):
        super().__init__(origin)
        self.requests = []
        self.defaults = {}
        self.plans = defaultdict(deque)
        self.held = {}
        self.release_results = []
        self.missions = [mission(A), mission(B)]
        self.titles = {}
        self.session_plan = None
        self.session_requests = []

    def plan(self, key, body, status=200, hold=None):
        self.plans[key].append({"body": body, "status": status, "hold": hold})

    def plan_session(self, session, hold=None):
        self.session_plan = {"body": replacement_session(session), "status": 200, "hold": hold}

    def route(self, route):
        parsed = urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        if parsed.path == "/api/auth/session" and self.session_plan is not None:
            if route.request.method != "GET" or parsed.query:
                self.unexpected.append({"kind": "session_contract", "method": route.request.method, "query": parsed.query})
                return route.abort()
            value = self.session_plan["body"]
            self.session_requests.append({"userId": value["user"]["id"], "actorId": value["context"]["actorId"], "role": value["membership"]["role"]})
            return self.answer(route, self.session_plan)
        if not parsed.path.startswith("/api/missions"):
            return super().route(route)
        if route.request.method != "GET":
            self.unexpected.append({"kind": "mission_effect", "path": parsed.path, "method": route.request.method})
            return route.abort()
        query = parse_qs(parsed.query)
        if parsed.path == "/api/missions":
            if query != {"ownerScope": ["readable"], "limit": ["50"]}:
                self.unexpected.append({"kind": "list_bounds", "query": query})
                return route.abort()
            key, body = "list", {"missions": self.missions, "requestReadContracts": {"missions": "readable_v1"}}
        else:
            match = re.fullmatch(r"/api/missions/([a-f0-9-]{36})(/events)?", parsed.path)
            if not match or match[1] not in (A, B, C):
                self.unexpected.append({"kind": "mission_route", "path": parsed.path})
                return route.abort()
            mid = match[1]
            if match[2]:
                if set(query) != {"afterSeq", "limit"} or query["limit"] != ["25"] or not re.fullmatch(r"\d+", query["afterSeq"][0]):
                    self.unexpected.append({"kind": "event_bounds", "query": query})
                    return route.abort()
                after = int(query["afterSeq"][0])
                key, body = f"events:{mid}:{after}", events(after)
            elif query == {"ownerScope": ["readable"], "view": ["summary"]}:
                key, body = "summary:" + mid, {"mission": mission(mid, self.titles.get(mid)), "requestReadContracts": {"missionSummary": "readable_v1"}}
            elif not query:
                key, body = "detail:" + mid, detail(mid, self.titles.get(mid))
            else:
                self.unexpected.append({"kind": "detail_contract", "query": query})
                return route.abort()
        self.requests.append({"key": key, "path": parsed.path, "query": query})
        if len(self.requests) > 150:
            self.unexpected.append({"kind": "read_budget"})
            return route.abort()
        spec = self.plans[key].popleft() if self.plans[key] else self.defaults.get(key, {"body": body, "status": 200})
        return self.answer(route, spec)

    def answer(self, route, spec):
        spec = copy.deepcopy(spec)
        if spec.get("hold"):
            name = spec["hold"]
            while name in self.held:
                name += ":again"
            self.held[name] = (route, spec)
            return
        return self.fulfill(route, spec["body"], spec.get("status", 200))

    def release_prefix(self, prefix):
        for name in list(self.held):
            if name == prefix or name.startswith(prefix + ":"):
                route, spec = self.held.pop(name)
                try:
                    self.fulfill(route, spec["body"], spec.get("status", 200))
                    self.release_results.append({"name": name, "result": "fulfilled"})
                except PlaywrightError:
                    self.release_results.append({"name": name, "result": "already_aborted"})

    def abort_held(self):
        for route, _ in self.held.values():
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.held.clear()
