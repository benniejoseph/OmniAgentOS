#!/usr/bin/env python3
"""Six Capabilities views and Connections with bounded synthetic effects only.

Reuses the isolated preview and real login. OAuth/provider/spec fetches, workflow
execution, installs and connector writes are intercepted; none reaches the server.
"""

import argparse
import json
from pathlib import Path
import re
import time
from datetime import datetime

from playwright.sync_api import expect, sync_playwright
from capabilities_fixtures import (CapabilityFixtures, GRANT, INSTALLATION, MCP, REST, SCHEDULE, LONG,
                                  connector, digest, manifest, oauth, overview, plugin_catalog,
                                  plugin_installation, plugin_preview, schedule, tool, trash_receipts)
from run import Checks, REPO, navigate, preview, select_theme


def until(page, predicate, message, seconds=20):
    deadline = time.monotonic() + seconds
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def settle(page):
    page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


def studio(page):
    return page.get_by_role("tablist", name="Capabilities workspace sections").locator("xpath=..")


def admin(page):
    return page.get_by_test_id("integrations-workspace")


def tab(page, name):
    control = page.get_by_role("tab", name=name, exact=True)
    control.click()
    expect(control).to_have_attribute("aria-selected", "true")
    return page.locator("#" + control.get_attribute("aria-controls"))


def section(page, name):
    control = admin(page).get_by_role("button", name=re.compile("^" + re.escape(name) + r"(?:\s|$)"))
    control.click()
    expect(control).to_have_attribute("aria-pressed", "true")
    return page.locator("#" + control.get_attribute("aria-controls"))


def disclose(scope, label):
    control = scope.locator("summary").filter(has_text=re.compile(r"^\s*" + re.escape(label)))
    if not control.evaluate("el=>el.parentElement.open"):
        control.click()
    return control.locator("xpath=..")


def refresh_studio(page):
    control = studio(page).get_by_role("button", name="Refresh", exact=True)
    control.click()
    expect(control).to_be_enabled()


def refresh_connections(page):
    control = admin(page).get_by_role("button", name="Refresh connections", exact=True)
    control.click()
    expect(control).to_be_enabled()


def target_floor(scope, checks, label, coarse):
    values = scope.locator("button:visible, a:visible, summary:visible, input:visible, select:visible, textarea:visible").evaluate_all("""els=>els.filter(el=>!['checkbox','radio'].includes(el.type)).map(el=>({
      name:(el.innerText||el.getAttribute('aria-label')||el.tagName).slice(0,80),
      height:el.getBoundingClientRect().height, font:parseFloat(getComputedStyle(el).fontSize)}))""")
    checks.check(label + ": control target and UI type floor", all(item["height"] >= (47.9 if coarse else 43.9) and item["font"] >= 13.9 for item in values), values)


