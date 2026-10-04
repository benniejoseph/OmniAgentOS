#!/usr/bin/env python3
"""Read-only legacy Mission history on the actual authenticated routes.

All Mission responses are bounded local fixtures. No legacy execution, review,
tool, provider, schedule or evidence destination is invoked by this suite.
"""

import argparse
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright
from missions_fixtures import A, B, C, ARTIFACT, LONG, LITERAL, MissionFixtures, detail, mission, replacement_session
from run import Checks, REPO, navigate, preview, select_theme


def area(page):
    return page.get_by_test_id("mission-history")


def button(page, name):
    return area(page).get_by_role("button", name=name, exact=True)


def record(page):
    return area(page).get_by_role("region", name="Mission record", exact=True)


def until(page, predicate, message):
    deadline = time.monotonic() + 20
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def settle(page):
    page.evaluate("() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")


def row(page, mid):
    return area(page).locator(f'a[href^="/app/missions/{mid}?"]')


def select(page, mid):
    row(page, mid).click()
    expect(row(page, mid)).to_have_attribute("aria-current", "page")


def ready_record(page, title=None):
    expect(record(page).get_by_role("heading", name=title or mission()["title"], exact=True)).to_be_visible(timeout=30_000)
    expect(record(page).get_by_role("heading", name="Tasks and decisions", exact=True)).to_be_visible()
    expect(button(page, "Refresh mission record")).to_be_enabled()


def count(fixture, key):
    return sum(item["key"] == key for item in fixture.requests)


def initial_reads(page, fixture, checks, label):
    fixture.defaults["list"] = {"body": {"error": "Synthetic history unavailable"}, "status": 503, "hold": "initial"}
    navigate(page, fixture.origin, "/app/missions?legacy=1&keep=exact")
    until(page, lambda: bool(fixture.held), "Initial read did not start")
    expect(area(page).get_by_text("History counts are unavailable until the first confirmed read.", exact=True)).to_be_visible()
    checks.check(label + ": initial pending history does not invent zero or no history", "No historical missions" not in area(page).inner_text())
    fixture.defaults.pop("list")
    fixture.release_prefix("initial")
    expect(button(page, "Retry history list")).to_be_visible()
    checks.check(label + ": initial failed history is unavailable rather than empty", "No historical missions" not in area(page).inner_text())
    button(page, "Retry history list").click()
    expect(row(page, A)).to_be_visible()
    expect(area(page).get_by_role("heading", name="Historical missions", exact=True)).to_be_focused()
    checks.check(label + ": list is bounded and archive controls are read only", "At most 50 are read" in area(page).inner_text() and area(page).get_by_role("button", name=re.compile(r"^(Create|Run|Cancel|Approve|Start|Archive) ")).count() == 0)
    expect(area(page).get_by_role("link", name="Back to Work", exact=True)).to_have_attribute("href", "/app/projects?view=execution")
    select(page, A)
    ready_record(page)
    expect(area(page).get_by_role("heading", name="Mission record", exact=True)).to_be_focused()
    checks.check(label + ": canonical source completion stays unverified and unknown cost remains unknown", "Closed · unverified" in record(page).inner_text() and "Cost unavailable" in record(page).inner_text() and "Verified success" not in record(page).inner_text())
    expect(record(page).get_by_role("link", name="Open recorded agent result", exact=True)).to_have_attribute("href", "/app/results?run=history-run-exact")
    checks.check(label + ": exact Work project/item identities are inspectable", "mission_project:" + A in record(page).inner_text() and "mission_root:" + A in record(page).inner_text())


