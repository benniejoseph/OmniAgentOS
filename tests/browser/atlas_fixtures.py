"""Bounded synthetic vector delivery; never publishes or approves ATLAS artwork."""

import json
from urllib.parse import parse_qs, urlsplit


STATES = ("available", "listening", "responding", "working", "needs_you", "blocked", "completed", "paused")
ROOT = "/companion/atlas-lottie/"
REVISION = "atlas-scout-20261009-voice"


def asset(state, theme, format="svg"):
    return ROOT + f"{state}-{theme}.{format}?v={REVISION}"


class AtlasFixtures:
    def __init__(self, origin):
        self.origin = origin
        self.requests = []
        self.unexpected = []
        self.poster = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><circle cx="128" cy="128" r="72" fill="#866539"/></svg>'
        self.clip = {"v": "5.12.2", "w": 256, "h": 256, "fr": 30, "ip": 0, "op": 36,
                     "assets": [], "layers": [{"ddd": 0, "ind": 1, "ty": 4, "nm": "Synthetic finite vector",
                         "ks": {"o": {"a": 0, "k": 100}, "r": {"a": 0, "k": 0},
                                "p": {"a": 0, "k": [128, 128, 0]}, "a": {"a": 0, "k": [0, 0, 0]},
                                "s": {"a": 0, "k": [100, 100, 100]}},
                         "shapes": [{"ty": "el", "p": {"a": 0, "k": [0, 0]}, "s": {"a": 0, "k": [144, 144]}, "d": 1},
                                    {"ty": "fl", "c": {"a": 0, "k": [.525, .396, .224, 1]}, "o": {"a": 0, "k": 100}, "r": 1}],
                         "ip": 0, "op": 36, "st": 0, "bm": 0}]}

    def route(self, route):
        parsed = urlsplit(route.request.url)
        path = parsed.path
        self.requests.append(path)
        for state in STATES:
            for theme in ("light", "dark"):
                for format in ("svg", "json"):
                    if (f"{parsed.scheme}://{parsed.netloc}" == self.origin and route.request.method == "GET"
                            and path == ROOT + f"{state}-{theme}.{format}"
                            and parse_qs(parsed.query) == {"v": [REVISION]}):
                        return route.fulfill(status=200,
                                             content_type="image/svg+xml" if format == "svg" else "application/json",
                                             body=self.poster if format == "svg" else json.dumps(self.clip),
                                             headers={"cache-control": "no-store"})
        self.unexpected.append({"path": path, "method": route.request.method})
        return route.abort()

    def clip_requests(self):
        return [path for path in self.requests if path.endswith(".json")]
