import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import mac_credentials as M

class ReleaseTemporaryDirectoryTests(unittest.TestCase):
    def exercise(self, folder, *, mac_tmp=True, remove_child_tmp=False, wrong_receipt=False):
        node = shutil.which("node", path=M.runtime_path({"PATH": os.environ.get("PATH", "/usr/bin:/bin")}))
        self.assertIsNotNone(node, "The Python-to-Node release contract requires the local Node runtime.")
        root = Path(folder)
        selected = root / "mac temporary directory"; selected.mkdir()
        key = root / "synthetic-signing-key.pem"
        generated = subprocess.run([node, "--input-type=module", "-e",
            "import {generateKeyPairSync} from 'node:crypto';process.stdout.write(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));"],
            env={"PATH": str(Path(node).parent)}, stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
        self.assertEqual(generated.returncode, 0, generated.stderr.decode())
        key.write_bytes(generated.stdout); key.chmod(0o600)
        (root / "vercel.json").write_text('{"regions":[]}')
        config = {"releaseAuth": {"email": "fixture@example.test", "signingKeyFile": str(key), "gateway": {}, "vercelBypass": {}}}
        base = {"PATH": "/usr/bin:/bin", "HOME": folder, "LANG": "en_US.UTF-8"}
        hosted = {"OMNIAGENT_INTERNAL_AUTH_SECRET": "synthetic-internal-secret", "TMPDIR": "/untrusted-hosted-temp", "NODE_OPTIONS": "untrusted-hosted-options"}
        parent = {"TMPDIR": str(selected)} if mac_tmp else {}
        with patch.dict(os.environ, parent, clear=True), patch.object(tempfile, "tempdir", None), \
                patch.object(M, "hosting_environment", return_value=hosted), \
                patch.object(M, "login_password", return_value="synthetic-password"), \
                patch.object(M, "named_keychain", return_value="synthetic-" + "a" * 32):
            environment = M.release_environment(config, base)
            python_root = tempfile.gettempdir()
            receipt = Path(python_root) / ("asael-release-controller-" + "a" * 32 + ".json")
        self.assertEqual(environment["TMPDIR"], python_root)
        self.assertEqual(Path(environment["RELEASE_EVIDENCE_OUTPUT"]).parent, Path(python_root))
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertEqual(set(base), {"PATH", "HOME", "LANG"})
        self.assertFalse(Path(environment["RELEASE_EVIDENCE_OUTPUT"]).exists())
        environment.update(OMNIAGENT_RELEASE_SHA="a" * 40, OMNIAGENT_RELEASE_VERIFICATION_BUDGET_MICROUSD="1000000")
        if remove_child_tmp:
            # Reproduce the old handoff while keeping the actual runner guard.
            environment.pop("TMPDIR")
        else:
            environment["OMNIAGENT_RELEASE_CONTROLLER_RECEIPT_FILE"] = str(root / receipt.name if wrong_receipt else receipt)
        result = subprocess.run([node, str(Path(__file__).resolve().parents[1] / "deploy-production.mjs"), "--configuration-probe"],
            cwd=root, env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
        self.assertFalse(receipt.exists())
        self.assertFalse(Path(environment["RELEASE_EVIDENCE_OUTPUT"]).exists())
        return result

    def test_mac_python_tempdir_reaches_real_node_evidence_and_receipt_guards(self):
        with tempfile.TemporaryDirectory(dir=Path.home(), prefix=".asael-release-test-") as folder:
            result = self.exercise(folder)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b"Production release configuration is valid.", result.stdout)

    def test_absent_parent_tempdir_uses_same_default_in_both_runtimes(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.exercise(folder, mac_tmp=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_original_missing_child_tempdir_still_refuses_evidence_path(self):
        with tempfile.TemporaryDirectory(dir=Path.home(), prefix=".asael-release-test-") as folder:
            result = self.exercise(folder, remove_child_tmp=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"RELEASE_EVIDENCE_OUTPUT must be a unique", result.stderr)

    def test_unrelated_controller_receipt_directory_remains_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.exercise(folder, wrong_receipt=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Controller receipt requires a new fixed-name file", result.stderr)

class CandidateCredentialTests(unittest.TestCase):
    def test_only_local_database_and_provider_credentials_are_admitted(self):
        with tempfile.TemporaryDirectory() as folder:
            auth = Path(folder) / "auth.json"; auth.write_text(json.dumps({"token":"synthetic-sandbox-token"})); auth.chmod(0o600)
            config={"releaseAuth":{"vercelAuthFile":str(auth),"gateway":{"service":"fixture","account":"fixture"}}}
            values={"OPENAI_API_KEY":"synthetic-provider-key","OPENAI_MODEL_PRICING_JSON":"{}","OMNIAGENT_GITHUB_APP_PRIVATE_KEY":"synthetic-github-key",
                "DATABASE_URL":"postgres://production-secret","OMNIAGENT_INTERNAL_AUTH_SECRET":"do-not-copy","OMNIAGENT_RELEASE_SIGNING_KEY_FILE":"do-not-copy"}
            with patch.object(M,"hosting_environment",return_value=values),patch.object(M,"named_keychain",return_value="synthetic-gateway-token"):
                result=M.candidate_environment(config,{"PATH":"/usr/bin:/bin","HOME":folder,"NODE_OPTIONS":"malicious-injection"},"postgres://local:fixture@127.0.0.1:55439/asael_self_improvement_candidate")
            self.assertEqual(result["OMNIAGENT_SANDBOX_ACCESS_TOKEN"],"synthetic-sandbox-token")
            self.assertIn("127.0.0.1:55439",result["DATABASE_URL"])
            self.assertNotIn("OMNIAGENT_INTERNAL_AUTH_SECRET",result);self.assertNotIn("NODE_OPTIONS",result);self.assertNotIn("OMNIAGENT_RELEASE_SIGNING_KEY_FILE",result)
            self.assertTrue(result["PATH"].startswith(M.NODE_BIN+":"))
    def test_foreign_database_refused_before_credential_read(self):
        with patch.object(M,"hosting_environment") as hosted:
            for url in ["postgres://localhost:55439/asael_self_improvement_candidate","postgres://127.0.0.1:5432/postgres","postgres://production.example/postgres"]:
                with self.assertRaisesRegex(RuntimeError,"isolation"): M.candidate_environment({}, {},url)
            hosted.assert_not_called()
    def test_origin_userinfo_rejected_before_credential_read(self):
        with patch.object(M,"hosting_environment") as hosted:
            with self.assertRaisesRegex(RuntimeError,"isolation"):
                M.candidate_environment({}, {}, "postgres://local:fixture@127.0.0.1:55439/asael_self_improvement_candidate", "http://user:password@127.0.0.1:3100")
            hosted.assert_not_called()
    def test_recovery_ca_pin_and_verified_transport_survive_runtime_url_omission(self):
        with tempfile.TemporaryDirectory() as folder:
            ca=Path(folder)/"ca.crt";ca.write_text("fixture certificate bytes");ca.chmod(0o600)
            key=Path(folder)/"key";key.write_text("fixture backup key");key.chmod(0o600)
            config={"recovery":{"sourceCa":{"path":str(ca),"sha256":hashlib.sha256(ca.read_bytes()).hexdigest()},"encryptionKey":{"path":str(key)}}}
            with patch.object(M,"hosting_environment",return_value={"DATABASE_URL":"","OMNIAGENT_BACKUP_DATABASE_URL":"postgres://backup:fixture@db.example/postgres?sslmode=require"}):
                result=M.recovery_environment(config,{})
            self.assertIn("sslmode=verify-full",result["DATABASE_URL"])
            self.assertEqual(result["DATABASE_URL"],result["OMNIAGENT_BACKUP_DATABASE_URL"])
            self.assertEqual(result["NODE_EXTRA_CA_CERTS"],str(ca))
            config["recovery"]["sourceCa"]["sha256"]="0"*64
            with patch.object(M,"hosting_environment",return_value={}):
                with self.assertRaisesRegex(RuntimeError,"source_ca_changed"): M.recovery_environment(config,{})
