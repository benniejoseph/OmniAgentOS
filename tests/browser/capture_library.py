#!/usr/bin/env python3
"""Maintained exact Library identities, recording bookmarks and reindex receipts.

Only the isolated login reaches a mutation backend. Every declared reindex is
fulfilled locally with a bounded immutable receipt; no media, provider, recording,
upload, deletion or connector action is performed.
"""

import argparse
import copy
import json
from pathlib import Path
import re
import time
from urllib.parse import quote

from playwright.sync_api import expect, sync_playwright
from capture_library_fixtures import CaptureLibraryFixtures, LITERAL, RECORDING, RETAINED, library_envelope, metadata_envelope, recording_metadata
from run import Checks, REPO, navigate, preview, select_theme


def library(page):
    return page.get_by_test_id("workspace-library")


def button(page, name):
    return page.get_by_role("button", name=name, exact=True)


def until(page, predicate, message):
    deadline = time.monotonic() + 20
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def settle(page):
    page.evaluate("() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")


def panel_capture(page, checks, name, coarse, panel):
    # A tall locator screenshot expands Chromium's viewport and can reset touch
    # emulation. Capture the visible panel without changing the device profile.
    panel.evaluate("el=>el.scrollIntoView({block:'start'})")
    settle(page)
    checks.check(name + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    checks.check(name + ": screenshot preserved pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)


def read_count(fixture, key):
    return sum(value["key"] == key for value in fixture.requests)


def row(page, item):
    return library(page).get_by_role("button", name="Show details for " + item["title"], exact=True)


def identity_details(page):
    summary = library(page).locator("summary:visible").filter(has_text="Current version and source identities").first
    summary.click()
    return summary.locator("..")


def library_reads(page, fixture, checks, label, coarse):
    fixture.defaults["library::0"] = {"body": {}, "status": 200, "hold": "initial-library"}
    navigate(page, fixture.origin, "/app/capture?keep=exact")
    until(page, lambda: "initial-library" in fixture.held, "Initial Library read did not start")
    checks.check(label + ": initial read has no invented zero or empty success", "0 assets" not in library(page).inner_text() and "Your library is ready for its first asset" not in library(page).inner_text())
    fixture.defaults.pop("library::0")
    fixture.release("initial-library")
    expect(library(page).get_by_role("button", name="Retry", exact=True)).to_be_visible()
    expect(library(page).get_by_text("Count unavailable", exact=True)).to_be_visible()
    library(page).get_by_role("button", name="Retry", exact=True).click()
    expect(row(page, fixture.items[0])).to_be_visible()
    expect(library(page).get_by_text("3+ assets", exact=True)).to_be_visible()
    detail = identity_details(page)
    checks.check(label + ": full current identity and every exact citation remain selectable", all(value in detail.inner_text() for value in [fixture.items[0]["id"], fixture.items[0]["sourceId"], fixture.items[0]["currentVersion"]["versionId"], fixture.items[0]["currentVersion"]["contentSha256"], *fixture.items[0]["citationRefs"]]))
    checks.check(label + ": historical availability is stated honestly", "Earlier version content is not included" in detail.inner_text())
    expect(library(page).get_by_role("link", name="Open " + fixture.items[0]["title"], exact=True).first).to_have_attribute("href", fixture.items[0]["openHref"])
    expect(library(page).get_by_role("link", name="Open " + fixture.items[1]["title"], exact=True).first).to_have_attribute("href", "/app/capture?recording=" + RECORDING)
    page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>new Promise(resolve=>{window.__copiedText=text;window.__copyResolve=resolve})}})")
    library(page).locator('button[aria-label="Copy citation 2"]:visible').click()
    checks.check(label + ": clipboard success waits for the write promise", "Citation copied." not in library(page).inner_text())
    page.evaluate("window.__copyResolve()")
    expect(library(page).get_by_text("Citation copied.", exact=True)).to_be_visible()
    checks.check(label + ": full second citation was copied", page.evaluate("window.__copiedText") == fixture.items[0]["citationRefs"][1])
    page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('synthetic clipboard failure')}}})")
    library(page).locator('button[aria-label="Copy citation 1"]:visible').click()
    expect(library(page).get_by_text("Citation could not be copied. Select the citation text and copy it manually.", exact=True)).to_be_visible()
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse)
        settle(page)
        checks.snapshot(page, f"{label}-{theme}-library-identities", coarse)
        panel_capture(page, checks, f"{label}-{theme}-library-panel", coarse, library(page))
    page.keyboard.press("Tab")
    row(page, fixture.items[0]).focus()
    checks.check(label + ": keyboard focus remains visible", row(page, fixture.items[0]).evaluate("el=>document.activeElement===el && el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth)>=3"))
    page.evaluate("document.documentElement.style.fontSize='200%'")
    settle(page)
    checks.snapshot(page, label + "-library-text200", coarse)
    page.evaluate("document.documentElement.style.fontSize=''")
    settle(page)
    library(page).get_by_role("button", name="Next", exact=True).click()
    expect(row(page, fixture.items[2])).to_be_visible()
    checks.check(label + ": server nextOffset is independent of requested limit100", read_count(fixture, "library::2") > 0 and "libraryOffset=2" in page.url and "keep=exact" in page.url)
    library(page).get_by_role("button", name="Previous", exact=True).click()
    expect(row(page, fixture.items[0])).to_be_visible()
    field = library(page).get_by_role("textbox", name="Search library", exact=True)
    fixture.defaults["library:failed:0"] = {"body": {"error": "Synthetic Library read failure"}, "status": 503}
    field.fill("failed")
    expect(library(page).get_by_role("button", name="Retry", exact=True)).to_be_visible()
    expect(row(page, fixture.items[0])).to_be_visible()
    checks.check(label + ": failed read preserves last-loaded rows and count", "3+ assets · Last loaded" in library(page).inner_text())
    fixture.defaults["library:failed:0"] = {"body": {"items": [], "total": 0}, "status": 200}
    library(page).get_by_role("button", name="Retry", exact=True).click()
    expect(library(page).get_by_role("button", name="Retry", exact=True)).to_be_enabled()
    expect(row(page, fixture.items[0])).to_be_visible()
    fixture.defaults.pop("library:failed:0")
    field.fill("empty")
    expect(library(page).get_by_text("Nothing matches this view", exact=True)).to_be_visible()
    expect(library(page).get_by_text("0 assets", exact=True)).to_be_visible()
    library(page).get_by_role("button", name="Clear filters", exact=True).click()
    expect(row(page, fixture.items[0])).to_be_visible()


