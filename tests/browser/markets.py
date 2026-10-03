#!/usr/bin/env python3
"""Five Markets views, bounded reads, exact intercepted effects and chart host checks.

Licensed TradingView rendering is intentionally not certified by the labelled
adapter used for host theme/save/disposal integration. No real provider/model,
job, private analysis, replay or journal mutation is sent to the server.
"""

import argparse
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright
from markets_fixtures import (GOLD, INDEX, LONG, MarketFixtures, analysis, backtest_body,
                              bars, forecast, job, outcome)
from run import Checks, REPO, navigate, preview, select_theme


def workspace(page):
    return page.get_by_test_id("markets-workspace")


def button(page, name):
    return workspace(page).get_by_role("button", name=name, exact=True)


def view(page, label):
    control = workspace(page).get_by_role("group", name="Market research views").get_by_role("button", name=re.compile(r"^" + label + r"(?:\s|$)"))
    control.click()
    expect(control).to_have_attribute("aria-pressed", "true")
    return control


def until(page, predicate, label, timeout=20):
    end = time.monotonic() + timeout
    while not predicate() and time.monotonic() < end:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(label)


def count(fixture, key):
    return sum(row["key"] == key for row in fixture.requests)


def settle(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def evidence(page, name):
    summary = workspace(page).locator("summary").filter(has_text=re.compile("^" + re.escape(name) + "$"))
    if not summary.evaluate("el=>el.parentElement.open"):
        summary.click()
    return summary.locator("xpath=..")


def ready(page):
    expect(workspace(page)).to_be_visible(timeout=30_000)
    expect(button(page, "Refresh current view")).to_be_enabled()
    expect(workspace(page).get_by_role("heading", name="Markets", exact=True)).to_be_visible()


def refresh(page, fixture):
    before = count(fixture, "overview")
    button(page, "Refresh current view").click()
    until(page, lambda: count(fixture, "overview") > before, "Overview refresh did not start")
    expect(button(page, "Refresh current view")).to_be_enabled()


def receipt(page):
    return workspace(page).get_by_role("region", name="Confirmed market effect receipt", exact=True)


def select_instrument(page, key):
    label = "Gold" if key == GOLD else "NASDAQ-100"
    control = workspace(page).get_by_role("button", name=re.compile(r"^" + re.escape(label) + r"(?:\s|$)"))
    control.click()
    expect(control).to_have_attribute("aria-pressed", "true")


def initial_and_chart(page, fixture, checks, label):
    # Hold all mount reads, including development Strict Mode's replaced mount.
    fixture.defaults["overview"] = {"body": {"error": "Synthetic first readiness read failed."}, "status": 503, "hold": "initial"}
    navigate(page, fixture.origin, "/app/markets")
    until(page, lambda: "initial" in fixture.held, "Initial overview was not held")
    expect(workspace(page).get_by_text("Availability is not yet confirmed", exact=True)).to_be_visible()
    checks.check(label + ": pending readiness does not invent zero counts", "0 connected" not in workspace(page).inner_text())
    fixture.defaults.pop("overview")
    for name in list(fixture.held):
        if name == "initial" or name.startswith("initial:"):
            fixture.release(name)
    expect(button(page, "Retry research readiness")).to_be_visible()
    checks.check(label + ": unavailable overview does not become an empty market list", "Research instruments are unavailable" in workspace(page).inner_text())
    button(page, "Retry research readiness").click()
    ready(page)
    fixture.chart_available = False
    button(page, "Load live chart").click()
    expect(workspace(page).get_by_text("Advanced Chart could not load", exact=True)).to_be_visible(timeout=30_000)
    data = evidence(page, "Exact price data · 48 bars")
    expect(data.get_by_role("row")).to_have_count(41)
    checks.check(label + ": exact price evidence survives unavailable licensed assets", bars()["snapshotSha256"] in data.inner_text())
    button(page, "Next price rows").click()
    expect(data.get_by_role("row")).to_have_count(9)
    button(page, "Previous price rows").click()
    fixture.chart_available = True
    button(page, "Retry").click()
    expect(page.get_by_test_id("market-chart-adapter")).to_be_visible()
    data.locator("summary").click()
    checks.check(label + ": local chart retry preserves loaded source identity", bars()["snapshotId"] in evidence(page, "Price snapshot provenance").inner_text())
    evidence(page, "Price snapshot provenance").locator("summary").click()


def visual_views(page, fixture, checks, coarse):
    label = "phone" if coarse else "desktop"
    for name in ("Overview", "Events", "Technicals", "Backtests", "Journal"):
        view(page, name)
        if name == "Events":
            expect(workspace(page).get_by_role("table", name=re.compile("Official releases"))).to_be_visible()
            expect(workspace(page).get_by_role("region", name="Official calendar source coverage")).to_contain_text("Event coverage unavailable")
        elif name == "Technicals":
            expect(button(page, "Save version")).to_be_enabled()
            evidence(page, "Exact technical evidence")
        elif name == "Backtests":
            expect(workspace(page).get_by_role("region", name="Backtest history")).to_contain_text("2 returned")
            evidence(page, "Exact backtest result and configuration")
        elif name == "Journal":
            expect(workspace(page).get_by_text("Abstain", exact=True)).to_be_visible()
            evidence(page, "Exact forecast " + forecast()["id"] + " and outcome")
        select_theme(page, "light", coarse)
        settle(page)
        checks.snapshot(page, f"markets-{label}-{name.lower()}-light", coarse)
    view(page, "Technicals")
    select_theme(page, "dark", coarse)
    until(page, lambda: page.evaluate("() => (window.marketChartCalls||[]).some(x=>x.kind==='theme'&&x.theme==='dark')"), "Chart theme adapter did not receive the dark theme")
    settle(page)
    checks.snapshot(page, f"markets-{label}-technicals-dark", coarse)
    checks.check(label + ": chart override uses actual canonical surface token", page.evaluate("() => {const items=window.marketChartCalls.filter(x=>x.kind==='overrides');return items.at(-1)?.values['paneProperties.background']===getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()}"))
    checks.check(label + ": retrieved markup stays literal", page.evaluate("window.untrustedMarketRan !== true"))
    controls = workspace(page).locator("button:visible, input:visible, select:visible, summary:visible, a:visible").evaluate_all("els=>els.map(el=>({name:(el.innerText||el.getAttribute('aria-label')||el.tagName).slice(0,80),height:el.getBoundingClientRect().height}))")
    checks.check(label + ": native controls meet target floor", all(item["height"] >= (47.9 if coarse else 43.9) for item in controls), controls)
    button(page, "Save version").focus()
    page.keyboard.press("Tab"); page.keyboard.press("Shift+Tab")
    checks.check(label + ": keyboard focus is a three-pixel outline", button(page, "Save version").evaluate("el=>getComputedStyle(el).outlineWidth==='3px'"))
    page.evaluate("document.documentElement.style.fontSize='200%'")
    settle(page)
    checks.snapshot(page, f"markets-{label}-text200", coarse)
    page.evaluate("document.documentElement.style.fontSize=''")
    settle(page)
    page.emulate_media(forced_colors="active")
    expect(workspace(page).get_by_role("region", name="Exact provider price bars")).to_be_visible()
    checks.check(label + ": forced colors expose exact table and hide renderer", not page.get_by_test_id("market-chart-adapter").is_visible())
    page.emulate_media(forced_colors="none")
    settle(page)


def read_lifecycle(page, fixture, checks):
    view(page, "Overview")
    old = fixture.snapshot(GOLD)
    fixture.plan(f"bars:{GOLD}:15min", old, hold="old-a")
    refresh(page, fixture)
    until(page, lambda: "old-a" in fixture.held, "Old A snapshot was not held")
    fixture.plan(f"bars:{INDEX}:15min", fixture.snapshot(INDEX), hold="old-b")
    select_instrument(page, INDEX)
    until(page, lambda: "old-b" in fixture.held, "B snapshot was not held")
    fixture.series_version[GOLD + ":15min"] = 2
    select_instrument(page, GOLD)
    latest = fixture.snapshot(GOLD)
    evidence(page, "Price snapshot provenance")
    until(page, lambda: latest["snapshotSha256"] in workspace(page).locator("details").filter(has=page.locator("summary").get_by_text("Price snapshot provenance", exact=True)).inner_text(), "Fresh A snapshot not displayed")
    fixture.release("old-a"); fixture.release("old-b")
    page.wait_for_timeout(100)
    checks.check("A→B→A price response fencing keeps the latest exact digest", latest["snapshotSha256"] in evidence(page, "Price snapshot provenance").inner_text() and old["snapshotSha256"] not in evidence(page, "Price snapshot provenance").inner_text())
    fixture.fail(f"bars:{GOLD}:15min")
    refresh(page, fixture)
    expect(button(page, "Retry price snapshot")).to_be_visible()
    checks.check("Failed price refresh retains exact accepted snapshot", latest["snapshotId"] in evidence(page, "Price snapshot provenance").inner_text())
    fixture.defaults.clear(); button(page, "Retry price snapshot").click()
    view(page, "Journal")
    fixture.defaults["journal:" + GOLD] = {"body": {}}
    refresh(page, fixture)
    expect(button(page, "Retry forecast journal")).to_be_visible()
    expect(workspace(page).get_by_text("Abstain", exact=True)).to_be_visible()
    checks.check("Malformed journal response preserves sealed rows and counts", "1 due" in workspace(page).inner_text())
    fixture.defaults.pop("journal:" + GOLD)
    button(page, "Retry forecast journal").click()
    view(page, "Backtests")
    control = workspace(page).get_by_role("region", name="Backtest history").get_by_role("button").last
    control.click()
    expect(control).to_have_attribute("aria-pressed", "true")
    fixture.fail("backtests:" + GOLD)
    refresh(page, fixture)
    expect(button(page, "Retry backtest history")).to_be_visible()
    expect(control).to_have_attribute("aria-pressed", "true")
    checks.check("Backtest refresh failure preserves selected immutable result", "Selected sealed result" in workspace(page).inner_text())
    fixture.defaults.clear(); button(page, "Retry backtest history").click()


def queue_lifecycle(page, fixture, checks):
    view(page, "Events")
    expect(button(page, "Refresh history")).to_be_enabled()
    dates = page.evaluate("() => {const end=new Date();const start=new Date();start.setUTCDate(start.getUTCDate()-120);return {startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10)}}")
    event_job = job("browser_market_events", "market.events.backfill")
    fixture.jobs[event_job["id"]] = event_job
    fixture.expect_action("/api/market-research/events", dates, {"job": event_job}, status=202, hold="event-enqueue")
    before = len(fixture.writes)
    workspace(page).evaluate("el=>{const b=[...el.querySelectorAll('button')];b.find(x=>x.textContent.trim()==='Refresh history').click();b.find(x=>x.textContent.trim()==='Build next 24 per mapped market').click()}")
    until(page, lambda: "event-enqueue" in fixture.held, "Event enqueue was not held")
    checks.check("Synchronous cross-button collection shares one effect slot", len(fixture.writes) == before + 1)
    fixture.plan("job:" + event_job["id"], {"job": event_job})
    fixture.plan("job:" + event_job["id"], {"error": "Synthetic job status temporarily unavailable."}, 503)
    fixture.plan("job:" + event_job["id"], {"job": job(event_job["id"], event_job["type"], "completed", 1)})
    fixture.fail("events")
    fixture.release("event-enqueue")
    expect(receipt(page)).to_contain_text(event_job["id"])
    expect(button(page, "Refresh current view")).to_be_enabled()
    until(page, lambda: "Status is unconfirmed" in workspace(page).inner_text(), "Transient job failure was not presented", timeout=12)
    checks.check("Unknown job progress is not a zero", "Importing Unavailable/Unavailable" in workspace(page).inner_text())
    until(page, lambda: count(fixture, "job:" + event_job["id"]) >= 3, "Unchanged/error polling stopped", timeout=12)
    expect(button(page, "Retry event history")).to_be_visible()
    checks.check("Completed job receipt survives failed history refresh", event_job["id"] in workspace(page).inner_text() and "completed" in workspace(page).get_by_role("region", name="Market operation jobs").inner_text())
    fixture.defaults.clear(); button(page, "Retry event history").click()
    end = dates["endDate"]
    for key in (GOLD, INDEX):
        receipt_job = job("browser_replay_" + ("gold" if key == GOLD else "index"), "market.replays.backfill", "completed", 1)
        result = {"job": receipt_job} if key == GOLD else {"error": "Synthetic index replay queue unavailable."}
        fixture.expect_action("/api/market-research/replays", {"instrumentId": key, "interval": "5min", "startDate": "2000-01-01", "endDate": end, "maxEvents": 24}, result, status=202 if key == GOLD else 503)
    button(page, "Build next 24 per mapped market").click()
    expect(receipt(page)).to_contain_text("1 of 2 replay job receipts confirmed.")
    expect(workspace(page).get_by_role("alert")).to_contain_text("Unconfirmed replay requests")
    checks.check("One replay enqueue failure retains the independently confirmed sibling", "browser_replay_gold" in workspace(page).get_by_role("region", name="Market operation jobs").inner_text())
    view(page, "Backtests")
    snapshot = fixture.snapshot(GOLD)
    body = {"snapshotId": snapshot["snapshotId"], **backtest_body(snapshot)}
    queued = job("browser_backtest", "market.backtest.run")
    fixture.jobs[queued["id"]] = queued
    fixture.expect_action("/api/market-research/backtests", body, {"job": queued}, hold="backtest", status=202)
    button(page, "Run immutable backtest").click()
    until(page, lambda: "backtest" in fixture.held, "Backtest request not held")
    workspace(page).get_by_label("Reward / risk", exact=True).fill("3")
    fixture.release("backtest")
    expect(receipt(page)).to_contain_text(queued["id"])
    checks.check("Backtest receipt remains bound to the submitted settings, independent of later draft edits", fixture.writes[-1]["body"]["strategy"]["rewardRiskRatio"] == 2)
    fixture.jobs[queued["id"]] = job(queued["id"], queued["type"], "completed", 1)
    until(page, lambda: "completed" in workspace(page).get_by_role("region", name="Market operation jobs").locator("article").filter(has_text=queued["id"]).inner_text(), "Backtest terminal read not received")


def analysis_and_journal(page, fixture, checks):
    view(page, "Technicals")
    expect(button(page, "Save version")).to_be_enabled()
    snapshot = fixture.snapshot(GOLD)
    current = analysis(snapshot)
    body = {"snapshotId": snapshot["snapshotId"], "visibleLayerIds": ["structure"], "chartState": current["chartState"]}
    saved = analysis(snapshot, 2, body)
    fixture.saved[GOLD + ":15min"] = [saved, current]
    fixture.expect_action("/api/market-research/analysis", body, {"version": saved, "reused": False}, hold="save-analysis", after_fail=(f"analysis:{GOLD}:15min",))
    button(page, "Save version").click()
    until(page, lambda: "save-analysis" in fixture.held, "Private analysis save not held")
    expect(button(page, "15min")).to_be_disabled()
    fixture.release("save-analysis")
    expect(receipt(page)).to_contain_text(saved["id"])
    expect(button(page, "Retry private analyses")).to_be_visible()
    expect(button(page, "Save version")).to_be_enabled()
    checks.check("Accepted private save settles independently of ledger refresh", saved["id"] in workspace(page).inner_text())
    fixture.defaults.clear(); button(page, "Retry private analyses").click()
    view(page, "Journal")
    generated = forecast(GOLD, "daily", 2)
    fixture.expect_action("/api/market-research/journal/generate", {"instrumentId": GOLD, "horizon": "daily"}, {"forecast": generated, "reused": False}, hold="generate", after_fail=("journal:" + GOLD,))
    button(page, "Daily scenario").click()
    until(page, lambda: "generate" in fixture.held, "Generation request not held")
    expect(button(page, "Daily scenario")).to_be_disabled()
    expect(button(page, "Weekly scenario")).to_be_disabled()
    fixture.release("generate")
    expect(receipt(page)).to_contain_text(generated["id"])
    expect(button(page, "Retry forecast journal")).to_be_visible()
    expect(button(page, "Daily scenario")).to_be_focused()
    expect(button(page, "Daily scenario")).to_be_enabled()
    checks.check("Accepted forecast and focus survive independent failed journal read", generated["id"] in receipt(page).inner_text())
    fixture.defaults.clear(); button(page, "Retry forecast journal").click()
    fixture.expect_action("/api/market-research/journal/generate", {"instrumentId": GOLD, "horizon": "weekly"}, {})
    button(page, "Weekly scenario").click()
    expect(workspace(page).get_by_role("alert")).to_contain_text("No new effect receipt was confirmed")
    expect(receipt(page)).to_contain_text(generated["id"])
    checks.check("Malformed successful HTTP response cannot replace prior accepted effect", True)
    fixture.expect_action("/api/market-research/journal/score", {"instrumentId": GOLD, "maxForecasts": 2}, {"outcomes": [outcome(GOLD)]}, after_fail=("journal:" + GOLD,))
    button(page, "Score due").click()
    expect(receipt(page)).to_contain_text("1 scoring outcome receipts returned")
    expect(button(page, "Retry forecast journal")).to_be_visible()
    returned = receipt(page).locator("summary")
    returned.click()
    checks.check("Score receipt preserves exact returned forecast/outcome identities without inventing an instrument echo", outcome()["id"] in receipt(page).inner_text() and outcome()["forecastId"] in receipt(page).inner_text())
    fixture.defaults.clear(); button(page, "Retry forecast journal").click()


def empty_and_disposal(page, fixture, checks, coarse):
    fixture.empty = True
    view(page, "Journal"); refresh(page, fixture)
    expect(workspace(page).get_by_text("No frozen forecasts yet", exact=True)).to_be_visible()
    checks.check(("phone" if coarse else "desktop") + ": a successful empty journal alone establishes zero counts", "0 resolved · 0 due" in workspace(page).inner_text())
    fixture.empty = False
    if not coarse:
        generated = forecast(GOLD, "weekly", 3)
        fixture.expect_action("/api/market-research/journal/generate", {"instrumentId": GOLD, "horizon": "weekly"}, {"forecast": generated, "reused": False}, hold="disposed-effect")
        button(page, "Weekly scenario").click()
        until(page, lambda: "disposed-effect" in fixture.held, "Disposal effect not held")
    else:
        fixture.plan("journal:" + GOLD, {"error": "LATE_READ_MUST_NOT_APPEAR"}, 503, "disposed-read")
        refresh(page, fixture)
        until(page, lambda: "disposed-read" in fixture.held, "Disposal read not held")
    navigation = page.get_by_role("navigation", name="Everyday workspace navigation" if coarse else "Application navigation", exact=True)
    navigation.get_by_role("link", name="Assistant", exact=True).click()
    expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
    before = len(fixture.requests)
    if not coarse:
        checks.check("Unmount disposes the chart adapter", page.evaluate("() => (window.marketChartCalls||[]).some(x=>x.kind==='remove')"))
    fixture.release("disposed-read" if coarse else "disposed-effect")
    page.wait_for_timeout(150)
    expect(workspace(page)).to_have_count(0)
    checks.check(("phone" if coarse else "desktop") + ": disposed response cannot trigger new Markets reads or restore UI", len(fixture.requests) == before and "LATE_READ_MUST_NOT_APPEAR" not in page.locator("body").inner_text())


def exercise(browser, origin, credentials, checks, coarse):
    label, errors = ("phone" if coarse else "desktop"), []
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, timezone_id="UTC", has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture, page = None, None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        fixture = MarketFixtures(origin, max_effects=10 if not coarse else 0)
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        # Compile and hydrate the existing destination before holding a Markets
        # response; disposal checks should not depend on cold dev compilation.
        navigate(page, origin, "/app/command")
        expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
        initial_and_chart(page, fixture, checks, label)
        visual_views(page, fixture, checks, coarse)
        if not coarse:
            read_lifecycle(page, fixture, checks)
            queue_lifecycle(page, fixture, checks)
            analysis_and_journal(page, fixture, checks)
        empty_and_disposal(page, fixture, checks, coarse)
        checks.check(label + ": all declared bounded effects consumed locally", not fixture.actions)
        checks.check(label + ": no unexpected request, popup, download or real effect", not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "reads": fixture.requests, "writes": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / f"{label}-failure.png"), full_page=False)
            (checks.output / f"{label}-failure-dom.html").write_text(page.content())
        if fixture:
            (checks.output / f"{label}-failure-requests.json").write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "pendingActions": list(fixture.actions), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        if fixture:
            fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/markets")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks, contexts, failure = Checks(args.output, args.axe.resolve()), [], None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True):
                    contexts.append(exercise(browser, origin, credentials, checks, coarse))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print("Markets browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure, "boundary": "Actual /app/markets route and isolated login; all five views and private context use bounded synthetic GETs. At most 10 declared Markets POSTs on desktop and zero on phone, all locally fulfilled with exact payload/idempotency assertions; no provider/model/job/replay/journal/private-analysis effect reaches the server. Labelled chart adapter checks host theme/save/disposal only, not licensed TradingView rendering. Server authorization/ownership and analytical correctness remain separate unit/route suites."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
