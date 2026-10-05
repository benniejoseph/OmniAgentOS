#!/usr/bin/env python3
"""Root-run paired Next route-JS measurement; writes only a NEW external directory.

No install, source checkout mutation, provider credentials, server, browser, or
deployment. Both variants compile the complete pinned route graph serially.
Turbopack root stays unchanged: installed dependencies are copied inside it.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time

PLAYER = "src/components/companion-atlas-player.tsx"
PLAYER_SHA = "f762c68e23732720a031fc0ae3fc43a26d94ac7eadf9e35a7bdb5856d90838c6"
CONFIG_SHA = "8a0653728b006d10fa9bc0f419f891367d59fd576f3d669835112076048cf990"
NEXT_VERSION = "16.3.8"
MANIFEST_SHA = "d485ef524ff7441ea663c38a59e21e7b258f9a6186b832c9d0a3b3ce866c19a8"
STATS = ".next/diagnostics/route-bundle-stats.json"

# Measurement-only counterfactual. Same two public exports and same real scoped
# preference/motion read. Parents still own all labels, state and controls.
# Only image/manifest/sprite/gate mechanics become a static neutral portrait.
STATIC_PLAYER = '''"use client";

import Image from "next/image";
import { useRef, useState, useSyncExternalStore } from "react";
import { useCompanionPreferences } from "@/components/use-companion-preferences";
import { effectiveCompanionMotion } from "@/lib/companion/model";
import type { companionPresentation } from "@/lib/companion/presentation";

/** Disposable route-size counterfactual; never publish this replacement. */
export function useCompanionAtlasPlayer({ scope }: {
  scope?: string;
  conversationId?: string;
  presentation: ReturnType<typeof companionPresentation>;
  greeting?: boolean;
}) {
  const read = useCompanionPreferences(scope);
  const [assetFailed, setAssetFailed] = useState(false);
  const observationRef = useRef<HTMLElement>(null);
  const posterRef = useRef<HTMLSpanElement>(null);
  const spriteRef = useRef<HTMLSpanElement>(null);
  const pageVisible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => false);
  const reduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const preferences = read.response?.snapshot.preferences;
  const motion = effectiveCompanionMotion(preferences?.motion ?? "off", reduced);
  const intensity = preferences?.intensity ?? "quiet";
  const showPortrait = Boolean(read.state === "ready" && preferences?.visible && pageVisible && !assetFailed);
  return {
    read, motion, intensity, assetFailed, showPortrait, fullBody: false,
    poster: "/companion/atlas-neutral.png", observationRef, posterRef, spriteRef,
    onPosterError() { setAssetFailed(true); },
  };
}

export function CompanionAtlasPortrait({ posterRef, spriteRef, showPortrait, poster, fullBody, onPosterError, className, imageClassName, size }: Pick<ReturnType<typeof useCompanionAtlasPlayer>, "posterRef" | "spriteRef" | "showPortrait" | "poster" | "fullBody" | "onPosterError"> & {
  className: string;
  imageClassName: string;
  size: string;
}) {
  return <span className={className} aria-hidden="true">
    <span ref={posterRef} data-atlas-poster>{showPortrait ? <Image key={poster} src={poster} alt=""
      width={fullBody ? 211 : 108} height={fullBody ? 432 : 108} unoptimized loading="lazy"
      className={imageClassName} onError={onPosterError} /> : null}</span>
    <span ref={spriteRef} data-atlas-sprite style={{ display: "none", width: size, height: size, backgroundRepeat: "no-repeat" }} />
  </span>;
}

function subscribeVisibility(notify: () => void) { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); }
function visibleSnapshot() { return document.visibilityState === "visible"; }
function subscribeMotion(notify: () => void) { const query = window.matchMedia("(prefers-reduced-motion: reduce)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); }
function motionSnapshot() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
'''


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_record(path: Path, name: str | None = None) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return {"path": name or str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def write_json(path: Path, value) -> dict:
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    with path.open("xb") as destination:
        destination.write(data)
    return file_record(path, path.name)


def inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def inventory(root: Path, excluded=()) -> list[dict]:
    rows = []
    for folder, dirs, files in os.walk(root, followlinks=False):
        relative = Path(folder).relative_to(root)
        if relative == Path("."):
            dirs[:] = [name for name in dirs if name not in excluded]
        for name in sorted(dirs + files):
            path = Path(folder) / name
            rel = path.relative_to(root).as_posix()
            if path.is_symlink():
                target = os.readlink(path)
                # Relative in-tree npm links remain in-tree in the private copy.
                if Path(target).is_absolute() or not inside(path.resolve(strict=True), root.resolve()):
                    raise ValueError(f"External/absolute dependency or source symlink: {rel}")
                rows.append({"path": rel, "kind": "symlink", "target": target})
            elif path.is_file():
                rows.append({**file_record(path, rel), "kind": "file", "mode": stat.S_IMODE(path.stat().st_mode)})
    return sorted(rows, key=lambda row: row["path"])


def freeze_source(project: Path, expected: list[dict]) -> None:
    observed = inventory(project, ("node_modules", ".next"))
    # Next may create this ignored declaration file. It has no emitted JS and
    # is retained with each build receipt; tracked inputs must remain exact.
    expected_names = {row["path"] for row in expected}
    observed = [row for row in observed if row["path"] != "next-env.d.ts" or "next-env.d.ts" in expected_names]
    if observed != expected:
        raise ValueError("Disposable tracked source changed beyond the declared player substitution.")


def extract_archive(archive: Path, destination: Path) -> None:
    destination.mkdir()
    with tarfile.open(archive, "r:") as source:
        members = source.getmembers()
        for entry in members:
            name = PurePosixPath(entry.name)
            if name.is_absolute() or ".." in name.parts or not (entry.isdir() or entry.isfile() or entry.issym()):
                raise ValueError("Unsafe or unsupported Git archive member.")
        # Add symlinks last so no subsequent member can traverse one.
        for entry in members:
            target = destination / entry.name
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(entry) as data, target.open("xb") as output:
                    shutil.copyfileobj(data, output)
                target.chmod(entry.mode & 0o777)
        for entry in members:
            if entry.issym():
                target = destination / entry.name
                if Path(entry.linkname).is_absolute() or not inside((target.parent / entry.linkname).resolve(), destination.resolve()):
                    raise ValueError("Git archive link escapes the disposable checkout.")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(entry.linkname)


def run_logged(argv: list[str], cwd: Path, env: dict, log: Path, timeout: int, check=True) -> dict:
    started = time.monotonic()
    with log.open("xb") as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except BaseException:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
            raise
    result = {"argv": argv, "exitCode": code, "elapsedSeconds": round(time.monotonic() - started, 3), "log": file_record(log, log.name)}
    if check and code:
        raise RuntimeError(f"Command failed ({code}); inspect {log.name}.")
    return result


def checked_dependencies(project: Path, donor: Path, output: Path) -> dict:
    for name in ("package.json", "package-lock.json"):
        if (project / name).read_bytes() != (donor / name).read_bytes():
            raise ValueError(f"Dependency donor differs from archived {name}; no install is attempted.")
    modules = (donor / "node_modules").resolve(strict=True)
    committed = json.loads((project / "package-lock.json").read_text())["packages"]
    installed_file = modules / ".package-lock.json"
    installed = json.loads(installed_file.read_text())["packages"]
    if not installed or "node_modules/next" not in installed:
        raise ValueError("Installed npm lock metadata is missing.")
    for key, meta in installed.items():
        if not key.startswith("node_modules/") or key not in committed:
            raise ValueError(f"Installed package is outside the committed lock: {key}")
        for field in ("version", "integrity", "resolved"):
            if meta.get(field) != committed[key].get(field):
                raise ValueError(f"Installed package lock mismatch: {key} ({field})")
        package_file = modules / key.removeprefix("node_modules/") / "package.json"
        if not package_file.is_file() or json.loads(package_file.read_text()).get("version") != meta.get("version"):
            raise ValueError(f"Installed package version mismatch: {key}")
    print("Hashing and copying the compatible installed dependency tree inside the disposable root.", flush=True)
    before = inventory(modules)
    required = sum(row.get("bytes", 0) for row in before)
    if shutil.disk_usage(output).free < required + 2 * 1024**3:
        raise ValueError("Insufficient space: dependency copy plus a 2 GiB build/evidence reserve is required.")
    shutil.copytree(modules, project / "node_modules", symlinks=True)
    copied = inventory(project / "node_modules")
    if copied != before or inventory(modules) != before:
        raise ValueError("Dependency bytes changed during copying.")
    manifest = write_json(output / "dependencies.json", copied)
    return {"donor": str(donor), "donorModules": str(modules), "materializedInsideProject": True,
            "method": "independent copytree; relative internal links retained; no hardlinks or outside-root symlink",
            "installedLock": file_record(installed_file), "manifest": manifest, "files": len(copied), "bytes": required}


def collect_stats(project: Path, destination: Path) -> tuple[dict, list[dict]]:
    data = (project / STATS).read_bytes()
    rows = json.loads(data)
    if not isinstance(rows, list) or not rows:
        raise ValueError("Next emitted no route rows.")
    routes, chunks = {}, {}
    for row in rows:
        route, total, paths = row.get("route"), row.get("firstLoadUncompressedJsBytes"), row.get("firstLoadChunkPaths")
        if not isinstance(route, str) or not route.startswith("/") or route in routes or type(total) is not int or total <= 0 or not isinstance(paths, list) or not paths:
            raise ValueError("Invalid, empty or duplicate route statistics.")
        if len(set(paths)) != len(paths):
            raise ValueError(f"Duplicate first-load chunk in {route}.")
        measured = 0
        for name in paths:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or not name.startswith(".next/static/") or not name.endswith(".js"):
                raise ValueError("Unexpected first-load chunk path.")
            original = project / name
            if original.is_symlink() or not original.is_file():
                raise ValueError(f"Next statistics reference a missing/non-file chunk: {name}")
            if name not in chunks:
                record = file_record(original, name)
                retained = destination / "chunks" / name
                retained.parent.mkdir(parents=True, exist_ok=True)
                with original.open("rb") as source, retained.open("xb") as target:
                    shutil.copyfileobj(source, target)
                if file_record(retained, name) != record:
                    raise ValueError("Retained chunk differs from compiled bytes.")
                chunks[name] = record
            measured += chunks[name]["bytes"]
        if measured != total:
            raise ValueError(f"Next route total differs from actual referenced chunk bytes: {route}")
        routes[route] = total
    with (destination / "route-bundle-stats.json").open("xb") as file:
        file.write(data)
    chunk_manifest = write_json(destination / "chunks.json", sorted(chunks.values(), key=lambda row: row["path"]))
    return {"routes": routes, "stats": file_record(destination / "route-bundle-stats.json", "route-bundle-stats.json"),
            "chunks": chunk_manifest, "referencedChunkCount": len(chunks)}, rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Git checkout containing the already accepted exact commit; read-only")
    parser.add_argument("--head", required=True, help="Full 40-character accepted commit SHA, never a branch name")
    parser.add_argument("--dependencies", type=Path, required=True, help="Existing npm project with identical package.json/lock and installed node_modules")
    parser.add_argument("--node", type=Path, required=True, help="Absolute existing Node24 executable; no download")
    parser.add_argument("--output", type=Path, required=True, help="NEW external evidence directory; all artifacts and disposable checkout remain here")
    parser.add_argument("--app-url", default="http://127.0.0.1:3100", help="Explicit public build URL, identical for both variants")
    parser.add_argument("--build-timeout-seconds", type=int, default=1200)
    args = parser.parse_args()
    source, donor, node = args.source.resolve(strict=True), args.dependencies.resolve(strict=True), args.node.resolve(strict=True)
    output = args.output.absolute()
    if output.exists() or output.is_symlink() or inside(output.resolve(), source) or inside(output.resolve(), donor):
        raise ValueError("Output must be new and outside both source and dependency donor.")
    if not re.fullmatch(r"[a-f0-9]{40}", args.head) or not node.is_file() or not args.node.is_absolute():
        raise ValueError("Exact commit and absolute Node executable are required.")
    if not 60 <= args.build_timeout_seconds <= 3600 or not re.fullmatch(r"https?://[A-Za-z0-9.:-]+/?", args.app_url):
        raise ValueError("Invalid bounded build timeout or public app origin.")
    git = shutil.which("git")
    if not git:
        raise ValueError("Existing Git executable required.")
    output.mkdir()  # Exclusive: failed runs are retained and cannot be overwritten.
    task_temp = output / "tmp"
    task_temp.mkdir()
    env = {"PATH": f"{node.parent}:/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": str(task_temp),
           "NODE_ENV": "production", "NODE_OPTIONS": "--max-old-space-size=2048", "CI": "1", "NO_COLOR": "1",
           "NEXT_TELEMETRY_DISABLED": "1", "NEXT_PUBLIC_APP_URL": args.app_url,
           "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    if "HOME" in os.environ:
        env["HOME"] = os.environ["HOME"]
    record = {"schemaVersion": 1, "kind": "atlas-paired-next-route-js", "status": "incomplete",
              "startedAt": datetime.now(timezone.utc).isoformat(), "sourceRepo": str(source), "revision": args.head,
              "environment": env, "helper": file_record(Path(__file__).resolve()), "builds": [],
              "homeBoundary": "Caller HOME is preserved unchanged if set, allowing ordinary build/cache configuration there; no private HOME copy is created. Other environment values remain explicitly allowlisted.",
              "boundary": "Same-source production-compiled first-load JS comparison. No full release/typecheck/static-generation/deployment claim.",
              "network": "No provider credentials inherited. Compile mode skips application prerender; ordinary build dependency/font downloads may use network. No egress-confinement claim."}
    try:
        def git_text(*arguments):
            return subprocess.check_output([git, "-C", str(source), *arguments], env=env, text=True).strip()
        if git_text("rev-parse", "--verify", f"{args.head}^{{commit}}") != args.head:
            raise ValueError("Requested immutable commit differs.")
        record["tree"] = git_text("rev-parse", f"{args.head}^{{tree}}")
        archive = output / "source.tar"
        with archive.open("xb") as file:
            subprocess.run([git, "-C", str(source), "archive", "--format=tar", args.head], env=env, stdout=file, check=True)
        record["sourceArchive"] = file_record(archive, archive.name)
        project = output / "workspace"
        extract_archive(archive, project)
        originals = inventory(project)
        record["sourceManifest"] = write_json(output / "source-files.json", originals)
        if file_record(project / PLAYER)["sha256"] != PLAYER_SHA or file_record(project / "next.config.ts")["sha256"] != CONFIG_SHA:
            raise ValueError("Player or production config differs from the reviewed helper boundary; review before updating pins.")
        if file_record(project / "public/companion/atlas-v1/manifest.json")["sha256"] != MANIFEST_SHA:
            raise ValueError("Expected accepted HELD01 assets.")
        for name in (".env", ".env.local", ".env.production", ".env.production.local"):
            if (project / name).exists():
                raise ValueError("Archived source contains an automatically loaded environment file.")
        version = subprocess.check_output([str(node), "--version"], env=env, text=True).strip()
        if not re.fullmatch(r"v24\.\d+\.\d+", version):
            raise ValueError("Node24 is required.")
        record["dependencies"] = checked_dependencies(project, donor, output)
        next_dir = project / "node_modules/next"
        next_version = json.loads((next_dir / "package.json").read_text())["version"]
        if next_version != NEXT_VERSION:
            raise ValueError("Next version differs from inspected compile/stats implementation.")
        record["tools"] = {"node": version, "nodeBinary": file_record(node), "next": next_version,
                           "python": sys.version, "git": subprocess.check_output([git, "--version"], env=env, text=True).strip(),
                           "buildImplementation": file_record(next_dir / "dist/build/index.js"),
                           "statsImplementation": file_record(next_dir / "dist/build/route-bundle-stats.js")}
        record["inputs"] = [file_record(project / name, name) for name in ("package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "performance-budgets.json", "scripts/check-route-js-budget.mjs", PLAYER)]
        baseline = STATIC_PLAYER.encode()
        original = (project / PLAYER).read_bytes()
        with (output / "static-only-companion-atlas-player.tsx").open("xb") as file:
            file.write(baseline)
        diff = "".join(difflib.unified_diff(original.decode().splitlines(True), STATIC_PLAYER.splitlines(True), fromfile=f"a/{PLAYER}", tofile=f"b/{PLAYER}")).encode()
        with (output / "static-only.patch").open("xb") as file:
            file.write(diff)
        record["substitution"] = {"path": PLAYER, "actualSha256": sha(original), "staticSha256": sha(baseline), "patchSha256": sha(diff),
                                  "scope": "Only the player module changes. Existing parent preference controls, state labels, routes, assets and app config remain byte-exact."}
        for variant in ("actual", "static-only"):
            destination = output / variant
            destination.mkdir()
            expected = originals
            if variant == "static-only":
                freeze_source(project, originals)
                (project / PLAYER).write_bytes(baseline)
                expected = [{**row, "bytes": len(baseline), "sha256": sha(baseline)} if row["path"] == PLAYER else row for row in originals]
            freeze_source(project, expected)
            # Same path and graph for both variants. Retain actual artifacts
            # before clearing only this helper-owned generated directory.
            if (project / ".next").exists():
                shutil.rmtree(project / ".next")
            print(f"Starting serial {variant} production compilation (Node24, heap2048).", flush=True)
            build = run_logged([str(node), str(next_dir / "dist/bin/next"), "build", "--turbopack", "--experimental-build-mode", "compile"],
                               project, env, destination / "compile.log", args.build_timeout_seconds)
            freeze_source(project, expected)
            metrics, _rows = collect_stats(project, destination)
            budget = run_logged([str(node), str(project / "scripts/check-route-js-budget.mjs"), str(destination / "route-bundle-stats.json")],
                                project, env, destination / "budget.log", 60, check=False)
            item = {"variant": variant, "build": build, "measurement": metrics, "budget": budget,
                    "generatedNextEnv": file_record(project / "next-env.d.ts", "next-env.d.ts") if (project / "next-env.d.ts").exists() else None}
            write_json(destination / "receipt.json", item)
            record["builds"].append(item)
        first, second = (item["measurement"]["routes"] for item in record["builds"])
        if set(first) != set(second):
            raise ValueError("The two compilations emitted different route sets.")
        record["comparison"] = [{"route": route, "actualBytes": first[route], "staticOnlyBytes": second[route],
                                  "additionalPlayerBytes": first[route] - second[route]} for route in sorted(first)]
        record["allRouteBudgetsPass"] = all(item["budget"]["exitCode"] == 0 for item in record["builds"])
        if inventory(project / "node_modules") != json.loads((output / "dependencies.json").read_text()):
            raise ValueError("Private dependency copy changed across the paired builds.")
        freeze_source(project, expected)
        record["status"] = "complete" if record["allRouteBudgetsPass"] else "complete-with-budget-failure"
        return 0 if record["allRouteBudgetsPass"] else 2
    except BaseException as error:
        record["status"] = "failed"
        record["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        record["finishedAt"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "comparison.json", record)


if __name__ == "__main__":
    raise SystemExit(main())