def display_and_navigation(page, fixture, checks, label, coarse):
    task = record(page).locator("summary").filter(has_text="Reviewed historical task")
    task.click()
    evidence = record(page).locator("summary").filter(has_text="Public evidence · " + ARTIFACT)
    evidence.click()
    expect(record(page).locator("pre:visible").filter(has_text=LITERAL)).to_have_count(1)
    checks.check(label + ": source markup remains literal", page.evaluate("window.untrustedMissionRan") is not True and LITERAL in record(page).inner_text())
    expect(record(page).get_by_role("link", name="Open evidence source (new tab)", exact=True)).to_have_attribute("href", "https://example.test/evidence?id=" + LONG)
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse)
        settle(page)
        checks.snapshot(page, f"{label}-{theme}-mission-history", coarse)
    page.keyboard.press("Tab")
    button(page, "Refresh history").focus()
    checks.check(label + ": keyboard focus is explicit and visible", button(page, "Refresh history").evaluate("el=>document.activeElement===el && el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth)>=3 && getComputedStyle(el).outlineStyle!=='none'"))
    page.evaluate("document.documentElement.style.fontSize='200%'")
    settle(page)
    checks.snapshot(page, label + "-text200", coarse)
    page.evaluate("document.documentElement.style.fontSize=''")
    if coarse:
        page.set_viewport_size({"width": 320, "height": 844})
        settle(page)
        checks.snapshot(page, "phone320-mission-history", True)
        page.set_viewport_size({"width": 390, "height": 844})
    settle(page)
    field = area(page).get_by_role("searchbox", name="Search loaded history", exact=True)
    field.fill("Readable")
    expect(row(page, A)).to_have_count(0)
    expect(row(page, B)).to_be_visible()
    checks.check(label + ": local filters preserve exact selected history and unrelated query", "keep=exact" in page.url and "q=Readable" in page.url and mission()["title"] in record(page).inner_text())
    field.fill("")
    area(page).get_by_role("combobox", name="Recorded Work status", exact=True).select_option("unverified")
    expect(row(page, B)).to_have_count(0)
    area(page).get_by_role("combobox", name="Recorded Work status", exact=True).select_option("all")
    before_detail, before_events = count(fixture, "detail:" + B), count(fixture, "events:" + B + ":0")
    select(page, B)
    expect(record(page).get_by_text("Only the readable summary is available.", exact=False)).to_be_visible()
    checks.check(label + ": readable summary does not authorize detailed records or events", count(fixture, "detail:" + B) == before_detail and count(fixture, "events:" + B + ":0") == before_events)
    page.go_back()
    ready_record(page)
    checks.check(label + ": browser history restores selected record", "/missions/" + A in page.url)
    button(page, "Close mission record").click()
    expect(area(page).get_by_role("heading", name="Historical missions", exact=True)).to_be_focused()
    checks.check(label + ": close preserves explicit legacy entry and query", "/missions?" in page.url and "legacy=1" in page.url and "keep=exact" in page.url)
    navigate(page, fixture.origin, "/app/missions/" + C + "?returnTo=%2Fapp%2Fresults%3Frun%3Dexact&keep=bookmark")
    ready_record(page, mission(C)["title"])
    checks.check(label + ": bookmark outside bounded list is independently re-proven", count(fixture, "summary:" + C) > 0 and row(page, C).count() == 0)
    expect(area(page).get_by_role("link", name="Back to Results", exact=True)).to_have_attribute("href", "/app/results?run=exact")


def failures_and_pages(page, fixture, checks):
    navigate(page, fixture.origin, "/app/missions/" + A + "?legacy=1&keep=exact")
    ready_record(page)
    fixture.defaults["list"] = {"body": {"error": "Synthetic partial history failure"}, "status": 503}
    button(page, "Refresh history").click()
    expect(button(page, "Retry history list")).to_be_visible()
    expect(row(page, A)).to_be_visible()
    expect(record(page).get_by_role("heading", name="Tasks and decisions", exact=True)).to_be_visible()
    checks.check("List failure preserves rows, counts and independently confirmed detail", "Last loaded: 2 matching of 2" in area(page).inner_text())
    fixture.defaults["list"] = {"body": {"missions": [], "requestReadContracts": {"missions": "exact_v1"}}, "status": 200}
    button(page, "Retry history list").click()
    expect(button(page, "Retry history list")).to_be_enabled()
    expect(row(page, A)).to_be_visible()
    checks.check("Malformed200 does not become an empty history", "No historical missions" not in area(page).inner_text())
    fixture.defaults.pop("list")
    button(page, "Retry history list").click()
    expect(button(page, "Retry history list")).to_have_count(0)
    fixture.defaults["detail:" + A] = {"body": {"error": "Synthetic detail failure"}, "status": 503}
    button(page, "Refresh mission record").click()
    expect(button(page, "Retry detailed history")).to_be_visible()
    checks.check("Independent detail failure retains last loaded tasks and evidence", "Last loaded detail: 1 tasks, 1 attempts and 1 evidence records" in record(page).inner_text())
    fixture.defaults.pop("detail:" + A)
    button(page, "Retry detailed history").click()
    expect(button(page, "Retry detailed history")).to_have_count(0)
    expect(area(page).get_by_role("heading", name="Mission record", exact=True)).to_be_focused()
    fixture.defaults["events:" + A + ":0"] = {"body": {"error": "Synthetic event failure"}, "status": 503}
    button(page, "Refresh events").click()
    expect(button(page, "Retry event history")).to_be_visible()
    checks.check("Event failure leaves detailed evidence intact", record(page).get_by_role("heading", name="Evidence and handoffs", exact=True).is_visible())
    fixture.defaults.pop("events:" + A + ":0")
    button(page, "Retry event history").click()
    expect(button(page, "Next event page")).to_be_enabled()
    button(page, "Next event page").click()
    expect(record(page).get_by_text("mission.recorded.26", exact=True)).to_be_visible()
    expect(record(page).get_by_text("mission.recorded.1", exact=True)).to_have_count(0)
    expect(area(page).get_by_role("heading", name="Recorded events", exact=True)).to_be_focused()
    expect(button(page, "Next event page")).to_be_disabled()
    checks.check("Event pagination uses the server cursor without fabricating a total", count(fixture, "events:" + A + ":25") > 0)
    button(page, "Previous event page").click()
    expect(record(page).get_by_text("mission.recorded.1", exact=True)).to_be_visible()


