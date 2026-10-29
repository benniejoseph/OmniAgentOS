import copy
import os
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import controller as C

PREVIOUS, SOURCE, MERGED = "a" * 40, "b" * 40, "c" * 40

def seal(kind, value, field):
    return dict(value, **{field: C.digest({"contract": "asael-self-improvement", "version": 1, "kind": kind, "value": value})})

def fixture(path="src/components/example.tsx", notify_outcomes=False):
    policy = seal("policy", {"maxChangedFiles":12,"maxChangedLines":1200,"autoReleaseRoutineChanges":True,"notifyOutcomes":notify_outcomes}, "policySha256")
    config = {"allowedPolicySha256": [policy["policySha256"]]}
    actor = {"tenantId": "tenant", "actorId": "actor"}
    repository = {"owner": "benniejoseph", "name": "OmniAgentOS", "defaultBranch": "main"}
    candidate = seal("candidate", {"revision": SOURCE, "workspaceSha256": "b" * 64, "diffSha256": "c" * 64, "changedFiles": [{"path": path, "beforeSha256": "d" * 64, "afterSha256": "e" * 64}], "changedLines": 3, "architectureImpact": "minor"}, "candidateSha256")
    checks = [{"id": kind, "kind": kind, "outcome": "passed", "executedCases": 1, "declaredCases": 1, "failedCases": 0, "candidateRevision": SOURCE, "workspaceSha256": candidate["workspaceSha256"], "completedAt": C.now()} for kind in sorted(C.REQUIRED_CHECKS)]
    validation = seal("validation", {"scope": {"tenantId": "tenant", "ownerActorId": "actor", "repository": repository, "baseRevision": PREVIOUS}, "candidateRevision": SOURCE, "candidateSha256": candidate["candidateSha256"], "workspaceSha256": candidate["workspaceSha256"], "policySha256": policy["policySha256"], "checks": checks}, "validationSha256")
    request = {"cycleId": "cycle-one", "policyId": "policy-one", "tenantId": "tenant", "ownerActorId": "actor", "repository": repository, "policy":policy, "policySha256": policy["policySha256"], "previousRevision": PREVIOUS, "candidateRevision": SOURCE, "pullRequestUrl": "https://github.com/benniejoseph/OmniAgentOS/pull/123", "candidate": candidate, "validation": validation, "validationSha256": validation["validationSha256"]}
    return request, config, actor

