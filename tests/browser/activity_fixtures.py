"""Bounded read-only Activity contracts; all application mutations are blocked."""

import base64
from collections import defaultdict, deque
import copy
from datetime import datetime, timedelta, timezone
import json
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import Error as PlaywrightError

from fixtures import Fixtures

GROUPS = ("working", "needs_you", "updates", "history")
LABELS = {"all": "All activity", "working": "Working", "needs_you": "Needs you", "updates": "Updates", "history": "History"}
ACTIVITY_PATH = "/api/activity"
LONG_ID = "run:opaque/+" + "x" * 175


def canonical(status, domain="agent_run", terminal=False, verification="unassessed"):
    return {"schemaVersion": 1, "status": status, "domain": domain,
            "basis": "terminal_receipt" if terminal else "legacy_status",
            "source": "outcome_evaluator" if terminal else "legacy_adapter",
            "sourceStatus": status, "verificationState": verification}


def run_row(identity, status, group, *, verified=False, partial=False, thread="fixture-thread"):
    translated = {"queued": "waiting", "running": "running", "resuming": "running", "waiting_approval": "waiting",
                  "waiting_clarification": "waiting", "completed": "unverified", "failed": "failed", "canceled": "canceled"}[status]
    projection = canonical("succeeded" if verified else "partial" if partial else translated,
                           terminal=verified or partial, verification="verified" if verified else "partially_verified" if partial else "unassessed")
    if not verified and not partial:
        projection["sourceStatus"] = status
    summary = "The run completed with a verified outcome." if verified else (
        "The run ended with a partial outcome. Open its source to inspect what remains." if partial else {
            "queued": "Queued to start.", "running": "The run is in progress.", "resuming": "The run is resuming.",
            "waiting_approval": "Waiting for an approval decision.",
            "waiting_clarification": "Waiting for clarification in the conversation.",
            "completed": "The run completed; its outcome has not been verified.",
            "failed": "The run failed. Open its source to inspect the result.", "canceled": "The run was canceled.",
        }[status])
    reference = {"kind": "run", "id": identity}
    return {"id": "run:" + identity, "workKey": "run:" + identity, "group": group, "source": "runs",
            "sourceRef": reference, "references": [reference], "title": "Agent run", "summary": summary,
            "status": status, "canonicalStatus": projection,
            "href": "/app/command?" + urlencode({"thread": thread, "run": identity})}


def approval_row(identity, kind, *, origin=False, reconciliation=False):
    status = "reconciliation_required" if reconciliation else "approval_required" if kind == "tool" else "waiting_approval" if kind == "workflow" else "pending"
    reference = {"kind": "approval", "id": identity, "approvalKind": kind}
    projection = canonical("waiting", "approval")
    projection["sourceStatus"] = status
    value = {"id": f"approval:{kind}:{identity}", "workKey": f"approval:{kind}:{identity}", "group": "needs_you",
             "source": "approvals", "sourceRef": reference, "references": [reference],
             "title": {"tool": "Tool approval", "workflow": "Workflow approval", "slo_policy": "Policy approval"}[kind],
             "summary": "An approved action needs reconciliation. Open the approval to inspect its receipt." if reconciliation else "A decision is waiting in the approvals inbox.",
             "status": status, "canonicalStatus": projection,
             "href": "/app/approvals?" + urlencode({"id": identity, "kind": kind, "returnTo": "/app/activity"})}
    if origin:
        value["origin"] = {"runId": "own-origin-run", "threadId": "own-origin-thread",
                           "href": "/app/command?" + urlencode({"thread": "own-origin-thread", "run": "own-origin-run"})}
        value["workKey"] = "run:own-origin-run"
        value["references"].append({"kind": "run", "id": "own-origin-run"})
    return value


def notification_row(index, status):
    identity, work = f"reminder-{index}", "today-item-a" if index < 3 else f"today-item-{index}"
    reference = {"kind": "notification", "id": identity}
    return {"id": "notification:" + identity, "workKey": "today_item:" + work,
            "group": "updates" if status in ("unread", "snoozed") else "history", "source": "notifications",
            "sourceRef": reference, "references": [reference, {"kind": "today_item", "id": work}], "title": "Reminder",
            "summary": {"unread": "An unread reminder is available in Today.", "snoozed": "This reminder is snoozed.",
                        "read": "This reminder has been read.", "dismissed": "This reminder was dismissed.",
                        "acted": "An action was recorded for this reminder."}[status], "status": status, "href": "/app"}


