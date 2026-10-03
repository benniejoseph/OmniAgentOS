#!/usr/bin/env python3
"""Quality, Monitoring, Security QA with exact wholly intercepted operations.

Root's serial browser owner runs this file. No live evaluation, monitor,
notification, marker, retention sweep, export, provider, or database effect.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import time
from playwright.sync_api import expect, sync_playwright
from operational_views_fixtures import CLUSTER, DIGEST, JOB, LONG, MESSAGE, POLICY_KEYS, PROPOSAL, OperationalFixtures
from fixtures import STAMP
from run import Checks, REPO, navigate, preview, select_theme

VIEWS = (("Quality", "/app/evaluations", "Evaluation runs"), ("Monitoring", "/app/observability", "SLO measurements"), ("Security", "/app/security", "Security audit"))


def root(page, title): return page.locator('[data-testid="operational-' + title.lower() + '"]')
def region(page, title, name): return root(page, title).get_by_role("region", name=name, exact=True)
def refresh(page, title):
    button = root(page, title).get_by_role("button", name="Refresh " + title.lower(), exact=True)
    expect(button).to_be_enabled()
    button.click()
    expect(button).to_be_enabled()


def until(page, predicate, label, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)


def settle(page): page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
def disclosure(scope, name):
    summary = scope.locator("summary").filter(has_text=re.compile("^" + re.escape(name) + "$"))
    if not summary.evaluate("el=>el.parentElement.open"): summary.click()
    return summary.locator("xpath=..")


def prepare(page, title, action):
    scope = region(page, title, action)
    scope.get_by_role("button", name="Review " + action.lower(), exact=True).focus()
    page.keyboard.press("Enter")
    expect(scope.get_by_role("button", name="Keep editing", exact=True)).to_be_focused()
    return scope


def confirm(scope, action): scope.get_by_role("button", name="Confirm " + action.lower(), exact=True).click()


def capture(page, checks, title, name, coarse, target=None, axe=True):
    (target or root(page, title)).evaluate("el=>el.scrollIntoView({block:'start'})")
    settle(page)
    checks.check(name + ": document reflows", page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    controls = root(page, title).locator("button:visible,select:visible,input:visible,textarea:visible,a:visible,summary:visible")
    bad = controls.evaluate_all("""(els,min)=>els.flatMap(el=>{
      const target=el.matches('input[type=checkbox]')?(el.closest('label')||el):el;
      const r=target.getBoundingClientRect();return r.height<min-1?[{name:el.textContent||el.name,height:r.height}]:[];
    })""", 48 if coarse else 44)
    checks.check(name + ": control targets", not bad, bad)
    if axe:
        if not page.evaluate("Boolean(window.axe)"): page.add_script_tag(path=str(checks.axe))
        report = root(page, title).evaluate("""async el=>{const r=await axe.run(el,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
          return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>v.id),passes:r.passes.length};}""")
        (checks.output / (name + "-axe.json")).write_text(json.dumps(report, indent=2))
        checks.check(name + ": scoped axe", not report["violations"], report["violations"])
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)


def read_states(page, fixture, origin, checks, title, route, main, label):
    fixture.mode = "error"
    navigate(page, origin, route)
    expect(root(page, title).get_by_role("heading", name=title, exact=True)).to_be_visible()
    expect(region(page, title, main).get_by_text("Unavailable", exact=True)).to_be_visible()
    checks.check(label + " " + title + ": initial read failure does not claim empty", "No records in this loaded view." not in region(page, title, main).inner_text())
    fixture.mode = "ready"
    refresh(page, title)
    expect(region(page, title, main).get_by_text("Loaded snapshot", exact=False)).to_be_visible()
    fixture.mode = "error"
    refresh(page, title)
    expect(region(page, title, main).get_by_text("Refresh unavailable · last loaded data", exact=False)).to_be_visible()
    checks.check(label + " " + title + ": failed refresh preserves identified snapshot", True)
    fixture.mode = "ready"
    refresh(page, title)


def quality_effects(page, fixture, checks):
    title, action = "Quality", "Run evaluations"
    panel = region(page, title, action)
    panel.get_by_label("Suite name", exact=True).fill("frozen-suite")
    prepare(page, title, action)
    panel.get_by_label("Suite name", exact=True).fill("new unsent draft")
    submitted = {"suite": "frozen-suite", "maxSafetyMode": "synthetic"}
    fixture.expect_effect("/api/evaluations", submitted, {"error": "Synthetic lost outcome after possible admission."}, status=503, hold="enqueue-uncertain")
    confirm(panel, action)
    until(page, lambda: "enqueue-uncertain" in fixture.held, "Evaluation request did not reach exact held fixture")
    expect(panel.get_by_role("button", name="Review run evaluations", exact=True)).to_be_disabled()
    panel.get_by_label("Suite name", exact=True).fill("draft survives pending request")
    fixture.release("enqueue-uncertain")
    expect(root(page, title).get_by_role("heading", name="Outcome unconfirmed", exact=True)).to_be_visible()
    fixture.expect_effect("/api/evaluations", submitted, {"job": fixture.job()}, status=202, hold="enqueue-accepted")
    fixture.plan("evaluations", body={"error": "Synthetic refresh unavailable after confirmed receipt."}, status=503, hold="receipt-refresh")
    root(page, title).get_by_role("button", name="Retry exact request", exact=True).click()
    until(page, lambda: "enqueue-accepted" in fixture.held, "Retry did not enter held fixture")
    fixture.release("enqueue-accepted")
    until(page, lambda: "receipt-refresh" in fixture.held, "Post-receipt read was not held")
    receipt = region(page, title, "Last confirmed action")
    expect(receipt.get_by_role("heading", name="Evaluation request accepted", exact=True)).to_be_visible()
    expect(panel.get_by_role("button", name="Review run evaluations", exact=True)).to_be_enabled()
    expect(panel.get_by_label("Suite name", exact=True)).to_have_value("draft survives pending request")
    checks.check("Quality: retry retains exact body and UUID key", fixture.writes[0]["body"] == fixture.writes[1]["body"] and fixture.writes[0]["idempotencyKey"] == fixture.writes[1]["idempotencyKey"])
    disclosure(receipt, "Submitted request and returned receipt")
    expect(receipt.get_by_text(JOB, exact=True)).to_be_visible()
    expect(receipt.get_by_text("queued", exact=True).first).to_be_visible()
    receipt.get_by_role("button", name="Copy receipt", exact=True).click()
    until(page, lambda: len(page.evaluate("window.__operationalCopies")) == 1, "Receipt was not copied to local test stub")
    copied = json.loads(page.evaluate("window.__operationalCopies[0]"))
    checks.check("Quality: copied receipt retains submitted suite and returned job identity", copied["submission"]["body"] == submitted and ["Job ID", JOB] in copied["receipt"]["details"])
    fixture.release("receipt-refresh")
    expect(region(page, title, "Evaluation runs").get_by_text("Refresh unavailable · last loaded data", exact=False)).to_be_visible()
    expect(receipt.get_by_role("heading", name="Evaluation request accepted", exact=True)).to_be_visible()
    checks.check("Quality: confirmed enqueue settles before and survives unrelated failed GET", True)
    review = region(page, title, "Review proposal")
    review.get_by_label("Proposal ID", exact=True).fill(PROPOSAL)
    review.get_by_label("Review reason", exact=False).fill("Reviewed the exact synthetic proposal.")
    body = {"action": "review", "proposalId": PROPOSAL, "decision": "approved", "reason": "Reviewed the exact synthetic proposal."}
    proposal = {**fixture.proposal, "status": "approved", "reviewedBy": fixture.actor, "reviewedAt": STAMP, "reviewReason": body["reason"]}
    fixture.expect_effect("/api/evaluations/failure-feedback", body, {"proposal": proposal, "applied": False})
    prepare(page, title, "Review proposal")
    expect(review.get_by_text(DIGEST, exact=True)).to_be_visible()
    fixture.proposal = proposal
    confirm(review, "Review proposal")
    expect(region(page, title, "Last confirmed action").get_by_role("heading", name="Proposal review recorded", exact=True)).to_be_visible()
    expect(review.get_by_label("Review reason", exact=False)).to_have_value(body["reason"])
    replay = region(page, title, "Replay failure case")
    replay.get_by_label("Failure cluster ID", exact=True).fill(CLUSTER)
    fixture.expect_effect("/api/evaluations/failure-feedback", {"action": "replay", "clusterId": CLUSTER}, {"error": "Failure replay case definition changed; review a new minimized case."}, status=409)
    prepare(page, title, "Replay failure case")
    confirm(replay, "Replay failure case")
    expect(root(page, title).get_by_role("heading", name="Request not accepted", exact=True)).to_be_visible()
    expect(root(page, title).get_by_role("button", name="Retry exact request", exact=True)).to_have_count(0)
    expect(region(page, title, "Last confirmed action").get_by_role("heading", name="Proposal review recorded", exact=True)).to_be_visible()
    checks.check("Quality: exact proposal review stays inactive; stale replay is rejected without erasing receipt", True)


def monitor_effects(page, fixture, checks):
    panel = region(page, "Monitoring", "Run SLO monitor")
    panel.get_by_label("Queue alerts for breached policies", exact=True).uncheck()
    panel.get_by_label("Dispatch pending alerts now (up to 10)", exact=True).check()
    result = {**fixture.slo(), "trigger": "operator.api", "actorId": fixture.actor, "queuedAlerts": 0, "incidentActions": []}
    delivery = {"id": "synthetic-dispatch:" + LONG, "tenantId": fixture.tenant, "status": "failed", "lastError": MESSAGE}
    fixture.expect_effect("/api/observability/slo", {"action": "run_monitor", "queueAlerts": False, "dispatchAlerts": True}, {"result": result, "dispatch": {"processed": [delivery], "delivered": 0, "skipped": 0, "failed": 1}})
    prepare(page, "Monitoring", "Run SLO monitor")
    expect(panel.get_by_text("This endpoint has no request replay guarantee.", exact=False)).to_be_visible()
    confirm(panel, "Run SLO monitor")
    receipt = region(page, "Monitoring", "Last confirmed action")
    expect(receipt.get_by_role("heading", name="SLO monitor returned", exact=True)).to_be_visible()
    expect(receipt.get_by_text("Insufficient samples", exact=True)).to_be_visible()
    disclosure(receipt, "Submitted request and returned receipt")
    expect(receipt.get_by_text(delivery["id"], exact=True)).to_be_visible()
    marker = region(page, "Monitoring", "Record marker")
    marker.get_by_label("Marker message", exact=True).fill("Synthetic marker held as an uncertain outcome.")
    fixture.expect_effect("/api/observability", {"action": "record_marker", "message": "Synthetic marker held as an uncertain outcome.", "level": "info", "category": "system"}, {})
    prepare(page, "Monitoring", "Record marker")
    confirm(marker, "Record marker")
    expect(root(page, "Monitoring").get_by_role("heading", name="Outcome unconfirmed", exact=True)).to_be_visible()
    expect(root(page, "Monitoring").get_by_role("button", name="Retry exact request", exact=True)).to_have_count(0)
    expect(marker.get_by_role("button", name="Review record marker", exact=True)).to_be_disabled()
    root(page, "Monitoring").get_by_role("button", name="Dismiss outcome notice", exact=True).click()
    checks.check("Monitoring: actual delivery failure and insufficient samples stay distinct; malformed marker is uncertain without auto retry", True)


def retention_effect(page, fixture, checks):
    panel = region(page, "Security", "Sweep tenant retention")
    prepare(page, "Security", "Sweep tenant retention")
    expect(panel.get_by_text("This is a local review", exact=False)).to_be_visible()
    panel.get_by_role("button", name="Keep editing", exact=True).focus()
    page.keyboard.press("Enter")
    expect(panel.get_by_role("button", name="Review sweep tenant retention", exact=True)).to_be_focused()
    prepare(page, "Security", "Sweep tenant retention")
    frozen = disclosure(panel, "Policy snapshot reviewed with this request")
    expect(frozen.locator("dt").filter(has_text=re.compile("^runContentDays$")).locator("xpath=../dd")).to_have_text("30 days")
    fixture.policy["runContentDays"] = 60
    refresh(page, "Security")
    expect(frozen.locator("dt").filter(has_text=re.compile("^runContentDays$")).locator("xpath=../dd")).to_have_text("30 days")
    result = {"backend": "bounded_local", "scope": "tenant", "tenantId": fixture.tenant, "policy": copy.deepcopy(fixture.policy), "deleted": {"runs": 2, "securityAudits": 0}, "batchLimit": 200, "moreAvailable": True, "completedAt": STAMP}
    fixture.expect_effect("/api/security/retention", {"scope": "tenant"}, {"result": result})
    confirm(panel, "Sweep tenant retention")
    receipt = region(page, "Security", "Last confirmed action")
    expect(receipt.get_by_role("heading", name="Retention sweep returned", exact=True)).to_be_visible()
    expect(receipt.get_by_text("Bounded batch completed · more available", exact=True)).to_be_visible()
    disclosure(receipt, "Submitted request and returned receipt")
    expect(receipt.locator("dt").filter(has_text=re.compile("^Applied policy · runContentDays$")).locator("xpath=../dd")).to_have_text("60 days")
    checks.check("Security: cancel restores keyboard position and frozen policy review is separate from actual applied policy", fixture.writes[-1]["body"] == {"scope": "tenant"})


def dispose_effect(page, fixture, origin, checks):
    navigate(page, origin, "/app/evaluations")
    panel = region(page, "Quality", "Run evaluations")
    expect(panel.get_by_role("button", name="Review run evaluations", exact=True)).to_be_enabled()
    fixture.expect_effect("/api/evaluations", {"suite": "operator-console", "maxSafetyMode": "synthetic"}, {"job": fixture.job(identity="disposed-job-must-not-reappear")}, status=202, hold="disposed-effect")
    prepare(page, "Quality", "Run evaluations")
    confirm(panel, "Run evaluations")
    until(page, lambda: "disposed-effect" in fixture.held, "Dispose effect not held")
    navigate(page, origin, "/app/security")
    fixture.release("disposed-effect")
    expect(root(page, "Security")).to_be_visible()
    expect(root(page, "Security").get_by_text("disposed-job-must-not-reappear", exact=True)).to_have_count(0)
    navigate(page, origin, "/app/evaluations")
    expect(region(page, "Quality", "Last confirmed action")).to_have_count(0)
    checks.check("Quality: navigation disposes local effect receipt; no cancellation of server work is claimed", True)


def exercise(browser, origin, credentials, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture, page, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        fixture = OperationalFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        context.route("**/*", fixture.route)
        context.add_init_script("""window.__operationalForbidden=[];window.__operationalCopies=[];
          const stop=kind=>{window.__operationalForbidden.push(kind);throw Error('Forbidden effect: '+kind)};
          if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>stop('microphone');
          HTMLMediaElement.prototype.play=async()=>stop('playback');window.open=()=>stop('popup');
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__operationalCopies.push(text)}}});""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("download", lambda _download: fixture.unexpected.append({"kind": "download_event"}))
        page.on("popup", lambda _popup: fixture.unexpected.append({"kind": "popup_event"}))
        for title, path, main in VIEWS:
            read_states(page, fixture, origin, checks, title, path, main, label)
            for theme in ("light", "dark"):
                select_theme(page, theme, coarse)
                capture(page, checks, title, f"operations-{label}-{title.lower()}-{theme}", coarse)
            if title == "Quality":
                expect(region(page, title, "Evaluation runs").get_by_text("completed", exact=True)).to_be_visible()
                expect(region(page, title, "Evaluation runs").get_by_text(MESSAGE, exact=True)).to_be_visible()
                panel = region(page, title, "Run evaluations")
                panel.get_by_label("Suite name", exact=True).fill("preserved read draft")
                refresh(page, title)
                expect(panel.get_by_label("Suite name", exact=True)).to_have_value("preserved read draft")
                if not coarse: quality_effects(page, fixture, checks)
            elif title == "Monitoring":
                expect(region(page, title, "SLO measurements").get_by_text("Insufficient samples", exact=True).first).to_be_visible()
                if not coarse: monitor_effects(page, fixture, checks)
            else:
                link = region(page, title, "Signed audit chain").get_by_role("link", name="Download signed audit", exact=True)
                expect(link).to_have_attribute("href", "/api/security/audits/export")
                checks.check(label + ": signed export exact endpoint retained without invoking download", link.get_attribute("download") is not None)
                disclosure(region(page, title, "Tenant isolation"), "Table policy evidence")
                if not coarse: retention_effect(page, fixture, checks)
            panel_name = {"Quality": "Run evaluations", "Monitoring": "Run SLO monitor", "Security": "Sweep tenant retention"}[title]
            panel = region(page, title, panel_name)
            prepare(page, title, panel_name)
            capture(page, checks, title, f"operations-{label}-{title.lower()}-review", coarse, panel)
            panel.get_by_role("button", name="Keep editing", exact=True).focus()
            page.keyboard.press("Enter")
            expect(panel.get_by_role("button", name="Review " + panel_name.lower(), exact=True)).to_be_focused()
            focus = panel.get_by_role("button", name="Review " + panel_name.lower(), exact=True).evaluate("el=>{const s=getComputedStyle(el);return {width:s.outlineWidth,offset:s.outlineOffset,gap:s.boxShadow}}")
            checks.check(label + " " + title + ": 3px keyboard focus after cancel", focus["width"] == "3px" and focus["offset"] == "3px" and "3px" in focus["gap"], focus)
            if coarse:
                page.set_viewport_size({"width": 320, "height": 812}); settle(page)
                capture(page, checks, title, "operations-320-" + title.lower(), True, panel)
                page.set_viewport_size({"width": 390, "height": 844}); settle(page)
            normal = root(page, title).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
            page.evaluate("document.documentElement.style.fontSize='200%'"); settle(page)
            # The root style can update before rem descendants finish layout.
            # Wait for measured text growth, not merely for the inline value.
            page.wait_for_function("([selector,before])=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)>=before*1.99", arg=['[data-testid="operational-' + title.lower() + '"]', normal])
            scaled = root(page, title).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
            checks.check(label + " " + title + ": text scales to 200%", scaled >= normal * 1.99, {"normal": normal, "scaled": scaled, "computed": page.evaluate("() => ({html:getComputedStyle(document.documentElement).fontSize,body:getComputedStyle(document.body).fontSize,inline:document.documentElement.style.fontSize})"), "rules": root(page, title).evaluate("el=>{const out=[];const walk=rs=>{for(const r of rs){if(r.selectorText && el.matches(r.selectorText) && (r.style.fontSize||r.style.font))out.push(r.cssText);if(r.cssRules)walk(r.cssRules)}};for(const s of document.styleSheets){try{walk(s.cssRules)}catch{}}return out}")})
            capture(page, checks, title, f"operations-{label}-{title.lower()}-text-200", coarse, panel, axe=False)
            page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
            page.wait_for_function("([selector,before])=>Math.abs(parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)-before)<.1", arg=['[data-testid="operational-' + title.lower() + '"]', normal])
            page.emulate_media(forced_colors="active")
            capture(page, checks, title, f"operations-{label}-{title.lower()}-forced-colors", coarse, panel, axe=False)
            page.emulate_media(forced_colors="none")
            fixture.mode = "empty"; refresh(page, title)
            empty = {"Quality": "No evaluation runs in this loaded view.", "Monitoring": "No enabled policy measurements", "Security": "No audit records in this loaded view."}[title]
            expect(region(page, title, main).get_by_text(empty, exact=True)).to_be_visible()
            fixture.mode = "restricted"; refresh(page, title)
            expect(region(page, title, main).get_by_text("Restricted", exact=True)).to_be_visible()
            checks.check(label + " " + title + ": source 403 clears previously loaded records", region(page, title, main).locator("li").count() == 0)
            fixture.mode = "ready"
        if not coarse: dispose_effect(page, fixture, origin, checks)
        checks.check(label + ": exact synthetic effect budget", len(fixture.writes) == (0 if coarse else 8) and not fixture.effects)
        checks.check(label + ": untrusted evidence remains text", not page.evaluate("Boolean(window.operationalInjected)"))
        checks.check(label + ": no unexpected write, external request or device effect", not fixture.unexpected and not page.evaluate("window.__operationalForbidden"), fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "reads": fixture.requests, "syntheticEffects": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        if fixture is not None:
            (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        if fixture is not None: fixture.abort_held()
        if page is not None and not page.is_closed(): page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/operational-views")
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
        failure = str(error); print("Operational browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated authentication and actual Quality, Monitoring, Security routes. Synthetic exact bounded reads. At most eight fully intercepted desktop POST attempts: enqueue+same-key retry, proposal review, replay conflict, SLO result, malformed marker response, retention result, disposed enqueue. Zero phone effects. Signed export href is inspected only. No model/provider, actual evaluation, notification dispatch, marker persistence, retention deletion, export bytes, media, or third-party traffic is permitted. Source 403 fixtures test restricted resource display under an admin session, not a server role change. Unit permission/lifecycle coverage remains separate. Retention preview is local and does not bind policy or affected rows; SLO/marker/retention endpoints have no replay contract."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
