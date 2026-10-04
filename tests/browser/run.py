#!/usr/bin/env python3
"""Real Next/Chrome interaction checks with synthetic, wholly intercepted effects."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, expect, sync_playwright

from fixtures import (ANSWER, PROMPT, THREAD_ID, RUN_ID, SCOPE_THREAD_B,
                      Fixtures, AssistantScopeFixtures, scope_session)

REPO = Path(__file__).resolve().parents[2]


@contextmanager
def preview(output):
    # Next loads these independently of the child environment. Never load a
    # developer's saved credentials or reuse their application data directory.
    dotenv = [REPO / name for name in (".env", ".env.local", ".env.development", ".env.development.local")]
    if any(path.exists() for path in dotenv):
        raise RuntimeError("Use a checkout without Next dotenv files for the isolated browser run.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node 24 must be on PATH.")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    credentials = {"email": "browser-review@example.test", "password": secrets.token_urlsafe(32)}
    with tempfile.TemporaryDirectory(prefix="asael-browser-") as data:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ["HOME"],
               "TMPDIR": os.environ.get("TMPDIR", "/tmp"), "NODE_ENV": "development",
               "NODE_OPTIONS": "--max-old-space-size=2560", "NEXT_TELEMETRY_DISABLED": "1",
               "NEXT_PUBLIC_APP_URL": origin, "NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE": "0",
               "OMNIAGENT_AUTH_ENABLED": "true",
               "OMNIAGENT_BOOTSTRAP_EMAIL": credentials["email"],
               "OMNIAGENT_BOOTSTRAP_PASSWORD": credentials["password"],
               "OMNIAGENT_BOOTSTRAP_NAME": "Synthetic browser review",
               "OMNIAGENT_DEFAULT_TENANT": "browser-review", "OMNIAGENT_DATA_DIR": data}
        with (output / "preview.log").open("w") as log:
            process = subprocess.Popen([node, "node_modules/next/dist/bin/next", "dev", "--webpack",
                                        "--hostname", "127.0.0.1", "--port", str(port)],
                                       cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Isolated preview exited; inspect preview.log.")
                    try:
                        with urlopen(origin + "/api/auth/session", timeout=3) as response:
                            if response.status == 200:
                                break
                    except (URLError, TimeoutError):
                        pass
                    time.sleep(0.2)
                else:
                    raise RuntimeError("Isolated preview did not become ready.")
                yield origin, credentials
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)


class Checks:
    def __init__(self, output, axe):
        self.output = output
        self.axe = axe
        self.results = []

    def check(self, name, passed, detail=None):
        result = {"name": name, "passed": bool(passed), "detail": detail}
        self.results.append(result)
        print(json.dumps(result), flush=True)
        if not passed:
            raise AssertionError(name)

    def snapshot(self, page, name, coarse):
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(200)
        self.check(name + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
        reflow = page.evaluate("""() => ({viewport:innerWidth, document:document.documentElement.scrollWidth,
          outside:[...document.body.querySelectorAll('*')].filter(el=>{
            const r=el.getBoundingClientRect();return r.width && (r.right>innerWidth+1 || r.left < -1);
          }).map(el=>({tag:el.tagName,cls:typeof el.className==='string'?el.className:'',
            left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,
            client:el.clientWidth,scroll:el.scrollWidth})).slice(0,20)})""")
        self.check(name + ": no horizontal page overflow", reflow["document"] <= reflow["viewport"] + 1, reflow)
        page.screenshot(path=str(self.output / f"{name}.png"), full_page=False)
        self.check(name + ": screenshot preserved pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
        page.add_script_tag(path=str(self.axe))
        audit = page.evaluate("""async () => {
          const result = await axe.run({exclude:[['nextjs-portal']]},
            {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
          return {violations:result.violations.map(v=>({id:v.id,impact:v.impact,
            nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
            incomplete:result.incomplete.map(v=>v.id), passes:result.passes.length};
        }""")
        (self.output / f"{name}-axe.json").write_text(json.dumps(audit, indent=2))
        self.check(name + ": axe WCAG scan", not audit["violations"], audit["violations"])


def navigate(page, origin, path):
    print(f"Navigate {path}", flush=True)
    page.goto(origin + path, wait_until="domcontentloaded", timeout=180_000)
    # Command maintains live reads. An idle network is a useful fast path,
    # while the concrete controlled field/loaded queue below is the actual
    # readiness assertion when a long-lived read keeps the connection open.
    try:
        page.wait_for_load_state("networkidle", timeout=5_000)
    except PlaywrightTimeoutError:
        pass


def select_theme(page, theme, coarse):
    if coarse:
        control = page.get_by_role("button", name=re.compile(r"^Theme: "))
        for _ in range(3):
            if control.get_attribute("aria-label").startswith(f"Theme: {theme.title()}."):
                break
            control.click()
        expect(control).to_have_attribute("aria-label", re.compile(rf"^Theme: {theme.title()}\."))
    else:
        page.get_by_role("button", name=f"{theme.title()} theme", exact=True).click()
    page.wait_for_function("theme=>document.documentElement.dataset.theme===theme", arg=theme)


def exercise(browser, origin, credentials, checks, coarse):
    fixtures = Fixtures(origin)
    errors = []
    page = None
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    try:
        # Ordinary bootstrap login establishes the real SSR role. A mocked
        # /auth/session response must never be used as authority for these pages.
        login = context.request.post(origin + "/api/auth/login", data=credentials,
                                     headers={"Origin": origin}, timeout=90_000)
        checks.check("Real isolated login", login.ok)
        context.route("**/*", fixtures.route)
        context.add_init_script("""window.__micAttempts=0; window.untrustedContentRan=false;
          if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>{
            window.__micAttempts++; throw new DOMException('Synthetic denied microphone','NotAllowedError');
          };""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixtures.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixtures.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, f"/app/command?thread={THREAD_ID}")
        field = page.locator('textarea[role="combobox"]')
        expect(field).to_be_visible()
        deadline = time.monotonic() + 30
        while f"/api/threads/{THREAD_ID}" not in fixtures.reads and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        checks.check("Hydrated conversation loaded its selected thread", f"/api/threads/{THREAD_ID}" in fixtures.reads)
        field.fill(PROMPT)
        page.get_by_role("button", name="Map view", exact=True).click()
        page.get_by_role("button", name="Chat view", exact=True).click()
        expect(field).to_have_value(PROMPT)
        checks.check("Draft survives Chat/Map", True)
        trigger = page.get_by_role("button", name="Start voice mode with Asael")
        trigger.click()
        dialog = page.get_by_role("dialog", name="Realtime voice to Asael")
        expect(dialog).to_be_visible()
        checks.check("Voice consent does not open microphone", page.evaluate("window.__micAttempts") == 0)
        for _ in range(12):
            page.keyboard.press("Tab")
            checks.check("Voice focus remains in dialog", dialog.evaluate("el=>el.contains(document.activeElement)"))
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(trigger).to_be_focused()
        expect(field).to_have_value(PROMPT)
        page.get_by_role("button", name="Send message", exact=True).click()
        expect(page.get_by_text(ANSWER, exact=True)).to_be_visible(timeout=30_000)
        expect(field).to_have_value("")
        checks.check("One bounded conversation submission", fixtures.sent and len(fixtures.writes) == 1)
        checks.check("Response markup stays text", page.evaluate("window.untrustedContentRan") is False)
        label = "phone" if coarse else "desktop"
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            checks.snapshot(page, f"command-{label}-{theme}", coarse)
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_text(ANSWER, exact=True)).to_be_visible(timeout=30_000)
        checks.check("Conversation reopens with saved fixture turns", True)
        if coarse:
            menu = page.get_by_role("button", name="Open workspace menu", exact=True)
            menu.click()
            page.keyboard.press("Escape")
            expect(menu).to_be_focused()
            expect(menu).to_have_attribute("aria-expanded", "false")
            checks.check("Phone menu Escape restores focus", True)
        navigate(page, origin, "/app/approvals")
        root = page.locator('[data-testid="inbox-workspace"][aria-busy="false"]')
        expect(root).to_be_visible()
        card = page.get_by_role("article", name="Review synthetic document export", exact=True)
        expect(card).to_be_visible()
        inputs = card.get_by_role("region", name="Exact inputs (secrets redacted)", exact=True)
        expect(inputs).to_be_visible()
        checks.check("Approval preserves the exact JSON input", json.loads(inputs.inner_text()) == fixtures.approval()["input"])
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            checks.snapshot(page, f"approval-{label}-{theme}", coarse)
        card.get_by_role("textbox").fill("Reviewed synthetic scope.")
        card.get_by_role("button", name="Approve and run", exact=True).click()
        expect(card).to_have_count(0, timeout=30_000)
        checks.check("Exact decision was intercepted once", fixtures.decided and len(fixtures.writes) == 2)
        checks.check("No unexpected write, external request, popup or download", not fixtures.unexpected, fixtures.unexpected)
        checks.check("No uncaught browser errors", not errors, errors)
        checks.check("No microphone capture", page.evaluate("window.__micAttempts") == 0)
        return {"viewport": label, "writes": fixtures.writes, "readPaths": sorted(fixtures.reads),
                "unexpected": fixtures.unexpected, "browserErrors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / "failure.png"), full_page=False)
            (checks.output / "failure-dom.html").write_text(page.content())
            (checks.output / "failure-requests.json").write_text(json.dumps({
                "writes": fixtures.writes, "unexpected": fixtures.unexpected,
                "readPaths": sorted(fixtures.reads), "errors": errors}, indent=2))
        raise
    finally:
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def scope_until(page, condition, message):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if condition():
            return
        page.wait_for_timeout(25)
    raise AssertionError(message)


def exercise_scope(browser, origin, credentials, checks):
    fixture = AssistantScopeFixtures(origin)
    errors = []
    context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block", reduced_motion="reduce")
    page = None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check("Assistant scope: real isolated login", login.ok)
        session_response = context.request.get(origin + "/api/auth/session")
        if not session_response.ok:
            raise AssertionError("Assistant scope session was unavailable")
        session = scope_session(session_response.json())
        context.route("**/*", fixture.route)
        context.add_init_script("""window.__scopeMicAttempts=0; window.__scopeMicStops=0; window.__scopePeers=0;
          navigator.mediaDevices.getUserMedia=async()=>{
            window.__scopeMicAttempts++;
            const track=Object.assign(new EventTarget(),{enabled:true,readyState:'live',
              stop(){if(this.readyState==='live'){this.readyState='ended';window.__scopeMicStops++;this.dispatchEvent(new Event('ended'));}}});
            return {getTracks:()=>[track],getAudioTracks:()=>[track]};
          };
          window.AudioContext=class{constructor(){throw new Error('Synthetic meter unavailable');}};
          window.RTCPeerConnection=class{constructor(){window.__scopePeers++;throw new Error('Unexpected peer after stale session');}};""")
        fixture.plan_read("/api/runs/" + RUN_ID, fixture.defaults["/api/runs/" + RUN_ID], hold="initial-run-a")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, f"/app/command?thread={THREAD_ID}&run={RUN_ID}")
        field = page.locator('textarea[role="combobox"]')
        expect(field).to_be_visible()
        scope_until(page, lambda: "initial-run-a" in fixture.held, "Initial run A was not held")
        field.fill("Keep this same-owner composer draft.")
        page.get_by_role("button", name="Show conversations", exact=True).click()
        rail = page.get_by_role("complementary", name="Recent conversations")
        rail.get_by_role("button").filter(has_text="Initial B conversation").click()
        expect(page.get_by_text("Initial B private response", exact=True)).to_be_visible()
        before_a = sum(read["path"] == "/api/threads/" + THREAD_ID for read in fixture.requests)
        fixture.release("initial-run-a")
        page.wait_for_timeout(150)
        expect(page.get_by_text("Initial B private response", exact=True)).to_be_visible()
        expect(field).to_have_value("Keep this same-owner composer draft.")
        checks.check("Assistant scope: late selected run A cannot adopt or start a thread follow-up after B",
                     before_a == sum(read["path"] == "/api/threads/" + THREAD_ID for read in fixture.requests)
                     and "Initial A private response" not in page.locator("body").inner_text())

        page.evaluate("window.__assistantScopeDocument='same-mounted-document'")
        fixture.plan_read("/api/auth/session", session, hold="same-owner")
        page.get_by_role("button", name="Refresh account access", exact=True).click()
        scope_until(page, lambda: "same-owner" in fixture.held, "Same-owner access check was not held")
        expect(field).to_have_count(0)
        checks.check("Assistant scope: pending access recheck hides private transcript and draft",
                     "Initial B private response" not in page.locator("body").inner_text())
        fixture.defaults["/api/auth/session"] = session
        fixture.release("same-owner")
        expect(field).to_have_value("Keep this same-owner composer draft.")
        expect(page.get_by_text("Initial B private response", exact=True)).to_be_visible()
        checks.check("Assistant scope: same-owner confirmation retains draft without sending", not fixture.writes)

        for label, held_thread in (("Canonical replacement", THREAD_ID), ("Role replacement", SCOPE_THREAD_B)):
            old_text = "Old held " + label + " private response"
            held_body = json.loads(json.dumps(fixture.defaults["/api/threads/" + held_thread]))
            held_body["turns"][0]["content"] = old_text
            hold = "old-thread-" + label
            fixture.plan_read("/api/threads/" + held_thread, held_body, hold=hold)
            if not rail.is_visible():
                page.get_by_role("button", name="Show conversations", exact=True).click()
            old_title = fixture.defaults["/api/threads/" + held_thread]["thread"]["title"]
            rail.get_by_role("button").filter(has_text=old_title).click()
            scope_until(page, lambda: hold in fixture.held, "Prior-owner conversation read was not held")
            field.fill("Private draft before " + label)
            if label == "Canonical replacement":
                fixture.allow_voice = True
                page.get_by_role("button", name="Start voice mode with Asael", exact=True).click()
                page.get_by_role("button", name="Agree & start", exact=True).click()
                scope_until(page, lambda: "old-voice" in fixture.held, "Synthetic voice session was not held")
                checks.check("Assistant scope: synthetic microphone is active before replacement",
                             page.evaluate("window.__scopeMicAttempts===1 && window.__scopeMicStops===0"))
                replacement = scope_session(session, user_id="77777777-7777-4777-8777-777777777777")
            else:
                replacement = scope_session(session, role="viewer")
            fixture.plan_read("/api/auth/session", replacement, hold="replacement-access")
            if label == "Canonical replacement":
                # Simulate an asynchronous account-access refresh while the
                # modal owns focus, through the real refresh control/provider.
                # This dispatches a DOM click; no React state or callback is replaced.
                page.get_by_role("button", name="Refresh account access", exact=True).dispatch_event("click")
            else:
                page.get_by_role("button", name="Refresh account access", exact=True).click()
            scope_until(page, lambda: "replacement-access" in fixture.held, "Replacement access check was not held")
            expect(field).to_have_count(0)
            expect(page.get_by_role("dialog", name="Realtime voice to Asael")).to_have_count(0)
            if label == "Canonical replacement":
                checks.check("Assistant scope: access loss stops the active microphone before replacement settles",
                             page.evaluate("window.__scopeMicStops===1 && window.__scopePeers===0"))
            fixture.set_owner_label(label)
            fixture.defaults["/api/auth/session"] = replacement
            fixture.release("replacement-access")
            expect(field).to_have_value("")
            expect(page.get_by_text(label + " A private response", exact=True)).to_be_visible()
            scope_until(page, lambda: rail.is_visible(), "Current-owner conversations were not restored")
            reads_before_release = len(fixture.requests)
            fixture.release(hold)
            if label == "Canonical replacement":
                fixture.release("old-voice")
            page.wait_for_timeout(200)
            checks.check("Assistant scope: " + label + " clears prior draft and ignores late private follow-ups",
                         old_text not in page.locator("body").inner_text()
                         and field.input_value() == "" and len(fixture.requests) == reads_before_release
                         and page.evaluate("window.__assistantScopeDocument") == "same-mounted-document")
            session = replacement
        expect(page.get_by_role("button", name="Send follow-up", exact=True)).to_be_disabled()
        checks.check("Assistant scope: viewer cannot send and cleanup produced no effect retry",
                     len(fixture.writes) == 1 and fixture.writes[0]["disposition"] == "synthetic_held_voice_session"
                     and page.evaluate("window.__scopeMicStops===1 && window.__scopePeers===0"))
        checks.check("Assistant scope: no unplanned request or uncaught browser error", not fixture.unexpected and not errors,
                     {"unexpected": fixture.unexpected, "errors": errors})
        return {"scenario": "mounted Assistant owner/role and exact selection", "reads": fixture.requests,
                "writes": fixture.writes, "releases": fixture.releases, "unexpected": fixture.unexpected, "browserErrors": errors,
                "boundary": "Real session-provider refresh; coherent intercepted owner/role replacement; synthetic microphone track only. No device, provider transport, send, cancel or approval effect."}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / "assistant-scope-failure.png"), full_page=False)
            (checks.output / "assistant-scope-failure-dom.html").write_text(page.content())
            (checks.output / "assistant-scope-failure-requests.json").write_text(json.dumps({
                "reads": fixture.requests, "writes": fixture.writes, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/browser")
    parser.add_argument("--chrome", type=Path, help="Use installed Chrome instead of Playwright Chromium")
    parser.add_argument("--axe", required=True, type=Path, help="Path to axe-core 4.11.0 axe.min.js")
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve())
    contexts = []
    failure = None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True):
                    contexts.append(exercise(browser, origin, credentials, checks, coarse))
                contexts.append(exercise_scope(browser, origin, credentials, checks))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print(f"Browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts,
            "failure": failure, "boundary": "Isolated real authentication/SSR; synthetic intercepted reads and effects; no provider, tool or device execution."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