class RequestTests(unittest.TestCase):
    def test_exact_passing_candidate(self):
        request, config, actor = fixture()
        self.assertEqual(C.validate_request(request, config, actor), request)
    def test_installed_policy_preserves_explicit_notification_choice(self):
        for enabled in (False, True):
            request, config, actor = fixture(notify_outcomes=enabled)
            self.assertIs(C.validate_request(request, config, actor)["policy"]["notifyOutcomes"], enabled)
            request["policy"]["notifyOutcomes"] = not enabled
            with self.assertRaisesRegex(C.Refused, "sealed_record_changed"): C.validate_request(request, config, actor)
    def test_missing_or_non_boolean_notification_policy_is_rejected(self):
        for value in (None, "false", 0):
            request, config, actor = fixture(notify_outcomes=value)
            with self.assertRaisesRegex(C.Refused, "policy_notification_preference_invalid"): C.validate_request(request, config, actor)
        request, config, actor = fixture()
        body = {key:value for key,value in request["policy"].items() if key not in ("policySha256", "notifyOutcomes")}
        request["policy"] = seal("policy", body, "policySha256")
        request["policySha256"] = request["policy"]["policySha256"]
        config["allowedPolicySha256"] = [request["policySha256"]]
        with self.assertRaisesRegex(C.Refused, "policy_notification_preference_invalid"): C.validate_request(request, config, actor)
    def test_foreign_owner(self):
        request, config, actor = fixture(); actor["actorId"] = "other"
        with self.assertRaisesRegex(C.Refused, "owner"): C.validate_request(request, config, actor)
    def test_forged_check_is_not_authority(self):
        request, config, actor = fixture(); request["validation"]["checks"][0]["outcome"] = "failed"
        with self.assertRaisesRegex(C.Refused, "sealed_record_changed"): C.validate_request(request, config, actor)
    def test_resealed_incomplete_case_rejected(self):
        request, config, actor = fixture()
        body = {k:v for k,v in request["validation"].items() if k != "validationSha256"}
        body["checks"][0]["executedCases"] = 0
        request["validation"] = seal("validation", body, "validationSha256"); request["validationSha256"] = request["validation"]["validationSha256"]
        with self.assertRaisesRegex(C.Refused, "validation_not_current"): C.validate_request(request, config, actor)
    def test_protected_installed_control_plane_cannot_self_update(self):
        for path in ("scripts/deploy-production.mjs", "src/lib/self-improvement/policy.ts", "src/lib/auth/session.ts", "src/app/api/release/evidence/route.ts", "docs/deployment.md", "src/.env.local", "src/lib/models/selector.ts", "src/app/api/projects/[id]/builder/route.ts", "src/proxy.ts"):
            with self.subTest(path=path):
                request, config, actor = fixture(path)
                with self.assertRaises(C.Refused): C.validate_request(request, config, actor)
    def test_exact_owner_review_authorizes_major_business_change_only(self):
        request, config, actor = fixture()
        candidate={k:v for k,v in request["candidate"].items() if k!="candidateSha256"}
        candidate.update(architectureImpact="major",changedLines=1500)
        request["candidate"]=seal("candidate",candidate,"candidateSha256")
        validation={k:v for k,v in request["validation"].items() if k!="validationSha256"}
        validation["candidateSha256"]=request["candidate"]["candidateSha256"]
        request["validation"]=seal("validation",validation,"validationSha256");request["validationSha256"]=request["validation"]["validationSha256"]
        with self.assertRaisesRegex(C.Refused,"exact_owner_review_required"):C.validate_request(request,config,actor)
        request["approval"]=seal("approval",{"approvalId":"approved-fixture","tenantId":"tenant","ownerActorId":"actor","candidateSha256":request["candidate"]["candidateSha256"],"policySha256":request["policySha256"],"validationSha256":request["validationSha256"],"decision":"approved","approvedAt":C.now(),"expiresAt":(C.datetime.now(C.timezone.utc)+C.timedelta(hours=1)).isoformat()},"receiptSha256")
        self.assertEqual(C.validate_request(request,config,actor),request)
        request["approval"]["ownerActorId"]="another-actor"
        with self.assertRaisesRegex(C.Refused,"sealed_record_changed"):C.validate_request(request,config,actor)
    def test_uninstalled_policy_rejected(self):
        request, config, actor = fixture(); config["allowedPolicySha256"] = []
        with self.assertRaisesRegex(C.Refused, "policy_not_installed"): C.validate_request(request, config, actor)
    def test_old_validation_held(self):
        request, config, actor = fixture()
        with patch.object(C, "age", return_value=90_000):
            with self.assertRaisesRegex(C.Refused, "validation_not_current"): C.validate_request(request, config, actor)
    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(C.Refused): C.strict_json(b'{"action":"read","action":"deploy"}')

class OutcomeTests(unittest.TestCase):
    def receipt(self, outcome, **extra): return {"candidateRevision": MERGED, "previousRevision": PREVIOUS, "outcome": outcome, **extra}
    def paired(self, revision): return {"webRevision": revision, "workerRevision": revision}
    def test_success_requires_runner_and_both_live_revisions(self):
        self.assertEqual(C.release_outcome(0, self.receipt("deployed", releaseVerified=True), self.paired(MERGED), PREVIOUS, MERGED), "deployed")
        with self.assertRaises(C.Refused): C.release_outcome(0, self.receipt("deployed", releaseVerified=True), {"webRevision": MERGED, "workerRevision": PREVIOUS}, PREVIOUS, MERGED)
    def test_rollback_is_not_inferred_from_nonzero_exit(self):
        with self.assertRaises(C.Refused): C.release_outcome(1, self.receipt("rolled_back", rollbackVerified=False), self.paired(PREVIOUS), PREVIOUS, MERGED)
        self.assertEqual(C.release_outcome(1, self.receipt("rolled_back", rollbackVerified=True), self.paired(PREVIOUS), PREVIOUS, MERGED), "rolled_back")
    def test_no_mutation_failure_is_distinct_from_rollback(self):
        self.assertEqual(C.release_outcome(1, self.receipt("failed"), self.paired(PREVIOUS), PREVIOUS, MERGED), "failed")
    def test_uncertain_outcome_stays_held(self):
        with self.assertRaises(C.Refused): C.release_outcome(1, self.receipt("uncertain"), self.paired(PREVIOUS), PREVIOUS, MERGED)

