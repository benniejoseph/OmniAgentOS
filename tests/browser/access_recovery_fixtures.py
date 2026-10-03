"""Bounded access fixtures. Credential POSTs are synthetic and never forwarded."""

from collections import deque
import copy
import json
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError

EMAIL = "synthetic-access@example.test"
PASSWORD = "synthetic-password-never-sent"
ANONYMOUS = {"authEnabled": True, "authenticated": False, "googleLoginConfigured": False}


class AccessFixtures:
    def __init__(self, origin):
        self.origin = origin
        self.session = {"body": ANONYMOUS, "status": 200}
        self.preferences = {"body": {"error": "Synthetic preferences unavailable."}, "status": 503}
        self.login_plans = deque()
        self.reads, self.writes, self.unexpected, self.releases = [], [], [], []
        self.held = {}

    def plan_session(self, body=None, *, status=200, hold=None, real=False):
        self.session = {"body": copy.deepcopy(ANONYMOUS if body is None else body), "status": status, "hold": hold, "real": real}

    def plan_login(self, body, *, status=401, hold=None):
        self.login_plans.append({"body": copy.deepcopy(body), "status": status, "hold": hold})

    @staticmethod
    def fulfill(route, body, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body),
                      headers={"cache-control": "private, no-store"})

    def answer(self, route, plan):
        if plan.get("hold"):
            stem, name, suffix = plan["hold"], plan["hold"], 1
            while name in self.held:
                name = f"{stem}-{suffix}"
                suffix += 1
            self.held[name] = (route, copy.deepcopy(plan))
            return
        return self.fulfill(route, plan["body"], plan["status"])

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path = parsed.path
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            self.unexpected.append({"kind": "external", "path": path})
            return route.abort()
        if path.startswith(("/api/auth/google", "/api/voice")):
            self.unexpected.append({"kind": "forbidden_provider_route", "path": path})
            return self.fulfill(route, {"error": "Provider routes blocked."}, 503)
        if path == "/__nextjs_original-stack-frames" and request.method == "POST":
            return self.fulfill(route, {"results": []})
        if request.method == "POST" and path == "/api/auth/login":
            try:
                body = request.post_data_json
            except Exception:
                body = None
            valid = (not parsed.query and body == {"email": EMAIL, "password": PASSWORD}
                     and request.headers.get("content-type", "").startswith("application/json"))
            record = {"method": "POST", "path": path, "exactSyntheticBody": valid, "forwarded": False}
            self.writes.append(record)
            if not valid or not self.login_plans:
                self.unexpected.append({"kind": "unplanned_login", **record})
                return self.fulfill(route, {"error": "Unexpected credential submission blocked."}, 409)
            plan = self.login_plans.popleft()
            record["status"] = plan["status"]
            record["hold"] = plan.get("hold")
            return self.answer(route, plan)
        if request.method not in ("GET", "HEAD"):
            self.unexpected.append({"kind": "write", "method": request.method, "path": path})
            return self.fulfill(route, {"error": "Every other application write is blocked."}, 409)
        if not path.startswith("/api/"):
            return route.continue_()
        if request.method == "GET" and not parsed.query and path in ("/api/auth/session", "/api/companion/preferences"):
            plan = self.session if path == "/api/auth/session" else self.preferences
            self.reads.append({"path": path, "realIsolatedRead": bool(plan.get("real"))})
            if len(self.reads) > 100:
                self.unexpected.append({"kind": "read_bound", "path": path})
                return self.fulfill(route, {"error": "Fixture read bound reached."}, 503)
            if plan.get("real"):
                return route.continue_()
            return self.answer(route, plan)
        self.unexpected.append({"kind": "api_read", "method": request.method, "path": path, "query": parsed.query})
        return self.fulfill(route, {"error": "Unexpected API read blocked."}, 503)

    def release(self, stem):
        for name in list(self.held):
            if name != stem and not name.startswith(stem + "-"):
                continue
            route, plan = self.held.pop(name)
            try:
                self.fulfill(route, plan["body"], plan["status"])
                disposition = "fulfilled"
            except PlaywrightError:
                disposition = "client_canceled"
            self.releases.append({"name": name, "disposition": disposition})

    def abort_held(self):
        for route, _ in self.held.values():
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.held.clear()