def races_and_disposal(page, fixture, checks):
    select(page, B)
    expect(record(page).get_by_role("heading", name=mission(B)["title"], exact=True)).to_be_visible()
    fixture.defaults["summary:" + A] = {"body": {"mission": mission(A, "OLD_HELD_RECORD"), "requestReadContracts": {"missionSummary": "readable_v1"}}, "status": 200, "hold": "old-a"}
    select(page, A)
    until(page, lambda: any(key.startswith("old-a") for key in fixture.held), "Old A summary was not held")
    select(page, B)
    expect(record(page).get_by_role("heading", name=mission(B)["title"], exact=True)).to_be_visible()
    fixture.defaults.pop("summary:" + A)
    fixture.titles[A] = "NEW_CURRENT_RECORD"
    select(page, A)
    ready_record(page, "NEW_CURRENT_RECORD")
    fixture.release_prefix("old-a")
    settle(page)
    checks.check("Held A to B to A cannot replace the current record", "OLD_HELD_RECORD" not in area(page).inner_text() and "NEW_CURRENT_RECORD" in record(page).inner_text())
    fixture.defaults["list"] = {"body": {"missions": [], "requestReadContracts": {"missions": "readable_v1"}}, "status": 200, "hold": "hidden-list"}
    button(page, "Refresh history").click()
    until(page, lambda: "hidden-list" in fixture.held, "Hidden read not held")
    page.evaluate("() => {window.historyTestVisibility='hidden';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.historyTestVisibility});document.dispatchEvent(new Event('visibilitychange'));}")
    fixture.release_prefix("hidden-list")
    expect(row(page, A)).to_be_visible()
    fixture.defaults.pop("list")
    page.evaluate("() => {window.historyTestVisibility='visible';document.dispatchEvent(new Event('visibilitychange'));}")
    expect(button(page, "Refresh history")).to_be_enabled()
    checks.check("Hidden read is canceled and visible recovery retains authority", row(page, A).count() == 1)
    fixture.defaults["summary:" + B] = {"body": {"mission": mission(B), "requestReadContracts": {"missionSummary": "readable_v1"}}, "status": 200, "hold": "disposed"}
    select(page, B)
    until(page, lambda: "disposed" in fixture.held, "Disposal summary not held")
    page.get_by_role("link", name="Assistant", exact=True).first.click()
    expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
    before = len(fixture.requests)
    fixture.release_prefix("disposed")
    settle(page)
    checks.check("Unmount prevents follow-up detail/events after late summary", len(fixture.requests) == before and area(page).count() == 0)
    fixture.defaults.pop("summary:" + B)