def library_races(page, fixture, checks):
    field = library(page).get_by_role("textbox", name="Search library", exact=True)
    old = copy.deepcopy(fixture.items)
    old[0]["title"] = "Old held Library response"
    fixture.defaults["library:alpha:0"] = {"body": library_envelope(old), "status": 200, "hold": "old-library"}
    field.fill("alpha")
    until(page, lambda: "old-library" in fixture.held, "Old search was not held")
    field.fill("bravo")
    until(page, lambda: read_count(fixture, "library:bravo:0") > 0, "New search did not start")
    expect(row(page, fixture.items[0])).to_be_visible()
    fixture.release("old-library")
    settle(page)
    checks.check("Late query cannot replace the current Library", "Old held Library response" not in library(page).inner_text())
    fixture.defaults.pop("library:alpha:0")
    exact_id = fixture.items[0]["id"]
    fixture.defaults["library::0"] = {"body": {"error": "Synthetic current-session refusal"}, "status": 401, "hold": "refused-list"}
    fixture.defaults["exact:" + exact_id] = {"body": {"item": fixture.items[0]}, "status": 200, "hold": "held-exact"}
    navigate(page, fixture.origin, "/app/capture?libraryItem=" + quote(exact_id, safe=""))
    until(page, lambda: "held-exact" in fixture.held and "refused-list" in fixture.held, "Both independent reads were not held")
    fixture.release("refused-list")
    expect(library(page).get_by_text("Count unavailable", exact=True)).to_be_visible()
    fixture.release("held-exact")
    settle(page)
    checks.check("Collection401 fences the concurrent exact read", fixture.items[0]["title"] not in library(page).inner_text() and fixture.items[0]["currentVersion"]["versionId"] not in library(page).inner_text())
    fixture.defaults.pop("library::0")
    fixture.defaults.pop("exact:" + exact_id)
    library(page).get_by_role("button", name="Retry", exact=True).click()
    expect(row(page, fixture.items[0])).to_be_visible()


