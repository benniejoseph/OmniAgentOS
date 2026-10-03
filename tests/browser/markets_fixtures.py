"""Markets browser contracts; no market/provider/model/job mutation reaches a server."""

import copy
import hashlib
import json
import re
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

FOUNDATION = "market-research-foundation:6"
BASELINE = "market-event-baseline:1"
DETECTOR = "market-ict-quarterly-candidates:2"
FORWARD = "market-forward-shadow:1"
GOLD, INDEX = "xauusd.spot", "ndx.cash"
LONG = "ExactEvidence_" + "x" * 160
MARKUP = "<script>window.untrustedMarketRan=true</script>"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
SDK = "/vendor/tradingview/charting_library/charting_library.standalone.js"


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def identity(kind, value):
    return "market_" + kind + "_" + sha(value)[:48]


def date_time(minutes):
    return (datetime.fromisoformat(STAMP.replace("Z", "+00:00")) + timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def instrument(key):
    gold = key == GOLD
    return {"instrumentId": key, "label": "Gold / U.S. dollar" if gold else "NASDAQ-100 cash index", "shortLabel": "Gold" if gold else "NASDAQ-100", "canonicalSymbol": "XAU/USD" if gold else "NDX", "assetClass": "commodity_spot" if gold else "equity_index", "aliases": ["XAUUSD"] if gold else ["NAS100", "US100"], "description": "Synthetic exact instrument reference.", "identityWarning": "Exact cash reference, never a substitute for a broker CFD or futures contract. " + LONG, "providerMapping": {"provider": "twelve_data", "symbol": "XAU/USD" if gold else "NDX", "status": "verified", "note": "Synthetic mapped source."}}


def overview():
    return {"contractVersion": FOUNDATION, "generatedAt": STAMP, "phase": "ready_for_historical_replay", "instruments": [instrument(GOLD), instrument(INDEX)], "providers": [{"provider": key, "label": label, "purpose": purpose, "configured": True, "blocking": key == "twelve_data", "status": "connected", "setupVariable": "SYNTHETIC_ONLY"} for key, label, purpose in [("twelve_data", "Twelve Data", "Exact prices"), ("fred", "FRED / ALFRED", "Initial-release values"), ("bls", "BLS", "Official times")]], "agent": {"agentId": "meridian", "name": "Meridian", "role": "Market research", "modelScope": "market_research", "assignmentState": "assigned", "configured": True, "provider": "synthetic", "model": "fixture-model", "source": "tenant_assignment", "note": "No model call occurs in this suite."}, "engineTracks": [{"id": key, "label": key.replace("_", " "), "state": "foundation", "note": "Synthetic ready fixture."} for key in ("event_replay", "ict_detectors", "scenario_forecast", "forward_shadow")], "guardrails": ["Research only. No trade execution.", "Uncalibrated scenarios remain separate from observed outcomes."]}


def bars(key=GOLD, interval="15min", revision=1):
    minutes = {"5min": 5, "15min": 15, "1h": 60}[interval]
    rows = []
    for index in range(48):
        stamp = date_time(index * minutes)
        price = (2500 if key == GOLD else 20000) + index + revision
        rows.append({"time": int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()), "timestamp": stamp, "open": price, "high": price + 3, "low": price - 2, "close": price + 1, "volume": None})
    tag = f"{key}:{interval}:{revision}"
    return {"contractVersion": FOUNDATION, "instrumentId": key, "provider": "twelve_data", "providerSymbol": instrument(key)["providerMapping"]["symbol"], "providerTimezone": "UTC", "interval": interval, "retrievedAt": date_time(3000), "asOf": rows[-1]["timestamp"], "bars": rows, "snapshotId": identity("snapshot", tag), "snapshotSha256": sha(tag), "snapshotSource": "provider"}


