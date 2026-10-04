#!/usr/bin/env python3
"""Publish an explicitly reviewed, hash-bound ATLAS raster bundle to web/native assets.

No rendering, installs, network, application APIs, or deployment. Run only after
reviewing the matching export; --accept-reviewed is the operator's admission.
"""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile

from export import COLUMNS, EXPECTED_REFERENCE, FPS, FRAME_SIZE, STATES, source_paths, state_delivery
from serve import PRODUCTION, REPO

HASH = re.compile(r'^[a-f0-9]{64}$')
THEMES = ('light', 'dark')
MAX_FILE_BYTES = 32 * 1024 * 1024
TARGETS = (REPO / 'public/companion/atlas-v1', REPO / 'apps/flutter/assets/companion/atlas-v1')


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def exact_keys(value, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f'{label} has an unsupported shape.')
    return value


def json_value(value: bytes):
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError('Duplicate JSON field.')
            result[key] = item
        return result
    return json.loads(value, object_pairs_hook=unique)


def check_path(path: Path, base: Path) -> None:
    if not path.is_relative_to(base) or not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('Asset path leaves its fixed directory.')
    current = path
    while current != base:
        if current.is_symlink():
            raise ValueError(f'Symbolic links are not publishable: {path}')
        current = current.parent
    if base.is_symlink():
        raise ValueError('Asset root may not be a symbolic link.')


def read_file(path: Path, base: Path) -> bytes:
    check_path(path, base)
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE_BYTES:
        raise ValueError(f'Missing or oversized source/artifact: {path}')
    return path.read_bytes()


def relative_file(base: Path, value: object) -> Path:
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError('Invalid recorded path.')
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('Recorded paths must be exact local relative paths.')
    return base.joinpath(*parts)


def image_check(data: bytes, size: tuple[int, int], frame_count: int | None = None) -> None:
    from PIL import Image
    with Image.open(BytesIO(data)) as source:
        if source.format != 'WEBP' or source.size != size or getattr(source, 'n_frames', 1) != 1 or 'A' not in source.getbands():
            raise ValueError('Expected a single transparent WebP with exact dimensions.')
        with source.convert('RGBA') as image:
            with image.getchannel('A') as alpha:
                if frame_count is None:
                    low, high = alpha.getextrema()
                    if low != 0 or high == 0:
                        raise ValueError('Poster lacks transparent background or visible geometry.')
                else:
                    cells = COLUMNS * math.ceil(frame_count / COLUMNS)
                    for index in range(cells):
                        x, y = index % COLUMNS * FRAME_SIZE, index // COLUMNS * FRAME_SIZE
                        with alpha.crop((x, y, x + FRAME_SIZE, y + FRAME_SIZE)) as cell:
                            low, high = cell.getextrema()
                        if index < frame_count and (low != 0 or high == 0):
                            raise ValueError('A sprite frame is opaque or empty.')
                        if index >= frame_count and high != 0:
                            raise ValueError('Unused sprite cells must be fully transparent.')


