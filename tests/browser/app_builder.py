#!/usr/bin/env python3
"""Actual Work/Build UI against intercepted exact sandbox, evidence and delivery contracts."""
import argparse
import copy
import json
from pathlib import Path
import re
from urllib.parse import quote
from playwright.sync_api import expect, sync_playwright
from run import Checks, REPO, navigate, preview, select_theme
from app_builder_fixtures import BuilderFixtures, PROJECT, ARTIFACT, DEPLOYMENT, RELEASE, UNTRUSTED


def root(page): return page.get_by_test_id("app-builder-studio")
def button(page, name): return root(page).get_by_role("button", name=name, exact=True)


def exercise(browser, origin, credentials, checks, coarse):
    label = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 1000}, has_touch=coarse,
                                  service_workers="block", reduced_motion="reduce")
    fixture = None; page = None; errors = []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90000)
        checks.check(label + ": isolated authenticated canonical owner", login.ok)
        session = context.request.get(origin + "/api/auth/session").json()
        fixture = BuilderFixtures(origin, session); context.route("**/*", fixture.route)
        page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, "/app/projects?project=" + quote(PROJECT, safe="") + "&artifact=" + quote(ARTIFACT, safe=""))
        expect(page.get_by_role("button", name="Build", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="Synthetic app delivery", exact=True)).to_be_visible()
        checks.check(label + ": inactive Builder starts no API reads", not fixture.requests)
        page.get_by_role("button", name="Build", exact=True).click()
        expect(root(page)).to_be_visible(); expect(button(page, "Refresh snapshot")).to_be_enabled()
        expect(root(page).get_by_text(PROJECT, exact=True)).to_be_visible()
        expect(root(page).get_by_text(ARTIFACT, exact=True)).to_be_visible()
        frame = root(page).locator("iframe"); expect(frame).to_have_count(1)
        checks.check(label + ": preview isolated and suppresses referrer", frame.get_attribute("src").startswith("https://builder-sandbox.example.test/") and
                     frame.get_attribute("referrerpolicy") == "no-referrer" and "allow-top-navigation" not in frame.get_attribute("sandbox") and "allow-popups" not in frame.get_attribute("sandbox"))
        button(page, "Code").click(); editor = root(page).get_by_label("Edit app/page.tsx", exact=True)
        expect(editor).to_be_enabled(); editor.fill("export default function Page() { return <main>My retained edit</main>; }")
        draft = editor.input_value(); page.get_by_role("button", name="Plan & context", exact=True).click()
        expect(root(page)).to_be_hidden(); reads = len(fixture.requests)
        expect(page.get_by_role("heading", name="Tasks", exact=True)).to_be_visible()
        checks.check(label + ": inactive Builder has no live preview", root(page).locator("iframe").count() == 0)
        page.get_by_role("button", name="Build", exact=True).click(); expect(editor).to_have_value(draft)
        expect(button(page, "Save file")).to_be_enabled()
        checks.check(label + ": Work return retains exact file, artifact and dirty draft", len(fixture.requests) >= reads and quote(ARTIFACT, safe="") in page.url and "builderView=code" in page.url)
        fixture.fail_after_save = True; button(page, "Save file").click()
        expect(root(page).get_by_text(re.compile(r"Action response received.*file.update"))).to_be_visible()
        expect(root(page).get_by_text(re.compile(r"Refresh failed afterward"))).to_be_visible()
        checks.check(label + ": accepted save survives failed snapshot refresh", fixture.content == draft and len(fixture.mutations) == 1)
        fixture.fail_snapshot = False; fixture.fail_after_save = False; button(page, "Refresh snapshot").click()
        expect(button(page, "Checkpoint")).to_be_enabled(); expect(editor).to_have_value(draft)
        fixture.conflict_save = True; editor.fill(draft + "\n// conflicting local edit")
        button(page, "Save file").click(); expect(root(page).get_by_text(re.compile(r"Action outcome uncertain.*file.update"))).to_be_visible()
        expect(button(page, "Save file")).to_be_disabled()
        before = len(fixture.mutations); button(page, "Refresh snapshot").click()
        expect(button(page, "I inspected the refreshed state; allow a new decision")).to_be_enabled()
        button(page, "I inspected the refreshed state; allow a new decision").click()
        checks.check(label + ": conflict retains edit and requires explicit reviewed decision with no replay", "conflicting local edit" in editor.input_value() and len(fixture.mutations) == before)
        fixture.conflict_save = False
        root(page).get_by_role("region", name="Source files", exact=True).get_by_role("button").first.click()
        expect(editor).to_have_value(draft)
        button(page, "Restore").click(); expect(root(page).get_by_text(UNTRUSTED, exact=True)).to_be_visible()
        checks.check(label + ": checkpoint content remains text", not page.evaluate("Boolean(window.builderUntrustedRan)"))
        button(page, "Activity").click(); expect(root(page).get_by_text("Up to 40 recent events; this is a bounded history.", exact=True)).to_be_visible()
        older = copy.deepcopy(fixture.value["deployments"][0]); older["id"] = "app_build_deployment_" + "1" * 48
        fixture.value["deployments"].insert(0, older); button(page, "Refresh snapshot").click()
        expect(root(page).get_by_label("Preview deployment record", exact=True)).to_have_value(DEPLOYMENT)
        checks.check(label + ": newer first row cannot replace exact deployment choice", True)
        button(page, "GitHub").click()
        expect(root(page).get_by_label("Repository", exact=True)).to_have_value("12345")
        button(page, "Bind repository").click()
        expect(button(page, "Open repository in workspace")).to_be_enabled(); button(page, "Open repository in workspace").click()
        expect(button(page, "Repository open in workspace")).to_be_disabled()
        root(page).get_by_label("New branch", exact=True).fill("asael/exact-reviewed-app")
        root(page).get_by_label("Title", exact=True).fill("Review the exact synthetic app")
        button(page, "Secret-scan & open draft PR").click()
        expect(root(page).get_by_role("link", name="Open PR #7", exact=False)).to_be_visible()
        handoff = [item for item in fixture.mutations if item["body"]["action"] == "delivery.create"]
        checks.check(label + ": handoff keeps exact repository revision, checkpoint, verification and draft choice", len(handoff) == 1 and handoff[0]["body"]["expectedBindingRevision"] == 1
                     and handoff[0]["body"]["draft"] is True and handoff[0]["body"]["branchName"] == "asael/exact-reviewed-app")
        button(page, "Deploy").click()
        confirmation = root(page).get_by_placeholder("RELEASE", exact=True)
        expect(confirmation).to_be_visible(); confirmation.fill("RELEASE")
        expect(button(page, "Release to production")).to_be_enabled()
        fixture.value["releases"][0]["releaseDigest"] = "2" * 64; button(page, "Refresh snapshot").click()
        expect(confirmation).to_have_value(""); expect(button(page, "Release to production")).to_be_disabled()
        checks.check(label + ": changed exact review digest invalidates confirmation", not any(item["body"]["action"] == "release.production" for item in fixture.mutations))
        confirmation.fill("RELEASE"); button(page, "Release to production").click()
        expect(root(page).get_by_text("Production healthy", exact=True)).to_be_visible()
        release_call = [item for item in fixture.mutations if item["body"]["action"] == "release.production"]
        checks.check(label + ": release submits one exact reviewed ID and digest", len(release_call) == 1 and release_call[0]["body"]["releaseId"] == RELEASE and release_call[0]["body"]["releaseDigest"] == "2" * 64)
        root(page).get_by_text("Inspect exact source, verification and release evidence", exact=True).click()
        expect(root(page).get_by_text(re.compile(r"This API does not expose a rollback action"))).to_be_visible()
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse); checks.snapshot(page, "builder-" + label + "-" + theme, coarse)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 844}); checks.snapshot(page, "builder-phone-320", coarse)
            page.evaluate("document.documentElement.style.fontSize='200%'"); checks.snapshot(page, "builder-phone-text-200", coarse)
            page.evaluate("document.documentElement.style.fontSize=''")
        else:
            page.emulate_media(forced_colors="active"); checks.snapshot(page, "builder-forced-colors", coarse); page.emulate_media(forced_colors="none")
        page.keyboard.press("Tab")
        button(page, "Refresh snapshot").focus()
        checks.check(label + ": visible keyboard focus", button(page, "Refresh snapshot").evaluate("el=>document.activeElement===el && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) >= 2"))
        button(page, "Stop sandbox").click(); expect(root(page).get_by_text(re.compile(r"^Sandbox stopped"))).to_be_visible()
        expect(button(page, "Restart live preview")).to_be_disabled()
        checks.check(label + ": stopped sandbox retains evidence and removes iframe", root(page).locator("iframe").count() == 0)
        checks.check(label + ": all effects synthetic; no unexpected writes or client errors", not fixture.writes and not fixture.unexpected and not errors,
                     {"unexpected": fixture.unexpected, "errors": errors})
        return {"viewport": label, "reads": fixture.requests, "syntheticMutations": fixture.mutations, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if fixture is not None: (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "mutations": fixture.mutations, "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        raise
    finally:
        if fixture is not None: fixture.release_held()
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--output", type=Path, default=REPO / "test-results/app-builder")
    parser.add_argument("--chrome", type=Path); parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve()); contexts = []; failure = None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True): contexts.append(exercise(browser, origin, credentials, checks, coarse))
            finally: browser.close()
    except Exception as error:
        failure = str(error); print("App Builder browser check failed: " + failure, flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual Work/Build route with authenticated canonical owner and synthetic intercepted project, sandbox, file, verification, preview and production contracts. No real sandbox, command, Agent, GitHub, Vercel, production or rollback effect. UI scope and response presentation proof; backend authorization and effect idempotency require their own integration suites."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
