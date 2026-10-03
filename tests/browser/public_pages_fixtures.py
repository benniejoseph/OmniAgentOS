"""Exact read-only public health fixtures; no account or application effects."""

import copy
import json
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError

STAMP = "2026-10-04T12:00:00.000Z"


class PublicFixtures:
    def __init__(self, origin):
        self.origin = origin
        self.health = {"body": {"status": "healthy", "checkedAt": STAMP}, "status": 200}
        self.reads, self.writes, self.unexpected, self.releases = [], [], [], []
        self.held = {}

    def plan_health(self, body, status=200, hold=None):
        self.health = {"body": copy.deepcopy(body), "status": status, "hold": hold}

    @staticmethod
    def fulfill(route, body, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body),
                      headers={"cache-control": "private, no-store"})

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path = parsed.path
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            self.unexpected.append({"kind": "external", "path": path})
            return route.abort()
        if path == "/__nextjs_original-stack-frames" and request.method == "POST":
            # Development diagnostics are fulfilled locally, never sent onward.
            return self.fulfill(route, {"results": []})
        if request.method not in ("GET", "HEAD"):
            self.writes.append({"method": request.method, "path": path})
            return self.fulfill(route, {"error": "Application writes blocked by public fixture."}, 409)
        if not path.startswith("/api/"):
            return route.continue_()
        if path == "/api/health" and request.method == "GET" and parsed.query == "public=1":
            self.reads.append({"method": "GET", "path": path, "query": parsed.query})
            plan = copy.deepcopy(self.health)
            if plan.get("hold"):
                stem, name, suffix = plan["hold"], plan["hold"], 1
                while name in self.held:
                    name = f"{stem}-{suffix}"
                    suffix += 1
                self.held[name] = (route, plan)
                return
            return self.fulfill(route, plan["body"], plan["status"])
        self.unexpected.append({"kind": "api_read", "method": request.method, "path": path, "query": parsed.query})
        return self.fulfill(route, {"error": "Unexpected API read blocked by public fixture."}, 503)

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
