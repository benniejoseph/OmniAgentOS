#!/usr/bin/env python3
"""Measure actual HELD01 production component delivery on an isolated loopback fixture."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import itertools
import json
import math
from pathlib import Path
import platform
import sys
import time
from urllib.parse import urlencode, urlsplit

from production_measurement_server import ASSET_ROOT, MANIFEST_SHA256, MODES, digest, verified_build

SCALE_CONTEXT = {36: "Actual compact Assistant CSS slot size; isolated fixture layout",
                 64: "Actual mobile Voice CSS slot size; desktop lab viewport, not mobile-device evidence",
                 72: "Accepted art comparison/static greeting scale; motion here is a lab comparison",
                 108: "Actual desktop Voice CSS slot size; isolated fixture without real audio",
                 256: "Authored raster/comparison scale; not a current live app slot"}


INIT = """(() => {
  const result = {posters:[], effects:[], intersectionObserved:false};
  window.__atlasProbe = result;
  const seen = new Set();
  const capture = () => {
    const stage = document.querySelector('#stage');
    const img = stage?.querySelector('[data-atlas-poster] img');
    if (stage?.dataset.preferences !== 'ready' || !img?.complete || !img.naturalWidth) return;
    const source = new URL(img.currentSrc || img.src, location.href).pathname;
    if (!seen.has(source)) {
      seen.add(source);
      result.posters.push({source, observedAtMs:performance.now(), naturalWidth:img.naturalWidth,
        naturalHeight:img.naturalHeight});
    }
  };
  new MutationObserver(capture).observe(document, {subtree:true, childList:true, attributes:true,
    attributeFilter:['data-preferences','src']});
  document.addEventListener('load', capture, true);
  const refuse = kind => {result.effects.push(kind); throw new Error('Measurement refused '+kind);};
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => refuse('microphone');
  HTMLMediaElement.prototype.play = async () => refuse('media playback');
  window.open = () => refuse('popup');
  if (window.AudioContext) window.AudioContext = function(){return refuse('AudioContext');};
  if (window.webkitAudioContext) window.webkitAudioContext = function(){return refuse('webkitAudioContext');};
  if (window.RTCPeerConnection) window.RTCPeerConnection = function(){return refuse('WebRTC');};
})();"""

SNAPSHOT = """() => {
  const stage=document.querySelector('#stage');
  const image=stage.querySelector('[data-atlas-poster] img');
  const box=stage.getBoundingClientRect();
  const sprite=stage.querySelector('[data-atlas-sprite]');
  return {measurement:window.__atlasMeasurement, probe:window.__atlasProbe,
    endAtMs:performance.now(), documentVisibility:document.visibilityState,
    geometry:{width:box.width,height:box.height}, devicePixelRatio,
    preferences:stage.dataset.preferences, motion:stage.dataset.motion, state:stage.dataset.state,
    poster:{path:new URL(image.currentSrc||image.src,location.href).pathname,
      naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight},
    spriteAtEnd:{display:sprite.style.display,image:sprite.style.backgroundImage},
    controlCount:Number(document.querySelector('#counter').textContent),
    navigation:performance.getEntriesByType('navigation').map(row=>row.toJSON()),
    resources:performance.getEntriesByType('resource').map(row=>{
      const item=row.toJSON();item.name=new URL(row.name).pathname+new URL(row.name).search;return item;
    })};
}"""


def distribution(values: list[float]) -> dict:
    ordered = sorted(value for value in values if isinstance(value, (int, float)) and math.isfinite(value))
    return {"count": len(ordered), "p50": ordered[math.ceil(len(ordered) * .5) - 1] if ordered else None,
            "p95": ordered[math.ceil(len(ordered) * .95) - 1] if ordered else None,
            "max": ordered[-1] if ordered else None}


def wait_observed(page, predicate: str, label: str, *, arg=None, timeout_ms=30_000):
    """Explicit protocol evaluation avoids wait_for_function's CSP-blocked eval."""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        if page.evaluate(predicate, arg):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Observation timed out after {timeout_ms} ms: {label}")
        page.wait_for_timeout(min(50, remaining * 1000))


