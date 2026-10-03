#!/usr/bin/env python3
"""Read-only Activity navigation, window paging and resource-state checks.

Uses the real isolated login and Assistant → Activity navigation. All browser
application mutations and external requests are blocked by the fixture layer.
"""

import argparse
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

from activity_fixtures import ACTIVITY_PATH, GROUPS, LABELS, LONG_ID, ActivityFixtures, rows
from run import Checks, REPO, navigate, preview, select_theme


def workspace(page):
    return page.get_by_test_id("activity-workspace")


def navigation(page, coarse):
    return page.get_by_role("navigation", name="Everyday workspace navigation" if coarse else "Application navigation", exact=True)


def until(page, predicate, label, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(label)


def enter_activity(page, coarse):
    navigation(page, coarse).get_by_role("link", name="Activity", exact=True).click()
    expect(page).to_have_url(re.compile(r"/app/activity$"), timeout=30_000)
    expect(workspace(page)).to_be_visible()
    expect(navigation(page, coarse).get_by_role("link", name="Activity", exact=True)).to_have_attribute("aria-current", "page")


def filter_button(page, group):
    return workspace(page).get_by_role("group", name="Activity views", exact=True).get_by_role(
        "button", name=re.compile(r"^" + re.escape(LABELS[group]) + r"(?:\s|$)"))


def ready(page, group="all", count=25):
    root = workspace(page)
    expect(root.locator("#activity-results-title")).to_have_text(LABELS[group])
    expect(root.locator('section[aria-labelledby="activity-results-title"]')).to_have_attribute("aria-busy", "false")
    expect(root.get_by_role("article")).to_have_count(count)
    expect(filter_button(page, group)).to_have_attribute("aria-pressed", "true")


def select_group(page, group, count):
    filter_button(page, group).click()
    ready(page, group, count)


def pager(page, name):
    return workspace(page).get_by_role("navigation", name="Activity pages", exact=True).get_by_role("button", name=name, exact=True)


def range_label(page):
    return workspace(page).locator("#activity-results-title + p")


def identities(page):
    return workspace(page).get_by_role("article").evaluate_all("els=>els.map(el=>el.getAttribute('aria-label'))")


def coverage(page):
    summary = workspace(page).locator("summary").filter(has_text=re.compile(r"^Source coverage ·"))
    if not summary.evaluate("el=>el.parentElement.open"):
        summary.click()
    return summary.locator("xpath=..")


def source_links(page, fixture, checks, label):
    root = workspace(page)
    for item in rows(fixture.version)[:25]:
        article = root.get_by_role("article", name=f"{item['title']}: {item['sourceRef']['id']}", exact=True)
        links = article.get_by_role("link").all()
        expected = urlsplit(item["href"])
        actual = urlsplit(links[0].get_attribute("href"))
        checks.check(label + ": exact source destination " + item["id"],
                     actual.path == expected.path and parse_qs(actual.query) == parse_qs(expected.query))
        if item.get("origin"):
            origin = urlsplit(links[1].get_attribute("href"))
            checks.check(label + ": own origin returns to exact run and conversation",
                         origin.path == "/app/command" and parse_qs(origin.query) == {"thread": ["own-origin-thread"], "run": ["own-origin-run"]})
        if item["source"] == "approvals":
            checks.check(label + ": approval retains Activity return destination", parse_qs(actual.query)["returnTo"] == ["/app/activity"])
    long_row = root.get_by_role("article", name="Agent run: " + LONG_ID, exact=True)
    expect(long_row.locator("code").filter(has_text=re.compile("^" + re.escape(LONG_ID) + "$" )).first).to_have_text(LONG_ID)
    checks.check(label + ": full long opaque identity remains selectable", long_row.locator("code").first.evaluate("el=>getComputedStyle(el).userSelect!=='none'"))
    for identity, expected in (("legacy-completed", "Completed · Unverified outcome"),
                               ("verified-completed", "Completed · Verified outcome"),
                               ("partial-completed", "Completed · Partial outcome")):
        expect(root.get_by_role("article", name="Agent run: " + identity, exact=True).get_by_text(expected, exact=True)).to_be_visible()
    checks.check(label + ": legacy completion stays distinct from verified and partial outcomes", True)


def paging(page, fixture, checks, label):
    root = workspace(page)
    expect(range_label(page)).to_have_text("1–25 of 30 in this window")
    first_ids = identities(page)
    first_cursor = fixture.response()["page"]["nextCursor"]
    pager(page, "Next").click()
    ready(page, count=5)
    expect(root.locator("#activity-results-title")).to_be_focused()
    expect(range_label(page)).to_have_text("26–30 of 30 in this window")
    expect(pager(page, "Next")).to_be_disabled()
    checks.check(label + ": Next returns opaque cursor and focuses newly loaded rows",
                 fixture.requests[-1]["cursor"] == first_cursor and not set(first_ids).intersection(identities(page)))
    pager(page, "Previous").click()
    ready(page)
    expect(root.locator("#activity-results-title")).to_be_focused()
    checks.check(label + ": Previous restores first-page identities", identities(page) == first_ids and fixture.requests[-1]["cursor"] is None)

    fixture.version += 1
    before = len(fixture.requests)
    pager(page, "Next").click()
    ready(page)
    expect(root.get_by_text("Activity changed while you were paging. A new window is shown from its first page.", exact=True)).to_be_visible()
    expect(range_label(page)).to_have_text("1–25 of 30 in this window")
    expect(pager(page, "Previous")).to_be_disabled()
    expect(root.locator("#activity-results-title")).to_be_focused()
    requests = fixture.requests[before:]
    checks.check(label + ": stale cursor409 restarts once at the first page",
                 len(requests) == 2 and requests[0]["cursor"] == first_cursor and requests[1]["cursor"] is None)


def failed_read(page, fixture, checks, name, *, body, status=200, expected="Activity returned an incomplete response. Refresh to try again."):
    before = identities(page)
    fixture.plan(body=body, status=status)
    workspace(page).get_by_role("button", name="Refresh activity", exact=True).click()
    expect(workspace(page).get_by_text(expected, exact=True)).to_be_visible()
    expect(range_label(page)).to_have_text("Last loaded: 1–25 of 30 in this window")
    checks.check(name + ": failed read retains exact rows and last-loaded counts", identities(page) == before)
    workspace(page).get_by_role("button", name="Retry activity", exact=True).click()
    ready(page)
    expect(workspace(page).get_by_role("button", name="Retry activity", exact=True)).to_have_count(0)
    checks.check(name + ": GET retry recovers", fixture.requests[-1]["cursor"] is None)


def read_states(page, fixture, checks):
    failed_read(page, fixture, checks, "HTTP failure", body={"error": "Synthetic Activity refresh failed."}, status=503,
                expected="Synthetic Activity refresh failed.")
    malformed = fixture.response()
    malformed["items"][0]["sourceRef"]["kind"] = ["run"]
    failed_read(page, fixture, checks, "Coercible enum response", body=malformed)
    malformed = fixture.response()
    legacy = next(item for item in malformed["items"] if item["sourceRef"]["id"] == "legacy-completed")
    legacy["canonicalStatus"]["status"] = "succeeded"
    failed_read(page, fixture, checks, "Unsupported verified claim", body=malformed)
    expect(workspace(page).get_by_role("article", name="Agent run: legacy-completed", exact=True).get_by_text("Completed · Unverified outcome", exact=True)).to_be_visible()
    failed_read(page, fixture, checks, "All sources unavailable", body=fixture.response(mode="unavailable"),
                expected="All Activity sources are unavailable. The last loaded rows and counts are retained.")

    fixture.version += 1
    fixture.plan(body={"error": "Synthetic replacement window unavailable."}, status=503)
    retained = identities(page)
    pager(page, "Next").click()
    expect(workspace(page).get_by_text("The previous window expired and its replacement could not be loaded.", exact=False)).to_be_visible()
    checks.check("Expired window plus failed replacement keeps old rows explicit", identities(page) == retained)
    workspace(page).get_by_role("button", name="Retry activity", exact=True).click()
    ready(page)

    fixture.mode = "partial"
    workspace(page).get_by_role("button", name="Refresh activity", exact=True).click()
    count = len(fixture.response()["items"])
    ready(page, count=count)
    source = coverage(page)
    expect(source.get_by_text("Access is restricted.", exact=True)).to_be_visible()
    expect(source.get_by_text("Source could not be checked.", exact=True)).to_be_visible()
    checks.check("Partial coverage keeps missing source counts unavailable", source.get_by_text("Count unavailable.", exact=True).count() == 2)
    select_group(page, "updates", 0)
    expect(workspace(page).get_by_text("No matching records were returned by the readable sources. Incomplete sources may contain other activity.", exact=True)).to_be_visible()
    fixture.mode = "ready"
    select_group(page, "all", 25)


def filter_races(page, fixture, checks, coarse):
    poisoned = fixture.response("working")
    poisoned["items"][0]["summary"] = "STALE_FILTER_RESPONSE_MUST_NOT_APPEAR"
    fixture.plan("working", hold="old-working", body=poisoned)
    filter_button(page, "working").click()
    until(page, lambda: "old-working" in fixture.held, "Working read was not held")
    fixture.plan("needs_you", hold="old-needs-you", body={"error": "STALE_FILTER_ERROR_MUST_NOT_APPEAR"}, status=503)
    filter_button(page, "needs_you").click()
    until(page, lambda: "old-needs-you" in fixture.held, "Needs-you read was not held")
    filter_button(page, "working").click()
    ready(page, "working", 8)
    fixture.release("old-working")
    fixture.release("old-needs-you")
    page.wait_for_timeout(150)
    ready(page, "working", 8)
    expect(filter_button(page, "working")).to_be_focused()
    expect(workspace(page).get_by_text(re.compile("STALE_FILTER_(RESPONSE|ERROR)_MUST_NOT_APPEAR"))).to_have_count(0)
    checks.check("Rapid Working → Needs you → Working fences old success and error replies without focus theft", True)

    fixture.plan("history", hold="unmounted-history")
    filter_button(page, "history").click()
    until(page, lambda: "unmounted-history" in fixture.held, "Unmount read was not held")
    before = len(fixture.requests)
    navigation(page, coarse).get_by_role("link", name="Assistant", exact=True).click()
    expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
    expect(workspace(page)).to_have_count(0)
    fixture.release("unmounted-history")
    page.wait_for_timeout(100)
    checks.check("Unmount suppresses stale Activity state and extra reads", len(fixture.requests) == before and workspace(page).count() == 0)
    enter_activity(page, coarse)
    ready(page)
    checks.check("Navigation remount starts a fresh All activity window", fixture.requests[-1]["group"] == "all" and fixture.requests[-1]["cursor"] is None)


def real_empty_read(context, origin, checks, label):
    response = context.request.get(origin + ACTIVITY_PATH + "?group=all&limit=25", timeout=90_000)
    checks.check(label + ": real isolated Activity route responds", response.status == 200)
    body = response.json()
    checks.check(label + ": real local route exposes only an empty bounded window",
                 body.get("contract") == "asael-activity:1" and body.get("items") == [] and
                 body.get("window") == {"bounded": True, "limitPerSource": 100} and
                 body.get("page") == {"limit": 25, "nextCursor": None, "hasMore": False})
    checks.check(label + ": real response is private and uncached", "private" in response.headers.get("cache-control", "") and "no-store" in response.headers.get("cache-control", ""))
    return {"status": response.status, "state": body.get("state"), "coverage": body.get("coverage")}


def exercise(browser, origin, credentials, checks, coarse):
    fixture = ActivityFixtures(origin)
    errors, label = [], "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page = None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        actual = real_empty_read(context, origin, checks, label)
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        initial = fixture.response(mode="unavailable") if coarse else {"error": "Synthetic initial Activity read failed."}
        fixture.plan(hold="initial-read", body=initial, status=200 if coarse else 503)
        navigate(page, origin, "/app/command")
        expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
        enter_activity(page, coarse)
        until(page, lambda: "initial-read" in fixture.held, "Initial Activity read was not held")
        checks.check(label + ": first pending read shows unavailable counts, not zero", workspace(page).get_by_text("Count unavailable", exact=True).count() >= 5 and "0–0" not in workspace(page).inner_text())
        fixture.release("initial-read")
        expect(workspace(page).get_by_role("heading", name="Activity is unavailable", exact=True)).to_be_visible()
        checks.check(label + ": failed/unavailable initial read stays distinct from empty", workspace(page).get_by_text("Count unavailable", exact=True).count() >= 5 and "No activity in this window" not in workspace(page).inner_text())
        workspace(page).get_by_role("button", name="Refresh activity", exact=True).click()
        ready(page)
        source_links(page, fixture, checks, label)
        source = coverage(page)
        checks.check(label + ": bounded source coverage names all three sources", all(source.get_by_text(name, exact=True).is_visible() for name in ("Your runs", "Authorized approvals", "Your reminders")))
        for group in GROUPS:
            expected = fixture.response(group)
            select_group(page, group, len(expected["items"]))
            checks.check(label + ": grouped filter " + group, fixture.requests[-1]["group"] == group and fixture.requests[-1]["cursor"] is None)
        select_group(page, "all", 25)
        paging(page, fixture, checks, label)
        if not coarse:
            read_states(page, fixture, checks)
            filter_races(page, fixture, checks, coarse)
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            checks.snapshot(page, f"activity-{label}-{theme}", coarse)
        checks.check(label + ": Activity target-size floor", workspace(page).locator("button:visible,a:visible").evaluate_all(
            "(els,minimum)=>els.every(el=>el.getBoundingClientRect().height>=minimum-1)", 48 if coarse else 44))
        fixture.mode = "empty"
        navigation(page, coarse).get_by_role("link", name="Assistant", exact=True).click()
        expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
        enter_activity(page, coarse)
        ready(page, count=0)
        expect(workspace(page).get_by_role("heading", name="No activity in this window", exact=True)).to_be_visible()
        expect(range_label(page)).to_have_text("0–0 of 0 in this window")
        checks.check(label + ": successful empty read establishes zero in the bounded window", workspace(page).get_by_text("Count unavailable", exact=True).count() == 0)
        checks.check(label + ": no application writes or unexpected requests", not fixture.writes and not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "realRoute": actual, "requests": fixture.requests,
                "heldReleases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / f"{label}-failure.png"), full_page=False)
            (checks.output / f"{label}-failure-dom.html").write_text(page.content())
        (checks.output / f"{label}-failure-requests.json").write_text(json.dumps({"requests": fixture.requests,
            "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/activity")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve())
    contexts, failure = [], None
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
        print(f"Activity browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts,
            "failure": failure, "boundary": "Real isolated login and empty local GET route; actual Assistant→Activity navigation; synthetic bounded reads thereafter. No application effects. Source destinations are inspected as links; destination action controllers are outside this suite."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
