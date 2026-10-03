#!/usr/bin/env python3
"""Memory → Reviews interactions with exact, wholly intercepted evaluation effects.

Run serially using the same --axe/--chrome options as tests/browser/run.py.
No provider, collection, activation, approval, or live evaluation is invoked.
"""

import argparse
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright

from run import Checks, REPO, navigate, preview, select_theme
from semantic_review_fixtures import QUESTION, REVIEW_PATH, SemanticReviewFixtures

BENCH = 'section[aria-labelledby="semantic-review-bench-title"]'


def bench(page):
    return page.locator(BENCH)


def until(page, predicate, label, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(label)


def disclosure(root, name):
    summary = root.locator("summary").filter(has_text=re.compile("^" + re.escape(name) + "$"))
    if not summary.evaluate("el=>el.parentElement.open"):
        summary.click()
    return summary.locator("xpath=..")


def view_button(page, name):
    return page.get_by_role("navigation", name="Memory workspace", exact=True).get_by_role(
        "button", name=re.compile(r"^" + name + r"(?:\s*\d+)?$"))


def open_reviews(page):
    view_button(page, "Reviews").click()
    disclosure(page.locator('section[aria-labelledby="memory-page-title"]'), "Quality signals and semantic evaluation")
    expect(bench(page)).to_be_visible(timeout=30_000)


def episode_button(page, number):
    return bench(page).get_by_role("region", name="Available evaluation episodes", exact=True).get_by_role(
        "button", name=re.compile(r"^Episode " + str(number) + r"\b"))


def evidence(page, number=1, version=1):
    region = bench(page).get_by_role("region", name="Source conversation evidence", exact=True)
    expect(region).to_contain_text(f"EPISODE_{number}_VERSION_{version}:", timeout=30_000)
    return region


def review_button(page):
    return bench(page).get_by_role("button", name=re.compile(r"^(Save review|Update review)$"))


def fill_review(page):
    root = bench(page)
    root.get_by_role("combobox", name="Scenario", exact=True).select_option("decision")
    groups = root.locator("fieldset")
    groups.nth(0).get_by_role("radio", name="Supported", exact=True).check()
    groups.nth(1).get_by_role("radio", name="Unsupported", exact=True).check()
    for name, value in (("Important source facts", "3"), ("Facts in baseline", "1"),
                        ("Facts in semantic result", "2"), ("Unrelated or cross-scope facts", "0")):
        root.get_by_role("spinbutton", name=name, exact=True).fill(value)
    root.get_by_role("combobox", name="Useful compression", exact=True).select_option("good")
    root.get_by_role("checkbox", name=re.compile(r"^I compared the source")).check()
    expect(review_button(page)).to_be_enabled()


def fill_probe(page):
    root = bench(page)
    root.get_by_role("textbox", name="Retrieval question", exact=True).fill(QUESTION)
    root.get_by_role("checkbox", name=re.compile(r"^This episode is a relevant answer")).check()
    expect(root.get_by_role("button", name="Measure ranks", exact=True)).to_be_enabled()


def retry_evidence(page):
    root = bench(page)
    root.get_by_role("button", name="Retry episode evidence", exact=True).click()
    expect(root.get_by_text("Current episode evidence could not be verified. Retry the evidence read before submitting.", exact=True)).to_have_count(0)
    expect(root.get_by_text("The submitted outcome is unconfirmed. Retry the evidence read to check for a recorded result.", exact=True)).to_have_count(0)


def count_reads(fixtures):
    return sum(request["path"] == REVIEW_PATH for request in fixtures.requests)


def malformed_effect(page, fixtures, checks, kind, mode):
    if kind == "review":
        fill_review(page)
    else:
        fill_probe(page)
    before = len(fixtures.writes)
    fixtures.expect_action(kind, mode=mode)
    control = review_button(page) if kind == "review" else bench(page).get_by_role("button", name="Measure ranks", exact=True)
    control.click()
    until(page, lambda: len(fixtures.writes) == before + 1, f"{kind} fixture was not consumed")
    expect(bench(page).get_by_text("The evaluation response could not confirm the submitted result.", exact=False)).to_be_visible()
    expect(bench(page).get_by_role("button", name="Measure ranks", exact=True)).to_be_disabled()
    if kind == "review":
        expect(bench(page).locator("summary").filter(has_text=re.compile("^Confirmed evaluation receipt$"))).to_have_count(0)
    else:
        expect(bench(page).get_by_text("Retrieval ranks measured and sealed.", exact=False)).to_have_count(0)
    checks.check(f"{kind} {mode} 200 is unconfirmed and blocks another effect until evidence retry", True)
    retry_evidence(page)
    evidence(page, version=fixtures.versions[0])


def read_races(page, fixtures, checks):
    root = bench(page)
    fill_review(page)
    first = fixtures.episode_id(0)
    second = fixtures.episode_id(1)
    poisoned = fixtures.workspace(first)
    poisoned["candidates"][0]["sourceTurns"][0]["content"] = "STALE_A_RESPONSE_MUST_NOT_APPEAR"
    fixtures.read_plan("detail:" + first, hold="old-a", body=poisoned)
    root.get_by_role("button", name="Retry episode evidence", exact=True).click()
    until(page, lambda: "old-a" in fixtures.held, "A evidence read was not held")
    fixtures.read_plan("detail:" + second, hold="old-b")
    episode_button(page, 2).click()
    until(page, lambda: "old-b" in fixtures.held, "B evidence read was not held")
    episode_button(page, 1).click()
    evidence(page)
    fixtures.release("old-b")
    fixtures.release("old-a")
    page.wait_for_timeout(100)
    expect(episode_button(page, 1)).to_have_attribute("aria-pressed", "true")
    expect(root.get_by_text("STALE_A_RESPONSE_MUST_NOT_APPEAR", exact=True)).to_have_count(0)
    expect(root.get_by_role("spinbutton", name="Important source facts", exact=True)).to_have_value("3")
    checks.check("A → B → A ignores both disposed detail responses and preserves the surviving draft", True)

    stale_list = fixtures.workspace()
    stale_list["candidates"][0]["reviewSourceSha256"] = "f" * 64
    fixtures.read_plan("list", hold="old-list", body=stale_list)
    root.get_by_role("button", name="Refresh semantic evaluation episodes", exact=True).click()
    until(page, lambda: "old-list" in fixtures.held, "List read was not held")
    episode_button(page, 2).click()
    evidence(page, 2)
    fixtures.release("old-list")
    page.wait_for_timeout(100)
    expect(episode_button(page, 2)).to_have_attribute("aria-pressed", "true")
    checks.check("A late list cannot replace a newer explicit episode selection", True)
    episode_button(page, 1).click()
    evidence(page)

    fill_review(page)
    fixtures.versions[0] += 1
    fixtures.read_plan("detail:" + first, hold="new-version")
    root.get_by_role("button", name="Refresh semantic evaluation episodes", exact=True).click()
    until(page, lambda: "new-version" in fixtures.held, "New source evidence was not requested")
    expect(root.get_by_role("combobox", name="Scenario", exact=True)).to_be_disabled()
    expect(root.get_by_role("spinbutton", name="Important source facts", exact=True)).to_have_value("3")
    fixtures.release("new-version")
    evidence(page, version=2)
    expect(root.get_by_role("combobox", name="Scenario", exact=True)).to_have_value("")
    expect(root.get_by_role("checkbox", name=re.compile(r"^I compared the source"))).not_to_be_checked()
    checks.check("Same episode with a new digest retains old evidence while pending, then requires new judgments", True)

    fill_review(page)
    field = root.get_by_role("spinbutton", name="Important source facts", exact=True)
    fixtures.read_plan("detail:" + first, hold="same-version")
    root.get_by_role("button", name="Retry episode evidence", exact=True).click()
    until(page, lambda: "same-version" in fixtures.held, "Same-source evidence was not held")
    field.focus()
    expect(field).to_have_value("3")
    fixtures.release("same-version")
    expect(root.get_by_text("Refreshing episode evidence.", exact=False)).to_have_count(0)
    expect(field).to_be_focused()
    expect(field).to_have_value("3")
    expect(root.get_by_role("checkbox", name=re.compile(r"^I compared the source"))).to_be_checked()
    checks.check("Same-version refresh preserves the mounted focused draft and explicit attestation", True)


def accepted_with_failed_reads(page, fixtures, checks, kind):
    root = bench(page)
    fill_review(page)
    fill_probe(page)
    before = len(fixtures.writes)
    fixture_name = kind + "-post"
    fixtures.expect_action(kind, hold=fixture_name)
    # Two controls are activated in the same JavaScript task. Only the first
    # explicit request may reach the interception boundary.
    root.evaluate("""(el, kind) => {
      const buttons = [...el.querySelectorAll('button')];
      const review = buttons.find(button => /^(Save review|Update review)$/.test(button.textContent.trim()));
      const probe = buttons.find(button => button.textContent.trim() === 'Measure ranks');
      const first = kind === 'review' ? review : probe;
      const second = kind === 'review' ? probe : review;
      first.click(); second.click(); first.click();
    }""", kind)
    until(page, lambda: fixture_name in fixtures.held, "Evaluation POST was not held")
    checks.check(f"{kind}: one synchronous effect and both actions disabled", len(fixtures.writes) == before + 1 and
                 root.get_by_role("button", name=re.compile(r"^(Saving evidence…|Measuring…)$")).count() == 1 and
                 root.locator("input,select").evaluate_all("els=>els.every(el=>el.matches(':disabled'))"))
    expect(episode_button(page, 2)).to_be_disabled()
    expect(root.get_by_text("Leaving Reviews does not cancel a request already sent to the server.", exact=False)).to_be_visible()
    fixtures.read_plan("list", body={"error": "Synthetic list refresh unavailable."}, status=503)
    fixtures.read_plan("detail:" + fixtures.episode_id(0), hold=kind + "-follow-up",
                       body={"error": "Synthetic evidence refresh unavailable."}, status=503)
    fixtures.read_plan("overview", body={"error": "Synthetic overview refresh unavailable."}, status=503)
    fixtures.release(fixture_name)
    until(page, lambda: kind + "-follow-up" in fixtures.held, "Follow-up evidence GET was not held")
    receipt = disclosure(root, "Confirmed evaluation receipt")
    expect(receipt.get_by_text(fixtures.candidate(0)["reviewSourceSha256"], exact=True)).to_be_visible()
    expect(root.get_by_role("textbox", name="Retrieval question", exact=True)).to_be_enabled()
    field = root.get_by_role("textbox", name="Retrieval question", exact=True)
    field.focus()
    fixtures.release(kind + "-follow-up")
    expect(root.get_by_text("Synthetic evidence refresh unavailable.", exact=False)).to_be_visible()
    expect(field).to_be_focused()
    expect(field).to_have_value(QUESTION)
    expect(root.get_by_role("spinbutton", name="Important source facts", exact=True)).to_have_value("3")
    expect(root.get_by_text("Showing last loaded evaluation counts and episodes.", exact=True)).to_be_visible()
    checks.check(f"{kind}: accepted receipt survives independent GET failures with draft and focus retained", True)
    if kind == "probe":
        expect(receipt.get_by_text(fixtures.probes[fixtures.episode_id(0)]["querySha256"], exact=True)).to_be_visible()
        expect(root.get_by_text("#10", exact=True)).to_be_visible()
        expect(root.get_by_text("#3", exact=True)).to_be_visible()
        checks.check("Measured probe receipt retains exact query/corpus identity and returned ranks", True)
    retry_evidence(page)
    evidence(page, version=fixtures.versions[0])


def disposal(page, fixtures, checks):
    fill_review(page)
    fixtures.expect_action("review", hold="disposed-post")
    review_button(page).click()
    until(page, lambda: "disposed-post" in fixtures.held, "Disposal POST was not held")
    before = count_reads(fixtures)
    view_button(page, "Memory").click()
    expect(bench(page)).to_have_count(0)
    fixtures.release("disposed-post")
    page.wait_for_timeout(150)
    checks.check("Leaving Reviews suppresses late POST UI and follow-up evaluation reads", count_reads(fixtures) == before)
    open_reviews(page)
    expect(episode_button(page, 1)).to_be_visible()
    episode_button(page, 1).click()
    evidence(page, version=fixtures.versions[0])
    expect(bench(page).locator("summary").filter(has_text=re.compile("^Confirmed evaluation receipt$"))).to_have_count(0)
    checks.check("Remounted Reviews obtains fresh evidence without reviving the disposed local receipt", True)


def scoped_snapshot(page, checks, name, coarse):
    root = bench(page)
    root.get_by_role("heading", name="Semantic review bench", exact=True).evaluate("el=>el.scrollIntoView({block:'start'})")
    checks.check(name + ": pointer mode", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    checks.check(name + ": bench and page reflow", root.evaluate("el=>el.scrollWidth<=el.clientWidth+1") and
                 page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    checks.check(name + ": control target floor", root.locator("button:visible").evaluate_all(
        "(els,minimum)=>els.every(el=>el.getBoundingClientRect().height>=minimum-1)", 48 if coarse else 44))
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    page.add_script_tag(path=str(checks.axe))
    result = page.evaluate("""async selector => {
      const result = await axe.run(document.querySelector(selector),
        {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
      return {violations:result.violations.map(v=>({id:v.id,impact:v.impact,
        nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
        incomplete:result.incomplete.map(v=>v.id),passes:result.passes.length};
    }""", BENCH)
    (checks.output / (name + "-axe.json")).write_text(json.dumps(result, indent=2))
    checks.check(name + ": scoped axe", not result["violations"], result["violations"])


def exercise(browser, origin, credentials, checks, coarse):
    fixture = SemanticReviewFixtures(origin, max_writes=2 if coarse else 7)
    errors = []
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 320 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page = None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials,
                                     headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": isolated real login", login.ok)
        context.route("**/*", fixture.route)
        context.add_init_script("window.untrustedContentRan=false")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        if not coarse:
            fixture.read_plan("list", body={"error": "Synthetic initial evaluation read unavailable."}, status=503)
        navigate(page, origin, "/app/memory")
        open_reviews(page)
        if not coarse:
            expect(bench(page).get_by_text("Synthetic initial evaluation read unavailable.", exact=True)).to_be_visible()
            checks.check("Failed first read never reports zero reviewed cases", bench(page).get_by_text("Unavailable", exact=True).count() > 0 and
                         bench(page).get_by_text("0", exact=True).count() == 0)
            bench(page).get_by_role("button", name="Refresh semantic evaluation episodes", exact=True).click()
        evidence(page)
        episode_button(page, 3).click()
        evidence(page, 3)
        expect(bench(page).get_by_text("Synthetic source requires recollection before evaluation.", exact=True).first).to_be_visible()
        expect(bench(page).get_by_role("button", name="Measure ranks", exact=True)).to_be_disabled()
        checks.check(label + ": unavailable episode retains its disabled cause", True)
        episode_button(page, 1).click()
        evidence(page)

        if coarse:
            fill_review(page)
            fixture.expect_action("review")
            review_button(page).click()
            expect(bench(page).get_by_text("Review saved as evaluation evidence.", exact=False)).to_be_visible()
            fill_probe(page)
            fixture.expect_action("probe")
            bench(page).get_by_role("button", name="Measure ranks", exact=True).click()
            expect(bench(page).get_by_text("Retrieval ranks measured and sealed.", exact=False)).to_be_visible()
        else:
            read_races(page, fixture, checks)
            malformed_effect(page, fixture, checks, "review", "malformed")
            malformed_effect(page, fixture, checks, "review", "mismatch")
            accepted_with_failed_reads(page, fixture, checks, "review")
            malformed_effect(page, fixture, checks, "probe", "malformed")
            malformed_effect(page, fixture, checks, "probe", "mismatch")
            accepted_with_failed_reads(page, fixture, checks, "probe")
            disposal(page, fixture, checks)

        evidence(page, version=fixture.versions[0])
        checks.check(label + ": untrusted source text stays inert", page.evaluate("window.untrustedContentRan") is False)
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            scoped_snapshot(page, checks, f"semantic-review-{label}-{theme}", coarse)
        if coarse:
            fixture.read_plan("list", body={"candidates": [], "report": None, "reviewedCaseCount": 0})
            navigate(page, origin, "/app/memory")
            open_reviews(page)
            expect(bench(page).get_by_text("No episodes collected yet", exact=True)).to_be_visible()
            checks.check("Confirmed empty read distinguishes zero cases from unavailable counts", bench(page).get_by_text("0", exact=True).count() == 1)
        checks.check(label + ": exact bounded effect plans consumed", not fixture.actions and len(fixture.writes) == fixture.max_writes)
        checks.check(label + ": no unexpected effects, requests, popups or downloads", not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "writes": fixture.writes, "requests": fixture.requests,
                "heldReleases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / f"{label}-failure.png"), full_page=False)
            (checks.output / f"{label}-failure-dom.html").write_text(page.content())
        (checks.output / f"{label}-failure-requests.json").write_text(json.dumps({"writes": fixture.writes,
            "requests": fixture.requests, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/semantic-reviews")
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
        print(f"Semantic Reviews browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts,
            "failure": failure, "boundary": "Real isolated authentication and Memory→Reviews route. At most7 desktop and2 phone synthetic intercepted evaluation POSTs. No live providers, collection, activation or private production data. Axe scope: Semantic review bench only."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