def outside_library_page(page, fixture, checks, label, coarse):
    exact = fixture.items[2]
    navigate(page, fixture.origin, "/app/capture?libraryItem=" + quote(exact["id"], safe="") + "&keep=exact")
    expect(row(page, fixture.items[0])).to_be_visible()
    if coarse:
        region = library(page).locator("[data-library-exact-inline]")
        expect(region).to_be_visible()
        expect(region.get_by_role("heading", name=exact["title"], exact=True)).to_be_visible()
    else:
        region = library(page).get_by_role("region", name="Details for " + exact["title"], exact=True)
        expect(region).to_be_visible()
    expect(row(page, exact)).to_have_count(0)
    region.locator("summary").filter(has_text="Current version and source identities").click()
    checks.check(label + ": exact item outside bounded page has visible current version and full citations", all(value in region.inner_text() for value in [exact["id"], exact["currentVersion"]["versionId"], *exact["citationRefs"]]))
    if coarse:
        page.set_viewport_size({"width": 320, "height": 844})
        settle(page)
        checks.snapshot(page, "phone320-exact-library-outside-page", True)
        panel_capture(page, checks, "phone320-exact-library-panel", True, region)
        page.set_viewport_size({"width": 390, "height": 844})
        settle(page)


def recordings(page, fixture, checks, label, coarse):
    navigate(page, fixture.origin, "/app/capture?recording=" + RECORDING + "&keep=recording")
    dialog = page.get_by_role("dialog", name=recording_metadata()["title"], exact=True)
    expect(dialog).to_be_visible()
    checks.check(label + ": bookmark opens exact metadata outside six history rows", read_count(fixture, "metadata:" + RECORDING) > 0 and read_count(fixture, "history") > 0 and read_count(fixture, "private:" + RECORDING) == 0)
    expect(dialog.get_by_role("button", name="Read private transcript and audio", exact=True)).to_be_visible()
    expect(dialog.get_by_role("heading", name="Segment 9", exact=True)).to_have_count(0)
    dialog.get_by_role("button", name="Show more linked segments", exact=True).click()
    expect(dialog.get_by_role("heading", name="Segment 12", exact=True)).to_be_visible()
    for theme in ("light", "dark"):
        dialog.get_by_role("button", name="Close linked recording", exact=True).click()
        select_theme(page, theme, coarse)
        button(page, "Open linked recording metadata").click()
        expect(dialog).to_be_visible()
        settle(page)
        checks.snapshot(page, f"{label}-{theme}-exact-recording-metadata", coarse)
    dialog.get_by_role("button", name="Read private transcript and audio", exact=True).click()
    expect(dialog.get_by_text(LITERAL, exact=True)).to_be_visible()
    checks.check(label + ": private content is literal and follows explicit exact-owner read", read_count(fixture, "private:" + RECORDING) == 1 and page.evaluate("window.captureFixtureExecuted") is not True)
    page.evaluate("document.documentElement.style.fontSize='200%'")
    settle(page)
    checks.snapshot(page, label + "-recording-text200", coarse)
    page.evaluate("document.documentElement.style.fontSize=''")
    settle(page)
    if not coarse:
        fixture.defaults["metadata:" + RECORDING] = {"body": metadata_envelope(), "status": 200, "hold": "visible-metadata"}
        page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__captureVisibility||'visible'});window.__captureVisibility='hidden';document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.evaluate("window.__captureVisibility='visible';document.dispatchEvent(new Event('visibilitychange'))")
        until(page, lambda: "visible-metadata" in fixture.held, "Restored metadata read was not held")
        checks.check("Hidden private content cannot flash during visibility restoration", LITERAL not in page.locator("body").inner_text())
        fixture.defaults.pop("metadata:" + RECORDING)
        fixture.release("visible-metadata")
        expect(dialog).to_be_visible()
        checks.check("A new visible epoch still requires explicit private content admission", dialog.get_by_text(LITERAL, exact=True).count() == 0 and read_count(fixture, "private:" + RECORDING) == 1)
        dialog.get_by_role("button", name="Close linked recording", exact=True).click()
        fixture.defaults["metadata:" + RECORDING] = {"body": metadata_envelope(), "status": 200, "hold": "old-recording"}
        button(page, "Open linked recording metadata").click()
        until(page, lambda: "old-recording" in fixture.held, "Old recording metadata was not held")
        page.evaluate("id=>{history.pushState({},'', '/app/capture?recording='+id);dispatchEvent(new PopStateEvent('popstate'))}", RETAINED)
        retained = page.get_by_role("dialog", name=recording_metadata(RETAINED)["title"], exact=True)
        expect(retained).to_be_visible()
        fixture.defaults.pop("metadata:" + RECORDING)
        page.evaluate("id=>{history.pushState({},'', '/app/capture?recording='+id);dispatchEvent(new PopStateEvent('popstate'))}", RECORDING)
        expect(dialog).to_be_visible()
        fixture.release("old-recording")
        checks.check("Recording A→B→A preserves the latest exact selection", dialog.is_visible() and read_count(fixture, "private:" + RECORDING) == 1)
    button(page, "Close linked recording").click()
    navigate(page, fixture.origin, "/app/capture?recording=" + RETAINED)
    retained = page.get_by_role("dialog", name=recording_metadata(RETAINED)["title"], exact=True)
    expect(retained).to_be_visible()
    checks.check(label + ": retained metadata never exposes private actions or private GET", retained.get_by_role("button", name="Read private transcript and audio", exact=True).count() == 0 and read_count(fixture, "private:" + RETAINED) == 0)
    button(page, "Close linked recording").click()


