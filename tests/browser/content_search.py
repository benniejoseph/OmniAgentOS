#!/usr/bin/env python3
"""Actual search palette with bounded synthetic GETs, exact destinations and zero application effects."""
import argparse
import json
from pathlib import Path
import time
from urllib.parse import unquote, urlsplit
from playwright.sync_api import expect, sync_playwright
from run import Checks, REPO, navigate, preview, select_theme
from content_search_fixtures import ContentSearchFixtures, MEMORY, LIBRARY, CONNECTED_SOURCE, UNTRUSTED


def palette(page): return page.get_by_test_id("command-palette-dialog")
def search(page, query):
    if not palette(page).count(): page.get_by_test_id("command-palette-trigger").click()
    page.get_by_test_id("command-palette-input").fill(query)
def until(page, predicate, label):
    deadline = time.monotonic() + 20
    while not predicate() and time.monotonic() < deadline: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)


def open_exact_result(page, name, path, status):
    # A first client navigation may compile a new Next route. Wait for its
    # exact consumer read before starting the ordinary UI assertion deadline.
    with page.expect_response(lambda response: response.request.method == "GET"
                              and unquote(urlsplit(response.url).path) == path,
                              timeout=20_000) as received:
        palette(page).get_by_role("option", name=name, exact=True).click()
    response = received.value
    response.body()
    if response.status != status:
        raise AssertionError(f"Exact destination read {path} returned {response.status}, expected {status}")


