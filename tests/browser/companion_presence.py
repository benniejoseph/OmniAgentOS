#!/usr/bin/env python3
"""Static ATLAS presence from read-only, synthetic Command projections.

No model, microphone, audio, OAuth, application write, rig or clip is exercised.
The isolated bootstrap login is the shared runner's only real setup mutation.
"""

import argparse
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright

from companion_presence_fixtures import HOME_ID, RUN_ID, THREAD_ID, PresenceFixtures, preferences
from run import Checks, REPO, navigate, preview, select_theme

ROOT = '[data-testid="companion-presence"]'
COMMAND = f"/app/command?thread={THREAD_ID}&run={RUN_ID}"
EMPTY_COMMAND = f"/app/command?thread={HOME_ID}"
GREETING = "/companion/atlas-greeting.png"


def presence(page):
    return page.locator(ROOT).first


def until(page, predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(message)


def ready(page, state="completed", label="Completed"):
    root = presence(page)
    expect(root).to_be_visible(timeout=30_000)
    expect(root).to_have_attribute("data-companion-preferences", "ready")
    expect(root).to_have_attribute("data-companion-state", state)
    expect(root.get_by_text(label, exact=True)).to_be_visible()
    return root


def open_details(page):
    root = presence(page)
    summary = root.locator("summary").first
    expect(summary).to_be_visible()
    if not summary.evaluate("el=>el.parentElement.open"):
        summary.click()
    return root


def home(page):
    return open_details(page).get_by_role("button", name="Home conversation", exact=True)


def snapshot(page, checks, name, coarse, greeting=False):
    root = presence(page) if greeting else open_details(page)
    if greeting and root.locator("details").first.evaluate("el=>el.open"):
        root.locator("summary").first.click()
    page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    root.scroll_into_view_if_needed()
    geometry = root.evaluate("""(el,greeting) => { const slot=el.querySelector('summary > span[aria-hidden="true"]').getBoundingClientRect();const image=el.querySelector('img');const imageBox=image?.getBoundingClientRect(); return {
      viewport:innerWidth,document:document.documentElement.scrollWidth,client:el.clientWidth,scroll:el.scrollWidth,
      portraitWidth:slot.width,portraitHeight:slot.height,
      imageSource:image?new URL(image.currentSrc||image.src,location.href).pathname:null,
      sameOrigin:image?new URL(image.currentSrc||image.src,location.href).origin===location.origin:false,
      naturalWidth:image?.naturalWidth,naturalHeight:image?.naturalHeight,
      imageWidth:imageBox?.width,imageHeight:imageBox?.height,
      targets:[...el.querySelectorAll(greeting?'summary':'button,a,summary')].map(el=>el.getBoundingClientRect().height)}; }""", greeting)
    if greeting:
        expect(root).to_have_attribute("data-companion-layout", "greeting")
        expect(root).to_have_attribute("data-companion-artwork", "greeting")
        checks.check(name + ": approved bounded full-body image", geometry["imageSource"] == GREETING and geometry["sameOrigin"] and
                     geometry["naturalWidth"] == 211 and geometry["naturalHeight"] == 432 and
                     0 < geometry["imageWidth"] < geometry["imageHeight"] <= 144 and
                     abs(geometry["imageWidth"] / geometry["imageHeight"] - 211 / 432) < .01, geometry)
    else:
        checks.check(name + ": stable36px portrait", geometry["portraitWidth"] == 36 and geometry["portraitHeight"] == 36, geometry)
    checks.check(name + ": no horizontal overflow", geometry["document"] <= geometry["viewport"] + 1 and geometry["scroll"] <= geometry["client"] + 1, geometry)
    checks.check(name + ": control target floor", all(size >= (48 if coarse else 44) - 1 for size in geometry["targets"]))
    checks.check(name + ": no animation claimed", root.evaluate("el=>[el,...el.querySelectorAll('*')].every(node=>getComputedStyle(node).animationName==='none')"))
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    page.add_script_tag(path=str(checks.axe))
    audit = page.evaluate("""async selector => { const result=await axe.run(document.querySelector(selector),
      {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
      return {violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
      incomplete:result.incomplete.map(v=>v.id),passes:result.passes.length}; }""", ROOT)
    (checks.output / (name + "-axe.json")).write_text(json.dumps(audit, indent=2))
    checks.check(name + ": scoped axe", not audit["violations"], audit["violations"])


def greeting_views(page, origin, fixture, checks, label, coarse):
    fixture.preferences = preferences()
    fixture.asset_failure = False
    navigate(page, origin, EMPTY_COMMAND)
    root = ready(page, "available", "Available")
    expect(page.get_by_role("heading", name="What are we working on?", exact=True)).to_be_visible()
    expect(root.locator("code")).to_have_count(0)
    draft = page.locator('textarea[role="combobox"]')
    draft.fill("")
    page.wait_for_function("selector=>document.querySelector(selector+' img')?.naturalHeight===432", arg=ROOT)
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse)
        snapshot(page, checks, f"presence-{label}-greeting-{theme}", coarse, greeting=True)
    if coarse:
        page.set_viewport_size({"width": 320, "height": 844})
        page.evaluate("document.documentElement.style.fontSize='200%'")
        snapshot(page, checks, "presence-greeting-320-text-200", True, greeting=True)
        draft.click()
        draft.fill("Local unsent greeting draft. Keep this message editable while reviewing composer options.")
        send = page.get_by_role("button", name="Send message", exact=True)
        expect(send).to_be_enabled()
        send.click(trial=True)
        composer = page.locator('section[aria-labelledby="command-composer-title"]')
        options = composer.locator("summary").first
        options.click()
        expect(composer.locator("details").first).to_have_attribute("open", "")
        options.click()
        send.click(trial=True)
        bounds = send.evaluate("""el=>{const box=el.getBoundingClientRect();const dock=document.querySelector('nav[aria-label="Everyday workspace navigation"]').getBoundingClientRect();const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return {bottom:box.bottom,dockTop:dock.top,hit:hit===el||el.contains(hit)}}""")
        checks.check("greeting 320px/200%: draft, Options and send remain reachable above dock without submission",
                     draft.input_value().startswith("Local unsent greeting draft.") and bounds["hit"] and bounds["bottom"] <= bounds["dockTop"] + 1, bounds)
        page.screenshot(path=str(checks.output / "presence-greeting-320-text-200-composer.png"), full_page=False)
        draft.fill("")
        page.evaluate("document.documentElement.style.fontSize=''")
        page.set_viewport_size({"width": 390, "height": 844})

    fixture.preferences = preferences(visible=False)
    navigate(page, origin, EMPTY_COMMAND)
    root = ready(page, "available", "Available")
    expect(root).to_have_attribute("data-companion-layout", "greeting")
    expect(root).to_have_attribute("data-companion-portrait", "hidden")
    expect(root.locator("img")).to_have_count(0)
    checks.check(label + ": hidden character preserves the empty idle greeting and composer", draft.is_visible())

    fixture.preferences = preferences()
    missing = []
    def missing_greeting(route):
        missing.append(route.request.url)
        route.fulfill(status=404, content_type="text/plain", body="Synthetic greeting unavailable")
    page.route(origin + GREETING, missing_greeting)
    try:
        navigate(page, origin, EMPTY_COMMAND)
        root = ready(page, "available", "Available")
        expect(root.locator("img")).to_have_attribute("src", "/companion/atlas-neutral.png")
        page.wait_for_function("selector=>document.querySelector(selector+' img')?.naturalWidth===108", arg=ROOT)
        expect(root).to_have_attribute("data-companion-artwork", "portrait")
        expect(root).to_have_attribute("data-companion-portrait", "visible")
        checks.check(label + ": missing full-body image falls back to neutral without changing idle state", bool(missing))
        page.screenshot(path=str(checks.output / f"presence-{label}-greeting-neutral-fallback.png"), full_page=False)
    finally:
        page.unroute(origin + GREETING, missing_greeting)
    navigate(page, origin, COMMAND)
    root = ready(page)
    expect(root).to_have_attribute("data-companion-layout", "compact")
    expect(root).to_have_attribute("data-companion-artwork", "portrait")
    expect(root.locator("img")).to_have_attribute("src", "/companion/atlas-neutral.png")
    checks.check(label + ": populated verified conversation returns to the compact portrait", True)


