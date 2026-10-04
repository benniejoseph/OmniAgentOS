"""Bounded Capture/Library reads and exact synthetic reindex receipts only."""

import copy
import hashlib
import json
import re
from collections import defaultdict, deque
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

RECORDING = "recording-outside-six"
RETAINED = "recording-retained-owner"
LITERAL = "Full exact transcript <script>window.captureFixtureExecuted=true</script> & literal evidence"
LONG = "Exact_source_" + "x" * 140


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def asset(owner, index):
    return {**owner, "id": f"original-{index}", "filename": f"Original {index} {LONG}.txt", "mediaType": "text/plain", "extension": "txt",
            "byteCount": 40 + index, "contentSha256": str(index) * 64, "storageKind": "database", "status": "stored", "extractionStatus": "pending",
            "tags": ["synthetic"], "metadata": {}, "createdAt": STAMP, "updatedAt": STAMP, "manageable": True, "indexable": True, "contentAvailable": True}


def library_item(owner, source="original-1", authority="capture_asset", kind="document"):
    return {"schemaVersion": 1, "id": f"library:{authority}:{source}", "tenantId": owner["tenantId"], "kind": kind, "sourceAuthority": authority, "sourceId": source,
            "title": f"Current {kind} {source} {LONG}", "summary": "Stored source identity and current version. <literal>", "sourceLabel": "Synthetic Capture", "status": "ready", "tags": ["exact"],
            "scope": {"visibility": "user_private", "ownerActorId": owner["actorId"], "workspaceId": None, "projectId": None, "missionId": None, "workItemId": None, "permissionBasis": "owner"},
            "currentVersion": {"versionId": f"version:{source}:exact-current", "versionNumber": 3, "contentSha256": "a" * 64, "byteCount": 90, "mediaType": "text/plain", "sourceRevisionId": f"source-revision:{source}", "createdAt": STAMP},
            "versionCount": 5, "citationRefs": [f"source:{source}:first:{LONG}", f"source:{source}:second:{LONG}"], "links": [],
            "openHref": f"/api/capture/assets/{source}?content=1" if authority == "capture_asset" else f"/app/capture?recording={source}", "createdAt": STAMP, "updatedAt": STAMP}


def library_envelope(items, offset=0):
    rows = items[offset:offset + 2]
    more = offset + len(rows) < len(items)
    return {"items": rows, "total": offset + len(rows) + int(more), "totalIsLowerBound": more,
            "nextOffset": offset + len(rows) if more else None, "countsByKind": {"document": 1, "recording": 1, "transcript": 1} if items else {}, "countsAreLowerBound": more}


def recording_metadata(recording_id=RECORDING):
    private = recording_id == RECORDING
    return {"id": recording_id, "title": ("Exact older recording " if private else "Retained recording ") + LONG,
            "status": "ready", "language": "en", "tags": ["history"], "startedAt": STAMP, "completedAt": STAMP, "durationMs": 12_000, "byteCount": 1200,
            "segmentCount": 12, "createdAt": STAMP, "updatedAt": STAMP, "metadataAvailable": True, "segmentMetadataAvailable": True,
            "transcriptAvailable": private, "audioAvailable": private, "manageable": private,
            "segments": [{"id": f"{recording_id}-segment-{i}", "segmentIndex": i, "mimeType": "audio/webm", "durationMs": 1000, "byteCount": 100,
                          "transcriptionStatus": "completed", "createdAt": STAMP, "updatedAt": STAMP} for i in range(12)]}


def metadata_envelope(recording_id=RECORDING):
    return {"recording": recording_metadata(recording_id), "requestReadContracts": {"captureRecordingDetail": "readable_v1"}}


def private_envelope(owner):
    value = recording_metadata()
    value.update({**owner, "transcript": LITERAL, "source": "synthetic_recording", "metadata": {}})
    value["segments"] = [{**segment, **owner, "recordingId": RECORDING, "transcript": f"Exact segment {i}", "audioSha256": "b" * 64, "metadata": {}} for i, segment in enumerate(value["segments"])]
    return {"recording": value, "requestReadContracts": {"captureRecordingDetail": "exact_v1"}}