class FilesystemTests(unittest.TestCase):
    def test_no_symlink_or_public_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "receipt.json"; path.write_text("{}"); path.chmod(0o600)
            self.assertEqual(C.private_read(path), b"{}")
            link = Path(folder) / "link.json"; link.symlink_to(path)
            with self.assertRaises(C.Refused): C.private_read(link)
            path.chmod(0o644)
            with self.assertRaises(C.Refused): C.private_read(path)
    def test_private_immutable_attempt_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "receipt.json"; C.write_new(path, {"stage": "claimed"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): C.write_new(path, {"stage": "replayed"})

class ExecutionTests(unittest.TestCase):
    def test_probe_error_is_closed_and_does_not_persist_raw_output(self):
        cases = [
            (SimpleNamespace(returncode=1, stdout=b"synthetic-secret", stderr=b"RELEASE_EVIDENCE_OUTPUT must be a unique asael-release-evidence-*.json file inside the system temporary directory. synthetic-secret"), "failed", "evidence_directory_mismatch"),
            (SimpleNamespace(returncode=1, stdout=b"synthetic-secret", stderr=b"other synthetic-secret"), "failed", "nonzero_exit"),
            (SimpleNamespace(returncode=137, stdout=b"", stderr=b""), "incomplete", "terminated"),
            (SimpleNamespace(returncode=0, stdout=b"x" * 4_000_001, stderr=b""), "incomplete", "output_limit"),
            (C.subprocess.TimeoutExpired(["node"], 120, output=b"synthetic-secret"), "incomplete", "timeout"),
            (OSError("synthetic-secret"), "incomplete", "launch_failed"),
        ]
        for result, status, reason in cases:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as folder:
                controller = C.Controller({"checkoutDirectory": folder, "stateDirectory": folder, "executablePath": "/usr/bin:/bin", "verificationMode": "owner-authorized-live"}, None, None)
                with patch.object(C.subprocess, "run", **({"side_effect": result} if isinstance(result, Exception) else {"return_value": result})):
                    with self.assertRaisesRegex(C.ProbeFailure, "release_configuration_probe_" + reason):
                        controller.probe("configuration", {}, Path(folder))
                raw = C.private_read(Path(folder) / "probe-configuration.json")
                self.assertNotIn(b"synthetic-secret", raw)
                self.assertEqual(C.strict_json(raw)["status"], status)
                self.assertEqual(C.strict_json(raw)["reason"], reason)

    def test_deployment_log_redacts_credential_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            controller = C.Controller({"checkoutDirectory": folder, "stateDirectory": folder, "executablePath": "/usr/bin:/bin"}, None, None)
            target = Path(folder) / "release.log"
            code = controller.deploy([sys.executable, "-c", "import os; print('status fixture'); print(os.environ['SMOKE_PAID_AGENT_PASSWORD'])"], {"PATH": "/usr/bin:/bin", "SMOKE_PAID_AGENT_PASSWORD": "synthetic-secret-value"}, target)
            self.assertEqual(code, 0)
            self.assertEqual(target.read_text(), "status fixture\n[redacted]\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
    def exercise(self, callback_fails=False):
        request, config, actor = fixture()
        with tempfile.TemporaryDirectory() as folder:
            evidence = Path(folder) / "evidence.json"; C.write_new(evidence, {"releaseGate": {"status": "passed"}})
            config.update(checkoutDirectory=folder, stateDirectory=folder, executablePath="/usr/bin:/bin", controllerId="fixture", verificationMode="owner-authorized-live", ownerLiveReason="Authorized fixture")
            binding = seal("release_binding", {"sourceCandidateRevision": SOURCE, "candidateRevision": MERGED, "previousRevision": PREVIOUS, "sourceTree": "d" * 40, "mergedTree": "d" * 40, "pullRequestUrl": request["pullRequestUrl"], "policySha256": request["policySha256"], "validationSha256": request["validationSha256"], "candidateSha256": request["candidate"]["candidateSha256"], "scope": request["validation"]["scope"], "runner": "asael_paired_production"}, "releaseBindingSha256")
            actions, deployments, temporary_receipts = [], [], []
            def api(method, route, body):
                actions.append(body["action"])
                if body["action"] == "claim": return {"claim": {"request": request, "leaseToken": "fixture-token", "releaseBudget": {"phaseId": "release:fixture", "reservedUsd": 1}}}
                if body["action"] == "prepare": return {"releaseBinding": binding}
                if body["action"] == "complete" and callback_fails: raise OSError("synthetic offline callback")
                return {}
            app = SimpleNamespace(actor=actor, request=api)
            credentials = SimpleNamespace(release_environment=lambda *_: {"RELEASE_EVIDENCE_OUTPUT": str(evidence)})
            controller = C.Controller(config, app, credentials)
            observations = [{"webRevision": revision, "workerRevision": revision, "manifestSha256": "a" * 64, "healthEvidenceSha256": "b" * 64} for revision in (PREVIOUS, MERGED)]
            def deploy(argv, env, log):
                deployments.append(argv)
                target = Path(env["OMNIAGENT_RELEASE_CONTROLLER_RECEIPT_FILE"]); temporary_receipts.append(target)
                C.write_new(target, {"candidateRevision": MERGED, "previousRevision": PREVIOUS, "outcome": "deployed", "releaseVerified": True, "verificationUsage": {"reservedMicrousd": 1_000_000, "actualMicrousd": 10_000, "phases": [{"actualMicrousd": 10_000, "limitMicrousd": 500_000}]}})
                return 0
            try:
                with patch.object(controller, "checkout_guard"), patch.object(controller, "backup_guard", return_value="c" * 64), patch.object(controller, "merge", return_value=(MERGED, "d" * 40)), patch.object(controller, "observe", side_effect=observations), patch.object(controller, "probe"), patch.object(controller, "deploy", side_effect=deploy):
                    if callback_fails:
                        with self.assertRaises(C.Refused): controller.execute(request)
                    else: self.assertEqual(controller.execute(request)["outcome"], "deployed")
                    with self.assertRaisesRegex(C.Refused, "existing_attempt_requires_reconciliation"): controller.execute(request)
                self.assertEqual(len(deployments), 1)
                self.assertEqual(actions, ["claim", "prepare", "complete"] + (["hold"] if callback_fails else []))
                attempt = next(path for path in Path(folder).iterdir() if path.is_dir())
                self.assertTrue((attempt / "receipt.json").exists())
                self.assertEqual((attempt / "delivered.json").exists(), not callback_fails)
            finally:
                for target in temporary_receipts: target.unlink(missing_ok=True)
    def test_candidate_claim_merge_deploy_receipt_and_dedupe(self): self.exercise()
    def test_callback_failure_preserves_result_without_redeploy(self): self.exercise(callback_fails=True)

class PreDeployFailureTests(unittest.TestCase):
    def exercise(self, condition="confirmed", stage="configuration"):
        request, config, actor = fixture()
        with tempfile.TemporaryDirectory() as folder:
            config.update(checkoutDirectory=folder, stateDirectory=folder, executablePath="/usr/bin:/bin", controllerId="fixture", verificationMode="owner-authorized-live", ownerLiveReason="Authorized synthetic fixture")
            binding = seal("release_binding", {"sourceCandidateRevision": SOURCE, "candidateRevision": MERGED, "previousRevision": PREVIOUS, "sourceTree": "d" * 40, "mergedTree": "d" * 40, "pullRequestUrl": request["pullRequestUrl"], "policySha256": request["policySha256"], "validationSha256": request["validationSha256"], "candidateSha256": request["candidate"]["candidateSha256"], "scope": request["validation"]["scope"], "runner": "asael_paired_production"}, "releaseBindingSha256")
            budget = {"phaseId": "release:fixture", "reservedUsd": 1}
            actions, commands = [], []
            directory = Path(folder) / C.digest({"cycleId": request["cycleId"], "candidateRevision": request["candidateRevision"]})
            def api(method, route, body):
                actions.append(body)
                if body["action"] == "claim": return {"claim": {"request": request, "leaseToken": "initial-fixture-token", "releaseBudget": budget}}
                if body["action"] == "prepare":
                    if condition == "missing_binding": raise OSError("synthetic prepare transport failure")
                    return {"releaseBinding": binding}
                if body["action"] == "heartbeat":
                    if condition == "expired_lease": raise C.Refused("app_request_refused")
                    return {"leaseToken": "renewed-fixture-token", "expiresAt": (C.datetime.now(C.timezone.utc) + C.timedelta(minutes=-1 if condition == "expired_response" else 5)).isoformat()}
                if body["action"] == "complete":
                    self.assertEqual(body["leaseToken"], "renewed-fixture-token")
                    if condition == "callback_failure": raise OSError("synthetic uncertain response")
                    return {"cycleId": request["cycleId"], "stage": "succeeded" if condition == "wrong_confirmation" else "failed", "receipt": {**body["receipt"], "serverHealthEvidenceSha256": "f" * 64}}
                return {}
            def command(argv, **_):
                commands.append(argv)
                if "--" + stage + "-probe" not in argv: return SimpleNamespace(returncode=0, stdout=b"configuration passed", stderr=b"")
                if condition == "started": C.write_new(directory / "deploy-started.json", {"at": C.now()})
                if condition == "timeout": raise C.subprocess.TimeoutExpired(argv, 120)
                return SimpleNamespace(returncode=1, stdout=b"", stderr=b"synthetic fixed probe refusal")
            paired = {"webRevision": PREVIOUS, "workerRevision": PREVIOUS, "manifestSha256": "a" * 64, "healthEvidenceSha256": "b" * 64}
            after = dict(paired)
            if condition == "health_mismatch": after["workerRevision"] = MERGED
            if condition == "manifest_mismatch": after["manifestSha256"] = "c" * 64
            app = SimpleNamespace(actor=actor, request=api)
            controller = C.Controller(config, app, SimpleNamespace(release_environment=lambda *_: {"RELEASE_EVIDENCE_OUTPUT": str(Path(folder) / "unused.json")}))
            with patch.object(controller, "checkout_guard"), patch.object(controller, "backup_guard", return_value="e" * 64), \
                    patch.object(controller, "merge", return_value=(MERGED, "d" * 40)), patch.object(controller, "observe", side_effect=[paired, after]), \
                    patch.object(controller, "deploy") as deploy, patch.object(C.subprocess, "run", side_effect=command):
                if condition == "confirmed":
                    receipt = controller.execute(request)
                    self.assertEqual(receipt["outcome"], "failed")
                    self.assertEqual(receipt["evidenceSha256"], C.digest(C.private_read(directory / "pre-deploy-failure.json")))
                    self.assertEqual(C.strict_json(C.private_read(directory / "release-usage.json")), C.release_usage(budget))
                    self.assertEqual(C.strict_json(C.private_read(directory / "release-binding.json")), binding)
                    self.assertEqual(C.strict_json(C.private_read(directory / "delivered.json"))["outcome"], "failed")
                    self.assertEqual([body["action"] for body in actions], ["claim", "prepare", "heartbeat", "complete"])
                else:
                    with self.assertRaises(C.Refused): controller.execute(request)
                    self.assertFalse((directory / "delivered.json").exists())
                    self.assertEqual(actions[-1]["action"], "hold")
                    self.assertEqual(sum(body["action"] == "complete" for body in actions), int(condition in ("callback_failure", "wrong_confirmation")))
                deploy.assert_not_called()
                before = len(actions)
                with self.assertRaisesRegex(C.Refused, "existing_attempt_requires_reconciliation"): controller.execute(request)
                self.assertEqual(len(actions), before)
            self.assertTrue((directory / "held.json").exists())
            self.assertFalse((directory / "runner-receipt.json").exists())
            self.assertFalse((directory / "release.log").exists())
            if condition != "started": self.assertFalse((directory / "deploy-started.json").exists())
            if condition != "missing_binding":
                self.assertEqual(len(commands), 2 if stage == "provenance" else 1)

    def test_failed_configuration_closes_only_confirmed_zero_use_release(self): self.exercise()
    def test_failed_provenance_closes_only_confirmed_zero_use_release(self): self.exercise(stage="provenance")
    def test_missing_prepared_binding_stays_held(self): self.exercise("missing_binding")
    def test_expired_lease_stays_held(self): self.exercise("expired_lease")
    def test_expired_renewal_response_stays_held(self): self.exercise("expired_response")
    def test_prior_pair_mismatch_stays_held(self): self.exercise("health_mismatch")
    def test_prior_manifest_mismatch_stays_held(self): self.exercise("manifest_mismatch")
    def test_started_deployment_stays_held(self): self.exercise("started")
    def test_incomplete_probe_stays_held(self): self.exercise("timeout")
    def test_ambiguous_completion_callback_stays_held(self): self.exercise("callback_failure")
    def test_wrong_completion_response_stays_held(self): self.exercise("wrong_confirmation")

if __name__ == "__main__": unittest.main()