def features(snapshot):
    definitions = ["foundation.swing.v2", "foundation.fvg.v2", "foundation.displacement.v1", "foundation.liquidity_sweep.v1", "foundation.liquidity_pool.v1", "foundation.session_window.v1", "foundation.calendar_gap.v1", "foundation.quarterly_time.v1", "foundation.reference_open.v1", "candidate.order_block.v1"]
    detection = {"id": identity("feature", snapshot["snapshotId"]), "definitionId": "foundation.swing.v2", "kind": "swing_high", "direction": "neutral", "timestamp": snapshot["asOf"], "endTimestamp": None, "price": snapshot["bars"][-1]["close"], "zoneLow": None, "zoneHigh": None, "strength": 1, "state": "observed", "reviewState": "deterministic_foundation", "reason": "Synthetic bounded geometry. " + MARKUP, "evidenceTimestamps": [snapshot["asOf"]]}
    return {"contractVersion": FOUNDATION, "detectorVersion": DETECTOR, "snapshot": {"id": snapshot["snapshotId"], "sha256": snapshot["snapshotSha256"], "instrumentId": snapshot["instrumentId"], "provider": snapshot["provider"], "providerSymbol": snapshot["providerSymbol"], "interval": snapshot["interval"], "firstBarAt": snapshot["bars"][0]["timestamp"], "asOf": snapshot["asOf"], "barCount": len(snapshot["bars"])}, "timeContext": {"timezone": "America/New_York", "localDate": "2026-10-03", "localTime": "15:30", "ninetyMinuteQuarter": 11, "session": "off_hours", "references": [{"id": key, "label": key.replace("_", " "), "period": "2026-10-03", "open": None, "timestamp": None, "status": "outside_snapshot"} for key in ("ninety_minute", "day", "week", "month")]}, "range": {"lookbackBars": 48, "low": 2400, "high": 2700, "equilibrium": 2550, "latestClose": snapshot["bars"][-1]["close"], "positionPercent": 50, "zone": "equilibrium"}, "definitions": [{"id": key, "label": key, "formula": "Frozen deterministic definition. " + LONG, "reviewState": "candidate_rule" if key.startswith("candidate") else "deterministic_foundation", "transcriptAuthority": "awaiting_review" if key.startswith("candidate") else "not_claimed"} for key in definitions], "detections": [detection], "layers": [{"id": key, "label": key.title(), "description": "Exact immutable layer " + key, "defaultVisible": key == "structure", "count": 1 if key == "structure" else 0} for key in ("liquidity", "imbalances", "blocks", "setups", "sessions", "quarterly", "structure", "gaps")], "annotations": [{"id": identity("annotation", snapshot["snapshotId"]), "detectionId": detection["id"], "layerId": "structure", "concept": "swing_high", "label": "Frozen high", "detail": detection["reason"], "direction": "neutral", "state": "observed", "reviewState": "deterministic_foundation", "renderPriority": 1, "primitive": {"type": "horizontal_line", "point": {"time": snapshot["bars"][0]["time"], "price": detection["price"]}, "endTime": snapshot["bars"][-1]["time"]}}], "counts": {key: 1 if key == "swingPoints" else 0 for key in ("activeFairValueGaps", "validOrderBlocks", "liquidityLevels", "sessionWindows", "setupCandidates", "displacements", "liquiditySweeps", "swingPoints")}, "resultSha256": sha("features:" + snapshot["snapshotId"])}


def analysis(snapshot, sequence=1, submitted=None):
    submitted = submitted or {"visibleLayerIds": ["structure"], "chartState": {"sources": [["manual-1", {"kind": "trend_line", "label": LONG}]], "groups": [], "symbol": snapshot["instrumentId"]}}
    return {"id": identity("analysis", snapshot["snapshotId"] + str(sequence)), "contractVersion": "market-analysis-version:1", "instrumentId": snapshot["instrumentId"], "interval": snapshot["interval"], "snapshotId": snapshot["snapshotId"], "snapshotSha256": snapshot["snapshotSha256"], "detectorVersion": DETECTOR, "technicalResultSha256": features(snapshot)["resultSha256"], "visibleLayerIds": sorted(submitted["visibleLayerIds"]), "chartStateSha256": sha(json.dumps(submitted["chartState"], sort_keys=True)), "chartState": copy.deepcopy(submitted["chartState"]), "annotationCount": 1, "detectionCount": 1, "candidateCount": 0, "savedAt": date_time(sequence), "versionSha256": sha("version:" + str(sequence) + snapshot["snapshotId"])}