def mounted_session_replacement(page, fixture, checks, session):
    # A single document hosts both replacements. Every change goes through the
    # real provider refresh control and a held /api/auth/session response.
    original_url = fixture.origin + "/app/missions/" + A + "?legacy=1&q=history&status=all&keep=mounted&returnTo=%2Fapp%2Factivity"
    fixture.titles[A] = "Private initial history"
    fixture.missions = [mission(A, fixture.titles[A]), mission(B)]
    navigate(page, fixture.origin, original_url.removeprefix(fixture.origin))
    ready_record(page, fixture.titles[A])
    page.evaluate("window.__missionMountedDocument = 'same-document-owner-and-role'")
    current_session = replacement_session(session)
    for name, held_kind in (("canonical owner", "summary"), ("role", "detail")):
        previous_title = "Private " + name + " history"
        previous_task = "Private " + name + " task evidence"
        fixture.missions = [mission(A, previous_title), mission(B)]
        previous_detail = detail(A, previous_title)
        previous_detail["tasks"][0]["title"] = previous_task
        fixture.defaults["summary:" + A] = {"body": {"mission": mission(A, previous_title), "requestReadContracts": {"missionSummary": "readable_v1"}}, "status": 200}
        fixture.defaults["detail:" + A] = {"body": previous_detail, "status": 200}
        button(page, "Refresh history").click()
        expect(row(page, A)).to_contain_text(previous_title)
        button(page, "Refresh mission record").click()
        ready_record(page, previous_title)
        expect(record(page).locator("summary").filter(has_text=previous_task)).to_be_visible()
        expect(button(page, "Refresh events")).to_be_enabled()

        late_title = "OLD LATE " + name + " history"
        old_read = "mounted-" + held_kind
        old_body = ({"mission": mission(A, late_title), "requestReadContracts": {"missionSummary": "readable_v1"}}
                    if held_kind == "summary" else detail(A, late_title))
        fixture.plan(held_kind + ":" + A, old_body, hold=old_read)
        button(page, "Refresh mission record").click()
        until(page, lambda: old_read in fixture.held, "Old mounted " + held_kind + " was not held")

        if name == "canonical owner":
            next_session = replacement_session(current_session, user_id="77777777-7777-4777-8777-777777777777")
            assert next_session["user"]["id"] != current_session["user"]["id"]
            assert next_session["context"]["actorId"] == current_session["context"]["actorId"]
            assert next_session["membership"]["role"] == current_session["membership"]["role"]
        else:
            next_role = "viewer" if current_session["membership"]["role"] != "viewer" else "operator"
            next_session = replacement_session(current_session, role=next_role)
            assert next_session["user"]["id"] == current_session["user"]["id"]
        session_hold = "mounted-session-" + held_kind
        fixture.plan_session(next_session, hold=session_hold)
        session_reads = len(fixture.session_requests)
        button(page, "Refresh account access").click()
        until(page, lambda: session_hold in fixture.held, "Mounted session refresh was not held")
        expect(page.get_by_text("Checking your workspace permissions.", exact=True)).to_be_visible()
        expect(area(page)).to_have_count(0)
        checks.check("Mounted " + name + ": pending account recheck clears prior private rows and evidence",
                     previous_title not in page.locator("body").inner_text() and previous_task not in page.locator("body").inner_text()
                     and len(fixture.session_requests) == session_reads + 1 and page.url == original_url
                     and page.evaluate("window.__missionMountedDocument") == "same-document-owner-and-role")

        current_title = "Current " + name + " summary history"
        current_summary = mission(A, current_title)
        current_summary.update(detailAvailable=False, manageable=False, runnable=False)
        fixture.defaults["summary:" + A] = {"body": {"mission": current_summary, "requestReadContracts": {"missionSummary": "readable_v1"}}, "status": 200}
        fixture.missions = [mission(B, "Current " + name + " list history")]
        followups_before = (count(fixture, "detail:" + A), count(fixture, "events:" + A + ":0"))
        fixture.session_plan["hold"] = None
        fixture.release_prefix(session_hold)
        expect(record(page).get_by_role("heading", name=current_title, exact=True)).to_be_visible()
        expect(record(page).get_by_text("Only the readable summary is available.", exact=False)).to_be_visible()
        expect(row(page, B)).to_contain_text("Current " + name + " list history")
        expect(row(page, A)).to_have_count(0)
        expect(area(page).get_by_role("searchbox", name="Search loaded history", exact=True)).to_have_value("history")
        expect(area(page).get_by_role("combobox", name="Recorded Work status", exact=True)).to_have_value("all")
        checks.check("Mounted " + name + ": fresh scope reproves the exact bookmark and preserves URL filters",
                     page.url == original_url and previous_title not in area(page).inner_text()
                     and page.evaluate("window.__missionMountedDocument") == "same-document-owner-and-role"
                     and followups_before == (count(fixture, "detail:" + A), count(fixture, "events:" + A + ":0")))

        reads_before_release = len(fixture.requests)
        fixture.release_prefix(old_read)
        settle(page)
        checks.check("Mounted " + name + ": old late " + held_kind + " cannot restore private evidence or start follow-up reads",
                     len(fixture.requests) == reads_before_release and late_title not in area(page).inner_text()
                     and previous_task not in area(page).inner_text() and current_title in record(page).inner_text()
                     and record(page).get_by_role("heading", name="Tasks and decisions", exact=True).count() == 0)
        current_session = next_session
    fixture.defaults.pop("summary:" + A)
    fixture.defaults.pop("detail:" + A)
    fixture.session_plan = None


