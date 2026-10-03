#!/usr/bin/env python3
"""Advanced Settings presentation and exact synthetic recovery contracts.

All eleven desktop effects are fulfilled inside Playwright. Secret issuance,
provider validation, notification delivery and archive/Trash recovery are not
performed. Clipboard and programmatic download requests use recorded stubs.
"""
import argparse
import json
from pathlib import Path
import re
import time
from playwright.sync_api import expect, sync_playwright
from fixtures import STAMP
from run import Checks, REPO, navigate, preview, select_theme
from settings_advanced_fixtures import AdvancedSettingsFixtures, EVIDENCE, KEY, LONG, PROVIDER, RETAINED, SCOPES, TRASH_A, TRASH_B, path

ROOT = '[data-testid="advanced-settings"]'
CURRENT = "Settings are current as of the last successful read."
STALE = "Settings: refresh unavailable; last-loaded details are shown."


def root(page): return page.locator(ROOT)
def button(page, name): return root(page).get_by_role("button", name=name, exact=True)
def ready(page): expect(root(page).get_by_text(CURRENT, exact=True)).to_be_visible()
def refresh(page): button(page, "Refresh settings").click()
def settle(page): page.evaluate("() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
def until(page, predicate, label, timeout=20):
    end = time.monotonic() + timeout
    while not predicate() and time.monotonic() < end: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)
def section(page, name): return root(page).get_by_role("region", name=name, exact=True)
def view(page, name):
    root(page).get_by_role("navigation", name="Settings categories").get_by_role("button", name=name, exact=True).click()
    if name == "General": expect(root(page)).not_to_be_visible()
    else: expect(root(page).get_by_role("heading", name=name, exact=True)).to_be_visible()
    settle(page)
def enter(page, origin, suffix=""):
    navigate(page, origin, "/app/settings" + suffix)
    page.get_by_role("navigation", name="Settings categories").get_by_role("button", name=re.compile(r"^Workspace(?:$| )")).click()
    expect(root(page)).to_be_visible()
def dialog(page, name): return page.get_by_role("dialog", name=name, exact=True)


BOUNDARY = r"""(() => {
  window.untrustedSettingsRan=false; window.__settingsClipboardPlans=[];
  window.__settingsDownloadBudget=0;
  const bad=event=>window.__recordSettingsBoundary(event);
  window.open=(...args)=>{bad({kind:'popup_call',args});return null;};
  HTMLMediaElement.prototype.play=function(){bad({kind:'playback'});return Promise.reject(new Error('Media prohibited'));};
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{bad({kind:'microphone'});return Promise.reject(new Error('Media prohibited'));};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
    const plan=window.__settingsClipboardPlans.shift();
    if(!plan||plan.text!==text){bad({kind:'unexpected_clipboard_stub'});throw new Error('No exact clipboard plan');}
    await window.__recordSettingsClipboard({length:text.length,disposition:plan.ok?'synthetic_success':'synthetic_failure'});
    if(!plan.ok)throw new Error('Synthetic clipboard unavailable');
  }}});
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download){
      if(window.__settingsDownloadBudget===1 && this.href.startsWith('blob:') && this.download==='asael-portable-archive.json'){
        window.__settingsDownloadBudget--;window.__recordSettingsDownload({name:this.download,protocol:'blob:',disposition:'recorded_only_no_download'});
      }else bad({kind:'unplanned_programmatic_download',name:this.download});
      return;
    }
    return click.call(this);
  };
})();"""


