#!/usr/bin/env python3
"""Synthetic Accounts list/dossier browser checks; all effects stay in route.fulfill.

The real isolated login and actual Next routes are used. No CRM sync, OAuth,
external write, governed agent execution or provider action is invoked.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, quote, urlsplit
from playwright.sync_api import expect, sync_playwright
from accounts_fixtures import A, B, BASE, LONG, WORKSPACE, AccountsFixtures, digest, seal
from fixtures import STAMP
from run import Checks, REPO, navigate, preview, select_theme

ROOT = '[data-testid="customer-accounts-workspace"]'


def root(page): return page.locator(ROOT)

def dossier(page): return root(page).get_by_role("region", name="Account dossier", exact=True)

def until(page, predicate, label, timeout=20):
    end = time.monotonic() + timeout
    while not predicate() and time.monotonic() < end: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)


def ready(page, fixture, identity=A):
    expect(dossier(page).get_by_role("heading", name=fixture.selected(identity)["name"], exact=True)).to_be_visible()
    expect(root(page).get_by_role("button", name="New account", exact=True)).to_be_enabled()
    expect(dossier(page).get_by_role("button", name="Review Synthetic onboarding workflow", exact=True)).to_be_enabled()


def select_account(page, fixture, identity, coarse):
    if coarse and dossier(page).is_visible(): dossier(page).get_by_role("button", name="Back to account list", exact=True).click()
    root(page).get_by_role("complementary", name="Customer account list").get_by_role("button", name=re.compile("^" + re.escape(fixture.selected(identity)["name"]))).click()
    ready(page, fixture, identity)


def disclosure(scope, label):
    control = scope.locator("summary").filter(has_text=re.compile("^" + re.escape(label) + "$"))
    if not control.evaluate("el=>el.parentElement.open"): control.click()
    return control.locator("xpath=..")


def capture(page, checks, label, coarse, target=None, axe=True):
    page.evaluate("window.scrollTo(0,0)")
    page.wait_for_timeout(150)
    checks.check(label + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    checks.check(label + ": no page overflow", page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    checks.check(label + ": control target floor", root(page).locator("button:visible,select:visible,input:visible,a:visible,summary:visible").evaluate_all(
        "(els,min)=>els.every(el=>el.getBoundingClientRect().height>=min-1)", 48 if coarse else 44))
    if axe:
        page.add_script_tag(path=str(checks.axe))
        report = page.evaluate("""async selector=>{const r=await axe.run(document.querySelector(selector),
          {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
          return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
            incomplete:r.incomplete.map(v=>v.id),passes:r.passes.length};}""", ROOT)
        (checks.output / (label + "-axe.json")).write_text(json.dumps(report, indent=2))
        checks.check(label + ": Accounts scoped axe", not report["violations"], report["violations"])
    if target is not None: target.evaluate("el=>el.scrollIntoView({block:'center'})")
    page.screenshot(path=str(checks.output / (label + ".png")), full_page=False)
    checks.check(label + ": viewport capture retained pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)


def presentation(page, fixture, checks, coarse):
    ready(page, fixture)
    exact = disclosure(dossier(page), "Account identity, revision and permissions")
    checks.check("Full account identity and hash are selectable", A in exact.inner_text() and fixture.selected()["accountSha256"] in exact.inner_text())
    source = dossier(page).locator("summary").filter(has_text="Exact fact and source evidence:").first
    source.click()
    checks.check("Full fact source and conflicting IDs remain available", fixture.dossier(A)["facts"][0]["fact"]["source"]["sourceRevisionId"] in source.locator("xpath=..").inner_text())
    expect(dossier(page).get_by_text("Neither value was silently selected.", exact=False).first).to_be_visible()
    dossier(page).get_by_role("button", name="Show more renewal (2 remaining)", exact=True).click()
    checks.check("Returned fact evidence remains reachable beyond first five rows", dossier(page).locator("summary").filter(has_text="Exact fact and source evidence:").count() == 7)
    dossier(page).get_by_role("button", name="Show more account timeline (2 remaining)", exact=True).click()
    expect(dossier(page).get_by_text("Exact source update 6", exact=True)).to_be_visible()
    approval = dossier(page).get_by_role("link", name="Review Synthetic customer approval", exact=True)
    destination = urlsplit(approval.get_attribute("href"))
    checks.check("Exact approval link carries kind, ID and dossier return", destination.path == "/app/approvals" and parse_qs(destination.query) == {"id": ["approval:account/+exact"], "kind": ["tool"], "returnTo": ["/app/accounts/" + quote(A, safe="")]})
    expect(dossier(page).get_by_text("No health score yet", exact=True)).to_be_visible()
    checks.check("No unavailable health is presented as healthy", dossier(page).get_by_text("healthy", exact=True).count() == 0)
    select_account(page, fixture, B, coarse)
    if coarse:
        dossier(page).get_by_role("button", name="Back to account list", exact=True).click()
        expect(root(page).get_by_role("complementary", name="Customer account list").get_by_role("button", name=re.compile("^Synthetic customer B"))).to_be_focused()
        checks.check("Phone Back restores selected account focus", True)
    select_account(page, fixture, A, coarse)


def drafts(page, fixture, checks):
    trigger = root(page).get_by_role("button", name="New account", exact=True)
    trigger.click()
    editor = page.get_by_role("dialog", name="New Account 360", exact=True)
    expect(editor).to_be_visible()
    editor.get_by_role("textbox", name="Account name", exact=True).fill("Retained synthetic draft")
    editor.get_by_role("button", name="Recheck workspace access", exact=True).click()
    expect(editor.get_by_role("button", name="Create Account 360", exact=True)).to_be_enabled()
    expect(editor.get_by_role("textbox", name="Account name", exact=True)).to_have_value("Retained synthetic draft")
    for _ in range(14):
        page.keyboard.press("Tab")
        checks.check("Native account editor keeps application focus inside the modal", editor.evaluate("el=>el.contains(document.activeElement)") or not page.evaluate("document.hasFocus()"))
    page.keyboard.press("Escape")
    expect(editor).to_have_count(0)
    expect(trigger).to_be_focused()
    checks.check("Closing account draft restores focus and sends no effect", not fixture.writes)
    workflow = dossier(page).get_by_role("button", name="Review Synthetic onboarding workflow", exact=True)
    workflow.click()
    editor = page.get_by_role("dialog", name="Synthetic onboarding", exact=True)
    editor.get_by_role("textbox", name="Objective", exact=True).fill("Preserved objective")
    editor.get_by_role("textbox", name="Success criteria · one per line", exact=True).fill("Review exact sources")
    fixture.plan("workflows", identity=A, body={"error": "Synthetic optional workflow read failed."}, status=503)
    editor.get_by_role("button", name="Recheck account sources", exact=True).click()
    expect(root(page).get_by_text("Synthetic optional workflow read failed.", exact=False)).to_be_attached()
    expect(editor.get_by_role("button", name="Create workflow project", exact=True)).to_be_disabled()
    expect(editor.get_by_role("textbox", name="Objective", exact=True)).to_have_value("Preserved objective")
    editor.get_by_role("button", name="Recheck account sources", exact=True).click()
    expect(editor.get_by_role("button", name="Create workflow project", exact=True)).to_be_enabled()
    expect(editor.get_by_role("textbox", name="Objective", exact=True)).to_have_value("Preserved objective")
    editor.get_by_role("button", name="Cancel", exact=True).click()
    expect(workflow).to_be_focused()
    checks.check("Workflow drafts survive source failure and recovery without a project effect", not fixture.writes)


def read_races(page, fixture, checks):
    old = fixture.response("intelligence", A)
    old["intelligence"]["nextBestAction"]["title"] = "OLD_ACCOUNT_MUST_NOT_REAPPEAR"
    fixture.plan("intelligence", identity=A, hold="old-intelligence", body=old)
    root(page).get_by_role("button", name="Refresh accounts", exact=True).click()
    until(page, lambda: "old-intelligence" in fixture.held, "Account intelligence was not held")
    select_account(page, fixture, B, False)
    fixture.release("old-intelligence")
    expect(root(page).get_by_text("OLD_ACCOUNT_MUST_NOT_REAPPEAR", exact=True)).to_have_count(0)
    checks.check("Old account optional reply cannot update newly selected dossier", True)
    select_account(page, fixture, A, False)
    fixture.plan("health", identity=A, body={"error": "Synthetic health read failed."}, status=503)
    root(page).get_by_role("button", name="Refresh accounts", exact=True).click()
    expect(root(page).get_by_text("Synthetic health read failed.", exact=False)).to_be_visible()
    expect(dossier(page).get_by_role("heading", name=fixture.selected()["name"], exact=True)).to_be_visible()
    expect(dossier(page).get_by_role("heading", name="What needs attention now", exact=True)).to_be_visible()
    checks.check("Optional health failure keeps dossier and intelligence independently usable", True)
    root(page).get_by_role("button", name="Retry customer health", exact=True).click()
    expect(root(page).get_by_role("button", name="Retry customer health", exact=True)).to_have_count(0)
    fixture.mode = "error"
    root(page).get_by_role("button", name="Refresh accounts", exact=True).click()
    expect(root(page).get_by_role("button", name="Retry account dossier", exact=True)).to_be_visible()
    expect(dossier(page).get_by_role("heading", name=fixture.selected()["name"], exact=True)).to_be_visible()
    checks.check("Failed populated refresh retains exact dossier and labels counts last loaded", "last loaded workspace list" in root(page).inner_text() and "Refresh unavailable; last-loaded details are shown." in root(page).inner_text())
    fixture.mode = "ready"
    root(page).get_by_role("button", name="Refresh accounts", exact=True).click(); ready(page, fixture)


def reviewed_effects(page, fixture, checks):
    path = BASE + "/" + quote(A, safe="")
    old = copy.deepcopy(fixture.selected())
    body = {"workspaceId": WORKSPACE, "expectedRevision": old["revision"], "lifecycle": "at_risk"}
    dossier(page).get_by_role("button", name="Revise lifecycle", exact=True).click()
    dossier(page).get_by_role("combobox", name="Account lifecycle", exact=True).select_option("at_risk")
    checks.check("Selecting a lifecycle is local until explicit Save", not fixture.writes)
    fixture.expect_effect(path, "PATCH", body, {"account": fixture.selected(B)})
    dossier(page).get_by_role("button", name="Save lifecycle", exact=True).click()
    expect(root(page).get_by_text("The action is not confirmed here.", exact=False)).to_be_visible()
    expect(dossier(page).get_by_role("combobox", name="Account lifecycle", exact=True)).to_have_value("at_risk")
    checks.check("Mismatched effect receipt retains reviewed lifecycle without claiming confirmation", root(page).get_by_role("region", name="Confirmed account action").count() == 0)
    updated = fixture.account(A, old["name"], revision=2, lifecycle="at_risk")
    fixture.expect_effect(path, "PATCH", body, {"account": updated}, hold="lifecycle-effect")
    dossier(page).get_by_role("button", name="Save lifecycle", exact=True).click()
    until(page, lambda: "lifecycle-effect" in fixture.held, "Lifecycle effect was not intercepted")
    expect(root(page).get_by_role("button", name="New account", exact=True)).to_be_disabled()
    expect(dossier(page).get_by_role("combobox", name="Account lifecycle", exact=True)).to_be_disabled()
    expect(dossier(page).get_by_role("button", name="Review Synthetic onboarding workflow", exact=True)).to_be_disabled()
    checks.check("One action excludes duplicate and cross-action submission", len(fixture.writes) == 2 and fixture.writes[0]["idempotencyKey"] == fixture.writes[1]["idempotencyKey"])
    fixture.accounts[0] = updated
    fixture.plan("detail", identity=A, hold="accepted-followup", body={"error": "Synthetic confirmed lifecycle refresh failed."}, status=503)
    fixture.release("lifecycle-effect")
    until(page, lambda: "accepted-followup" in fixture.held, "Accepted receipt followup was not held")
    expect(root(page).get_by_role("region", name="Confirmed account action").get_by_text("lifecycle revised to at risk.", exact=False)).to_be_visible()
    expect(root(page).get_by_role("button", name="Refresh accounts", exact=True)).to_be_enabled()
    fixture.release("accepted-followup")
    expect(root(page).get_by_text("Synthetic confirmed lifecycle refresh failed.", exact=False)).to_be_visible()
    checks.check("Accepted lifecycle receipt is independent of hung/failed followup reads", "lifecycle revised to at risk." in root(page).get_by_role("region", name="Confirmed account action").inner_text())
    root(page).get_by_role("button", name="Retry account dossier", exact=True).click(); ready(page, fixture)
    current = fixture.selected()
    score = seal({"tenantId": fixture.tenant, "workspaceId": WORKSPACE, "accountId": A, "accountRevisionId": current["revisionId"], "accountSha256": current["accountSha256"],
        "scoreRevisionId": "customer-health-score:" + "f"*64 + ":v1", "revision": 1, "policy": {"policyVersion": "asael-customer-health:1"}, "scoreBasisPoints": None,
        "status": "unknown", "confidenceBasisPoints": 0, "coverageBasisPoints": 0, "factors": [], "suggestions": [], "authority": "deterministic_policy", "evaluatedAt": STAMP}, "scoreSha256")
    fixture.expect_effect(path + "/health", "POST", {"workspaceId": WORKSPACE, "expectedAccountRevision": 2, "expectedAccountSha256": current["accountSha256"]}, {"score": score})
    fixture.scores[A] = score
    dossier(page).get_by_role("region", name="Explainable customer health", exact=True).get_by_role("button", name="Evaluate health", exact=True).click()
    expect(root(page).get_by_role("region", name="Confirmed account action").get_by_text("health evaluated as unknown", exact=False)).to_be_visible()
    checks.check("Unknown evaluated health is not promoted to healthy", dossier(page).get_by_role("region", name="Explainable customer health").get_by_text("Unknown", exact=True).count() == 1)
    dossier(page).get_by_role("button", name="Review Synthetic onboarding workflow", exact=True).click()
    editor = page.get_by_role("dialog", name="Synthetic onboarding", exact=True)
    editor.get_by_role("textbox", name="Objective", exact=True).fill("Review exact customer evidence.")
    editor.get_by_role("textbox", name="Success criteria · one per line", exact=True).fill("Sources reviewed")
    submitted = {"workflowId": "onboarding", "objective": "Review exact customer evidence.", "targetDate": None, "successCriteria": ["Sources reviewed"], "productNames": [], "stakeholderIds": []}
    run_id = "customer-success-run:" + "f"*64
    run = seal({"tenantId": fixture.tenant, "workspaceId": WORKSPACE, "accountId": A, "accountRevisionId": current["revisionId"], "accountSha256": current["accountSha256"], "runId": run_id,
        "runRevisionId": run_id + ":v1", "revision": 1, "workflowId": "onboarding", "definitionSha256": fixture.pack[0]["definitionSha256"], "projectId": "project:exact/+synthetic",
        "input": submitted, "outcome": {"status": "in_progress", "nextAction": "Review exact source evidence before any external action.", "receiptSha256": digest(submitted)}}, "runSha256")
    fixture.expect_effect(path + "/workflows", "POST", {"workspaceId": WORKSPACE, "expectedAccountRevision": 2, "expectedAccountSha256": current["accountSha256"], "input": submitted}, {"run": run})
    fixture.runs[A] = [run]
    editor.get_by_role("button", name="Create workflow project", exact=True).click()
    expect(editor).to_have_count(0)
    expect(root(page).get_by_role("region", name="Confirmed account action").get_by_text("project created", exact=False)).to_be_visible()
    link = dossier(page).get_by_role("link", name="Open project", exact=True)
    checks.check("Workflow acceptance retains exact project destination and input receipt", parse_qs(urlsplit(link.get_attribute("href")).query) == {"project": ["project:exact/+synthetic"]})
    # Leave the exact deep route with a still-pending action. No server call is
    # forwarded, and the late synthetic receipt must not enter the new scope.
    dossier(page).get_by_role("button", name="Revise lifecycle", exact=True).click()
    dossier(page).get_by_role("combobox", name="Account lifecycle", exact=True).select_option("active")
    late = fixture.account(A, "OLD_SCOPE_RECEIPT_MUST_NOT_APPEAR", revision=3, lifecycle="active")
    fixture.expect_effect(path, "PATCH", {"workspaceId": WORKSPACE, "expectedRevision": 2, "lifecycle": "active"}, {"account": late}, hold="old-scope-effect")
    dossier(page).get_by_role("button", name="Save lifecycle", exact=True).click()
    until(page, lambda: "old-scope-effect" in fixture.held, "Old-scope effect was not held")
    dossier(page).get_by_role("link", name="Portfolio", exact=True).click()
    expect(page).to_have_url(re.compile(r"/app/accounts$"))
    ready(page, fixture)
    fixture.release("old-scope-effect")
    expect(root(page).get_by_text("OLD_SCOPE_RECEIPT_MUST_NOT_APPEAR", exact=False)).to_have_count(0)
    checks.check("External dossier-route change disposes pending receipt and starts a fresh local view", root(page).get_by_role("region", name="Confirmed account action").count() == 0 and not fixture.effects)


def exercise(browser, origin, credentials, checks, coarse):
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    label = "phone" if coarse else "desktop"
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        session = context.request.get(origin + "/api/auth/session").json()
        fixture = AccountsFixtures(origin, session)
        fixture.mode = "error"
        context.route("**/*", fixture.route)
        context.expose_binding("__recordAccountsBoundary", lambda source, event: fixture.unexpected.append(event))
        context.add_init_script("""window.__accountsForbidden=[];const record=event=>{window.__accountsForbidden.push(event);window.__recordAccountsBoundary(event);};window.open=(...args)=>{record({kind:'popup',args});return null;};HTMLMediaElement.prototype.play=function(){record({kind:'playback'});return Promise.reject(new Error('Playback prohibited'));};""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/accounts/" + quote(A, safe=""))
        expect(root(page).get_by_role("heading", name="Account dossier unavailable", exact=True)).to_be_visible()
        checks.check(label + ": failed initial reads do not invent empty or zero counts", root(page).get_by_text("Unavailable", exact=True).count() >= 4 and root(page).get_by_text("No customer accounts were returned in this workspace.", exact=True).count() == 0)
        fixture.mode = "ready"
        root(page).get_by_role("button", name="Refresh accounts", exact=True).click()
        presentation(page, fixture, checks, coarse)
        drafts(page, fixture, checks)
        if not coarse:
            read_races(page, fixture, checks)
            reviewed_effects(page, fixture, checks)
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            capture(page, checks, f"accounts-{label}-{theme}", coarse, dossier(page).get_by_role("heading", name=fixture.selected()["name"], exact=True))
            capture(page, checks, f"accounts-{label}-{theme}-crm", coarse, root(page).get_by_role("heading", name="Salesforce sync", exact=True), axe=False)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 812})
            for theme in ("light", "dark"):
                select_theme(page, theme, True)
                capture(page, checks, f"accounts-320-{theme}", True, dossier(page).get_by_role("heading", name=fixture.selected()["name"], exact=True))
        page.evaluate("document.documentElement.style.fontSize='200%'")
        capture(page, checks, f"accounts-{label}-text-200", coarse, dossier(page), axe=False)
        page.evaluate("document.documentElement.style.fontSize=''")
        page.emulate_media(forced_colors="active")
        capture(page, checks, f"accounts-{label}-forced-colors", coarse, dossier(page), axe=False)
        page.emulate_media(forced_colors="none")
        checks.check(label + ": reduced motion remains active", page.evaluate("matchMedia('(prefers-reduced-motion:reduce)').matches"))
        fixture.mode = "empty"
        navigate(page, origin, "/app/accounts")
        expect(root(page).get_by_text("No customer accounts were returned in this workspace.", exact=True)).to_be_visible()
        expect(root(page).get_by_role("region", name="Customer account overview").get_by_text("Unavailable", exact=True)).to_have_count(0)
        checks.check(label + ": successful empty list establishes empty rather than unavailable", True)
        checks.check(label + ": no unexpected application, external, popup, download or media calls", not fixture.unexpected and not page.evaluate("window.__accountsForbidden"), fixture.unexpected)
        checks.check(label + ": exact local effect budget", len(fixture.writes) == (0 if coarse else 5) and not fixture.effects)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "reads": fixture.requests, "syntheticEffects": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        if fixture is not None: (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        if fixture is not None: fixture.abort_held()
        if page is not None and not page.is_closed(): page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/accounts")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file(): parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks, contexts, failure = Checks(args.output, args.axe.resolve()), [], None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True): contexts.append(exercise(browser, origin, credentials, checks, coarse))
            finally: browser.close()
    except Exception as error:
        failure = str(error); print(f"Accounts browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated auth and Accounts routes. Synthetic bounded UI read fixtures, five exact wholly intercepted effects on desktop (three lifecycle attempts, health, workflow), zero phone effects. No real CRM/OAuth/provider/agent effects. Create is draft/close-only here; canonical create receipts are covered by unit tests. All held routes settle or abort before context close. Axe scope is Customer Accounts."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
