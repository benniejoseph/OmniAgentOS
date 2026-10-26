"""Encrypted backup and disposable loopback restore using the paired repo tools."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import urllib.parse

def refresh(controller, previous_revision):
    config = controller.config["recovery"]
    parent = Path(controller.config["stateDirectory"]) / "recovery"
    parent.mkdir(mode=0o700, exist_ok=True)
    if shutil.disk_usage(parent).free < config.get("minimumFreeBytes", 4 * 1024**3): raise RuntimeError("recovery_disk_space_low")
    folder = Path(tempfile.mkdtemp(prefix="attempt-", dir=parent))
    cluster, data = folder / "cluster", folder / "cluster/data"
    cluster.mkdir(mode=0o700)
    bin_dir = Path(config["postgresBin"])
    pg_env = dict(controller.env, PATH=str(bin_dir) + ":" + controller.env["PATH"])
    backup_env = {}
    started = False
    marker = {"purpose": "self-improvement-disposable-restore", "directory": str(data), "nonce": secrets.token_hex(16)}
    (cluster / "marker.json").write_text(json.dumps(marker)); (cluster / "marker.json").chmod(0o600)
    def run(argv, env=pg_env, timeout=180):
        controller.command(argv, env=env, timeout=timeout)
    try:
        backup_env = controller.credentials.recovery_environment(controller.config, controller.env)
        backup = folder / "database.dump.enc"
        backup_env.update(PATH=pg_env["PATH"], OMNIAGENT_BACKUP_OUTPUT=str(backup), OMNIAGENT_RELEASE_SHA=previous_revision)
        run(["node", "scripts/db-backup.mjs"], backup_env, 1800)
        manifest = json.loads(Path(str(backup) + ".manifest.json").read_bytes())
        if manifest["sourceDatabaseIdentity"]["omniDatabaseId"] != controller.config["databaseIdentity"]: raise RuntimeError("backup_database_identity_changed")
        owner, database = "self_improvement_restore_owner", "self_improvement_restore_" + secrets.token_hex(8)
        with socket.socket() as selected:
            selected.bind(("127.0.0.1", 0)); port = selected.getsockname()[1]
        password = secrets.token_urlsafe(40)
        password_file = cluster / "connection-password"
        password_file.write_text(password + "\n"); password_file.chmod(0o600)
        run([str(bin_dir / "initdb"), "-D", str(data), "-U", owner, "--encoding=UTF8", "--locale=C", "--auth-host=scram-sha-256", "--auth-local=reject", "--pwfile=" + str(password_file)])
        run([config["opensslExecutable"], "req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", str(cluster / "server.key"), "-out", str(cluster / "server.crt"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"])
        (cluster / "server.key").chmod(0o600)
        # Paths derive from a locally created directory, never an app request.
        if "'" in str(cluster): raise RuntimeError("recovery_path_invalid")
        with (data / "postgresql.conf").open("a") as config_file:
            config_file.write(f"\nlisten_addresses='127.0.0.1'\nport={port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='{cluster}/server.crt'\nssl_key_file='{cluster}/server.key'\nmax_connections=12\nshared_buffers='32MB'\nmax_locks_per_transaction=1024\nmaintenance_work_mem='32MB'\nmax_parallel_maintenance_workers=0\nmax_parallel_workers_per_gather=0\nmax_parallel_workers=0\nlog_statement='none'\nlog_min_error_statement='panic'\n")
        (data / "pg_hba.conf").write_text("hostnossl all all 127.0.0.1/32 reject\nhostssl all all 127.0.0.1/32 scram-sha-256\n")
        run([str(bin_dir / "pg_ctl"), "-D", str(data), "-l", str(cluster / "postgres.private.log"), "-w", "-t", "45", "start"], timeout=60)
        started = True
        pg_env.update(PGHOST="127.0.0.1", PGPORT=str(port), PGUSER=owner, PGPASSWORD=password, PGDATABASE="postgres", PGSSLMODE="verify-full", PGSSLROOTCERT=str(cluster / "server.crt"))
        def sql(statement, name="postgres"):
            run([str(bin_dir / "psql"), "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--dbname", name, "--command", statement])
        sql(f"CREATE DATABASE {database} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'")
        sql("CREATE EXTENSION vector", database)
        for role in manifest["grantRoles"]:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", role) or role == owner: raise RuntimeError("restore_role_invalid")
            sql(f'DO $r$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=\'{role}\') THEN CREATE ROLE "{role}" NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $r$;')
        target = f"postgresql://{owner}:{urllib.parse.quote(password, safe='')}@127.0.0.1:{port}/{database}?sslmode=verify-full"
        restore_env = dict(pg_env, DATABASE_URL=backup_env["DATABASE_URL"], OMNIAGENT_BACKUP_ENCRYPTION_KEY=backup_env["OMNIAGENT_BACKUP_ENCRYPTION_KEY"], OMNIAGENT_BACKUP_INPUT=str(backup), RESTORE_DATABASE_URL=target, RESTORE_CONFIRM="restore-into-isolated-database:" + database, OMNIAGENT_RESTORE_RTO_SECONDS=str(config.get("recoveryTimeObjectiveSeconds", 3600)))
        try: run(["node", "scripts/db-restore-drill.mjs"], restore_env, 3600)
        finally: restore_env.clear()
        evidence = Path(str(backup) + ".restore-evidence.json")
        return {"path": str(evidence), "sha256": hashlib.sha256(evidence.read_bytes()).hexdigest()}
    finally:
        backup_env.clear(); pg_env.pop("PGPASSWORD", None)
        # Do not delete a cluster if stop is uncertain. Its private marker keeps
        # that failure available for explicit cleanup, without touching others.
        if data.exists() and (started or (data / "postmaster.pid").exists()):
            run([str(bin_dir / "pg_ctl"), "-D", str(data), "-m", "fast", "-w", "-t", "45", "stop"], timeout=60)
        if json.loads((cluster / "marker.json").read_text()) != marker: raise RuntimeError("recovery_cleanup_marker_changed")
        shutil.rmtree(cluster)
