"""Synthetic client contracts. No application mutation is sent to the server."""

import json
import re
from urllib.parse import parse_qs, urlsplit

THREAD_ID = "7c1ca45b-1068-41c4-93ab-8c09e15e84a3"
RUN_ID = "browser-fixture-run"
APPROVAL_ID = "browser-fixture-approval"
PROMPT = "Summarize the synthetic review document."
ANSWER = "The synthetic review is ready. <script>window.untrustedContentRan=true</script>"
STAMP = "2026-10-03T12:00:00.000Z"


class Fixtures:
    def __init__(self, origin):
        self.origin = origin
        self.sent = False
        self.decided = False
        self.refresh_failure = False
        self.writes = []
        self.unexpected = []
        self.reads = set()

    def thread(self):
        return {"id": THREAD_ID, "title": "Synthetic review", "mode": "orchestrate",
                "createdAt": STAMP, "updatedAt": STAMP}

    def approval(self):
        return {"kind": "tool", "id": APPROVAL_ID, "title": "Review synthetic document export",
                "status": "approval_required", "riskLevel": 2,
                "requestedBy": "synthetic-requester", "createdAt": STAMP,
                "reason": "Review the exact synthetic export scope.",
                "contract": {"reversible": True, "readOnly": False, "effect": "write"},
                "input": {"documentId": "synthetic-document", "content": "First line\nSecond line <exact> & text."},
                "origin": {"runId": RUN_ID, "threadId": THREAD_ID}}

    def run(self):
        return {"id": RUN_ID, "threadId": THREAD_ID, "agentId": "atlas",
                "mode": "orchestrate", "status": "completed", "prompt": PROMPT,
                "response": ANSWER, "startedAt": STAMP, "completedAt": STAMP,
                "grounding": {"status": "not_required"}}

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
            # Next's development error-overlay source lookup is a diagnostic
            # read. Fulfill locally so expected unavailable fixtures never
            # send it to the application or masquerade as an app mutation.
            return self.fulfill(route, {"results": []})
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return self.mutation(route, path)
        if not path.startswith("/api/") or path == "/api/auth/session":
            return route.continue_()
        self.reads.add(path)
        query = parse_qs(parsed.query)
        if path == "/api/threads":
            return self.fulfill(route, {"threads": [self.thread()]})
        if path == f"/api/threads/{THREAD_ID}":
            turns = [] if not self.sent else [
                {"id": "fixture-user", "role": "user", "content": PROMPT, "createdAt": STAMP},
                {"id": "fixture-answer", "role": "assistant", "content": ANSWER,
                 "runId": RUN_ID, "createdAt": STAMP},
            ]
            return self.fulfill(route, {"thread": self.thread(), "turns": turns, "summaries": []})
        if path == f"/api/runs/{RUN_ID}":
            return self.fulfill(route, {"run": self.run()})
        if path == "/api/approvals":
            if self.refresh_failure:
                return self.fulfill(route, {"error": "Synthetic queue refresh unavailable."}, 503)
            items = [] if self.decided else [self.approval()]
            if "id" in query:
                return self.fulfill(route, {"item": items[0] if items and query["id"] == [APPROVAL_ID] else None})
            return self.fulfill(route, {"items": items, "nextCursor": None,
                                       "stats": {"total": len(items), "tools": len(items),
                                                 "reconciliations": 0, "workflows": 0, "sloPolicies": 0}})
        if path == "/api/trust":
            return self.fulfill(route, {"enabled": True, "threshold": 20, "profiles": []})
        if path == "/api/onboarding/access-requests":
            return self.fulfill(route, {"requests": [], "stats": {"shown": 0, "pending": 0, "provisioning": 0}})
        if path == "/api/inbox":
            return self.fulfill(route, {"pending": 0 if self.decided else 1, "approvals": 0 if self.decided else 1})
        if path == "/api/command/prompt-queue":
            return self.fulfill(route, {"items": [], "revision": 1})
        # Optional sources are explicitly unavailable; this does not pretend to
        # exercise database-only queues, a provider, or an external connector.
        return self.fulfill(route, {"error": "Source unavailable in this bounded browser fixture."}, 503)

    def mutation(self, route, path):
        request = route.request
        try:
            body = request.post_data_json
        except Exception:
            body = None
        if path == "/api/agent" and request.method == "POST" and not self.sent:
            allowed = {"mode", "threadId", "message", "requestId", "strategy", "agentId",
                       "contextScope", "contextSelection", "contextReferences"}
            if (isinstance(body, dict) and set(body) <= allowed and body.get("message") == PROMPT
                    and body.get("threadId") == THREAD_ID and body.get("mode") == "orchestrate"
                    and body.get("strategy") == "auto"
                    and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", body.get("requestId", ""))):
                self.sent = True
                self.writes.append({"path": path, "disposition": "synthetic_sse"})
                events = [{"type": "run", "runId": RUN_ID, "threadId": THREAD_ID},
                          {"type": "status", "label": "Reading", "detail": "Synthetic local response."},
                          {"type": "delta", "text": ANSWER}, {"type": "done", "response": ANSWER}]
                return route.fulfill(status=200, content_type="text/event-stream",
                                     headers={"x-asael-run-id": RUN_ID, "cache-control": "no-store"},
                                     body="".join(f"data: {json.dumps(event)}\n\n" for event in events))
        if (path == f"/api/approvals/{APPROVAL_ID}" and request.method == "POST" and not self.decided
                and body == {"kind": "tool", "decision": "approve", "reason": "Reviewed synthetic scope."}
                and re.fullmatch(r"approval-approve-[0-9a-f-]{36}", request.headers.get("idempotency-key", ""))):
            self.decided = True
            self.writes.append({"path": path, "disposition": "synthetic_decision"})
            return self.fulfill(route, {"record": {"id": APPROVAL_ID, "status": "executed"}})
        self.unexpected.append({"kind": "write", "path": path, "method": request.method})
        return self.fulfill(route, {"error": "Unexpected browser mutation blocked."}, 503)
