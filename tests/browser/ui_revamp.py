#!/usr/bin/env python3
"""Focused workspace presentation checks; application effects are blocked or exactly intercepted."""
import argparse
import json
import re
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from run import Checks, REPO, navigate, preview, select_theme
from fixtures import ANSWER, Fixtures, THREAD_ID, STAMP, APPROVAL_ID
from atlas_fixtures import AtlasFixtures, ROOT as ATLAS_ROOT
from app_builder_fixtures import BuilderFixtures
from semantic_review_fixtures import overview


LONG_WORK_TITLE = "Synthetic long work instruction: " + "Review the source, compare evidence and prepare the next action. " * 120
TODAY_RUN_ID = "b6df7a27-386d-4ae9-9793-b4d18c0ebc84"

def today_projection():
    sections = ["focus", "agenda", "active_agents", "work", "memory", "conversations"]
    return {
        "policyVersion": "p11.1-cohesive-today:1", "generatedAt": STAMP, "timezone": "UTC", "visibleSections": sections,
        "today": {"generatedAt": STAMP, "items": [], "threads": [],
                  "memories": [{"id": "memory-synthetic", "title": "Creative launch context", "content": "Keep claims tied to their sources.", "type": "fact"}],
                  "projects": [], "briefLocalDate": "2026-10-03", "briefGenerationDue": False,
                  "preferences": {"briefEnabled": False, "briefTime": "08:00", "timezone": "UTC", "reminderLeadMinutes": 30,
                                  "notificationsEnabled": False, "quietHoursEnabled": True, "quietHoursStart": "22:00", "quietHoursEnd": "07:00", "visibleSections": sections}},
        "workspaceSummary": {"sources": {
            "runs": {"status": "ready", "data": [{"id": TODAY_RUN_ID, "prompt": LONG_WORK_TITLE, "status": "running"}]}, "approvals": {"status": "ready", "data": []},
            "workflows": {"status": "ready", "data": []}}},
        "meetings": [], "usage": None, "agenda": [],
        "sources": [{"source": source, "status": "ready", "freshness": "current", "observedAt": STAMP, "lastChangedAt": None,
                     "detail": "Synthetic presentation fixture."} for source in ["personal_reminders", "meetings", "commitments", "approvals", "active_agents", "work"]],
        "counts": {"needsAttention": 0, "meetingsToday": 0, "openCommitments": 0, "approvals": 0, "activeAgents": 1, "activeWork": 1, "unknownSources": 0},
        "projectionSha256": "synthetic-presentation-projection",
    }


def coverage_projection():
    return {"version": "p11.9-source-coverage:1", "generatedAt": STAMP, "state": "ready",
            "disclosure": {"absenceInference": "forbidden", "rawCursorValuesIncluded": False, "providerContentIncluded": False, "actorCoordinatesIncluded": False},
            "inventory": {key: {"state": "ready", "detail": "Synthetic read-only fixture."} for key in ["integrations", "oauth", "ownedSources"]},
            "summary": {"connectedDomains": 1, "completeDomains": 1, "staleDomains": 0, "blindSpots": 0, "unknownDomains": 0, "lastVerifiedAt": STAMP},
            "knowledgeIndex": {"state": "complete", "sourceItems": 24, "indexedDocuments": 24, "chunks": 48, "embeddedChunks": 48, "lastIndexedAt": STAMP,
                               "detail": "Twenty-four synthetic documents have matching index receipts."},
            "domains": [{"id": "knowledge_uploads", "label": "Project documents", "category": "knowledge", "availability": "native",
                         "coverage": {"state": "complete", "observedItems": 24, "detail": "All documents in this synthetic collection have been indexed."},
                         "backfill": {"state": "complete", "detail": "Synthetic backfill complete."},
                         "freshness": {"state": "current", "lastVerifiedAt": STAMP, "staleAfterSeconds": 86400},
                         "blindSpot": False, "limitation": "Presentation fixture only; no production source access.",
                         "nextAction": {"state": "available", "label": "Open Library", "href": "/app/memory"}}]}