def index_receipt(original, key, mode):
    status = {"duplicate": "running", "repair": "completed"}.get(mode, "queued")
    data = {"asset": {k: v for k, v in original.items() if k not in ("manageable", "indexable", "contentAvailable")},
            "job": {"id": "index-job-" + original["id"], "type": "capture.asset.process", "status": status, "priority": 0, "attempt": 0, "maxAttempts": 3, "runAt": STAMP, "createdAt": STAMP, "updatedAt": STAMP}}
    data["asset"].update({"status": "indexed" if mode == "repair" else "queued", "ingestJobId": data["job"]["id"]})
    if mode in ("duplicate", "repair"):
        data["duplicate"] = True
    if mode == "repair":
        data["repaired"] = True
        data["asset"]["knowledgeDocumentId"] = "knowledge-exact"
    body = {"schemaVersion": 1, "receiptKind": "app_service_receipt", "boundaryVersion": "p9.1-app-service-boundary:1", "operation": "app.assets.index", "action": "write.memory",
            "resourceType": "capture_asset", "accessMode": "mutation", "eventContract": "capture-events.v1", "authoritySha256": "c" * 64,
            "idempotencyKeySha256": hashlib.sha256((original["tenantId"] + "\0" + key).encode()).hexdigest(), "outcomeSha256": digest(data), "resourceCount": 1, "occurredAt": STAMP}
    result = {**data, "serviceReceipt": {**body, "receiptSha256": digest(body)}}
    if mode == "malformed":
        return {"asset": result["asset"], "job": result["job"]}
    if mode == "mismatch":
        result["job"]["id"] = "different-job"
    return result