def event(number=1):
    exact = number == 1
    return {"id": identity("event", str(number)), "eventKey": "us.cpi" if exact else "us.gdp", "name": "Consumer prices" if exact else "Date-only GDP release", "currency": "USD", "impact": "high", "source": "fred", "sourceReleaseId": number, "sourceUrl": f"https://fred.stlouisfed.org/release?rid={number}", "releaseDate": "2026-10-03", "occurredAt": STAMP if exact else None, "timestampPrecision": "instant" if exact else "date", "scheduleSource": "bls" if exact else None, "scheduleSourceUrl": "https://www.bls.gov/schedule/" if exact else None, "actual": None, "consensus": None, "previous": None, "revised": None, "valueStatus": "release_date_only", "observations": [], "importedAt": STAMP}


def calendar():
    family = {"eventKey": "us.cpi", "name": "Consumer prices", "category": "inflation", "components": ["Headline", "Core"], "aliases": [], "scheduleCoverage": "official_exact", "historyCoverage": "fred_release_dates", "whyItMatters": "Synthetic release evidence. " + MARKUP, "sourceUrl": "https://www.bls.gov/schedule/"}
    release = {key: value for key, value in family.items() if key not in ("aliases", "scheduleCoverage", "historyCoverage")}
    release.update(source="bls", releaseDate="2026-10-03", occurredAt=STAMP, timezone="America/New_York", dayState="today", releaseState="released")
    return {"contractVersion": "market-live-calendar:1", "generatedAt": STAMP, "marketDate": "2026-10-03", "timezone": "America/New_York", "windowDays": 14, "catalog": {"reviewedFamilies": 1, "exactTimeFamilies": 1, "dateOnlyFamilies": 0, "families": [family]}, "events": [release], "sourceHealth": [{"source": source, "status": "unavailable" if source == "bea" else "connected", "eventCount": 1 if source == "bls" else 0, "note": "Synthetic publisher unavailable." if source == "bea" else "Synthetic bounded publisher read."} for source in ("bls", "census", "bea", "federal_reserve")], "disclosures": ["Unavailable publishers may have missing releases.", "Exact time remains distinct from date-only history."]}


def replays(key):
    snapshot = bars(key, "5min")
    row = {"id": identity("replay", key), "eventId": event()["id"], "eventKey": "us.cpi", "instrumentId": key, "provider": "twelve_data", "providerSymbol": snapshot["providerSymbol"], "interval": "5min", "occurredAt": STAMP, "windowStart": STAMP, "windowEnd": date_time(240), "retrievedAt": date_time(241), "barCount": 48, "snapshotSha256": snapshot["snapshotSha256"], "baseline": {"timestamp": STAMP, "close": 2500}, "post5m": {"timestamp": date_time(5), "close": 2501, "returnBps": 4}, "post15m": None, "post60m": {"timestamp": date_time(60), "close": 2505, "returnBps": 20}, "post240m": None, "pre60mRangeBps": 4, "post60mRangeBps": 30, "maxFavorableBps": 30, "maxAdverseBps": 2, "direction": "up"}
    return {"contractVersion": FOUNDATION, "instrumentId": key, "replays": [row], "eligibleEvents": 1, "replayedEvents": 1, "remainingEvents": 0, "lastReplayedAt": STAMP}


