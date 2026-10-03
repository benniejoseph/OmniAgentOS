"""Bounded Semantic Reviews contracts; every evaluation write is intercepted."""

import copy
import hashlib
import json
import re
from collections import defaultdict, deque
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError

from fixtures import Fixtures, STAMP

REVIEW_PATH = "/api/memory/semantic-shadow"
PROBE_PATH = REVIEW_PATH + "/rank-probe"
QUESTION = "Which release decision did this synthetic episode record?"
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
SOURCE_MARKUP = "<script>window.untrustedContentRan=true</script>"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def query_digest(query):
    # Same lexical JSON key order and UTF-8 encoding as sourceContractSha256.
    return digest(json.dumps({"domain": "asael:semantic-memory-shadow-rank-query:v1", "query": query.strip()},
                             ensure_ascii=False, separators=(",", ":")))


def overview():
    return {"version": "memory-intelligence-observatory:4", "generatedAt": STAMP,
            "summary": {"durableMemories": 0, "activeMemories": 0, "knowledgeDocuments": 0,
                        "knowledgeChunks": 0, "embeddedChunks": 0, "pendingReviews": 0,
                        "archivedMemories": 0, "graphNodes": 0, "graphEdges": 0,
                        "graphStatus": "unbuilt", "graphUpdatedAt": None,
                        "graphBuildLatencyMs": None, "maintenanceUpdatedAt": None},
            "memoryCategories": [], "knowledgeCategories": [],
            "semanticShadow": {"currentEpisodeCount": 24, "distinctThreadCount": 6,
                               "minimumEpisodeTarget": 24, "minimumThreadTarget": 6,
                               "sampleReadyForHumanReview": True, "activationReady": False,
                               "deterministicSummariesActive": True, "shadowOnly": True, "rankingEffect": "none"},
            "steward": {"agentId": "mnemosyne", "name": "Mnemosyne", "role": "Memory steward",
                        "state": "watching", "healthScore": 100, "lastObservedAt": STAMP,
                        "autonomy": "Synthetic read-only health sample.",
                        "learningSignals": {"retrievalUses": 0, "corrections": 0, "forgetRequests": 0, "resolvedReviews": 0},
                        "controller": {"contractVersion": "mnemosyne-proposal:1", "mode": "deterministic_propose_only",
                                       "automaticJobExecution": False, "automaticTruthMutation": False},
                        "recommendations": []}}