def home_adoption(page, origin, fixture, checks, label):
    draft = page.locator('textarea[role="combobox"]')
    draft.fill("Unsaved message remains in the composer")
    fixture.plan_home(body={"error": "Synthetic home unavailable."}, status=503)
    before = page.url
    home(page).click()
    expect(page.get_by_text("Synthetic home unavailable.", exact=False).first).to_be_visible()
    expect(home(page)).to_be_enabled()
    checks.check(label + ": failed home read preserves URL and draft", page.url == before and draft.input_value() == "Unsaved message remains in the composer")
    fixture.plan_home(hold="home-selection")
    home(page).focus()
    page.keyboard.press("Enter")
    until(page, lambda: "home-selection" in fixture.held, "Home selection was not held")
    expect(home(page)).to_be_disabled()
    draft.fill("Draft edited while the home read is pending")
    fixture.release("home-selection")
    expect(page).to_have_url(origin + f"/app/command?thread={HOME_ID}")
    expect(page.get_by_role("heading", name="Owned home conversation", exact=True)).to_be_visible()
    expect(draft).to_have_value("Draft edited while the home read is pending")
    expect(home(page)).to_be_enabled()
    checks.check(label + ": exact home adopted through existing loader without clearing composer or stale run URL", True)


def exercise(browser, origin, credentials, checks, coarse):
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture, page, errors, effects = None, None, [], []
    label = "phone" if coarse else "desktop"
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated bootstrap login", login.ok)
        session = context.request.get(origin + "/api/auth/session", timeout=90_000).json()
        fixture = PresenceFixtures(origin, session["context"]["tenantId"], session["context"]["actorId"])
        # Hold every initial lifecycle request, including development Strict
        # Mode's superseded mount. Release all handles rather than assuming one.
        fixture.preference_hold = {"body": {"error": "Synthetic preferences unavailable."}, "status": 503, "hold": "initial"}
        context.route("**/*", fixture.route)
        context.expose_binding("__recordPresenceEffect", lambda _source, kind: effects.append(kind))
        context.add_init_script("""const stop=kind=>{void window.__recordPresenceEffect(kind);throw Error('Effect blocked: '+kind)};
          if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>stop('microphone');
          HTMLMediaElement.prototype.play=async()=>stop('media playback');
          window.open=()=>stop('popup');
          if(window.AudioContext) window.AudioContext=function(){return stop('AudioContext')};
          if(window.webkitAudioContext) window.webkitAudioContext=function(){return stop('webkitAudioContext')};
          if(window.RTCPeerConnection) window.RTCPeerConnection=function(){return stop('WebRTC')};""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        navigate(page, origin, COMMAND)
        root = presence(page)
        until(page, lambda: "initial" in fixture.held, "Initial preference read was not held")
        expect(root).to_have_attribute("data-companion-preferences", "loading")
        expect(root).to_have_attribute("data-companion-portrait", "hidden")
        expect(root.locator("img")).to_have_count(0)
        fixture.release_preferences()
        expect(root).to_have_attribute("data-companion-preferences", "unavailable")
        open_details(page)
        expect(root.get_by_role("link", name="Companion settings", exact=True)).to_be_visible()
        checks.check(label + ": unknown/failed preferences never flash the character or fabricate home", root.locator("img").count() == 0 and root.get_by_role("button", name="Home conversation", exact=True).count() == 0)

        navigate(page, origin, COMMAND)
        root = ready(page)
        expect(root).to_have_attribute("data-companion-motion", "reduced")
        expect(root).to_have_attribute("data-companion-portrait", "visible")
        open_details(page)
        expect(root.locator("code")).to_have_text(RUN_ID)
        page.wait_for_function("selector=>document.querySelector(selector+' img')?.naturalWidth===108", arg=ROOT)
        home(page).focus()
        checks.check(label + ": home keyboard focus has a3px outline", home(page).evaluate("el=>getComputedStyle(el).outlineWidth==='3px'"))
        home_adoption(page, origin, fixture, checks, label)

        for mode, state, text in [("legacy", "available", "Outcome unverified"), ("partial", "needs_you", "Partial outcome"),
                                  ("mismatched", "available", "Outcome unverified"), ("queued", "working", "Queued"),
                                  ("running", "working", "Working"), ("failed", "blocked", "Needs attention"), ("canceled", "paused", "Canceled")]:
            fixture.run_mode = mode
            navigate(page, origin, COMMAND)
            ready(page, state, text)
            if mode in ("queued", "running"):
                expect(home(page)).to_be_disabled()
            checks.check(label + ": truthful read projection " + mode, True)

        fixture.run_mode = "verified"
        fixture.preferences = preferences(intensity="quiet", visible=False, home_state="unavailable")
        navigate(page, origin, COMMAND)
        root = ready(page)
        expect(root).to_have_attribute("data-companion-intensity", "quiet")
        expect(root).to_have_attribute("data-companion-portrait", "hidden")
        open_details(page)
        expect(root.get_by_role("link", name="Open Assistant", exact=True)).to_have_attribute("href", "/app/command")
        expect(root.get_by_text("Home conversation unavailable; opens Assistant.", exact=True)).to_be_visible()
        checks.check(label + ": hidden quiet character retains verified status and truthful home fallback", root.locator("img").count() == 0)

        fixture.preferences = preferences(motion="off")
        fixture.asset_failure = True
        navigate(page, origin, COMMAND)
        root = ready(page)
        expect(root).to_have_attribute("data-companion-portrait", "unavailable")
        expect(root).to_have_attribute("data-companion-motion", "off")
        open_details(page)
        expect(root.get_by_text("Portrait unavailable.", exact=True)).to_be_visible()
        expect(home(page)).to_be_enabled()
        checks.check(label + ": failed image keeps status, navigation and geometry", True)

        fixture.preferences = preferences(intensity="expressive")
        fixture.asset_failure = False
        navigate(page, origin, COMMAND)
        root = ready(page)
        expect(root).to_have_attribute("data-companion-motion", "reduced")
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            snapshot(page, checks, f"presence-{label}-{theme}", coarse)
        page.evaluate("""()=>{window.__presenceVisibility='hidden';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__presenceVisibility});document.dispatchEvent(new Event('visibilitychange'));}""")
        expect(root).to_have_attribute("data-companion-portrait", "hidden")
        expect(root.get_by_text("Completed", exact=True)).to_be_visible()
        expect(home(page)).to_be_enabled()
        page.evaluate("window.__presenceVisibility='visible';document.dispatchEvent(new Event('visibilitychange'))")
        expect(root).to_have_attribute("data-companion-portrait", "visible")
        checks.check(label + ": synthetic hidden-document event retains text and controls", True)
        if not coarse:
            page.set_viewport_size({"width": 320, "height": 900})
            snapshot(page, checks, "presence-320", False)
            page.evaluate("document.documentElement.style.fontSize='200%'")
            dock = page.get_by_role("navigation", name="Everyday workspace navigation", exact=True)
            links = dock.get_by_role("link")
            links.first.focus()
            for index in range(links.count()):
                if index:
                    page.keyboard.press("Tab")
                expect(links.nth(index)).to_be_focused()
                page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                bounds = links.nth(index).evaluate("""el => {
                  const box=el.getBoundingClientRect();
                  const dock=el.closest('nav');
                  const nav=dock.getBoundingClientRect();
                  const label=el.querySelector('span');
                  const labelBox=label.getBoundingClientRect();
                  const range=document.createRange();range.selectNodeContents(label);
                  const contained=(inner,outer)=>inner.left>=outer.left-1 && inner.right<=outer.right+1 && inner.top>=outer.top-1 && inner.bottom<=outer.bottom+1;
                  const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
                  return {label:label.textContent.trim(),left:box.left,right:box.right,navLeft:nav.left,navRight:nav.right,
                    itemContained:contained(box,nav),labelContained:contained(labelBox,box) && [...range.getClientRects()].every(rect=>contained(rect,labelBox)),
                    labelVisible:labelBox.width>0 && labelBox.height>0,labelOverflow:label.scrollWidth>label.clientWidth+1,
                    hitTarget:hit===el || el.contains(hit),dockHeight:nav.height,
                    reservedHeight:parseFloat(getComputedStyle(document.getElementById('workspace-content')).paddingBottom),
                    dockOverflow:dock.scrollWidth>dock.clientWidth+1};
                }""")
                checks.check("320px/200% dock keyboard destination " + str(index + 1),
                             bool(bounds["label"]) and bounds["itemContained"] and bounds["labelContained"] and bounds["labelVisible"] and
                             not bounds["labelOverflow"] and not bounds["dockOverflow"] and bounds["hitTarget"] and
                             bounds["dockHeight"] <= bounds["reservedHeight"] + 1, bounds)
            snapshot(page, checks, "presence-320-text-200", False)
            page.set_viewport_size({"width": 1440, "height": 900})
            snapshot(page, checks, "presence-text-200", False)
            page.evaluate("document.documentElement.style.fontSize=''")
            page.emulate_media(forced_colors="active")
            snapshot(page, checks, "presence-forced-colors", False)
            page.emulate_media(forced_colors="none")

        greeting_views(page, origin, fixture, checks, label, coarse)

        fixture.preference_hold = {"body": fixture.preferences, "status": 200, "hold": "disposed-preferences"}
        navigate(page, origin, COMMAND)
        until(page, lambda: "disposed-preferences" in fixture.held, "Dispose preference read not held")
        navigate(page, origin, "/app/activity")
        fixture.release_preferences()
        expect(page.locator(ROOT)).to_have_count(0)
        fixture.preferences = preferences(visible=False)
        navigate(page, origin, COMMAND)
        root = ready(page)
        expect(root).to_have_attribute("data-companion-portrait", "hidden")
        fixture.plan_home(hold="disposed-home")
        home(page).click()
        until(page, lambda: "disposed-home" in fixture.held, "Dispose home read not held")
        navigate(page, origin, "/app/activity")
        fixture.release("disposed-home")
        expect(page).to_have_url(origin + "/app/activity")
        expect(page.locator(ROOT)).to_have_count(0)
        checks.check(label + ": disposed preference/home reads cannot revive the view or change URL", True)
        checks.check(label + ": zero application writes, provider/audio/device/OAuth effects", not fixture.writes and not fixture.unexpected and not effects, {"unexpected": fixture.unexpected, "effects": effects})
        checks.check(label + ": no uncaught page errors", not errors, errors)
        return {"viewport": label, "requests": fixture.requests, "releases": fixture.releases, "unexpected": fixture.unexpected, "effects": effects, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (label + "-failure.png")), full_page=False)
            (checks.output / (label + "-failure-dom.html")).write_text(page.content())
        (checks.output / (label + "-failure-requests.json")).write_text(json.dumps({"requests": fixture.requests if fixture else [], "unexpected": fixture.unexpected if fixture else [], "errors": errors, "effects": effects}, indent=2))
        raise
    finally:
        if fixture is not None:
            fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/companion-presence")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve())
    contexts, failure = [], None
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
        print(f"Companion presence check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Real isolated bootstrap login, then synthetic GET-only Command/Companion projections. Every application write and OAuth/provider/audio/device action blocked. Hidden visibility is a synthetic document event. Static portrait evidence only; no clips, model/rig, playback or performance proof."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