def summarize(raw: dict, initial_path: str, target_path: str) -> dict:
    measure, probe = raw["measurement"], raw["probe"]
    trigger = measure["trigger"]["handlerAtMs"]
    advances = [row for row in measure["styles"] if row["atMs"] >= trigger and row["display"] == "block" and row["image"] != "none"]
    positions = []
    for row in advances:
        if not positions or row["position"] != positions[-1]["position"]:
            positions.append(row)
    endings = [row for row in measure["styles"] if advances and row["atMs"] > advances[0]["atMs"] and row["display"] == "none"]
    initial = next((row["observedAtMs"] for row in probe["posters"] if row["source"] == initial_path), None)
    target = next((row["observedAtMs"] for row in probe["posters"] if row["source"] == target_path and row["observedAtMs"] >= trigger), None)
    resources = raw["resources"]
    asset_resources = [row for row in resources if row["name"].startswith("/companion/")]
    return {"initialPosterObservedReadyMsFromNavigation": initial,
            "targetPosterObservedReadyMsFromTransition": target - trigger if target is not None else None,
            "firstSpriteStyleMsFromTransition": advances[0]["atMs"] - trigger if advances else None,
            "observedSpriteVisibleWindowMs": endings[0]["atMs"] - advances[0]["atMs"] if endings else None,
            "observedDistinctSpritePositions": len(positions),
            "observedPositionIntervalMs": distribution([right["atMs"] - left["atMs"] for left, right in zip(positions, positions[1:])]),
            "controlHandlerToSecondRafMs": [row["secondRafAtMs"] - row["handlerAtMs"] for row in measure["controls"] if row["secondRafAtMs"] is not None],
            "controlEventToHandlerMs": [row["handlerAtMs"] - row["eventTimestampMs"] for row in measure["controls"]],
            "assetResourceEntries": len(asset_resources),
            "assetEncodedBodyBytes": sum(row["encodedBodySize"] for row in asset_resources),
            "assetTransferBytesIncludingHeaders": sum(row["transferSize"] for row in asset_resources)}