def initial_and_views(page, fixture, checks, coarse):
    label = "phone" if coarse else "desktop"
    fixture.defaults["/api/skills"] = {"body": {"error": "Synthetic initial skills unavailable."}, "status": 503, "hold": "skills-initial"}
    navigate(page, fixture.origin, "/app/automation?view=skills&keep=fixture")
    expect(page.get_by_role("heading", name="Capabilities", exact=True)).to_be_visible()
    until(page, lambda: "skills-initial" in fixture.held, "Initial Skills GET was not held")
    panel = page.locator("#automation-panel-skills")
    expect(panel.get_by_label("Loading inventory")).to_be_visible()
    checks.check(label + ": initial unknown Skills do not claim an empty catalog", "No Skills are available" not in panel.inner_text())
    fixture.defaults.clear()
    for held in list(fixture.held):
        fixture.release(held)
    expect(panel).to_contain_text("Synthetic initial skills unavailable")
    checks.check(label + ": failed first read remains unavailable", "No Skills are available" not in panel.inner_text())
    refresh_studio(page)
    expect(panel.get_by_text("Fixture source method", exact=True)).to_be_visible()
    select_theme(page, "light", coarse)
    for name in ("Overview", "Automations", "Skills", "Connections", "Extensions", "Advanced"):
        tab(page, name)
        checks.check(label + ": " + name + " keeps unrelated query", "keep=fixture" in page.url)
        settle(page)
        checks.snapshot(page, f"capabilities-{label}-{name.lower()}-light", coarse)
        target_floor(studio(page), checks, label + " " + name, coarse)
    tab(page, "Automations").get_by_role("button", name="New schedule", exact=True).click()
    page.get_by_label("Routine name", exact=True).fill("Preserved local draft")
    tab(page, "Skills"); tab(page, "Automations")
    expect(page.get_by_label("Routine name", exact=True)).to_have_value("Preserved local draft")
    checks.check(label + ": local builder survives view changes", True)
    page.locator("#automation-panel-automations").get_by_role("button", name="Cancel", exact=True).click()
    tab(page, "Advanced").get_by_role("heading", name="Capability audit", exact=True).wait_for()
    page.get_by_role("tab", name="Advanced", exact=True).focus()
    page.keyboard.press("Home")
    expect(page.get_by_role("tab", name="Overview", exact=True)).to_be_focused()
    page.keyboard.press("End")
    expect(page.get_by_role("tab", name="Advanced", exact=True)).to_be_focused()
    checks.check(label + ": keyboard tabs have working Home and End", True)
    checks.check(label + ": keyboard focus uses canonical three-pixel outline", page.get_by_role("tab", name="Advanced", exact=True).evaluate("el=>getComputedStyle(el).outlineWidth==='3px'"))
    tab(page, "Extensions")
    select_theme(page, "dark", coarse)
    settle(page); checks.snapshot(page, f"capabilities-{label}-extensions-dark", coarse)
    page.evaluate("document.documentElement.style.fontSize='200%'")
    settle(page); checks.snapshot(page, f"capabilities-{label}-text200", coarse)
    page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
    checks.check(label + ": retrieved markup stays text", page.evaluate("window.untrustedCapabilityRan !== true"))


