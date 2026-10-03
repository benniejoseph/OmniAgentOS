#!/usr/bin/env python3
"""Actual Responsibility list/detail/edit/review/lifecycle UI with synthetic intercepted effects."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import quote
from playwright.sync_api import expect, sync_playwright
from run import Checks, REPO, navigate, preview, select_theme
from responsibilities_fixtures import ResponsibilityFixtures, ID, UNTRUSTED


def root(page): return page.get_by_test_id("responsibilities-workspace")
def button(page, name): return root(page).get_by_role("button", name=name, exact=True)
def notifications(page): return root(page).locator("section[aria-labelledby='responsibility-notifications-heading']")
def settle(page): page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def wait_held(page, fixture, name):
    for _ in range(100):
        if name in fixture.held: return
        page.wait_for_timeout(20)
    raise AssertionError("Fixture request did not reach its held boundary: " + name)


def exercise_notifications(page, fixture, checks, label, coarse):
    panel = notifications(page)
    expect(panel.get_by_text("Not enabled", exact=True)).to_be_visible()
    checks.check(label + ": saved request and pilot activation do not enable inbox delivery", fixture.notification_current is None)
    button(page, "Review in-app notification delivery").click()
    expect(panel.get_by_role("heading", name="Exact inbox delivery review", exact=True)).to_be_visible()
    expect(button(page, "Enable exact in-app notifications")).to_be_disabled()
    panel.get_by_label("I reviewed the exact owner, source, configuration, runtime revision and generation, finite limit, expiry and owner inbox destination.", exact=True).check()
    fixture.notification_write_hold = "enable-outstanding"
    # Both handlers can observe the same pre-render state; the shared controller
    # must still admit only the first explicit action synchronously.
    button(page, "Enable exact in-app notifications").evaluate("el => { const pause = [...document.querySelectorAll('button')].find(x => x.textContent === 'Pause responsibility'); el.click(); pause.click(); }")
    wait_held(page, fixture, "enable-outstanding")
    expect(button(page, "Pause responsibility")).to_be_disabled()
    expect(root(page).get_by_label("Purpose", exact=True)).to_be_disabled()
    checks.check(label + ": one synchronous action slot spans enable and lifecycle", len([item for item in fixture.mutations if item["body"]["action"] == "enable"]) == 1 and not any(item["body"]["action"] == "pause" for item in fixture.mutations))
    fixture.release("enable-outstanding")
    expect(button(page, "Retry exact submitted request")).to_be_visible()
    button(page, "Retry exact submitted request").click()
    expect(root(page).get_by_text(re.compile(r"Recovered immutable receipt · enable"))).to_be_visible()
    expect(panel.get_by_text(re.compile(r"In-app notification history unavailable\..*Synthetic notification history unavailable"))).to_be_visible()
    expect(root(page).get_by_role("heading", name="Accepted receipt", exact=True)).to_be_focused()
    calls = [item for item in fixture.mutations if item["body"]["action"] == "enable"]
    checks.check(label + ": lost enable response recovers exact key/body and preserves receipt/focus on failed GET", len(calls) == 2 and calls[0] == calls[1] and len(fixture.notification_receipts) == 1)
    fixture.fail_notification_refresh = False; button(page, "Refresh in-app notifications").click()
    expect(panel.get_by_text("enabled", exact=True)).to_be_visible()
    expect(panel.get_by_text("No notification candidates were returned in this bounded history.", exact=True)).to_be_visible()
    checks.check(label + ": enable has finite allowance and no historical backfill", fixture.notification_current["configuration"]["maximumNotifications"] == 2 and fixture.notification_current["used"] == 0 and not fixture.notification_candidates)
    fixture.notification_candidate("first"); fixture.notification_transition("held")
    button(page, "Refresh in-app notifications").click()
    expect(panel.get_by_text("held", exact=True)).to_be_visible()
    expect(panel.get_by_text(re.compile(r"Delivery is not confirmed\."))).to_be_visible()
    checks.check(label + ": quiet hold keeps reservation without claiming delivery", fixture.notification_current["reserved"] == 1 and fixture.notification_current["used"] == 0 and fixture.notification_candidates[0]["notificationId"] is None)
    fixture.notification_transition("delivered"); button(page, "Refresh in-app notifications").click()
    source = panel.get_by_role("link", name="Open notification source", exact=True)
    expect(source).to_have_attribute("href", "/app/responsibilities/" + quote(ID, safe=""))
    expect(panel.get_by_text("Confirmed in the Asael inbox by the recorded delivery receipt.", exact=True)).to_be_visible()
    checks.check(label + ": confirmed delivery exposes exact inbox receipt and permanent source", fixture.notification_current["used"] == 1 and fixture.notification_current["reserved"] == 0 and fixture.notification_candidates[0]["deliveryBindingSha256"] is not None)
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse); settle(page); checks.snapshot(page, "responsibility-inbox-" + label + "-" + theme, coarse)
    fixture.notification_read_mode = "malformed"; button(page, "Refresh in-app notifications").click()
    expect(panel.get_by_text(re.compile(r"In-app notification history unavailable\..*could not be verified"))).to_be_visible()
    expect(source).to_be_visible(); expect(button(page, "Stop in-app notifications")).to_be_disabled()
    checks.check(label + ": malformed read retains last confirmed delivery and count", panel.get_by_text("Confirmed in the Asael inbox by the recorded delivery receipt.", exact=True).count() == 1)
    button(page, "Refresh in-app notifications").click(); expect(button(page, "Stop in-app notifications")).to_be_enabled()
    fixture.notification_candidate("second"); fixture.notification_transition("held"); button(page, "Refresh in-app notifications").click()
    expect(panel.get_by_text("held", exact=True)).to_be_visible()
    button(page, "Stop in-app notifications").click(); expect(button(page, "Retry exact submitted request")).to_be_visible()
    button(page, "Retry exact submitted request").click()
    expect(root(page).get_by_text(re.compile(r"Recovered immutable receipt · stop"))).to_be_visible()
    expect(panel.get_by_text(re.compile(r"In-app notification history unavailable\..*Synthetic notification history unavailable"))).to_be_visible()
    calls = [item for item in fixture.mutations if item["body"]["action"] == "stop"]
    checks.check(label + ": exact stop recovery cancels hold once and preserves delivered use", len(calls) == 2 and calls[0] == calls[1] and fixture.notification_current["used"] == 1 and fixture.notification_current["reserved"] == 0 and fixture.notification_candidates[0]["reason"] == "owner_stopped")
    fixture.fail_notification_refresh = False; button(page, "Refresh in-app notifications").click()
    expect(panel.get_by_text("Stopped by owner", exact=True)).to_be_visible(); expect(button(page, "Stop in-app notifications")).to_be_disabled()
    expect(button(page, "Enable exact in-app notifications")).to_be_disabled()
    checks.check(label + ": notification stop leaves runtime active and cannot reset allowance", fixture.current["state"] == "active" and fixture.notification_current["generation"] == 2)


def exercise(browser, origin, credentials, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture = None; page = None; errors = []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90000)
        checks.check(label + ": isolated authenticated owner", login.ok)
        fixture = ResponsibilityFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        context.route("**/*", fixture.route)
        page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/responsibilities")
        expect(root(page).get_by_role("heading", name="Recent responsibilities", exact=True)).to_be_visible()
        root(page).get_by_role("link").filter(has_text="Prepare a bounded meeting brief").click()
        expect(root(page).get_by_role("heading", name="Saved draft and review", exact=True)).to_be_visible()
        checks.check(label + ": exact full-identity detail route", quote(ID, safe="") in page.url or ID in page.url)
        expect(root(page).get_by_text(UNTRUSTED, exact=False)).to_be_visible()
        checks.check(label + ": private reference labels remain text", not page.evaluate("Boolean(window.responsibilityUntrustedRan)"))
        expect(root(page).get_by_text("Inactive", exact=True)).to_be_visible()
        expect(button(page, "Activate this exact pilot")).to_have_count(0)
        checks.check(label + ": complete draft alone has no activation claim", True)
        fixture.sources_unavailable = True; button(page, "Refresh available references").click()
        expect(root(page).get_by_text("sources are unavailable; availability could not be checked.", exact=True)).to_be_visible()
        checks.check(label + ": unavailable sources retain exact selected identity", root(page).get_by_role("button", name="Remove source " + fixture.source["id"], exact=True).count() == 1)
        fixture.sources_unavailable = False; button(page, "Refresh available references").click()
        purpose = root(page).get_by_label("Purpose", exact=True)
        purpose.fill("Edited purpose retained until saved")
        button(page, "Refresh saved draft").click()
        expect(purpose).to_have_value("Edited purpose retained until saved")
        expect(button(page, "Check exact references for review")).to_be_disabled()
        button(page, "Save inactive draft").click()
        expect(root(page).get_by_role("heading", name="Accepted receipt", exact=True)).to_be_visible()
        expect(button(page, "Check exact references for review")).to_be_enabled()
        button(page, "Check exact references for review").click()
        expect(button(page, "Accept this exact inactive review")).to_be_visible()
        button(page, "Accept this exact inactive review").click()
        expect(root(page).get_by_text(re.compile(r"^Revision 3 · Reviewed"))).to_be_visible()
        checks.check(label + ": draft review pins exact saved revision without activating", fixture.current is None and fixture.record["state"] == "reviewed")
        button(page, "Review exact pilot activation").click()
        expect(button(page, "Activate this exact pilot")).to_be_disabled()
        root(page).get_by_label("I reviewed this finite meeting pilot, its exact configuration, and the absence of notification or mutation authority.", exact=True).check()
        button(page, "Activate this exact pilot").click()
        expect(button(page, "Retry exact submitted request")).to_be_visible()
        expect(purpose).to_be_disabled()
        button(page, "Retry exact submitted request").click()
        expect(root(page).get_by_text(re.compile(r"Recovered immutable receipt · activate"))).to_be_visible()
        expect(root(page).get_by_text(re.compile(r"Lifecycle unavailable\. Synthetic refresh unavailable"))).to_be_visible()
        calls = [item for item in fixture.mutations if item["body"]["action"] == "activate"]
        checks.check(label + ": lost activation response recovers one exact receipt", len(calls) == 2 and calls[0] == calls[1] and len(fixture.runtime_receipts) == 1)
        fixture.fail_refresh = False; button(page, "Refresh lifecycle").click()
        expect(button(page, "Pause responsibility")).to_be_enabled()
        exercise_notifications(page, fixture, checks, label, coarse)
        button(page, "Pause responsibility").click()
        expect(root(page).get_by_text("paused", exact=True)).to_be_visible()
        button(page, "Review exact pilot activation").click()
        expect(button(page, "Resume this exact pilot")).to_be_disabled()
        checks.check(label + ": new generation requires fresh exact acknowledgement", True)
        button(page, "End responsibility").click()
        expect(root(page).get_by_text("ended", exact=True)).to_be_visible()
        expect(button(page, "End responsibility")).to_have_count(0)
        checks.check(label + ": end is an exact separately acknowledged lifecycle transition", fixture.current["state"] == "ended" and fixture.current["generation"] == 3)
        expect(root(page).get_by_text(re.compile(r"No accepted baseline"))).to_be_visible()
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse); settle(page); checks.snapshot(page, "responsibility-" + label + "-" + theme, coarse)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 844})
            settle(page)
            checks.snapshot(page, "responsibility-phone-320", coarse)
            page.evaluate("document.documentElement.style.fontSize='200%'")
            settle(page)
            checks.snapshot(page, "responsibility-phone-text-200", coarse)
            checks.check(label + ": responsibility text responds to 200 percent root sizing", root(page).get_by_role("heading", name="Responsibility", exact=True).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)") >= 50)
            page.evaluate("document.documentElement.style.fontSize=''")
            settle(page)
        else:
            page.emulate_media(forced_colors="active"); checks.snapshot(page, "responsibility-forced-colors", coarse); page.emulate_media(forced_colors="none")
        page.keyboard.press("Tab"); button(page, "Refresh saved draft").focus()
        checks.check(label + ": keyboard focus remains visible", button(page, "Refresh saved draft").evaluate("el => document.activeElement === el && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) >= 3"))
        fixture.notification_read_mode = "late-after-leave"; button(page, "Refresh in-app notifications").click(); wait_held(page, fixture, "late-after-leave")
        navigate(page, origin, "/app/responsibilities")
        fixture.release("late-after-leave"); settle(page)
        checks.check(label + ": disposed notification read cannot repopulate the list route", notifications(page).count() == 0)
        button(page, "New responsibility").click(); root(page).get_by_label("Purpose", exact=True).fill("A deliberately incomplete draft")
        button(page, "Create inactive draft").click(); expect(root(page).get_by_role("link", name="Open this responsibility", exact=True)).to_be_visible()
        checks.check(label + ": incomplete draft creates no watcher", fixture.record["draft"]["sources"] == [] and fixture.record["review"] is None)
        checks.check(label + ": no live effects, unexpected traffic or client errors", not fixture.writes and not fixture.unexpected and not errors,
                     {"unexpected": fixture.unexpected, "errors": errors})
        checks.check(label + ": exact bounded synthetic effect count", len(fixture.mutations) == 11 and not fixture.held)
        return {"viewport": label, "reads": fixture.requests, "syntheticMutations": fixture.mutations, "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if fixture is not None:
            (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "syntheticMutations": fixture.mutations, "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        raise
    finally: context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/responsibilities")
    parser.add_argument("--chrome", type=Path); parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve()); contexts = []; failure = None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True): contexts.append(exercise(browser, origin, credentials, checks, coarse))
            finally: browser.close()
    except Exception as error:
        failure = str(error); print("Responsibility browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual web list/detail/draft/review/lifecycle and separately enabled owner inbox presentation using isolated authenticated session. Every Responsibility read and mutation is intercepted; each viewport allows at most 12 exact synthetic effects and expects 11. Includes same-key lost-response recovery, quiet hold, confirmed synthetic inbox receipt, permanent stop, malformed/failed read retention, keyboard focus and disposal. No live activation, scheduler, tools, provider, DB Responsibility write, inbox delivery or external channel. Database authority and concurrent source races belong to separate integration suites. Browser fixtures are not evidence of runtime readiness."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
