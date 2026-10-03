"""Synthetic search metadata and exact reads; every application mutation is blocked."""
import copy
from urllib.parse import parse_qs, quote, unquote, urlsplit
from fixtures import Fixtures, STAMP, THREAD_ID

MEMORY = "memory:search/exact+identity"
LIBRARY = "library:capture_asset:search-exact"
CONNECTED_SOURCE = "library:source_item:source-item:" + "c" * 64
UNTRUSTED = "Report <script>window.searchUntrustedRan=true</script>"


class ContentSearchFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.session = session
        self.requests = []
        self.mode = "ready"
        self.held = {}
        self.work_ready = False
        self.hold_connected = False

    def mutation(self, route, path):
        self.unexpected.append({"kind": "blocked_write", "path": path, "method": route.request.method})
        return self.fulfill(route, {"error": "Search fixture blocks every mutation."}, 503)

    def item(self, provider, page=False):
        identity, href, title, detail = {
            "conversations": (THREAD_ID, "/app/command?thread=" + THREAD_ID, "Report conversation", "Conversation"),
            "work": ("project:search", "/app/projects?project=search&fromSearch=1", "Report project", "Project"),
            "memory": (MEMORY, "/app/memory?memory=" + quote(MEMORY, safe=""), "Report private memory", "Active private memory"),
            "library": (LIBRARY, "/app/capture?libraryItem=" + quote(LIBRARY, safe=""), "Report original file", "document · ready"),
        }[provider]
        return {"id": identity, "href": href, "title": title, "detail": detail, "updatedAt": STAMP}

    def group(self, provider, page=False):
        labels = {"conversations": "Conversations", "work": "Work", "memory": "Private memory", "library": "Library"}
        coverage = {"conversations": "Your conversation titles.", "work": "Your mapped projects and tasks in active workspaces.",
                    "memory": "Your active private memories. Shared and historical memory are excluded.",
                    "library": "Your captures, recordings, transcripts, project artifacts and currently authorized indexed sources. Unindexed or revoked connections are excluded."}
        unavailable = provider == "work" and not self.work_ready
        item = self.item(provider)
        items = [] if unavailable or self.mode == "empty" else [item]
        if provider == "library" and page:
            duplicate = copy.deepcopy(item); duplicate["title"] = "Report original file refreshed"
            extra = copy.deepcopy(item); extra["id"] = "library:capture_asset:another"; extra["title"] = UNTRUSTED
            extra["href"] = "/app/capture?libraryItem=library%3Acapture_asset%3Aanother"
            items = [duplicate, extra]
        if provider == "library" and items:
            items.append({"id": CONNECTED_SOURCE, "href": "/app/capture?libraryItem=" + quote(CONNECTED_SOURCE, safe=""),
                          "title": "Report connected source", "detail": "document · ready", "updatedAt": STAMP})
        return {"provider": provider, "label": labels[provider], "coverage": coverage[provider],
                "status": "unavailable" if unavailable else "ready", "items": items,
                "nextCursor": "synthetic-library-next" if provider == "library" and not page and items else None,
                "message": "This content could not be searched. Try again; other groups remain available." if unavailable else None}

    def body(self, query, provider=None, page=False):
        return {"query": query, "generatedAt": STAMP, "consistency": "live",
                "groups": [self.group(key, page) for key in ([provider] if provider else ["conversations", "work", "memory", "library"])]}

    def route(self, route):
        parsed = urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin or route.request.method != "GET":
            return super().route(route)
        path, params = unquote(parsed.path), parse_qs(parsed.query)
        if path == "/api/content-search":
            self.requests.append({"path": path, "query": params})
            if set(params) - {"q", "limit", "provider", "cursor"} or params.get("limit") != ["8"]:
                self.unexpected.append({"kind": "search_contract", "query": params})
                return self.fulfill(route, {"error": "Unexpected search contract"}, 400)
            query = params.get("q", [""])[0]
            body = self.body(query, params.get("provider", [None])[0], "cursor" in params)
            if query == "delayed": self.held[query] = (route, body); return
            if self.mode == "error": return self.fulfill(route, {"error": "Synthetic search unavailable"}, 503)
            return self.fulfill(route, body)
        if path == "/api/content-search/memory/" + MEMORY:
            self.requests.append({"path": path})
            return self.fulfill(route, {"memory": {"id": MEMORY, "tenantId": self.session["context"]["tenantId"], "type": "fact", "tier": "semantic",
                "title": "Exact private memory outside first page", "content": "Synthetic exact private detail. No retrieval or embedding ran.", "tags": [], "scope": "user", "source": "manual",
                "importance": .7, "confidence": .9, "claimStatus": "active", "assertedBy": "user", "evidenceRefs": [], "createdAt": STAMP, "updatedAt": STAMP}})
        if path.startswith("/api/content-search/work/") or path.startswith("/api/library/"):
            self.requests.append({"path": path})
            if path == "/api/library/" + CONNECTED_SOURCE and self.hold_connected:
                self.held["connected-exact"] = (route, {"error": "This exact result was deleted or access was revoked."}); return
            return self.fulfill(route, {"error": "This exact result was deleted or access was revoked."}, 404)
        return super().route(route)

    def release(self, key, status=200):
        route, body = self.held.pop(key)
        try: self.fulfill(route, body, status)
        except Exception: pass  # An aborted browser request is an expected fenced disposition.

    def abort_held(self):
        for route, _body in self.held.values():
            try: route.abort()
            except Exception: pass
        self.held.clear()