def extension_effects(page, fixture, checks):
    panel = tab(page, "Extensions")
    preview_result = plugin_preview()
    body = {"pluginId": manifest()["pluginId"], "version": "1.0.0", "manifestSha256": digest(manifest())}
    fixture.expect_action("/api/plugins/preview", body, preview_result, key="plugin-preview", status=201, hold="plugin-preview")
    panel.get_by_role("button", name="Review", exact=True).click()
    until(page, lambda: "plugin-preview" in fixture.held, "Extension preview not held")
    expect(panel.get_by_role("button", name="Preparing…", exact=True)).to_be_disabled()
    checks.check("Review pending blocks installation and schedule mutation synchronously", True)
    fixture.release("plugin-preview")
    dialog = page.get_by_role("dialog", name="Review Fixture evidence extension", exact=True)
    expect(dialog).to_be_visible()
    disclose(dialog, "Technical verification")
    disclose(dialog, "Full reviewed declarative manifest")
    checks.check("Preview displays full immutable identity and declared instructions", preview_result["preview"]["manifestSha256"] in dialog.inner_text() and LONG in dialog.inner_text())
    for _ in range(8):
        page.keyboard.press("Tab")
        focus = dialog.evaluate("""el=>({within:el.contains(document.activeElement),documentFocused:document.hasFocus(),
          activeTag:document.activeElement?.tagName,activeName:document.activeElement?.getAttribute('aria-label')})""")
        # Native dialogs may move Tab focus to browser chrome. While this document
        # owns keyboard focus, no application element outside the modal may own it.
        checks.check("Native Extension review contains application keyboard focus", focus["within"] or not focus["documentFocused"], focus)
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    expect(panel.get_by_role("button", name="Review", exact=True)).to_be_focused()
    checks.check("Cancel returns to the explicit review origin captured before pending disable", True)
    preview_result = plugin_preview()
    preview_result["preview"]["previewId"] = "plugin-preview-browser-evidence-second"
    preview_result["preview"]["previewSha256"] = digest({key: value for key, value in preview_result["preview"].items() if key != "previewSha256"})
    fixture.expect_action("/api/plugins/preview", body, preview_result, key="plugin-preview", status=201)
    panel.get_by_role("button", name="Review", exact=True).click()
    expect(dialog).to_be_visible()
    accepted = plugin_installation()
    fixture.expect_action("/api/plugins/install", {"previewId": preview_result["preview"]["previewId"], "manifestSha256": digest(manifest())}, accepted,
                          key="plugin-install", status=201, after=lambda: setattr(fixture, "installed", accepted["installation"]))
    dialog.get_by_role("button", name="Install Extension", exact=True).click()
    expect(dialog).to_have_count(0)
    expect(panel.get_by_role("button", name="Disable", exact=True)).to_be_enabled()
    receipt_summary = panel.locator("summary").filter(has_text=re.compile("^Last confirmed Extension receipt$"))
    expect(receipt_summary).to_be_focused()
    receipt = disclose(panel, "Last confirmed Extension receipt")
    checks.check("Successful install inventory relocation restores focus to confirmed receipt", INSTALLATION in receipt.inner_text())
    fixture.expect_action("/api/plugins/" + INSTALLATION, {"action": "disable", "expectedRevision": 1}, {}, method="PATCH", key="plugin-disable")
    panel.get_by_role("button", name="Disable", exact=True).click()
    expect(panel).to_contain_text("unconfirmed")
    checks.check("Malformed successful lifecycle HTTP response retains prior confirmed installation", "enabled" in receipt.inner_text() and INSTALLATION in receipt.inner_text())
    disabled = plugin_installation("disabled", 2)
    fixture.expect_action("/api/plugins/" + INSTALLATION, {"action": "disable", "expectedRevision": 1}, disabled, method="PATCH", key="plugin-disable", after=lambda: fixture.fail("/api/plugins"))
    panel.get_by_role("button", name="Disable", exact=True).click()
    expect(receipt).to_contain_text(disabled["installation"]["installationSha256"])
    expect(studio(page).get_by_role("button", name="Refresh", exact=True)).to_be_enabled()
    checks.check("Accepted exact revision remains confirmed when inventory refresh fails", "disabled" in receipt.inner_text() and "Previous" in studio(page).inner_text())
    fixture.installed = disabled["installation"]; fixture.defaults.clear(); refresh_studio(page)
    disclose(panel, "Import declarative manifest")
    panel.get_by_label("Manifest JSON", exact=True).fill(json.dumps(manifest()))
    fixture.expect_action("/api/plugins/preview", {"manifest": manifest()}, plugin_preview(expired=True), key="plugin-import-preview", status=201)
    panel.get_by_role("button", name="Prepare immutable review", exact=True).click()
    expect(dialog).to_be_visible()
    before = len(fixture.writes)
    dialog.get_by_role("button", name="Install Extension", exact=True).click()
    expect(dialog).to_have_count(0)
    expect(panel).to_contain_text("expired")
    checks.check("Expired review cannot submit installation and imported draft survives", len(fixture.writes) == before and panel.get_by_label("Manifest JSON", exact=True).input_value() == json.dumps(manifest()))


