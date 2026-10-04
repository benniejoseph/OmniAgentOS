#!/usr/bin/env python3
"""Read-only loopback server for the isolated rough lab; never opens a browser."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
from pathlib import Path
import threading
from urllib.parse import unquote, urlsplit

REPO = Path(__file__).resolve().parents[2]
PRODUCTION = REPO / '.design/asael-ace-revamp/atlas-production'
THREE = (REPO / 'node_modules/three').resolve()


def resolve_file(raw_path: str) -> Path | None:
    try:
        path = unquote(urlsplit(raw_path).path, errors='strict')
    except (UnicodeError, ValueError):
        return None
    if not path.startswith('/') or '\\' in path or any(ord(c) < 32 for c in path):
        return None
    if path == '/':
        return PRODUCTION / 'web/index.html'
    parts = path.removeprefix('/').split('/')
    if any(part in ('', '.', '..') for part in parts):
        return None
    category, *tail = parts
    if category == 'vendor':
        if len(tail) < 2 or tail[0] not in ('build', 'examples'):
            return None
        if tail[0] == 'examples' and tail[1] != 'jsm':
            return None
        base = THREE
        allowed = {'.js'}
    elif category in ('web', 'source', 'sheets', 'output'):
        base = (PRODUCTION / category).resolve()
        if not base.is_relative_to(PRODUCTION.resolve()):
            return None
        allowed = {'.html', '.css', '.mjs', '.json', '.svg', '.png', '.webp', '.glb'}
    else:
        return None
    target = base.joinpath(*tail).resolve()
    if not target.is_relative_to(base) or target.suffix not in allowed or not target.is_file():
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = 'AtlasRoughLab/1'

    def _file(self, body: bool) -> None:
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
            self.send_error(421, 'Loopback host required')
            return
        target = resolve_file(self.path)
        if target is None:
            self.send_error(404)
            return
        mime = {'.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.webp': 'image/webp'}.get(target.suffix)
        mime = mime or mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(target.stat().st_size))
        # Deliberately no HTTP compression. Fresh contexts and reloads are labeled separately.
        self.send_header('Cache-Control', 'public, max-age=60' if target.suffix != '.html' else 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'none'; media-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        if body:
            try:
                with target.open('rb') as source:
                    while chunk := source.read(65536):
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_GET(self) -> None:
        self._file(True)

    def do_HEAD(self) -> None:
        self._file(False)

    def log_message(self, *_args) -> None:
        pass


@contextmanager
def running_server(port: int = 0):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    with running_server(args.port) as url:
        print(f'ROUGH local lab: {url}\nNo browser opened. Ctrl+C stops the server.', flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
