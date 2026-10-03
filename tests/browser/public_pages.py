#!/usr/bin/env python3
"""Public/reading templates with synthetic health, no login or application writes.

Covers all nine 4.10 routes. Demo checks only shared header compatibility; its
simulation/controller and the remaining access/recovery pages retain 4.11 scope.
"""

import argparse
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright

from public_pages_fixtures import PublicFixtures, STAMP
from run import Checks, REPO, navigate, preview

ROUTES = [
    ("/", "Give agents goals. Keep the controls.", "Asael — Private AI Agent Arsenal"),
    ("/platform", "Give agents work and review what happens.", "Platform"),
    ("/solutions", "Run multi-step work with explicit review points.", "Solutions"),
    ("/pricing", "No public plans or registration.", "Pricing"),
    ("/security", "Set boundaries for agent actions.", "Security"),
    ("/docs", "How to use Asael.", "How to Use Asael"),
    ("/changelog", "Platform changes and operating notes.", "Changelog"),
    ("/privacy", "Privacy Policy", "Privacy Policy"),
    ("/terms", "Terms of Use", "Terms of Use"),
]
FOOTER_PATHS = {"/platform", "/solutions", "/pricing", "/security", "/docs", "/changelog", "/privacy", "/terms", "/demo"}
ROOT = '[data-testid="public-page"]'


