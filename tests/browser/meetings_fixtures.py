"""Bounded Meetings contracts. Every Calendar/media/work/draft effect is local."""

import copy
import hashlib
import json
import re
from collections import defaultdict, deque
from urllib.parse import parse_qs, quote, unquote, urlsplit

from playwright.sync_api import Error as PlaywrightError

from fixtures import Fixtures, STAMP

MAIN = "meeting:browser-main"
OTHER = "meeting:browser-other"
OUTSIDE = "meeting:outside-readable-window"
CREATED = "meeting:browser-created"
WORKSPACE = "workspace:browser-meetings"
PROJECT = "66666666-6666-4666-8666-666666666666"
KNOWN_WORK = "77777777-7777-4777-8777-777777777777"
SHARED_MEETING_OWNER = "actor:88888888-8888-4888-8888-888888888888"
OWNER = "participant:owner"
GUEST = "participant:guest"
RECORDING = "recording:browser-meeting"
MEDIA = RECORDING + ":media:v1"
POLICY = "policy:browser-owner"
EMAIL = "owner@example.test"
LONG = "ExactEvidence_" + "x" * 170
MARKUP = "<script>window.untrustedMeetingRan=true</script>"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
DRAFT_FIELDS = ("title", "summary", "status", "scheduledStartAt", "scheduledEndAt", "actualStartAt", "actualEndAt",
                "timezone", "location", "projectId", "declaredAccessClass", "participants", "sourceLinks",
                "entityLinks", "decisions", "commitments", "followUps")


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def meeting_path(identity):
    return "/app/meetings/" + quote(identity, safe="")


def api_path(identity):
    return "/api/meetings/" + quote(identity, safe="")


def participant(identity=OWNER, name="Review owner", email=EMAIL):
    return {"participantId": identity, "displayName": name, "email": email, "entityId": None,
            "role": "organizer" if identity == OWNER else "required", "response": "accepted",
            "attendeeConsent": "granted", "recordingConsent": "granted", "consentCapturedAt": STAMP, "source": "manual"}


def citation():
    return {"turnId": "turn:" + LONG, "segmentIndex": 0, "startMilliseconds": 10000,
            "endMilliseconds": 19000, "speakerLabel": "Speaker A", "speakerParticipantId": OWNER}


def source_link():
    return {"linkId": "link:browser-recording", "kind": "capture_recording", "sourceId": RECORDING,
            "sourceRevisionId": RECORDING + ":v1", "sourceRevisionSha256": digest("source"),
            "sourceAuthoritySha256": digest("authority"), "accessClass": "owner_private",
            "mediaRole": "recording", "label": "Customer recording · " + LONG}


def media(status="ready"):
    output = None
    if status == "ready":
        output = {"mediaRevisionId": MEDIA, "processedAt": STAMP, "languageTags": ["en-US"],
                  "turns": [{"turnId": citation()["turnId"], "startMilliseconds": 10000, "endMilliseconds": 19000,
                             "languageTag": "en-US", "speaker": {"label": "Speaker A", "identity": "known",
                             "participantId": OWNER, "displayName": "Review owner"},
                             "text": "Send the release review after checking its exact source. " + MARKUP + "\n" + LONG}],
                  "chapters": [], "summary": {"text": "Synthetic release evidence. " + LONG, "citations": [citation()]},
                  "actionItems": [{"text": f"Action {number}: send the bounded release evidence.", "citations": [citation()],
                                   "actionItemId": f"action:{number}", "ownerParticipantId": OWNER,
                                   "ownershipEvidence": "explicit", "dueDateEvidence": "unconfirmed"} for number in (1, 2, 3)],
                  "decisions": [], "warnings": ["Synthetic transcript; provider execution is outside this check."]}
    return {"processingStatus": status, "operationJobId": "job:meeting-media", "rawAudioDeletedAt": None,
            "updatedAt": STAMP, "output": output}


def source(head):
    link = source_link()
    return {key: link[key] for key in ("linkId", "kind", "sourceId", "mediaRole", "label")} | {
        "revisionState": "exact", "status": "ready", "mediaType": "audio/webm", "durationMs": 19000,
        "byteCount": 2048, "updatedAt": STAMP, "transcript": None, "transcriptTruncated": False,
        "media": copy.deepcopy(head), "segments": [{"segmentIndex": 0, "mimeType": "audio/webm", "durationMs": 19000}]}


