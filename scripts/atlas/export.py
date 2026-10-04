#!/usr/bin/env python3
"""Render/export the rough model locally. No installation, app writes or browser UI."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

from serve import PRODUCTION, REPO, THREE, running_server

EXPECTED_REFERENCE = '876591c5a2b739df99d6aab647554dc53bcab97d55bf0c3e0864e39e1c98c070'
STATES = ['available', 'listening', 'responding', 'working', 'needs_you', 'blocked', 'completed', 'paused']
FRAME_SIZE = 256
FPS = 20
COLUMNS = 4


def source_paths() -> list[Path]:
    paths = [path for folder in ('source', 'web', 'sheets') for path in (PRODUCTION / folder).rglob('*') if path.is_file()]
    paths.extend(path for path in (REPO / 'scripts/atlas').iterdir() if path.is_file() and path.suffix in ('.py', '.mjs'))
    return sorted(paths)


def state_delivery(config: dict) -> dict:
    performances = config.get('statePerformances')
    revision = config.get('creativeRevision')
    if not isinstance(revision, str) or not 1 <= len(revision) <= 160 or not revision.isprintable():
        raise ValueError('A bounded creative revision is required.')
    if not isinstance(performances, dict) or set(performances) != set(STATES):
        raise ValueError('The exact eight authored state performances are required.')
    states = {}
    for state in STATES:
        duration = performances[state].get('duration')
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration):
            raise ValueError(f'Invalid duration for {state}.')
        milliseconds = round(duration * 1000)
        if abs(duration * 1000 - milliseconds) > .000001 or not 0 < milliseconds <= 1200:
            raise ValueError(f'{state} must have an integer duration between 1 and 1200ms.')
        count = math.ceil(milliseconds / 50) + 1
        if count > 25:
            raise ValueError(f'{state} exceeds the bounded frame count.')
        states[state] = {'durationMs': milliseconds, 'frameCount': count}
    return {'schemaVersion': 1, 'creativeRevision': revision, 'frameSize': FRAME_SIZE, 'fps': FPS, 'columns': COLUMNS, 'states': states}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bind_network(context, origin: str, rejected: list) -> None:
    def route_request(route):
        request = route.request
        parsed = urlsplit(request.url)
        if request.method == 'GET' and f'{parsed.scheme}://{parsed.netloc}' == origin:
            route.continue_()
        else:
            rejected.append({'method': request.method, 'url': request.url})
            route.abort()
    context.route('**/*', route_request)


def save_data_url(value: str, target: Path, mime: str) -> None:
    prefix = f'data:{mime};base64,'
    if not value.startswith(prefix):
        raise ValueError(f'Unexpected image encoding for {target.name}')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(value[len(prefix):], validate=True))


def transparent_capture(page, parameters: dict):
    # Capture the renderer's RGBA buffer, not a page screenshot or a composited
    # background. PNG keeps each sample lossless before sprite assembly.
    from PIL import Image
    value = page.evaluate('(p) => window.atlas.capture(p)', {**parameters, 'size': FRAME_SIZE, 'dpr': 1, 'format': 'image/png', 'transparent': True})
    prefix = 'data:image/png;base64,'
    if not isinstance(value, str) or not value.startswith(prefix):
        raise ValueError('Expected a transparent renderer PNG.')
    with Image.open(BytesIO(base64.b64decode(value[len(prefix):], validate=True))) as source:
        if source.size != (FRAME_SIZE, FRAME_SIZE) or 'A' not in source.getbands():
            raise ValueError('Transparent capture has incorrect dimensions or no alpha channel.')
        image = source.convert('RGBA')
    low, high = image.getchannel('A').getextrema()
    if low != 0 or high == 0:
        image.close()
        raise ValueError('Capture must contain transparent background and visible geometry.')
    return image


def export_state_delivery(page, output: Path, delivery: dict, theme: str, artifacts: list[Path]) -> None:
    from PIL import Image
    directory = output / 'atlas-v1'
    if directory.is_symlink() or not directory.resolve().is_relative_to(output.resolve()):
        raise ValueError('State exports must stay inside their fixed output directory.')
    directory.mkdir(parents=True, exist_ok=True)
    for state, row in delivery['states'].items():
        poster = directory / f'{state}-{theme}-poster.webp'
        sprite = directory / f'{state}-{theme}-sprite.webp'
        if poster.is_symlink() or sprite.is_symlink():
            raise ValueError('State export files may not be symbolic links.')
        with transparent_capture(page, {'pose': state}) as image:
            image.save(poster, format='WEBP', lossless=True, method=6)
        rows = math.ceil(row['frameCount'] / COLUMNS)
        with Image.new('RGBA', (COLUMNS * FRAME_SIZE, rows * FRAME_SIZE), (0, 0, 0, 0)) as sheet:
            for index in range(row['frameCount']):
                milliseconds = min(index * 50, row['durationMs'])
                with transparent_capture(page, {'clip': state, 'time': milliseconds / 1000}) as frame:
                    # Copy alpha rather than compositing it twice at the edges.
                    sheet.paste(frame, ((index % COLUMNS) * FRAME_SIZE, (index // COLUMNS) * FRAME_SIZE))
            sheet.save(sprite, format='WEBP', lossless=True, method=6)
        row[theme] = {'poster': poster.name, 'sprite': sprite.name, 'posterSha256': digest(poster), 'spriteSha256': digest(sprite)}
        artifacts.extend((poster, sprite))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-executable', type=Path)
    parser.add_argument('--overwrite', action='store_true', help='Replace previously generated output files in this isolated rough directory.')
    args = parser.parse_args()
    reference = REPO / '.design/asael-ace-revamp/references/atlas-selected.png'
    provenance = REPO / '.design/asael-ace-revamp/references/atlas-export.json'
    reference_metadata = json.loads(provenance.read_text())
    if digest(reference) != EXPECTED_REFERENCE or reference_metadata.get('screenSha256') != EXPECTED_REFERENCE:
        raise SystemExit('Approved concept provenance does not match. No exports written.')
    config = json.loads((PRODUCTION / 'source/model.json').read_text())
    if config.get('sourceExpectedSha256') != EXPECTED_REFERENCE:
        raise SystemExit('Model source no longer binds the approved reference.')
    delivery = state_delivery(config)
    sources = source_paths()
    source_snapshot = [{'path': str(path.relative_to(REPO)), 'sha256': digest(path)} for path in sources]
    three_version = json.loads((THREE / 'package.json').read_text())['version']
    if three_version != '0.186.0':
        raise SystemExit(f'Three.js {three_version} differs from the authored 0.186.0 baseline. Review compatibility before exporting.')
    output = PRODUCTION / 'output'
    if output.is_symlink() or not output.resolve().is_relative_to(PRODUCTION.resolve()):
        raise SystemExit('Generated output must stay within this isolated rough directory.')
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit('Output already contains files. Review them or explicitly pass --overwrite.')
    output.mkdir(parents=True, exist_ok=True)
    # Optional tooling is imported only when root explicitly runs this command.
    from playwright.sync_api import sync_playwright
    rejected, errors, artifacts = [], [], []
    launch = {'headless': True}
    if args.chromium_executable:
        launch['executable_path'] = str(args.chromium_executable.resolve())
    with running_server() as origin, sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch)
        try:
            context = browser.new_context(viewport={'width': 1280, 'height': 1400}, device_scale_factor=1, reduced_motion='no-preference', service_workers='block')
            bind_network(context, origin, rejected)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            for theme in ('light', 'dark'):
                page.goto(f'{origin}/?mode=procedural&size=256&dpr=1&theme={theme}&captureAlpha=1', wait_until='networkidle')
                page.wait_for_function('() => window.atlas && window.atlas.metrics().status !== "loading"', timeout=30000)
                if not page.evaluate('window.atlas.ready'):
                    raise RuntimeError(page.evaluate('window.atlas.metrics()'))
                if theme == 'light':
                    encoded = page.evaluate('window.atlas.exportGLB()')
                    glb = output / 'atlas-rough.glb'
                    glb.write_bytes(base64.b64decode(encoded, validate=True))
                    artifacts.append(glb)
                for view in ('front', 'three_quarter', 'profile'):
                    path = output / f'turnaround-{view}-{theme}.png'
                    value = page.evaluate('(p) => window.atlas.capture(p)', {'view': view, 'framing': 'full', 'size': 512})
                    save_data_url(value, path, 'image/png')
                    artifacts.append(path)
                for state in STATES:
                    path = output / f'state-{state}-{theme}.png'
                    value = page.evaluate('(p) => window.atlas.capture(p)', {'pose': state, 'size': 256})
                    save_data_url(value, path, 'image/png')
                    artifacts.append(path)
                for size in (36, 72, 108):
                    path = output / f'portrait-{size}-{theme}.png'
                    value = page.evaluate('(p) => window.atlas.capture(p)', {'size': size})
                    save_data_url(value, path, 'image/png')
                    artifacts.append(path)
                path = output / f'portrait-{theme}.webp'
                value = page.evaluate('(p) => window.atlas.capture(p)', {'format': 'image/webp', 'size': 256})
                save_data_url(value, path, 'image/webp')
                artifacts.append(path)
                sequence_dir = output / f'sequence-{theme}'
                frame_rows = []
                # 20 samples/second, inclusive endpoints: exactly 19 images, never a looping movie.
                for index in range(19):
                    time = round(index / 20, 2)
                    filename = f'reaction-{index:02}.webp'
                    path = sequence_dir / filename
                    value = page.evaluate('(p) => window.atlas.capture(p)', {'clip': 'quick_reaction', 'time': time, 'format': 'image/webp', 'size': 256})
                    save_data_url(value, path, 'image/webp')
                    artifacts.append(path)
                    frame_rows.append({'time': time, 'file': filename, 'bytes': path.stat().st_size, 'sha256': digest(path)})
                manifest = sequence_dir / 'manifest.json'
                manifest.write_text(json.dumps({'schemaVersion': 1, 'status': 'ROUGH_RENDERED_NOT_REVIEWED', 'clip': 'quick_reaction', 'duration': .9, 'width': 256, 'height': 256, 'samplingHz': 20, 'frames': frame_rows}, indent=2) + '\n')
                artifacts.append(manifest)
                export_state_delivery(page, output, delivery, theme, artifacts)
            delivery_manifest = output / 'atlas-v1/manifest.json'
            if delivery_manifest.is_symlink():
                raise ValueError('State manifest may not be a symbolic link.')
            delivery_manifest.write_text(json.dumps(delivery, indent=2) + '\n')
            artifacts.append(delivery_manifest)
            measured = page.evaluate('window.atlas.metrics()')
            if rejected or errors:
                raise RuntimeError({'rejectedRequests': rejected, 'pageErrors': errors})
            if sources != source_paths() or source_snapshot != [{'path': str(path.relative_to(REPO)), 'sha256': digest(path)} for path in sources]:
                raise RuntimeError('Creative/export source changed during capture. No matching export manifest written.')
            record = {
                'schemaVersion': 1, 'status': 'ROUGH_RENDERED_NOT_REVIEWED',
                'exportedAtUtc': datetime.now(timezone.utc).isoformat(),
                'approvedReference': {'path': str(reference.relative_to(REPO)), 'sha256': EXPECTED_REFERENCE, 'provenanceSha256': digest(provenance), 'kind': reference_metadata['kind']},
                'creativeRevision': config.get('creativeRevision', 'rough-01'),
                'technique': 'Deterministic procedural skinned geometry, editable skeleton, authored quaternion clips and one embedded 1024x1024 RGBA atlas containing fixed-hash directional feather-color motifs over a profile-relative angular chart; no generated imagery or raster planes.',
                'textureProvenance': {'encoding': 'embedded PNG', 'dimensions': [1024, 1024], 'channels': 'RGBA8', 'decodedRgbaEstimateBytes': 4_194_304, 'colorSpace': 'sRGB', 'filtering': 'linear minification and magnification', 'wrapping': 'clamp-to-edge S/T', 'mipmaps': False, 'bodyAndHead': 'Deterministic tapered directional motifs with sparse barb accents and weak anisotropic underpaint. A shared umber field is copied to front and rear half-circumference islands; all pale-free body texels match. UVs normalize rest X/Z by the retained silhouette profile and invert its squared-front contour before atan2.', 'throat': 'The original physical-X/Y pale mask is evaluated after converting chart angle back to silhouette X. The front-only pale blend has attenuated directional contrast. The old throat bitmap is not retained byte-for-byte.', 'wings': 'Two wing underforms and 24 coverts reuse existing brown rear-chart texels through a wing-local angular map with original scalar vertex tones. All atlas bytes and wing geometry/skin/animation remain unchanged from FACE02.', 'scope': 'Feather color is sampled by the two continuous layers, 44 body tufts, two anchored brows, two wing underforms and 24 coverts. The wing-color refinement changes only the 26 wing parts UV/color attributes; it adds no geometry, image, material, skin binding or animation.'},
                'parameters': {'seed': 0, 'randomness': 'none', 'radialSegments': config['radialSegments'], 'glb': {'binary': True, 'trs': True, 'onlyVisible': True, 'animations': list(config['statePerformances']) + ['rest', 'quick_reaction', 'speech_test', 'satisfied_nod']}, 'raster': {'pixelRatio': 1, 'webpQuality': .9, 'sequenceFramesPerTheme': 19, 'sequenceSamplingHz': 20}, 'stateDelivery': {'manifest': 'output/atlas-v1/manifest.json', 'frameSize': FRAME_SIZE, 'fps': FPS, 'columns': COLUMNS, 'alpha': 'renderer RGBA; no backdrop compositor', 'encoding': 'lossless WebP', 'loop': False}, 'lighting': {'hemisphereIntensity': 2.1, 'keyIntensity': 3, 'fillIntensity': 1.2}, 'toneMapping': 'ACESFilmic', 'exposure': 1, 'colorSpace': 'sRGB'},
                'runtime': {'threeVersion': three_version, 'chromiumVersion': browser.version, 'headless': True, 'renderer': measured['renderer']},
                'geometry': measured['geometry'],
                'sources': source_snapshot,
                'artifacts': [{'path': str(path.relative_to(PRODUCTION)), 'bytes': path.stat().st_size, 'sha256': digest(path)} for path in artifacts],
                'review': {'approvedFidelity': None, 'rigInspection': None, 'animationInspection': None, 'productionReadiness': False, 'reason': 'A human must inspect rendered outputs and measured delivery evidence. Export success is not artistic or performance approval.'},
                'limitations': ['No final retopology, layered feather finish, blend shapes, phoneme rig, eye tracking, voice, native renderer or device/thermal/battery proof. Procedural color motifs do not establish physical feather relief.', 'Headless browser pixels may vary by Three/browser/GPU backend. Seed 0 describes deterministic geometry, not cross-platform pixel or GLB byte identity.', 'Decoded RGBA storage is dimension-derived, not a measured GPU allocation or performance result.'],
            }
            (output / 'export-manifest.json').write_text(json.dumps(record, indent=2) + '\n')
            print(json.dumps({'status': record['status'], 'artifacts': len(artifacts), 'manifest': str(output / 'export-manifest.json')}, indent=2))
            context.close()
        finally:
            browser.close()


if __name__ == '__main__':
    main()