def baselines(key):
    distribution = {"sampleSize": 1, "meanBps": 20, "medianBps": 20, "lowerQuartileBps": 20, "upperQuartileBps": 20}
    group = {"eventKey": "us.cpi", "sampleSize": 1, "state": "low_sample", "firstOccurredAt": STAMP, "lastOccurredAt": STAMP, "directions": {"up": 1, "down": 0, "flat": 0}, "empiricalRates": {"up": 1, "down": 0, "flat": 0}, "excursions": {"sampleSize": 1, "medianFavorableBps": 30, "medianAdverseBps": 2}}
    group.update({key: copy.deepcopy(distribution) for key in ("post5m", "post15m", "post60m", "post240m")})
    return {"contractVersion": FOUNDATION, "baselineVersion": BASELINE, "instrumentId": key, "minimumSampleSize": 20, "includedReplays": 1, "groups": [group], "resultSha256": sha("baseline:" + key), "interpretation": "descriptive_not_predictive"}


def backtest(snapshot, sequence=1):
    metric = {"trades": 0, "wins": 0, "losses": 0, "breakEven": 0, "winRate": None, "netR": 0, "expectancyR": None, "profitFactor": None, "maxDrawdownPercent": 0, "endingEquity": 10000}
    return {"contractVersion": FOUNDATION, "backtestVersion": "market-deterministic-backtest:1", "id": identity("backtest", snapshot["snapshotId"] + str(sequence)), "instrumentId": snapshot["instrumentId"], "provider": "twelve_data", "providerSymbol": snapshot["providerSymbol"], "interval": snapshot["interval"], "snapshotId": snapshot["snapshotId"], "snapshotSha256": snapshot["snapshotSha256"], "snapshotAsOf": snapshot["asOf"], "firstBarAt": snapshot["bars"][0]["timestamp"], "lastBarAt": snapshot["asOf"], "barCount": len(snapshot["bars"]), "manifest": backtest_body(snapshot) | {"engineRulesSha256": sha("engine"), "entryTiming": "next_bar_open", "collisionPolicy": "stop_first", "overlapPolicy": "single_position", "evaluationLabel": "retrospective_rule_evaluation", "splitRatios": [0.6, 0.2, 0.2]}, "splitBoundaries": {"validationStartsAt": date_time(400), "testStartsAt": date_time(550)}, "leakageChecks": {key: True for key in ("strictChronology", "immutableSnapshotBound", "signalUsesPastAndPresentOnly", "entryAfterSignal", "costsApplied")}, "metrics": {key: copy.deepcopy(metric) for key in ("overall", "train", "validation", "test")}, "trades": [], "warnings": ["Synthetic deterministic history. No market execution. " + LONG], "resultSha256": sha("backtest:" + str(sequence)), "createdAt": date_time(sequence)}


def backtest_body(snapshot):
    return {"strategy": {"strategyId": "foundation.liquidity_sweep_reversal.v1", "direction": "both", "session": "all", "rewardRiskRatio": 2, "maxHoldingBars": 24, "stopBufferRangeMultiplier": 0.1}, "costs": {"spreadBps": 2, "slippageBps": 1, "commissionBps": 0}, "initialEquity": 10000, "riskPerTradeBps": 100}


def forecast(key=GOLD, horizon="daily", sequence=1):
    snapshot = bars(key)
    return {"id": identity("forecast", f"{key}:{horizon}:{sequence}"), "contractVersion": FORWARD, "instrumentId": key, "horizon": horizon, "windowStart": "2026-10-05T13:30:00.000Z", "windowEnd": "2026-10-05T20:00:00.000Z", "sealedAt": STAMP, "researchMode": True, "probabilityState": "uncalibrated", "stance": "abstain", "evidenceStrength": "limited", "summary": "A frozen synthetic scenario with unresolved evidence. " + MARKUP + " " + LONG, "scenarios": [{"direction": direction, "rank": index + 1, "thesis": "Conditional " + direction + " path. " + LONG, "observationZone": None, "targets": [], "invalidation": None, "supportingFeatureIds": []} for index, direction in enumerate(("bullish", "bearish", "neutral"))], "warnings": ["No calibrated probability is claimed."], "evidence": {"snapshotId": snapshot["snapshotId"], "snapshotSha256": snapshot["snapshotSha256"], "snapshotAsOf": snapshot["asOf"], "detectorVersion": DETECTOR, "technicalResultSha256": sha("technical"), "baselineVersion": BASELINE, "baselineResultSha256": sha("baseline"), "baselineReplayCount": 1, "baselineQualifiedGroups": 0, "macroEventIds": [event()["id"]], "macroEventsSha256": sha("macro")}, "modelAttribution": {"provider": "synthetic", "model": "fixture-model", "assignmentScope": "market_research", "assignmentId": LONG, "assignmentRevision": 1, "assignmentConfigurationSha256": sha("assignment"), "usageReceiptId": "123e4567-e89b-42d3-a456-426614174000", "usageReceiptRecorded": True}, "forecastSha256": sha("forecast" + key + horizon + str(sequence))}