def reindex(page, fixture, checks):
    navigate(page, fixture.origin, "/app/capture")
    fixture.post_modes.update({"original-2": "duplicate", "original-3": "repair", "original-4": "malformed", "original-5": "mismatch"})
    fixture.post_holds["original-1"] = "accepted-index"
    bulk = button(page, "Re-index 6 shown")
    expect(bulk).to_be_enabled()
    bulk.evaluate("el=>{el.click();el.click()}")
    until(page, lambda: len(fixture.writes) == 6, "The bounded six-source fixture did not settle its admissions")
    fixture.defaults["capture"] = {"body": {"error": "Synthetic source refresh failure"}, "status": 503}
    fixture.post_holds.clear()
    fixture.release("accepted-index")
    receipts = page.get_by_role("region", name="Indexing request receipts", exact=True)
    expect(receipts).to_have_attribute("aria-busy", "false")
    checks.check("Synchronous double-click admits exactly one batch", len(fixture.writes) == 6)
    expect(receipts.get_by_text("Accepted job · Queued", exact=True)).to_have_count(2)
    expect(receipts.get_by_text("Existing job · Running", exact=True)).to_be_visible()
    expect(receipts.get_by_text("Existing completed job · source index repaired", exact=True)).to_be_visible()
    expect(receipts.get_by_text("Acceptance unconfirmed", exact=True)).to_have_count(2)
    checks.check("Accepted receipts survive independent read failure without claiming completion", "4 confirmed receipts from 6 requests" in receipts.inner_text())
    original_unknown_key = next(value["key"] for value in fixture.writes if value["path"].endswith("original-4"))
    fixture.defaults.pop("capture")
    receipts.get_by_role("button", name="Refresh source status", exact=True).click()
    expect(button(page, "Refresh Capture")).to_be_enabled()
    expect(button(page, "Re-index " + fixture.assets[3]["filename"])).to_be_disabled()
    # Lose the next HTTP response rather than merely returning malformed JSON.
    fixture.post_modes["original-6"] = "lost"
    fixture.defaults["capture"] = {"body": {"error": "Synthetic read failed after response loss"}, "status": 503}
    button(page, "Re-index " + fixture.assets[5]["filename"]).click()
    expect(receipts).to_have_attribute("aria-busy", "false")
    until(page, lambda: len(fixture.writes) == 7, "Lost response request was not admitted")
    lost_key = fixture.writes[-1]["key"]
    button(page, "Re-index " + fixture.assets[5]["filename"]).evaluate("el=>el.click()")
    checks.check("Lost response plus failed refresh cannot admit a second fresh key", len(fixture.writes) == 7 and receipts.locator('[data-reindex-asset="original-6"]').get_by_text("Acceptance unconfirmed", exact=True).count() == 1)
    fixture.defaults.pop("capture")
    receipts.get_by_role("button", name="Refresh source status", exact=True).click()
    expect(button(page, "Refresh Capture")).to_be_enabled()
    expect(button(page, "Re-index " + fixture.assets[5]["filename"])).to_be_disabled()
    fixture.post_modes["original-1"] = "duplicate"
    button(page, "Re-index " + fixture.assets[0]["filename"]).click()
    until(page, lambda: len(fixture.writes) == 8, "Independent source did not admit its later explicit request")
    expect(receipts).to_have_attribute("aria-busy", "false")
    for original_id in ("original-4", "original-6"):
        receipts.locator(f'[data-reindex-asset="{original_id}"] summary').click()
    checks.check("Other batches preserve all unknown frozen keys", original_unknown_key in receipts.inner_text() and lost_key in receipts.inner_text())
    # Fresh view-local batch: only the three already-sent requests may exist after unmount.
    navigate(page, fixture.origin, "/app/capture?disposal=1")
    fixture.post_modes.clear()
    fixture.post_holds = {f"original-{i}": "dispose-index" for i in range(1, 7)}
    expect(button(page, "Re-index 6 shown")).to_be_enabled()
    button(page, "Re-index 6 shown").click()
    until(page, lambda: len(fixture.writes) == 11, "The three in-flight requests were not admitted")
    page.locator('a[href="/app/command"]:visible').first.click()
    expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
    fixture.release("dispose-index")
    settle(page)
    checks.check("Disposal stops later batches without claiming sent server work was canceled", len(fixture.writes) == 11)
    fixture.post_holds.clear()