def empty_and_missing(page, fixture, checks, label):
    fixture.missions = []
    navigate(page, fixture.origin, "/app/missions?legacy=1")
    expect(area(page).get_by_text("No historical missions were returned for this account.", exact=True)).to_be_visible()
    checks.check(label + ": only a confirmed empty read presents zero history", "0 matching of 0 returned missions" in area(page).inner_text())
    fixture.defaults["summary:" + C] = {"body": {}, "status": 200}
    navigate(page, fixture.origin, "/app/missions/" + C)
    expect(button(page, "Retry mission summary")).to_be_visible()
    checks.check(label + ": malformed bookmark read is retryable and never inferred missing", "/app/missions/" + C in page.url)
    fixture.defaults["summary:" + C] = {"body": {"error": "Synthetic missing history"}, "status": 404}
    navigate(page, fixture.origin, "/app/missions/" + C)
    expect(page).to_have_url(re.compile(r"/app/projects\?view=execution$"), timeout=30_000)
    checks.check(label + ": authoritative missing bookmark falls back to Work", True)
    navigate(page, fixture.origin, "/app/missions")
    expect(page).to_have_url(re.compile(r"/app/projects\?view=execution$"), timeout=30_000)
    checks.check(label + ": default alias still opens Work execution", True)


def exercise(browser, origin, credentials, checks, coarse):
    label, errors = ("phone" if coarse else "desktop"), []
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce", timezone_id="UTC")
    fixture, page = MissionFixtures(origin), None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        session_response = context.request.get(origin + "/api/auth/session", timeout=90_000)
        session = replacement_session(session_response.json())
        checks.check(label + ": real isolated session has coherent canonical identity and membership", session_response.ok)
        context.route("**/*", fixture.route)
        context.add_init_script("window.untrustedMissionRan=false")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/command")
        expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
        initial_reads(page, fixture, checks, label)
        display_and_navigation(page, fixture, checks, label, coarse)
        if not coarse:
            failures_and_pages(page, fixture, checks)
            races_and_disposal(page, fixture, checks)
            mounted_session_replacement(page, fixture, checks, session)
        empty_and_missing(page, fixture, checks, label)
        checks.check(label + ": all reads bounded and zero application effects", not fixture.unexpected and not fixture.writes, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "reads": fixture.requests, "sessionReads": fixture.session_requests, "releases": fixture.release_results, "unexpected": fixture.unexpected, "writes": fixture.writes, "errors": errors}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"requests": fixture.requests, "sessionReads": fixture.session_requests, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        fixture.abort_held()
        if page and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/missions")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", type=Path, required=True)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must be an installed local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks, results, failure = Checks(args.output, args.axe.resolve()), [], None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True):
                    results.append(exercise(browser, origin, credentials, checks, coarse))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print("Missions history browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": results, "failure": failure,
            "boundary": "Actual authenticated legacy history routes; bounded synthetic list, summary, detail and event GETs. Two desktop account-access refreshes return coherent synthetic session scopes derived from the real isolated session: canonical UUID replacement with the same actor label/role, then a role-only replacement. These use the mounted provider control without document reload or real account mutation. Zero application effects beyond isolated login. Evidence links inspected without visiting their destinations. Source authorization/RLS and stored historical truth require independent route/store validation. Visibility event uses a deterministic browser override for request cancellation only."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