def outcome(key=GOLD):
    return {"id": identity("forecast_outcome", key), "forecastId": forecast(key)["id"], "resolvedAt": "2026-10-05T20:15:00.000Z", "provider": "twelve_data", "providerSymbol": instrument(key)["providerMapping"]["symbol"], "interval": "15min", "sourcePayloadSha256": sha("outcome-payload"), "snapshotSha256": sha("outcome-snapshot"), "firstPrice": 2500, "lastPrice": 2501, "returnBps": 4, "actualDirection": "bullish", "stanceHit": None, "scenarioRankHit": 1, "maxFavorableBps": None, "maxAdverseBps": None, "brierScore": None, "outcomeSha256": sha("outcome")}


def journal(key=GOLD, empty=False):
    return {"contractVersion": FORWARD, "instrumentId": key, "entries": [] if empty else [{"forecast": forecast(key), "resolutionState": "due", "outcome": None}], "scorecard": {"total": 0 if empty else 1, "resolved": 0, "due": 0 if empty else 1, "abstentions": 0 if empty else 1, "directionalAccuracy": None, "directionalSampleSize": 0, "coverage": None, "brierScore": None, "probabilityState": "uncalibrated"}}


def job(identity, kind, status="queued", revision=0):
    return {"id": identity, "type": kind, "status": status, "progress": {"stage": "completed" if status == "completed" else "queued"}, "priority": 0, "attempt": 0, "maxAttempts": 3, "runAt": STAMP, "createdAt": STAMP, "updatedAt": date_time(revision), **({"completedAt": date_time(revision)} if status in ("completed", "failed", "canceled") else {})}


# Deliberately labelled adapter, not a reimplementation/certification of TradingView.
# Only the host integration, disposal, theme calls and private-save body are tested.
CHART_ADAPTER = r"""(() => {
  window.marketChartCalls = [];
  let count=0;
  window.TradingView={widget:class {
    constructor(options){this.options=options;this.sources=null;this.groups=new Map();this.symbol=options.symbol;
      this.el=document.createElement('div');this.el.dataset.testid='market-chart-adapter';
      this.el.textContent='Synthetic chart adapter · licensed renderer not certified';
      Object.assign(this.el.style,{padding:'1rem',height:'100%',background:options.loading_screen.backgroundColor,color:options.loading_screen.foregroundColor});
      options.container.append(this.el);window.marketChartCalls.push({kind:'construct',symbol:options.symbol,theme:options.theme});}
    chartReady(){return Promise.resolve();} activeChart(){return this;}
    changeTheme(theme){window.marketChartCalls.push({kind:'theme',theme});return Promise.resolve();}
    applyOverrides(values){this.el.style.background=values['paneProperties.background'];this.el.style.color=values['scalesProperties.textColor'];window.marketChartCalls.push({kind:'overrides',values});}
    resetData(){window.marketChartCalls.push({kind:'reset'});} setSymbol(symbol){this.symbol=symbol;return Promise.resolve(true);} setResolution(){return Promise.resolve(true);}
    createShape(){return Promise.resolve('shape'+(++count));} createMultipointShape(){return Promise.resolve('shape'+(++count));} removeEntity(){}
    getLineToolsState(){return {sources:this.sources,groups:this.groups,symbol:this.symbol};}
    applyLineToolsState(state){this.sources=state.sources;this.groups=state.groups;this.symbol=state.symbol||this.symbol;return Promise.resolve();}
    remove(){window.marketChartCalls.push({kind:'remove',symbol:this.symbol});this.el.remove();}
  }};
})();"""