class SemanticReviewFixtures(Fixtures):
    """Plans are consumed once; held routes expose late-response races without timers."""

    def __init__(self, origin, max_writes=8):
        super().__init__(origin)
        self.max_writes = max_writes
        self.versions = [1] * 24
        self.reviews = {}
        self.probes = {}
        self.plans = defaultdict(deque)
        self.held = {}
        self.actions = deque()
        self.requests = []
        self.releases = []
        self.used_keys = set()

    @staticmethod
    def episode_id(index):
        return "semantic_episode_enrichment_" + format(index + 1, "048x")

    def candidate(self, index, detail=False):
        version = self.versions[index]
        identity = self.episode_id(index)
        source = (f"EPISODE_{index + 1}_VERSION_{version}: explicit synthetic release evidence.\n" * 8 +
                  SOURCE_MARKUP + "\n" + "ReadableEvidenceReference_" + "x" * 160)
        summary = f"Synthetic proposal for episode {index + 1}, version {version}."
        decision = "Keep the release decision bound to this exact source."
        value = {"id": identity, "reviewSourceSha256": digest(f"episode:{index}:version:{version}"),
                 "startsAt": STAMP, "endsAt": STAMP, "model": {"provider": "openai", "model": "synthetic-memory-model"},
                 "metrics": {"sourceCharacterCount": len(source), "outputCharacterCount": len(summary + decision),
                             "quoteBindingCount": 2, "validQuoteBindingCount": 2, "semanticItemCount": 2,
                             "generationLatencyMs": 1200, "deterministicReplayMatch": True},
                 "reviewable": index != 2}
        if not value["reviewable"]:
            value["unavailableReason"] = "Synthetic source requires recollection before evaluation."
        for storage, key in ((self.reviews, "latestReview"), (self.probes, "latestRankProbe")):
            if identity in storage and storage[identity]["reviewSourceSha256"] == value["reviewSourceSha256"]:
                value[key] = copy.deepcopy(storage[identity])
        if detail:
            turn_id = f"fixture-turn-{index}"
            evidence = [{"turnId": turn_id, "quote": source[:100], "startOffset": 0, "endOffsetExclusive": 100, "valid": True}]
            value.update(sourceTurns=[{"id": turn_id, "role": "user", "content": source, "createdAt": STAMP}],
                         deterministicSummary=f"BASELINE_{index + 1}_VERSION_{version}: deterministic source summary.",
                         semanticItems=[{"id": "semantic_summary", "kind": "summary", "text": summary,
                                         "confidenceBasisPoints": 9000, "evidence": copy.deepcopy(evidence)},
                                        {"id": "semantic_decision", "kind": "decision", "text": decision,
                                         "confidenceBasisPoints": 8000, "evidence": copy.deepcopy(evidence)}])
        return value

    def workspace(self, detail_id=None):
        candidates = [self.candidate(index, detail_id == self.episode_id(index)) for index in range(24)]
        count = sum("latestReview" in row for row in candidates)
        report = None if not count else {"caseCount": count, "distinctThreadCount": 1,
                  "rankProbeCaseCount": sum("latestRankProbe" in row for row in candidates if "latestReview" in row),
                  "coveredDimensions": ["decision"], "missingDimensions": ["commitment", "preference", "procedure",
                  "temporal_change", "conflict_correction", "multi_topic", "noisy_dialogue", "long_episode", "negative_control"],
                  "failureCodes": ["insufficient_cases", "insufficient_threads"], "activationReady": False}
        return {"candidates": candidates, "report": report, "reviewedCaseCount": count}

    def read_plan(self, key, *, hold=None, body=None, status=200):
        self.plans[key].append({"hold": hold, "body": copy.deepcopy(body), "status": status})

    def serve(self, route, key, body):
        plan = self.plans[key].popleft() if self.plans[key] else {}
        result = copy.deepcopy(plan.get("body") if plan.get("body") is not None else body)
        status = plan.get("status", 200)
        if plan.get("hold"):
            self.held[plan["hold"]] = (route, result, status)
            return
        return self.fulfill(route, result, status)

    def release(self, name):
        route, body, status = self.held.pop(name)
        try:
            self.fulfill(route, body, status)
            self.releases.append({"name": name, "disposition": "fulfilled_or_client_canceled"})
        except PlaywrightError:
            self.releases.append({"name": name, "disposition": "client_canceled"})

    def abort_held(self):
        for name, (route, _, _) in list(self.held.items()):
            try:
                route.abort()
            except PlaywrightError:
                pass
            self.releases.append({"name": name, "disposition": "teardown_abort"})
        self.held.clear()

    def review_body(self, index=0):
        target = self.candidate(index)
        return {"enrichmentId": target["id"], "reviewSourceSha256": target["reviewSourceSha256"],
                "dimension": "decision", "itemDecisions": [{"itemId": "semantic_summary", "decision": "supported"},
                {"itemId": "semantic_decision", "decision": "unsupported"}], "importantFactCount": 3,
                "baselineImportantFactHitCount": 1, "semanticImportantFactHitCount": 2,
                "compressionJudgment": "good", "scopeLeakCount": 0, "humanReviewed": True}

    def probe_body(self, index=0):
        target = self.candidate(index)
        return {"enrichmentId": target["id"], "reviewSourceSha256": target["reviewSourceSha256"],
                "query": QUESTION, "humanConfirmedTarget": True}

    def expect_action(self, kind, *, mode="success", hold=None, index=0):
        self.actions.append({"kind": kind, "mode": mode, "hold": hold, "index": index,
                             "body": self.review_body(index) if kind == "review" else self.probe_body(index)})

    def receipt(self, plan):
        body = plan["body"]
        candidate = self.candidate(plan["index"])
        if plan["kind"] == "review":
            result = {"enrichmentId": body["enrichmentId"], "reviewSourceSha256": body["reviewSourceSha256"],
                      "reviewedAt": STAMP, "itemDecisions": copy.deepcopy(body["itemDecisions"]), "actorId": "synthetic-owner", "seq": 1,
                      "case": {"caseId": "shadow-case-browser", "threadSha256": "a" * 64, "sourceSha256": "b" * 64,
                               "enrichmentSha256": "c" * 64, "humanReviewed": True, **candidate["metrics"],
                               "supportedSemanticItemCount": 1, "baselineFirstRelevantRank": None, "semanticFirstRelevantRank": None,
                               **{key: body[key] for key in ("dimension", "importantFactCount", "baselineImportantFactHitCount",
                                  "semanticImportantFactHitCount", "compressionJudgment", "scopeLeakCount")}}}
            if plan["mode"] == "success":
                self.reviews[body["enrichmentId"]] = result
            key = "review"
        else:
            result = {"schemaVersion": 1, "contract": "semantic-memory-shadow-rank-probe:1",
                      "enrichmentId": body["enrichmentId"], "reviewSourceSha256": body["reviewSourceSha256"],
                      "querySha256": query_digest(body["query"]), "corpusSha256": digest("synthetic-24-episode-corpus"),
                      "corpusCount": 24, "baselineFirstRelevantRank": 10, "semanticFirstRelevantRank": 3, "rankDelta": 7,
                      "rankingEngine": {"version": "p4.4-reranker-receipt:1", "modelVersion": "asael-local-pairwise-reranker:1",
                      "algorithm": "pairwise_logistic_regression", "trainingFixtureVersion": "p4.4-reranker-training:1",
                      "trainingCaseCount": 40, "candidateCount": 24, "externalDisclosure": False},
                      "humanConfirmedTarget": True, "probedAt": STAMP, "actorId": "synthetic-owner", "seq": 2}
            if plan["mode"] == "success":
                self.probes[body["enrichmentId"]] = result
            key = "probe"
        if plan["mode"] == "malformed":
            return {}
        if plan["mode"] == "mismatch":
            result["enrichmentId"] = self.episode_id(1)
        return {key: result}

    def mutation(self, route, path):
        request = route.request
        try:
            body = request.post_data_json
        except Exception:
            body = None
        plan = self.actions[0] if self.actions else None
        expected_path = REVIEW_PATH if plan and plan["kind"] == "review" else PROBE_PATH
        key = request.headers.get("x-idempotency-key", "")
        if (plan and len(self.writes) < self.max_writes and request.method == "POST" and path == expected_path and
                body == plan["body"] and UUID.fullmatch(key) and key not in self.used_keys and
                "idempotency-key" not in request.headers and request.headers.get("content-type", "").startswith("application/json")):
            self.actions.popleft()
            self.used_keys.add(key)
            self.writes.append({"path": path, "body": body, "x-idempotency-key": key, "disposition": "synthetic_" + plan["mode"]})
            result = self.receipt(plan)
            if plan["hold"]:
                self.held[plan["hold"]] = (route, result, 200)
                return
            return self.fulfill(route, result)
        self.unexpected.append({"kind": "write", "path": path, "method": request.method})
        return self.fulfill(route, {"error": "Unexpected evaluation effect blocked."}, 503)

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if path == "/__nextjs_original-stack-frames":
                return super().route(route)
            return self.mutation(route, path)
        if not path.startswith("/api/") or path == "/api/auth/session":
            return super().route(route)
        self.reads.add(path)
        self.requests.append({"path": path, "query": query})
        if path == REVIEW_PATH:
            selected = query.get("id", [None])[0]
            valid = query == {"limit": ["24"]} if selected is None else query == {"limit": ["100"], "id": [selected]} and selected in {self.episode_id(i) for i in range(24)}
            if not valid:
                self.unexpected.append({"kind": "unbounded_review_read", "query": query})
                return self.fulfill(route, {"error": "Unexpected review read."}, 400)
            return self.serve(route, "detail:" + selected if selected else "list", self.workspace(selected))
        if path == "/api/memory/intelligence":
            view = query.get("view", ["overview"])[0]
            return self.serve(route, "overview", {"overview": overview()}) if view == "overview" else self.fulfill(route, {view: {"items": [], "total": 0, "nextCursor": None}})
        if path == "/api/memory/personal-context-consent":
            return self.fulfill(route, {"state": "inactive", "notice": {"text": "Synthetic personal recall stays inactive.", "sha256": "c" * 64}})
        if path == "/api/memory/reconciliation":
            return self.fulfill(route, {"reviews": []})
        if path == "/api/knowledge/cognification":
            return self.fulfill(route, {"reviews": [], "reviewGroups": []})
        return super().route(route)