def studio_flow(flow_id, name, project_id):
    return {"id": flow_id, "name": name, "description": "Synthetic presentation flow", "workspaceId": "synthetic-workspace",
            "projectId": project_id, "revision": 1, "archived": False, "createdAt": STAMP, "updatedAt": STAMP,
            "viewport": {"x": 24, "y": 24, "zoom": 0.9},
            "graph": {"schemaVersion": 1, "nodes": [
                {"id": "brief", "type": "prompt", "title": "Start with an idea", "position": {"x": 32, "y": 48}, "enabled": True,
                 "config": {"prompt": "An editorial portrait in soft window light.", "parameters": {}}},
                {"id": "notes", "type": "note", "title": "Creative direction", "position": {"x": 352, "y": 48}, "enabled": True,
                 "config": {"prompt": "Keep the framing natural and the story focused.", "parameters": {}}}], "edges": []}}


class RevampFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.sent = True
        self.allow_approval = False
        self.approval_reads = 0
        self.hold_thread = False
        self.held_thread_reads = []
        self.fail_access_after_decision = False
        self.flows = [studio_flow("flow-editorial", "Editorial story", "brand-fashion"),
                      studio_flow("flow-explainer", "The weekly explainer", "brand-ai")]
        self.project = BuilderFixtures(origin, session).project()
        self.project["title"] = "Synthetic creative launch"
        self.project["objective"] = "Prepare an evidence-backed launch plan and creative assets."

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin or request.method not in ("GET", "HEAD", "OPTIONS"):
            return super().route(route)
        if self.hold_thread and path == f"/api/threads/{THREAD_ID}":
            self.held_thread_reads.append(route)
            return
        if path == "/api/onboarding/access-requests" and self.decided and self.fail_access_after_decision:
            self.reads.add(path)
            return self.fulfill(route, {"error": "Synthetic access readback unavailable"}, 503)
        if path == "/api/approvals":
            self.approval_reads += 1
        values = {
            "/api/today/agenda": {"projection": today_projection()},
            "/api/source-coverage": {"coverage": coverage_projection()},
            "/api/projects": {"projects": [self.project]},
            "/api/workspace-templates": {"templates": []},
            "/api/studio/projects": {"projects": [
                {"id": "brand-fashion", "title": "Fashion — synthetic", "profile": None},
                {"id": "brand-ai", "title": "AI & technology — synthetic", "profile": None},
            ]},
            "/api/studio/flows": {"flows": self.flows},
            "/api/studio/flows/flow-editorial": {"flow": self.flows[0]},
            "/api/studio/flows/flow-editorial/runs": {"runs": []},
            "/api/studio/capabilities": {"capabilities": []},
            "/api/studio/assets": {"assets": []},
            "/api/memory/personal-context-consent": {"state": "inactive", "notice": {"text": "Synthetic recall stays inactive.", "sha256": "c" * 64}},
            "/api/memory/reconciliation": {"reviews": []},
            "/api/knowledge/cognification": {"reviews": [], "reviewGroups": []},
        }
        if path == "/api/memory/intelligence":
            view = query.get("view", ["overview"])[0]
            values[path] = {"overview": overview()} if view == "overview" else {view: {"items": [], "total": 0, "nextCursor": None}}
        if path in values:
            self.reads.add(path)
            return self.fulfill(route, values[path])
        return super().route(route)

    def mutation(self, route, path):
        if self.allow_approval and path == f"/api/approvals/{APPROVAL_ID}":
            return super().mutation(route, path)
        # Only the exact fixed synthetic approval below may use the base fixture's
        # strict interception. Every other application effect remains blocked.
        self.unexpected.append({"kind": "write", "path": path, "method": route.request.method})
        return self.fulfill(route, {"error": "Presentation check blocks all application writes."}, 503)


class PresentationChecks(Checks):
    def check(self, name, passed, detail=None):
        try:
            super().check(name, passed, detail)
        except AssertionError:
            # Collect independent screen defects in one pass. The final report
            # still fails if any recorded assertion failed; interactions remain
            # fail-fast because later state could otherwise be misleading.
            if name != "cover: approval receipt rereads queue and returns focus" and not name.endswith((": touch controls at least 48px", ": axe WCAG scan", ": no horizontal page overflow", ": scoped axe")):
                raise