class MarketFixtures(Fixtures):
    def __init__(self, origin, max_effects=12):
        super().__init__(origin)
        self.plans, self.defaults, self.actions = defaultdict(deque), {}, deque()
        self.held, self.requests, self.releases = {}, [], []
        self.max_effects = max_effects
        self.series_version = defaultdict(lambda: 1)
        self.snapshots, self.jobs, self.saved = {}, {}, {}
        self.chart_available = True
        self.empty = False

    def snapshot(self, key=GOLD, interval="15min"):
        data = bars(key, interval, self.series_version[key + ":" + interval])
        self.snapshots[data["snapshotId"]] = data
        return data

    def plan(self, key, body=None, status=200, hold=None):
        self.plans[key].append({"body": copy.deepcopy(body), "status": status, "hold": hold})

    def fail(self, *keys):
        for key in keys:
            self.defaults[key] = {"body": {"error": "Synthetic " + key + " unavailable."}, "status": 503}

    def serve(self, route, key, body):
        if len(self.requests) >= 300:
            return self.reject(route, "read_budget")
        plan = self.plans[key].popleft() if self.plans[key] else self.defaults.get(key, {})
        result = copy.deepcopy(plan.get("body") if plan.get("body") is not None else body)
        status = plan.get("status", 200)
        self.requests.append({"key": key, "path": urlsplit(route.request.url).path, "status": status})
        if plan.get("hold"):
            label = plan["hold"]
            if label in self.held:
                label += ":" + str(len(self.requests))
            self.held[label] = (route, result, status)
            return
        return self.fulfill(route, result, status)

    def release(self, name):
        route, body, status = self.held.pop(name)
        try:
            self.fulfill(route, body, status)
            disposition = "fulfilled"
        except PlaywrightError:
            disposition = "already_aborted"
        self.releases.append({"name": name, "disposition": disposition})

    def abort_held(self):
        for name, (route, _, _) in list(self.held.items()):
            try:
                route.abort()
            except PlaywrightError:
                pass
            self.releases.append({"name": name, "disposition": "teardown_abort"})
        self.held.clear()

    def expect_action(self, path, body, result, *, hold=None, status=200, after_fail=()):
        self.actions.append({"path": path, "body": copy.deepcopy(body), "result": copy.deepcopy(result), "hold": hold, "status": status, "after_fail": after_fail})

    def mutation(self, route, path):
        request = route.request
        try:
            body = request.post_data_json
        except Exception:
            body = None
        plan = next((item for item in self.actions if item["path"] == path and item["body"] == body), None)
        key = request.headers.get("idempotency-key", "")
        pattern = {"/api/market-research/events": r"market-events-\d+", "/api/market-research/replays": r"market-replays-(?:xauusd\.spot|ndx\.cash)-\d+", "/api/market-research/backtests": r"market-backtest-market_snapshot_[a-f0-9]{48}-" + UUID, "/api/market-research/analysis": r"market-analysis-market_snapshot_[a-f0-9]{48}-" + UUID, "/api/market-research/journal/generate": r"market-forecast-(?:xauusd\.spot|ndx\.cash)-(?:daily|weekly)-" + UUID, "/api/market-research/journal/score": r"market-forecast-score-(?:xauusd\.spot|ndx\.cash)-" + UUID}.get(path)
        if (not plan or not pattern or len(self.writes) >= self.max_effects or request.method != "POST" or urlsplit(request.url).query or path != plan["path"] or body != plan["body"] or not re.fullmatch(pattern, key) or "x-idempotency-key" in request.headers or not request.headers.get("content-type", "").startswith("application/json")):
            return self.reject(route, "effect_contract", {"path": path, "body": body, "key": key, "expected": plan})
        self.actions.remove(plan)
        self.writes.append({"path": path, "body": body, "idempotency-key": key, "disposition": "locally_fulfilled", "status": plan["status"]})
        self.fail(*plan["after_fail"])
        if plan["hold"]:
            self.held[plan["hold"]] = (route, plan["result"], plan["status"])
            return
        return self.fulfill(route, plan["result"], plan["status"])

    def reject(self, route, reason, detail=None):
        self.unexpected.append({"kind": reason, "url": route.request.url, "method": route.request.method, "detail": detail})
        return self.fulfill(route, {"error": "Unexpected Markets request blocked."}, 503)

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return super().route(route) if path == "/__nextjs_original-stack-frames" else self.mutation(route, path)
        if path == SDK:
            return route.fulfill(status=200 if self.chart_available else 503, content_type="application/javascript", body=CHART_ADAPTER if self.chart_available else "", headers={"cache-control": "no-store"})
        if path == "/api/market-research":
            return self.reject(route, "overview_query") if query else self.serve(route, "overview", overview())
        if path == "/api/market-research/events":
            if query != {"limit": ["500"]}:
                return self.reject(route, "event_bound")
            return self.serve(route, "events", {"contractVersion": FOUNDATION, "events": [] if self.empty else [event(1), event(2)], "total": 0 if self.empty else 2, "lastImportedAt": None if self.empty else STAMP})
        if path == "/api/market-research/calendar":
            return self.reject(route, "calendar_bound") if query != {"days": ["14"]} else self.serve(route, "calendar", calendar())
        if path == "/api/market-research/features":
            snapshot = self.snapshots.get(query.get("snapshotId", [None])[0])
            if set(query) != {"snapshotId"} or not snapshot:
                return self.reject(route, "feature_identity")
            return self.serve(route, "features:" + snapshot["snapshotId"], features(snapshot))
        if path.startswith("/api/market-research/"):
            kind = path.rsplit("/", 1)[-1]
            key, interval = query.get("instrumentId", [None])[0], query.get("interval", ["15min"])[0]
            if key not in (GOLD, INDEX) or interval not in ("5min", "15min", "1h"):
                return self.reject(route, "market_context")
            if kind == "bars":
                if query != {"instrumentId": [key], "interval": [interval], "outputSize": ["480"]}:
                    return self.reject(route, "bar_bound")
                return self.serve(route, f"bars:{key}:{interval}", self.snapshot(key, interval))
            if kind == "analysis":
                if query != {"instrumentId": [key], "interval": [interval], "limit": ["8"]}:
                    return self.reject(route, "analysis_bound")
                rows = self.saved.get(key + ":" + interval, [analysis(self.snapshot(key, interval))])
                return self.serve(route, f"analysis:{key}:{interval}", {"contractVersion": "market-analysis-version:1", "instrumentId": key, "interval": interval, "versions": rows, "total": len(rows)})
            expected = {"instrumentId": [key], "minimumSampleSize": ["20"]} if kind == "baselines" else {"instrumentId": [key], "limit": [{"replays": "100", "backtests": "20", "journal": "40"}.get(kind, "")]}
            if query != expected:
                return self.reject(route, "history_bound")
            if kind == "replays":
                data = replays(key)
            elif kind == "baselines":
                data = baselines(key)
            elif kind == "journal":
                data = journal(key, self.empty)
            elif kind == "backtests":
                data = {"contractVersion": FOUNDATION, "instrumentId": key, "backtests": [] if self.empty else [backtest(self.snapshot(key), 2), backtest(self.snapshot(key), 1)], "total": 0 if self.empty else 2}
            else:
                return self.reject(route, "unknown_market_read")
            return self.serve(route, kind + ":" + key, data)
        if path.startswith("/api/operations/jobs/"):
            key = path.rsplit("/", 1)[-1]
            if query or key not in self.jobs:
                return self.reject(route, "job_identity")
            return self.serve(route, "job:" + key, {"job": self.jobs[key]})
        return super().route(route)