class MeetingFixtures(Fixtures):
    def __init__(self, origin, tenant_id, actor_id, max_effects=16, max_calendar=20):
        super().__init__(origin)
        self.tenant_id, self.actor_id = tenant_id, actor_id
        self.context = {"workspaceId": WORKSPACE, "accessLevel": "contributor", "canWrite": True}
        self.records = {identity: self.new_meeting(identity) for identity in (MAIN, OTHER, OUTSIDE)}
        self.list_ids = [MAIN, OTHER]
        self.head = media()
        self.proposals = [self.proposal(1), self.proposal(2)]
        self.plans, self.defaults = defaultdict(deque), {}
        self.actions, self.calendar_plans = deque(), deque()
        self.held, self.requests, self.releases = {}, [], []
        self.max_effects, self.max_calendar = max_effects, max_calendar
        self.calendar_count = 0
        self.leaving_for_assistant = False

    def new_meeting(self, identity, revision=1):
        return {"schemaVersion": 1, "tenantId": self.tenant_id, "workspaceId": WORKSPACE,
                "meetingId": identity, "meetingRevisionId": f"{identity}:v{revision}", "revision": revision,
                "meetingSha256": digest(f"{identity}:{revision}"), "ownerActorId": self.actor_id,
                "title": "Customer release review" if identity == MAIN else "Outside the bounded timeline" if identity == OUTSIDE else "Other meeting",
                "summary": "Revision-bound customer evidence. " + LONG + "\n" + MARKUP,
                "status": "scheduled", "scheduledStartAt": STAMP, "scheduledEndAt": "2026-10-03T13:00:00.000Z",
                "actualStartAt": None, "actualEndAt": None, "timezone": "UTC", "location": "Review room",
                "projectId": PROJECT, "declaredAccessClass": "owner_private", "effectiveAccessClass": "owner_private",
                "revisedAt": STAMP, "participants": [participant(), participant(GUEST, "Review guest", "guest@example.test")],
                "sourceLinks": [source_link()] if identity == MAIN else [], "entityLinks": [],
                "decisions": [], "commitments": [], "followUps": []}

    def bump(self, identity=MAIN, **changes):
        row = self.records[identity]
        revision = row["revision"] + 1
        row.update(changes, revision=revision, meetingRevisionId=f"{identity}:v{revision}", meetingSha256=digest(f"{identity}:{revision}"))
        return row

    def proposal(self, number, version=1):
        return {"proposal": {"proposalId": f"proposal:{number}", "proposalSha256": digest(f"proposal:{number}:{version}"),
                "proposedByActorId": self.actor_id,
                "meetingId": MAIN, "meetingRevisionId": self.records[MAIN]["meetingRevisionId"], "projectId": PROJECT,
                "mediaRevisionId": MEDIA, "actionItemId": f"action:{number}", "title": f"Review action {number}, source version {version}.",
                "citations": [citation()], "ownership": {"participantId": OWNER, "displayName": "Review owner", "authority": "explicit_transcript"},
                "dueDate": {"dueAt": None, "authority": "confirmation_required"}}, "resolution": None}

    def detail(self, identity=MAIN):
        return {"context": copy.deepcopy(self.context), "meeting": copy.deepcopy(self.records[identity]),
                "linkedSources": [source(self.head)] if identity == MAIN else []}

    def commitment_read(self, identity=MAIN):
        return {"context": copy.deepcopy(self.context), "meeting": copy.deepcopy(self.records[identity]),
                "commitments": copy.deepcopy(self.proposals) if identity == MAIN else [],
                "eligiblePolicies": [{"id": POLICY, "displayName": "Owner email policy", "address": EMAIL, "channel": "email"}]}

    def draft(self, identity=MAIN, **changes):
        result = {key: copy.deepcopy(self.records[identity][key]) for key in DRAFT_FIELDS}
        result.update(changes)
        result["sourceLinks"] = [{key: link[key] for key in ("linkId", "kind", "sourceId", "sourceRevisionId", "mediaRole", "label")} for link in result["sourceLinks"]]
        return result

    def read_plan(self, key, *, body=None, status=200, hold=None):
        self.plans[key].append({"body": copy.deepcopy(body), "status": status, "hold": hold})

    def fail(self, *keys):
        for key in keys:
            self.defaults[key] = {"body": {"error": "Synthetic " + key + " unavailable."}, "status": 503}

    def serve(self, route, key, body):
        if len(self.requests) >= 300:
            return self.reject(route, "read_budget")
        self.requests.append({"key": key, "method": route.request.method, "url": route.request.url})
        plan = self.plans[key].popleft() if self.plans[key] else self.defaults.get(key, {})
        result = copy.deepcopy(body if plan.get("body") is None else plan["body"])
        if plan.get("hold"):
            self.held[plan["hold"]] = (route, result, plan.get("status", 200))
            return
        return self.fulfill(route, result, plan.get("status", 200))

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

    def expect_action(self, kind, body, *, identity=MAIN, mode="success", hold=None, after_fail=()):
        self.actions.append({"kind": kind, "body": copy.deepcopy(body), "identity": identity, "mode": mode,
                             "hold": hold, "after_fail": after_fail})

    def resolution_body(self, number=1, decision="confirmed", communication=None):
        proposal = next(view["proposal"] for view in self.proposals if view["proposal"]["proposalId"] == f"proposal:{number}")
        body = {"proposalId": proposal["proposalId"], "expectedProposalSha256": proposal["proposalSha256"], "decision": decision}
        if decision == "confirmed":
            body.update(ownerParticipantId=OWNER, dueAt=None, communication=communication)
        return body

    def resolution_digest(self, proposal, body):
        communication = copy.deepcopy(body.get("communication"))
        if communication:
            communication.update(connectionId=None, subject=communication["subject"].strip(), body=communication["body"].strip())
        request = {"decision": "dismissed"} if body["decision"] == "dismissed" else {
            "decision": "confirmed", "ownerParticipantId": body.get("ownerParticipantId") or proposal["ownership"]["participantId"],
            "dueAt": body.get("dueAt", proposal["dueDate"]["dueAt"]), "communication": communication}
        intent = {"schemaVersion": 1, "contract": "meeting-commitment-resolution-intent:1", "tenantId": self.tenant_id,
                  "workspaceId": WORKSPACE, "meetingId": proposal["meetingId"], "proposalId": proposal["proposalId"],
                  "proposalSha256": proposal["proposalSha256"], "ownerActorId": proposal["proposedByActorId"], "request": request}
        return digest(json.dumps(intent, sort_keys=True, separators=(",", ":"), ensure_ascii=False))

    def action_result(self, plan):
        kind, mode, body, identity = (plan[key] for key in ("kind", "mode", "body", "identity"))
        if mode == "conflict":
            return {"error": "Synthetic immutable revision conflict."}, 409
        if mode == "malformed":
            return {}, 200
        if kind in ("create", "edit"):
            revision = body.get("expectedRevision", 0) + 1
            row = self.new_meeting(identity, revision)
            row.update({key: copy.deepcopy(body[key]) for key in DRAFT_FIELDS})
            # The server resolves the submitted source identities into immutable hashes.
            if row["sourceLinks"]:
                row["sourceLinks"] = [source_link()]
            if mode == "success":
                self.records[identity] = row
                if identity not in self.list_ids:
                    self.list_ids.insert(0, identity)
            result = {"context": self.context, "meeting": row, "linkedSources": [source(self.head)] if identity == MAIN else []}
            return result, 201 if kind == "create" else 200
        if kind == "media":
            head = media("queued")
            result = {"recording": {"id": RECORDING}, "media": {key: value for key, value in head.items() if key not in ("output", "rawAudioDeletedAt")},
                      "job": {"id": head["operationJobId"], "status": "queued"}}
            result["media"].update(recordingId=RECORDING, meetingId=MAIN if mode == "success" else OTHER)
            if mode == "success":
                self.head = head
            return result, 202
        if kind == "propose":
            view = self.proposal(3)
            if mode == "success":
                self.proposals.append(view)
            else:
                view["proposal"]["mediaRevisionId"] = "unrelated:media"
            return {"context": self.context, "commitment": view}, 201
        view = copy.deepcopy(next(item for item in self.proposals if item["proposal"]["proposalId"] == body["proposalId"]))
        proposal = view["proposal"]
        request_sha256 = self.resolution_digest(proposal, body)
        if mode in ("lost_response", "reconciliation_pending"):
            view["reconciliation"] = {"schemaVersion": 1, "requestSha256": request_sha256,
                "decision": body["decision"], "state": "uncertain", "automaticRetryAllowed": False, "createdAt": STAMP,
                "phases": [{"phase": "work_started", "at": STAMP, "resourceId": None, "evidenceSha256": None},
                           {"phase": "work_completed", "at": STAMP, "resourceId": KNOWN_WORK, "evidenceSha256": digest("known-work")},
                           {"phase": "interrupted", "at": STAMP, "resourceId": None, "evidenceSha256": None}]}
            if mode == "reconciliation_pending":
                view["reconciliation"].update(state="pending", phases=[])
            self.proposals = [view if item["proposal"]["proposalId"] == proposal["proposalId"] else item for item in self.proposals]
            return {"error": "An existing immutable decision requires inspection.", "code": "meeting_commitment_reconciliation_required", "reconciliation": view["reconciliation"]}, 409
        confirmed = body["decision"] == "confirmed"
        communication = body.get("communication")
        number = proposal["proposalId"].split(":")[-1]
        resolution = {"proposalId": proposal["proposalId"], "proposalSha256": proposal["proposalSha256"],
                      "resolutionSha256": digest("resolution:" + proposal["proposalSha256"]), "decision": body["decision"],
                      "ownerParticipantId": body.get("ownerParticipantId") if confirmed else None,
                      "ownerDisplayName": "Review owner" if confirmed else None,
                      "ownershipAuthority": "explicit_transcript" if confirmed else None,
                      "dueAt": body.get("dueAt") if confirmed else None, "dueDateAuthority": "user_confirmed" if body.get("dueAt") else None,
                      "workItemId": "work:browser-" + number if confirmed else None,
                      "draftId": "draft:browser-" + number if communication else None,
                      "communicationPolicyId": communication["policyId"] if communication else None,
                      "meetingRevisionId": f"{MAIN}:v{self.records[MAIN]['revision'] + 1}" if confirmed else None}
        view["resolution"] = resolution
        phases = ["work_started", "work_completed"] if confirmed else []
        if communication:
            phases.extend(["draft_started", "draft_completed"])
        if confirmed:
            phases.extend(["meeting_started", "meeting_completed"])
        phases.append("resolution_started")
        resources = {"work_completed": resolution["workItemId"], "draft_completed": resolution["draftId"],
                     "meeting_completed": resolution["meetingRevisionId"]}
        view["reconciliation"] = {"schemaVersion": 1, "requestSha256": request_sha256,
            "decision": body["decision"], "state": "resolved", "automaticRetryAllowed": False, "createdAt": STAMP,
            "phases": [{"phase": phase, "at": STAMP, "resourceId": resources.get(phase),
                        "evidenceSha256": digest(phase + ":" + proposal["proposalSha256"]) if phase.endswith("_completed") else None}
                       for phase in phases]}
        result = {"commitment": view}
        if communication:
            result["draft"] = {"id": resolution["draftId"], "policyId": communication["policyId"], "recipient": EMAIL,
                               "subject": communication["subject"].strip(), "body": communication["body"].strip(),
                               "draftSha256": digest("draft:" + proposal["proposalSha256"])}
            if mode == "wrong_draft":
                result["draft"]["body"] = "UNRELATED_BODY_MUST_NOT_CONFIRM"
        if mode == "success":
            if confirmed:
                result["meeting"] = copy.deepcopy(self.bump(MAIN))
            self.proposals = [view if item["proposal"]["proposalId"] == proposal["proposalId"] else item for item in self.proposals]
        return result, 200

    def mutation(self, route, path):
        request = route.request
        query = parse_qs(urlsplit(request.url).query)
        if path == "/api/oauth/google/sync":
            if (request.method != "POST" or query != {"source": ["calendar"]} or request.post_data not in (None, "") or
                    "idempotency-key" in request.headers or "x-idempotency-key" in request.headers or self.calendar_count >= self.max_calendar):
                return self.reject(route, "calendar_contract")
            self.calendar_count += 1
            plan = self.calendar_plans.popleft() if self.calendar_plans else {"body": {"provider": "google", "sources": []}}
            self.writes.append({"kind": "calendar", "path": path, "query": query, "body": None, "disposition": "locally_fulfilled"})
            result = plan.get("body", {"provider": "google", "sources": [{"source": "calendar", "status": "healthy", "imported": 0}]})
            if plan.get("hold"):
                self.held[plan["hold"]] = (route, result, plan.get("status", 200))
                return
            return self.fulfill(route, result, plan.get("status", 200))
        plan = self.actions[0] if self.actions else None
        if not plan or sum(row["kind"] != "calendar" for row in self.writes) >= self.max_effects:
            return self.reject(route, "undeclared_effect")
        kind, identity, expected = plan["kind"], plan["identity"], plan["body"]
        method = "PATCH" if kind in ("edit", "resolve") else "POST"
        expected_path = "/api/meetings" if kind == "create" else api_path(identity)
        if kind in ("resolve", "propose"):
            expected_path += "/commitments"
        if kind == "media":
            expected_path = "/api/capture/recordings/" + quote(RECORDING, safe="") + "/complete"
        try:
            body = request.post_data_json
        except Exception:
            body = None
        key = request.headers.get("idempotency-key", "")
        pattern = {"create": "meeting-create:" + UUID,
                   "edit": re.escape(f"meeting-update:{identity}:{expected.get('expectedRevision')}:") + UUID,
                   "media": re.escape(f"meeting-media:{identity}:{RECORDING}"),
                   "propose": re.escape(f"meeting-proposal:{MEDIA}:action:3"),
                   "resolve": re.escape("meeting-resolution:" + expected.get("expectedProposalSha256", ""))}[kind]
        if (request.method != method or path != expected_path or query or body != expected or not re.fullmatch(pattern, key)
                or "x-idempotency-key" in request.headers or not request.headers.get("content-type", "").startswith("application/json")):
            return self.reject(route, "effect_contract", {"expected": expected, "actual": body, "key": key})
        self.actions.popleft()
        result, status = self.action_result(plan)
        self.writes.append({"kind": kind, "path": path, "body": body, "idempotency-key": key, "disposition": "synthetic_" + plan["mode"]})
        self.fail(*plan["after_fail"])
        if plan["mode"] == "lost_response":
            return route.abort("failed")
        if plan["hold"]:
            self.held[plan["hold"]] = (route, result, status)
            return
        return self.fulfill(route, result, status)

    def reject(self, route, reason, detail=None):
        self.unexpected.append({"kind": reason, "method": route.request.method, "url": route.request.url, "detail": detail})
        return self.fulfill(route, {"error": "Unexpected Meetings request blocked."}, 503)

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return super().route(route) if path == "/__nextjs_original-stack-frames" else self.mutation(route, path)
        if path == "/api/meetings":
            if query != {"limit": ["200"]}:
                return self.reject(route, "list_bound")
            return self.serve(route, "list", {"context": self.context, "meetings": [self.records[identity] for identity in self.list_ids]})
        if path.startswith("/api/meetings/"):
            if query:
                return self.reject(route, "detail_query")
            tail = path[len("/api/meetings/"):]
            commitments = tail.endswith("/commitments")
            identity = unquote(tail[:-len("/commitments")] if commitments else tail)
            if identity not in self.records:
                return self.reject(route, "unknown_meeting")
            key = ("commitments:" if commitments else "detail:") + identity
            return self.serve(route, key, self.commitment_read(identity) if commitments else self.detail(identity))
        if path == "/api/projects":
            if self.leaving_for_assistant and not query:
                # Assistant's independent optional picker is outside Meetings;
                # the shared fixture reports it unavailable without live reads.
                return super().route(route)
            if query != {"view": ["summary"], "limit": ["100"]}:
                return self.reject(route, "project_bound")
            return self.serve(route, "projects", {"projects": [{"id": PROJECT, "title": "Release evidence"}]})
        if path == "/api/entities":
            return self.serve(route, "entities", {"entities": [{"entityId": "entity:customer", "entityTypeId": "organization", "canonicalLabel": "Customer organization", "state": "active"}]})
        if path == "/api/library":
            if query != {"kind": ["meeting,recording,transcript,document,file,image,audio,video"], "limit": ["100"]}:
                return self.reject(route, "library_bound")
            return self.serve(route, "library", {"items": [{"id": "library:recording", "kind": "recording", "sourceAuthority": "capture_recording", "sourceId": RECORDING,
                "title": "Customer recording", "sourceLabel": "Capture", "status": "ready", "currentVersion": {"sourceRevisionId": RECORDING + ":v1", "mediaType": "audio/webm"}}]})
        return super().route(route)
