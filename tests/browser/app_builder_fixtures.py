"""Exact synthetic Builder records. Sandbox/provider/Agent/production effects never reach a server."""
import copy
import hashlib
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urlsplit
from fixtures import Fixtures, STAMP

PROJECT = "builder:browser/exact-project"
ARTIFACT = "artifact:browser/exact-result"
SESSION = "app_build_" + "a" * 48
CHECKPOINT = "app_build_checkpoint_" + "b" * 48
VERIFICATION = "app_build_verification_" + "c" * 48
DEPLOYMENT = "app_build_deployment_" + "d" * 48
RELEASE = "app_build_release_" + "e" * 48
DIGEST = "f" * 64
UNTRUSTED = "Source <script>window.builderUntrustedRan=true</script>"


class BuilderFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.session = session
        assert session["user"]["id"] and session["context"]["actorId"] == session["user"]["email"]
        self.requests = []; self.mutations = []; self.fail_snapshot = False; self.fail_after_save = False
        self.fail_file = False; self.conflict_save = False; self.held = {}; self.hold_file = False
        self.content = "export default function Page() { return <main>Initial exact source</main>; }"
        self.sha = hashlib.sha256(self.content.encode()).hexdigest()
        self.readiness = {"status": "retired", "captures": [], "legacyField": True, "summary": "Retired legacy capture history.",
            "replacement": {"mode": "deterministic", "version": 1, "phase": "checkpoint", "status": "passed", "summary": "Lint and typecheck passed.",
                "signals": [{"name": "lint", "status": "passed"}, {"name": "typecheck", "status": "passed"}]}}
        verification = {"id": VERIFICATION, "sessionId": SESSION, "checkpointId": CHECKPOINT, "workspaceSha256": DIGEST,
            "status": "passed", "checks": [{"command": command, "status": "passed", "exitCode": 0, "durationMs": 2, "outputSha256": DIGEST} for command in ("lint", "typecheck")],
            "browserEvidence": copy.deepcopy(self.readiness), "createdAt": STAMP}
        deployment = {"id": DEPLOYMENT, "checkpointId": CHECKPOINT, "verificationId": VERIFICATION, "workspaceSha256": DIGEST,
            "fileManifestSha256": DIGEST, "fileCount": 1, "byteCount": 100, "secretScanSha256": DIGEST, "smokeRoutes": ["/"],
            "providerDeploymentId": "provider:preview/exact", "status": "ready", "logs": {"status": "captured", "sha256": DIGEST, "eventCount": 2},
            "routeEvidence": {"status": "passed", "routes": [{"path": "/", "status": "passed", "statusCode": 200, "durationMs": 2}]},
            "browserEvidence": copy.deepcopy(self.readiness), "createdAt": STAMP, "updatedAt": STAMP}
        release = {"id": RELEASE, "deploymentId": DEPLOYMENT, "previewProviderDeploymentId": deployment["providerDeploymentId"], "workspaceSha256": DIGEST,
            "previewEvidenceSha256": DIGEST, "releaseDigest": DIGEST, "migrationEvidence": {"status": "not_declared", "fileCount": 0, "manifestSha256": DIGEST},
            "rollbackEvidence": {"status": "available", "providerDeploymentId": "provider:previous-production/exact"}, "status": "review_pending",
            "logs": deployment["logs"], "routeEvidence": deployment["routeEvidence"], "browserEvidence": copy.deepcopy(self.readiness),
            "createdAt": STAMP, "updatedAt": STAMP, "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()}
        self.value = {"session": {"id": SESSION, "projectId": PROJECT, "status": "ready", "revision": 2, "currentCheckpointId": CHECKPOINT, "templateId": "TypeScript starter", "updatedAt": STAMP},
            "activity": [{"id": "activity:exact", "eventType": "app_builder.sentinel.reviewed", "detail": {"verificationId": VERIFICATION, "checkpointId": CHECKPOINT, "workspaceSha256": DIGEST, "verdict": "passed"}, "occurredAt": STAMP}],
            "checkpoints": [{"id": CHECKPOINT, "sessionId": SESSION, "workspaceSha256": DIGEST, "fileCount": 1, "snapshotBytes": 100, "reason": "manual", "label": UNTRUSTED, "sessionRevision": 2, "createdAt": STAMP}],
            "verifications": [verification], "deliveries": [], "deployments": [deployment], "releases": [release], "repositoryBinding": None, "repositoryWorkspace": None,
            "github": {"configured": True, "missing": []}, "vercel": {"configured": True, "missing": []},
            "previewUrl": "https://builder-sandbox.example.test/?asael_preview=synthetic-private-token"}

    def project(self):
        status = {"schemaVersion": 1, "authority": "canonical_work_item_v1", "persistence": "postgres", "workspaceId": "workspace:builder",
            "projectId": PROJECT, "workItemId": "task:exact", "kind": "task", "sourceAuthority": "legacy_project_task", "sourceId": "task:exact",
            "status": "succeeded", "sourceStatus": "done", "statusRevision": 1, "updatedAt": STAMP}
        work = {"version": "p11.4-work-item-surface:1", "projection": {"authority": "canonical_work_item_v1", "sha256": DIGEST, "sourceRevisionSha256": DIGEST},
            "status": status, "assignment": {"authority": "canonical_work_item_v1", "agents": []},
            "artifacts": {"authority": "canonical_work_item_v1", "count": 1, "items": [{"artifactId": ARTIFACT, "kind": "app", "evidenceCount": 0}]},
            "execution": {"authority": "governed_workflow_v1", "availability": "current", "workflowRunId": "workflow:exact", "sourceStatus": "completed",
                "currentStep": None, "completedSteps": 1, "totalSteps": 1, "progressPercent": 100, "updatedAt": STAMP},
            "cost": {"authority": "ai_usage_ledger_v1", "state": "not_recorded", "usageReceiptCount": 0, "unknownCostReceiptCount": 0, "totalTokens": 0, "knownEstimatedCostMicrousd": 0}}
        task = {"id": "task:exact", "title": "Build this exact artifact", "status": "done", "priority": "medium", "agentId": "forge", "order": 0,
            "dependencies": [], "updatedAt": STAMP, "workItemStatus": status, "workItem": work}
        return {"id": PROJECT, "title": "Synthetic app delivery", "objective": "Build and review one exact app revision", "status": "active", "autonomyMode": "manual",
            "executionStatus": "idle", "taskBudget": 3, "tasksDispatched": 0, "maxParallelTasks": 1, "requireApproval": True, "updatedAt": STAMP, "tasks": [task],
            "artifacts": [{"id": ARTIFACT, "taskId": "task:exact", "workflowRunId": "workflow:exact", "agentId": "forge", "status": "verified", "title": "Exact selected app artifact",
                "content": "Synthetic result only", "evidenceRefs": [], "createdAt": STAMP}]}

    def route(self, route):
        parsed = urlsplit(route.request.url); path = unquote(parsed.path); params = parse_qs(parsed.query)
        if parsed.netloc == "builder-sandbox.example.test":
            return route.fulfill(status=200, content_type="text/html", body="<!doctype html><html><head><title>Synthetic isolated preview</title></head><body><main><h1>Isolated app preview</h1></main></body></html>")
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin: return super().route(route)
        if path == "/api/auth/session": return self.fulfill(route, self.session)
        if path == "/api/projects" and route.request.method == "GET": return self.fulfill(route, {"projects": [self.project()]})
        if path == "/api/workspace-templates": return self.fulfill(route, {"templates": []})
        if path == "/api/projects/" + PROJECT + "/builder":
            if route.request.method != "GET": return self.mutation(route, path)
            self.requests.append({"path": path, "query": params}); view = params.get("view", ["session"])[0]
            if view == "session":
                if self.fail_snapshot: return self.fulfill(route, {"error": "Synthetic snapshot refresh unavailable"}, 503)
                return self.fulfill(route, self.value)
            if view in ("file", "tree", "search") and params.get("sessionId") != [SESSION]:
                self.unexpected.append({"kind": "wrong_session", "query": params}); return self.fulfill(route, {"error": "Wrong session"}, 404)
            if view in ("tree", "search"): return self.fulfill(route, {"entries": [{"path": "app/page.tsx", "kind": "file", "size": len(self.content)}]})
            if view == "file":
                body = {"file": {"path": params.get("path", [""])[0], "content": self.content, "sha256": self.sha, "size": len(self.content)}}
                if self.hold_file: self.held["file"] = (route, body); return
                if self.fail_file: return self.fulfill(route, {"error": "Synthetic file read failed"}, 503)
                return self.fulfill(route, body)
            if view == "github.repositories": return self.fulfill(route, {"repositories": [{"repositoryId": "12345", "owner": "synthetic", "name": "app", "fullName": "synthetic/app", "private": True, "defaultBranch": "main", "htmlUrl": "https://github.example.test/synthetic/app"}]})
            self.unexpected.append({"kind": "wrong_view", "query": params}); return self.fulfill(route, {"error": "Unsupported synthetic view"}, 400)
        return super().route(route)

    def mutation(self, route, path):
        if path != "/api/projects/" + PROJECT + "/builder": return super().mutation(route, path)
        body = route.request.post_data_json; key = route.request.headers.get("idempotency-key")
        self.mutations.append({"body": copy.deepcopy(body), "key": key})
        if not key or body.get("sessionId") != SESSION: self.unexpected.append({"kind": "invalid_mutation_scope"}); return self.fulfill(route, {"error": "Invalid scope"}, 400)
        action = body.get("action")
        if action == "file.update":
            if self.conflict_save or body.get("expectedSha256") != self.sha: return self.fulfill(route, {"error": "File revision changed. Refresh and review the current source."}, 409)
            self.content = body["content"]; self.sha = hashlib.sha256(self.content.encode()).hexdigest()
            self.value["session"]["revision"] += 1
            if self.fail_after_save: self.fail_snapshot = True
            return self.fulfill(route, {"updated": True, "serviceReceipt": {"receiptSha256": DIGEST}})
        if action == "repository.bind" and body.get("repositoryId") == "12345":
            self.value["repositoryBinding"] = {"id": "app_build_repository_" + "3" * 48, "repositoryId": "12345", "repositoryFullName": "synthetic/app", "private": True,
                "defaultBranch": "main", "baseSha": "4" * 40, "revision": 1, "updatedAt": STAMP}
            return self.fulfill(route, {"repositoryBinding": self.value["repositoryBinding"], "serviceReceipt": {"receiptSha256": DIGEST}})
        if action == "repository.checkout" and body.get("repositoryBindingId") == self.value["repositoryBinding"]["id"] and body.get("expectedBindingRevision") == 1:
            self.value["repositoryWorkspace"] = {"contractVersion": "app-builder-repository-workspace:1", "repositoryId": "12345", "repositoryFullName": "synthetic/app", "baseSha": "4" * 40,
                "archiveSha256": DIGEST, "workspaceSha256": DIGEST, "fileCount": 1, "importedAt": STAMP}
            return self.fulfill(route, {"session": self.value["session"], "repositoryBinding": self.value["repositoryBinding"], "repositoryWorkspace": self.value["repositoryWorkspace"],
                "previewUrl": self.value["previewUrl"], "serviceReceipt": {"receiptSha256": DIGEST}})
        if (action == "delivery.create" and body.get("repositoryBindingId") == self.value["repositoryBinding"]["id"] and body.get("expectedBindingRevision") == 1
                and body.get("checkpointId") == CHECKPOINT and body.get("verificationId") == VERIFICATION and body.get("draft") is True):
            delivery = {"id": "app_build_delivery_" + "5" * 48, "repositoryBindingId": body["repositoryBindingId"], "checkpointId": CHECKPOINT, "verificationId": VERIFICATION,
                "workspaceSha256": DIGEST, "baseSha": "4" * 40, "branchName": body["branchName"], "commitSha": "6" * 40, "pullRequestNumber": 7,
                "pullRequestUrl": "https://github.example.test/synthetic/app/pull/7", "secretScanSha256": DIGEST, "secretFindingCount": 0, "status": "pull_request_open", "createdAt": STAMP, "updatedAt": STAMP}
            self.value["deliveries"].insert(0, delivery)
            return self.fulfill(route, {"delivery": delivery, "serviceReceipt": {"receiptSha256": DIGEST}})
        if action == "command.run": return self.fulfill(route, {"result": {"exitCode": 0, "stdout": "Synthetic focused check passed", "stderr": "", "durationMs": 2}, "serviceReceipt": {"receiptSha256": DIGEST}})
        if action == "release.production" and body.get("releaseId") == RELEASE and body.get("releaseDigest") == self.value["releases"][0]["releaseDigest"] and body.get("confirmation") == "RELEASE":
            self.value["releases"][0]["status"] = "healthy"; self.value["releases"][0]["providerDeploymentId"] = "provider:production/exact"
            return self.fulfill(route, {"release": self.value["releases"][0], "serviceReceipt": {"receiptSha256": DIGEST}})
        if action == "stop":
            self.value["session"]["status"] = "stopped"; self.value["previewUrl"] = None
            return self.fulfill(route, {**self.value, "serviceReceipt": {"receiptSha256": DIGEST}})
        self.unexpected.append({"kind": "unsupported_builder_mutation", "body": body}); return self.fulfill(route, {"error": "Unsupported synthetic mutation"}, 400)

    def release_held(self):
        for route, body in self.held.values():
            try: self.fulfill(route, body)
            except Exception: pass
        self.held.clear()
