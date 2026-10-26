#!/usr/bin/env python3
"""Installed, hash-pinned Mac release controller. No effects on import."""
from __future__ import annotations
import argparse
import contextlib
from datetime import datetime, timezone, timedelta
import fcntl
import hashlib
import http.client
from http.cookies import SimpleCookie
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.parse

ORIGIN = "https://asael.bennierichard.com"
API = "/api/self-improvement/release-controller"
REPOSITORY = "benniejoseph/OmniAgentOS"
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
REQUIRED_CHECKS = {"focused_regression", "adjacent_regression", "typecheck", "independent_review"}
# An app approval never changes this installed control-plane boundary. Updating
# these surfaces requires a separately installed controller, not self-review.
PROTECTED = re.compile("|".join((
    r"^src/lib/(?:self-improvement|auth|security|db|tools|delegation|operations|workflows|capabilities|app-builder|release|releases)/",
    r"^src/(?:proxy|middleware|instrumentation)(?:\.|/)|^src/lib/config(?:\.|/)",
    r"^src/lib/(?:models|mcp)/|^src/lib/connectors/(?:credential|vault|oauth|native-|mcp-trust)",
    r"^src/lib/agents/(?:identity|principal|release|learning|adaptation|execution-improvement)(?:[./-]|$)",
    r"^src/lib/orchestration/(?:agent-runner|agent-tool-policy|loop-v2|continuation-authority|resume-queue|action-approval|clarification-approval|prompts)(?:[./-]|$)",
    r"^src/lib/app-services/(?:authorization|context|registry|tool-dispatcher|agent-governance|app-builder|self-improvement)(?:[./-]|$)",
    r"^src/app/api/(?:auth|oauth|release|internal|agent|agents|approvals|tools|security|mobile|capabilities|command|system|operations|mcp|openapi-connectors|connectors|plugins|skills|triggers|workflows|health|self-improvement)(?:/|$)|^src/app/api/projects/[^/]+/builder(?:/|$)",
    r"(?:^|/)(?:supabase/migrations|prisma/migrations|drizzle|migrations)(?:/|$)",
    r"^(?:apps|native|packages/native)/",
    r"^(?:scripts/|\.github/|\.husky/|dockerfile|fly\.|vercel\.json|schema-migrations\.json)",
    r"^(?:package(?:-lock)?\.json|(?:pnpm|yarn|bun)\.lockb?|next\.config\.|tsconfig|vitest\.|eslint\.|performance-budgets\.json)",
    r"(?:^|/)(?:agents|claude)\.md$|^docs/(?:production-rollout|deployment|harness-engineering)\.md$",
    r"(?:^|/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|p12|pfx|mobileprovision)$)",
)), re.I)
NODE_BIN = "/opt/homebrew/opt/node@24/bin"

class Refused(Exception):
    """Only a fixed category, never subprocess/HTTP output, leaves the process."""

def require(value, category):
    if not value: raise Refused(category)

def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()

def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else encoded(value)).hexdigest()

def sealed(kind, value, field):
    require(isinstance(value, dict) and DIGEST.fullmatch(str(value.get(field, ""))), "invalid_sealed_record")
    body = {key: item for key, item in value.items() if key != field}
    expected = digest({"contract": "asael-self-improvement", "version": 1, "kind": kind, "value": body})
    require(value[field] == expected, "sealed_record_changed")

def now(): return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def age(value):
    try: return (datetime.now(timezone.utc) - datetime.fromisoformat(value.replace("Z", "+00:00"))).total_seconds()
    except (ValueError, TypeError, AttributeError): raise Refused("invalid_timestamp") from None

def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    try: return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(Refused("invalid_json")))
    except (ValueError, UnicodeError, RecursionError): raise Refused("invalid_json") from None

def private_read(path, limit=2_000_000):
    path = Path(path)
    require(path.is_absolute(), "private_path_required")
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077 and info.st_size <= limit, "private_file_invalid")
            result = source.read(limit + 1)
            require(len(result) <= limit, "private_file_too_large")
            return result
    except OSError: raise Refused("private_file_unavailable") from None

def private_directory(path):
    path = Path(path)
    info = path.lstat()
    require(path.is_absolute() and stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, "private_directory_invalid")
    return path

