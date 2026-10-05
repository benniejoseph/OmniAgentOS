#!/usr/bin/env python3
"""Read-only loopback fixture server for the unchanged production ATLAS component."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
from urllib.parse import parse_qs, urlsplit

REPO = Path(__file__).resolve().parents[2]
MANIFEST_SHA256 = "d485ef524ff7441ea663c38a59e21e7b258f9a6186b832c9d0a3b3ce866c19a8"
ASSET_ROOT = "/companion/atlas-v1/"
MODES = ("neutral", "poster", "motion")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verified_build(directory: Path) -> tuple[dict, dict[str, bytes], str]:
    raw = (directory / "build.json").read_bytes()
    record = json.loads(raw)
    if (record.get("schemaVersion") != 1 or record.get("kind") != "atlas-production-component-build"
            or Path(record["repo"]).resolve() != REPO.resolve()
            or record.get("acceptedManifestSha256") != MANIFEST_SHA256):
        raise ValueError("Unsupported build or repository/manifest identity.")
    metafile_bytes = (directory / "esbuild-metafile.json").read_bytes()
    if digest(metafile_bytes) != record["metafile"]["sha256"]:
        raise ValueError("Compiler input/output metadata differs from build receipt.")
    compiler_inputs = json.loads(metafile_bytes)["inputs"]
    definitions = record["compilation"]["define"]
    input_names = [row["path"] for row in record["inputs"]]
    for row in record["virtualInputs"]:
        match = re.fullmatch(r"<define:(.+)>", row["name"])
        if (row.get("kind") != "esbuild-virtual-define" or not match
                or row["name"] not in compiler_inputs
                or row["definitionKey"] != match[1] or match[1] not in definitions
                or row["replacement"] != definitions[match[1]]
                or row["metadata"] != compiler_inputs.get(row["name"])):
            raise ValueError("Compiler-generated define input does not match its recorded configuration/metadata.")
        input_names.append(row["name"])
    if len(set(input_names)) != len(input_names) or not set(compiler_inputs).issubset(input_names):
        raise ValueError("Compiler provenance contains duplicate or unrecorded inputs.")
    # Include dependencies and dirty, uncommitted harness inputs, not just HEAD.
    for row in record["inputs"] + record["assets"]:
        if row.get("kind") != "physical" or row["path"].startswith("<"):
            raise ValueError("Expected an explicitly physical source/asset input.")
        data = (REPO / row["path"]).read_bytes()
        if len(data) != row["bytes"] or digest(data) != row["sha256"]:
            raise ValueError(f"Source/asset changed after fixture build: {row['path']}")
    bundle = (directory / "player.js").read_bytes()
    if len(bundle) != record["bundle"]["bytes"] or digest(bundle) != record["bundle"]["sha256"]:
        raise ValueError("Compiled player differs from build receipt.")
    files = {"/player.js": bundle}
    for row in record["assets"]:
        files["/" + row["path"].removeprefix("public/")] = (REPO / row["path"]).read_bytes()
    if digest(files[ASSET_ROOT + "manifest.json"]) != MANIFEST_SHA256 or len(record["assets"]) != 34:
        raise ValueError("Missing exact HELD01 bundle plus approved neutral baseline.")
    return record, files, digest(raw)


def preferences(mode: str) -> dict:
    # Persisted revision 1 permits expressive/off without violating default-revision semantics.
    return {"schemaVersion": 1, "contract": "asael-companion-preferences:1",
            "snapshot": {"revision": 1, "persisted": True, "updatedAt": "2026-10-05T00:00:00.000Z",
                         "preferences": {"intensity": "expressive", "visible": True,
                                         "motion": "full" if mode == "motion" else "off",
                                         "defaultDestination": "assistant", "preferredThreadId": None}},
            "home": {"state": "not_set", "preferredThreadId": None, "href": None,
                     "fallbackHref": "/app/command"},
            "destination": {"href": "/app/command", "state": "configured"}}


HTML = b"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>ATLAS component measurement fixture</title><style>
body{margin:0;padding:24px;background:#f6f3ed;color:#272522;font:16px system-ui}
html[data-theme=dark] body{background:#252729;color:#f2eee6}
main{max-width:800px}#stage{margin:24px 0}.portrait,.portrait [data-atlas-poster]{display:block;width:100%;height:100%}
.portrait-image{display:block;width:100%;height:100%;object-fit:contain}button{padding:12px;margin:8px 8px 8px 0}output{padding:8px}
</style></head><body><div id="root"></div><script src="/player.js"></script></body></html>"""


def handler_for(record: dict, files: dict[str, bytes], identity: str):
    manifest = json.loads(files[ASSET_ROOT + "manifest.json"])
    asset_queries = {ASSET_ROOT + values[kind]: values[kind + "Sha256"]
                     for clip in manifest["states"].values() for theme in ("light", "dark")
                     for values in (clip[theme],) for kind in ("poster", "sprite")}

    class Handler(BaseHTTPRequestHandler):
        server_version = "AtlasProductionComponentLab/1"

        def respond(self, data: bytes, mime: str, cache="no-store"):
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                self.send_error(421)
                return
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            if parsed.path == "/case" and set(query) == {"mode", "size", "theme"}:
                if (query["mode"] in [[mode] for mode in MODES] and query["size"] in [[str(size)] for size in (36, 64, 72, 108, 256)]
                        and query["theme"] in [["light"], ["dark"]]):
                    return self.respond(HTML, "text/html; charset=utf-8")
            if parsed.path == "/__measurement__/identity" and not query:
                return self.respond(json.dumps({"buildSha256": identity, "source": record["source"],
                                                "manifestSha256": MANIFEST_SHA256}).encode(), "application/json")
            reference = urlsplit(self.headers.get("Referer", ""))
            refquery = parse_qs(reference.query)
            mode = refquery.get("mode", [None])[0]
            if f"{reference.scheme}://{reference.netloc}" != origin or reference.path != "/case" or mode not in MODES:
                self.send_error(403)
                return
            if parsed.path == "/api/companion/preferences" and not query:
                return self.respond(json.dumps(preferences(mode)).encode(), "application/json")
            if parsed.path == ASSET_ROOT + "manifest.json" and not query:
                # Explicitly exercise the production neutral fallback, not a replaced hook/player.
                data = b'{"schemaVersion":1,"status":"awaiting-art-review"}' if mode == "neutral" else files[parsed.path]
                return self.respond(data, "application/json", "no-cache")
            if parsed.path in asset_queries and query == {"v": [asset_queries[parsed.path]]}:
                return self.respond(files[parsed.path], "image/webp", "public, max-age=60")
            if parsed.path == "/companion/atlas-neutral.png" and not query:
                return self.respond(files[parsed.path], "image/png", "public, max-age=60")
            if parsed.path == "/player.js" and not query:
                return self.respond(files[parsed.path], "text/javascript; charset=utf-8")
            self.send_error(404)

        def log_message(self, *_args):
            pass

    return Handler


@contextmanager
def running_server(directory: Path, port=0):
    record, files, identity = verified_build(directory)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(record, files, identity))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", record, identity
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    with running_server(args.bundle_dir, args.port) as (origin, _, _):
        print(f"ATLAS production component fixture: {origin}", flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