def disable_disposable_brief(context, origin, checks, label):
    response = context.request.patch(origin + "/api/today/brief", data={"briefEnabled": False},
        headers={"Origin": origin, "idempotency-key": str(uuid.uuid4())})
    checks.check(label + ": disposable automatic brief disabled", response.ok,
                 {"status": response.status, "scope": "ephemeral local browser-review account only"})


def targets(page, checks, name, coarse):
    if not coarse:
        return
    invalid = page.locator("#workspace-content").locator("button:visible, select:visible, textarea:visible, summary:visible, input:visible, .react-flow__attribution a:visible").evaluate_all("""els=>els.flatMap(el=>{
      const style=getComputedStyle(el);
      if(el.tabIndex<0 && (style.clip==='rect(0px, 0px, 0px, 0px)' || style.clipPath==='inset(50%)')) return [];
      const target=el.matches('input[type=checkbox],input[type=radio]')?(el.closest('label')||el):el;
      const r=target.getBoundingClientRect();
      return r.height && r.height<47?[{tag:el.tagName,name:el.getAttribute('aria-label')||el.textContent||el.name,height:r.height}]:[];
    })""")
    checks.check(name + ": touch controls at least 48px", not invalid, invalid)


def exercise(browser, origin, credentials, checks, width, coarse, start_route=None, only_routes=None, exclude_routes=None, screens_only=False):
    label = {360: "cover", 720: "inner", 1440: "desktop"}[width]
    context = browser.new_context(viewport={"width": width, "height": 900}, has_touch=coarse,
                                  service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        disable_disposable_brief(context, origin, checks, label)
        session = context.request.get(origin + "/api/auth/session").json()
        fixture = RevampFixtures(origin, session)
        atlas = AtlasFixtures(origin)
        context.route("**/*", fixture.route)
        context.route(origin + ATLAS_ROOT + "**", atlas.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        routes = (("assistant", f"/app/command?thread={THREAD_ID}"), ("today", "/app"),
                  ("work", "/app/projects"), ("studio", "/app/studio"), ("studio-editor", "/app/studio?flow=flow-editorial"),
                  ("library", "/app/memory"), ("settings", "/app/settings"))
        if start_route:
            routes = routes[next(index for index, item in enumerate(routes) if item[0] == start_route):]
        routes = tuple(item for item in routes if (not only_routes or item[0] in only_routes) and item[0] not in (exclude_routes or []))
        for name, path in routes:
            navigate(page, origin, path)
            expect(page.locator("#workspace-content")).to_be_visible()
            if name == "assistant":
                # The initial shell can render before the selected thread is
                # adopted. Exercise resize on an established conversation.
                expect(page.get_by_text(ANSWER, exact=True)).to_be_visible(timeout=30_000)
                field = page.locator('textarea[role="combobox"]')
                expect(field).to_be_visible()
                field.fill("Keep this draft while the window changes.")
                for alternate in (720, 360, width):
                    page.set_viewport_size({"width": alternate, "height": 900})
                    expect(field).to_have_value("Keep this draft while the window changes.")
                checks.check(label + ": Assistant draft survives cover/inner resize", True)
                if width == 360:
                    attach = page.get_by_role("button", name="Attach files", exact=True)
                    attach.focus()
                    with page.expect_file_chooser() as chooser_event:
                        page.keyboard.press("Enter")
                    chooser_event.value.set_files([])
                    checks.check("cover: keyboard Attach opens the picker without an invisible tab stop",
                                 page.get_by_label("Attach files to conversation", exact=True).get_attribute("tabindex") == "-1")
            if name == "today":
                expect(page.get_by_test_id("activity-workspace")).to_have_attribute("data-hydrated", "true", timeout=60_000)
                with page.expect_response(lambda response: "/api/today/agenda?" in response.url):
                    page.get_by_role("button", name="Refresh Today", exact=True).click()
                title = page.get_by_text(LONG_WORK_TITLE, exact=True)
                expect(title).to_have_count(2)
                geometry = title.evaluate_all("els=>els.map(el=>({height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}))")
                checks.check(label + ": long work instruction stays within three lines", all(item["height"] <= item["line"] * 3 + 2 for item in geometry), geometry)
                expect(page.get_by_role("link", name="Open conversation", exact=True)).to_have_attribute("href", f"/app/command?run={TODAY_RUN_ID}")
                checks.check(label + ": current-work cue opens its exact conversation", True)
            if name == "work":
                expect(page.get_by_text("Synthetic creative launch", exact=True).first).to_be_visible()
                checks.check(label + ": default My work shows general projects", True)
            if name == "studio":
                expect(page.get_by_text("Editorial story", exact=True)).to_be_visible()
                search = page.get_by_role("searchbox", name="Find a saved flow")
                search.fill("weekly")
                expect(page.get_by_text("The weekly explainer", exact=True)).to_be_visible()
                expect(page.get_by_text("Editorial story", exact=True)).to_have_count(0)
                search.clear()
                checks.check(label + ": Studio saved-flow search works", True)
            if name == "studio-editor":
                expect(page.get_by_role("textbox", name="Flow name", exact=True)).to_have_value("Editorial story")
            for theme in ("light", "dark"):
                select_theme(page, theme, coarse)
                targets(page, checks, f"{name}-{label}-{theme}", coarse)
                checks.snapshot(page, f"{name}-{label}-{theme}", coarse)
                if name == "today":
                    details = page.locator("#today-sources")
                    details.locator(":scope > summary").click()
                    expect(details.get_by_role("heading", name="Project documents", exact=True)).to_be_visible()
                    targets(page, checks, f"today-details-{label}-{theme}", coarse)
                    details.evaluate("el=>window.scrollTo(0,el.getBoundingClientRect().top+scrollY)")
                    page.screenshot(path=str(checks.output / f"today-details-{label}-{theme}.png"), full_page=False)
                    checks.check(f"today-details-{label}-{theme}: screenshot preserved pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
                    violations = details.evaluate("async el=>(await axe.run(el,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))")
                    checks.check(f"today-details-{label}-{theme}: scoped axe", not violations, violations)
                    details.locator(":scope > summary").click()
            if name == "assistant" and not coarse:
                trigger = page.get_by_role("button", name="Start voice conversation with Asael")
                for theme in ("light", "dark"):
                    select_theme(page, theme, coarse)
                    trigger.click()
                    dialog = page.get_by_role("dialog", name="Conversation with Asael")
                    expect(dialog).to_be_visible()
                    checks.snapshot(page, f"voice-notice-{label}-{theme}", coarse)
                    page.keyboard.press("Escape")
                    expect(trigger).to_be_focused()
                    expect(field).to_have_value("Keep this draft while the window changes.")
        if width == 360 and not screens_only:
            navigate(page, origin, "/app/approvals")
            card = page.get_by_role("article", name="Review synthetic document export", exact=True)
            expect(card).to_be_visible()
            actions = page.get_by_role("heading", name="Agent and workflow actions", exact=True)
            access = page.get_by_role("heading", name="Workspace access", exact=True)
            checks.check("cover: pending agent actions precede empty account access", actions.bounding_box()["y"] < access.bounding_box()["y"])
            select_theme(page, "light", True)
            checks.snapshot(page, "approval-cover-current", True)
            reads = fixture.approval_reads
            fixture.allow_approval = True
            card.get_by_role("textbox").fill("Reviewed synthetic scope.")
            card.get_by_role("button", name="Approve and run", exact=True).click()
            expect(card).to_have_count(0, timeout=30_000)
            try:
                expect(actions).to_be_focused(timeout=1500)
            except AssertionError:
                pass
            focus = page.evaluate("() => ({tag:document.activeElement?.tagName,id:document.activeElement?.id,html:document.activeElement?.outerHTML.slice(0,350)})")
            checks.check("cover: approval receipt rereads queue and returns focus", fixture.decided and fixture.approval_reads > reads
                         and len(fixture.writes) == 1 and fixture.writes[0]["disposition"] == "synthetic_decision" and actions.evaluate("el=>document.activeElement===el"),
                         {"focus":focus,"queueReadsBefore":reads,"queueReadsAfter":fixture.approval_reads,"writes":fixture.writes})
            fixture.allow_approval = False
        if coarse and not screens_only:
            # Begin on a primary route so the secondary disclosure starts closed.
            navigate(page, origin, "/app/projects")
            expect(page.get_by_text("Synthetic creative launch", exact=True).first).to_be_visible()
            trigger = page.get_by_role("button", name="Open workspace menu", exact=True)
            trigger.click()
            menu = page.get_by_role("dialog", name="Asael", exact=True)
            first = menu.get_by_role("link", name="Asael workspace home", exact=True)
            account = menu.locator('summary[aria-label^="Account:"]')
            expect(first).to_be_focused()
            page.keyboard.press("Shift+Tab")
            expect(account).to_be_focused()
            page.keyboard.press("Tab")
            expect(first).to_be_focused()
            checks.check(label + ": closed Account focus wraps without hidden controls", True)
            account.click()
            sign_out = menu.get_by_role("button", name="Sign out", exact=True)
            expect(sign_out).to_be_visible()
            sign_out.focus()
            page.keyboard.press("Tab")
            expect(first).to_be_focused()
            page.keyboard.press("Shift+Tab")
            expect(sign_out).to_be_focused()
            account.click()
            account.focus()
            page.keyboard.press("Tab")
            expect(first).to_be_focused()
            checks.check(label + ": expanded and reclosed Account retain focus trap", True)
            more = menu.locator("details").filter(has=page.locator("summary").filter(has_text=re.compile("^More$")))
            expect(more).not_to_have_attribute("open")
            more.locator("summary").focus()
            page.keyboard.press("Enter")
            expect(more).to_have_attribute("open", "")
            expect(menu.get_by_role("link", name="Watches", exact=True)).to_be_visible()
            checks.check(label + ": More opens by keyboard", True)
            first.focus()
            page.keyboard.press("Shift+Tab")
            expect(account).to_be_focused()
            page.keyboard.press("Tab")
            expect(first).to_be_focused()
            checks.check(label + ": expanded More retains visible focus boundaries", True)
            page.keyboard.press("Escape")
            expect(trigger).to_be_focused()
            navigate(page, origin, "/app/watches")
            trigger.click()
            expect(page.get_by_role("dialog").get_by_role("link", name="Watches", exact=True)).to_be_visible()
            checks.check(label + ": active secondary route opens its menu group", True)
            page.keyboard.press("Escape")
        elif not screens_only:
            nav = page.get_by_role("navigation", name="Application navigation", exact=True)
            expect(nav.get_by_role("link", name="Visual Studio", exact=True)).to_be_visible()
            checks.check(label + ": Studio is a primary desktop destination", True)
        checks.check(label + ": no unplanned effects or external requests", not fixture.unexpected and not atlas.unexpected,
                     fixture.unexpected + atlas.unexpected)
        checks.check(label + ": no browser errors", not errors, errors)
        return {"viewport": label, "width": width, "coarse": coarse, "reads": sorted(fixture.reads), "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / f"failure-{label}.png"))
            (checks.output / f"failure-{label}.html").write_text(page.content())
        if fixture:
            (checks.output / f"failure-{label}-requests.json").write_text(json.dumps(
                {"reads": sorted(fixture.reads), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        context.close()


def exercise_early_draft(browser, origin, credentials, checks):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin})
        checks.check("early draft: real isolated login", login.ok)
        disable_disposable_brief(context, origin, checks, "early draft")
        fixture = RevampFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        fixture.hold_thread = True
        context.route("**/*", fixture.route)
        atlas = AtlasFixtures(origin)
        context.route(origin + ATLAS_ROOT + "**", atlas.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        navigate(page, origin, f"/app/command?thread={THREAD_ID}")
        field = page.locator('textarea[role="combobox"]')
        expect(field).to_be_enabled()
        # This probe distinguishes an event-bound control from an SSR element.
        # The later title transition independently proves React handled typing.
        page.wait_for_function("""() => {const el=document.querySelector('textarea[role="combobox"]');
          return el && Object.keys(el).some(key=>key.startsWith('__reactFiber$'));} """)
        checks.check("early draft: selected conversation read is pending", bool(fixture.held_thread_reads))
        send = page.get_by_role("button", name="Send message", exact=True)
        expect(send).to_have_attribute("title", "Write a message first.")
        field.fill("Keep this handled draft while the saved conversation loads.")
        expect(send).not_to_have_attribute("title", "Write a message first.")
        checks.check("early draft: typing changes the controlled send state", True)
        checks.check("reduced motion: composer control has no transition",
                     send.evaluate("el=>matchMedia('(prefers-reduced-motion:reduce)').matches && getComputedStyle(el).transitionDuration.split(',').every(value=>parseFloat(value)===0)"))
        fixture.hold_thread = False
        for held in fixture.held_thread_reads:
            fixture.route(held)
        expect(page.get_by_text(ANSWER, exact=True)).to_be_visible()
        expect(field).to_have_value("Keep this handled draft while the saved conversation loads.")
        checks.check("early draft: saved conversation adoption preserves handled input", True)
        checks.check("early draft: no application writes or browser errors", not fixture.unexpected and not atlas.unexpected and not errors,
                     {"unexpected": fixture.unexpected + atlas.unexpected, "errors": errors})
        return {"scenario": "hydrated input before selected conversation read completes", "heldReads": len(fixture.held_thread_reads), "reads": sorted(fixture.reads)}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / "early-draft-failure.png"))
            (checks.output / "early-draft-failure.html").write_text(page.content())
        raise
    finally:
        context.close()


def exercise_approval_recovery(browser, origin, credentials, checks):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin})
        checks.check("approval recovery: real isolated login", login.ok)
        disable_disposable_brief(context, origin, checks, "approval recovery")
        fixture = RevampFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        fixture.allow_approval = True
        fixture.fail_access_after_decision = True
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        navigate(page, origin, "/app/approvals")
        card = page.get_by_role("article", name="Review synthetic document export", exact=True)
        expect(card).to_be_visible()
        card.get_by_role("textbox").fill("Reviewed synthetic scope.")
        card.get_by_role("button", name="Approve and run", exact=True).click()
        expect(page.get_by_role("alert").filter(has_text="Synthetic access readback unavailable")).to_be_visible()
        checks.check("approval recovery: failed access readback reports the unavailable source", fixture.decided and len(fixture.writes) == 1,
                     {"remainingCards": card.count(), "writes": fixture.writes})
        fixture.fail_access_after_decision = False
        refresh = page.get_by_role("button", name="Refresh", exact=True)
        refresh.click()
        expect(card).to_have_count(0)
        expect(page.get_by_role("alert").filter(has_text="Synthetic access readback unavailable")).to_have_count(0)
        expect(refresh).to_be_enabled()
        checks.check("approval recovery: successful refresh clears the source error without replay", len(fixture.writes) == 1 and fixture.approval_reads >= 3,
                     {"reads":fixture.approval_reads,"writes":fixture.writes})
        checks.check("approval recovery: no unplanned effects or browser errors", not fixture.unexpected and not errors,
                     {"unexpected":fixture.unexpected,"errors":errors})
        return {"scenario":"failed access readback followed by manual refresh", "reads":sorted(fixture.reads), "syntheticDecisions":len(fixture.writes)}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / "approval-recovery-failure.png"))
            (checks.output / "approval-recovery-failure.html").write_text(page.content())
        raise
    finally:
        context.close()


