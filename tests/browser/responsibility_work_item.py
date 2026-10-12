#!/usr/bin/env python3
"""Work-item setup, exact review, activation and inbox presentation with intercepted effects."""
import argparse
import copy
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from run import Checks, REPO, navigate, preview, select_theme
from responsibilities import root, button, notifications, settle
from responsibilities_fixtures import ResponsibilityFixtures, signed, DIMENSIONS


class WorkItemFixtures(ResponsibilityFixtures):
    def __init__(self, origin, session):
        super().__init__(origin, session)
        self.source = {"kind": "work_item", "id": self.draft["work"]["workItemId"],
                       "workspaceId": self.draft["work"]["workspaceId"], "projectId": self.draft["work"]["projectId"]}
        self.pins["sources"] = [{"source": self.source, "revisionSha256": "a" * 64}]
        self.pins["procedure"]["id"] = "responsibility.work_item.followthrough.v1"
        body = {k: v for k, v in self.policy.items() if k != "policySha256"}
        body.update(id="responsibility-work-item-comparison:1", adapterCoverage="Canonical work-item status, deadline, owners, dependencies and linked outputs.",
                    materialExamples=["A deadline changes.", "Task is marked done or reopened."])
        self.policy = signed(body, "policySha256")
        self.disclosure.update(pilot="canonical_work_item_followthrough_v1", source="One currently owned work item.",
                               comparison="Deterministic state changes; marked done is not verified.", stops="Expiry.",
                               execution="Read the work item. No task mutation or message sending.")
        self.lost_notification_enable = False
        self.write_budget = 5

    def references(self):
        value = super().references()
        value["groups"]["sources"]["items"] = []
        value["groups"]["procedures"]["items"] = [{"id": self.pins["procedure"]["id"], "label": "Follow this work item"}]
        return value

    def configuration(self):
        draft = self.record["draft"]
        return signed({"schemaVersion": 1, "pilot": self.disclosure["pilot"], "responsibilityRevision": self.record["revision"],
            "reviewSha256": self.record["review"]["reviewSha256"], "draftSha256": self.record["draftSha256"], "pins": self.pins, "source": self.source,
            "tool": {"id": "app.work_items.show", "input": draft["work"], "contractSha256": "3" * 64},
            "cadence": draft["cadence"], "maximumChecks": 7, "cumulativeLimits": draft["limits"]["cumulative"],
            "checkReservation": {**dict.fromkeys(DIMENSIONS, 0), "wallTimeMs": 30000, "toolCalls": 1, "agents": 1},
            "comparisonPolicySha256": self.policy["policySha256"], "stops": ["expiry"],
            "notificationAuthority": "none", "approvalAuthority": "none", "mutationAuthority": "none"}, "configurationSha256")


def exercise(browser, origin, credentials, checks, coarse):
    label = "work-phone" if coarse else "work-desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page = None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90000)
        checks.check(label + ": isolated owner", login.ok)
        fixture = WorkItemFixtures(origin, context.request.get(origin + "/api/auth/session").json())
        context.route("**/*", fixture.route)
        page = context.new_page(); errors = []; page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/responsibilities")
        button(page, "New follow-up").click()
        root(page).get_by_label("Canonical work").select_option(json.dumps(fixture.draft["work"], separators=(",", ":")))
        button(page, "Set up work-item tracking").click()
        expect(root(page).get_by_label("Purpose", exact=True)).to_have_value("Follow through on Synthetic canonical Work")
        expect(root(page).get_by_label("Maximum checks", exact=True)).to_have_value("7")
        expect(root(page).get_by_label("Maximum notifications", exact=False)).to_have_value("7")
        checks.check(label + ": preset is only a draft", not fixture.mutations and fixture.current is None)
        button(page, "Create inactive draft").click()
        expect(root(page).get_by_role("link", name="Open this responsibility", exact=True)).to_be_visible()
        checks.check(label + ": saved source is exact and no procedure memory invented", fixture.record["draft"]["sources"] == [fixture.source] and fixture.record["draft"]["procedureId"] == fixture.pins["procedure"]["id"] and fixture.current is None)
        root(page).get_by_role("link", name="Open this responsibility", exact=True).click()
        button(page, "Check exact references for review").click(); button(page, "Accept this exact inactive review").click()
        button(page, "Review tracking plan").click()
        expect(button(page, "Start tracking")).to_be_disabled()
        root(page).get_by_label("I reviewed this work item, schedule and limit. Tracking only reads its state; it does not change the task or send messages.", exact=True).check()
        button(page, "Start tracking").click()
        expect(button(page, "Retry exact submitted request")).to_be_visible()
        button(page, "Retry exact submitted request").click()
        fixture.fail_refresh = False; button(page, "Refresh lifecycle").click()
        expect(button(page, "Pause responsibility")).to_be_enabled()
        calls = [item for item in fixture.mutations if item["body"]["action"] == "activate"]
        checks.check(label + ": exact work pilot and same-key recovery", len(calls) == 2 and calls[0] == calls[1] and calls[0]["body"]["acknowledgePilot"] == "canonical_work_item_followthrough_v1")
        checks.check(label + ": activation did not enable delivery", fixture.notification_current is None)
        button(page, "Review in-app notification delivery").click()
        notifications(page).get_by_label("I reviewed the exact owner, source, configuration, runtime revision and generation, finite limit, expiry and owner inbox destination.", exact=True).check()
        button(page, "Enable exact in-app notifications").click()
        expect(button(page, "Stop in-app notifications")).to_be_enabled()
        checks.check(label + ": finite work notification configuration", fixture.notification_current["configuration"]["source"] == fixture.source)
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse); settle(page); checks.snapshot(page, label + "-" + theme, coarse)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 844}); page.evaluate("document.documentElement.style.fontSize='200%'")
            settle(page); checks.snapshot(page, label + "-320-text-200", coarse)
        checks.check(label + ": five intercepted effects and no unexpected traffic", len(fixture.mutations) == 5 and not fixture.unexpected and not fixture.writes and not errors,
                     {"unexpected": fixture.unexpected, "errors": errors})
        return {"viewport": label, "effects": copy.deepcopy(fixture.mutations)}
    except Exception:
        if page: page.screenshot(path=str(checks.output / (label + "-failure.png")))
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--output", type=Path, default=REPO / "test-results/responsibility-work-item")
    parser.add_argument("--chrome", type=Path); parser.add_argument("--axe", type=Path, required=True); args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True); checks = Checks(args.output, args.axe); contexts = []; failure = None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True): contexts.append(exercise(browser, origin, credentials, checks, coarse))
            finally: browser.close()
    except Exception as error:
        failure = str(error); print("Work-item browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real web UI and isolated auth. Exactly five intercepted Responsibility writes per viewport, including same-key recovery. No actual DB tracking, model call, scheduler, external message or inbox effect."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