def write_new(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as output:
        output.write(encoded(value) + b"\n"); output.flush(); os.fsync(output.fileno())

def load_config(path, expected):
    raw = private_read(path, 100_000)
    require(DIGEST.fullmatch(expected) and digest(raw) == expected, "controller_configuration_changed")
    config = strict_json(raw)
    require(config.get("version") == 1 and config.get("repository") == REPOSITORY and config.get("verificationMode") in ("owner-authorized-live", "use-hosted-verification"), "controller_configuration_invalid")
    require(SHA.fullmatch(config.get("trustedRevision", "")), "trusted_revision_required")
    require(isinstance(config.get("allowedPolicySha256"), list) and config["allowedPolicySha256"] and all(DIGEST.fullmatch(item) for item in config["allowedPolicySha256"]), "installed_policy_required")
    require(config.get("ownerLiveReason") and len(config["ownerLiveReason"]) <= 200, "installed_authorization_required")
    root = Path(__file__).resolve().parent
    require(root == Path(config["installationDirectory"]) and not (root / ".git").exists(), "installed_controller_required")
    for name, expected_hash in config["sourceHashes"].items():
        require(re.fullmatch(r"[a-z_-]+\.py", name) and digest(private_read(root / name)) == expected_hash, "installed_controller_changed")
    require({"controller.py", "mac_credentials.py", "recovery.py"} <= set(config["sourceHashes"]), "controller_source_pins_missing")
    private_directory(config["stateDirectory"])
    require(Path(config["checkoutDirectory"]).is_absolute() and Path(config["checkoutDirectory"]).resolve() != root, "release_checkout_invalid")
    require(isinstance(config.get("controllerId"), str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", config["controllerId"]), "controller_id_invalid")
    require(isinstance(config.get("executablePath"), str) and all(Path(item).is_absolute() for item in config["executablePath"].split(":")), "controller_executable_path_invalid")
    node = Path(NODE_BIN) / "node"
    require(node.is_file() and os.access(node, os.X_OK), "node24_unavailable")
    version = subprocess.run([str(node), "--version"], capture_output=True, text=True, timeout=10)
    require(version.returncode == 0 and re.fullmatch(r"v24\.[0-9]+\.[0-9]+\n?", version.stdout), "node24_version_required")
    auth = config["releaseAuth"]
    require(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", auth["email"]) and DIGEST.fullmatch(auth["loginHelper"]["sha256"]), "credential_reference_invalid")
    require(digest(private_read(auth["loginHelper"]["path"])) == auth["loginHelper"]["sha256"], "saved_login_helper_changed")
    for reference in (auth["signingKeyFile"], auth["vercelAuthFile"]):
        info = Path(reference).lstat()
        require(Path(reference).is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, "credential_file_reference_invalid")
    for reference in (auth["gateway"], auth["vercelBypass"]):
        require(set(reference) == {"account", "service"} and all(isinstance(value, str) and 0 < len(value) <= 200 for value in reference.values()), "keychain_reference_invalid")
    recovery = config["recovery"]
    require(digest(private_read(recovery["sourceCa"]["path"], 32_000)) == recovery["sourceCa"]["sha256"], "source_ca_changed")
    for executable in (auth["vercelExecutable"], recovery["opensslExecutable"], str(Path(recovery["postgresBin"]) / "pg_ctl")):
        require(Path(executable).is_absolute() and os.access(executable, os.X_OK), "installed_executable_unavailable")
    require(1 <= config.get("maximumRecoveryAgeSeconds", 86400) <= 604800 and 1 <= config.get("maximumValidationAgeSeconds", 86400) <= 604800, "evidence_age_limit_invalid")
    return config

def release_usage(budget, usage=None, started=False):
    actual = None if started else 0
    if usage is not None:
        require(isinstance(usage, dict) and usage.get("reservedMicrousd") == round(budget["reservedUsd"] * 1_000_000), "release_usage_reservation_changed")
        amount, phases = usage.get("actualMicrousd"), usage.get("phases")
        require(isinstance(phases, list) and len(phases) <= 2, "release_usage_phases_invalid")
        require(amount is None or (type(amount) is int and 0 <= amount <= usage["reservedMicrousd"]), "release_usage_invalid")
        if amount is not None:
            require(all(type(phase.get("actualMicrousd")) is int and 0 <= phase["actualMicrousd"] <= phase["limitMicrousd"] for phase in phases) and sum(phase["actualMicrousd"] for phase in phases) == amount, "release_usage_sum_invalid")
            actual = amount / 1_000_000
    return {"phaseId": budget["phaseId"], "actualUsd": actual, "evidenceSha256": digest({"releaseBudget": budget, "usage": usage, "started": started})}

def validate_request(request, config, actor):
    require(isinstance(request, dict), "request_invalid")
    require(request.get("tenantId") == actor["tenantId"] and request.get("ownerActorId") in actor.get("actorIds", [actor["actorId"]]), "request_owner_mismatch")
    require(request.get("repository") == {"owner": "benniejoseph", "name": "OmniAgentOS", "defaultBranch": "main"}, "request_repository_mismatch")
    require(request.get("policySha256") in config["allowedPolicySha256"], "policy_not_installed")
    policy = request["policy"]
    sealed("policy", policy, "policySha256")
    require(policy["policySha256"] == request["policySha256"], "policy_binding_changed")
    require(SHA.fullmatch(request.get("candidateRevision", "")) and SHA.fullmatch(request.get("previousRevision", "")) and request["candidateRevision"] != request["previousRevision"], "request_revisions_invalid")
    require(re.fullmatch(r"https://github\.com/benniejoseph/OmniAgentOS/pull/[1-9][0-9]*", request.get("pullRequestUrl", "")), "request_pull_request_invalid")
    candidate, validation = request["candidate"], request["validation"]
    sealed("candidate", candidate, "candidateSha256"); sealed("validation", validation, "validationSha256")
    require(candidate["revision"] == request["candidateRevision"] == validation["candidateRevision"] and candidate["candidateSha256"] == validation["candidateSha256"] and candidate["workspaceSha256"] == validation["workspaceSha256"] and request["validationSha256"] == validation["validationSha256"] and request["policySha256"] == validation["policySha256"], "candidate_evidence_mismatch")
    require(validation["scope"] == {"tenantId": request["tenantId"], "ownerActorId": request["ownerActorId"], "repository": request["repository"], "baseRevision": request["previousRevision"]}, "validation_scope_mismatch")
    kinds = set()
    for check in validation["checks"]:
        require(check["outcome"] == "passed" and check["executedCases"] == check["declaredCases"] > 0 and check["failedCases"] == 0 and check["candidateRevision"] == request["candidateRevision"] and check["workspaceSha256"] == candidate["workspaceSha256"] and 0 <= age(check["completedAt"]) <= config.get("maximumValidationAgeSeconds", 86400), "validation_not_current_and_passing")
        kinds.add(check["kind"])
    require(REQUIRED_CHECKS <= kinds, "focused_validation_missing")
    review_required = candidate["architectureImpact"] == "major" or len(candidate["changedFiles"]) > policy["maxChangedFiles"] or candidate["changedLines"] > policy["maxChangedLines"] or not policy["autoReleaseRoutineChanges"]
    if review_required:
        approval = request.get("approval")
        require(isinstance(approval, dict), "exact_owner_review_required")
        sealed("approval", approval, "receiptSha256")
        require(approval["tenantId"] == request["tenantId"] and approval["ownerActorId"] == request["ownerActorId"] and approval["candidateSha256"] == candidate["candidateSha256"] and approval["policySha256"] == request["policySha256"] and approval["validationSha256"] == request["validationSha256"] and approval["decision"] == "approved", "owner_review_binding_changed")
        require(age(approval["approvedAt"]) >= 0 and age(approval["expiresAt"]) < 0, "owner_review_expired")
    paths = [row["path"] for row in candidate["changedFiles"]]
    require(paths and paths == sorted(set(paths)), "candidate_paths_invalid")
    for item in paths:
        require(not item.startswith("/") and all(part not in ("", ".", "..") for part in item.split("/")) and "\\" not in item and not re.search(r"[\x00-\x1f\x7f]", item), "candidate_path_invalid")
        require((item.lower().startswith(("src/", "public/", "docs/", "tests/", "evals/")) or re.fullmatch(r"(?:readme|product|design|design_review)\.md", item, re.I)) and not PROTECTED.search(item), "protected_change_requires_trusted_manual_release")
    return request

def release_outcome(exit_code, runner, observation, previous, merged):
    require(runner.get("candidateRevision") == merged and runner.get("previousRevision") == previous, "runner_receipt_revision_changed")
    paired = observation.get("webRevision") == observation.get("workerRevision")
    if exit_code == 0 and runner.get("outcome") == "deployed" and runner.get("releaseVerified") is True and paired and observation["webRevision"] == merged:
        return "deployed"
    if exit_code != 0 and runner.get("outcome") in ("failed", "rolled_back") and paired and observation["webRevision"] == previous:
        require(runner["outcome"] != "rolled_back" or runner.get("rollbackVerified") is True, "rollback_not_verified")
        return runner["outcome"]
    raise Refused("release_outcome_requires_reconciliation")

class App:
    def __init__(self): self.cookie = ""; self.actor = None; self.mutex = threading.Lock()
    def request(self, method, route, body=None):
        require(route.startswith("/api/") and "\r" not in route and "\n" not in route, "api_route_invalid")
        headers = {"Origin": ORIGIN, "Accept": "application/json", "Content-Type": "application/json", "Idempotency-Key": digest({"route": route, "body": body})}
        if self.cookie: headers["Cookie"] = self.cookie
        with self.mutex:
            connection = http.client.HTTPSConnection("asael.bennierichard.com", timeout=30)
            try:
                connection.request(method, route, encoded(body) if body is not None else None, headers)
                response = connection.getresponse(); raw = response.read(2_000_001)
                require(response.status == 200 and len(raw) <= 2_000_000, "app_request_refused")
                if route == "/api/auth/login":
                    cookies = SimpleCookie()
                    for key, value in response.getheaders():
                        if key.lower() == "set-cookie": cookies.load(value)
                    names = {"__Host-asael_session", "asael_session", "__Host-omniagent_session", "omniagent_session"}
                    self.cookie = "; ".join(f"{name}={item.value}" for name, item in cookies.items() if name in names)
                return strict_json(raw)
            finally: connection.close()
    def login(self, email, password):
        body = self.request("POST", "/api/auth/login", {"email": email, "password": password})
        context = body.get("context", {})
        require(self.cookie and body.get("authenticated") is True and context.get("source") == "session" and body.get("user", {}).get("email", "").lower() == email.lower() and body.get("tenant", {}).get("id") == context.get("tenantId"), "controller_login_mismatch")
        self.actor = {"tenantId": context["tenantId"], "actorId": context["actorId"]}
        user_id = body["user"].get("id", "")
        require(re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", user_id) and context["actorId"] == body["user"]["email"], "controller_actor_binding_invalid")
        self.actor["actorIds"] = [context["actorId"], "actor:" + user_id]
    def logout(self):
        if self.cookie:
            try: require(self.request("POST", "/api/auth/logout").get("authenticated") is False, "controller_logout_failed")
            finally: self.cookie = ""

class Controller:
    def __init__(self, config, app, credentials):
        self.config, self.app, self.credentials = config, app, credentials
        self.root = Path(config["checkoutDirectory"])
        self.state = Path(config["stateDirectory"])
        self.env = {"PATH": NODE_BIN + ":" + config["executablePath"], "HOME": str(Path.home()), "LANG": "en_US.UTF-8"}
    def command(self, argv, *, env=None, timeout=120, output=False):
        result = subprocess.run(argv, cwd=self.root, env=env or self.env, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        require(result.returncode == 0 and len(result.stdout) <= 4_000_000, "trusted_command_failed")
        return result.stdout.decode().strip() if output else None
    def git(self, *args): return self.command(["git", *args], output=True)
    def deploy(self, argv, env, log):
        secrets = []
        for key, value in env.items():
            if any(word in key for word in ("SECRET", "TOKEN", "PASSWORD", "EMAIL", "DATABASE_URL")) and len(value) > 3:
                secrets.extend((value, urllib.parse.quote(value, safe="")))
        secrets = sorted(set(secrets), key=len, reverse=True)
        descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try: process = subprocess.Popen(argv, cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except BaseException:
            os.close(descriptor); secrets.clear(); raise
        try:
            with os.fdopen(descriptor, "w") as output:
                written = 0
                for raw in process.stdout:
                    line = raw.decode("utf-8", errors="replace")
                    for secret in secrets: line = line.replace(secret, "[redacted]")
                    if written < 8_000_000:
                        output.write(line); output.flush(); written += len(line)
                output.flush(); os.fsync(output.fileno())
            return process.wait()
        finally:
            process.stdout.close()
            secrets.clear()
    def checkout_guard(self, request):
        require(self.git("remote", "get-url", "origin") in (f"https://github.com/{REPOSITORY}.git", f"git@github.com:{REPOSITORY}.git"), "checkout_repository_mismatch")
        require(not self.git("status", "--porcelain", "--untracked-files=all"), "release_checkout_dirty")
        # Fetch only observed revisions; no candidate-supplied ref or command.
        self.git("fetch", "origin", "main", request["candidateRevision"])
        require(self.git("rev-parse", "origin/main") == request["previousRevision"], "main_advanced")
        require(self.git("merge-base", request["previousRevision"], request["candidateRevision"]) == request["previousRevision"], "candidate_base_changed")
        actual = self.git("diff", "--name-only", "--no-renames", request["previousRevision"], request["candidateRevision"]).splitlines()
        require(actual == [row["path"] for row in request["candidate"]["changedFiles"]], "candidate_file_inventory_changed")
        for row in request["candidate"]["changedFiles"]:
            for revision, field in ((request["previousRevision"], "beforeSha256"), (request["candidateRevision"], "afterSha256")):
                if row[field] is None:
                    require(not self.git("ls-tree", revision, "--", row["path"]), "candidate_file_presence_changed")
                else:
                    entry = self.git("ls-tree", revision, "--", row["path"])
                    require(entry.startswith("100644 blob ") or entry.startswith("100755 blob "), "candidate_symlink_refused")
                    result = subprocess.run(["git", "show", f"{revision}:{row['path']}"], cwd=self.root, env=self.env, capture_output=True, timeout=30)
                    require(result.returncode == 0 and digest(result.stdout) == row[field], "candidate_file_bytes_changed")
        # Candidate cannot edit any trusted script/config relative to installation,
        # even when an unrelated intervening deployment changed it.
        drift = self.git("diff", "--name-only", self.config["trustedRevision"], request["candidateRevision"]).splitlines()
        require(not any(PROTECTED.search(item) for item in drift), "installed_controller_baseline_changed")
    def backup_guard(self, request):
        pointer = self.state / "recovery-current.json"
        reference = strict_json(private_read(pointer)) if pointer.exists() else self.config.get("recoveryEvidence")
        if reference:
            evidence = strict_json(private_read(reference["path"]))
            if not 0 <= age(evidence["completedAt"]) <= self.config.get("maximumRecoveryAgeSeconds", 86400): reference = None
        if not reference:
            import recovery
            reference = recovery.refresh(self, request["previousRevision"])
            temporary = pointer.with_name("recovery-" + uuid.uuid4().hex + ".json")
            write_new(temporary, reference); os.replace(temporary, pointer)
        raw = private_read(reference["path"])
        require(digest(raw) == reference["sha256"], "recovery_evidence_changed")
        evidence = strict_json(raw)
        require(0 <= age(evidence["completedAt"]) <= self.config.get("maximumRecoveryAgeSeconds", 86400), "recovery_evidence_expired")
        require(evidence["backup"]["sourceDatabaseIdentity"]["omniDatabaseId"] == self.config["databaseIdentity"] and evidence["recovery"]["restoreSeconds"] <= evidence["recovery"]["objectiveSeconds"], "recovery_evidence_invalid")
        filename = evidence["backup"]["file"]
        require(Path(filename).name == filename, "backup_filename_invalid")
        backup_path = Path(reference["path"]).parent / filename
        with os.fdopen(os.open(backup_path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as backup_file:
            info = os.fstat(backup_file.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077 and info.st_size == evidence["backup"]["bytes"], "backup_file_invalid")
            backup_hash = hashlib.sha256()
            while chunk := backup_file.read(1024 * 1024): backup_hash.update(chunk)
            require(backup_hash.hexdigest() == evidence["backup"]["sha256"], "backup_file_changed")
        schema = strict_json((self.root / "schema-migrations.json").read_bytes())
        expected = [{key: item[key] for key in ("version", "name", "checksum")} for item in schema]
        require(evidence["backup"]["schemaMigrations"] == expected, "recovery_schema_changed")
        return reference["sha256"]
    def merge(self, request):
        number = request["pullRequestUrl"].rsplit("/", 1)[1]
        before = strict_json(self.command(["gh", "api", f"repos/{REPOSITORY}/pulls/{number}"], output=True))
        require(before["state"] == "open" and before["head"]["sha"] == request["candidateRevision"] and before["base"]["sha"] == request["previousRevision"] and before["base"]["ref"] == "main", "pull_request_changed")
        if before["draft"]:
            self.command(["gh", "pr", "ready", request["pullRequestUrl"]])
            before = strict_json(self.command(["gh", "api", f"repos/{REPOSITORY}/pulls/{number}"], output=True))
            require(before["state"] == "open" and not before["draft"] and before["head"]["sha"] == request["candidateRevision"] and before["base"]["sha"] == request["previousRevision"], "pull_request_changed_after_ready")
        self.command(["gh", "pr", "merge", request["pullRequestUrl"], "--squash", "--match-head-commit", request["candidateRevision"]])
        after = strict_json(self.command(["gh", "api", f"repos/{REPOSITORY}/pulls/{number}"], output=True))
        merged = after.get("merge_commit_sha", "")
        require(after.get("merged") is True and SHA.fullmatch(merged), "merge_outcome_unknown")
        self.git("fetch", "origin", "main")
        require(self.git("rev-parse", "origin/main") == merged, "merged_main_advanced")
        tree = self.git("rev-parse", f"{merged}^{{tree}}")
        require(tree == self.git("rev-parse", f"{request['candidateRevision']}^{{tree}}"), "merged_tree_changed")
        require(self.git("rev-parse", f"{merged}^") == request["previousRevision"], "merged_parent_changed")
        self.git("checkout", "main"); self.git("merge", "--ff-only", merged)
        require(self.git("rev-parse", "HEAD") == merged and not self.git("status", "--porcelain"), "merged_checkout_changed")
        return merged, tree
    def observe(self):
        web = self.app.request("GET", "/api/health")
        connection = http.client.HTTPSConnection("omniagent-os-worker.fly.dev", timeout=15)
        try:
            connection.request("GET", "/healthz"); response = connection.getresponse()
            require(response.status == 200, "worker_health_unavailable")
            worker = strict_json(response.read(100_001))
        finally: connection.close()
        require(web.get("status") == "healthy" and worker.get("status") == "healthy" and worker.get("service") == "asael-openai-egress", "paired_health_unhealthy")
        require(SHA.fullmatch(web.get("revision", "")) and SHA.fullmatch(worker.get("revision", "")), "paired_revision_missing")
        require(isinstance(web.get("releaseManifest"), str) and bool(web["releaseManifest"]), "paired_manifest_missing")
        return {"webRevision": web["revision"], "workerRevision": worker["revision"], "manifestSha256": digest(web.get("releaseManifest")), "healthEvidenceSha256": digest({"web": web, "worker": worker})}
    def execute(self, request):
        validate_request(request, self.config, self.app.actor)
        directory = self.state / digest({"cycleId": request["cycleId"], "candidateRevision": request["candidateRevision"]})
        # A prior attempt is inspectable, never automatically replayed.
        require(not directory.exists(), "existing_attempt_requires_reconciliation")
        directory.mkdir(mode=0o700)
        write_new(directory / "request.json", request)
        self.checkout_guard(request)
        backup = self.backup_guard(request)
        observed = self.observe()
        require(observed["webRevision"] == observed["workerRevision"] == request["previousRevision"], "production_advanced")
        claim = self.app.request("POST", API, {"action": "claim", "cycleId": request["cycleId"], "candidateRevision": request["candidateRevision"], "controllerId": self.config["controllerId"]})["claim"]
        require(claim["request"] == request and isinstance(claim["leaseToken"], str), "claim_changed")
        release_budget = claim.get("releaseBudget")
        require(isinstance(release_budget, dict) and isinstance(release_budget.get("phaseId"), str) and isinstance(release_budget.get("reservedUsd"), (int, float)) and .02 <= release_budget["reservedUsd"] <= 10, "release_budget_not_reserved")
        usage_receipt = release_usage(release_budget)
        lease = {"cycleId": request["cycleId"], "leaseToken": claim["leaseToken"], "controllerId": self.config["controllerId"]}
        lease_guard = threading.Lock()
        def leased_action(action, **fields):
            with lease_guard:
                result = self.app.request("POST", API, {"action": action, **lease, **fields})
                next_token = result.get("leaseToken") or result.get("nextToken")
                if next_token:
                    require(isinstance(next_token, str), "lease_response_invalid")
                    lease["leaseToken"] = next_token
                return result
        stop, heartbeat_failed = threading.Event(), threading.Event()
        def heartbeat():
            while not stop.wait(30):
                try: leased_action("heartbeat")
                except Exception: heartbeat_failed.set(); return
        thread = threading.Thread(target=heartbeat, daemon=True); thread.start()
        release_env = {}
        try:
            write_new(directory / "claimed.json", {"claimedAt": now(), "requestSha256": digest(request)})
            merged, tree = self.merge(request)
            write_new(directory / "merged.json", {"sourceCandidateRevision": request["candidateRevision"], "mergedRevision": merged, "tree": tree})
            require(not heartbeat_failed.is_set(), "lease_heartbeat_failed")
            prepared = leased_action("prepare", mergedRevision=merged, sourceTree=tree, mergedTree=tree)
            binding = prepared["releaseBinding"]
            sealed("release_binding", binding, "releaseBindingSha256")
            require(binding["sourceCandidateRevision"] == request["candidateRevision"] and binding["candidateRevision"] == merged and binding["previousRevision"] == request["previousRevision"] and binding["sourceTree"] == binding["mergedTree"] == tree and binding["pullRequestUrl"] == request["pullRequestUrl"], "prepared_binding_changed")
            require(binding["policySha256"] == request["policySha256"] and binding["validationSha256"] == request["validationSha256"] and binding["candidateSha256"] == request["candidate"]["candidateSha256"] and binding["scope"] == request["validation"]["scope"] and binding["runner"] == "asael_paired_production", "prepared_authority_changed")
            release_env = self.credentials.release_environment(self.config, self.env)
            release_env.update(OMNIAGENT_RELEASE_ISOLATED_BUILD="required", OMNIAGENT_RELEASE_SHA=merged, OMNIAGENT_RELEASE_VERIFICATION_BUDGET_MICROUSD=str(round(release_budget["reservedUsd"] * 1_000_000)))
            mode = self.config["verificationMode"]
            if mode == "owner-authorized-live":
                release_env["OMNIAGENT_RELEASE_OWNER_LIVE_AUTHORIZATION"] = json.dumps({"previousRevision": request["previousRevision"], "candidateRevision": merged, "reason": self.config["ownerLiveReason"], "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=3, minutes=50)).isoformat(timespec="milliseconds").replace("+00:00", "Z")})
            self.command(["node", "scripts/deploy-production.mjs", "--configuration-probe", f"--{mode}"], env=release_env)
            self.command(["node", "scripts/deploy-production.mjs", "--provenance-probe", f"--{mode}"], env=release_env)
            require(not heartbeat_failed.is_set(), "lease_heartbeat_failed")
            runner_receipt = Path(tempfile.gettempdir()) / ("asael-release-controller-" + uuid.uuid4().hex + ".json")
            release_env["OMNIAGENT_RELEASE_CONTROLLER_RECEIPT_FILE"] = str(runner_receipt)
            write_new(directory / "deploy-started.json", {"startedAt": now(), "mergedRevision": merged, "recoveryEvidenceSha256": backup, "validationSha256": request["validationSha256"]})
            # The paired runner owns rollback. Never kill/replay it merely because
            # the app session/heartbeat became unavailable during promotion.
            usage_receipt = release_usage(release_budget, started=True)
            result = self.deploy(["npm", "run", "deploy:production", "--", f"--{mode}"], release_env, directory / "release.log")
            observation = self.observe()
            runner = strict_json(private_read(runner_receipt))
            write_new(directory / "runner-receipt.json", runner)
            usage_receipt = release_usage(release_budget, runner.get("verificationUsage"), started=True)
            require(usage_receipt["actualUsd"] is not None, "release_usage_unknown")
            write_new(directory / "release-usage.json", usage_receipt)
            outcome = release_outcome(result, runner, observation, request["previousRevision"], merged)
            evidence_path = Path(release_env["RELEASE_EVIDENCE_OUTPUT"])
            evidence = private_read(evidence_path)
            write_new(directory / "release-evidence.json", strict_json(evidence))
            receipt = {"releaseBindingSha256": binding["releaseBindingSha256"], "outcome": outcome, **observation, "behaviorEvidenceSha256": request["validationSha256"], "evidenceSha256": digest(evidence), "recordedAt": now()}
            write_new(directory / "receipt.json", receipt)
            leased_action("complete", receipt=receipt, releaseUsage=usage_receipt)
            write_new(directory / "delivered.json", {"at": now(), "receiptSha256": digest(receipt)})
            return receipt
        except Exception as error:
            category = str(error) if isinstance(error, Refused) else "controller_step_failed"
            if not (directory / "held.json").exists(): write_new(directory / "held.json", {"category": category, "at": now(), "automaticRetry": False})
            try: leased_action("hold", candidateRevision=request["candidateRevision"], category=category, occurredAt=now(), releaseUsage=usage_receipt)
            except Exception: pass
            raise Refused(category) from None
        finally:
            stop.set(); thread.join(timeout=35); release_env.clear()

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True); parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--check-configuration", action="store_true")
    parser.add_argument("--watch", action="store_true", help="Keep one session in memory while polling the app-owned queue")
    args = parser.parse_args(argv)
    os.umask(0o077); sys.dont_write_bytecode = True
    config = load_config(args.config, args.config_sha256)
    if args.check_configuration:
        print(json.dumps({"configurationValid": True, "credentialsRead": False, "productionContacted": False})); return
    descriptor = os.open(Path(config["stateDirectory"]) / "controller.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a+b") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        if (Path(config["stateDirectory"]) / "PAUSED").exists(): return
        spec = importlib.util.spec_from_file_location("asael_controller_credentials", Path(__file__).with_name("mac_credentials.py"))
        credentials = importlib.util.module_from_spec(spec); spec.loader.exec_module(credentials)
        app = App(); signed_in_at = 0; previous_failure = None; current_request = None
        try:
            while True:
                if (Path(config["stateDirectory"]) / "PAUSED").exists(): return
                try:
                    current_request = None
                    if not app.cookie or time.monotonic() - signed_in_at > 1800:
                        app.logout()
                        password = credentials.login_password(config)
                        try: app.login(config["releaseAuth"]["email"], password)
                        finally: password = None
                        signed_in_at = time.monotonic()
                    app.request("POST", API, {"action": "status", "controllerId": config["controllerId"], "status": "online", "observedAt": now()})
                    requests = app.request("GET", API)["requests"]
                    require(isinstance(requests, list) and len(requests) <= 10, "queue_response_invalid")
                    if requests:
                        current_request = requests[0]
                        Controller(config, app, credentials).execute(current_request)
                    previous_failure = None
                except Exception as error:
                    if not args.watch: raise
                    category = str(error) if isinstance(error, Refused) else "controller_unavailable"
                    if category != previous_failure:
                        print(json.dumps({"status": "held", "category": category, "at": now(), "automaticDeploymentRetry": False}), file=sys.stderr, flush=True)
                    previous_failure = category
                    try:
                        app.request("POST", API, {"action": "status", "controllerId": config["controllerId"], "status": "held", "category": category, "observedAt": now()})
                        if current_request:
                            app.request("POST", API, {"action": "hold", "controllerId": config["controllerId"], "cycleId": current_request["cycleId"], "candidateRevision": current_request["candidateRevision"], "category": category, "occurredAt": now()})
                    except Exception: pass
                    # Retry read-only connectivity/login later, never a consumed
                    # cycle: its immutable local attempt remains a hard stop.
                    try: app.logout()
                    except Exception: app.cookie = ""
                if not args.watch: break
                time.sleep(300 if previous_failure else 60)
        finally: app.logout()

if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(json.dumps({"status": "held", "category": str(error) if isinstance(error, Refused) else "controller_unavailable", "automaticRetry": False}), file=sys.stderr)
        sys.exit(1)