def exercise_approval_success(browser, origin, credentials, checks):
    """Exercise the exact supported decision receipt without replaying workspace screens."""
    context = browser.new_context(viewport={"width": 360, "height": 900}, has_touch=True,
                                  service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin})
        checks.check("approval success: real isolated login", login.ok)
        disable_disposable_brief(context, origin, checks, "approval success")
        fixture = RevampFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        fixture.allow_approval = True
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        navigate(page, origin, "/app/approvals")
        card = page.get_by_role("article", name="Review synthetic document export", exact=True)
        expect(card).to_be_visible()
        actions = page.get_by_role("heading", name="Agent and workflow actions", exact=True)
        access = page.get_by_role("heading", name="Workspace access", exact=True)
        checks.check("cover: pending agent actions precede empty account access", actions.bounding_box()["y"] < access.bounding_box()["y"])
        select_theme(page, "light", True)
        checks.snapshot(page, "approval-cover-current", True)
        reads = fixture.approval_reads
        card.get_by_role("textbox").fill("Reviewed synthetic scope.")
        with page.expect_response(lambda response: response.request.method == "POST" and urlsplit(response.url).path == f"/api/approvals/{APPROVAL_ID}") as receipt:
            card.get_by_role("button", name="Approve and run", exact=True).click()
        body = receipt.value.json()
        checks.check("approval success: decision receipt matches the supported contract",
                     body.get("record", {}).get("toolId") == "synthetic.document.export"
                     and body.get("record", {}).get("approvalDecision") == "approved", body)
        expect(card).to_have_count(0)
        expect(actions).to_be_focused()
        checks.check("cover: approval receipt rereads queue and returns focus", fixture.decided and fixture.approval_reads > reads
                     and len(fixture.writes) == 1 and fixture.writes[0]["disposition"] == "synthetic_decision",
                     {"queueReadsBefore": reads, "queueReadsAfter": fixture.approval_reads, "writes": fixture.writes})
        checks.check("approval success: no unplanned effects or browser errors", not fixture.unexpected and not errors,
                     {"unexpected": fixture.unexpected, "errors": errors})
        return {"scenario": "valid decision receipt and focus after the final action card", "reads": sorted(fixture.reads), "syntheticDecisions": len(fixture.writes)}
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(checks.output / "approval-success-failure.png"))
            (checks.output / "approval-success-failure.html").write_text(page.content())
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/ui-revamp")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", type=Path, required=True)
    parser.add_argument("--widths", nargs="+", type=int, choices=(1440, 360, 720), default=[1440, 360, 720])
    parser.add_argument("--start-route", choices=("assistant", "today", "work", "studio", "studio-editor", "library", "settings"), help="Resume the first viewport at this route; later viewports still exercise every route")
    parser.add_argument("--production", action="store_true", help="Build and run one isolated production preview")
    parser.add_argument("--reuse-build", action="store_true", help="Reuse the unchanged isolated production preview build")
    parser.add_argument("--early-draft-only", action="store_true", help="Check a handled draft while the selected conversation read is pending")
    parser.add_argument("--only-routes", nargs="+", help="Recheck only named changed route screens")
    parser.add_argument("--exclude-routes", nargs="+", default=[], help="Retain known failing routes for a separate repaired-source check")
    parser.add_argument("--screens-only", action="store_true", help="Do not repeat completed navigation and approval interactions")
    parser.add_argument("--with-approval-recovery", action="store_true", help="Also exercise a failed access readback and a deliberate refresh")
    parser.add_argument("--approval-only", action="store_true", help="Check the valid decision contract and source-readback recovery without replaying workspace screens")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    checks, results, failure = PresentationChecks(args.output, args.axe), [], None
    expect.set_options(timeout=30_000)
    try:
        with preview(args.output, production=args.production or args.reuse_build, reuse_build=args.reuse_build) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                if args.approval_only:
                    results.append(exercise_approval_success(browser, origin, credentials, checks))
                    results.append(exercise_approval_recovery(browser, origin, credentials, checks))
                elif args.early_draft_only:
                    results.append(exercise_early_draft(browser, origin, credentials, checks))
                else:
                    for index, width in enumerate(args.widths):
                        results.append(exercise(browser, origin, credentials, checks, width, width != 1440, args.start_route if index == 0 else None,
                                                args.only_routes, args.exclude_routes, args.screens_only))
                if args.with_approval_recovery and not args.approval_only:
                    results.append(exercise_approval_recovery(browser, origin, credentials, checks))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print("UI revamp check failed: " + failure, flush=True)
    finally:
        failed_checks = [item["name"] for item in checks.results if not item["passed"]]
        if not failure and failed_checks:
            failure = f"{len(failed_checks)} screen checks failed: " + ", ".join(failed_checks)
            print(failure, flush=True)
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": results, "failure": failure,
            "boundary": "Isolated real authentication and an automatic-brief preference disabled only in disposable local data. Mocked project/Studio/Memory reads; Today uses an explicitly refreshed synthetic current-agent projection with a 1,200-word title. Exact synthetic decisions are intercepted once per independent approval fixture; all other browser application writes are blocked. No provider, production, native-device or pixel-equivalence claim."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
