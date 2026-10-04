#!/usr/bin/env python3
"""Real isolated access/demo/fallback views with synthetic credential submissions.

Error-boundary retry wiring is covered by the actual component unit tests. This
suite does not fake a React boundary or claim that local examples verify work.
"""

import argparse
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, parse_qsl, quote, urlsplit

from playwright.sync_api import expect, sync_playwright

from access_recovery_fixtures import ANONYMOUS, EMAIL, PASSWORD, AccessFixtures
from run import Checks, REPO, navigate, preview, select_theme

DEEP_LINK = "/app/command?thread=11111111-1111-4111-8111-111111111111&view=notes%20today"
LONG_ERROR = "Synthetic account unavailable: " + "review-reference-" * 22


def until(page, predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def settle(page):
    page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")


def login(page, origin, query=""):
    navigate(page, origin, "/login" + query)
    expect(page.get_by_role("heading", level=1)).to_have_text("Welcome back")


def theme(page, color, coarse):
    select_theme(page, color, coarse)
    settle(page)


def snapshot(page, checks, label, coarse):
    settle(page)
    floor = 48 if coarse else 44
    targets = page.locator("body").evaluate("""body=>[...body.querySelectorAll('a,button,input,summary')]
      .filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(el).visibility!=='hidden'&&!el.closest('nextjs-portal')})
      .map(el=>({name:el.getAttribute('aria-label')||el.textContent.trim()||el.getAttribute('name'),height:el.getBoundingClientRect().height}))""")
    checks.check(label + ": 44/48px targets", all(row["height"] >= floor - 1 for row in targets), targets)
    checks.check(label + ": one primary heading", page.get_by_role("heading", level=1).count() == 1)
    checks.snapshot(page, label, coarse)


def credentials(page):
    page.get_by_label("Email address", exact=True).fill(EMAIL)
    page.get_by_label("Password", exact=True).fill(PASSWORD)


def demo_cases(page, origin, fixture, checks, label):
    navigate(page, origin, "/demo")
    expect(page.get_by_role("heading", level=1)).to_have_text("Explore a sample agent workflow.")
    expect(page.locator('[data-public-header="flow"]')).to_be_visible()
    before = (len(fixture.reads), len(fixture.writes))
    demo = page.get_by_test_id("demo-workspace")
    demo.get_by_role("button", name="Start walkthrough", exact=True).click()
    expect(demo.get_by_role("status")).to_have_text("Viewing step 1 of 5")
    expect(demo.get_by_role("button", name="Previous step", exact=True)).to_be_disabled()
    for number in range(2, 6):
        demo.get_by_role("button", name="Next step", exact=True).click()
        expect(demo.get_by_role("status")).to_have_text(f"Viewing step {number} of 5")
    expect(demo.get_by_role("button", name="Next step", exact=True)).to_be_disabled()
    expect(demo.get_by_text("Last step of the walkthrough. No work was executed or verified.", exact=True)).to_be_visible()
    group = demo.get_by_role("group", name="Simulation steps", exact=True)
    group.get_by_role("button", name="Tools", exact=True).focus()
    page.keyboard.press("Enter")
    expect(group.get_by_role("button", name="Tools", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(demo.get_by_text("There is no approval request here.", exact=False)).to_be_visible()
    demo.get_by_role("button", name="Previous step", exact=True).click()
    expect(demo.get_by_role("status")).to_have_text("Viewing step 3 of 5")
    demo.get_by_role("button", name="Restart walkthrough", exact=True).click()
    expect(demo.get_by_role("status")).to_have_text("Viewing step 1 of 5")
    checks.check(label + ": simulation selection/restart has no API reads or effects", before == (len(fixture.reads), len(fixture.writes)))
    checks.check(label + ": sample labels never claim live verification", "Not performed" in demo.inner_text() and "Fictional" in demo.inner_text())
    page.get_by_role("link", name="Skip to demo", exact=True).focus()
    page.keyboard.press("Enter")
    expect(demo).to_be_focused()
    checks.check(label + ": demo skip target receives focus", True)


def login_read_cases(page, origin, fixture, checks, label, coarse):
    fixture.plan_session(real=True)
    page.context.set_extra_http_headers({"x-asael-return-path": "/app/security?spoofed=1"})
    navigate(page, origin, DEEP_LINK)
    page.context.set_extra_http_headers({})
    expect(page.get_by_role("heading", level=1)).to_have_text("Welcome back")
    parsed = urlsplit(page.url)
    returned = parse_qs(parsed.query).get("next", [])
    expected = urlsplit(DEEP_LINK)
    destination = urlsplit(returned[0]) if len(returned) == 1 else None
    # Next may serialize query spaces as + instead of %20; assert every decoded
    # value in order, not a particular equivalent transport encoding.
    checks.check(label + ": anonymous private route preserves requested path/query values, ignoring supplied header",
                 parsed.path == "/login" and destination is not None and
                 destination.path == expected.path and not destination.netloc and
                 parse_qsl(destination.query, keep_blank_values=True) == parse_qsl(expected.query, keep_blank_values=True), page.url)
    checks.check(label + ": real isolated session remains anonymous", page.get_by_test_id("login-form").is_visible())

    fixture.plan_session({"error": "Synthetic session unavailable."}, status=503, hold="initial")
    login(page, origin)
    until(page, lambda: any(name.startswith("initial") for name in fixture.held), "Initial session read was not held")
    expect(page.get_by_text("Checking existing session.", exact=True)).to_be_visible()
    credentials(page)
    fixture.release("initial")
    expect(page.get_by_text("Session status is unavailable. You can still try signing in.", exact=True)).to_be_visible()
    expect(page.get_by_label("Email address", exact=True)).to_have_value(EMAIL)
    expect(page.get_by_label("Password", exact=True)).to_have_value(PASSWORD)
    fixture.plan_session({**ANONYMOUS, "googleLoginConfigured": True})
    page.get_by_role("button", name="Retry", exact=True).click()
    expect(page.get_by_role("link", name="Continue with Google", exact=True)).to_be_visible()
    expect(page.get_by_label("Email address", exact=True)).to_have_value(EMAIL)
    checks.check(label + ": session retry retains credential draft", True)

    reveal = page.get_by_role("button", name="Show password", exact=True)
    reveal.click()
    expect(page.get_by_label("Password", exact=True)).to_have_attribute("type", "text")
    expect(page.get_by_role("button", name="Hide password", exact=True)).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="Hide password", exact=True).click()
    expect(page.get_by_label("Password", exact=True)).to_have_attribute("type", "password")
    page.get_by_label("Email address", exact=True).focus()
    ring = page.get_by_label("Email address", exact=True).evaluate("el=>({width:getComputedStyle(el).outlineWidth,offset:getComputedStyle(el).outlineOffset})")
    checks.check(label + ": input focus stays visible", ring == {"width": "3px", "offset": "3px"}, ring)
    page.get_by_role("link", name="Skip to sign in", exact=True).focus()
    page.keyboard.press("Enter")
    expect(page.locator("#main-content")).to_be_focused()

    exact = "/app/results/agent%3Arun%2Fopaque.v2?view=evidence#section-one"
    login(page, origin, "?next=" + quote(exact, safe="") + "&google=denied")
    expect(page.get_by_test_id("login-form").get_by_role("alert")).to_have_text("Google sign-in was canceled.")
    google = page.get_by_role("link", name="Continue with Google", exact=True)
    checks.check(label + ": OAuth link preserves validated encoded identity/query/hash without invoking it",
                 parse_qs(urlsplit(google.get_attribute("href")).query).get("next") == [exact])
    login(page, origin, "?next=" + quote("https://outside.invalid/app", safe="") + "&google=failed")
    expect(page.get_by_test_id("login-form").get_by_role("alert")).to_have_text("Google sign-in could not be verified. Choose an approved Personal or Work account and try again.")
    expect(page.get_by_role("link", name="Continue with Google", exact=True)).to_have_attribute("href", "/api/auth/google/authorize")
    checks.check(label + ": invalid external next never becomes provider return destination", True)

    fixture.plan_session({"authEnabled": False, "authenticated": False, "googleLoginConfigured": False})
    navigate(page, origin, "/login?next=" + quote(DEEP_LINK, safe=""))
    expect(page.get_by_role("heading", level=1)).to_have_text("Local development mode")
    expect(page.get_by_role("link", name="Open workspace", exact=True)).to_have_attribute("href", DEEP_LINK)
    checks.check(label + ": synthetic local-mode entry retains explicit app destination without bypassing server auth", True)

    # Observe the authenticated display while its destination read is held, then
    # dispose before the bounded preference fallback can navigate. No cookie is set.
    fixture.plan_session({"authEnabled": True, "authenticated": True, "googleLoginConfigured": False})
    fixture.preferences["hold"] = "entry"
    page.goto(origin + "/login", wait_until="domcontentloaded")
    expect(page.get_by_role("heading", level=1)).to_have_text("Opening your workspace")
    until(page, lambda: any(name.startswith("entry") for name in fixture.held), "Entry destination was not held")
    navigate(page, origin, "/demo")
    fixture.release("entry")
    fixture.preferences.pop("hold", None)
    expect(page).to_have_url(origin + "/demo")
    checks.check(label + ": disposed authenticated entry read does not redirect a different page", True)
    fixture.plan_session()

    navigate(page, origin, "/signup")
    expect(page).to_have_url(origin + "/login")
    navigate(page, origin, "/onboarding")
    expect(page).to_have_url(re.compile(re.escape(origin) + r"/login\?next="))
    checks.check(label + ": private signup/onboarding redirects remain enforced", True)

    if not coarse:
        fixture.plan_session(hold="session-timeout")
        login(page, origin)
        expect(page.get_by_text("Session status is unavailable. You can still try signing in.", exact=True)).to_be_visible(timeout=20_000)
        fixture.release("session-timeout")
        fixture.plan_session()
        page.get_by_role("button", name="Retry", exact=True).click()
        expect(page.get_by_text("Session status is unavailable.", exact=False)).to_have_count(0)
        checks.check(label + ": held session GET reaches its bounded retry state", True)


def login_write_cases(page, origin, fixture, checks):
    fixture.plan_session()
    login(page, origin)
    credentials(page)
    cases = [
        ({"message": LONG_ERROR}, 401, LONG_ERROR),
        ({"message": "Ignored rate-limit detail"}, 429, "Too many sign-in attempts. Try again shortly."),
        ({"message": {"private": "Malformed detail"}}, 503, "Sign-in is unavailable. Try again shortly."),
        ({}, 200, "Sign-in could not be confirmed. Check your session before trying again."),
    ]
    for body, status, expected in cases:
        fixture.plan_login(body, status=status)
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_test_id("login-form").get_by_role("alert")).to_have_text(expected)
        expect(page.get_by_label("Email address", exact=True)).to_have_value(EMAIL)
        expect(page.get_by_label("Password", exact=True)).to_have_value(PASSWORD)
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_enabled()
        checks.check(f"desktop: synthetic login {status} response is truthful and retains draft", True)
        if expected == LONG_ERROR:
            viewport = page.viewport_size
            page.set_viewport_size({"width": 320, "height": 844})
            snapshot(page, checks, "desktop-login-long-error-320", False)
            page.locator("html").evaluate("el=>el.style.fontSize='200%'")
            snapshot(page, checks, "desktop-login-long-error-320-text200", False)
            page.locator("html").evaluate("el=>el.style.fontSize=''")
            page.set_viewport_size(viewport)
            settle(page)

    fixture.plan_login({"message": "Synthetic pending rejection."}, hold="pending")
    before = len(fixture.writes)
    # Real submit events in the same JavaScript turn check the synchronous slot.
    page.get_by_test_id("login-form").evaluate("form=>{form.requestSubmit();form.requestSubmit()}")
    until(page, lambda: "pending" in fixture.held, "Pending login was not held")
    expect(page.get_by_role("button", name="Signing in", exact=True)).to_be_disabled()
    expect(page.get_by_test_id("login-form")).to_have_attribute("aria-busy", "true")
    page.get_by_label("Email address", exact=True).fill("edited-draft@example.test")
    fixture.release("pending")
    expect(page.get_by_test_id("login-form").get_by_role("alert")).to_have_text("Synthetic pending rejection.")
    expect(page.get_by_label("Email address", exact=True)).to_have_value("edited-draft@example.test")
    checks.check("desktop: one admitted frozen login request and later draft retained", len(fixture.writes) == before + 1)
    credentials(page)

    fixture.plan_login({"authenticated": True}, status=200, hold="disposed-login")
    page.get_by_role("button", name="Sign in", exact=True).click()
    until(page, lambda: "disposed-login" in fixture.held, "Disposable login was not held")
    navigate(page, origin, "/demo")
    fixture.release("disposed-login")
    expect(page).to_have_url(origin + "/demo")
    expect(page.get_by_test_id("demo-workspace")).to_be_visible()
    checks.check("desktop: late synthetic success cannot revive disposed sign-in or navigate", True)

    login(page, origin)
    credentials(page)
    fixture.plan_login({"authenticated": True}, status=200, hold="login-timeout")
    page.get_by_role("button", name="Sign in", exact=True).click()
    until(page, lambda: "login-timeout" in fixture.held, "Timeout login was not held")
    expect(page.get_by_test_id("login-form").get_by_role("alert")).to_have_text("Sign-in could not be confirmed in time. Check your session before trying again.", timeout=35_000)
    expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_enabled()
    fixture.release("login-timeout")
    expect(page).to_have_url(origin + "/login")
    checks.check("desktop: timeout releases local controls without inventing authentication or cancellation", True)


def exercise(browser, origin, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture = AccessFixtures(origin)
    errors, effects = [], []
    page = None
    context.route("**/*", fixture.route)
    context.expose_binding("__accessEffect", lambda _source, kind: effects.append(kind))
    context.add_init_script("""const stop=kind=>{void window.__accessEffect(kind);throw Error('Effect blocked: '+kind)};
      if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>stop('microphone');
      HTMLMediaElement.prototype.play=async()=>stop('playback');
      window.open=()=>stop('popup');""")
    try:
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("download", lambda _download: effects.append("download"))
        page.on("popup", lambda _popup: effects.append("popup"))
        login_read_cases(page, origin, fixture, checks, label, coarse)
        if not coarse:
            login_write_cases(page, origin, fixture, checks)
        demo_cases(page, origin, fixture, checks, label)
        fixture.plan_session({**ANONYMOUS, "googleLoginConfigured": True})
        for color in ("light", "dark"):
            login(page, origin)
            theme(page, color, coarse)
            snapshot(page, checks, f"{label}-login-{color}", coarse)
            navigate(page, origin, "/demo")
            snapshot(page, checks, f"{label}-demo-{color}", coarse)
            navigate(page, origin, "/offline")
            expect(page.get_by_role("heading", level=1)).to_have_text("You are offline.")
            expect(page.get_by_text("same account and workspace", exact=False)).to_be_visible()
            expect(page.get_by_text("cannot confirm your queue", exact=False)).to_be_visible()
            expect(page.get_by_role("link", name="Try again", exact=True)).to_have_attribute("href", "/app")
            checks.check(label + ": offline view avoids promising a complete offline workspace", "full workspace is not available offline" in page.locator("main").inner_text())
            snapshot(page, checks, f"{label}-offline-{color}", coarse)
            navigate(page, origin, "/this-page-does-not-exist-access-fixture")
            expect(page.get_by_role("heading", level=1)).to_have_text("This address has no page")
            expect(page).to_have_title("Page not found | Asael")
            expect(page.get_by_role("link", name="Open workspace", exact=True)).to_have_attribute("href", "/app")
            snapshot(page, checks, f"{label}-not-found-{color}", coarse)
        page.get_by_role("link", name="Open workspace", exact=True).click()
        expect(page.get_by_role("heading", level=1)).to_have_text("Welcome back")
        checks.check(label + ": 404 workspace exit retains private authentication boundary", urlsplit(page.url).path == "/login")

        # Readable unavailable state at 320px and 200% text in both viewports.
        fixture.plan_session({"error": "Synthetic session unavailable."}, status=503)
        login(page, origin, "?google=failed")
        expect(page.get_by_text("Session status is unavailable.", exact=False)).to_be_visible()
        page.set_viewport_size({"width": 320, "height": 844})
        snapshot(page, checks, label + "-login-320", coarse)
        page.locator("html").evaluate("el=>el.style.fontSize='200%'")
        snapshot(page, checks, label + "-login-320-text200", coarse)
        page.locator("html").evaluate("el=>el.style.fontSize=''")
        page.emulate_media(forced_colors="active")
        snapshot(page, checks, label + "-login-forced-colors", coarse)
        page.emulate_media(forced_colors="none")
        navigate(page, origin, "/demo")
        page.get_by_role("group", name="Simulation steps", exact=True).get_by_role("button", name="Evidence", exact=True).click()
        snapshot(page, checks, label + "-demo-evidence-320", coarse)
        page.locator("html").evaluate("el=>el.style.fontSize='200%'")
        snapshot(page, checks, label + "-demo-evidence-320-text200", coarse)
        page.locator("html").evaluate("el=>el.style.fontSize=''")
        checks.check(label + ": reduced motion keeps the walkthrough static", page.get_by_test_id("demo-workspace").evaluate("el=>[el,...el.querySelectorAll('*')].every(node=>getComputedStyle(node).animationName==='none')"))
        checks.check(label + ": no undeclared API/provider/external effects", not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": exact synthetic credential count", len(fixture.writes) == (0 if coarse else 7), fixture.writes)
        checks.check(label + ": all synthetic submissions consumed", not fixture.login_plans)
        checks.check(label + ": no microphone/playback/popup/download effects", not effects, effects)
        checks.check(label + ": no browser errors", not errors, errors)
        return {"viewport": label, "reads": fixture.reads, "writes": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected}
    except Exception:
        if page:
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
        (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.reads, "writes": fixture.writes, "unexpected": fixture.unexpected, "errors": errors, "effects": effects}, indent=2))
        raise
    finally:
        fixture.abort_held()
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/access-recovery")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve())
    contexts, failure = [], None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True):
                    # Each independent viewport gets a bounded compiler lifetime.
                    # Retaining both complete route passes in one webpack dev
                    # server can trigger Next's memory-threshold restart midway
                    # through a navigation; never retry or weaken that assertion.
                    preview_output = args.output / ("preview-phone" if coarse else "preview-desktop")
                    preview_output.mkdir(parents=True, exist_ok=True)
                    with preview(preview_output) as (origin, _credentials):
                        contexts.append(exercise(browser, origin, checks, coarse))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print(f"Access and recovery check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated public/access routes and anonymous server redirects. Initial real isolated session reads per viewport; all other declared session/preferences reads synthetic. Exactly seven desktop credential POSTs fully intercepted, zero phone submissions, no authenticated cookie or application write forwarded. Demo is local simulation. OAuth, external requests, devices, playback, popups and downloads blocked. Actual error/loading components have focused unit coverage; browser coverage does not claim forced React-boundary activation, successful real sign-in, or service-worker/offline-outbox integration."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
