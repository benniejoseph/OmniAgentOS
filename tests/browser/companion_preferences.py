#!/usr/bin/env python3
"""Companion Settings with exact, wholly intercepted preference changes.

Uses the shared isolated preview/login. Real application preference writes,
provider/model actions, media, downloads and external requests are blocked.
"""

import argparse
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright

from companion_preferences_fixtures import (
    CompanionFixtures, DEFAULTS, HOME_B, LONG_TITLE, PREFERENCES_PATH, THREADS_PATH, save_body,
)
from run import Checks, REPO, navigate, preview, select_theme

ROOT = '[data-testid="companion-preferences"]'


def workspace(page):
    return page.locator(ROOT)


def until(page, predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def button(page, name):
    return workspace(page).get_by_role("button", name=name, exact=True)


def style(page, name):
    return workspace(page).get_by_role("radio", name=name, exact=True)


def saved_revision(page, revision):
    expect(workspace(page).get_by_text(re.compile(r"^Saved snapshot · revision " + str(revision) + r"(?:\s|$)"))).to_be_visible()


def details(page, prefix, revision):
    summary = workspace(page).locator("summary").filter(has_text=re.compile(r"^" + re.escape(prefix) + " · revision " + str(revision) + r"$"))
    expect(summary).to_be_visible()
    if not summary.evaluate("el=>el.parentElement.open"):
        summary.click()
    return summary.locator("xpath=..")


def receipt(page, revision):
    return details(page, "Confirmed save receipt", revision)


def refresh(page, revision):
    button(page, "Refresh preferences").click()
    saved_revision(page, revision)


def scoped_snapshot(page, checks, name, coarse, heading="Companion preferences"):
    root = workspace(page)
    page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    root.get_by_role("heading", name=heading, exact=True).evaluate("el=>el.scrollIntoView({block:'start'})")
    checks.check(name + ": pointer mode", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    reflow = page.evaluate("""selector => {
      const root = document.querySelector(selector);
      return {viewport:innerWidth, document:document.documentElement.scrollWidth,
        rootClient:root.clientWidth, rootScroll:root.scrollWidth,
        overflow:[...root.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().width && el.scrollWidth>el.clientWidth+1)
          .map(el=>({tag:el.tagName,cls:el.className,client:el.clientWidth,scroll:el.scrollWidth})).slice(0,12)};
    }""", ROOT)
    checks.check(name + ": page and preference reflow", reflow["document"] <= reflow["viewport"] + 1 and reflow["rootScroll"] <= reflow["rootClient"] + 1, reflow)
    checks.check(name + ": control target floor", root.locator("button:visible,select:visible,summary:visible,label:has(input):visible").evaluate_all(
        "(els,minimum)=>els.every(el=>el.getBoundingClientRect().height>=minimum-1)", 48 if coarse else 44))
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    page.add_script_tag(path=str(checks.axe))
    audit = page.evaluate("""async selector => {
      const result = await axe.run(document.querySelector(selector),
        {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
      return {violations:result.violations.map(v=>({id:v.id,impact:v.impact,
        nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
        incomplete:result.incomplete.map(v=>v.id),passes:result.passes.length};
    }""", ROOT)
    (checks.output / (name + "-axe.json")).write_text(json.dumps(audit, indent=2))
    checks.check(name + ": scoped axe", not audit["violations"], audit["violations"])


def isolated_defaults(context, origin, checks, label):
    response = context.request.get(origin + PREFERENCES_PATH, timeout=90_000)
    checks.check(label + ": real isolated Companion GET", response.status == 200)
    body = response.json()
    checks.check(label + ": real unsaved defaults and fallback contract", body == {
        "schemaVersion": 1, "contract": "asael-companion-preferences:1",
        "snapshot": {"revision": 0, "persisted": False, "updatedAt": None, "preferences": DEFAULTS},
        "home": {"state": "not_set", "preferredThreadId": None, "href": None, "fallbackHref": "/app/command"},
        "destination": {"href": "/app/command", "state": "configured"},
    })
    checks.check(label + ": preference read is private/no-store", "private" in response.headers.get("cache-control", "") and "no-store" in response.headers.get("cache-control", ""))
    return {"status": response.status, "revision": body["snapshot"]["revision"]}


def pending_save(page, fixture, checks, label):
    root = workspace(page)
    style(page, "Quiet").check()
    categories = page.get_by_role("navigation", name="Settings categories", exact=True)
    categories.get_by_role("button", name=re.compile(r"^Workspace(?:\s|$)")).click()
    expect(root).to_be_hidden()
    categories.get_by_role("button", name=re.compile(r"^General(?:\s|$)")).click()
    expect(style(page, "Quiet")).to_be_checked()
    checks.check(label + ": General draft survives advanced section navigation", not fixture.writes)

    original = save_body(0, intensity="quiet")
    fixture.expect_patch(original, hold="save-one")
    button(page, "Save preferences").click()
    until(page, lambda: "save-one" in fixture.held, "First save did not reach its exact fixture")
    expect(button(page, "Saving preferences…")).to_be_disabled()
    root.get_by_role("checkbox", name="Show Companion character", exact=True).uncheck()
    expect(button(page, "Retry same submission")).to_be_disabled()
    checks.check(label + ": pending changes preserve the one frozen body and one request", len(fixture.writes) == 1 and fixture.writes[0]["body"] == original)
    fixture.release("save-one")
    saved_revision(page, 1)
    confirmed = receipt(page, 1)
    expect(confirmed.get_by_text("Shown", exact=True)).to_be_visible()
    expect(root.get_by_role("checkbox", name="Show Companion character", exact=True)).not_to_be_checked()
    expect(root.get_by_text(re.compile(r"^Unsaved draft · draft base revision 1"))).to_be_visible()
    checks.check(label + ": confirmed receipt is distinct from edits made while saving", True)
    fixture.plan_read(body={"error": "Synthetic preference refresh unavailable."}, status=503)
    button(page, "Refresh preferences").click()
    expect(root.get_by_text("Preferences could not be verified. The last loaded values and your draft are retained.", exact=True)).to_be_visible()
    expect(root.get_by_text(re.compile(r"^Last loaded snapshot · revision 1"))).to_be_visible()
    expect(receipt(page, 1)).to_be_visible()
    expect(root.get_by_role("checkbox", name="Show Companion character", exact=True)).not_to_be_checked()
    checks.check(label + ": failed follow-up GET cannot erase accepted receipt or draft", True)
    refresh(page, 1)


def uncertain_replay_and_conflict(page, fixture, checks, label):
    root = workspace(page)
    original = save_body(1, intensity="quiet", visible=False)
    fixture.expect_patch(original, drop=True)
    button(page, "Save preferences").click()
    expect(root.get_by_text("Save not confirmed.", exact=False)).to_be_visible()
    expect(root.get_by_role("heading", name="Unconfirmed submission", exact=True)).to_be_visible()
    first = fixture.writes[-1]
    style(page, "Off").check()
    fixture.advance(intensity="expressive", visible=True, motion="reduced", defaultDestination="activity")
    refresh(page, 3)
    expect(root.get_by_role("heading", name="Unconfirmed submission", exact=True)).to_be_visible()
    expect(button(page, "Save preferences")).to_be_disabled()
    expect(style(page, "Quiet")).to_be_checked()
    expect(style(page, "Off")).to_be_checked()
    fixture.expect_patch(original, key=first["idempotencyKey"])
    button(page, "Retry same submission").click()
    saved_revision(page, 3)
    old_receipt = receipt(page, 2)
    expect(old_receipt.get_by_text("Original submission replay confirmed", exact=False)).to_be_visible()
    expect(old_receipt.get_by_text("This receipt precedes the current saved revision 3; it does not replace that newer snapshot.", exact=True)).to_be_visible()
    current = details(page, "Current saved values", 3)
    expect(current.get_by_text("Expressive", exact=True)).to_be_visible()
    expect(current.get_by_text("Activity", exact=True)).to_be_visible()
    checks.check(label + ": uncertain retry reuses byte-identical body/key and retains newer snapshot",
                 fixture.writes[-1]["serializedBody"] == first["serializedBody"] and fixture.writes[-1]["idempotencyKey"] == first["idempotencyKey"])
    expect(style(page, "Quiet")).to_be_checked()
    expect(style(page, "Off")).to_be_checked()
    button(page, "Keep draft against current revision").click()
    fixture.advance(defaultDestination="work")
    conflict_body = save_body(3, intensity="quiet", visible=False, motion="off")
    fixture.expect_patch(conflict_body)
    button(page, "Save preferences").click()
    expect(root.get_by_text("Saved preferences changed. Refresh, then review your draft against the current revision.", exact=True)).to_be_visible()
    expect(style(page, "Quiet")).to_be_checked()
    expect(style(page, "Off")).to_be_checked()
    expect(root.get_by_role("checkbox", name="Show Companion character", exact=True)).not_to_be_checked()
    expect(receipt(page, 2)).to_be_visible()
    refresh(page, 4)
    button(page, "Keep draft against current revision").click()
    checks.check(label + ":409 keeps full draft and prior receipt until explicit rebase", fixture.writes[-1]["status"] == 409)


def choose_home(page, fixture, checks, label, coarse):
    root = workspace(page)
    button(page, "Choose conversation").click()
    expect(root.get_by_text("2 selectable conversations in this window · 3 unsupported or unverified rows omitted", exact=True)).to_be_visible()
    expect(root.get_by_text(re.compile("(FOREIGN_ACTOR|FOREIGN_TENANT|UNSUPPORTED_ID)_MUST_NOT_APPEAR"))).to_have_count(0)
    picker = root.locator("#companion-conversation-picker")
    search = picker.get_by_role("searchbox", name="Find a conversation in this list", exact=True)
    search.fill("full readable")
    expect(picker.get_by_role("radio")).to_have_count(1)
    picker.get_by_role("radio", name=re.compile(re.escape(HOME_B))).check()
    expect(picker.get_by_text(LONG_TITLE, exact=True)).to_be_visible()
    picker.get_by_role("button", name="Clear search", exact=True).click()
    expect(picker.get_by_role("radio", name=re.compile(re.escape(HOME_B)))).to_be_checked()
    fixture.plan_read(THREADS_PATH, body={"error": "Synthetic list unavailable."}, status=503)
    button(page, "Refresh conversations").click()
    expect(root.get_by_text("Conversation choices could not be checked. Any last loaded rows remain read only until a successful refresh.", exact=True)).to_be_visible()
    expect(picker.get_by_role("radio", name=re.compile(re.escape(HOME_B)))).to_be_disabled()
    button(page, "Refresh conversations").click()
    expect(picker.get_by_role("radio", name=re.compile(re.escape(HOME_B)))).to_be_enabled()
    scoped_snapshot(page, checks, f"companion-{label}-owned-picker", coarse, "Preferred home conversation")
    button(page, "Close picker").click()
    expect(button(page, "Choose conversation")).to_be_focused()
    expected = save_body(4, intensity="quiet", visible=False, motion="off", preferredThreadId=HOME_B)
    fixture.expect_patch(expected)
    button(page, "Save preferences").click()
    saved_revision(page, 5)
    expect(receipt(page, 5).get_by_text(HOME_B, exact=True)).to_be_visible()
    expect(root.get_by_text("Available to this account", exact=True)).to_be_visible()
    fixture.home_available = False
    refresh(page, 5)
    expect(root.get_by_text("Unavailable to this account; Assistant is the fallback", exact=True)).to_be_visible()
    expect(root.locator("code").filter(has_text=re.compile("^" + HOME_B + "$"))).to_have_count(4)
    checks.check(label + ": saved home deletion/inaccessibility keeps exact identity and revision", fixture.revision == 5)


def reset_and_discard(page, fixture, checks, label):
    root = workspace(page)
    reset = button(page, "Reset preferences")
    reset.click()
    button(page, "Keep editing").click()
    expect(reset).to_be_focused()
    before = len(fixture.writes)
    checks.check(label + ": reset preview/cancel causes no write", before == 5)
    reset.click()
    fixture.expect_patch({"action": "reset", "expectedRevision": 5})
    button(page, "Confirm reset").click()
    saved_revision(page, 6)
    expect(style(page, "Quiet")).to_be_focused()
    expect(style(page, "Balanced")).to_be_checked()
    expect(style(page, "Full")).to_be_checked()
    expect(root.get_by_role("checkbox", name="Show Companion character", exact=True)).to_be_checked()
    expect(root.get_by_role("combobox", name="Default destination", exact=True)).to_have_value("assistant")
    expect(receipt(page, 6).get_by_text("None", exact=True)).to_be_visible()
    style(page, "Quiet").check()
    discard = button(page, "Use saved preferences")
    discard.click()
    button(page, "Keep editing").click()
    expect(discard).to_be_focused()
    discard.click()
    button(page, "Replace draft").click()
    expect(style(page, "Quiet")).to_be_focused()
    expect(style(page, "Balanced")).to_be_checked()
    expect(button(page, "Save preferences")).to_be_disabled()
    checks.check(label + ": local discard restores saved values/focus without a write", len(fixture.writes) == before + 1)


def disposal(page, origin, fixture, checks, label):
    root = workspace(page)
    fixture.plan_read(hold="unmounted-read")
    button(page, "Refresh preferences").click()
    until(page, lambda: "unmounted-read" in fixture.held, "Dispose read not held")
    navigate(page, origin, "/app/activity")
    expect(root).to_have_count(0)
    fixture.release("unmounted-read")
    expect(root).to_have_count(0)
    navigate(page, origin, "/app/settings")
    saved_revision(page, 6)
    expect(root.locator("summary").filter(has_text="Confirmed save receipt")).to_have_count(0)
    style(page, "Expressive").check()
    fixture.expect_patch(save_body(6, intensity="expressive"), hold="unmounted-save")
    button(page, "Save preferences").click()
    until(page, lambda: "unmounted-save" in fixture.held, "Dispose save not held")
    navigate(page, origin, "/app/activity")
    fixture.release("unmounted-save")
    expect(root).to_have_count(0)
    navigate(page, origin, "/app/settings")
    saved_revision(page, 7)
    expect(style(page, "Expressive")).to_be_checked()
    expect(root.locator("summary").filter(has_text="Confirmed save receipt")).to_have_count(0)
    checks.check(label + ": disposed read/save cannot revive local state; remount uses GET without inventing a receipt", len(fixture.writes) == 7)


def exercise(browser, origin, credentials, checks, coarse):
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture, page, errors, effects = None, None, [], []
    label = "phone" if coarse else "desktop"
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        real = isolated_defaults(context, origin, checks, label)
        session = context.request.get(origin + "/api/auth/session", timeout=90_000).json()
        fixture = CompanionFixtures(origin, session["context"]["tenantId"], session["context"]["actorId"])
        fixture.plan_read(body={"error": "Synthetic initial preference read unavailable."}, status=503, hold="initial")
        context.route("**/*", fixture.route)
        context.expose_binding("__recordCompanionEffect", lambda _source, kind: effects.append(kind))
        context.add_init_script("""window.__companionEffects=[]; window.untrustedContentRan=false;
          const blockedEffect=kind=>{window.__companionEffects.push(kind); void window.__recordCompanionEffect(kind);};
          if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>{
            blockedEffect('microphone'); throw Error('Device action blocked'); };
          window.open=()=>{blockedEffect('window'); return null;};
          HTMLMediaElement.prototype.play=async()=>{blockedEffect('playback'); throw Error('Playback blocked');};""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/settings")
        expect(workspace(page)).to_be_visible(timeout=30_000)
        until(page, lambda: "initial" in fixture.held, "Initial preferences read was not held")
        expect(workspace(page).get_by_text("Loading Companion preferences…", exact=True)).to_be_visible()
        expect(workspace(page).get_by_role("radio")).to_have_count(0)
        fixture.release("initial")
        expect(workspace(page).get_by_text("Preferences have not been loaded.", exact=True)).to_be_visible()
        expect(workspace(page).get_by_role("radio")).to_have_count(0)
        checks.check(label + ": initial failure never fabricates saved defaults", not fixture.writes)
        button(page, "Retry preferences").click()
        saved_revision(page, 0)
        expect(style(page, "Balanced")).to_be_checked()
        expect(style(page, "Full")).to_be_checked()
        expect(workspace(page).get_by_text("Reduced · device reduction applies", exact=True)).to_be_visible()
        expect(button(page, "Save preferences")).to_be_disabled()
        checks.check(label + ": unsaved defaults are read only until edited; OS reduction is a floor", not fixture.writes)
        style(page, "Quiet").focus()
        page.keyboard.press("ArrowRight")
        expect(style(page, "Balanced")).to_be_focused()
        checks.check(label + ": keyboard focus uses the canonical three-pixel outline", style(page, "Balanced").evaluate("el=>getComputedStyle(el).outlineWidth==='3px'"))
        pending_save(page, fixture, checks, label)
        uncertain_replay_and_conflict(page, fixture, checks, label)
        choose_home(page, fixture, checks, label, coarse)
        reset_and_discard(page, fixture, checks, label)
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            scoped_snapshot(page, checks, f"companion-{label}-{theme}", coarse)
        if not coarse:
            page.set_viewport_size({"width": 320, "height": 900})
            scoped_snapshot(page, checks, "companion-320", False)
            page.set_viewport_size({"width": 1440, "height": 900})
            page.evaluate("document.documentElement.style.fontSize='200%'")
            scoped_snapshot(page, checks, "companion-text-200", False)
            page.evaluate("document.documentElement.style.fontSize=''")
            page.emulate_media(forced_colors="active")
            scoped_snapshot(page, checks, "companion-forced-colors", False)
            page.emulate_media(forced_colors="none")
        disposal(page, origin, fixture, checks, label)
        checks.check(label + ": previews never request audio, device, popup or execution", not effects and page.evaluate("window.untrustedContentRan") is False, effects)
        isolated_defaults(context, origin, checks, label + " after fixtures")
        checks.check(label + ": only seven declared preference PATCH attempts and no unexpected actions", len(fixture.writes) == 7 and not fixture.actions and not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "realRoute": real, "requests": fixture.requests, "writes": fixture.writes,
                "heldReleases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors, "blockedMediaAttempts": effects}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"requests": fixture.requests if fixture else [],
            "writes": fixture.writes if fixture else [], "held": list(fixture.held) if fixture else [],
            "unexpected": fixture.unexpected if fixture else [], "errors": errors}, indent=2))
        raise
    finally:
        if fixture is not None:
            fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/companion-preferences")
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
        print(f"Companion browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated login and read-only default endpoint. All seven per-viewport preference PATCH attempts are exact synthetic fulfill/drop fixtures; every other application write and external action is blocked. Durable persistence, native adoption and production character rendering are outside this browser evidence."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