def capture(page, checks, name, coarse, target=None, axe=True):
    page.evaluate("window.scrollTo(0,0)"); settle(page)
    checks.check(name + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    geometry = page.evaluate("() => ({viewport:innerWidth,document:document.documentElement.scrollWidth})")
    checks.check(name + ": document reflow", geometry["document"] <= geometry["viewport"] + 1, geometry)
    short = root(page).locator("button:visible,a:visible,summary:visible,input:visible,select:visible").evaluate_all("""(els,min)=>els.flatMap(el=>{
      const target=el.matches('input[type=checkbox]')?(el.closest('label')||el):el;
      const r=target.getBoundingClientRect();return r.height<min-1?[{name:el.getAttribute('aria-label')||el.textContent,height:r.height}]:[];
    })""", 48 if coarse else 44)
    checks.check(name + ": control targets", not short, short)
    if axe:
        if not page.evaluate("Boolean(window.axe)"): page.add_script_tag(path=str(checks.axe))
        result = page.evaluate("""async()=>{const r=await axe.run({exclude:[['nextjs-portal']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>v.id),passes:r.passes.length};}""")
        (checks.output / (name + "-axe.json")).write_text(json.dumps(result, indent=2))
        checks.check(name + ": page-wide axe", not result["violations"], result["violations"])
    if target is not None:
        target.evaluate("el=>el.scrollIntoView({block:'start'})"); page.evaluate("window.scrollBy(0,-112)"); settle(page)
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    checks.check(name + ": viewport capture preserves pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)


def read_states(page, fixture, checks, coarse):
    expect(root(page).get_by_text("Settings are unavailable.", exact=True)).to_be_visible()
    expect(root(page).get_by_text("Push readiness details are unavailable.", exact=True)).to_be_visible()
    checks.check("Initial failures never claim known workspace readiness or an empty installation list", "Counts and health are unavailable." in root(page).inner_text() and "Installation count unavailable." in root(page).inner_text() and "No active native installation was returned." not in root(page).inner_text())
    fixture.mode = "ready"; button(page, "Refresh push readiness").click()
    expect(root(page).get_by_text("Push readiness details are current as of the last successful read.", exact=True)).to_be_visible()
    expect(button(page, "Run live check")).to_be_disabled()
    checks.check("Independent push read recovers while aggregate Settings remains unavailable", root(page).get_by_text("Settings are unavailable.", exact=True).is_visible())
    refresh(page); ready(page)
    checks.check("Workspace renders the exact release and vault identities", "release:" + LONG in root(page).inner_text() and "keyring:" + LONG in root(page).inner_text())
    target = root(page).get_by_role("combobox", name="Target installation", exact=True)
    expect(target).to_have_value("")
    target.select_option(fixture.targets["registrations"][0]["id"])
    fixture.plan("push", body={"error": "Synthetic independent push read unavailable"}, status=503)
    button(page, "Refresh push readiness").click()
    expect(root(page).get_by_text("Push readiness details: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
    expect(target).to_have_value(fixture.targets["registrations"][0]["id"]); expect(button(page, "Run live check")).to_be_disabled()
    checks.check("Stale installation identity survives without implying current delivery authority", "Last-loaded targets" in root(page).inner_text() and fixture.targets["registrations"][0]["deviceId"] in root(page).inner_text())
    button(page, "Refresh push readiness").click()
    expect(root(page).get_by_text("Push readiness details are current as of the last successful read.", exact=True)).to_be_visible()
    if not coarse: capture(page, checks, "settings-workspace-desktop-light", False, section(page, "Live notification receipt"))
    view(page, "AI providers")
    checks.check("Provider full identities, owners, fingerprint and untrusted evidence remain text", all(value in section(page, "AI providers").text_content() for value in (PROVIDER, RETAINED, fixture.actor, "fingerprint:" + LONG, EVIDENCE)) and not page.evaluate("window.untrustedSettingsRan"))
    checks.check("Retained and environment connections expose no effect buttons", button(page, "Rotate Retained provider " + LONG).count() == 0 and button(page, "Validate Deployment provider").count() == 0)
    expect(button(page, "Connect OpenAI")).to_be_disabled()
    trigger = button(page, "Connect Google Gemini"); trigger.click()
    modal = dialog(page, "Connect Google Gemini"); expect(modal).to_be_visible()
    modal.get_by_label("Gemini API key", exact=True).fill("synthetic-only-unsent-secret")
    for _ in range(6):
        page.keyboard.press("Tab")
        checks.check("Provider dialog contains keyboard focus", modal.evaluate("el=>el.contains(document.activeElement) || (!document.hasFocus() && document.activeElement===document.body)"))
    page.keyboard.press("Escape"); expect(modal).to_have_count(0); expect(trigger).to_be_focused()
    trigger.click(); expect(dialog(page, "Connect Google Gemini").get_by_label("Gemini API key", exact=True)).to_have_value("")
    page.keyboard.press("Escape")
    checks.check("Closing unsent credential review discards its secret without a request", len(fixture.writes) == 0)
    view(page, "API & MCP")
    root(page).get_by_role("textbox", name="Service key name", exact=True).fill("Retained local key draft")
    view(page, "General")
    expect(root(page)).not_to_be_visible()
    page.get_by_role("navigation", name="Settings categories").get_by_role("button", name=re.compile(r"^API & MCP(?:$| )")).click()
    expect(root(page).get_by_role("textbox", name="Service key name", exact=True)).to_have_value("Retained local key draft")
    fixture.plan("settings", body={"error": "Synthetic refresh unavailable. " + EVIDENCE}, status=503)
    refresh(page); expect(root(page).get_by_text(STALE, exact=True)).to_be_visible()
    expect(root(page).get_by_role("textbox", name="Service key name", exact=True)).to_have_value("Retained local key draft")
    expect(button(page, "Create service key")).to_be_disabled()
    checks.check("Same-scope and failed refresh retain the key draft while blocking stale writes", True)
    # Agent choices have their own GET; failed provider configuration is not Agent authority.
    view(page, "Agent control")
    until(page, lambda: any(item["key"] == "agents" for item in fixture.requests), "Agent choice read")
    expect(button(page, "Refresh Agent choices")).to_be_visible()
    expect(root(page).get_by_text("This Agent uses reviewed server policy and has no user-authored explicit grant IDs. Built-in authority cannot be widened from Settings.", exact=True)).to_be_visible()
    checks.check("Agent authority remains independently readable", root(page).get_by_text(STALE, exact=True).is_visible() and len(fixture.writes) == 0)
    refresh(page); ready(page)
    old = fixture.snapshot(); old["platform"]["releaseRevision"] = "obsolete-settings-revision"
    fixture.plan("settings", body=old, hold="old-settings-read")
    refresh(page); until(page, lambda: "old-settings-read" in fixture.held, "Old settings GET held")
    refresh(page); ready(page); fixture.release("old-settings-read"); settle(page)
    view(page, "Workspace")
    checks.check("Replaced late Settings read cannot restore an obsolete revision", "obsolete-settings-revision" not in root(page).inner_text() and "release:" + LONG in root(page).inner_text())


def provider_and_route(page, fixture, checks):
    view(page, "AI providers")
    button(page, "Rotate Synthetic OpenAI").click()
    modal = dialog(page, "Rotate OpenAI")
    modal.get_by_label("API key", exact=True).fill("synthetic-replacement-secret-never-sent")
    expect(modal.get_by_label("API key", exact=True)).to_have_attribute("type", "password")
    modal.get_by_role("button", name="Show API key", exact=True).click()
    expect(modal.get_by_label("API key", exact=True)).to_have_attribute("type", "text")
    rotated = {**fixture.providers[0], "credentialVersion": 2, "updatedAt": "2026-10-04T13:00:00.000Z"}
    fixture.effect(path("settings/providers", PROVIDER, "/rotate"), "POST", {"credentials": {"apiKey": "synthetic-replacement-secret-never-sent"}, "validateNow": True}, {"connection": rotated}, hold="rotation")
    modal.get_by_role("button", name="Rotate and validate", exact=True).click()
    until(page, lambda: "rotation" in fixture.held, "Rotation held")
    expect(modal.get_by_role("button", name="Close Rotate OpenAI", exact=True)).to_be_disabled()
    expect(modal.get_by_label("API key", exact=True)).to_be_disabled()
    page.keyboard.press("Escape"); expect(modal).to_be_visible()
    checks.check("One pending action freezes the reviewed secret and all background writes", button(page, "Disable Synthetic OpenAI").is_disabled() and button(page, "Refresh settings").is_disabled() and len(fixture.writes) == 1)
    fixture.providers[0] = rotated
    fixture.plan("settings", status=503, body={"error": "Synthetic post-rotation read unavailable"}, hold="rotation-follow-up")
    fixture.release("rotation"); expect(modal).to_have_count(0)
    until(page, lambda: "rotation-follow-up" in fixture.held, "Rotation follow-up held")
    expect(button(page, "Refresh settings")).to_be_enabled()
    expect(root(page).get_by_text("Confirmed settings response · Rotate OpenAI", exact=True)).to_be_visible()
    fixture.release("rotation-follow-up"); expect(root(page).get_by_text(STALE, exact=True)).to_be_visible()
    checks.check("Accepted rotation remains distinct from failed current-state verification", root(page).get_by_text("Confirmed settings response · Rotate OpenAI", exact=True).is_visible())
    refresh(page); ready(page)
    capture(page, checks, "settings-providers-desktop-light", False, section(page, "AI providers"))
    view(page, "Model routing"); route = section(page, "Main agent routing")
    route.get_by_role("combobox", name="Main agent primary model", exact=True).select_option("synthetic-model-b")
    route.get_by_role("combobox", name="Main agent fallback provider", exact=True).select_option("anthropic")
    route.get_by_role("combobox", name="Main agent fallback model", exact=True).select_option("synthetic-claude")
    expect(route.get_by_role("button", name="Save Main agent route", exact=True)).to_be_disabled()
    route.get_by_role("checkbox", name="Allow Main agent cross-provider disclosure to anthropic", exact=True).check()
    fixture.assignments[0] = fixture.assignment(2)
    refresh(page); ready(page)
    expect(route.get_by_role("combobox", name="Main agent primary model", exact=True)).to_have_value("synthetic-model-b")
    expect(route.get_by_role("button", name="Save Main agent route", exact=True)).to_be_disabled()
    expect(route.get_by_text("The saved configuration changed. Your draft is retained, but saving is blocked until you review the current source.", exact=True)).to_be_visible()
    route.get_by_role("button", name="I reviewed the current version; keep my draft", exact=True).click()
    fixture.assignments[0] = fixture.assignment(3, "synthetic-model-b", True)
    body = {"scope": "main_agent", "provider": "openai", "modelId": "synthetic-model-b", "fallbackProvider": "anthropic", "fallbackModelId": "synthetic-claude", "crossProviderFallbackConsent": True}
    fixture.effect("/api/settings/assignments", "PUT", body, {"assignment": fixture.assignments[0]})
    route.get_by_role("button", name="Save Main agent route", exact=True).click(); ready(page)
    expect(route.get_by_text("3" * 64, exact=True)).to_be_visible()
    expect(route.get_by_text("No runtime receipt for this exact revision yet.", exact=True)).to_be_visible()
    checks.check("A saved revision never fabricates evidence of an actual model call", "Actual call outcome" not in route.inner_text())
    catalog = section(page, "Discovered models")
    catalog.get_by_role("searchbox", name="Search model catalog", exact=True).fill("no-such-synthetic-model")
    expect(catalog.get_by_text("No catalog models match this search.", exact=True)).to_be_visible()
    view(page, "AI providers"); view(page, "Model routing")
    expect(catalog.get_by_role("searchbox", name="Search model catalog", exact=True)).to_have_value("no-such-synthetic-model")
    catalog.get_by_role("searchbox", name="Search model catalog", exact=True).fill("")
    capture(page, checks, "settings-routing-desktop-light", False, route)
    view(page, "AI providers")
    fixture.providers[0] = {**fixture.providers[0], "enabled": False}
    fixture.effect(path("settings/providers", PROVIDER), "PATCH", {"enabled": False}, {"connection": fixture.providers[0]}, key=True)
    button(page, "Disable Synthetic OpenAI").click(); ready(page)
    expect(button(page, "Enable Synthetic OpenAI")).to_be_visible()
    checks.check("Provider enablement uses the exact encoded identity and acknowledged state", len(fixture.writes) == 3)


def keys_and_mcp(page, fixture, checks):
    view(page, "API & MCP")
    root(page).get_by_role("textbox", name="Service key name", exact=True).fill("Synthetic UI key")
    issued = fixture.key(); fixture.keys.append(issued)
    fixture.effect("/api/settings/api-keys", "POST", {"name": "Synthetic UI key", "scopes": SCOPES}, {"record": issued, "token": fixture.token})
    button(page, "Create service key").click()
    modal = dialog(page, "Copy this key now"); expect(modal).to_be_visible()
    expect(modal.get_by_text(fixture.token, exact=True)).to_be_visible()
    for ok in (False, True):
        page.evaluate("plan=>window.__settingsClipboardPlans.push(plan)", {"text": fixture.token, "ok": ok})
        modal.get_by_role("button", name="Copy key", exact=True).click()
        expect(modal.get_by_text("Key copied." if ok else "The key could not be copied. Select the displayed text and copy it manually.", exact=True)).to_be_visible()
    modal.get_by_role("button", name="I saved the key", exact=True).click(); expect(modal).to_have_count(0); ready(page)
    checks.check("One-time token disappears after acknowledgement and is never persisted in web storage", fixture.token not in page.content() and not page.evaluate("token=>JSON.stringify(localStorage).includes(token)||JSON.stringify(sessionStorage).includes(token)", fixture.token))
    button(page, "Revoke Synthetic UI key").click(); modal = dialog(page, "Revoke Synthetic UI key")
    expect(modal.get_by_text(KEY, exact=True)).to_be_visible()
    revoked = {**issued, "status": "revoked"}; fixture.keys[-1] = revoked
    fixture.effect(path("settings/api-keys", KEY), "DELETE", None, {"apiKey": revoked, "targetSha256": "c" * 64}, key=True)
    modal.get_by_role("button", name="Confirm revoke key", exact=True).click(); expect(modal).to_have_count(0); ready(page)
    checks.check("Revoked and retained keys expose no revocation action", button(page, "Revoke Synthetic UI key").count() == 0 and button(page, "Revoke Retained service key " + LONG).count() == 0)
    policy = section(page, "MCP export policy")
    policy.get_by_role("textbox", name="MCP server name", exact=True).fill("Reviewed synthetic MCP")
    policy.get_by_role("checkbox", name="Enable MCP export", exact=True).check()
    fixture.mcp = {**fixture.mcp, "serverName": "New authoritative policy", "updatedAt": "2026-10-04T14:00:00.000Z"}
    refresh(page); ready(page)
    expect(policy.get_by_role("button", name="Save MCP policy", exact=True)).to_be_disabled()
    expect(policy.get_by_role("textbox", name="MCP server name", exact=True)).to_have_value("Reviewed synthetic MCP")
    policy.get_by_role("button", name="I reviewed the current version; keep my draft", exact=True).click()
    body = {"enabled": True, "serverName": "Reviewed synthetic MCP", "allowedScopes": SCOPES, "exposeResources": False}
    bad = {**fixture.mcp, **body, "serverName": "Wrong returned policy", "readiness": "ready"}
    fixture.effect("/api/settings/mcp", "PUT", body, {"mcp": bad}, key=True)
    policy.get_by_role("button", name="Save MCP policy", exact=True).click()
    expect(root(page).get_by_role("alert")).to_contain_text("did not match")
    ready(page); first_key = fixture.writes[-1]["idempotencyKey"]
    expect(policy.get_by_role("textbox", name="MCP server name", exact=True)).to_have_value("Reviewed synthetic MCP")
    fixture.mcp = {**fixture.mcp, **body, "readiness": "ready"}
    fixture.effect("/api/settings/mcp", "PUT", body, {"mcp": fixture.mcp}, key=True, hold="mcp-retry")
    policy.get_by_role("button", name="Save MCP policy", exact=True).click()
    until(page, lambda: "mcp-retry" in fixture.held, "MCP retry held")
    expect(policy.get_by_role("textbox", name="MCP server name", exact=True)).to_be_disabled()
    expect(button(page, "Create service key")).to_be_disabled()
    checks.check("Malformed policy receipt preserves exact retry identity and shared exclusion", first_key == fixture.writes[-1]["idempotencyKey"] and len(fixture.writes) == 7)
    fixture.release("mcp-retry"); ready(page)
    expect(root(page).get_by_text("Confirmed settings response · Save MCP policy", exact=True)).to_be_visible()
    capture(page, checks, "settings-api-desktop-light", False, policy)


def push_and_recovery(page, fixture, checks):
    view(page, "Workspace")
    button(page, "Refresh push readiness").click()
    expect(root(page).get_by_text("Push readiness details are current as of the last successful read.", exact=True)).to_be_visible()
    registration = fixture.targets["registrations"][0]
    root(page).get_by_role("combobox", name="Target installation", exact=True).select_option(registration["id"])
    result = {"schemaVersion": 1, "canaryId": "canary:" + LONG, "deliveryId": "delivery:" + LONG, "outcome": "timed_out", "timedOut": True, "state": {"id": "delivery:" + LONG, "causeKind": "canary", "causeId": "canary:" + LONG, "providerState": "accepted", "appState": "none", "providerAcceptedAt": STAMP, "receivedAt": None, "failureCode": None}}
    fixture.effect("/api/mobile/push/canary", "POST", {"registrationId": registration["id"], "timeoutSeconds": 12}, result, key=True, hold="push-result")
    button(page, "Run live check").click(); until(page, lambda: "push-result" in fixture.held, "Push result held")
    expect(root(page).get_by_role("combobox", name="Target installation", exact=True)).to_be_disabled()
    fixture.plan("push", status=503, body={"error": "Synthetic push verification unavailable"}, hold="push-follow-up")
    fixture.release("push-result")
    expect(root(page).get_by_role("heading", name="Provider accepted; device receipt timed out", exact=True)).to_be_visible()
    until(page, lambda: "push-follow-up" in fixture.held, "Push follow-up held")
    expect(button(page, "Refresh settings")).to_be_enabled()
    fixture.release("push-follow-up")
    expect(root(page).get_by_text("Push readiness details: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
    checks.check("Provider acceptance never becomes device delivery and full requested/result IDs survive refresh failure", all(value in section(page, "Live notification receipt").inner_text() for value in ("This is not counted as delivery.", registration["id"], registration["deviceId"], result["canaryId"], result["deliveryId"])))
    fixture.plan("push", body={**fixture.targets, "registrations": []})
    button(page, "Refresh push readiness").click()
    expect(root(page).get_by_text("The selected installation is unavailable. Choose an available installation or refresh; it has not been replaced automatically.", exact=True)).to_be_visible()
    expect(button(page, "Run live check")).to_be_disabled()
    view(page, "Data & privacy")
    expect(root(page).get_by_text("Trash records are current as of the last successful read.", exact=True)).to_be_visible()
    fixture.plan("trash", status=503, body={"error": "Synthetic retained Trash failure"})
    button(page, "Refresh trash").click()
    expect(root(page).get_by_text("Trash records: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
    expect(button(page, "Review restore Synthetic recoverable skill")).to_be_disabled()
    checks.check("Trash retains full last-loaded records without allowing stale recovery", TRASH_A in root(page).inner_text() and "Last loaded: 2 retained items." in root(page).inner_text())
    button(page, "Refresh trash").click()
    expect(root(page).get_by_text("Trash records are current as of the last successful read.", exact=True)).to_be_visible()
    for identity, action, title, trigger, confirm in ((TRASH_A, "restore", "Review restoration", "Review restore Synthetic recoverable skill", "Confirm restore"), (TRASH_B, "purge", "Review permanent deletion", "Review purge Synthetic purgeable connector", "Confirm permanent purge")):
        opener = button(page, trigger); opener.click(); modal = dialog(page, title); expect(modal).to_be_visible()
        modal.get_by_text("Exact reviewed preview", exact=True).click()
        reviewed = json.loads(modal.locator("pre").inner_text())
        checks.check("Exact " + action + " review binds full resource, revision, digest and evidence", reviewed["trashId"] == identity and reviewed["lifecycleRevision"] == 1 and EVIDENCE in reviewed["effectSummary"] and reviewed["previewSha256"] in modal.inner_text())
        page.keyboard.press("Escape"); expect(modal).to_have_count(0); expect(opener).to_be_focused()
        opener.click(); modal = dialog(page, title); expect(modal).to_be_visible()
        modal.get_by_text("Exact reviewed preview", exact=True).click(); reviewed = json.loads(modal.locator("pre").inner_text())
        receipt = fixture.trash_receipt(reviewed)
        fixture.effect(path("trash", identity, "/" + action), "POST" if action == "restore" else "DELETE", {"preview": reviewed}, receipt, key=True, hold="trash-" + action)
        modal.get_by_role("button", name=confirm, exact=True).click()
        until(page, lambda: "trash-" + action in fixture.held, "Trash effect held")
        expect(modal.get_by_role("button", name="Close " + title, exact=True)).to_be_disabled()
        expect(button(page, "Download archive v2")).to_be_disabled()
        fixture.trash_items = [item for item in fixture.trash_items if item["trashId"] != identity]
        if action == "restore": fixture.plan("trash", status=503, body={"error": "Synthetic post-restore read unavailable"})
        fixture.release("trash-" + action); expect(modal).to_have_count(0)
        expect(root(page).get_by_text(("Restoration confirmed: Synthetic recoverable skill" if action == "restore" else "Permanent deletion confirmed: Synthetic purgeable connector"), exact=True)).to_be_visible()
        if action == "restore":
            expect(root(page).get_by_text("Trash records: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
            button(page, "Refresh trash").click()
        expect(root(page).get_by_text("Trash records are current as of the last successful read.", exact=True)).to_be_visible()
    upload = root(page).get_by_label("Choose an Asael archive to restore", exact=True)
    upload.set_input_files({"name": "empty.json", "mimeType": "application/json", "buffer": b""})
    expect(root(page).get_by_text("Choose a nonempty JSON archive no larger than 4 MB.", exact=True)).to_be_visible()
    expect(button(page, "Verify and restore")).to_be_disabled()
    upload.set_input_files({"name": "synthetic-only-archive.json", "mimeType": "application/json", "buffer": json.dumps(fixture.archive).encode()})
    expect(button(page, "Verify and restore")).to_be_enabled()
    checks.check("Selecting a local archive performs no upload or restore", len(fixture.writes) == 10)
    view(page, "Workspace"); view(page, "Data & privacy")
    expect(root(page).get_by_text("synthetic-only-archive.json", exact=True)).to_be_visible()
    fixture.effect("/api/data/restore", "POST", fixture.archive, fixture.portable_receipt(), hold="archive-restore")
    button(page, "Verify and restore").click(); until(page, lambda: "archive-restore" in fixture.held, "Archive restore held")
    expect(upload).to_be_disabled(); expect(button(page, "Refresh trash")).to_be_disabled()
    fixture.release("archive-restore")
    expect(root(page).get_by_text("V2 restore receipt confirmed · 0 records processed.", exact=True)).to_be_visible()
    checks.check("Verified empty archive does not fabricate restored records", fixture.archive["archiveSha256"] in root(page).inner_text())
    root(page).get_by_role("checkbox", name="Include eligible original assets", exact=True).check()
    expect(button(page, "Download archive v2")).to_be_disabled()
    root(page).get_by_label("Asset passphrase", exact=True).fill("synthetic-long-passphrase")
    view(page, "API & MCP"); view(page, "Data & privacy")
    expect(root(page).get_by_label("Asset passphrase", exact=True)).to_have_value("synthetic-long-passphrase")
    root(page).get_by_role("checkbox", name="Include eligible original assets", exact=True).uncheck()
    page.evaluate("window.__settingsDownloadBudget=1")
    button(page, "Download archive v2").click()
    expect(root(page).get_by_text("Archive prepared; browser download requested. Check your browser downloads for the saved file.", exact=True)).to_be_visible()
    until(page, lambda: len(fixture.local_downloads) == 1, "Recorded download stub")
    checks.check("Verified export records one bounded synthetic download request only", len(fixture.local_downloads) == 1 and len([item for item in fixture.requests if item["key"] == "export"]) == 1)
    select_theme(page, "dark", False)
    capture(page, checks, "settings-data-desktop-dark", False, section(page, "Your portable Asael archive"))


def read_only_layouts(page, fixture, checks, coarse):
    name = "phone" if coarse else "desktop"
    # Exercise local pagination with readable retained metadata, never extra authority.
    fixture.providers.extend(fixture.provider("retained-page:" + str(i), "Retained page " + str(i), owner="retained-actor", manageable=False) for i in range(10))
    refresh(page); ready(page); view(page, "AI providers")
    button(page, "Next connections").click()
    expect(root(page).get_by_text("13–14 of 14", exact=True)).to_be_visible()
    button(page, "Previous connections").click()
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse)
        capture(page, checks, "settings-providers-" + name + "-" + theme, coarse, section(page, "AI providers"), axe=coarse)
    if coarse:
        page.set_viewport_size({"width": 320, "height": 812})
        view(page, "API & MCP"); select_theme(page, "light", True)
        capture(page, checks, "settings-api-320-light", True, section(page, "MCP export policy"))
        view(page, "Data & privacy")
        expect(root(page).get_by_text("Trash records are current as of the last successful read.", exact=True)).to_be_visible()
        select_theme(page, "dark", True)
        capture(page, checks, "settings-data-320-dark", True, section(page, "Trash recovery"))
    view(page, "API & MCP")
    label = root(page).get_by_role("heading", name="Service identities", exact=True)
    before = label.evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
    page.evaluate("document.documentElement.style.fontSize='200%'"); settle(page)
    after = label.evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
    checks.check(name + ": reading text doubles", after >= before * 1.99, {"before": before, "after": after})
    capture(page, checks, "settings-api-" + name + "-text-200", coarse, section(page, "MCP export policy"), axe=False)
    page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
    page.emulate_media(forced_colors="active")
    capture(page, checks, "settings-api-" + name + "-forced-colors", coarse, section(page, "MCP export policy"), axe=False)
    page.emulate_media(forced_colors="none")
    checks.check(name + ": reduced motion", page.evaluate("matchMedia('(prefers-reduced-motion:reduce)').matches") and root(page).locator("*").evaluate_all("els=>els.every(el=>[getComputedStyle(el).animationDuration,getComputedStyle(el).transitionDuration].every(v=>v.split(',').every(p=>parseFloat(p)<=0.00001)))"))
    fixture.plan("settings", hold="disposed-settings")
    refresh(page); until(page, lambda: "disposed-settings" in fixture.held, "Disposed read held")
    fixture.mode = "empty"; enter(page, fixture.origin, "?synthetic=empty"); ready(page)
    fixture.release("disposed-settings"); settle(page)
    expect(root(page).get_by_text("No active native installation was returned. Enable notifications in the native app and refresh.", exact=True)).to_be_visible()
    view(page, "AI providers")
    expect(root(page).get_by_text("No provider connections were returned by this successful read.", exact=True)).to_be_visible()
    view(page, "Model routing")
    expect(root(page).get_by_text("No models were returned in the successful catalog read.", exact=True)).to_be_visible()
    view(page, "API & MCP")
    expect(root(page).get_by_text("No service keys were returned by this successful read.", exact=True)).to_be_visible()
    view(page, "Data & privacy")
    expect(root(page).get_by_text("No retained items were returned by this successful read.", exact=True)).to_be_visible()
    checks.check(name + ": successful empty snapshots stay distinct from failures and disposed reads", not root(page).get_by_text(STALE, exact=True).is_visible() and not page.evaluate("window.untrustedSettingsRan"))


def exercise(browser, origin, credentials, checks, coarse):
    name = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture, page, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(name + ": real isolated synthetic login", login.ok)
        fixture = AdvancedSettingsFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        fixture.mode = "error"; fixture.max_effects = 0 if coarse else 11
        context.route("**/*", fixture.route)
        context.expose_binding("__recordSettingsBoundary", lambda source, event: fixture.unexpected.append(event))
        context.expose_binding("__recordSettingsClipboard", lambda source, event: fixture.clipboard.append(event))
        context.expose_binding("__recordSettingsDownload", lambda source, event: fixture.local_downloads.append(event))
        context.add_init_script(BOUNDARY)
        page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup_event"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download_event"}), download.cancel()))
        enter(page, origin); select_theme(page, "light", coarse)
        read_states(page, fixture, checks, coarse)
        if not coarse:
            provider_and_route(page, fixture, checks)
            keys_and_mcp(page, fixture, checks)
            push_and_recovery(page, fixture, checks)
        read_only_layouts(page, fixture, checks, coarse)
        checks.check(name + ": exact intercepted effect budget", len(fixture.writes) == (0 if coarse else 11) and not fixture.effects, fixture.writes)
        checks.check(name + ": clipboard stub budget", len(fixture.clipboard) == (0 if coarse else 2), fixture.clipboard)
        checks.check(name + ": local download stub budget", len(fixture.local_downloads) == (0 if coarse else 1), fixture.local_downloads)
        checks.check(name + ": no held routes or unconsumed read plans", not fixture.held and not any(fixture.plans.values()), {"held": list(fixture.held), "plans": {key: len(plans) for key, plans in fixture.plans.items() if plans}})
        checks.check(name + ": no unexpected writes, external requests, media, popups or actual downloads", not fixture.unexpected, fixture.unexpected)
        checks.check(name + ": no uncaught browser errors", not errors, errors)
        return {"viewport": name, "reads": fixture.requests, "syntheticRequests": fixture.writes, "clipboardStubs": fixture.clipboard, "downloadStubs": fixture.local_downloads, "heldDispositions": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
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
    parser.add_argument("--output", type=Path, default=REPO / "test-results/settings-advanced")
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
        failure = str(error); print(f"Advanced Settings browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual lazy Advanced Settings route and real isolated synthetic login. Eleven exact desktop effects wholly intercepted: provider rotate POST and enablement PATCH, assignment PUT, service-key POST/DELETE, two MCP PUTs (wrong receipt then exact retry), push canary POST, Trash restore POST/purge DELETE, portable restore POST. Phone is GET-only. One bounded synthetic archive export GET, two recorded clipboard stubs and one intercepted blob download request; no live credentials issued, provider validation, notification, recovery, clipboard write, filesystem download, media, popup or external call. All held routes settle/abort before context close. Manual browser-safe fixture hashes bind exact reviewed previews and receipts. Page-wide axe, viewport captures, real text scaling, pointer assertions. Scope excludes real backend authorization, native push delivery, encrypted-asset cryptography, Agent grant mutation parity (covered by the separate Agents family), cross-client CAS and legacy endpoint replay guarantees. No denied-session SSR or RSC transformation is used."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
