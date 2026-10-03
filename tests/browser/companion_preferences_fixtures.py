"""Exact synthetic Companion receipts. Only predeclared preference PATCHes are permitted.

This is a browser contract simulator, not evidence of durable backend persistence.
Every provider, model, advanced-settings and other application write is blocked.
"""

from collections import defaultdict, deque
import copy
import hashlib
import json
import re
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError

from fixtures import Fixtures, STAMP

PREFERENCES_PATH = "/api/companion/preferences"
THREADS_PATH = "/api/threads"
HOME_A = "11111111-1111-4111-8111-111111111111"
HOME_B = "22222222-2222-4222-8222-222222222222"
FOREIGN_HOME = "33333333-3333-4333-8333-333333333333"
LONG_TITLE = "Owned conversation — " + "full readable synthetic identity and project context " * 12
DEFAULTS = {"intensity": "balanced", "visible": True, "motion": "full", "defaultDestination": "assistant", "preferredThreadId": None}


def save_body(revision, **preferences):
    return {"action": "save", "expectedRevision": revision, "preferences": {**DEFAULTS, **preferences}}


class CompanionFixtures(Fixtures):
    def __init__(self, origin, tenant_id, actor_id):
        super().__init__(origin)
        self.tenant_id, self.actor_id = tenant_id, actor_id
        self.revision, self.preferences = 0, copy.deepcopy(DEFAULTS)
        self.receipts = {}
        self.plans = defaultdict(deque)
        self.actions = deque()
        self.held = {}
        self.requests, self.releases = [], []
        self.home_available = True

    def response(self):
        identity = self.preferences["preferredThreadId"]
        home_state = "not_set" if identity is None else "available" if self.home_available else "unavailable"
        home_href = f"/app/command?thread={identity}" if home_state == "available" else None
        destination = self.preferences["defaultDestination"]
        return {"schemaVersion": 1, "contract": "asael-companion-preferences:1",
                "snapshot": {"revision": self.revision, "persisted": self.revision > 0,
                             "updatedAt": STAMP if self.revision else None, "preferences": copy.deepcopy(self.preferences)},
                "home": {"state": home_state, "preferredThreadId": identity, "href": home_href, "fallbackHref": "/app/command"},
                "destination": {"href": {"assistant": home_href or "/app/command", "today": "/app", "activity": "/app/activity", "work": "/app/projects"}[destination],
                                "state": "fallback" if destination == "assistant" and identity and not home_href else "configured"}}

    def conversations(self):
        def row(identity, title, **extra):
            return {"id": identity, "tenantId": self.tenant_id, "actorId": self.actor_id,
                    "title": title, "mode": "orchestrate", "createdAt": STAMP, "updatedAt": STAMP, **extra}
        return {"threads": [row(HOME_A, "Owned short conversation"), row(HOME_B, LONG_TITLE),
                            row(FOREIGN_HOME, "FOREIGN_ACTOR_MUST_NOT_APPEAR", actorId="someone-else"),
                            row("44444444-4444-4444-8444-444444444444", "FOREIGN_TENANT_MUST_NOT_APPEAR", tenantId="other-tenant"),
                            row("legacy-opaque-id", "UNSUPPORTED_ID_MUST_NOT_APPEAR")]}

    def advance(self, **changes):
        """Simulate a separate confirmed preference change without making a request."""
        self.revision += 1
        self.preferences = {**self.preferences, **changes}

    def plan_read(self, path=PREFERENCES_PATH, *, body=None, status=200, hold=None):
        self.plans[path].append({"body": copy.deepcopy(body), "status": status, "hold": hold})

    def expect_patch(self, body, *, key=None, hold=None, drop=False, malformed=False):
        self.actions.append({"body": copy.deepcopy(body), "key": key, "hold": hold, "drop": drop, "malformed": malformed})

    def release(self, name):
        route, body, status = self.held.pop(name)
        try:
            self.fulfill(route, body, status)
            result = "fulfilled_or_client_canceled"
        except PlaywrightError:
            result = "client_canceled"
        self.releases.append({"name": name, "disposition": result})

    def abort_held(self):
        for name, (route, _, _) in list(self.held.items()):
            try:
                route.abort()
            except PlaywrightError:
                pass
            self.releases.append({"name": name, "disposition": "teardown_abort"})
        self.held.clear()

    def route(self, route):
        parsed = urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        path, method = parsed.path, route.request.method
        if path not in (PREFERENCES_PATH, THREADS_PATH):
            return super().route(route)
        if method != "GET":
            return self.mutation(route, path)
        query = parse_qs(parsed.query)
        if (path == PREFERENCES_PATH and query) or (path == THREADS_PATH and query != {"limit": ["100"]}) or len(self.requests) >= 80:
            self.unexpected.append({"kind": "unexpected_companion_read", "path": path, "query": query})
            return self.fulfill(route, {"error": "Unexpected bounded read."}, 400)
        self.reads.add(path)
        self.requests.append({"path": path, "query": query, "revision": self.revision})
        plan = self.plans[path].popleft() if self.plans[path] else {}
        body = plan.get("body")
        if body is None:
            body = self.response() if path == PREFERENCES_PATH else self.conversations()
        if plan.get("hold"):
            self.held[plan["hold"]] = (route, copy.deepcopy(body), plan.get("status", 200))
            return
        return self.fulfill(route, body, plan.get("status", 200))

    def mutation(self, route, path):
        request = route.request
        try:
            body = request.post_data_json
        except Exception:
            body = None
        plan = self.actions[0] if self.actions else None
        key = request.headers.get("idempotency-key", "")
        allowed = (path == PREFERENCES_PATH and request.method == "PATCH" and plan and body == plan["body"] and
                   len(self.writes) < 12 and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", key) and
                   (plan["key"] is None or plan["key"] == key) and
                   request.headers.get("content-type", "").startswith("application/json"))
        if not allowed:
            self.unexpected.append({"kind": "write", "path": path, "method": request.method, "body": body})
            return self.fulfill(route, {"error": "Undeclared application mutation blocked."}, 503)
        self.actions.popleft()
        serialized = request.post_data
        status = 200
        if key in self.receipts:
            original, receipt = self.receipts[key]
            if original != serialized:
                response, status = {"error": "Different request with this key.", "code": "companion_idempotency_conflict", "reload": True}, 409
            else:
                response = self.response()
                response["mutation"] = {**copy.deepcopy(receipt), "outcome": "replayed"}
        elif body["expectedRevision"] != self.revision:
            response, status = {"error": "Preferences changed.", "code": "companion_revision_conflict", "reload": True}, 409
        else:
            self.revision += 1
            self.preferences = copy.deepcopy(DEFAULTS if body["action"] == "reset" else body["preferences"])
            receipt = {"outcome": "saved", "receiptId": "companion:" + hashlib.sha256(key.encode()).hexdigest(),
                       "revision": self.revision, "savedAt": STAMP, "preferences": copy.deepcopy(self.preferences)}
            self.receipts[key] = (serialized, receipt)
            response = self.response()
            response["mutation"] = copy.deepcopy(receipt)
        if plan["malformed"]:
            response = {}
        self.writes.append({"path": path, "method": request.method, "body": body, "serializedBody": serialized,
                            "idempotencyKey": key, "status": status,
                            "disposition": "synthetic_commit_then_transport_drop" if plan["drop"] else "synthetic_held" if plan["hold"] else "synthetic_receipt"})
        if plan["drop"]:
            return route.abort("failed")
        if plan["hold"]:
            self.held[plan["hold"]] = (route, copy.deepcopy(response), status)
            return
        return self.fulfill(route, response, status)