class CaptureLibraryFixtures(Fixtures):
    def __init__(self, origin, owner, post_budget=0):
        super().__init__(origin)
        self.owner, self.post_budget = owner, post_budget
        self.assets = [asset(owner, i) for i in range(1, 7)]
        self.items = [library_item(owner), library_item(owner, RECORDING, "capture_recording", "recording"), library_item(owner, RETAINED, "capture_transcript", "transcript")]
        self.requests, self.defaults, self.plans, self.held = [], {}, defaultdict(deque), {}
        self.post_modes, self.post_holds, self.releases = {}, {}, []

    def route(self, route):
        request, parsed = route.request, urlsplit(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        path, query = parsed.path, parse_qs(parsed.query)
        if request.method == "POST" and re.fullmatch(r"/api/capture/assets/original-[1-6]", path):
            original_id = path.rsplit("/", 1)[1]
            original = next(value for value in self.assets if value["id"] == original_id)
            key = request.headers.get("idempotency-key", "")
            if (parsed.query or request.post_data != "{}" or request.headers.get("content-type") != "application/json"
                    or not re.fullmatch(r"capture-reindex-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", key)
                    or len(self.writes) >= self.post_budget or any(value["key"] == key for value in self.writes)):
                self.unexpected.append({"kind": "index_contract", "path": path, "key": key, "body": request.post_data})
                return route.abort()
            mode = self.post_modes.get(original_id, "queued")
            self.writes.append({"path": path, "key": key, "body": {}, "mode": mode})
            if mode == "lost":
                return route.abort("failed")
            body = index_receipt(original, key, mode)
            return self.answer(route, {"body": body, "status": 202, "hold": self.post_holds.get(original_id)})
        if request.method != "GET":
            return super().route(route)
        key, body = None, None
        if path == "/api/library":
            if set(query) - {"q", "kind", "project", "limit", "offset"} or query.get("limit") not in (["100"], ["12"]) or not re.fullmatch(r"\d+", query.get("offset", ["0"])[0]):
                return self.reject(route, "library_bounds", query)
            offset, search = int(query.get("offset", ["0"])[0]), query.get("q", [""])[0]
            key = f"library:{search}:{offset}"
            matching = [value for value in self.items if value["kind"] in query.get("kind", [value["kind"]])]
            body = library_envelope([] if search == "empty" else matching, offset)
        elif path.startswith("/api/library/"):
            item_id = unquote(path[len("/api/library/"):])
            matching = next((value for value in self.items if value["id"] == item_id), None)
            if not matching or query:
                return self.reject(route, "exact_library", path)
            key, body = "exact:" + item_id, {"item": matching}
        elif path == "/api/capture":
            if query != {"limit": ["100"]}:
                return self.reject(route, "capture_bounds", query)
            key, body = "capture", {"assets": self.assets, "processingJobs": []}
        elif path == "/api/capture/recordings":
            if query != {"limit": ["6"], "ownerScope": ["readable"]}:
                return self.reject(route, "recording_bounds", query)
            rows = [{"id": f"recent-{i}", "title": f"Recent metadata {i}", "status": "ready", "startedAt": STAMP, "completedAt": STAMP, "durationMs": 1000,
                     "segmentCount": 1, "updatedAt": STAMP, "metadataDetailAvailable": True, "detailAvailable": False, "manageable": False} for i in range(6)]
            key, body = "history", {"recordings": rows, "requestReadContracts": {"captureRecordings": "readable_v1"}}
        elif path in ("/api/capture/recordings/" + RECORDING, "/api/capture/recordings/" + RETAINED):
            recording_id = path.rsplit("/", 1)[1]
            if query == {"ownerScope": ["readable"]}:
                key, body = "metadata:" + recording_id, metadata_envelope(recording_id)
            elif not query and recording_id == RECORDING:
                key, body = "private:" + recording_id, private_envelope(self.owner)
            else:
                return self.reject(route, "private_owner_contract", {"path": path, "query": query})
        elif path.startswith("/api/capture/assets/") or path.startswith("/api/capture/recordings/"):
            return self.reject(route, "unexpected_media_read", path)
        elif path == "/api/knowledge":
            return self.fulfill(route, {"documents": [], "stats": {"documents": 0, "chunks": 0, "embedded": 0}})
        elif path == "/api/oauth":
            return self.fulfill(route, {"providers": [], "grants": [], "requestReadContracts": {"oauthGrants": "readable_v1"}})
        elif path == "/api/capabilities":
            return self.fulfill(route, {"imageGenerationRoute": {"configured": False}, "videoGenerationRoute": {"configured": False}})
        else:
            return super().route(route)
        self.requests.append({"key": key, "path": path, "query": query})
        if len(self.requests) > 150:
            return self.reject(route, "read_budget", len(self.requests))
        spec = self.plans[key].popleft() if self.plans[key] else self.defaults.get(key, {"body": body, "status": 200})
        return self.answer(route, spec)

    def mutation(self, route, path):
        return self.reject(route, "unexpected_effect", {"path": path, "method": route.request.method})

    def reject(self, route, kind, detail):
        self.unexpected.append({"kind": kind, "detail": detail})
        return route.abort()

    def answer(self, route, spec):
        spec = copy.deepcopy(spec)
        if spec.get("hold"):
            name = spec["hold"]
            while name in self.held:
                name += ":again"
            self.held[name] = (route, spec)
            return
        return self.fulfill(route, spec["body"], spec.get("status", 200))

    def release(self, prefix):
        for name in list(self.held):
            if name == prefix or name.startswith(prefix + ":"):
                route, spec = self.held.pop(name)
                try:
                    self.fulfill(route, spec["body"], spec.get("status", 200))
                    self.releases.append({"name": name, "result": "fulfilled"})
                except PlaywrightError:
                    self.releases.append({"name": name, "result": "already_aborted"})

    def abort_held(self):
        for route, _ in self.held.values():
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.held.clear()