def rows(version):
    values = [run_row(LONG_ID if index == 0 else f"active-run-{index}", ("running", "queued", "resuming")[index % 3], "working") for index in range(8)]
    values.extend([approval_row("approval-tool", "tool", origin=True), approval_row("approval-workflow", "workflow"),
                   approval_row("approval-policy", "slo_policy"), approval_row("approval-reconciliation", "tool", reconciliation=True),
                   run_row("waiting-clarification", "waiting_clarification", "needs_you"), run_row("waiting-approval", "waiting_approval", "needs_you")])
    values.extend(notification_row(index, "snoozed" if index == 1 else "unread") for index in range(6))
    values.extend([run_row("legacy-completed", "completed", "history"), run_row("verified-completed", "completed", "history", verified=True),
                   run_row("partial-completed", "completed", "history", partial=True), run_row("failed-run", "failed", "history"),
                   run_row("canceled-run", "canceled", "history"), notification_row(6, "read"), notification_row(7, "acted"),
                   notification_row(8, "dismissed"), run_row("older-completed", "completed", "history"), run_row("oldest-completed", "completed", "history")])
    start = datetime(2026, 10, 3, 12, version, tzinfo=timezone.utc)
    for index, value in enumerate(values):
        value["timestamp"] = {"at": (start - timedelta(minutes=index)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                              "basis": "created" if value["source"] == "approvals" else "updated" if value["source"] == "notifications" else "completed" if value["group"] == "history" else "started"}
    return values


class ActivityFixtures(Fixtures):
    def __init__(self, origin):
        super().__init__(origin)
        self.version = 1
        self.mode = "ready"
        self.plans = defaultdict(deque)
        self.held = {}
        self.requests = []
        self.releases = []

    def cursor(self, group, offset):
        # Opaque fixture cursor. The UI must return it verbatim, not decode it.
        value = json.dumps({"fixtureWindow": self.version, "group": group, "offset": offset}, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    def response(self, group="all", offset=0, mode=None):
        mode = mode or self.mode
        all_rows = rows(self.version) if mode not in ("empty", "unavailable") else []
        if mode == "partial":
            all_rows = [row for row in all_rows if row["source"] == "runs"]
        counts = {key: sum(row["group"] == key for row in all_rows) for key in GROUPS}
        filtered = [row for row in all_rows if group == "all" or row["group"] == group]
        visible = filtered[offset:offset + 25]
        coverage = {source: {"state": "ready", "limit": 100, "visibleCount": sum(row["source"] == source for row in all_rows)}
                    for source in ("runs", "approvals", "notifications")}
        if mode in ("partial", "unavailable"):
            coverage["approvals"] = {"state": "restricted", "limit": 100, "visibleCount": None, "reason": "permission_required"}
            coverage["notifications"] = {"state": "unavailable", "limit": 100, "visibleCount": None, "reason": "read_failed"}
        if mode == "unavailable":
            coverage["runs"] = {"state": "unavailable", "limit": 100, "visibleCount": None, "reason": "read_failed"}
        more = offset + len(visible) < len(filtered)
        return {"schemaVersion": 1, "contract": "asael-activity:1", "generatedAt": f"2026-10-03T12:{self.version:02d}:00.000Z",
                "state": mode if mode in ("partial", "unavailable") else "ready", "group": group, "items": visible,
                "counts": counts, "coverage": coverage, "window": {"bounded": True, "limitPerSource": 100},
                "page": {"limit": 25, "hasMore": more, "nextCursor": self.cursor(group, offset + len(visible)) if more else None}}

    def plan(self, group="all", *, paged=False, hold=None, body=None, status=200):
        self.plans[(group, paged)].append({"hold": hold, "body": copy.deepcopy(body), "status": status})

    def release(self, name):
        route, body, status = self.held.pop(name)
        try:
            self.fulfill(route, body, status)
            disposition = "fulfilled_or_client_canceled"
        except PlaywrightError:
            disposition = "client_canceled"
        self.releases.append({"name": name, "disposition": disposition})

    def abort_held(self):
        for name, (route, _, _) in list(self.held.items()):
            try:
                route.abort()
            except PlaywrightError:
                pass
            self.releases.append({"name": name, "disposition": "teardown_abort"})
        self.held.clear()

    def mutation(self, route, path):
        self.unexpected.append({"kind": "write", "path": path, "method": route.request.method})
        return self.fulfill(route, {"error": "Activity browser checks permit no application effects."}, 503)

    def route(self, route):
        parsed = urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin or parsed.path != ACTIVITY_PATH:
            return super().route(route)
        if route.request.method != "GET":
            return self.mutation(route, parsed.path)
        query = parse_qs(parsed.query)
        group = query.get("group", [None])[0]
        cursor = query.get("cursor", [None])[0]
        expected = {"group": [group], "limit": ["25"], **({"cursor": [cursor]} if cursor is not None else {})}
        if query != expected or group not in ("all", *GROUPS) or len(self.requests) >= 60:
            self.unexpected.append({"kind": "unbounded_activity_read", "query": query})
            return self.fulfill(route, {"error": "Unexpected Activity read."}, 400)
        self.reads.add(ACTIVITY_PATH)
        self.requests.append({"group": group, "cursor": cursor, "limit": 25, "window": self.version})
        offset = 0
        if cursor is not None:
            expected_cursor = self.cursor(group, 25)
            if cursor != expected_cursor:
                return self.fulfill(route, {"error": "Activity changed or access was updated. Reload the first page.",
                                           "code": "activity_cursor_stale", "reload": True}, 409)
            offset = 25
        plan = self.plans[(group, cursor is not None)].popleft() if self.plans[(group, cursor is not None)] else {}
        body = plan.get("body") if plan.get("body") is not None else self.response(group, offset)
        if plan.get("hold"):
            self.held[plan["hold"]] = (route, copy.deepcopy(body), plan.get("status", 200))
            return
        return self.fulfill(route, body, plan.get("status", 200))
