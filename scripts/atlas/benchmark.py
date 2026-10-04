#!/usr/bin/env python3
"""Bounded local delivery comparison and lifecycle checks. No app routes or effects."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import platform
from pathlib import Path
import sys

from export import bind_network, digest
from serve import PRODUCTION, REPO, running_server


def distribution(values: list[float]) -> dict:
    ordered = sorted(value for value in values if math.isfinite(value))
    if not ordered:
        return {'count': 0, 'p50': None, 'p95': None, 'max': None}
    return {'count': len(ordered), 'p50': ordered[math.ceil(len(ordered) * .5) - 1], 'p95': ordered[math.ceil(len(ordered) * .95) - 1], 'max': ordered[-1]}


def settle(page) -> dict:
    page.wait_for_function('() => window.atlas && window.atlas.metrics().status !== "loading"', timeout=30000)
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    return page.evaluate('window.atlas.metrics()')


def control_check(page) -> bool:
    before = page.evaluate('window.atlas.metrics().counter')
    page.locator('#independent').click()
    page.wait_for_timeout(100)
    return page.evaluate('window.atlas.metrics().counter') == before + 1


def lifecycle(context, page, origin: str) -> dict:
    result = {}
    page.goto(f'{origin}/?mode=glb&size=256&theme=light', wait_until='networkidle')
    result['assetReady'] = settle(page)['status'] == 'ready'
    if not result['assetReady']:
        return result
    idle = page.evaluate('window.atlas.metrics().frameCount')
    page.wait_for_timeout(200)
    result['idleStopsRendering'] = page.evaluate('window.atlas.metrics().frameCount') == idle
    page.locator('[data-clip="quick_reaction"]').click()
    page.wait_for_timeout(120)
    page.locator('#interrupt').click()
    stopped = page.evaluate('window.atlas.metrics()')
    page.wait_for_timeout(200)
    result['interruptStopsImmediately'] = not stopped['loopRunning'] and page.evaluate('window.atlas.metrics().frameCount') == stopped['frameCount']
    result['controlAfterInterrupt'] = control_check(page)
    page.emulate_media(reduced_motion='reduce')
    page.locator('[data-clip="quick_reaction"]').click()
    result['osReducedFloor'] = page.evaluate('window.atlas.metrics().gate.reduced && !window.atlas.metrics().loopRunning')
    result['controlWithReducedMotion'] = control_check(page)
    page.emulate_media(reduced_motion='no-preference')
    page.locator('[data-clip="quick_reaction"]').click()
    page.evaluate('document.querySelector("#stage").style.transform="translateY(5000px)"')
    page.wait_for_function('() => !window.atlas.metrics().gate.onscreen', timeout=5000)
    offscreen = page.evaluate('window.atlas.metrics()')
    page.wait_for_timeout(150)
    result['offscreenStops'] = not offscreen['loopRunning'] and page.evaluate('window.atlas.metrics().frameCount') == offscreen['frameCount']
    page.evaluate('document.querySelector("#stage").style.transform=""')
    page.wait_for_function('() => window.atlas.metrics().gate.onscreen', timeout=5000)
    result['onscreenDoesNotRestartClip'] = not page.evaluate('window.atlas.metrics().loopRunning')
    # Headless engines do not all transition visibility when a second tab is foreground.
    page.locator('[data-clip="speech_test"]').click()
    other = context.new_page()
    other.goto(f'{origin}/?mode=poster&hidden=1', wait_until='domcontentloaded')
    other.bring_to_front()
    page.wait_for_timeout(150)
    hidden = page.evaluate('window.atlas.metrics()')
    result['hiddenTab'] = {'observed': hidden['visibility'] == 'hidden', 'stopped': not hidden['loopRunning'] if hidden['visibility'] == 'hidden' else None, 'limitation': None if hidden['visibility'] == 'hidden' else 'This headless backend did not expose a real hidden document. Test on a visible browser/device separately.'}
    other.close()
    page.bring_to_front()
    page.locator('#hide-character').check()
    result['hiddenCharacterDisposes'] = page.evaluate('window.atlas.metrics().status === "hidden" && !window.atlas.metrics().loopRunning')
    result['controlWhileHidden'] = control_check(page)
    page.locator('#hide-character').uncheck()
    result['explicitShowReloads'] = settle(page)['status'] == 'ready'
    page.locator('[data-clip="speech_test"]').click()
    page.locator('#dispose').click()
    result['disposeStops'] = page.evaluate('window.atlas.metrics().status === "disposed" && !window.atlas.metrics().loopRunning && window.atlas.metrics().gate.disposed')
    result['controlAfterDisposal'] = control_check(page)
    # One exact local asset failure, never an application/provider request.
    page.route('**/output/atlas-rough.glb', lambda route: route.abort())
    page.goto(f'{origin}/?mode=glb&size=36', wait_until='networkidle')
    failed = settle(page)
    result['failedAssetTruth'] = failed['status'] == 'failed' and bool(failed['error'])
    result['controlAfterAssetFailure'] = control_check(page)
    result['failedAssetStableGeometry'] = page.locator('#stage').evaluate('(node) => { const r=node.getBoundingClientRect(); return r.width===36 && r.height===36; }')
    page.unroute('**/output/atlas-rough.glb')
    # Hold the actual GLB response, dispose, then deliver it. The old load cannot revive UI.
    pending = []
    page.route('**/output/atlas-rough.glb', lambda route: pending.append(route))
    page.goto(f'{origin}/?mode=glb', wait_until='domcontentloaded')
    page.wait_for_function('() => window.atlas && window.atlas.metrics().status === "loading"')
    for _ in range(100):
        if pending:
            break
        page.wait_for_timeout(20)
    if not pending:
        result['lateLoadRemainsDisposed'] = False
    else:
        page.locator('#dispose').click()
        for route in pending:
            try:
                route.fulfill(status=200, content_type='model/gltf-binary', body=(PRODUCTION / 'output/atlas-rough.glb').read_bytes())
            except Exception:
                # AbortController may already have terminated it; both paths must stay disposed.
                pass
        page.wait_for_timeout(200)
        result['lateLoadRemainsDisposed'] = page.evaluate('window.atlas.metrics().status === "disposed" && !window.atlas.metrics().loopRunning')
    page.unroute('**/output/atlas-rough.glb')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-executable', type=Path)
    parser.add_argument('--repeats', type=int, choices=range(1, 6), default=3)
    parser.add_argument('--dpr', type=int, choices=(1, 2), nargs='+', default=[1])
    parser.add_argument('--theme', choices=('light', 'dark'), default='light')
    parser.add_argument('--output', type=Path, default=PRODUCTION / 'output/benchmark.json')
    args = parser.parse_args()
    manifest = PRODUCTION / 'output/export-manifest.json'
    if not manifest.is_file():
        raise SystemExit('Run the explicit rough export first. No raster substitute is measured.')
    provenance = json.loads(manifest.read_text())
    for source in provenance['sources']:
        path = (REPO / source['path']).resolve()
        if not path.is_relative_to(REPO.resolve()) or not path.is_file() or digest(path) != source['sha256']:
            raise SystemExit(f'Source changed since export: {source["path"]}. Re-export before comparing delivery evidence.')
    for artifact in provenance['artifacts']:
        path = (PRODUCTION / artifact['path']).resolve()
        if not path.is_relative_to(PRODUCTION.resolve()) or not path.is_file() or digest(path) != artifact['sha256']:
            raise SystemExit(f'Export artifact changed: {artifact["path"]}. Re-export or explicitly review provenance.')
    from playwright.sync_api import sync_playwright
    cases, rejected, errors = [], [], []
    launch = {'headless': True}
    if args.chromium_executable:
        launch['executable_path'] = str(args.chromium_executable.resolve())
    with running_server() as origin, sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch)
        try:
            for mode in ('poster', 'glb', 'sequence'):
                for size in (36, 256):
                    for ratio in dict.fromkeys(args.dpr):
                        for repeat in range(args.repeats):
                            context = browser.new_context(viewport={'width': 1280, 'height': 1600}, device_scale_factor=ratio, reduced_motion='no-preference', service_workers='block')
                            bind_network(context, origin, rejected)
                            page = context.new_page()
                            page.on('pageerror', lambda error: errors.append(str(error)))
                            page.goto(f'{origin}/?mode={mode}&size={size}&dpr={ratio}&theme={args.theme}', wait_until='networkidle')
                            initial = settle(page)
                            if initial['status'] == 'ready' and mode != 'poster':
                                page.locator('[data-clip="quick_reaction"]').click()
                                page.wait_for_timeout(1150)
                            control = control_check(page)
                            measured = page.evaluate('window.atlas.metrics()')
                            frame_count = measured['frameCount']
                            page.wait_for_timeout(150)
                            idle = page.evaluate('window.atlas.metrics().frameCount') == frame_count
                            motion_observed = len(measured['rafIntervalsMs']) == 0 if mode == 'poster' else len(measured['rafIntervalsMs']) > 1
                            row = {'mode': mode, 'sizeCssPx': size, 'pixelRatio': ratio, 'theme': args.theme, 'repeat': repeat + 1, 'context': 'fresh isolated context; HTTP cache disabled by network guard', 'controlWorks': control, 'idleStable': idle, 'expectedMotionObserved': motion_observed, 'measurements': measured, 'summary': {name: distribution(measured[name]) for name in ('cpuSubmitMs', 'frameWorkMs', 'rafIntervalsMs', 'interactionPaintMs')}}
                            row['summary']['encodedResourceBytes'] = sum(entry['encodedBodySize'] for entry in measured['resourceEntries'])
                            row['summary']['transferBytesIncludingHeaders'] = sum(entry['transferSize'] for entry in measured['resourceEntries'])
                            cases.append(row)
                            context.close()
            context = browser.new_context(viewport={'width': 1280, 'height': 1600}, device_scale_factor=1, reduced_motion='no-preference', service_workers='block')
            bind_network(context, origin, rejected)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            checks = lifecycle(context, page, origin)
            user_agent = page.evaluate('navigator.userAgent')
            context.close()
            failures = [key for key, value in checks.items() if value is False]
            hidden = checks.get('hiddenTab', {})
            if hidden.get('observed') and not hidden.get('stopped'):
                failures.append('hiddenTab')
            failures.extend(f'case-{index + 1}' for index, case in enumerate(cases) if case['measurements']['status'] != 'ready' or not case['controlWorks'] or not case['idleStable'] or not case['expectedMotionObserved'])
            if rejected:
                failures.append('unexpectedRequests')
            if errors:
                failures.append('pageErrors')
            record = {
                'schemaVersion': 1, 'status': 'LOCAL_LAB_CAPTURED' if not failures else 'LOCAL_LAB_CHECK_FAILED',
                'capturedAtUtc': datetime.now(timezone.utc).isoformat(), 'rough': True,
                'exportManifestSha256': digest(manifest), 'runtime': {'headless': True, 'chromiumVersion': browser.version, 'userAgent': user_agent, 'hostPlatform': platform.platform(), 'pythonVersion': platform.python_version(), 'viewport': {'width': 1280, 'height': 1600}, 'server': 'loopback HTTP, uncompressed, exact GET-only network guard'},
                'cases': cases, 'lifecycle': checks, 'failures': failures, 'rejectedRequests': rejected, 'pageErrors': errors,
                'comparison': 'Generated still versus the exported GLB versus its 19-frame WebP reaction sequence. All cases use the same rough construction and portrait framing. Generated still/frame pixels are 256px assets even at a 36px CSS slot.',
                'unmeasured': ['Actual GPU execution time and GPU memory', 'Warm HTTP cache and production compressed transfer', 'Deployed Next route bundle and field Core Web Vitals', 'iOS/Android/native integration and device startup', 'Target-device sustained frame pacing, battery and thermal cost', 'Artistic fidelity, personality approval and final eight-state rig'],
                'limits': ['No pass/fail production performance thresholds are invented by this lab.', 'CPU submit timing excludes asynchronous GPU execution; frameWork includes sampled skeletal update and submission.', 'The interaction metric is a two-rAF handler-to-paint proxy, not INP.', 'Decoded RGBA estimates are width × height × 4, not measured allocation or residency.', 'Headless visibility may be unavailable and is reported separately, not silently passed.'],
            }
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(record, indent=2) + '\n')
            print(json.dumps({'status': record['status'], 'cases': len(cases), 'failures': failures, 'output': str(args.output)}, indent=2))
            if failures:
                sys.exit(1)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
