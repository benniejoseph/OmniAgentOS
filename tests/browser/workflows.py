#!/usr/bin/env python3
"""Actual Workflow operations UI with twelve exact, wholly intercepted effects.

No real planner, workflow start, scheduler tick, PolicyLease, recovery, quarantine
decision or provider operation runs. Phone coverage is GET-only.
"""
import argparse
import copy
from datetime import datetime
import json
from pathlib import Path
import re
import time
from playwright.sync_api import expect, sync_playwright
from run import Checks, REPO, navigate, preview, select_theme
from workflows_fixtures import BUDGET, JOB, LONG, PLAN, PROCEDURE, RUN, SCHEDULE, WorkflowFixtures, path

ROOT = '[data-testid="workflows-workspace"]'


def root(page): return page.locator(ROOT)
def view(page, name): root(page).get_by_role("group", name="Automation operations views").get_by_role("button", name=name, exact=True).click()
def until(page, predicate, label, timeout=20):
    end = time.monotonic() + timeout
    while not predicate() and time.monotonic() < end: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)
def settle(page): page.evaluate("() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
def ready(page):
    for label in ("Workflow runs", "Workflow plans", "Schedules and triggers", "Operations"):
        expect(root(page).get_by_text(label + " loaded.", exact=True)).to_be_attached()
def refresh(page, label): root(page).get_by_role("button", name="Refresh " + label, exact=True).click()
def confirmation(page): return root(page).get_by_role("region", name="Review workflow operation", exact=True)
def confirmed(page): return root(page).get_by_role("region", name="Confirmed workflow receipt", exact=True)
def confirm(page): confirmation(page).get_by_role("button", name="Confirm reviewed operation", exact=True).click()
def reviewed_body(page): return json.loads(confirmation(page).locator("pre").first.inner_text())
def detail(page): return root(page).get_by_role("region", name="Workflow run detail", exact=True)
def schedule_detail(page, name="Synthetic morning schedule"): return root(page).get_by_role("region", name="Schedule detail · " + name, exact=True)
def open_run(page, name="Synthetic exact workflow"):
    view(page, "Runs"); root(page).get_by_role("button", name="Inspect run · " + name, exact=True).click()
    expect(detail(page).get_by_text("Workflow run detail loaded.", exact=True)).to_be_visible()
def open_schedule(page, name="Synthetic morning schedule"):
    view(page, "Schedules"); root(page).get_by_role("button", name="Inspect " + name, exact=True).click()
    expect(schedule_detail(page, name).get_by_text("Schedule preview and history loaded.", exact=True)).to_be_visible()


GUARDS = r"""(() => {
  window.untrustedWorkflowRan=false;
  const report=event=>window.__workflowBoundary(event);
  window.open=(...args)=>{report({kind:'popup',args});return null;};
  HTMLMediaElement.prototype.play=function(){report({kind:'playback'});return Promise.reject(new Error('Playback prohibited'));};
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{report({kind:'microphone'});return Promise.reject(new Error('Media prohibited'));};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(this.download){report({kind:'programmatic_download'});return;}return click.call(this);};
})();"""


def capture(page, checks, name, coarse, target=None, axe=True):
    page.evaluate("window.scrollTo(0,0)"); settle(page)
    checks.check(name + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    geometry = page.evaluate("() => ({viewport:innerWidth,document:document.documentElement.scrollWidth})")
    checks.check(name + ": no document overflow", geometry["document"] <= geometry["viewport"] + 1, geometry)
    short = root(page).locator("button:visible,input:visible,select:visible,a:visible,summary:visible").evaluate_all("""(els,min)=>els.flatMap(el=>{const target=el.matches('input[type=checkbox]')?el.closest('label'):el;const r=target.getBoundingClientRect();return r.height<min-1?[{name:el.getAttribute('aria-label')||el.textContent,height:r.height}]:[];})""", 48 if coarse else 44)
    checks.check(name + ": accessible control targets", not short, short)
    if axe:
        if not page.evaluate("Boolean(window.axe)"): page.add_script_tag(path=str(checks.axe))
        result = page.evaluate("""async()=>{const r=await axe.run({exclude:[['nextjs-portal']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});return{violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>v.id),passes:r.passes.length};}""")
        (checks.output / (name + "-axe.json")).write_text(json.dumps(result, indent=2))
        checks.check(name + ": page-wide axe", not result["violations"], result["violations"])
    if target is not None:
        target.evaluate("el=>el.scrollIntoView({block:'start'})"); page.evaluate("window.scrollBy(0,-112)"); settle(page)
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    checks.check(name + ": viewport capture preserves pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)


def inspect_reads(page, fixture, checks):
    expect(root(page).get_by_text("Workflow runs unavailable. Counts and empty state could not be checked.", exact=True)).to_be_visible()
    checks.check("Unavailable reads do not claim empty or zero", "No workflow runs were returned" not in root(page).inner_text() and root(page).locator("dd").filter(has_text="Unavailable").count() >= 4)
    fixture.mode = "ready"; refresh(page, "workflow runs")
    expect(root(page).get_by_text("Workflow runs loaded.", exact=True)).to_be_visible()
    checks.check("Successful run read is independent of failed operations", "Synthetic exact workflow" in root(page).inner_text() and "Runnable queue jobs" in root(page).inner_text() and "Unavailable" in root(page).inner_text())
    root(page).get_by_role("button", name="Refresh workflow sources", exact=True).click(); ready(page)
    checks.check("Returned script text remains untrusted", not page.evaluate("window.untrustedWorkflowRan"))
    view(page, "Plans")
    root(page).get_by_role("textbox", name="Workflow goal", exact=True).fill("Retained workflow draft " + LONG)
    root(page).get_by_role("combobox", name="Workflow mode", exact=True).select_option("research")
    fixture.plan("plans", status=503); refresh(page, "workflow plans")
    expect(root(page).get_by_text("Refresh unavailable for workflow plans. Last-loaded records and counts remain visible.", exact=True)).to_be_visible()
    expect(root(page).get_by_role("button", name="Review plan preview", exact=True)).to_be_disabled()
    expect(root(page).get_by_role("textbox", name="Workflow goal", exact=True)).to_have_value("Retained workflow draft " + LONG)
    view(page, "Runs"); view(page, "Plans")
    expect(root(page).get_by_role("combobox", name="Workflow mode", exact=True)).to_have_value("research")
    checks.check("Plan draft and exact evidence survive failed refresh and view switches", PLAN in root(page).inner_text())
    refresh(page, "workflow plans"); ready(page)
    view(page, "Runs")
    old = fixture.body("runs"); old["runs"] = copy.deepcopy(old["runs"]); old["runs"][0]["goal"] = "OBSOLETE RUN MUST NOT REPLACE CURRENT"; old["runs"][0]["input"]["goal"] = old["runs"][0]["goal"]
    fixture.plan("runs", hold="old-list", body=old); refresh(page, "workflow runs")
    until(page, lambda: "old-list" in fixture.held, "Old list held")
    root(page).get_by_role("button", name="Restart workflow runs read", exact=True).click()
    expect(root(page).get_by_text("Workflow runs loaded.", exact=True)).to_be_visible()
    fixture.release("old-list"); settle(page)
    checks.check("Replaced list GET cannot overwrite the current snapshot", "OBSOLETE RUN" not in root(page).inner_text())
    open_run(page)
    detail(page).get_by_text("Exact run identity, input, outcome and evidence", exact=True).click()
    checks.check("Run inspector preserves exact identity, executing Agent and unverified outcome", RUN in detail(page).inner_text() and "scout" in detail(page).inner_text() and LONG in detail(page).inner_text())
    detail(page).get_by_role("button", name="Review pause run", exact=True).click()
    expect(confirmation(page)).to_be_visible(); confirmation(page).get_by_role("button", name="Cancel review", exact=True).click()
    expect(detail(page).get_by_role("button", name="Review pause run", exact=True)).to_be_focused()
    detail(page).get_by_role("button", name="Back to workflow runs", exact=True).click()
    expect(root(page).get_by_role("button", name="Inspect run · Synthetic exact workflow", exact=True)).to_be_focused()
    fixture.plan("run:" + RUN, hold="old-detail")
    root(page).get_by_role("button", name="Inspect run · Synthetic exact workflow", exact=True).click()
    until(page, lambda: "old-detail" in fixture.held, "Old run detail held")
    root(page).get_by_role("button", name="Inspect run · Synthetic failed run", exact=True).click()
    expect(detail(page).get_by_text("Workflow run detail loaded.", exact=True)).to_be_visible()
    fixture.release("old-detail"); settle(page)
    expect(detail(page).get_by_role("button", name="Review retry run", exact=True)).to_be_enabled()
    checks.check("Late old detail cannot replace the newly selected run", "Review pause run" not in detail(page).inner_text())
    detail(page).get_by_role("button", name="Back to workflow runs", exact=True).click()


def inspect_schedules(page, fixture, checks):
    open_schedule(page)
    panel = schedule_detail(page)
    checks.check("Schedule inspector distinguishes unavailable lease history", "PolicyLease history unavailable; its count is unknown." in panel.inner_text() and "Pause stops future scheduling" in panel.inner_text())
    panel.get_by_text("Immutable procedure, Agent, policy and budget pins", exact=True).click()
    checks.check("Schedule pins keep complete identities, timezone and budget", LONG in panel.inner_text() and "Asia/Kolkata" in panel.inner_text() and "wallTimeMs" in panel.inner_text())
    fixture.lease_available = True; refresh(page, "schedule preview and history")
    expect(panel.get_by_text("Schedule preview and history loaded.", exact=True)).to_be_visible()
    panel.get_by_text("PolicyLease outcomes and exact bindings", exact=True).click()
    checks.check("Lease consumption remains distinct from successful business outcome", "leaseGrantsAuthority" in panel.inner_text() and "consumption:" + LONG in panel.inner_text() and "consumption is not proof" in panel.inner_text())
    panel.get_by_text("All returned occurrence receipts", exact=True).click()
    receipt_evidence = panel.locator("details").filter(has=page.locator("summary").filter(has_text=re.compile("^All returned occurrence receipts$"))).locator("pre")
    expect(receipt_evidence).to_be_visible()
    checks.check("Opened schedule receipts retain the exact schedule identity", any(item["id"] == "receipt:" + SCHEDULE for item in json.loads(receipt_evidence.inner_text())))
    fixture.plan("schedule:" + SCHEDULE, status=503); refresh(page, "schedule preview and history")
    expect(panel.get_by_text("Refresh unavailable for schedule preview and history. Last-loaded records and counts remain visible.", exact=True)).to_be_visible()
    expect(panel.get_by_role("button", name="Review pause schedule", exact=True)).to_be_disabled()
    checks.check("Retained schedule history is labelled and controls fail closed", "receipt:" + SCHEDULE in panel.inner_text())
    refresh(page, "schedule preview and history"); expect(panel.get_by_text("Schedule preview and history loaded.", exact=True)).to_be_visible()
    root(page).get_by_role("button", name="Open schedule editor", exact=True).click()
    editor = page.locator("#workflow-schedule-editor")
    editor.get_by_role("textbox", name="Schedule name", exact=True).fill("Synthetic created schedule")
    editor.get_by_role("combobox", name="Saved procedure", exact=True).select_option(PROCEDURE)
    editor.get_by_role("combobox", name="Executing Agent", exact=True).select_option("scout")
    editor.get_by_role("textbox", name=re.compile("^Schedule timezone")).fill("Asia/Kolkata")
    editor.get_by_role("textbox", name=re.compile("^Start instant")).fill("2026-10-10T09:00:00+05:30")
    editor.get_by_role("spinbutton", name="Maximum occurrences", exact=True).fill("25")
    editor.get_by_role("checkbox").check()
    view(page, "Runs"); view(page, "Schedules")
    root(page).get_by_role("button", name="Hide schedule editor", exact=True).click()
    root(page).get_by_role("button", name="Open schedule editor", exact=True).click()
    expect(editor.get_by_role("textbox", name="Schedule name", exact=True)).to_have_value("Synthetic created schedule")
    expect(editor.get_by_role("checkbox")).to_be_checked()
    refresh(page, "schedules and triggers"); ready(page)
    expect(editor.get_by_role("checkbox")).to_be_checked()
    checks.check("Schedule draft and exact acknowledgement survive same-source refresh and view/hide changes", editor.get_by_role("spinbutton", name="Maximum occurrences", exact=True).input_value() == "25")


def exact_effects(page, fixture, checks):
    # 1. Planner POST, wholly synthetic; no configured model is contacted.
    view(page, "Plans")
    root(page).get_by_role("combobox", name="Reviewed plan", exact=True).select_option("")
    root(page).get_by_role("textbox", name="Workflow goal", exact=True).fill("Synthetic planned request")
    root(page).get_by_role("combobox", name="Workflow mode", exact=True).select_option("orchestrate")
    body = {"goal": "Synthetic planned request", "mode": "orchestrate", "requireApproval": True}
    fixture.effect("/api/workflows/plan", body, {"plan": fixture.plan_record("plan:previewed", body["goal"])})
    root(page).get_by_role("button", name="Review plan preview", exact=True).click(); confirm(page)
    expect(confirmed(page)).to_be_visible(); ready(page)
    checks.check("Preview response is separate from starting execution", len(fixture.writes) == 1 and fixture.writes[0]["path"] == "/api/workflows/plan")
    # 2–3. Wrong receipt cannot confirm; exact retry reuses the original key.
    root(page).get_by_role("combobox", name="Reviewed plan", exact=True).select_option(PLAN)
    body = {"goal": "Synthetic exact workflow", "mode": "orchestrate", "requireApproval": True, "planId": PLAN}
    bad = fixture.run_record("workflow:wrong-receipt", goal="Wrong submitted goal")
    fixture.effect("/api/workflows", body, fixture.run_detail(record=bad), key=True)
    root(page).get_by_role("button", name="Review workflow start", exact=True).click(); confirm(page)
    expect(root(page).get_by_role("alert")).to_contain_text("unconfirmed"); ready(page)
    first_key = fixture.writes[-1]["idempotencyKey"]
    good = fixture.run_record("workflow:created-exact"); good["input"]["planId"] = PLAN
    fixture.effect("/api/workflows", body, fixture.run_detail(record=good), key=True, hold="accepted-start")
    root(page).get_by_role("button", name="Review workflow start", exact=True).click(); confirm(page)
    until(page, lambda: "accepted-start" in fixture.held, "Start receipt held")
    expect(confirmation(page).get_by_role("button", name="Submitting reviewed operation…", exact=True)).to_be_disabled()
    expect(root(page).get_by_role("textbox", name="Workflow goal", exact=True)).to_be_disabled()
    expect(root(page).get_by_role("combobox", name="Workflow mode", exact=True)).to_be_disabled()
    checks.check("Uncertain workflow retry uses the exact original durable key", fixture.writes[-1]["idempotencyKey"] == first_key)
    fixture.release("accepted-start"); ready(page)
    expect(confirmed(page)).to_contain_text("workflow:created-exact")
    # 4. Synchronous exclusion + accepted receipt independent of failed follow-up read.
    open_run(page)
    paused = copy.deepcopy(fixture.run_rows[0]); paused["status"] = "paused"; paused["canonicalStatus"]["sourceStatus"] = "paused"; paused["updatedAt"] = "2026-10-04T11:00:00.000Z"
    fixture.effect(path("workflows", RUN, "/signal"), {"signal": "pause"}, fixture.run_detail(record=paused), hold="pause")
    detail(page).get_by_role("button", name="Review pause run", exact=True).click()
    confirmation(page).get_by_role("button", name="Confirm reviewed operation", exact=True).evaluate("el=>{el.click();el.click();}")
    until(page, lambda: "pause" in fixture.held, "Pause receipt held")
    checks.check("One synchronous operation slot prevents duplicate submission", len(fixture.writes) == 4)
    fixture.run_rows[0] = paused; fixture.plan("runs", status=503); fixture.release("pause")
    expect(root(page).get_by_text("Refresh unavailable for workflow runs. Last-loaded records and counts remain visible.", exact=True)).to_be_visible()
    expect(confirmed(page)).to_contain_text('"status": "paused"')
    checks.check("Accepted signal is retained independently of read failure", "Submitting Pause" not in root(page).inner_text())
    refresh(page, "workflow runs"); ready(page)
    # 5. Run once only from the existing active schedule with a closed circuit.
    view(page, "Schedules")
    panel = schedule_detail(page)
    refresh(page, "schedule preview and history"); expect(panel.get_by_text("Schedule preview and history loaded.", exact=True)).to_be_visible()
    panel.get_by_role("button", name="Review run once", exact=True).click()
    body = reviewed_body(page)
    checks.check("Run-once review is one exact known schedule and instant", set(body) == {"action", "scheduledFor"} and body["action"] == "run_once" and bool(datetime.fromisoformat(body["scheduledFor"].replace("Z", "+00:00"))))
    instant = datetime.fromisoformat(body["scheduledFor"].replace("Z", "+00:00")).replace(second=0, microsecond=0).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    occurrence = fixture.occurrence(); occurrence.update(id="occurrence:synthetic-manual", kind="manual", status="enqueued", scheduledFor=instant)
    occurrence.pop("failureCode", None)
    fixture.effect(path("triggers", SCHEDULE), body, {"occurrence": occurrence}, key=True)
    confirm(page); ready(page)
    expect(confirmed(page)).to_contain_text('"status": "enqueued"')
    checks.check("Run-once receipt does not claim completed work", "queued run is not a completed outcome" in confirmed(page).inner_text())
    # 6. Pause preserves immutable configuration and disables another manual run.
    changed = copy.deepcopy(fixture.triggers[0]); changed["status"] = "paused"; changed["updatedAt"] = "2026-10-04T11:01:00.000Z"
    fixture.effect(path("triggers", SCHEDULE), {"action": "pause"}, {"trigger": changed}, key=True, hold="schedule-pause")
    panel.get_by_role("button", name="Review pause schedule", exact=True).click(); confirm(page)
    until(page, lambda: "schedule-pause" in fixture.held, "Schedule pause held")
    fixture.triggers[0] = changed; fixture.release("schedule-pause"); ready(page)
    expect(panel.get_by_role("button", name="Review resume schedule", exact=True)).to_be_enabled()
    expect(panel.get_by_role("button", name="Review run once", exact=True)).to_be_disabled()
    # 7. Create with explicit timezone, UTC conversion, exact inventory, full budget.
    editor = page.locator("#workflow-schedule-editor")
    editor.get_by_role("button", name="Review schedule request", exact=True).click()
    body = {"triggerKind": "schedule", "name": "Synthetic created schedule", "procedureId": PROCEDURE, "agentId": "scout", "timezone": "Asia/Kolkata", "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0", "startsAt": "2026-10-10T03:30:00.000Z", "maxOccurrences": 25, "missedPolicy": "skip", "failureLimit": 3, "occurrenceBudget": BUDGET, "authorityMode": "read_only"}
    checks.check("Schedule reviewed request matches full intended configuration", reviewed_body(page) == body, reviewed_body(page))
    created = fixture.trigger("schedule:created-exact"); created["name"] = body["name"]
    created["schedule"]["config"].update({key: copy.deepcopy(body[key]) for key in ("timezone", "rrule", "startsAt", "maxOccurrences", "missedPolicy", "failureLimit", "occurrenceBudget", "authorityMode")})
    fixture.effect("/api/triggers", body, {"trigger": created}, key=True, hold="schedule-created")
    confirm(page); until(page, lambda: "schedule-created" in fixture.held, "Create schedule held")
    fixture.triggers.append(created); fixture.release("schedule-created"); ready(page)
    expect(confirmed(page)).to_contain_text("schedule:created-exact")
    # 8–9. Wrong quarantine receipt, then exact release. No idempotency invented.
    view(page, "Queue and recovery")
    fixture.effect(path("operations/jobs", JOB), {"action": "release"}, {"outcome": "released", "job": {"id": "wrong-job", "status": "queued"}})
    root(page).get_by_role("button", name="Review release · " + JOB, exact=True).click(); confirm(page)
    expect(root(page).get_by_role("alert")).to_contain_text("unconfirmed"); ready(page)
    fixture.effect(path("operations/jobs", JOB), {"action": "release"}, {"outcome": "released", "job": {"id": JOB, "status": "queued", "attempt": 0, "leaseLapses": 0}}, hold="release-job")
    root(page).get_by_role("button", name="Review release · " + JOB, exact=True).click(); confirm(page)
    until(page, lambda: "release-job" in fixture.held, "Quarantine release held")
    fixture.quarantine = []; fixture.release("release-job"); ready(page)
    expect(confirmed(page)).to_contain_text('"outcome": "released"')
    # 10. Existing inspect POST, not repair/drain; 11. whole existing tick remains local.
    fixture.effect("/api/operations", {"action": "inspect_recovery", "limit": 10}, {"recovery": fixture.recovery(), "overview": fixture.body("operations")})
    root(page).get_by_role("button", name="Review recovery inspection", exact=True).click(); confirm(page); ready(page)
    expect(confirmed(page)).to_contain_text('"mode": "inspect"')
    fixture.effect("/api/workflows/tick", {"limit": 5, "slo": True, "alerts": False}, {"count": 1, "queue": {"requested": 5, "leased": 1, "completed": 0, "failed": 0, "requeued": 1, "stale": 0, "waiting": 1, "jobs": []}, "workflowSchedules": {"occurrencesEnqueued": 0}})
    root(page).get_by_role("button", name="Review queue tick", exact=True).click()
    checks.check("Tick review discloses tenant work beyond displayed rows", "background work beyond the displayed workflow rows" in confirmation(page).inner_text())
    confirm(page); ready(page)
    checks.check("Eleven effects so far match exact declared bodies and header contracts", len(fixture.writes) == 11 and not fixture.effects)


def presentation(page, fixture, checks, coarse):
    name = "phone" if coarse else "desktop"
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse)
        for active in ("Runs", "Plans", "Schedules", "Queue and recovery"):
            view(page, active)
            suffix = active.lower().replace(" ", "-")
            scan = (not coarse and (theme == "light" or active == "Runs")) or (coarse and theme == "dark" and active == "Schedules")
            capture(page, checks, f"workflows-{name}-{theme}-{suffix}", coarse, root(page).get_by_role("heading", name={"Runs": "Workflow runs", "Plans": "Plans and execution", "Schedules": "Schedules and triggers", "Queue and recovery": "Queue and recovery"}[active], exact=True), axe=scan)
    if coarse:
        page.set_viewport_size({"width": 320, "height": 812})
        for theme, active in (("light", "Plans"), ("dark", "Queue and recovery")):
            select_theme(page, theme, True); view(page, active); capture(page, checks, "workflows-320-" + theme, True)
    view(page, "Schedules")
    before = root(page).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
    page.evaluate("document.documentElement.style.fontSize='200%'"); settle(page)
    page.wait_for_function("([selector,before])=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)>=before*1.99", arg=[ROOT, before])
    after = root(page).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
    checks.check(name + ": UI text doubles at 200 percent", after >= before * 1.99, {"before": before, "after": after})
    capture(page, checks, "workflows-" + name + "-text-200", coarse, page.locator("#workflow-schedule-editor"), axe=False)
    page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
    page.wait_for_function("([selector,before])=>Math.abs(parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)-before)<.1", arg=[ROOT, before])
    page.emulate_media(forced_colors="active"); capture(page, checks, "workflows-" + name + "-forced-colors", coarse, axe=False); page.emulate_media(forced_colors="none")
    checks.check(name + ": reduced-motion presentation settles", page.evaluate("matchMedia('(prefers-reduced-motion:reduce)').matches") and root(page).locator("*").evaluate_all("els=>els.every(el=>[getComputedStyle(el).animationDuration,getComputedStyle(el).transitionDuration].every(v=>v.split(',').every(p=>parseFloat(p)<=0.00001)))"))
    checks.check(name + ": source text never executes", not page.evaluate("window.untrustedWorkflowRan"))


def replacement_review(page, fixture, checks):
    view(page, "Schedules")
    root(page).get_by_role("button", name="Edit by replacement · Synthetic morning schedule", exact=True).click()
    editor = page.locator("#workflow-schedule-editor")
    editor.get_by_role("textbox", name="Schedule name", exact=True).fill("Synthetic replacement draft")
    editor.get_by_role("textbox", name=re.compile("^Start instant")).fill("2026-10-11T09:00:00+05:30")
    editor.get_by_role("checkbox").check()
    editor.get_by_role("button", name="Review schedule request", exact=True).click()
    body = reviewed_body(page)
    checks.check("Schedule editing reviews an immutable replacement without patching history", body.get("replacesTriggerId") == SCHEDULE and body["startsAt"] == "2026-10-11T03:30:00.000Z" and body["name"] == "Synthetic replacement draft" and body["occurrenceBudget"] == BUDGET)
    confirmation(page).get_by_role("button", name="Cancel review", exact=True).click()
    expect(editor.get_by_role("button", name="Review schedule request", exact=True)).to_be_focused()
    fixture.triggers[0]["schedule"]["config"]["configSha256"] = "9" * 64
    refresh(page, "schedules and triggers"); ready(page)
    expect(editor.get_by_text("The replacement source changed. Reopen its editor from the current schedule before submitting.", exact=True)).to_be_visible()
    expect(editor.get_by_role("button", name="Review schedule request", exact=True)).to_be_disabled()
    expect(editor.get_by_role("textbox", name="Schedule name", exact=True)).to_have_value("Synthetic replacement draft")
    checks.check("Changed schedule version invalidates submission without discarding the written draft", "Synthetic replacement draft" == editor.get_by_role("textbox", name="Schedule name", exact=True).input_value())


def disposed_effect(page, fixture, checks):
    # 12. Dispose a held planner response before it may publish a receipt.
    view(page, "Plans")
    root(page).get_by_role("combobox", name="Reviewed plan", exact=True).select_option("")
    root(page).get_by_role("textbox", name="Workflow goal", exact=True).fill("Disposed synthetic preview")
    body = {"goal": "Disposed synthetic preview", "mode": "orchestrate", "requireApproval": True}
    fixture.effect("/api/workflows/plan", body, {"plan": fixture.plan_record("plan:disposed", body["goal"])}, hold="disposed-effect")
    root(page).get_by_role("button", name="Review plan preview", exact=True).click(); confirm(page)
    until(page, lambda: "disposed-effect" in fixture.held, "Disposed effect held")
    navigate(page, fixture.origin, "/app/workflows?fresh-owner-view=1"); ready(page)
    fixture.release("disposed-effect"); settle(page)
    checks.check("Disposed late effect cannot publish into a remounted owner view", confirmed(page).count() == 0 and "plan:disposed" not in root(page).inner_text())


def exercise(browser, origin, credentials, checks, coarse):
    name = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(name + ": real isolated synthetic login", login.ok)
        fixture = WorkflowFixtures(origin, context.request.get(origin + "/api/auth/session").json()); fixture.mode = "error"
        context.route("**/*", fixture.route); context.expose_binding("__workflowBoundary", lambda source, event: fixture.unexpected.append(event)); context.add_init_script(GUARDS)
        page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup_event"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download_event"}), download.cancel()))
        navigate(page, origin, "/app/workflows")
        inspect_reads(page, fixture, checks); inspect_schedules(page, fixture, checks)
        if not coarse: exact_effects(page, fixture, checks)
        replacement_review(page, fixture, checks)
        presentation(page, fixture, checks, coarse)
        if not coarse: disposed_effect(page, fixture, checks)
        fixture.mode = "empty"; navigate(page, origin, "/app/workflows?window=empty"); ready(page)
        expect(root(page).get_by_text("No workflow runs were returned in this window.", exact=True)).to_be_visible()
        view(page, "Schedules"); expect(root(page).get_by_text("No schedules or webhook triggers were returned in this window.", exact=True)).to_be_visible()
        checks.check(name + ": successful empty differs from unavailable", "Unavailable" not in root(page).locator("dl").first.inner_text())
        checks.check(name + ": exact synthetic effect budget", len(fixture.writes) == (0 if coarse else 12) and not fixture.effects, fixture.writes)
        checks.check(name + ": finite family GET budget and no held routes", len(fixture.requests) <= 180 and not fixture.held)
        checks.check(name + ": no unexpected writes, external traffic, popup, download or media", not fixture.unexpected, fixture.unexpected)
        checks.check(name + ": no uncaught application errors", not errors, errors)
        return {"viewport": name, "reads": fixture.requests, "syntheticEffects": fixture.writes, "heldDispositions": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (name + "-failure.png")), full_page=False)
            (checks.output / (name + "-failure-dom.html")).write_text(page.content())
        if fixture is not None: (checks.output / (name + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        try:
            if fixture is not None: fixture.abort_held()
            if page is not None and not page.is_closed(): page.goto("about:blank")
        finally: context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/workflows")
    parser.add_argument("--chrome", type=Path); parser.add_argument("--axe", required=True, type=Path)
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
    except Exception as caught:
        failure = str(caught); print(f"Workflow browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual /app/workflows with isolated real synthetic login. Twelve exact desktop POSTs fulfilled only in Playwright: two plan previews (one disposed), two workflow starts (wrong receipt then matching retry), one run signal, two schedule controls, one schedule creation, two quarantine responses, one recovery inspection, one tenant queue tick. Zero phone effects. No real planner, scheduler, workflow, PolicyLease, provider or recovery effect executes. Same-request retry key checked only where the existing endpoint supports it; legacy controls do not gain CAS/replay. Holds settle or abort before context closure. Eight page-wide axe scans across views/themes/phone sizes and viewport-only screenshots. These fixtures do not establish production authority enforcement, real DST execution or cross-client concurrency."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