def run_case(browser, origin, config, output, manifest):
    mode, theme, size, dpr, repeat = config
    label = f"{mode}-{theme}-{size}-dpr{dpr}-r{repeat}"
    context = browser.new_context(viewport={"width": 1000, "height": 900}, device_scale_factor=dpr,
                                  reduced_motion="no-preference", service_workers="block")
    failures, requests, rejected, browser_errors, http_errors = [], [], [], [], []
    allowed = {"/case", "/player.js", "/api/companion/preferences", ASSET_ROOT + "manifest.json",
               "/companion/atlas-neutral.png"}
    allowed.update(ASSET_ROOT + values[kind] for clip in manifest["states"].values()
                   for theme_name in ("light", "dark") for values in (clip[theme_name],)
                   for kind in ("poster", "sprite"))

    def route(request_route):
        request = request_route.request
        parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != origin or request.method != "GET" or parsed.path not in allowed:
            rejected.append({"method": request.method, "origin": f"{parsed.scheme}://{parsed.netloc}", "path": parsed.path})
            request_route.abort()
        else:
            requests.append({"path": parsed.path, "query": parsed.query, "method": request.method})
            request_route.continue_()

    context.route("**/*", route)  # Playwright routing disables the browser HTTP cache.
    context.add_init_script(INIT)
    page = context.new_page()
    page.on("pageerror", lambda error: browser_errors.append(str(error)))
    page.on("response", lambda response: http_errors.append({"status": response.status, "path": urlsplit(response.url).path}) if response.status >= 400 else None)
    page.on("popup", lambda popup: (rejected.append({"kind": "popup"}), popup.close()))
    page.on("download", lambda download: (rejected.append({"kind": "download"}), download.cancel()))
    started = datetime.now(timezone.utc).isoformat()
    try:
        page.goto(origin + "/case?" + urlencode({"mode": mode, "theme": theme, "size": size}), wait_until="networkidle", timeout=30_000)
        initial = "/companion/atlas-neutral.png" if mode == "neutral" else ASSET_ROOT + manifest["states"]["available"][theme]["poster"]
        target = "/companion/atlas-neutral.png" if mode == "neutral" else ASSET_ROOT + manifest["states"]["working"][theme]["poster"]
        wait_observed(page, """expected => {
          const stage=document.querySelector('#stage');const image=stage?.querySelector('[data-atlas-poster] img');
          return stage?.dataset.preferences==='ready' && stage.dataset.portrait==='true' && image?.complete &&
            image.naturalWidth>0 && new URL(image.currentSrc||image.src,location.href).pathname===expected;
        }""", "initial ready portrait", arg=initial)
        # Witness real intersection after production's own observer is mounted. No fake visibility.
        page.evaluate("""() => new Promise((resolve, reject) => {
          const timeout=setTimeout(()=>{observer.disconnect();reject(new Error('Visible intersection was not observed'));},5000);
          const observer=new IntersectionObserver(entries=>{
            if(entries.some(entry=>entry.isIntersecting)){window.__atlasProbe.intersectionObserved=true;observer.disconnect();
              clearTimeout(timeout);
              requestAnimationFrame(()=>requestAnimationFrame(resolve));}
          });observer.observe(document.querySelector('#stage'));
        })""")
        page.locator("#transition").click()
        observation_start = page.evaluate("() => window.__atlasMeasurement.trigger.handlerAtMs")
        if mode == "motion":
            wait_observed(page, "() => document.querySelector('[data-atlas-sprite]')?.style.display === 'block'",
                          "visible sprite admission", timeout_ms=5000)
            observation_start = page.evaluate("""() => window.__atlasMeasurement.styles.find(row =>
              row.atMs >= window.__atlasMeasurement.trigger.handlerAtMs && row.display === 'block'
              && row.image !== 'none').atMs""")
        else:
            wait_observed(page, "() => document.querySelector('#stage')?.dataset.state === 'working'",
                          "synthetic working presentation")
        page.locator("#independent").click()
        wait_observed(page, "() => typeof window.__atlasMeasurement.controls[0]?.secondRafAtMs === 'number'",
                      "independent control second animation callback")
        remaining = page.evaluate("end => Math.max(0, end - performance.now())", observation_start + 1600)
        page.wait_for_timeout(remaining)  # No rAF or page-timer polling throughout the sample window.
        # A valid slow asset admission is not a finite-playback failure. Lazy poster
        # loading may wait for sprite completion; retain its observed latency separately.
        wait_observed(page, """expected => {
          const image=document.querySelector('[data-atlas-poster] img');
          return image?.complete && image.naturalWidth>0 && new URL(image.currentSrc||image.src,location.href).pathname===expected;
        }""", "loaded target portrait", arg=target, timeout_ms=15_000)
        raw = page.evaluate(SNAPSHOT)
        raw["observationWindow"] = {"startAtMs": observation_start, "minimumDurationMs": 1600,
                                    "anchor": "first-observed-sprite-admission" if mode == "motion" else "transition-handler"}
        summary = summarize(raw, initial, target)
        sprite_reads = [row for row in requests if row["path"].endswith("-sprite.webp")]
        checks = {
            "realIntersection": raw["probe"]["intersectionObserved"],
            "visibleDocument": raw["documentVisibility"] == "visible",
            "requestedGeometry": raw["geometry"] == {"width": size, "height": size} and raw["devicePixelRatio"] == dpr,
            "readyPreferences": raw["preferences"] == "ready",
            "motionPreference": raw["motion"] == ("full" if mode == "motion" else "off"),
            "initialPosterObserved": summary["initialPosterObservedReadyMsFromNavigation"] is not None,
            "targetPoster": raw["poster"]["path"] == target and raw["poster"]["naturalWidth"] == (108 if mode == "neutral" else 256),
            "independentControl": raw["controlCount"] == 1 and len(summary["controlHandlerToSecondRafMs"]) == 1,
            "controlDuringIntendedMode": raw["measurement"]["controls"][0]["spriteVisibleAtHandler"] == (mode == "motion"),
            "finiteSprite": raw["spriteAtEnd"] == {"display": "none", "image": "none"} if mode == "motion" else raw["spriteAtEnd"]["display"] == "none",
            "intendedSpriteOnly": bool(sprite_reads) and all(row["path"] == ASSET_ROOT + manifest["states"]["working"][theme]["sprite"] for row in sprite_reads) if mode == "motion" else not sprite_reads,
            "observedMotion": summary["observedDistinctSpritePositions"] >= 2 if mode == "motion" else summary["observedDistinctSpritePositions"] == 0,
            "noEffectsOrUnexpectedRequests": not raw["probe"]["effects"] and not rejected,
            "noBrowserOrHttpErrors": not browser_errors and not http_errors,
        }
        failures = [name for name, passed in checks.items() if not passed]
        screenshot = None
        if repeat == 1:
            screenshot_bytes = page.screenshot(path=str(output / (label + ".png")))
            screenshot = {"path": label + ".png", "sha256": digest(screenshot_bytes)}
        result = {"case": label, "startedAt": started, "configuration": {"mode": mode, "theme": theme, "sizeCssPx": size, "scaleContext": SCALE_CONTEXT[size], "dpr": dpr, "repeat": repeat},
                  "passed": not failures, "checks": checks, "summary": summary, "raw": raw,
                  "requests": requests, "rejected": rejected, "browserErrors": browser_errors, "httpErrors": http_errors,
                  "screenshot": screenshot}
    except Exception as error:
        result = {"case": label, "startedAt": started, "passed": False, "error": str(error),
                  "requests": requests, "rejected": rejected, "browserErrors": browser_errors, "httpErrors": http_errors}
    finally:
        context.close()
    with (output / (label + ".json")).open("x") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--origin", required=True, help="Existing matching loopback fixture server, e.g. http://127.0.0.1:8766")
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory; never overwritten")
    parser.add_argument("--chromium-executable", type=Path)
    parser.add_argument("--repeats", type=int, choices=range(1, 4), default=3)
    parser.add_argument("--sizes", type=int, choices=tuple(SCALE_CONTEXT), nargs="+", default=[72, 256])
    args = parser.parse_args()
    sizes = list(dict.fromkeys(args.sizes))
    parsed = urlsplit(args.origin)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        parser.error("--origin must be an exact HTTP 127.0.0.1 origin with an explicit port.")
    record, files, build_sha = verified_build(args.bundle_dir)
    manifest = json.loads(files[ASSET_ROOT + "manifest.json"])
    args.output.mkdir(parents=False, exist_ok=False)
    from playwright.sync_api import sync_playwright
    cases = []
    with sync_playwright() as playwright:
        options = {"headless": True}
        if args.chromium_executable:
            options["executable_path"] = str(args.chromium_executable.resolve())
        browser = playwright.chromium.launch(**options)
        try:
            identity_context = browser.new_context(service_workers="block")
            try:
                response = identity_context.request.get(args.origin + "/__measurement__/identity", max_redirects=0)
                if not response.ok or response.json() != {"buildSha256": build_sha, "source": record["source"], "manifestSha256": MANIFEST_SHA256}:
                    raise ValueError("Fixture server does not match the exact measured build.")
            finally:
                identity_context.close()
            browser_version = browser.version
            gpu = {"status": "unobserved"}
            try:
                session = browser.new_browser_cdp_session()
                info = session.send("SystemInfo.getInfo")
                gpu = {"status": "reported-by-browser", "devices": info["gpu"]["devices"],
                       "featureStatus": info["gpu"].get("featureStatus"),
                       "auxAttributes": info["gpu"].get("auxAttributes")}
                session.detach()
            except Exception:
                pass  # Missing protocol metadata is not evidence of a renderer/GPU configuration.
            configurations = []
            for theme, size, dpr, repeat in itertools.product(("light", "dark"), sizes, (1, 2), range(1, args.repeats + 1)):
                start = (repeat - 1) % len(MODES)
                configurations.extend((mode, theme, size, dpr, repeat) for mode in MODES[start:] + MODES[:start])
            for config in configurations:
                result = run_case(browser, args.origin, config, args.output, manifest)
                cases.append(result)
                print(f"{'PASS' if result['passed'] else 'FAIL'} {result['case']}", flush=True)
                if not result["passed"]:
                    break  # Do not produce a large misleading timing set after fixture failure.
        finally:
            browser.close()
    verified_build(args.bundle_dir)  # Reject source/artifact changes during the run.
    expected = 3 * 2 * len(sizes) * 2 * args.repeats
    receipt = {"schemaVersion": 1, "kind": "atlas-production-component-measurements", "createdAt": datetime.now(timezone.utc).isoformat(),
               "passed": len(cases) == expected and all(row["passed"] for row in cases),
               "expectedCases": expected, "completedCases": len(cases), "buildSha256": build_sha, "build": record,
               "environment": {"python": sys.version, "playwright": version("playwright"), "browser": browser_version,
                               "browserExecutable": str(args.chromium_executable) if args.chromium_executable else "Playwright bundled Chromium",
                               "os": platform.platform(), "machine": platform.machine(), "headless": True,
                               "gpuRenderer": gpu,
                               "http": "uncompressed loopback; new browser context per case; Playwright interception disables HTTP cache; OS/filesystem/decoded/GPU caches are not claimed cold",
                               "caseOrder": "Within each theme/size/DPR, interleave variants and rotate their order each repetition; serial, no warmup exclusion",
                               "layout": "Isolated component at selected CSS scales; not real app layouts or physical devices",
                               "scales": {size: SCALE_CONTEXT[size] for size in sizes}},
               "claims": {"scope": "Production React component and actual preference hook/next-image; synthetic available-to-working display only; exact shipped HELD01 assets",
                          "timing": "Observed poster readiness and DOM sprite advances; control event/handler-to-second-rAF lab proxies. Not presented FPS, GPU time, isolated decode cost, field INP or a sustained soak.",
                          "instrumentation": "MutationObserver plus two rAF callbacks after an independent control; no continuous rAF measurement loop or player timer patch.",
                          "unobserved": ["physical device", "energy/thermal/battery", "memory reclamation", "real hidden-document transition", "native renderer", "live 3D", "all-state motion performance", "production route performance"]},
               "routeCosts": record["routeCosts"],
               "cases": [{"case": row["case"], "passed": row["passed"], "summary": row.get("summary"),
                          "sha256": digest((args.output / (row["case"] + ".json")).read_bytes())} for row in cases]}
    with (args.output / "measurement.json").open("x") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
    raise SystemExit(0 if receipt["passed"] else 1)


if __name__ == "__main__":
    main()