def verified_bundle() -> tuple[dict[str, bytes], dict]:
    output = PRODUCTION / 'output'
    export_bytes = read_file(output / 'export-manifest.json', PRODUCTION)
    record = json_value(export_bytes)
    if not isinstance(record, dict) or record.get('schemaVersion') != 1 or record.get('status') != 'ROUGH_RENDERED_NOT_REVIEWED':
        raise ValueError('A supported, actual export record is required.')
    config = json_value(read_file(PRODUCTION / 'source/model.json', PRODUCTION))
    expected = state_delivery(config)
    if record.get('creativeRevision') != expected['creativeRevision'] or config.get('sourceExpectedSha256') != EXPECTED_REFERENCE:
        raise ValueError('Export and current creative source revisions differ.')
    reference = record.get('approvedReference')
    reference_path = '.design/asael-ace-revamp/references/atlas-selected.png'
    if not isinstance(reference, dict) or reference.get('path') != reference_path or reference.get('sha256') != EXPECTED_REFERENCE:
        raise ValueError('Export is not bound to the approved identity reference.')
    if sha256(read_file(REPO / reference_path, REPO)) != EXPECTED_REFERENCE:
        raise ValueError('Approved reference bytes changed.')
    provenance = read_file(REPO / '.design/asael-ace-revamp/references/atlas-export.json', REPO)
    if sha256(provenance) != reference.get('provenanceSha256') or json_value(provenance).get('screenSha256') != EXPECTED_REFERENCE:
        raise ValueError('Approved reference provenance changed.')
    sources = record.get('sources')
    if not isinstance(sources, list) or len(sources) > 256:
        raise ValueError('Missing bounded source inventory.')
    seen = set()
    for row in sources:
        exact_keys(row, {'path', 'sha256'}, 'Source row')
        path = relative_file(REPO, row['path'])
        if row['path'] in seen or not isinstance(row['sha256'], str) or not HASH.fullmatch(row['sha256']):
            raise ValueError('Duplicate source or invalid digest.')
        seen.add(row['path'])
        if sha256(read_file(path, REPO)) != row['sha256']:
            raise ValueError(f'Source changed after export: {row["path"]}')
    if seen != {str(path.relative_to(REPO)) for path in source_paths()}:
        raise ValueError('Export does not cover the current complete source inventory.')
    artifacts = record.get('artifacts')
    if not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 1024:
        raise ValueError('Missing bounded artifact inventory.')
    recorded = {}
    for row in artifacts:
        exact_keys(row, {'path', 'bytes', 'sha256'}, 'Artifact row')
        path = relative_file(PRODUCTION, row['path'])
        if not path.is_relative_to(output) or row['path'] in recorded or type(row['bytes']) is not int or not isinstance(row['sha256'], str) or not HASH.fullmatch(row['sha256']):
            raise ValueError('Duplicate or invalid output artifact.')
        data = read_file(path, PRODUCTION)
        if len(data) != row['bytes'] or sha256(data) != row['sha256']:
            raise ValueError(f'Artifact changed after export: {row["path"]}')
        recorded[row['path']] = data
    manifest_bytes = recorded.get('output/atlas-v1/manifest.json')
    if manifest_bytes is None:
        raise ValueError('Export did not record the production raster manifest.')
    manifest = exact_keys(json_value(manifest_bytes), {'schemaVersion', 'creativeRevision', 'frameSize', 'fps', 'columns', 'states'}, 'Raster manifest')
    for key in ('schemaVersion', 'frameSize', 'fps', 'columns'):
        if type(manifest[key]) is not int or manifest[key] != expected[key]:
            raise ValueError('Unsupported raster manifest constants.')
    if manifest['creativeRevision'] != expected['creativeRevision']:
        raise ValueError('Raster manifest creative revision mismatch.')
    states = exact_keys(manifest['states'], set(STATES), 'Raster states')
    bundle = {'manifest.json': manifest_bytes}
    for state in STATES:
        row = exact_keys(states[state], {'durationMs', 'frameCount', 'light', 'dark'}, 'State delivery')
        for key in ('durationMs', 'frameCount'):
            if type(row[key]) is not int or row[key] != expected['states'][state][key]:
                raise ValueError('State timing differs from current authored clip.')
        for theme in THEMES:
            images = exact_keys(row[theme], {'poster', 'sprite', 'posterSha256', 'spriteSha256'}, 'Theme delivery')
            for kind in ('poster', 'sprite'):
                name = f'{state}-{theme}-{kind}.webp'
                digest = images[f'{kind}Sha256']
                if images[kind] != name or not isinstance(digest, str) or not HASH.fullmatch(digest):
                    raise ValueError('Asset must use its exact allowlisted basename and digest.')
                data = recorded.get(f'output/atlas-v1/{name}')
                if data is None or sha256(data) != digest:
                    raise ValueError(f'Raster manifest does not bind {name}.')
                size = (FRAME_SIZE, FRAME_SIZE) if kind == 'poster' else (COLUMNS * FRAME_SIZE, math.ceil(row['frameCount'] / COLUMNS) * FRAME_SIZE)
                image_check(data, size, None if kind == 'poster' else row['frameCount'])
                bundle[name] = data
    return bundle, {'creativeRevision': expected['creativeRevision'], 'exportManifestSha256': sha256(export_bytes), 'deliveryManifestSha256': sha256(manifest_bytes)}


def publish(bundle: dict[str, bytes]) -> None:
    # Both copies are fully prepared before either destination changes. Directory
    # renames switch each bundle as a unit; reported failures restore old copies.
    # Two destination directories are not a cross-filesystem crash transaction.
    prepared = []
    cleanup = True
    try:
        for destination in TARGETS:
            check_path(destination, REPO)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                if not destination.is_dir() or any(path.is_symlink() or not path.is_file() or path.name not in bundle for path in destination.iterdir()):
                    raise ValueError('Existing delivery contains unexpected files; no replacement performed.')
            staging = Path(tempfile.mkdtemp(prefix='.atlas-v1-', dir=destination.parent))
            fresh, previous = staging / 'new', staging / 'previous'
            prepared.append({'staging': staging, 'destination': destination, 'fresh': fresh, 'previous': previous, 'installed': False, 'backedUp': False})
            fresh.mkdir()
            for name, data in bundle.items():
                (fresh / name).write_bytes(data)
                if sha256((fresh / name).read_bytes()) != sha256(data):
                    raise OSError('Staged asset verification failed.')
        try:
            for item in prepared:
                if item['destination'].exists():
                    os.replace(item['destination'], item['previous'])
                    item['backedUp'] = True
                os.replace(item['fresh'], item['destination'])
                item['installed'] = True
            for item in prepared:
                for name, data in bundle.items():
                    if sha256(read_file(item['destination'] / name, REPO)) != sha256(data):
                        raise OSError('Published asset verification failed.')
        except BaseException as error:
            restoration_errors = []
            for item in reversed(prepared):
                try:
                    if item['installed']:
                        os.replace(item['destination'], item['fresh'])
                    if item['backedUp']:
                        os.replace(item['previous'], item['destination'])
                except OSError as restoration_error:
                    restoration_errors.append(str(restoration_error))
            if restoration_errors:
                cleanup = False
                retained = [str(item['staging']) for item in prepared]
                raise RuntimeError(f'Publication restoration is incomplete; retained recovery directories: {retained}; errors: {restoration_errors}') from error
            raise
    finally:
        if cleanup:
            for item in prepared:
                shutil.rmtree(item['staging'])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--accept-reviewed', action='store_true', help='Explicitly attest that the matching rendered bundle was visually reviewed for publication.')
    args = parser.parse_args()
    if not args.accept_reviewed:
        parser.error('No assets copied. Review the matching renders, then explicitly pass --accept-reviewed.')
    bundle, evidence = verified_bundle()
    publish(bundle)
    print(json.dumps({'status': 'reviewed_raster_bundle_copied', 'explicitReviewAcceptance': True, **evidence,
                      'filesPerDestination': len(bundle), 'destinations': [str(path.relative_to(REPO)) for path in TARGETS],
                      'productionDeployment': False, 'devicePerformanceCertified': False}, indent=2))


if __name__ == '__main__':
    main()
