#!/usr/bin/env python3
"""Payments presentation and local lifecycle QA; no hardware or payment execution.

Eleven desktop requests are wholly fulfilled from exact synthetic plans. The
WebAuthn SDK runs against pre-application navigator.credentials stubs, never an
actual authenticator. Phone coverage is read-only and explicitly unsupported.
"""
import argparse
import json
from pathlib import Path
import re
import time
from playwright.sync_api import expect, sync_playwright
from payments_fixtures import PaymentFixtures, REGISTER, REVIEWS, SIGNERS, REVIEW_A, REVIEW_B, LONG, auth_path, assertion, bound, registration_response, review, signed, signer
from fixtures import STAMP
from run import Checks, REPO, navigate, preview, select_theme

ROOT = '[data-testid="payments-workspace"]'


def root(page): return page.locator(ROOT)
def purchase(page, name="Synthetic merchant A"): return root(page).get_by_role("article").filter(has=page.get_by_role("heading", name=name, exact=True))
def register(page): return root(page).get_by_role("button", name="Register hardware signer", exact=True)
def until(page, predicate, label, timeout=20):
    end = time.monotonic() + timeout
    while not predicate() and time.monotonic() < end: page.wait_for_timeout(25)
    if not predicate(): raise AssertionError(label)
def settle(page): page.evaluate("() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
def ready(page):
    expect(root(page).get_by_text("Purchase reviews: loaded.", exact=True)).to_be_visible()
    expect(root(page).get_by_text("Signer registry: loaded.", exact=True)).to_be_visible()
def refresh(page, source): root(page).get_by_role("button", name="Refresh " + ("purchase reviews" if source == REVIEWS else "registered signers"), exact=True).click()
def plan_device(page, kind, mode, options, response=None):
    page.evaluate("plan=>window.__paymentDevicePlans.push(plan)", {"kind": kind, "mode": mode, "challenge": options["challenge"], "rpId": options.get("rpId") or options.get("rp", {}).get("id"), "response": response})
def confirm(page, identity=REVIEW_A):
    panel = purchase(page, "Synthetic merchant A" if identity == REVIEW_A else "Synthetic merchant B")
    panel.get_by_role("checkbox").check()
    return panel.get_by_role("button", name="Sign both mandates for review " + identity, exact=True)
def device_starts(fixture): return [event for event in fixture.devices if event.get("stage") == "start"]


DEVICE_GUARD = r"""(() => {
  window.__paymentDevicePlans=[];window.__paymentDevicePending=new Set();
  const boundary=event=>window.__recordPaymentBoundary(event);
  const bytes=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0)).buffer;
  const encode=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const record=event=>window.__recordPaymentDevice(event);
  const invoke=(kind,options)=>{
    const plan=window.__paymentDevicePlans.shift();
    const actual={kind,challenge:options?.publicKey?.challenge?encode(options.publicKey.challenge):null,rpId:options?.publicKey?.rpId||options?.publicKey?.rp?.id};
    record({...actual,stage:'start'});
    if(!plan||plan.kind!==kind||plan.challenge!==actual.challenge||plan.rpId!==actual.rpId){boundary({kind:'unexpected_authenticator_stub_call',actual});return Promise.reject(new Error('No exact synthetic authenticator plan'));}
    return new Promise((resolve,reject)=>{
      const finish=(disposition,error)=>{window.__paymentDevicePending.delete(stop);options.signal?.removeEventListener('abort',abort);record({kind,stage:'settled',disposition});if(error)reject(error);else{
        const source=plan.response,inner=source.response;
        const response=kind==='get'?{clientDataJSON:bytes(inner.clientDataJSON),authenticatorData:bytes(inner.authenticatorData),signature:bytes(inner.signature),userHandle:null}:{clientDataJSON:bytes(inner.clientDataJSON),attestationObject:bytes(inner.attestationObject),getTransports:()=>inner.transports};
        resolve({id:source.id,rawId:bytes(source.rawId),type:'public-key',authenticatorAttachment:'platform',response,getClientExtensionResults:()=>({})});
      }};
      const abort=()=>finish('synthetic_abort',new DOMException('Synthetic canceled challenge','AbortError'));
      const stop=()=>finish('teardown_abort',new DOMException('Synthetic teardown','AbortError'));
      if(options.signal?.aborted){abort();return;}
      options.signal?.addEventListener('abort',abort,{once:true});window.__paymentDevicePending.add(stop);
      if(plan.mode==='hold')return;
      if(plan.mode==='unsupported'){finish('synthetic_unsupported',new DOMException('Synthetic unsupported authenticator','NotSupportedError'));return;}
      if(plan.mode==='cancel'){finish('synthetic_canceled',new DOMException('Synthetic canceled challenge','NotAllowedError'));return;}
      finish('synthetic_response');
    });
  };
  Object.defineProperty(navigator.credentials,'create',{configurable:true,value:options=>invoke('create',options)});
  Object.defineProperty(navigator.credentials,'get',{configurable:true,value:options=>invoke('get',options)});
  window.__settlePaymentDevices=()=>{for(const stop of [...window.__paymentDevicePending])stop();};
  window.open=(...args)=>{boundary({kind:'popup',args});return null;};
  HTMLMediaElement.prototype.play=function(){boundary({kind:'playback'});return Promise.reject(new Error('Playback prohibited'));};
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{boundary({kind:'microphone'});return Promise.reject(new Error('Media prohibited'));};
  const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download){boundary({kind:'programmatic_download'});return;}return click.call(this);};
})();"""


def wait_for_theme_colors(page, coarse):
    # The theme preference/dataset can settle before inherited text colors do.
    # Wait for actual shell and current-control colors, keeping axe's full
    # contrast check intact rather than sampling the light/dark token swap.
    theme = page.locator("html").get_attribute("data-theme")
    palette = {"light": ["rgb(36, 35, 33)", "rgb(105, 100, 94)", "rgb(255, 255, 255)", "rgb(250, 249, 246)"],
               "dark": ["rgb(244, 241, 234)", "rgb(184, 179, 170)", "rgb(34, 35, 37)", "rgb(25, 26, 27)"]}[theme]
    page.wait_for_function("""({theme,coarse,palette})=>{
      const surface=document.querySelector(coarse?'nav[aria-label="Everyday workspace navigation"]':'#desktop-workspace-navigation');
      const navigation=coarse?surface:surface?.querySelector('nav[aria-label="Application navigation"]');
      const muted=navigation?.querySelector('a:not([aria-current="page"]):not(:hover)');
      const label=theme[0].toUpperCase()+theme.slice(1);
      const compact=document.querySelector('button[aria-label^="Theme: '+label+'."]');
      const selected=compact||document.querySelector('button[aria-label="'+label+' theme"][aria-pressed="true"]');
      const controlColor=compact&&!compact.matches(':hover')?palette[1]:palette[0];
      return document.documentElement.dataset.theme===theme && surface && muted && selected &&
        getComputedStyle(document.body).color===palette[0] && getComputedStyle(selected).color===controlColor &&
        getComputedStyle(muted).color===palette[1] && getComputedStyle(surface).backgroundColor===palette[coarse?3:2];
    }""", arg={"theme": theme, "coarse": coarse, "palette": palette}, timeout=10_000)


def capture(page, checks, name, coarse, target=None, axe=True):
    page.evaluate("window.scrollTo(0,0)"); settle(page)
    checks.check(name + ": expected pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)
    geometry = page.evaluate("() => ({viewport:innerWidth,document:document.documentElement.scrollWidth})")
    checks.check(name + ": no document overflow", geometry["document"] <= geometry["viewport"] + 1, geometry)
    short = root(page).locator("button:visible,a:visible,summary:visible,input:visible").evaluate_all("""(els,min)=>els.flatMap(el=>{
      const target=el.matches('input[type=checkbox]')?(el.closest('label')||el):el;
      const r=target.getBoundingClientRect();return r.height<min-1?[{name:el.getAttribute('aria-label')||el.textContent,height:r.height}]:[];
    })""", 48 if coarse else 44)
    checks.check(name + ": accessible control targets", not short, short)
    if axe:
        wait_for_theme_colors(page, coarse)
        if not page.evaluate("Boolean(window.axe)"): page.add_script_tag(path=str(checks.axe))
        result = page.evaluate("""async()=>{const result=await axe.run({exclude:[['nextjs-portal']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});return {violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:result.incomplete.map(v=>v.id),passes:result.passes.length};}""")
        (checks.output / (name + "-axe.json")).write_text(json.dumps(result, indent=2))
        checks.check(name + ": page-wide axe", not result["violations"], result["violations"])
    if target is not None:
        target.evaluate("el=>el.scrollIntoView({block:'start'})"); page.evaluate("window.scrollBy(0,-112)"); settle(page)
    page.screenshot(path=str(checks.output / (name + ".png")), full_page=False)
    checks.check(name + ": viewport capture preserves pointer", page.evaluate("matchMedia('(pointer:coarse)').matches") == coarse)


def inspect_reads(page, fixture, checks, coarse):
    expect(root(page).get_by_text("Signer registry: unavailable.", exact=True)).to_be_visible()
    expect(root(page).get_by_text("Purchase reviews: unavailable.", exact=True)).to_be_visible()
    checks.check("Initial failure does not claim zero signers or absent policy", "Signer count unavailable" in root(page).inner_text() and "No payment signers were returned." not in root(page).inner_text() and "No operator-reviewed policy is configured." not in root(page).inner_text())
    fixture.mode = "ready"; refresh(page, SIGNERS)
    expect(root(page).get_by_text("Signer registry: loaded.", exact=True)).to_be_visible()
    expect(register(page)).to_be_disabled()
    checks.check("Successful signers are independent of failed reviews", fixture.signers[0]["credentialId"] in root(page).inner_text() and "Review count unavailable" in root(page).inner_text())
    refresh(page, REVIEWS); ready(page)
    panel = purchase(page)
    text = panel.inner_text()
    checks.check("Full merchant, item, shipping, instrument and constraints remain visible", all(value in text for value in (LONG, "11300 minor units", "provider:" + LONG, "processor:" + LONG, "instrument:" + LONG, "Immediate execution only", "Synthetic suite")))
    checks.check("Exact review, owner, Agent, terms and authorization identities survive", all(fixture.reviews[0][key] in text for key in ("reviewId", "tenantId", "ownerActorId", "shoppingAgentPrincipalId", "intentSha256", "exactTermsSha256", "authorizationDigest", "reviewSha256")))
    checks.check("Untrusted merchant content stays text", not page.evaluate("Boolean(window.untrustedPaymentRan)"))
    checks.check("Merchant link metadata is safe and never followed", panel.get_by_role("link").get_attribute("href") == fixture.reviews[0]["terms"]["merchant"]["website"] and panel.get_by_role("link").get_attribute("rel") == "noopener noreferrer")
    for name, state in (("Synthetic expired merchant", "Expired"), ("Synthetic superseded merchant", "Superseded")):
        historical = purchase(page, name)
        expect(historical.get_by_text(state, exact=True)).to_be_visible()
        checks.check(state + " reviews expose no signing action", historical.get_by_role("button", name=re.compile("Sign both mandates")).count() == 0)
    if coarse:
        expect(register(page)).to_be_disabled()
        checks.check("Unsupported browser is explained without an authenticator call", "This browser cannot start WebAuthn here." in root(page).inner_text() and len(device_starts(fixture)) == 0)
        return
    expect(register(page)).to_be_enabled()
    panel.get_by_role("checkbox").check()
    fixture.plan(REVIEWS, body={"error": "Synthetic review refresh unavailable. " + LONG}, status=503)
    refresh(page, REVIEWS)
    expect(root(page).get_by_text("Purchase reviews: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
    expect(panel.get_by_role("checkbox")).to_be_checked(); expect(panel.get_by_role("checkbox")).to_be_disabled()
    checks.check("Read failure retains exact terms, checked draft and last-loaded count", fixture.reviews[0]["reviewSha256"] in panel.inner_text() and "Last loaded" in root(page).inner_text())
    refresh(page, REVIEWS); ready(page); expect(panel.get_by_role("checkbox")).to_be_checked()
    fixture.reviews[0] = review(fixture.tenant, fixture.actor, variant="changed exact item")
    refresh(page, REVIEWS); ready(page)
    expect(panel.get_by_role("checkbox")).not_to_be_checked()
    checks.check("Same review ID with changed terms invalidates prior consent", fixture.reviews[0]["exactTermsSha256"] in panel.inner_text())
    panel.get_by_role("checkbox").check()
    fixture.signers[0]["lifecycleRevision"] += 1
    refresh(page, SIGNERS); ready(page); expect(panel.get_by_role("checkbox")).not_to_be_checked()
    fixture.signers[0] = signer(fixture.tenant, fixture.actor)
    refresh(page, SIGNERS); ready(page); expect(panel.get_by_role("checkbox")).not_to_be_checked()
    checks.check("Signer source revision invalidates consent permanently until reviewed again", True)
    # Latest-request guard: the old GET is released after a fresh remount loaded different terms.
    fixture.plan(REVIEWS, hold="old-review-read")
    refresh(page, REVIEWS); until(page, lambda: "old-review-read" in fixture.held, "Old review GET held")
    fixture.reviews[0] = review(fixture.tenant, fixture.actor, variant="latest after remount")
    navigate(page, fixture.origin, "/app/payments?read=latest"); ready(page)
    latest = fixture.reviews[0]["reviewSha256"]
    fixture.release("old-review-read"); settle(page)
    checks.check("Disposed late read cannot overwrite the remounted current review", latest in purchase(page).inner_text() and "latest after remount" in purchase(page).inner_text())


def exact_effects(page, fixture, checks):
    # 1. Wrong options must be rejected before the browser authenticator is called.
    wrong = fixture.options(); wrong["reviewSha256"] = "f" * 64
    fixture.effect("POST", auth_path(), {"action": "options"}, wrong)
    confirm(page).click()
    expect(root(page).get_by_role("alert")).to_contain_text("did not match")
    checks.check("Wrong review challenge starts no authenticator", len(device_starts(fixture)) == 0)
    # 2. Hold a completely synthetic challenge, then cancel it without an authorize POST.
    options = fixture.options()
    fixture.effect("POST", auth_path(), {"action": "options"}, options)
    plan_device(page, "get", "hold", options["options"], assertion(fixture.reviews[0], fixture.signers[0]))
    trigger = confirm(page); trigger.click()
    cancel = root(page).get_by_role("button", name="Cancel authenticator challenge", exact=True)
    expect(cancel).to_be_visible(); expect(register(page)).to_be_disabled()
    checks.check("One pending action disables signer changes and review confirmations", root(page).get_by_role("checkbox").evaluate_all("els=>els.every(el=>el.disabled)"))
    cancel.click(); expect(root(page).get_by_role("alert")).to_contain_text("No completion request was sent")
    expect(trigger).to_be_focused()
    checks.check("Canceled challenge sends only its exact options request", len(fixture.writes) == 2)
    # 3. Unsupported physical profile is a synthetic browser error, never a real device call.
    start = fixture.registration()
    fixture.effect("POST", REGISTER, None, start)
    plan_device(page, "create", "unsupported", start["options"])
    register(page).click(); expect(root(page).get_by_role("alert")).to_contain_text("does not support")
    checks.check("Unsupported authenticator sends no registration completion", len(fixture.writes) == 3)
    # 4–5. An accepted registration survives held/failed source refreshes.
    new_signer = signer(fixture.tenant, fixture.actor, "b")
    start = fixture.registration(); response = registration_response(new_signer, start["options"]["challenge"])
    fixture.effect("POST", REGISTER, None, start)
    fixture.effect("PUT", REGISTER, {"challengeToken": start["challengeToken"], "response": response}, {"credential": new_signer, "created": True}, hold="registration-result")
    plan_device(page, "create", "response", start["options"], response)
    register(page).click(); until(page, lambda: "registration-result" in fixture.held, "Registration receipt held")
    checks.check("Registration and revocation share pending exclusion", all(button.is_disabled() for button in root(page).get_by_role("button", name=re.compile("Review removal of signer")).all()))
    fixture.signers.append(new_signer)
    fixture.plan(SIGNERS, body={"error": "Synthetic signer follow-up unavailable."}, status=503, hold="signer-follow-up")
    fixture.release("registration-result")
    expect(root(page).get_by_role("heading", name="Signer registration confirmed", exact=True)).to_be_visible()
    until(page, lambda: "signer-follow-up" in fixture.held, "Signer follow-up held")
    checks.check("Accepted registration ends pending before follow-up GET completes", root(page).get_by_text("Confirming the hardware signer registration…", exact=True).count() == 0)
    fixture.release("signer-follow-up")
    expect(root(page).get_by_text("Signer registry: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
    expect(root(page).get_by_role("heading", name="Signer registration confirmed", exact=True)).to_be_visible()
    refresh(page, SIGNERS); ready(page)
    # 6–7. A synthetically returned wrong successful receipt must not fabricate authorization.
    options = fixture.options(); response = assertion(fixture.reviews[0], fixture.signers[0]); wrong = signed(fixture.reviews[0], fixture.signers[0]); wrong["authorization"]["reviewId"] = REVIEW_B
    fixture.effect("POST", auth_path(), {"action": "options"}, options)
    fixture.effect("POST", auth_path(), {"action": "authorize", "response": response}, wrong)
    plan_device(page, "get", "response", options["options"], response)
    confirm(page).click(); expect(root(page).get_by_role("alert")).to_contain_text("did not match")
    checks.check("Wrong signed receipt leaves prior confirmed registration intact", root(page).get_by_role("heading", name="Mandate authorization confirmed", exact=True).count() == 0 and purchase(page).get_by_text("Awaiting signature", exact=True).count() == 1)
    # 8–9. Exact signed receipt, then unavailable review read.
    options = fixture.options(); response = assertion(fixture.reviews[0], fixture.signers[0]); result = signed(fixture.reviews[0], fixture.signers[0])
    fixture.effect("POST", auth_path(), {"action": "options"}, options)
    fixture.effect("POST", auth_path(), {"action": "authorize", "response": response}, result, hold="signed-result")
    plan_device(page, "get", "response", options["options"], response)
    confirm(page).click(); until(page, lambda: "signed-result" in fixture.held, "Signed receipt held")
    fixture.reviews[0] = result["review"]
    fixture.plan(REVIEWS, body={"error": "Synthetic review follow-up unavailable."}, status=503, hold="review-follow-up")
    fixture.release("signed-result")
    expect(root(page).get_by_role("heading", name="Mandate authorization confirmed", exact=True)).to_be_visible()
    until(page, lambda: "review-follow-up" in fixture.held, "Review follow-up held")
    checks.check("Accepted signature is distinct from executing payment", "No checkout or payment was submitted." in root(page).inner_text() and root(page).get_by_text("Verifying and storing the signed mandate receipt…", exact=True).count() == 0)
    fixture.release("review-follow-up")
    expect(root(page).get_by_text("Purchase reviews: refresh unavailable; last-loaded details are shown.", exact=True)).to_be_visible()
    expect(root(page).get_by_role("heading", name="Mandate authorization confirmed", exact=True)).to_be_visible()
    refresh(page, REVIEWS); ready(page)
    expect(purchase(page).get_by_text("Authorized · not a payment receipt", exact=True)).to_be_visible()
    checks.check("Authorized historical review exposes no fresh signing action", purchase(page).get_by_role("button", name=re.compile("Sign both mandates")).count() == 0)
    # 10. Exact signer revocation; the prior authorizations remain visible.
    removal = root(page).get_by_role("button", name="Review removal of signer " + new_signer["credentialId"], exact=True)
    removal.click(); expect(root(page).get_by_role("button", name="Keep signer", exact=True)).to_be_focused()
    root(page).get_by_role("button", name="Keep signer", exact=True).click(); expect(removal).to_be_focused()
    removal.click()
    revoked = {key: value for key, value in new_signer.items() if key != "credentialSha256"}; revoked.update(state="revoked", lifecycleRevision=2, revokedAt=STAMP); revoked = bound(revoked, "credentialSha256")
    fixture.effect("DELETE", SIGNERS, {"credentialId": new_signer["credentialId"]}, {"credential": revoked}, hold="revocation-result")
    root(page).get_by_role("button", name="Confirm revoke signer", exact=True).click()
    until(page, lambda: "revocation-result" in fixture.held, "Revocation result held")
    expect(register(page)).to_be_disabled()
    fixture.signers[1] = revoked; fixture.release("revocation-result")
    expect(root(page).get_by_role("heading", name="Signer revocation confirmed", exact=True)).to_be_visible(); ready(page)
    checks.check("Revocation receipt preserves full credential and authorization boundary", "Revocation does not undo earlier authorizations" in root(page).inner_text() and purchase(page).get_by_text("Authorized · not a payment receipt", exact=True).count() == 1)


def disposed_options(page, fixture, checks):
    # 11. Dispose before a held options receipt returns. It must never start a device call.
    value = fixture.reviews[1]
    fixture.effect("POST", auth_path(REVIEW_B), {"action": "options"}, fixture.options(value), hold="disposed-options")
    count = len(device_starts(fixture))
    confirm(page, REVIEW_B).click(); until(page, lambda: "disposed-options" in fixture.held, "Disposed options held")
    navigate(page, fixture.origin, "/app/payments?owner-lifecycle=remounted"); ready(page)
    fixture.release("disposed-options"); settle(page)
    checks.check("Late options after disposal cannot start a new authenticator or completion", len(device_starts(fixture)) == count and len(fixture.writes) == 11)


def exercise(browser, origin, credentials, checks, coarse):
    name = "phone" if coarse else "desktop"
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900}, has_touch=coarse, service_workers="block", reduced_motion="reduce")
    page, fixture, errors = None, None, []
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(name + ": isolated real synthetic login", login.ok)
        fixture = PaymentFixtures(origin, context.request.get(origin + "/api/auth/session").json()); fixture.mode = "error"
        context.route("**/*", fixture.route)
        context.expose_binding("__recordPaymentBoundary", lambda source, event: fixture.unexpected.append(event))
        context.expose_binding("__recordPaymentDevice", lambda source, event: fixture.devices.append(event))
        context.add_init_script(DEVICE_GUARD)
        if coarse: context.add_init_script("Object.defineProperty(window,'PublicKeyCredential',{configurable:true,value:undefined});")
        page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup_event"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download_event"}), download.cancel()))
        navigate(page, origin, "/app/payments")
        inspect_reads(page, fixture, checks, coarse)
        if not coarse: exact_effects(page, fixture, checks)
        for theme in ("light", "dark"):
            select_theme(page, theme, coarse)
            capture(page, checks, f"payments-{name}-{theme}-signers", coarse, root(page).get_by_role("heading", name="Registered signers", exact=True))
            capture(page, checks, f"payments-{name}-{theme}-terms", coarse, purchase(page).get_by_role("heading", name="Synthetic merchant A", exact=True), axe=False)
            capture(page, checks, f"payments-{name}-{theme}-constraints", coarse, purchase(page).get_by_role("region", name="Payment constraints for review " + REVIEW_A, exact=True), axe=False)
        if coarse:
            page.set_viewport_size({"width": 320, "height": 812})
            for theme in ("light", "dark"):
                select_theme(page, theme, True); capture(page, checks, "payments-320-" + theme, True, purchase(page))
        before = root(page).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
        page.evaluate("document.documentElement.style.fontSize='200%'"); settle(page)
        # Wait for the rem-based workspace style to be recalculated before
        # measuring reflow. Two animation frames can precede this style update
        # on the hosted Chromium runner after the theme/axe sequence.
        expect(root(page)).to_have_css("font-size", f"{before * 2:g}px", timeout=10_000)
        after = root(page).evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")
        checks.check(name + ": reading text actually doubles", after >= before * 1.99, {"before": before, "after": after})
        capture(page, checks, "payments-" + name + "-text-200", coarse, purchase(page), axe=False)
        page.evaluate("document.documentElement.style.fontSize=''"); settle(page)
        page.emulate_media(forced_colors="active")
        capture(page, checks, "payments-" + name + "-forced-colors", coarse, root(page).get_by_role("heading", name="Registered signers", exact=True), axe=False)
        page.emulate_media(forced_colors="none")
        checks.check(name + ": reduced motion and no ongoing presentation animation", page.evaluate("matchMedia('(prefers-reduced-motion:reduce)').matches") and root(page).locator("*").evaluate_all("els=>els.every(el=>[getComputedStyle(el).animationDuration,getComputedStyle(el).transitionDuration].every(v=>v.split(',').every(p=>parseFloat(p)<=0.00001)))"))
        if not coarse: disposed_options(page, fixture, checks)
        fixture.mode = "empty"; navigate(page, origin, "/app/payments?read=empty"); ready(page)
        expect(root(page).get_by_text("No payment signers were returned.", exact=True)).to_be_visible()
        expect(root(page).get_by_text("No AP2 checkout review was returned. Reviews require a verified merchant adapter.", exact=True)).to_be_visible()
        checks.check(name + ": empty success differs from unavailable", "0 active in the 0-signer window" in root(page).inner_text() and "0 pending in the 0-review window" in root(page).inner_text())
        checks.check(name + ": exact mocked request budget", len(fixture.writes) == (0 if coarse else 11) and not fixture.effects, fixture.writes)
        checks.check(name + ": exact synthetic authenticator budget", len(device_starts(fixture)) == (0 if coarse else 5), fixture.devices)
        checks.check(name + ": no pending synthetic device or request plans", page.evaluate("window.__paymentDevicePending.size===0&&window.__paymentDevicePlans.length===0") and not fixture.held)
        checks.check(name + ": no unexpected writes, external requests, physical devices, media, popup or download", not fixture.unexpected, fixture.unexpected)
        checks.check(name + ": no uncaught browser errors", not errors, errors)
        return {"viewport": name, "reads": fixture.requests, "syntheticRequests": fixture.writes, "syntheticWebAuthnCalls": fixture.devices, "heldDispositions": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / (name + "-failure.png")), full_page=False)
            (checks.output / (name + "-failure-dom.html")).write_text(page.content())
        if fixture is not None: (checks.output / (name + "-failure-requests.json")).write_text(json.dumps({"reads": fixture.requests, "writes": fixture.writes, "devices": fixture.devices, "held": list(fixture.held), "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        try:
            if page is not None and not page.is_closed(): page.evaluate("window.__settlePaymentDevices?.()")
        finally:
            try:
                if fixture is not None: fixture.abort_held()
                if page is not None and not page.is_closed(): page.goto("about:blank")
            finally: context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/payments")
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
        failure = str(error); print(f"Payments browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts, "failure": failure,
            "boundary": "Actual Payments route with real isolated synthetic login. Eleven exact desktop requests are fulfilled locally: five mandate-options POSTs, two mandate-authorization POSTs, two registration POSTs, one registration PUT and one signer DELETE. Zero phone effects. See per-request methods/paths/bodies for exact budget. Five synthetic navigator.credentials calls total; no browser authenticator, physical key, signature verification, provider, checkout, settlement or payment execution. Phone injects unsupported WebAuthn before app code. No idempotency header is invented. Held routes and synthetic device promises settle or abort before context close. Page-wide axe and viewport screenshots; scope does not establish backend signer-policy filtering, real attestation trust, cross-client concurrency or device acceptance."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__": raise SystemExit(main())
