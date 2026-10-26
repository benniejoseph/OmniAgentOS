import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import mac_credentials as M

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