def schedule_effects(page, fixture, checks):
    panel = tab(page, "Automations")
    panel.get_by_role("button", name="History", exact=True).click()
    history = panel.get_by_role("region", name="Schedule outcome history", exact=True)
    expect(history).to_contain_text("lease count unavailable")
    checks.check("Failed occurrence and unavailable lease count are distinct", "agent" in history.inner_text().lower() and "failed" in history.inner_text().lower())
    panel.get_by_role("button", name="Close history", exact=True).click()
    def manual_body(body):
        return isinstance(body, dict) and set(body) == {"action", "scheduledFor"} and body["action"] == "run_once" and bool(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", body["scheduledFor"]))
    def occurrence(body):
        value = datetime.fromisoformat(body["scheduledFor"].replace("Z", "+00:00")).replace(second=0, microsecond=0)
        return {"occurrence": {"id": "manual-browser-occurrence", "triggerId": SCHEDULE, "status": "enqueued", "scheduledFor": value.isoformat(timespec="milliseconds").replace("+00:00", "Z")}}
    fixture.expect_action("/api/triggers/" + SCHEDULE, manual_body, occurrence, key="workflow-schedule-run_once", status=202, hold="run-once")
    before = len(fixture.writes)
    panel.evaluate("el=>{const b=[...el.querySelectorAll('button')];b.find(x=>x.textContent.trim()==='Run once').click();b.find(x=>x.textContent.trim()==='Pause').click()}")
    until(page, lambda: "run-once" in fixture.held, "Run once not held")
    checks.check("Schedule cross-button handlers share one synchronous action slot", len(fixture.writes) == before + 1)
    fixture.release("run-once")
    expect(panel).to_contain_text("manual-browser-occurrence was accepted with state enqueued")
    expect(panel.get_by_role("button", name="Pause", exact=True)).to_be_enabled()
    fixture.expect_action("/api/triggers/" + SCHEDULE, {"action": "pause"}, {"trigger": schedule(state="paused")}, key="workflow-schedule-pause", after=lambda: fixture.fail("/api/triggers"))
    panel.get_by_role("button", name="Pause", exact=True).click()
    expect(panel).to_contain_text("Schedule " + SCHEDULE + " paused.")
    expect(studio(page).get_by_role("button", name="Refresh", exact=True)).to_be_enabled()
    checks.check("Confirmed pause survives failed independent inventory read", panel.get_by_role("button", name="Pause", exact=True).is_disabled())
    fixture.defaults.clear(); fixture.schedule = schedule(state="paused"); refresh_studio(page)
    panel.get_by_role("button", name="New schedule", exact=True).click()
    page.get_by_label("Routine name", exact=True).fill("Frozen browser schedule")
    page.get_by_label("Starts", exact=True).fill("2030-10-04T10:00")
    page.get_by_label("Maximum runs", exact=True).fill("7")
    body = {"triggerKind": "schedule", "name": "Frozen browser schedule", "procedureId": "browser.read-procedure", "agentId": "atlas", "timezone": "UTC", "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=10;BYMINUTE=0", "startsAt": "2030-10-04T10:00:00.000Z", "maxOccurrences": 7, "missedPolicy": "skip", "failureLimit": 3, "authorityMode": "read_only"}
    created = schedule(body)
    fixture.expect_action("/api/triggers", body, {"trigger": created}, key="workflow-schedule-create", status=201, hold="schedule-create", after=lambda: setattr(fixture, "schedule", created))
    panel.get_by_role("button", name="Review & schedule", exact=True).click()
    until(page, lambda: "schedule-create" in fixture.held, "Schedule creation not held")
    expect(page.get_by_label("Routine name", exact=True)).to_be_disabled()
    fixture.release("schedule-create")
    expect(panel).to_contain_text("The reviewed read-only schedule was accepted")
    checks.check("Frozen schedule receipt and original Agent/procedure configuration accepted", fixture.writes[-1]["body"] == body)


def connections_views(page, fixture, checks, coarse):
    label = "phone" if coarse else "desktop"
    navigate(page, fixture.origin, "/app/connectors")
    expect(page.get_by_role("heading", name="Connections", exact=True)).to_be_visible()
    expect(admin(page).get_by_role("button", name="Refresh connections", exact=True)).to_be_enabled()
    expect(page.get_by_role("region", name="Connected systems", exact=True)).to_contain_text("Gmail")
    personal = section(page, "Personal sources")
    expect(personal).to_contain_text("Count unavailable")
    checks.check(label + ": missing source item count stays unavailable", "0 recorded items" not in personal.inner_text())
    for name in ("Personal sources", "MCP servers", "REST APIs"):
        section(page, name)
        select_theme(page, "light", coarse); settle(page)
        checks.snapshot(page, f"connections-{label}-{name.split()[0].lower()}-light", coarse)
        target_floor(admin(page), checks, label + " " + name, coarse)
    section(page, "MCP servers")
    disclose(admin(page), "Exact connector and contract catalog")
    select_theme(page, "dark", coarse); settle(page)
    checks.snapshot(page, f"connections-{label}-mcp-dark", coarse)
    page.evaluate("document.documentElement.style.fontSize='200%'")
    settle(page); checks.snapshot(page, f"connections-{label}-text200", coarse)
    page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
    if coarse:
        page.set_viewport_size({"width": 320, "height": 844}); settle(page)
        checks.snapshot(page, "connections-phone-320", coarse)
        page.set_viewport_size({"width": 390, "height": 844}); settle(page)
    page.emulate_media(forced_colors="active"); settle(page)
    checks.check(label + ": forced colors retain named management controls", admin(page).get_by_role("button", name="Refresh connections", exact=True).is_visible())
    page.emulate_media(forced_colors="none"); settle(page)


def connection_reads(page, fixture, checks):
    systems = page.get_by_role("region", name="Connected systems", exact=True)
    old = overview(); old["overview"]["installed"][0]["nextAction"] = "OLD_SOURCE_MUST_NOT_REPLACE_NEW"
    fixture.plan("/api/integrations/overview", old, hold="old-overview")
    systems.get_by_role("button", name="Refresh status", exact=True).click()
    until(page, lambda: "old-overview" in fixture.held, "Overview read not held")
    page.evaluate("window.dispatchEvent(new Event('asael:integration-status-changed'))")
    expect(systems.get_by_role("button", name="Refresh status", exact=True)).to_be_enabled()
    fixture.release("old-overview")
    settle(page)
    checks.check("A later overview refresh fences an older held response", "OLD_SOURCE_MUST_NOT_REPLACE_NEW" not in systems.inner_text())
    fixture.defaults["/api/integrations/overview"] = {"body": {}, "status": 200}
    systems.get_by_role("button", name="Refresh status", exact=True).click()
    expect(systems.get_by_role("alert")).to_be_visible()
    checks.check("Malformed overview retains last-loaded status and explicit freshness", "Gmail" in systems.inner_text() and "Last-loaded connection status" in systems.inner_text())
    fixture.defaults.clear(); systems.get_by_role("button", name="Try again", exact=True).click()
    expect(systems.get_by_role("button", name="Refresh status", exact=True)).to_be_enabled()
    fixture.fail("/api/connectors"); refresh_connections(page)
    mcp = section(page, "MCP servers")
    expect(mcp).to_contain_text("Last-loaded connection records")
    expect(admin(page).get_by_role("button", name="Approve exact contracts", exact=True)).to_be_disabled()
    checks.check("One failed inventory retains rows and blocks stale contract review", "Fixture MCP server" in mcp.inner_text())
    fixture.defaults.clear(); refresh_connections(page)
    fixture.oauth["grants"][0]["manageable"] = False
    refresh_connections(page)
    personal = section(page, "Personal sources")
    expect(personal.get_by_role("button", name="Sync", exact=True)).to_be_disabled()
    checks.check("Readable retained account is not treated as owned mutation authority", "only its stored owner can use or change it" in personal.inner_text())
    fixture.oauth["grants"][0]["manageable"] = True
    refresh_connections(page)


def personal_effects(page, fixture, checks):
    personal = section(page, "Personal sources")
    result = {"provider": "google", "grant": {"id": GRANT}, "status": "partial", "imported": 2, "removed": 0,
              "sources": [{"source": "mail", "status": "healthy", "imported": 2, "removed": 0}, {"source": "calendar", "status": "error", "imported": 0, "removed": 0}]}
    fixture.expect_action("/api/oauth/google/sync?connectionId=" + GRANT, None, result, key=None, hold="google-sync", after=lambda: fixture.fail("/api/oauth"))
    personal.get_by_role("button", name="Sync", exact=True).click()
    until(page, lambda: "google-sync" in fixture.held, "Google sync not held")
    checks.check("Pending account action blocks another connection review", admin(page).get_by_role("button", name="Approve exact contracts", exact=True).is_disabled())
    fixture.release("google-sync")
    expect(personal).to_contain_text("sync partial · 2 imported")
    expect(admin(page).get_by_role("button", name="Refresh connections", exact=True)).to_be_enabled()
    checks.check("Partial sync receipt survives failed account read", "Last confirmed account receipt" in personal.inner_text())
    fixture.defaults.clear(); refresh_connections(page)
    fixture.expect_action("/api/oauth/google?connectionId=" + GRANT, None, {"revoked": True, "provider": "google", "providerRevoked": False, "providerRevocation": "failed"}, method="DELETE", key=None,
                          after=lambda: fixture.oauth.update({"grants": []}))
    personal.get_by_role("button", name="Disconnect", exact=True).click()
    personal.get_by_role("button", name="Disconnect", exact=True).last.click()
    expect(personal).to_contain_text("Provider token revocation could not be confirmed")
    checks.check("Local disconnect and unconfirmed provider revocation remain distinct", GRANT in personal.inner_text() and "submitted target" in personal.inner_text())


def managed_effects(page, fixture, checks):
    section(page, "MCP servers")
    promoted = {**tool(), "status": "active"}
    def reviewed():
        fixture.mcp[0]["review"]["pendingCount"] = 0
        fixture.tools = [promoted]
    fixture.expect_action("/api/connectors/" + MCP + "/review", {"expectedFingerprint": digest("mcp-contracts")}, {"promoted": 1, "connectorStatus": "disabled", "activationRequired": True, "tools": [promoted]}, key=None, after=reviewed)
    admin(page).get_by_role("button", name="Approve exact contracts", exact=True).click()
    receipt = disclose(admin(page), "Last confirmed connection receipt")
    checks.check("Contract review does not claim activation when still required", "activation" in receipt.inner_text().lower() and MCP in receipt.inner_text())
    mcp = section(page, "MCP servers")
    mcp.get_by_role("button", name="Add MCP connection", exact=True).click()
    mcp.get_by_label("Connection name", exact=True).fill("Partial fixture server")
    mcp.get_by_label("MCP server URL", exact=True).fill("https://example.com/partial-mcp")
    mcp.get_by_label("Provider token", exact=True).fill("synthetic-browser-token")
    new_id = "55555555-5555-4555-8555-555555555555"
    new = connector(new_id, name="Partial fixture server", endpoint="https://example.com/partial-mcp", status="error", toolCount=0, review={"pendingCount": 0})
    fixture.expect_action("/api/connectors", {"name": new["name"], "endpoint": new["endpoint"], "authType": "bearer_vault", "bearerToken": "synthetic-browser-token", "defaultRiskLevel": 2, "approvalRequired": True, "discover": True},
                          {"connector": new, "tools": [], "error": "Synthetic discovery failed after creation.", "discoveryFailed": True, "connectionCreated": True, "credentialSaved": True}, status=502, hold="mcp-create", after=lambda: fixture.mcp.append(new))
    mcp.get_by_role("button", name="Add connection", exact=True).click()
    until(page, lambda: "mcp-create" in fixture.held, "MCP creation not held")
    expect(mcp.get_by_label("Provider token", exact=True)).to_have_value("")
    fixture.release("mcp-create")
    expect(mcp).to_contain_text("was created, but tool discovery failed")
    checks.check("Confirmed partial MCP creation retains ID while token stays write-only", new_id in disclose(mcp, "Last confirmed MCP receipt").inner_text())
    original = mcp.locator("article").filter(has=page.get_by_role("heading", name="Fixture MCP server", exact=True))
    original.get_by_role("button", name="Remove token", exact=True).click()
    removed = {**fixture.mcp[0], "credentialConfigured": False, "status": "disabled"}
    fixture.expect_action("/api/connectors/" + MCP + "/credential", None, {"removed": True, "connector": removed, "externalCredentialRevoked": False}, method="DELETE", after=lambda: fixture.mcp.__setitem__(0, removed))
    original.get_by_role("button", name="Remove stored token", exact=True).click()
    expect(disclose(mcp, "Last confirmed MCP receipt")).to_contain_text("not revoked")
    expect(original.get_by_role("button", name="Add token", exact=True)).to_be_enabled()
    preview_result, trashed = trash_receipts(removed, fixture.tools)
    fixture.expect_action("/api/connectors/" + MCP, None, preview_result)
    original.get_by_role("button", name="Delete", exact=True).click()
    exact = disclose(original, "Exact Trash preview")
    checks.check("Connector retirement displays complete preview identity", preview_result["preview"]["previewSha256"] in exact.inner_text())
    fixture.expect_action("/api/connectors/" + MCP, {"preview": preview_result["preview"]}, trashed, method="DELETE", after=lambda: (fixture.mcp.pop(0), fixture.tools.clear()))
    original.get_by_role("button", name="Move to Trash", exact=True).click()
    expect(disclose(mcp, "Last confirmed MCP receipt")).to_contain_text(trashed["trash"]["trashId"])
    checks.check("Reversible retirement preserves exact receipt and restore deadline", trashed["trash"]["restoreUntil"] in disclose(mcp, "Last confirmed MCP receipt").inner_text())
    rest = section(page, "REST APIs")
    rest.get_by_role("button", name="Add REST API", exact=True).click()
    rest.get_by_label("Name", exact=True).fill("Partial REST fixture")
    rest.get_by_label("Spec URL", exact=True).fill("https://example.com/openapi.json")
    body = {"name": "Partial REST fixture", "specUrl": "https://example.com/openapi.json", "authType": "none", "defaultRiskLevel": 2, "approvalRequired": True, "importSpec": True}
    created = {"id": REST, "name": body["name"], "authType": "none", "status": "error", "specUrl": body["specUrl"], "baseUrl": "https://example.com", "operationCount": 0, "review": {"pendingCount": 0}}
    fixture.expect_action("/api/openapi-connectors", body, {"connector": created, "operations": [], "error": "Synthetic spec import failed."}, status=202, after=lambda: fixture.fail("/api/openapi-connectors"))
    rest.locator("#register-openapi").get_by_role("button", name="Run action", exact=True).click()
    expect(disclose(admin(page), "Last confirmed connection receipt")).to_contain_text("was created, but its operation import failed")
    expect(rest.get_by_label("Name", exact=True)).to_have_value("Partial REST fixture")
    checks.check("REST 202 partial creation survives failed refresh without resetting draft", REST in disclose(admin(page), "Last confirmed connection receipt").inner_text())


def disposal_and_empty(page, fixture, checks, coarse):
    fixture.defaults.clear()
    if not coarse:
        # Hold the first existing phase of the GitHub upgrade. Leaving the
        # owner must prevent its later discovery phase, not pretend to cancel
        # the already submitted endpoint update.
        old = connector(name="GitHub", endpoint="https://api.githubcopilot.com/mcp/", authType="none", credentialConfigured=False, toolCount=0, review={"pendingCount": 0})
        fixture.mcp, fixture.tools = [old], []
        refresh_connections(page)
        mcp = section(page, "MCP servers")
        body = {"endpoint": "https://api.githubcopilot.com/mcp/x/all", "defaultRiskLevel": 2, "approvalRequired": False}
        fixture.expect_action("/api/connectors/" + MCP, body, {"connector": {**old, **body}}, method="PATCH", hold="disposed-upgrade")
        mcp.get_by_role("button", name="Add Actions tools", exact=True).click()
        until(page, lambda: "disposed-upgrade" in fixture.held, "First upgrade phase not held")
        page.get_by_role("navigation", name="Application navigation", exact=True).get_by_role("link", name="Assistant", exact=True).click()
        expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
        before = len(fixture.writes)
        fixture.release("disposed-upgrade"); page.wait_for_timeout(150)
        checks.check("Disposal stops later MCP discovery after an already-submitted update", len(fixture.writes) == before and not fixture.unexpected)
    navigate(page, fixture.origin, "/app/tools")
    expect(page.get_by_role("heading", name="Capabilities", exact=True)).to_be_visible()
    checks.check(("phone" if coarse else "desktop") + ": tools alias reaches the canonical hub", url_path(page.url) == "/app/automation")
    fixture.empty = True; refresh_studio(page)
    panel = tab(page, "Skills")
    expect(panel.get_by_text("No Skills are available for this workspace.", exact=True)).to_be_visible()
    checks.check(("phone" if coarse else "desktop") + ": a successful empty source alone establishes empty inventory", True)
    fixture.empty = False; refresh_studio(page)
    fixture.plan("/api/skills", {"skills": [{"id": "late", "name": "LATE_SKILL_MUST_NOT_APPEAR"}]}, hold="disposed-read")
    studio(page).get_by_role("button", name="Refresh", exact=True).click()
    until(page, lambda: "disposed-read" in fixture.held, "Disposed read not held")
    navigation = page.get_by_role("navigation", name="Everyday workspace navigation" if coarse else "Application navigation", exact=True)
    navigation.get_by_role("link", name="Assistant", exact=True).click()
    expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
    before = len(fixture.requests)
    fixture.release("disposed-read"); page.wait_for_timeout(100)
    checks.check(("phone" if coarse else "desktop") + ": late source read cannot restore an unmounted workspace", len(fixture.requests) == before and "LATE_SKILL_MUST_NOT_APPEAR" not in page.locator("body").inner_text())


def url_path(value):
    from urllib.parse import urlsplit
    return urlsplit(value).path


def exercise(browser, origin, credentials, checks, coarse):
    label, errors = ("phone" if coarse else "desktop"), []
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, timezone_id="UTC", has_touch=coarse, reduced_motion="reduce", service_workers="block")
    fixture, page = None, None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        fixture = CapabilityFixtures(origin, max_effects=18 if not coarse else 0)
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        initial_and_views(page, fixture, checks, coarse)
        if not coarse:
            extension_effects(page, fixture, checks)
            schedule_effects(page, fixture, checks)
        connections_views(page, fixture, checks, coarse)
        if not coarse:
            connection_reads(page, fixture, checks)
            personal_effects(page, fixture, checks)
            managed_effects(page, fixture, checks)
        disposal_and_empty(page, fixture, checks, coarse)
        checks.check(label + ": all declared effects consumed locally", not fixture.actions)
        checks.check(label + ": no undeclared write, provider navigation, popup or download", not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "reads": fixture.requests, "writes": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        if fixture:
            (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "pendingActions": [{key: value for key, value in plan.items() if key not in ("after", "body", "result")} for plan in fixture.actions], "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        if fixture:
            fixture.abort_held()
        if page and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/capabilities")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks, contexts, failure = Checks(args.output, args.axe.resolve()), [], None
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
        print("Capabilities browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual Capabilities/Connections routes and real isolated login; bounded synthetic inventory/status/receipt reads. At most 18 declared desktop effects and zero phone effects, locally fulfilled with exact body, method, query and idempotency assertions. No real OAuth/provider/spec/discovery/install/schedule/credential/retirement effect reaches the server. Hash-valid fixtures test client receipts, not server authority, cryptographic provenance, OAuth flows or execution. Those remain separate route/store suites."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
