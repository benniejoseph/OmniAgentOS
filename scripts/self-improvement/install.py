#!/usr/bin/env python3
"""Install a reviewed controller snapshot; never read credentials or start a job."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

SOURCES = ("controller.py", "mac_credentials.py", "recovery.py", "macos_manifest.py", "macos_source.py", "macos_protocol.py", "macos_sandbox.py", "macos_build.py", "macos_toolchain.py", "macos_sign.py", "macos_bridge.py", "macos_install.py", "macos_controller.py", "macos_ticket.py", "macos_provision.py", "macos_reconcile.py", "macos_assets.py")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--configuration", required=True, help="Owner-only JSON containing credential references, never credential values")
    parser.add_argument("--destination", required=True, help="New immutable directory outside every checkout")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    os.umask(0o077)
    source = Path(__file__).resolve().parent
    root = source.parent.parent
    read = lambda *argv: subprocess.check_output(["git", *argv], cwd=root, text=True).strip()
    if read("status", "--porcelain", "--untracked-files=all"): raise ValueError("Install only a clean, reviewed commit")
    config_path = Path(args.configuration).resolve()
    info = config_path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077: raise ValueError("Configuration must be owner-only")
    config = json.loads(config_path.read_bytes())
    destination = Path(args.destination).absolute()
    if destination.exists() or destination.is_relative_to(root): raise ValueError("Use a new directory outside the checkout")
    # Refuse any checkout ancestor, including an unrelated repository.
    if any((parent / ".git").exists() for parent in [destination, *destination.parents]): raise ValueError("Installation must be outside Git")
    destination.mkdir(mode=0o700, parents=True)
    config.update(version=1, repository="benniejoseph/OmniAgentOS", installationDirectory=str(destination), trustedRevision=read("rev-parse", "HEAD"), sourceHashes={})
    for name in SOURCES:
        raw = (source / name).read_bytes()
        compile(raw, name, "exec")
        (destination / name).write_bytes(raw); (destination / name).chmod(0o400)
        config["sourceHashes"][name] = hashlib.sha256(raw).hexdigest()
    state = Path(config["stateDirectory"])
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.stat().st_mode & 0o077: raise ValueError("State directory must be owner-only")
    raw = (json.dumps(config, indent=2) + "\n").encode()
    installed_config = destination / "configuration.json"
    installed_config.write_bytes(raw); installed_config.chmod(0o400)
    config_hash = hashlib.sha256(raw).hexdigest()
    arguments = [str(Path(args.python).resolve()), str(destination / "controller.py"), "--config", str(installed_config), "--config-sha256", config_hash]
    checked = subprocess.run([*arguments, "--check-configuration"], capture_output=True)
    if checked.returncode: raise ValueError("Installed configuration failed its read-only check")
    plist = {"Label": "app.asael.self-improvement-release-controller", "ProgramArguments": [*arguments, "--watch"],
             "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 300, "ProcessType": "Background",
             "WorkingDirectory": config["checkoutDirectory"],
             "StandardOutPath": str(state / "controller.out.log"),
             "StandardErrorPath": str(state / "controller.error.log"),
             "EnvironmentVariables": {"PYTHONDONTWRITEBYTECODE": "1"}}
    launch = destination / "app.asael.self-improvement-release-controller.plist"
    launch.write_bytes(plistlib.dumps(plist)); launch.chmod(0o400)
    destination.chmod(0o500)
    print(json.dumps({"status": "installed_not_started", "revision": config["trustedRevision"], "configurationSha256": config_hash, "launchAgent": str(launch), "credentialsRead": False, "productionContacted": False}))

if __name__ == "__main__":
    try: main()
    except Exception:
        print("CONTROLLER_INSTALL_REFUSED: inspect the private configuration and clean source; no credentials were read.", file=sys.stderr)
        sys.exit(1)