def compact_library(page, fixture, checks, label):
    navigate(page, fixture.origin, "/app/results?keep=compact")
    expect(library(page).get_by_role("heading", name="Reusable outputs", exact=True)).to_be_visible(timeout=30_000)
    expect(library(page).get_by_role("heading", name=fixture.items[2]["title"], exact=True)).to_be_visible()
    detail = identity_details(page)
    checks.check(label + ": compact Library preserves every current identity/citation", fixture.items[2]["currentVersion"]["versionId"] in detail.inner_text() and fixture.items[2]["citationRefs"][1] in detail.inner_text())
    before = page.url
    library(page).get_by_role("textbox", name="Search library", exact=True).fill("compact")
    until(page, lambda: read_count(fixture, "library:compact:0") > 0, "Compact search did not read")
    checks.check(label + ": compact controls preserve host URL", page.url == before)


def exercise(browser, origin, credentials, checks, coarse):
    label, errors = ("phone" if coarse else "desktop"), []
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse,
                                  service_workers="block", reduced_motion="reduce", timezone_id="UTC")
    fixture, page = None, None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        session = context.request.get(origin + "/api/auth/session", timeout=90_000).json()
        owner = {"tenantId": session["context"]["tenantId"], "actorId": session["context"]["actorId"]}
        fixture = CaptureLibraryFixtures(origin, owner, post_budget=0 if coarse else 11)
        context.route("**/*", fixture.route)
        context.add_init_script("window.captureFixtureExecuted=false;window.__micAttempts=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{window.__micAttempts++;throw new Error('No microphone in this suite')}")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        library_reads(page, fixture, checks, label, coarse)
        if not coarse:
            library_races(page, fixture, checks)
        outside_library_page(page, fixture, checks, label, coarse)
        recordings(page, fixture, checks, label, coarse)
        if not coarse:
            reindex(page, fixture, checks)
        compact_library(page, fixture, checks, label)
        checks.check(label + ": only bounded declared effects and no media/microphone access", not fixture.unexpected and len(fixture.writes) == (0 if coarse else 11) and page.evaluate("window.__micAttempts") == 0, fixture.unexpected)
        checks.check(label + ": no uncaught page errors", not errors, errors)
        return {"viewport": label, "reads": fixture.requests, "writes": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        if fixture:
            (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        if fixture:
            fixture.abort_held()
        if page and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/capture-library")
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
        print("Capture/Library browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": results, "failure": failure,
            "boundary": "Actual authenticated Capture and Results hosts. Strict local synthetic Library/current-version and recording metadata/private reads; six-row history deliberately excludes the bookmarked recording. Desktop permits exactly11 intercepted reindex POSTs with body{} and fresh bounded keys; phone permitszero. No real media bytes, recording, provider, deletion, upload, connector or agent effect. Visibility is a deterministic event override for disclosure fencing. Historical-version content, source RLS and durable recovery after leaving this view require separate backend/store coverage."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
