#!/usr/bin/env python3
"""Agents presentation and lifecycle QA with exact, wholly local effect receipts.

Run by the serial browser owner only. Moltbook, agent execution, providers,
creation, Trash, adaptation activation and retirement are outside this suite.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, quote, urlsplit
from playwright.sync_api import expect, sync_playwright
from agents_fixtures import A, B, ADAPTATION, GRANT, LONG, OTHER_TASK, RUN, SKILL, TASK, TEXT, AgentFixtures, agent_path, definition, evaluated
from fixtures import STAMP
from run import Checks, REPO, navigate, preview, select_theme

ROOT = '[data-testid="agents-workspace"]'
PROFILE_KEYS = ("name", "role", "description", "instructions", "persona", "status", "accent", "modelPolicy", "autonomy", "approvalPolicy", "memoryScope", "skillIds", "toolIds")


def root(page): return page.locator(ROOT)
def inspector(page): return root(page).get_by_role("region", name="Selected Agent", exact=True)
def release_panel(page): return inspector(page).get_by_role("region", name="Agent release lifecycle", exact=True)
def grants(page): return inspector(page).get_by_role("region", name="Synthetic Agent A grants", exact=True)
def adaptation(page): return inspector(page).get_by_role("region", name="Synthetic Agent A adaptation evidence", exact=True)
def live(page): return root(page).get_by_role("region", name="Live Agent work", exact=True)


def until(page, predicate, label, timeout=20):
    end = time.monotonic() + timeout
    while not predicate() and time.monotonic() < end: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)


def settle(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def view(page, name):
    root(page).get_by_role("navigation", name="Agent workspace views", exact=True).get_by_role("button", name=re.compile("^" + re.escape(name))).click()


def ready(page):
    expect(root(page).get_by_role("button", name="Create agent", exact=True)).to_be_enabled()


def select_agent(page, identity=A, coarse=False):
    view(page, "Roster")
    if coarse and inspector(page).is_visible():
        inspector(page).get_by_role("button", name="Back to roster", exact=True).click()
    row = root(page).get_by_role("navigation", name="Agent roster", exact=True).get_by_role("button", name=re.compile("^Synthetic Agent " + ("A" if identity == A else "B")))
    row.click()
    expect(inspector(page).get_by_role("heading", name="Synthetic Agent " + ("A" if identity == A else "B"), exact=True).first).to_be_visible()
    if identity == A:
        expect(release_panel(page).get_by_role("button", name="Refresh release history", exact=True)).to_be_visible()
        expect(grants(page).get_by_role("button", name="Refresh exact grants", exact=True)).to_be_visible()
    return row


def disclosure(scope, name):
    summary = scope.locator("summary").filter(has_text=re.compile("^" + re.escape(name) + "$"))
    if not summary.evaluate("el=>el.parentElement.open"): summary.click()
    return summary.locator("xpath=..")


def capture(page, checks, name, coarse, target=None, axe=True):
    page.evaluate("window.scrollTo(0,0)"); settle(page)
    checks.check(name + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    reflow = page.evaluate("""() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,
      outside:[...document.body.querySelectorAll('*')].filter(el=>{
        const r=el.getBoundingClientRect();return r.width && (r.right>innerWidth+1 || r.left < -1);
      }).map(el=>({tag:el.tagName,cls:typeof el.className==='string'?el.className:'',
        left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,
        client:el.clientWidth,scroll:el.scrollWidth})).slice(0,20)})""")
    checks.check(name + ": no document overflow", reflow["document"] <= reflow["viewport"] + 1, reflow)
    controls = root(page).locator("button:visible,select:visible,input:visible,a:visible,summary:visible")
    bad = controls.evaluate_all("""(els,min)=>els.flatMap(el=>{
      const target=el.matches('input[type=checkbox],input[type=radio]')?(el.closest('label')||el):el;
      const r=target.getBoundingClientRect();return r.height<min-1?[{name:el.getAttribute('aria-label')||el.textContent||el.name,height:r.height}]:[];
    })""", 48 if coarse else 44)
    checks.check(name + ": control target height", not bad, bad)
    if axe:
        if not page.evaluate("Boolean(window.axe)"): page.add_script_tag(path=str(checks.axe))
        report = page.evaluate("""async selector=>{const r=await axe.run(document.querySelector(selector),
          {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
          return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
          incomplete:r.incomplete.map(v=>v.id),passes:r.passes.length};}""", ROOT)
        (checks.output / (name + "-axe.json")).write_text(json.dumps(report, indent=2))
        checks.check(name + ": Agents scoped axe", not report["violations"], report["violations"])
    if target is not None:
        target.evaluate("el=>el.scrollIntoView({block:'start'})")
        page.evaluate("window.scrollBy(0,-112)"); settle(page)
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    checks.check(name + ": viewport capture retained pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)


def inspect_family(page, fixture, checks, coarse):
    ready(page)
    expect(live(page).get_by_role("button", name="Cancel task", exact=True)).to_be_enabled()
    text = live(page).inner_text()
    checks.check("Live work names exact executing Agent, task, parent and delegation", all(value in text for value in (A, TASK, RUN, "delegation:exact-synthetic", "Synthetic Agent A")))
    expect(live(page).get_by_role("region", name="Signed execution grants").get_by_text("d" * 64, exact=True)).to_be_visible()
    checks.check("Full returned work and evidence are retained", TEXT in text and "artifact:" + "exact_" * 20 in text)
    destination = live(page).get_by_role("link", name="Open in Command", exact=True).get_attribute("href")
    checks.check("Command destination preserves exact run identity", parse_qs(urlsplit(destination).query).get("run") == [RUN])
    select_agent(page, A, coarse)
    profile = disclosure(inspector(page), "Stored profile instructions and routing")
    checks.check("Stored instructions retain complete returned text", TEXT in profile.inner_text())
    identity = inspector(page).get_by_role("region", name="Synthetic Agent A behavioral identity", exact=True)
    checks.check("Behavioral identity remains explicit and complete", fixture.agents[0]["persona"]["charter"] in identity.inner_text() and fixture.agents[0]["persona"]["operatingStyle"] in identity.inner_text())
    pins = release_panel(page).locator('dl[aria-label="Exact release pins"]')
    checks.check("Release uses full active and candidate version IDs", definition(1) in pins.inner_text() and definition(2) in pins.inner_text())
    exact = disclosure(grants(page), "Exact grant identity and limits")
    checks.check("Grant inspector retains principal generation, owner, targets and limits", all(value in exact.inner_text() for value in (fixture.grants[0]["record"]["granteeId"], fixture.grants[0]["record"]["target"]["resourceIds"][0], "24 items", "48000 bytes")))
    evidence = disclosure(adaptation(page), "Exact adaptation and evidence")
    checks.check("Adaptation inspector retains full source and digest identity", all(value in evidence.inner_text() for value in (ADAPTATION, fixture.adaptations[0]["evidence"][0]["sourceId"], "b" * 64)))
    select_agent(page, B, coarse)
    expect(inspector(page).get_by_text("This profile is read only. Its authority cannot be changed here.", exact=True)).to_be_visible()
    checks.check("Read-only returned profile exposes no profile or grant mutation", inspector(page).get_by_role("button", name="Edit profile", exact=True).count() == 0 and inspector(page).get_by_role("button", name="Activate exact grant", exact=True).count() == 0)
    if coarse:
        inspector(page).get_by_role("button", name="Back to roster", exact=True).click()
        expect(root(page).get_by_role("navigation", name="Agent roster").get_by_role("button", name=re.compile("^Synthetic Agent B"))).to_be_focused()
        checks.check("Phone Back restores selected roster row focus", True)
    select_agent(page, A, coarse)
    view(page, "Skills")
    skill = root(page).get_by_role("article").filter(has=page.get_by_role("heading", name="Synthetic exact Skill", exact=True))
    details = disclosure(skill, "Instructions, provenance and actions")
    checks.check("Skill inspector preserves full exact identity and instructions", SKILL in skill.inner_text() and TEXT in details.inner_text())
    view(page, "Outcomes")
    outcomes = root(page).get_by_role("region", name="Agent outcomes", exact=True)
    custom = outcomes.get_by_role("article").filter(has_text="Synthetic Agent A")
    checks.check("Missing custom outcomes are unknown rather than zero", custom.get_by_text("Not reported", exact=True).count() == 4)
    select_agent(page, A, coarse)


def local_drafts(page, fixture, checks, coarse):
    count = len(fixture.writes)
    trigger = inspector(page).get_by_role("button", name="Edit profile", exact=True)
    trigger.click()
    editor = page.get_by_role("dialog", name="Agent", exact=True)
    editor.get_by_role("textbox", name="Charter", exact=True).fill("Retained charter draft; no new authority.")
    capture(page, checks, "agents-" + ("phone" if coarse else "desktop") + "-profile-draft", coarse, editor.get_by_role("heading", name="Agent", exact=True), axe=False)
    for _ in range(12):
        page.keyboard.press("Tab")
        checks.check("Native Agent dialog retains application focus", editor.evaluate("el=>el.contains(document.activeElement)") or not page.evaluate("document.hasFocus()"))
    page.keyboard.press("Escape")
    expect(editor).to_have_count(0); expect(trigger).to_be_focused()
    root(page).get_by_role("button", name="New skill", exact=True).click()
    skill = page.get_by_role("dialog", name="Skill", exact=True)
    skill.get_by_role("textbox", name="Name", exact=True).fill("Local unsaved Skill")
    skill.get_by_role("button", name="Cancel", exact=True).click()
    expect(skill).to_have_count(0)
    checks.check("Closing profile and Skill drafts triggers no effect", len(fixture.writes) == count)
    disclosure(grants(page), "Add a bounded grant")
    target = grants(page).get_by_role("textbox", name=re.compile("^Exact targets"))
    target.fill("memory:local-draft-only")
    fixture.plan("grants", identity=A, body={"error": "Synthetic exact grant read failed. " + LONG}, status=503)
    grants(page).get_by_role("button", name="Refresh exact grants", exact=True).click()
    expect(grants(page).get_by_text("Synthetic exact grant read failed.", exact=False)).to_be_visible()
    expect(grants(page).get_by_role("button", name="Activate exact grant", exact=True)).to_be_disabled()
    expect(target).to_have_value("memory:local-draft-only")
    view(page, "Skills"); view(page, "Roster")
    expect(target).to_have_value("memory:local-draft-only")
    checks.check("Grant draft survives same-scope view and failed read", "last loaded" in grants(page).inner_text().lower() and GRANT in grants(page).inner_text())
    grants(page).get_by_role("button", name="Refresh exact grants", exact=True).click()
    expect(grants(page).get_by_role("button", name="Activate exact grant", exact=True)).to_be_enabled()
    expect(target).to_have_value("memory:local-draft-only")
    # Inspect terminal confirmation without invoking the effect.
    release_panel(page).get_by_role("button", name="Retire Agent", exact=True).click()
    confirmation = release_panel(page).get_by_role("textbox", name="Retirement confirmation", exact=True)
    confirmation.fill("retire")
    expect(release_panel(page).get_by_role("button", name="Retire", exact=True)).to_be_disabled()
    confirmation.fill("RETIRE AGENT")
    expect(release_panel(page).get_by_role("button", name="Retire", exact=True)).to_be_enabled()
    changed = copy.deepcopy(fixture.release_record)
    changed["latestDefinitionVersion"], changed["latestDefinitionVersionId"] = 3, definition(3)
    changed["versions"].append({"definitionVersion": 3, "definitionVersionId": definition(3), "publishedAt": STAMP, "active": False})
    fixture.plan("release", identity=A, body={"release": changed})
    release_panel(page).get_by_role("button", name="Refresh release history", exact=True).click()
    expect(release_panel(page).get_by_role("button", name="Review current release", exact=True)).to_be_visible()
    expect(confirmation).to_have_value("RETIRE AGENT")
    expect(release_panel(page).get_by_role("button", name="Retire", exact=True)).to_be_disabled()
    release_panel(page).get_by_role("button", name="Cancel", exact=True).click()
    release_panel(page).get_by_role("button", name="Refresh release history", exact=True).click()
    expect(release_panel(page).get_by_role("combobox", name="Review version", exact=True)).to_have_value("2")
    expect(release_panel(page).get_by_role("button", name="Evaluate v2", exact=True)).to_be_enabled()
    checks.check("Authoritative version change retains retirement draft but invalidates its review", len(fixture.writes) == count)


def reads_and_cancel(page, fixture, checks):
    view(page, "Live work")
    stale = fixture.authority(TASK)
    stale["task"]["authority"]["skills"][0]["skillVersionId"] = "OLD_TASK_AUTHORITY_MUST_NOT_REAPPEAR"
    fixture.plan("task", identity=TASK, body=stale, hold="old-authority")
    live(page).get_by_role("button", name="Refresh task authority", exact=True).click()
    until(page, lambda: "old-authority" in fixture.held, "Old task authority was not held")
    rail = live(page).get_by_role("complementary", name="Executions and team members", exact=True)
    rail.get_by_role("button", name=re.compile("Synthetic Agent B")).click()
    expect(live(page).get_by_text(OTHER_TASK, exact=True)).to_be_visible()
    fixture.release("old-authority")
    checks.check("Late old task read cannot enter newly selected worker", live(page).get_by_text("OLD_TASK_AUTHORITY_MUST_NOT_REAPPEAR", exact=False).count() == 0)
    rail.get_by_role("button", name=re.compile("Synthetic Agent A")).click()
    path = "/api/agents/tasks/" + quote(TASK, safe="") + "/cancel"
    body = {"expectedRevision": 3}
    accepted = {"task": {"executionId": TASK, "state": "canceled", "lifecycleRevision": 4, "canCancel": False, "updatedAt": STAMP, "terminalAt": STAMP}}
    wrong = copy.deepcopy(accepted); wrong["task"]["executionId"] = OTHER_TASK
    fixture.expect_effect(path, "POST", body, wrong)
    page.once("dialog", lambda dialog: dialog.accept())
    live(page).get_by_role("button", name="Cancel task", exact=True).click()
    expect(live(page).get_by_text("The response did not match the requested Agent", exact=False)).to_be_visible()
    expect(live(page).get_by_role("button", name="Cancel task", exact=True)).to_be_enabled()
    checks.check("Wrong task cancellation receipt does not change current task", "Lifecycle revision" in live(page).inner_text() and fixture.task_state == "working")
    fixture.expect_effect(path, "POST", body, accepted, hold="cancel-effect")
    page.once("dialog", lambda dialog: dialog.accept())
    live(page).get_by_role("button", name="Cancel task", exact=True).click()
    until(page, lambda: "cancel-effect" in fixture.held, "Cancel receipt was not held")
    expect(root(page).get_by_role("button", name="Create agent", exact=True)).to_be_disabled()
    expect(root(page).get_by_role("navigation", name="Agent workspace views").get_by_role("button", name=re.compile("^Roster"))).to_be_disabled()
    checks.check("One shared action gate and same-request retry identity", len(fixture.writes) == 2 and fixture.writes[0]["idempotencyKey"] == fixture.writes[1]["idempotencyKey"])
    fixture.task_state, fixture.task_revision = "canceled", 4
    fixture.release("cancel-effect")
    expect(live(page).get_by_text("Task " + TASK + " canceled at revision 4.", exact=False)).to_be_visible()
    expect(live(page).get_by_role("button", name="Cancel task", exact=True)).to_have_count(0)
    fixture.mode = "error"
    root(page).get_by_role("button", name="Refresh Agents", exact=True).click()
    expect(live(page).get_by_text("Last loaded live work", exact=False)).to_be_visible()
    checks.check("Stale source failure retains executing identity and truthful labels", A in live(page).inner_text() and "Last loaded" in root(page).inner_text())
    view(page, "Skills")
    expect(root(page).get_by_role("heading", name="Synthetic exact Skill", exact=True)).to_be_visible()
    expect(root(page).get_by_role("button", name="New skill", exact=True)).to_be_disabled()
    checks.check("Failed refresh retains Skills instead of claiming empty", root(page).get_by_text("No Skills in this successful snapshot.", exact=True).count() == 0)
    fixture.mode = "ready"
    root(page).get_by_role("button", name="Refresh Agents", exact=True).click(); ready(page)
    select_agent(page)


def exact_effects(page, fixture, checks):
    # Profile write: compatibility PATCH contains no invented expected version.
    inspector(page).get_by_role("button", name="Edit profile", exact=True).click()
    editor = page.get_by_role("dialog", name="Agent", exact=True)
    submitted = copy.deepcopy(fixture.agents[0]); submitted["description"] = "Confirmed synthetic profile description. " + LONG
    editor.get_by_role("textbox", name="Description", exact=True).fill(submitted["description"])
    body = {key: copy.deepcopy(submitted[key]) for key in PROFILE_KEYS}
    submitted["updatedAt"] = "2026-10-03T12:01:00.000Z"
    fixture.expect_effect(agent_path(), "PATCH", body, {"agent": submitted}, hold="profile-effect")
    editor.get_by_role("button", name="Save changes", exact=True).click()
    until(page, lambda: "profile-effect" in fixture.held, "Profile effect was not held")
    expect(editor.get_by_role("textbox", name="Description", exact=True)).to_be_disabled()
    expect(editor.get_by_role("button", name="Close builder", exact=True)).to_be_disabled()
    page.keyboard.press("Escape"); expect(editor).to_be_visible()
    fixture.agents[0] = submitted
    fixture.plan("agents", hold="profile-followup", status=503, body={"error": "Synthetic accepted profile refresh unavailable."})
    fixture.release("profile-effect")
    expect(editor).to_have_count(0)
    until(page, lambda: "profile-followup" in fixture.held, "Profile followup not held")
    expect(root(page).get_by_text("The exact stored receipt was confirmed.", exact=False)).to_be_visible()
    expect(root(page).get_by_role("button", name="Refresh Agents", exact=True)).to_be_enabled()
    fixture.release("profile-followup")
    expect(root(page).get_by_role("button", name="Create agent", exact=True)).to_be_disabled()
    checks.check("Accepted profile survives failed followup without remaining busy", submitted["description"] in inspector(page).inner_text() and "exact stored receipt was confirmed" in root(page).inner_text())
    root(page).get_by_role("button", name="Refresh Agents", exact=True).click(); ready(page)
    # Evaluation only: no adaptation activation is requested.
    next_adaptation = copy.deepcopy(fixture.adaptations[0])
    next_adaptation.update({"state": "evaluated", "lifecycleRevision": 1, "evaluation": {
        "version": "p7.6-agent-adaptation-evaluation:1", "definitionVersion": 1, "policyVersionId": "agent-adaptation-policy:1",
        "checks": {key: True for key in ("evidenceIntegrity", "ownerBinding", "exactDefinitionVersion", "nonAuthorityEffect", "confidenceThreshold")},
        "verdict": "passed", "evaluatedAt": STAMP, "evaluationSha256": "f" * 64}})
    fixture.expect_effect(agent_path(suffix="/adaptations"), "POST", {"action": "evaluate", "adaptationId": ADAPTATION}, {"definitionVersion": 1, "adaptations": [next_adaptation]})
    fixture.adaptations = [next_adaptation]
    adaptation(page).get_by_role("button", name="Evaluate", exact=True).click()
    expect(adaptation(page).get_by_role("button", name="Activate", exact=True)).to_be_enabled()
    checks.check("Exact evaluation permits reviewed activation but does not activate", len(fixture.writes) == 4 and fixture.writes[-1]["body"]["action"] == "evaluate")
    next_release = evaluated(fixture.release_record)
    fixture.expect_effect(agent_path(suffix="/release"), "POST", {"action": "evaluate", "definitionVersion": 2}, {"release": next_release}, hold="release-evaluation")
    release_panel(page).get_by_role("button", name="Evaluate v2", exact=True).click()
    until(page, lambda: "release-evaluation" in fixture.held, "Release evaluation was not held")
    fixture.release_record = next_release
    fixture.release("release-evaluation")
    expect(release_panel(page).get_by_role("button", name="Promote v2", exact=True)).to_be_enabled()
    checks.check("Evaluated release exposes exact digest and evaluation identity", all(value in release_panel(page).inner_text() for value in ("a" * 64, "c" * 64, next_release["evaluations"][0]["evaluationId"])))
    promoted = copy.deepcopy(next_release)
    promoted.update({"releaseRevision": 2, "activeDefinitionVersion": 2, "activeDefinitionVersionId": definition(2), "previousDefinitionVersion": 1, "previousDefinitionVersionId": definition(1)})
    for version in promoted["versions"]: version["active"] = version["definitionVersion"] == 2
    fixture.expect_effect(agent_path(suffix="/release"), "POST", {"action": "promote", "evaluationId": next_release["evaluations"][0]["evaluationId"]}, {"release": promoted}, hold="release-promotion")
    release_panel(page).get_by_role("button", name="Promote v2", exact=True).click()
    until(page, lambda: "release-promotion" in fixture.held, "Release promotion was not held")
    fixture.release_record, fixture.adaptation_definition = promoted, 2
    fixture.agents[0]["activeDefinitionVersion"] = 2
    fixture.release("release-promotion")
    expect(release_panel(page).get_by_text("Version 2 is now active.", exact=True)).to_be_visible()
    expect(adaptation(page).get_by_text("Observed on release v1. Refresh evidence for v2.", exact=True)).to_be_visible()
    checks.check("Exact release promotion invalidates old adaptation activation", adaptation(page).get_by_role("button", name="Activate", exact=True).count() == 0)
    old_grant = copy.deepcopy(fixture.grants[0])
    fixture.expect_effect(agent_path(suffix="/grants/" + quote(GRANT, safe="")), "DELETE", None, {"revoked": True, "target": {"agentId": A, "grant": old_grant["record"]}, "targetSha256": "f" * 64}, hold="grant-revoke")
    confirmations = []
    page.once("dialog", lambda dialog: (confirmations.append(dialog.message), dialog.accept()))
    grants(page).get_by_role("button", name="Revoke " + GRANT, exact=True).click()
    until(page, lambda: "grant-revoke" in fixture.held, "Exact grant revocation was not held")
    checks.check("Grant confirmation identifies exact grant and authority-generation effect", len(confirmations) == 1 and GRANT in confirmations[0] and "new authority generation" in confirmations[0])
    fixture.grants = []
    fixture.release("grant-revoke")
    expect(grants(page).get_by_text("Revocation confirmed for " + GRANT, exact=False)).to_be_visible()
    expect(grants(page).get_by_text("No explicit grants were returned", exact=False)).to_be_visible()
    checks.check("Exact grant receipt confirms local request then rechecks complete list", len(fixture.writes) == 7)


def dispose_effect(page, fixture, checks, origin):
    inspector(page).get_by_role("button", name="Edit profile", exact=True).click()
    editor = page.get_by_role("dialog", name="Agent", exact=True)
    returned = copy.deepcopy(fixture.agents[0]); returned["description"] = "OLD_SCOPE_RECEIPT_MUST_NOT_APPEAR"
    editor.get_by_role("textbox", name="Description", exact=True).fill(returned["description"])
    fixture.expect_effect(agent_path(), "PATCH", {key: copy.deepcopy(returned[key]) for key in PROFILE_KEYS}, {"agent": returned}, hold="disposed-profile")
    editor.get_by_role("button", name="Save changes", exact=True).click()
    until(page, lambda: "disposed-profile" in fixture.held, "Old scope profile write was not held")
    # A browser route change is possible even while the native modal makes
    # background links inert. The isolated server receives no profile effect.
    navigate(page, origin, "/app/agents?view=outcomes")
    expect(root(page).get_by_role("heading", name="Agent outcomes", exact=True)).to_be_visible()
    fixture.release("disposed-profile")
    settle(page)
    checks.check("Disposed route cannot publish old pending profile receipt", root(page).get_by_text("OLD_SCOPE_RECEIPT_MUST_NOT_APPEAR", exact=False).count() == 0 and root(page).get_by_text("The exact stored receipt was confirmed.", exact=False).count() == 0)
    select_agent(page)


def exercise(browser, origin, credentials, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        fixture = AgentFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        fixture.mode = "error"
        context.route("**/*", fixture.route)
        context.expose_binding("__recordAgentsBoundary", lambda source, event: fixture.unexpected.append(event))
        context.add_init_script("""window.__agentsForbidden=[];const record=event=>{window.__agentsForbidden.push(event);window.__recordAgentsBoundary(event);};
          window.open=(...args)=>{record({kind:'popup',args});return null;};
          HTMLMediaElement.prototype.play=function(){record({kind:'playback'});return Promise.reject(new Error('Playback prohibited'));};
          if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{record({kind:'media_permission'});return Promise.reject(new Error('Media prohibited'));};
          const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download){record({kind:'programmatic_download'});return;}return click.call(this);};""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup_event"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download_event"}), download.cancel()))
        navigate(page, origin, "/app/agents")
        expect(root(page).get_by_role("heading", name="Live work unavailable", exact=True)).to_be_visible()
        checks.check(label + ": initial failure does not invent empty live work", root(page).get_by_role("heading", name="No delegated work yet", exact=True).count() == 0)
        view(page, "Skills")
        expect(root(page).get_by_text("Skills are unavailable. No empty count has been confirmed.", exact=True)).to_be_visible()
        view(page, "Outcomes")
        expect(root(page).get_by_role("heading", name="Outcomes unavailable", exact=True)).to_be_visible()
        checks.check(label + ": unavailable outcomes have no invented summary", root(page).locator('[aria-label="Outcome summary"]').count() == 0)
        fixture.mode = "ready"
        root(page).get_by_role("button", name="Refresh Agents", exact=True).click(); ready(page)
        view(page, "Live work")
        inspect_family(page, fixture, checks, coarse)
        local_drafts(page, fixture, checks, coarse)
        if not coarse:
            reads_and_cancel(page, fixture, checks)
            exact_effects(page, fixture, checks)
        # Snapshot all inspectors before route-disposal resets local drafts.
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            capture(page, checks, f"agents-{label}-{theme}-roster", coarse, inspector(page).get_by_role("heading", name="Synthetic Agent A", exact=True).first)
            capture(page, checks, f"agents-{label}-{theme}-release", coarse, release_panel(page), axe=False)
            capture(page, checks, f"agents-{label}-{theme}-grants", coarse, grants(page), axe=False)
            capture(page, checks, f"agents-{label}-{theme}-adaptation", coarse, adaptation(page), axe=False)
            view(page, "Live work")
            capture(page, checks, f"agents-{label}-{theme}-live", coarse, live(page).get_by_role("heading", name="Live work", exact=True))
            view(page, "Skills")
            capture(page, checks, f"agents-{label}-{theme}-skills", coarse, root(page).get_by_role("heading", name="Skills", exact=True), axe=False)
            view(page, "Outcomes")
            capture(page, checks, f"agents-{label}-{theme}-outcomes", coarse, root(page).get_by_role("heading", name="Agent outcomes", exact=True), axe=False)
            select_agent(page, A, coarse)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 812})
            for theme in ("light", "dark"):
                select_theme(page, theme, True)
                capture(page, checks, "agents-320-" + theme, True, release_panel(page))
        normal_font = release_panel(page).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
        page.evaluate("document.documentElement.style.fontSize='200%'"); settle(page)
        zoomed_font = release_panel(page).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
        checks.check(label + ": inspector text actually doubles", zoomed_font >= normal_font * 1.99, {"before": normal_font, "after": zoomed_font})
        capture(page, checks, "agents-" + label + "-text-200", coarse, inspector(page), axe=False)
        page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
        page.emulate_media(forced_colors="active")
        capture(page, checks, "agents-" + label + "-forced-colors", coarse, release_panel(page), axe=False)
        page.emulate_media(forced_colors="none")
        checks.check(label + ": reduced motion is active", page.evaluate("matchMedia('(prefers-reduced-motion:reduce)').matches"))
        checks.check(label + ": scoped animations and transitions honor reduced motion", root(page).locator("*").evaluate_all("""els=>els.every(el=>{
          const c=getComputedStyle(el);return [c.animationDuration,c.transitionDuration].every(value=>value.split(',').every(part=>parseFloat(part)<=0.00001));
        })"""))
        if not coarse: dispose_effect(page, fixture, checks, origin)
        fixture.mode = "empty"
        navigate(page, origin, "/app/agents?view=skills")
        expect(root(page).get_by_text("No Skills in this successful snapshot.", exact=True)).to_be_visible()
        view(page, "Live work")
        expect(root(page).get_by_role("heading", name="No delegated work yet", exact=True)).to_be_visible()
        checks.check(label + ": empty successful reads establish empty explicitly", True)
        checks.check(label + ": exact intercepted effect budget", len(fixture.writes) == (0 if coarse else 8) and not fixture.effects)
        checks.check(label + ": no unexpected writes, external, popup, download, microphone or playback", not fixture.unexpected and not page.evaluate("window.__agentsForbidden"), fixture.unexpected)
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
    parser.add_argument("--output", type=Path, default=REPO / "test-results/agents")
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
        failure = str(error); print(f"Agents browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated auth and actual Agents route. Synthetic read fixtures; exactly eight locally fulfilled desktop effects maximum: two task cancellation attempts, two profile PATCHes, one adaptation evaluation, one release evaluation, one promotion and one grant revocation. Zero phone effects. All writes/external/media outside exact plans blocked. Held routes settle or abort before context close. Moltbook and Settings composition are excluded; no provider, Agent execution, creation, Trash, retirement or adaptation activation. Compatibility profile writes have no server expected-version CAS and grants have no expected-principal-generation field; this suite makes no cross-client concurrency claim. Axe scope is Agents workspace, with viewport-only captures."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
