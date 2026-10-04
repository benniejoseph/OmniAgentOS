"""Bounded synthetic image delivery; never publishes or approves ATLAS artwork."""

import hashlib
import json
import struct
from urllib.parse import parse_qs, urlsplit
import zlib


STATES = ("available", "listening", "responding", "working", "needs_you", "blocked", "completed", "paused")
ROOT = "/companion/atlas-v1/"


def solid_png(width, height):
    # The browser decodes these synthetic PNGs by content type. Fixed public
    # filenames still exercise the manifest contract; no art codec is certified.
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    pixels = (b"\x00" + b"\x86\x65\x39\xff" * width) * height
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


class AtlasFixtures:
    def __init__(self, origin):
        self.origin = origin
        self.requests = []
        self.unexpected = []
        self.images = {"poster": solid_png(256, 256), "sprite": solid_png(1024, 1792)}
        self.digests = {kind: hashlib.sha256(data).hexdigest() for kind, data in self.images.items()}
        self.manifest = {"schemaVersion": 1, "creativeRevision": "synthetic-browser-lifecycle-only",
                         "frameSize": 256, "fps": 20, "columns": 4,
                         "states": {state: {"durationMs": 1200, "frameCount": 25,
                            **{theme: {"poster": f"{state}-{theme}-poster.webp",
                                       "sprite": f"{state}-{theme}-sprite.webp",
                                       "posterSha256": self.digests["poster"],
                                       "spriteSha256": self.digests["sprite"]}
                               for theme in ("light", "dark")}} for state in STATES}}

    def route(self, route):
        parsed = urlsplit(route.request.url)
        path = parsed.path
        self.requests.append(path)
        if (f"{parsed.scheme}://{parsed.netloc}" == self.origin and route.request.method == "GET"
                and path == ROOT + "manifest.json" and not parsed.query):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(self.manifest),
                                 headers={"cache-control": "no-store"})
        for state in STATES:
            for theme in ("light", "dark"):
                for kind, image in self.images.items():
                    if (f"{parsed.scheme}://{parsed.netloc}" == self.origin and route.request.method == "GET"
                            and path == ROOT + f"{state}-{theme}-{kind}.webp"
                            and parse_qs(parsed.query) == {"v": [self.digests[kind]]}):
                        return route.fulfill(status=200, content_type="image/png", body=image,
                                             headers={"cache-control": "no-store"})
        self.unexpected.append({"path": path, "method": route.request.method})
        return route.abort()

    def sprite_requests(self):
        return [path for path in self.requests if path.endswith("-sprite.webp")]
