"""Trusted local credential access. Never imported into an application sandbox."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import uuid

NODE_BIN = "/opt/homebrew/opt/node@24/bin"

def runtime_path(base):
    return NODE_BIN + ":" + base.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin")

def private_bytes(path, limit=1_000_000):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise RuntimeError("credential_reference_invalid")
        return stream.read(limit + 1)

def login_password(config):
    reference = config["releaseAuth"]["loginHelper"]
    path = Path(reference["path"])
    raw = private_bytes(path, 100_000)
    if hashlib.sha256(raw).hexdigest() != reference["sha256"]: raise RuntimeError("saved_login_helper_changed")
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader("asael_saved_release_login", loader=None))
    exec(compile(raw, str(path), "exec"), module.__dict__)
    return module.read_password(config["releaseAuth"]["email"].lower())

def named_keychain(reference):
    result = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", reference["account"], "-s", reference["service"], "-w"], stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    value = result.stdout.decode().strip()
    if result.returncode or not 1 <= len(value) <= 16_384: raise RuntimeError("saved_credential_unavailable")
    return value

def hosting_environment(config, base):
    # Only the installed CLI renews its session. No package download, provider
    # creation or interactive login is attempted by this controller.
    refreshed = subprocess.run([config["releaseAuth"]["vercelExecutable"], "whoami"], env=dict(base, PATH=runtime_path(base)), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    if refreshed.returncode: raise RuntimeError("hosting_session_unavailable")
    auth = json.loads(private_bytes(config["releaseAuth"]["vercelAuthFile"]))
    connection = http.client.HTTPSConnection("api.vercel.com", timeout=30)
    try:
        connection.request("GET", "/v3/env/pull/prj_BF3Uy9PhUUitqFAeA0g0LafaL4co/production?teamId=team_hFIwf5wwfzIn2I1WDZwY8pAv", headers={"Authorization": "Bearer " + auth["token"]})
        response = connection.getresponse(); raw = response.read(1_000_001)
        if response.status != 200 or len(raw) > 1_000_000: raise RuntimeError("hosting_environment_unavailable")
        values = json.loads(raw)["env"]
        if values.get("OMNIAGENT_OWNER_EMAIL", "").lower() != config["releaseAuth"]["email"].lower(): raise RuntimeError("hosting_owner_changed")
        return values
    finally: connection.close(); auth.clear()

def release_environment(config, base):
    values, output = {}, {}
    try:
        values = hosting_environment(config, base)
        private_bytes(config["releaseAuth"]["signingKeyFile"], 32_000)
        output = dict(base, PATH=runtime_path(base))
        output.update({
            "BASE_URL": "https://asael.bennierichard.com",
            "SMOKE_PAID_AGENT_EMAIL": config["releaseAuth"]["email"],
            "SMOKE_PAID_AGENT_PASSWORD": login_password(config),
            "SMOKE_INTERNAL_AUTH_SECRET": values["OMNIAGENT_INTERNAL_AUTH_SECRET"],
            "LIVE_VERIFY_PAID_OPENAI": "CONFIRMED",
            "OMNIAGENT_RELEASE_SIGNING_KEY_FILE": config["releaseAuth"]["signingKeyFile"],
            "RELEASE_EVIDENCE_OUTPUT": str(Path(tempfile.gettempdir()) / ("asael-release-evidence-" + uuid.uuid4().hex + ".json")),
            "OMNIAGENT_OPENAI_GATEWAY_URL": "https://omniagent-os-worker.fly.dev/v1",
            "OMNIAGENT_OPENAI_GATEWAY_TOKEN": named_keychain(config["releaseAuth"]["gateway"]),
            "VERCEL_AUTOMATION_BYPASS_SECRET": named_keychain(config["releaseAuth"]["vercelBypass"]),
        })
        return output
    except BaseException:
        output.clear(); raise
    finally: values.clear()

def recovery_environment(config, base):
    values = hosting_environment(config, base)
    try:
        reference = config["recovery"]["encryptionKey"]
        key = named_keychain(reference) if reference.get("service") else private_bytes(reference["path"], 4096).decode().strip()
        result = dict(base, PATH=runtime_path(base))
        ca = config["recovery"]["sourceCa"]
        if hashlib.sha256(private_bytes(ca["path"], 32_000)).hexdigest() != ca["sha256"]: raise RuntimeError("source_ca_changed")
        from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
        def verified_url(value):
            parts = urlsplit(value)
            if parts.scheme not in ("postgres", "postgresql") or not parts.hostname or not parts.username: raise RuntimeError("backup_connection_invalid")
            query = dict(parse_qsl(parts.query, strict_parsing=True)); query["sslmode"] = "verify-full"
            return urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(query),""))
        result.update(NODE_ENV="production", DATABASE_URL=verified_url(values.get("DATABASE_URL") or values["OMNIAGENT_BACKUP_DATABASE_URL"]), OMNIAGENT_BACKUP_DATABASE_URL=verified_url(values["OMNIAGENT_BACKUP_DATABASE_URL"]), OMNIAGENT_BACKUP_ENCRYPTION_KEY=key,
            NODE_EXTRA_CA_CERTS=ca["path"], PGSSLROOTCERT=ca["path"] )
        return result
    finally: values.clear()

def candidate_environment(config, base, database_url, origin="http://127.0.0.1:3100"):
    """Read existing provider/GitHub/Sandbox credentials only into a local test process.

    Never copies production storage, owner login, release signing or internal auth.
    Caller owns the synthetic fixture and must keep its subprocess output private.
    """
    from urllib.parse import urlparse
    database, site = urlparse(database_url), urlparse(origin)
    if (database.scheme not in ("postgres", "postgresql") or database.hostname != "127.0.0.1" or
        database.port != 55439 or database.path != "/asael_self_improvement_candidate" or
        site.scheme != "http" or site.hostname != "127.0.0.1" or not site.port or site.username or site.password or site.path not in ("", "/") or site.query or site.fragment):
        raise RuntimeError("candidate_isolation_required")
    values, auth = {}, {}
    try:
        values = hosting_environment(config, base)
        allowed = {"OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_FAST_MODEL", "OPENAI_REASONING_MODEL", "OPENAI_MODEL_PRICING_JSON",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_MODEL", "GEMINI_FAST_MODEL", "GEMINI_REASONING_MODEL", "GEMINI_MODEL_PRICING_JSON",
            "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_FAST_MODEL", "ANTHROPIC_REASONING_MODEL", "ANTHROPIC_MODEL_PRICING_JSON",
            "OMNIAGENT_MODEL_PROVIDER_ORDER", "OMNIAGENT_GITHUB_APP_ID", "OMNIAGENT_GITHUB_APP_PRIVATE_KEY",
            "OMNIAGENT_GITHUB_APP_INSTALLATION_ID", "OMNIAGENT_GITHUB_APP_REPOSITORY_IDS", "OMNIAGENT_GITHUB_APP_SLUG"}
        output = {name: value for name,value in values.items() if name in allowed and isinstance(value,str)}
        output.update({name:base[name] for name in ("HOME","PATH","TMPDIR","LANG") if name in base})
        output["PATH"] = runtime_path(base)
        auth = json.loads(private_bytes(config["releaseAuth"]["vercelAuthFile"]))
        output.update(NODE_ENV="test", VERCEL="", VERCEL_ENV="", NEXT_PUBLIC_APP_URL=origin, DATABASE_URL=database_url,
            OMNIAGENT_SANDBOX_ACCESS_TOKEN=auth["token"], OMNIAGENT_SANDBOX_TEAM_ID="team_hFIwf5wwfzIn2I1WDZwY8pAv",
            OMNIAGENT_SANDBOX_PROJECT_ID="prj_BF3Uy9PhUUitqFAeA0g0LafaL4co",
            OMNIAGENT_OPENAI_GATEWAY_URL="https://omniagent-os-worker.fly.dev/v1",
            OMNIAGENT_OPENAI_GATEWAY_TOKEN=named_keychain(config["releaseAuth"]["gateway"]))
        return output
    finally:
        values.clear(); auth.clear()