def exercise(browser, origin, credentials, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page = None; fixture = None; errors = []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": isolated synthetic login", login.ok)
        fixture = ContentSearchFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        context.route("**/*", fixture.route)
        page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/command")
        search(page, "%%"); page.wait_for_timeout(350)
        checks.check(label + ": search leaves workspace controls inert while open",
                     page.get_by_test_id("command-palette-trigger").evaluate("el=>Boolean(el.closest('[inert]'))"))
        checks.check(label + ": punctuation never issues content search", len(fixture.requests) == 0)
        search(page, "report")
        expect(palette(page).get_by_role("option", name="Report private memory Active private memory")).to_be_visible()
        checks.check(label + ": independent unavailable provider and explicit scope", "This content could not be searched" in palette(page).inner_text() and "Unindexed or revoked connections are excluded" in palette(page).inner_text())
        palette(page).get_by_role("button", name="More Library", exact=True).click()
        expect(palette(page).get_by_role("option", name="Report original file refreshed document · ready")).to_be_visible()
        checks.check(label + ": live pagination deduplicates and preserves exact text", palette(page).get_by_role("option").filter(has_text="Report original file").count() == 1 and UNTRUSTED in palette(page).inner_text() and not page.evaluate("Boolean(window.searchUntrustedRan)"))
        fixture.work_ready = True
        palette(page).get_by_role("button", name="Retry Work", exact=True).click()
        expect(palette(page).get_by_role("option", name="Report project Project")).to_be_visible()
        for theme in ("light", "dark"):
            page.keyboard.press("Escape"); select_theme(page, theme, coarse); search(page, "report")
            expect(palette(page).get_by_role("option", name="Report private memory Active private memory")).to_be_visible()
            checks.snapshot(page, "content-search-" + label + "-" + theme, coarse)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 844})
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            checks.snapshot(page, "content-search-phone-320", coarse)
            page.evaluate("document.documentElement.style.fontSize='200%'")
            page.wait_for_function("() => parseFloat(getComputedStyle(document.documentElement).fontSize) >= 31")
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            checks.check("phone text 200: search portal covers the navigation dock",
                         palette(page).evaluate("el=>el.parentElement===document.body && el.contains(document.elementFromPoint(innerWidth/2,innerHeight-1))"))
            checks.snapshot(page, "content-search-phone-text-200", coarse)
            page.evaluate("document.documentElement.style.fontSize=''")
            page.set_viewport_size({"width": 390, "height": 844})
        else:
            page.emulate_media(forced_colors="active")
            checks.snapshot(page, "content-search-forced-colors", coarse)
            page.emulate_media(forced_colors="none")
        search(page, "delayed"); until(page, lambda: "delayed" in fixture.held, "Delayed read held")
        search(page, "report"); expect(palette(page).get_by_role("option", name="Report private memory Active private memory")).to_be_visible()
        fixture.release("delayed"); page.wait_for_timeout(100)
        checks.check(label + ": replaced query cannot publish late results", page.get_by_test_id("command-palette-input").input_value() == "report")
        page.get_by_test_id("command-palette-input").press("End")
        active = page.get_by_test_id("command-palette-input").get_attribute("aria-activedescendant")
        checks.check(label + ": keyboard active result remains in the list", page.locator('[id="' + active + '"]').get_attribute("role") == "option")
        page.keyboard.press("Escape"); expect(page.get_by_test_id("command-palette-trigger")).to_be_focused()
        checks.check(label + ": closing search restores workspace interaction",
                     page.get_by_test_id("command-palette-trigger").evaluate("el=>!el.closest('[inert]')"))
        fixture.mode = "error"; search(page, "report")
        expect(palette(page).get_by_role("button", name="Restart search", exact=True)).to_be_visible()
        search(page, "settings")
        expect(palette(page).get_by_role("option").filter(has_text="Settings").first).to_be_visible()
        checks.check(label + ": navigation stays available while content requests fail", True)
        fixture.mode = "ready"; search(page, "report")
        open_exact_result(page, "Report private memory Active private memory", "/api/content-search/memory/" + MEMORY, 200)
        expect(page.get_by_role("dialog", name="Memory details")).to_be_visible()
        expect(page.get_by_role("dialog", name="Memory details").get_by_role("heading", name="Exact private memory outside first page")).to_be_visible()
        checks.check(label + ": exact memory opens outside index without generic fallback", any(row["path"] == "/api/content-search/memory/" + MEMORY for row in fixture.requests))
        page.get_by_role("button", name="Close memory details", exact=True).click()
        search(page, "report"); open_exact_result(page, "Report project Project", "/api/content-search/work/search", 404)
        expect(page.get_by_role("button", name="Retry exact result", exact=True)).to_be_visible()
        expect(page.get_by_text("This exact result was deleted or access was revoked.", exact=True)).to_be_visible()
        checks.check(label + ": exact Work result rechecks access without selecting a fallback", any(row["path"] == "/api/content-search/work/search" for row in fixture.requests))
        search(page, "report"); open_exact_result(page, "Report original file document · ready", "/api/library/" + LIBRARY, 404)
        expect(page.get_by_text("This exact result was deleted or access was revoked.", exact=True)).to_be_visible()
        checks.check(label + ": revoked exact Library result is visible as unavailable", True)
        fixture.hold_connected = True
        search(page, "report"); palette(page).get_by_role("option", name="Report connected source document · ready").click()
        until(page, lambda: "connected-exact" in fixture.held, "Connected source exact read did not start")
        expect(page.get_by_text("Opening exact Library item…", exact=True)).to_be_visible()
        expect(page.get_by_text("This exact result was deleted or access was revoked.", exact=True)).to_have_count(0)
        checks.check(label + ": replacement Library target immediately fences the previous error", True)
        fixture.release("connected-exact", 404)
        expect(page.get_by_text("This exact result was deleted or access was revoked.", exact=True)).to_be_visible()
        checks.check(label + ": connected-source opening rechecks its full identity after revocation", any(row["path"] == "/api/library/" + CONNECTED_SOURCE for row in fixture.requests))
        checks.check(label + ": bounded reads and no application effects", len(fixture.requests) < 40 and not fixture.writes and not fixture.held)
        checks.check(label + ": no unexpected traffic or uncaught errors", not fixture.unexpected and not errors, {"unexpected": fixture.unexpected, "errors": errors})
        return {"viewport": label, "reads": fixture.requests, "writes": fixture.writes, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if fixture is not None:
            (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        raise
    finally:
        if fixture is not None: fixture.abort_held()
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/content-search")
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
        failure = str(error); print("Content search browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual palette and exact Memory/Work/Library destinations with isolated synthetic login. Search and exact detail GETs are wholly intercepted. Zero application effects, providers, embeddings or downloads. Seven desktop/phone theme, 320px, 200% text and forced-colors axe scans. Server ownership/deletion/revocation is covered by separate unit and disposable-database integration tests, not these fixtures."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