def until(page, predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def settle(page):
    page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")


def theme(page, desired):
    button = page.get_by_role("button", name=re.compile(r"^Theme: "))
    for _ in range(3):
        if button.get_attribute("aria-label").startswith(f"Theme: {desired.title()}."):
            break
        button.click()
    expect(button).to_have_attribute("aria-label", re.compile(rf"^Theme: {desired.title()}\."))
    page.wait_for_function("theme=>document.documentElement.dataset.theme===theme", arg=desired)
    settle(page)


def check_targets(page, checks, label, coarse):
    values = page.locator(ROOT).evaluate("""root=>[...root.querySelectorAll('button,a,summary')]
      .filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(el).visibility!=='hidden'})
      .map(el=>({name:el.textContent.trim()||el.getAttribute('aria-label'),height:el.getBoundingClientRect().height}))""")
    floor = 48 if coarse else 44
    checks.check(label + ": 44/48px navigation and control targets", all(row["height"] >= floor - 1 for row in values), values)


def snapshot(page, checks, label, coarse):
    settle(page)
    check_targets(page, checks, label, coarse)
    checks.snapshot(page, label, coarse)


def health_cases(page, fixture, checks, label):
    health = page.locator('[data-testid="public-health"]')
    expect(health).to_have_attribute("data-status", "healthy")
    fixture.plan_health({"status": "unknown"})
    health.get_by_role("button", name="Refresh status", exact=True).click()
    expect(health.get_by_text("The latest status could not be confirmed.", exact=False)).to_be_visible()
    expect(health.get_by_text("Last reported public health:", exact=False)).to_be_visible()
    checks.check(label + ": malformed read retains clearly labelled last report", health.get_attribute("data-status") == "healthy")
    fixture.plan_health({"status": "unhealthy", "checkedAt": STAMP}, status=503)
    health.get_by_role("button", name="Refresh status", exact=True).click()
    expect(health).to_have_attribute("data-status", "unhealthy")
    fixture.plan_health({"status": "degraded", "checkedAt": STAMP})
    health.get_by_role("button", name="Refresh status", exact=True).click()
    expect(health).to_have_attribute("data-status", "degraded")
    fixture.plan_health({"status": "healthy", "checkedAt": STAMP}, hold="timeout")
    health.get_by_role("button", name="Refresh status", exact=True).click()
    until(page, lambda: any(name.startswith("timeout") for name in fixture.held), "Health request did not enter held fixture")
    expect(health.get_by_role("button", name="Checking status…", exact=True)).to_be_disabled()
    expect(health.get_by_role("button", name="Refresh status", exact=True)).to_be_enabled(timeout=15_000)
    expect(health.get_by_text("The latest status could not be confirmed.", exact=False)).to_be_visible()
    fixture.release("timeout")
    settle(page)
    expect(health).to_have_attribute("data-status", "degraded")
    checks.check(label + ": timed-out read cannot overwrite retained health", True)
    fixture.plan_health({"status": "healthy", "checkedAt": STAMP}, hold="dispose")
    health.get_by_role("button", name="Refresh status", exact=True).click()
    until(page, lambda: any(name.startswith("dispose") for name in fixture.held), "Dispose read was not held")
    page.get_by_role("navigation", name="Public footer", exact=True).get_by_role("link", name="Privacy", exact=True).click()
    expect(page.get_by_role("heading", name="Privacy Policy", exact=True)).to_be_visible()
    fixture.release("dispose")
    expect(page.locator('[data-testid="public-health"]')).to_have_count(0)
    checks.check(label + ": leaving the page disposes health read", True)
    fixture.plan_health({"status": "healthy", "checkedAt": STAMP})


def exercise(browser, origin, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture = PublicFixtures(origin)
    errors, effects = [], []
    page = None
    context.route("**/*", fixture.route)
    context.expose_binding("__publicEffect", lambda _source, kind: effects.append(kind))
    context.add_init_script("""const stop=kind=>{void window.__publicEffect(kind);throw Error('Effect blocked: '+kind)};
      if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>stop('microphone');
      HTMLMediaElement.prototype.play=async()=>stop('playback');
      window.open=()=>stop('popup');""")
    try:
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("download", lambda _download: effects.append("download"))
        page.on("popup", lambda _popup: effects.append("popup"))
        fixture.plan_health({"error": "Synthetic public status unavailable."}, status=503, hold="initial")
        navigate(page, origin, "/")
        until(page, lambda: any(name.startswith("initial") for name in fixture.held), "Initial public health read was not held")
        expect(page.locator('[data-testid="public-health"]')).to_have_attribute("data-status", "checking")
        fixture.release("initial")
        expect(page.locator('[data-testid="public-health"]')).to_have_attribute("data-status", "unavailable")
        checks.check(label + ": initial unavailable never looks empty or healthy", True)
        fixture.plan_health({"status": "healthy", "checkedAt": STAMP})
        page.get_by_role("button", name="Refresh status", exact=True).click()
        expect(page.locator('[data-testid="public-health"]')).to_have_attribute("data-status", "healthy")
        page.keyboard.press("Tab")
        page.get_by_role("link", name="Skip to content", exact=True).focus()
        ring = page.get_by_role("link", name="Skip to content", exact=True).evaluate("""el=>{const s=getComputedStyle(el);return {width:s.outlineWidth,offset:s.outlineOffset,gap:s.boxShadow,background:getComputedStyle(el.parentElement).backgroundColor}}""")
        checks.check(label + ": immediate 3px focus ring and opaque surface gap", ring["width"] == "3px" and ring["offset"] == "3px" and ring["background"] in ring["gap"], ring)
        page.keyboard.press("Enter")
        expect(page.locator("#main-content")).to_be_focused()
        checks.check(label + ": skip link adopts main focus", True)
        if coarse:
            menu = page.get_by_role("button", name="Open public navigation", exact=True)
            menu.click()
            expect(page.locator("#public-mobile-navigation")).to_be_visible()
            page.keyboard.press("Escape")
            expect(menu).to_be_focused()
            expect(page.locator("#public-mobile-navigation")).to_have_count(0)
            menu.click()
            page.locator("#public-mobile-navigation").get_by_role("link", name="Platform", exact=True).click()
            expect(page).to_have_url(origin + "/platform")
            expect(page.locator("#public-mobile-navigation")).to_have_count(0)
            checks.check(label + ": mobile navigation closes on Escape and successful navigation", True)
        else:
            page.get_by_role("navigation", name="Public navigation", exact=True).get_by_role("link", name="Platform", exact=True).click()
            expect(page).to_have_url(origin + "/platform")
        for path, title, metadata in ROUTES:
            navigate(page, origin, path)
            expect(page.get_by_role("heading", level=1)).to_have_count(1)
            expect(page.get_by_role("heading", level=1)).to_have_text(title)
            expect(page).to_have_title(re.compile(re.escape(metadata)))
            expect(page.locator('[data-public-header="flow"]')).to_be_visible()
            footer = page.get_by_role("navigation", name="Public footer", exact=True)
            hrefs = set(footer.locator("a").evaluate_all("els=>els.map(el=>el.getAttribute('href'))"))
            checks.check(label + path + ": exact useful footer routes", hrefs == FOOTER_PATHS, sorted(hrefs))
            links = page.locator(ROOT).locator("a").evaluate_all("els=>els.map(el=>el.getAttribute('href'))")
            checks.check(label + path + ": private entry and safe local link identities", "/signup" not in links and "/onboarding" not in links and all(value.startswith(("/", "#")) and not value.startswith("//") for value in links), links)
            if path in ("/privacy", "/terms"):
                expect(page.get_by_text("Effective August 25, 2026", exact=True)).to_be_visible()
                contents = page.get_by_role("navigation", name=title + " sections", exact=True)
                contents.get_by_role("link", name="Contact", exact=True).click()
                expect(page.get_by_text("benniejoseph.r@gmail.com", exact=False)).to_be_visible()
                checks.check(label + path + ": legal contents targets retained wording", page.url.endswith("#legal-section-5"))
            if path == "/pricing":
                expect(page.get_by_text("No public registration or commercial checkout.", exact=True)).to_be_visible()
            if path == "/security":
                expect(page.get_by_text("It does not report the live security posture", exact=False)).to_be_visible()
            if path == "/changelog":
                expect(page.get_by_text("Release dates are not provided", exact=False)).to_be_visible()
            if path == "/docs":
                page.get_by_role("navigation", name="Guide sections", exact=True).get_by_role("link", name="APIs", exact=True).click()
                expect(page).to_have_url(origin + "/docs#api-map")
                for item in page.locator("#api-map details").all():
                    item.locator("summary").click()
                expect(page.locator("code").filter(has_text="/api/workflows/[id]/signal")).to_be_visible()
                checks.check(label + ": API references are readable text without executable effects", page.locator('#api-map a[href^="/api/"]').count() == 0)
            if path == "/":
                page.get_by_text("What can Asael do?", exact=True).click()
                expect(page.get_by_text("It turns a goal into planned, observable work", exact=False)).to_be_visible()
            slug = "home" if path == "/" else path[1:]
            for color in ("light", "dark"):
                theme(page, color)
                snapshot(page, checks, f"{label}-{slug}-{color}", coarse)
        navigate(page, origin, "/")
        health_cases(page, fixture, checks, label)
        navigate(page, origin, "/docs")
        page.set_viewport_size({"width": 320, "height": 844})
        settle(page)
        snapshot(page, checks, label + "-docs-320", coarse)
        page.locator("html").evaluate("el=>el.style.fontSize='200%'")
        settle(page)
        snapshot(page, checks, label + "-docs-320-text200", coarse)
        page.locator("html").evaluate("el=>el.style.fontSize=''")
        page.emulate_media(forced_colors="active")
        snapshot(page, checks, label + "-docs-forced-colors", coarse)
        page.emulate_media(forced_colors="none")
        checks.check(label + ": reduced motion has no ornamental animation", page.locator(ROOT).evaluate("el=>[el,...el.querySelectorAll('*')].every(node=>getComputedStyle(node).animationName==='none')"))
        # Compatibility only: do not invoke the separate simulated agent or login.
        page.set_viewport_size({"width": 390 if coarse else 1440, "height": 844 if coarse else 900})
        navigate(page, origin, "/demo")
        expect(page.locator('[data-public-header="flow"]')).to_be_visible()
        expect(page.get_by_role("heading", level=1)).to_have_text("Explore a sample agent workflow.")
        if coarse:
            page.get_by_role("button", name="Open public navigation", exact=True).click()
            nav = page.locator("#public-mobile-navigation")
        else:
            nav = page.get_by_role("navigation", name="Public navigation", exact=True)
        nav.get_by_role("link", name="Docs", exact=True).click()
        expect(page.get_by_role("heading", name="How to use Asael.", exact=True)).to_be_visible()
        checks.check(label + ": Demo in-flow header compatibility and public navigation", True)
        checks.check(label + ": no browser errors", not errors, errors)
        checks.check(label + ": zero application writes and external or unexpected reads", not fixture.writes and not fixture.unexpected, {"writes": fixture.writes, "unexpected": fixture.unexpected})
        checks.check(label + ": no device, playback, popup or download effects", not effects, effects)
        return {"viewport": label, "reads": fixture.reads, "releases": fixture.releases, "writes": fixture.writes, "unexpected": fixture.unexpected}
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
    parser.add_argument("--output", type=Path, default=REPO / "test-results/public-pages")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve())
    contexts, failure = [], None
    try:
        with preview(args.output) as (origin, _credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True):
                    contexts.append(exercise(browser, origin, checks, coarse))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print(f"Public pages check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated public routes with exact synthetic GET /api/health?public=1 responses. No browser login, form submission or application writes. External requests, devices, playback, popups and downloads blocked. Nine public/reading routes; Demo coverage limited to shared header compatibility."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
