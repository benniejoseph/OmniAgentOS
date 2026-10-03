"""Bounded synthetic responsibility contracts. Every application write is intercepted."""
import copy
import hashlib
import json
import uuid
from playwright.sync_api import Error as PlaywrightError
from urllib.parse import parse_qs, unquote, urlsplit
from fixtures import Fixtures

STAMP = "2026-10-04T00:00:00.000Z"
ID = "responsibility:" + "a" * 64
UNTRUSTED = "Meeting <script>window.responsibilityUntrustedRan=true</script>"
DIMENSIONS = ["modelTurns", "tokens", "costMicrousd", "wallTimeMs", "toolCalls", "browserActions", "agents", "fanOut", "retries", "replans"]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def signed(value, field):
    return {**value, field: digest(value)}


class ResponsibilityFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.owner = {"tenantId": session["context"]["tenantId"], "actorId": "actor:" + session["user"]["id"]}
        self.requests = []; self.mutations = []; self.receipts = {}; self.runtime_receipts = []
        self.current = None; self.lost_activation = True; self.fail_refresh = False; self.sources_unavailable = False
        self.notification_current = None; self.notification_candidates = []; self.notification_receipts = []
        self.lost_notification_enable = True; self.lost_notification_stop = True; self.fail_notification_refresh = False
        self.notification_read_mode = None; self.notification_write_hold = None; self.held = {}; self.releases = []
        self.receipt_requests = {}; self.write_budget = 12
        self.compatibility = {"schemaVersion": 1, "supportedActions": ["create", "update", "review"], "activationSupported": False,
                              "executionAuthority": "none", "observationSupported": False, "deliverySupported": False, "unknownVersionBehavior": "reject_without_mutation"}
        self.source = {"kind": "meeting", "id": "meeting:browser/owner", "workspaceId": "workspace:browser"}
        self.draft = {"schemaVersion": 1, "purpose": "Prepare a bounded meeting brief", "desiredOutcome": "Inspect current evidence before the meeting",
            "sources": [self.source], "cadence": {"frequency": "daily", "interval": 1, "timezone": "UTC", "startsAt": STAMP, "expiresAt": "2026-10-11T00:00:00.000Z", "missedPolicy": "skip"},
            "limits": {"maxChecks": 7, "maxNotifications": 2, "cumulative": {**dict.fromkeys(DIMENSIONS, 0), "wallTimeMs": 210000, "toolCalls": 7, "agents": 7}},
            "notificationRule": {"kind": "material_change_only", "destination": "owner_in_app", "quietOnNoChange": True},
            "successCondition": "Owner has current meeting evidence", "stopConditions": ["Meeting begins"],
            "work": {"workspaceId": "workspace:browser", "projectId": "project:browser", "workItemId": "work:browser"}, "procedureId": "meeting-read", "agentId": "atlas"}
        self.record = self.saved(ID, self.draft, 1)
        self.pins = {"sources": [{"source": self.source, "revisionSha256": "a" * 64}], "work": {**self.draft["work"], "projectionSha256": "b" * 64},
            "procedure": {"id": "meeting-read", "snapshotSha256": "c" * 64, "toolBindingsSha256": "d" * 64},
            "agent": {"id": "atlas", "definitionVersionId": "atlas:v1", "principalVersionId": "atlas-principal:v1", "identityPinSha256": "e" * 64, "policySha256": "f" * 64}}
        self.policy = signed({"schemaVersion": 1, "id": "responsibility-meeting-comparison:1", "maximumSourceAgeSeconds": 3600,
            "firstObservation": "establish_baseline_without_notification", "advancement": "complete_current_authorized_evidence_only", "uncertainComparison": "insufficient_evidence",
            "adapterCoverage": "Native owner-private Meeting metadata only. Linked sources and changed free-form prose are unsupported.",
            "materialExamples": ["A meeting time changes.", "A participant joins or leaves."], "cosmeticExamples": ["Whitespace or display markup changes without changing meaning."],
            "unsupportedExamples": ["Missing, stale, denied or partial evidence cannot advance a baseline."]}, "policySha256")
        self.disclosure = {"pilot": "native_meeting_metadata_v1", "source": "One owner-private native Meeting with current consent.",
            "comparison": "Deterministic metadata only. Changed prose is insufficient evidence.", "cadence": "Daily or weekly, with a 15-minute due grace; missed checks are skipped.",
            "stops": "Expiry, meeting started, or meeting canceled. Descriptive conditions are not executable predicates.",
            "execution": "Only app.meetings.show; no model, notification, mutation, approval or delivery authority."}

    def saved(self, identity, draft, revision):
        return {"schemaVersion": 1, "id": identity, **self.owner, "revision": revision, "state": "draft", "draft": copy.deepcopy(draft),
                "draftSha256": digest({"contract": "responsibility-draft:1", "draft": draft}), "review": None, "createdAt": STAMP, "updatedAt": STAMP}

    def envelope(self, **fields):
        return {"schemaVersion": 1, "contract": "asael-responsibility-draft:1", "compatibility": self.compatibility, **fields}

    def review(self):
        review_hash = digest({"contract": "responsibility-review:1", "id": self.record["id"], **self.owner, "revision": self.record["revision"],
            "draftSha256": self.record["draftSha256"], "pins": self.pins, "authorityEffect": "none", "activationSupported": False})
        return {"state": "ready", "draftSha256": self.record["draftSha256"], "reviewSha256": review_hash, "pins": self.pins, "authorityEffect": "none", "activationSupported": False}

    def configuration(self):
        return signed({"schemaVersion": 1, "pilot": "native_meeting_metadata_v1", "responsibilityRevision": self.record["revision"],
            "reviewSha256": self.record["review"]["reviewSha256"], "draftSha256": self.record["draftSha256"], "pins": self.pins, "source": self.source,
            "tool": {"id": "app.meetings.show", "input": {"workspaceId": self.source["workspaceId"], "meetingId": self.source["id"]}, "contractSha256": "3" * 64},
            "cadence": self.draft["cadence"], "maximumChecks": 7, "cumulativeLimits": self.draft["limits"]["cumulative"],
            "checkReservation": {**dict.fromkeys(DIMENSIONS, 0), "wallTimeMs": 30000, "toolCalls": 1, "agents": 1},
            "comparisonPolicySha256": self.policy["policySha256"], "stops": ["expiry", "meeting_started", "meeting_canceled"],
            "notificationAuthority": "none", "approvalAuthority": "none", "mutationAuthority": "none"}, "configurationSha256")

    def references(self):
        def available(items): return {"state": "available", "items": items, "hasMore": False}
        return {"schemaVersion": 1, "contract": "asael-responsibility-references:1", "owner": self.owner, "authorityEffect": "none",
            "coverage": {"perGroupLimit": 40, "totals": "unavailable"}, "groups": {
                "sources": {"state": "unavailable", "items": [], "hasMore": None, "errorCode": "responsibility_reference_read_unavailable"} if self.sources_unavailable else available([{"source": self.source, "label": UNTRUSTED}]),
                "work": available([{**self.draft["work"], "label": "Synthetic canonical Work"}]), "procedures": available([{"id": "meeting-read", "label": "Exact saved meeting read"}]),
                "agents": available([{"id": "atlas", "label": "ATLAS"}])}}

    def runtime(self, preview=False):
        value = {"schemaVersion": 1, "contract": "asael-responsibility-runtime:1", "current": self.current, "disclosure": self.disclosure,
            "wakes": [], "receipts": self.runtime_receipts, "coverage": {"limit": 40, "total": None, "hasMoreWakes": False, "hasMoreReceipts": False},
            "dispatchReadiness": "not_observed", "deliverySupported": False}
        if preview:
            value["preview"] = {"state": "ready", "configuration": self.configuration(), "authorityEffect": "none", "dispatchReadiness": "not_observed"} if self.record["review"] else {"state": "blocked", "reason": "responsibility_review_required", "authorityEffect": "none"}
        return value

    def notification_envelope(self, **fields):
        return {"schemaVersion": 1, "contract": "asael-responsibility-notifications:1", "externalDelivery": False,
                "disclosure": "Separate owner inbox admission only. Quiet hours hold changes. No email, push, browser notification or provider delivery.", **fields}

    def notification_configuration(self):
        return signed({"schemaVersion": 1, **self.owner, "responsibilityId": self.record["id"], "policy": "owner_in_app_material_change_v1",
            "runtimeConfigurationSha256": self.current["configuration"]["configurationSha256"], "responsibilityRevision": self.record["revision"],
            "reviewSha256": self.record["review"]["reviewSha256"], "draftSha256": self.record["draftSha256"], "source": self.source,
            "destination": "owner_in_app", "quietOnNoChange": True, "maximumNotifications": self.record["draft"]["limits"]["maxNotifications"],
            "expiresAt": self.current["configuration"]["cadence"]["expiresAt"]}, "configurationSha256")

    def notifications(self, preview=False):
        value = self.notification_envelope(current=self.notification_current, candidates=self.notification_candidates,
            receipts=self.notification_receipts, coverage={"limit": 40, "total": None, "hasMoreCandidates": False, "hasMoreReceipts": False})
        if preview:
            value["preview"] = {"state": "ready", "authorityEffect": "none", "configuration": self.notification_configuration(),
                "expectedRuntimeRevision": self.current["revision"], "expectedRuntimeGeneration": self.current["generation"]} if (
                self.current and self.current["state"] == "active" and self.record["review"] and not self.notification_current
            ) else {"state": "blocked", "authorityEffect": "none", "reason": "responsibility_notification_not_ready"}
        return copy.deepcopy(value)

    def notification_receipt(self, action, key, request, previous_revision, candidate=None):
        key_sha = digest(["responsibility-idempotency:1", key]); head = self.notification_current
        receipt = signed({"schemaVersion": 1, "id": "responsibility-notification-receipt:" + digest([self.owner["tenantId"], self.owner["actorId"], key_sha]),
            "idempotencySha256": key_sha, "requestSha256": digest(request), "previousRevision": previous_revision, "action": action,
            "snapshot": copy.deepcopy(head), "candidate": copy.deepcopy(candidate), "savedAt": head["updatedAt"], "contentIncluded": False}, "receiptSha256")
        self.notification_receipts.insert(0, receipt); return receipt

    def notification_candidate(self, tag):
        """A synthetic newly observed change, never an application write."""
        head = self.notification_current; assert head and head["state"] == "enabled" and head["used"] + head["reserved"] < head["configuration"]["maximumNotifications"]
        change_id = "responsibility-change:" + digest([tag, "change"]); change_sha = digest([tag, "proof"])
        at = "2026-10-04T00:20:00.000Z" if tag == "second" else STAMP
        candidate = {"schemaVersion": 1, **self.owner, "responsibilityId": self.record["id"],
            "id": "responsibility-notification:" + digest([self.owner["tenantId"], self.owner["actorId"], self.record["id"], change_id, change_sha, "owner_in_app"]),
            "changeId": change_id, "changeSha256": change_sha, "configurationSha256": head["configuration"]["configurationSha256"], "generation": head["generation"], "revision": 1,
            "state": "pending", "reason": "material_change", "attempts": 0, "expiresAt": "2026-10-04T01:00:00.000Z", "nextAttemptAt": at,
            "notificationId": None, "dispositionId": None, "deliveryBindingSha256": None, "createdAt": at, "updatedAt": at, "terminalAt": None}
        self.notification_current = {**head, "revision": head["revision"] + 1, "reserved": head["reserved"] + 1, "updatedAt": at}
        self.notification_candidates.insert(0, candidate)
        self.notification_receipt("admit", tag + ":admit", {"changeId": change_id, "changeSha256": change_sha}, head["revision"], candidate)
        return candidate

    def notification_transition(self, state):
        head = self.notification_current; previous = self.notification_candidates[0]; assert previous["state"] in ("pending", "held")
        at = "2026-10-04T00:20:00.000Z" if state == "delivered" or previous["createdAt"] != STAMP else STAMP
        item = {**previous, "revision": previous["revision"] + 1, "state": state, "reason": {"held": "quiet_hours", "delivered": "in_app_recorded", "canceled": "owner_stopped"}[state],
            "attempts": previous["attempts"] + 1, "updatedAt": at, "terminalAt": None if state == "held" else at,
            "nextAttemptAt": ("2026-10-04T00:35:00.000Z" if at != STAMP else "2026-10-04T00:15:00.000Z") if state == "held" else None,
            "dispositionId": previous["dispositionId"] or "notification_disposition_" + digest(previous["id"])[:48]}
        if state == "delivered": item.update(notificationId="notification_" + digest([previous["id"], "inbox"])[:48], deliveryBindingSha256=digest([previous["id"], "delivery"]))
        self.notification_candidates[0] = item
        self.notification_current = {**head, "revision": head["revision"] + 1, "reserved": head["reserved"] - (0 if state == "held" else 1), "used": head["used"] + (1 if state == "delivered" else 0), "updatedAt": at}
        self.notification_receipt({"held": "hold", "delivered": "deliver", "canceled": "cancel"}[state], item["id"] + ":" + str(item["revision"]), {"candidateId": item["id"], "revision": previous["revision"]}, head["revision"], item)

    def release(self, name):
        route, value, status = self.held.pop(name)
        try: self.fulfill(route, value, status); result = "fulfilled"
        except PlaywrightError: result = "already canceled"
        self.releases.append({"name": name, "result": result})

    def route(self, route):
        parsed = urlsplit(route.request.url); path = unquote(parsed.path); params = parse_qs(parsed.query)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin: return super().route(route)
        if path.startswith("/api/responsibilities"):
            if route.request.method != "GET": return self.mutation(route, path)
            self.requests.append({"path": path, "query": params})
            if path == "/api/responsibilities/references": return self.fulfill(route, self.references())
            if path == "/api/responsibilities":
                limit = int(params.get("limit", ["40"])[0])
                return self.fulfill(route, self.envelope(records=[self.record], hasMore=False, coverage={"kind": "bounded_recent", "limit": limit, "returned": 1, "total": None}))
            if path == "/api/responsibilities/" + self.record["id"]:
                return self.fulfill(route, self.envelope(record=self.record, readiness=self.review() if params.get("view") == ["review"] else {"state": "not_checked", "issues": []}))
            if path.endswith("/lifecycle"):
                if self.fail_refresh: return self.fulfill(route, {"error": "Synthetic refresh unavailable"}, 503)
                return self.fulfill(route, self.runtime(params.get("view") == ["activation"]))
            if path.endswith("/observations"):
                return self.fulfill(route, {"schemaVersion": 1, "contract": "asael-responsibility-observation:1", "policy": self.policy,
                    "authorityEffect": "none", "activationSupported": False, "deliverySupported": False, "receipts": [], "baseline": None, "hasMore": False,
                    "coverage": {"kind": "bounded_recent", "limit": 25, "returned": 0, "total": None}})
            if path == "/api/responsibilities/" + self.record["id"] + "/notifications":
                if params not in ({}, {"view": ["enable"]}):
                    self.unexpected.append({"kind": "notification_query", "query": params}); return self.fulfill(route, {"error": "Unbounded query"}, 400)
                body = self.notifications(params.get("view") == ["enable"])
                if self.notification_read_mode:
                    mode = self.notification_read_mode; self.notification_read_mode = None
                    if mode == "malformed": return self.fulfill(route, {**body, "externalDelivery": True})
                    self.held[mode] = (route, body, 200); return
                if self.fail_notification_refresh: return self.fulfill(route, {"error": "Synthetic notification history unavailable"}, 503)
                return self.fulfill(route, body)
            return self.fulfill(route, {"error": "Exact responsibility not found"}, 404)
        return super().route(route)

    def mutation(self, route, path):
        if not path.startswith("/api/responsibilities"):
            self.unexpected.append({"kind": "blocked_application_write", "path": path})
            return self.fulfill(route, {"error": "All nonfixture writes blocked"}, 503)
        body = route.request.post_data_json; key = route.request.headers.get("idempotency-key")
        self.mutations.append({"path": path, "method": route.request.method, "body": copy.deepcopy(body), "key": key})
        if len(self.mutations) > self.write_budget:
            self.unexpected.append({"kind": "effect_budget", "path": path}); return self.fulfill(route, {"error": "Fixture write budget exceeded"}, 503)
        try: uuid.UUID(key)
        except (ValueError, TypeError, AttributeError):
            self.unexpected.append({"kind": "invalid_exact_key", "path": path}); return self.fulfill(route, {"error": "Missing exact key"}, 400)
        exact = {"path": path, "method": route.request.method, "body": body}
        if key in self.receipt_requests and self.receipt_requests[key] != exact:
            self.unexpected.append({"kind": "changed_replay", "path": path}); return self.fulfill(route, {"error": "Changed exact replay"}, 409)
        if path.endswith("/notifications"): return self.notification_mutation(route, path, body, key)
        if key in self.receipts:
            result = self.receipts[key]; result = {**result, "replayed": True, "current": self.current if path.endswith("/lifecycle") else self.record}
            if path.endswith("/lifecycle"): self.fail_refresh = True
            return self.fulfill(route, result)
        key_sha = digest(["responsibility-idempotency:1", key]); action = body["action"]
        if path.endswith("/lifecycle"):
            previous = self.current; previous_revision = previous["revision"] if previous else 0; generation = previous["generation"] if previous else 0
            if body["expectedRevision"] != previous_revision or body["expectedGeneration"] != generation: return self.fulfill(route, {"error": "Exact lifecycle changed"}, 409)
            if action == "activate":
                config = self.configuration()
                if body["configurationSha256"] != config["configurationSha256"] or body["acknowledgePilot"] != "native_meeting_metadata_v1": return self.fulfill(route, {"error": "Exact pilot changed"}, 409)
                self.current = {"schemaVersion": 1, "contract": "asael-responsibility-runtime:1", **self.owner, "responsibilityId": self.record["id"], "revision": 1, "generation": 1,
                    "state": "active", "reason": "owner_activated", "configuration": config, "nextDueAt": STAMP, "activatedAt": STAMP, "updatedAt": STAMP,
                    "budget": {"limits": config["cumulativeLimits"], "used": dict.fromkeys(DIMENSIONS, 0), "reserved": dict.fromkeys(DIMENSIONS, 0), "maximumChecks": 7, "usedChecks": 0, "reservedChecks": 0}}
            elif action in ("pause", "end"):
                self.current = {**previous, "revision": previous_revision + 1, "generation": generation + 1, "state": "paused" if action == "pause" else "ended", "reason": "owner_paused" if action == "pause" else "owner_ended", "nextDueAt": None}
            else: return self.fulfill(route, {"error": "Unexpected fixture action"}, 400)
            receipt = signed({"schemaVersion": 1, "id": "responsibility-runtime-receipt:" + digest([self.owner["tenantId"], self.owner["actorId"], key_sha]),
                "idempotencySha256": key_sha, "requestSha256": digest({"responsibilityId": self.record["id"], **body}), "action": action, "previousRevision": previous_revision,
                "snapshot": copy.deepcopy(self.current), "wake": None, "savedAt": STAMP}, "receiptSha256")
            self.runtime_receipts.insert(0, receipt)
            result = {"schemaVersion": 1, "contract": "asael-responsibility-runtime:1", "current": self.current, "receipt": receipt, "replayed": False}
        else:
            expected = body["expectedRevision"]
            if action != "create" and expected != self.record["revision"]: return self.fulfill(route, {"error": "Exact draft changed"}, 409)
            if action == "create": self.record = self.saved("responsibility:" + digest([self.owner["tenantId"], self.owner["actorId"], key_sha]), body["draft"], 1)
            elif action == "update": self.record = self.saved(self.record["id"], body["draft"], expected + 1)
            elif action == "review":
                review = self.review()
                if body["draftSha256"] != review["draftSha256"] or body["reviewSha256"] != review["reviewSha256"]: return self.fulfill(route, {"error": "Exact review changed"}, 409)
                self.record = {**self.record, "revision": expected + 1, "state": "reviewed", "review": {"schemaVersion": 1, **{key: value for key, value in review.items() if key != "state"}, "reviewedAt": STAMP}}
            else: return self.fulfill(route, {"error": "Unexpected fixture draft action"}, 400)
            receipt = {"schemaVersion": 1, "id": "responsibility-mutation:" + digest([self.owner["tenantId"], self.owner["actorId"], key_sha]), "idempotencySha256": key_sha,
                "requestSha256": digest(["responsibility-request:1", self.record["id"], body]), "action": {"create": "created", "update": "updated", "review": "reviewed"}[action],
                "expectedRevision": expected, "snapshot": copy.deepcopy(self.record), "savedAt": STAMP, "authorityEffect": "none", "activationSupported": False}
            result = self.envelope(current=self.record, receipt=receipt, replayed=False)
        self.receipts[key] = copy.deepcopy(result)
        self.receipt_requests[key] = copy.deepcopy(exact)
        if action == "activate" and self.lost_activation:
            self.lost_activation = False
            return self.fulfill(route, {"error": "Synthetic lost activation response; exact receipt retained"}, 503)
        return self.fulfill(route, result)

    def notification_mutation(self, route, path, body, key):
        expected_path = "/api/responsibilities/" + self.record["id"] + "/notifications"
        if path != expected_path or route.request.method != "POST" or body.get("action") not in ("enable", "stop"):
            self.unexpected.append({"kind": "notification_effect", "path": path, "body": body}); return self.fulfill(route, {"error": "Unexpected fixture effect"}, 400)
        if key in self.receipts:
            self.fail_notification_refresh = True
            return self.fulfill(route, {**self.receipts[key], "current": self.notification_current, "replayed": True})
        action = body["action"]
        if action == "enable":
            preview = self.notifications(True)["preview"]
            expected = {"action": "enable", "expectedRuntimeRevision": self.current["revision"], "expectedRuntimeGeneration": self.current["generation"],
                "configurationSha256": preview.get("configuration", {}).get("configurationSha256"), "acknowledgeDestination": "owner_in_app"}
            if body != expected or preview["state"] != "ready":
                self.unexpected.append({"kind": "notification_enable_binding", "body": body}); return self.fulfill(route, {"error": "Exact admission changed"}, 409)
            self.notification_current = {"schemaVersion": 1, "contract": "asael-responsibility-notifications:1", **self.owner, "responsibilityId": self.record["id"],
                "revision": 1, "generation": 1, "state": "enabled", "reason": "owner_enabled", "configuration": preview["configuration"], "used": 0, "reserved": 0, "enabledAt": STAMP, "updatedAt": STAMP}
            previous_revision = 0
        else:
            head = self.notification_current
            expected = {"action": "stop", "expectedRevision": head["revision"], "expectedGeneration": head["generation"]} if head else None
            if body != expected or head["state"] == "ended":
                self.unexpected.append({"kind": "notification_stop_binding", "body": body}); return self.fulfill(route, {"error": "Exact admission changed"}, 409)
            if self.notification_candidates and self.notification_candidates[0]["state"] in ("pending", "held"): self.notification_transition("canceled")
            head = self.notification_current; previous_revision = head["revision"]
            self.notification_current = {**head, "revision": head["revision"] + 1, "generation": head["generation"] + 1, "state": "ended", "reason": "owner_stopped"}
        receipt = self.notification_receipt(action, key, {"responsibilityId": self.record["id"], **body}, previous_revision)
        result = self.notification_envelope(current=self.notification_current, receipt=receipt, replayed=False)
        self.receipts[key] = copy.deepcopy(result); self.receipt_requests[key] = {"path": path, "method": route.request.method, "body": copy.deepcopy(body)}
        lost = self.lost_notification_enable if action == "enable" else self.lost_notification_stop
        if action == "enable": self.lost_notification_enable = False
        else: self.lost_notification_stop = False
        reply, status = ({"error": "Synthetic notification response loss; exact receipt retained"}, 503) if lost else (result, 200)
        if self.notification_write_hold:
            name = self.notification_write_hold; self.notification_write_hold = None; self.held[name] = (route, copy.deepcopy(reply), status); return
        return self.fulfill(route, reply, status)
