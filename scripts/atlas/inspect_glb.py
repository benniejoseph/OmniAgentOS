#!/usr/bin/env python3
"""Inspect a generated rough GLB structurally; never establishes visual quality."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import struct
from serve import PRODUCTION


def inspect(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b'glTF':
        raise ValueError('Not a GLB file.')
    version, size = struct.unpack_from('<II', data, 4)
    if version != 2 or size != len(data):
        raise ValueError('Invalid GLB version or declared length.')
    cursor, chunks = 12, []
    while cursor < len(data):
        if cursor + 8 > len(data):
            raise ValueError('Truncated chunk header.')
        length, kind = struct.unpack_from('<II', data, cursor)
        cursor += 8
        if length % 4 or cursor + length > len(data):
            raise ValueError('Invalid chunk alignment or length.')
        chunks.append((kind, data[cursor:cursor + length]))
        cursor += length
    if [kind for kind, _ in chunks] != [0x4E4F534A, 0x004E4942]:
        raise ValueError('Expected one JSON and one BIN chunk.')
    document = json.loads(chunks[0][1])
    if document.get('asset', {}).get('version') != '2.0':
        raise ValueError('Expected glTF 2.0.')
    if document.get('images') or document.get('textures') or any('uri' in buffer for buffer in document.get('buffers', [])):
        raise ValueError('Rough asset must be self-contained and texture-free.')
    if document.get('extensionsRequired'):
        raise ValueError('Unexpected decoder/extension requirement.')
    skins = document.get('skins', [])
    if len(skins) != 1 or len(skins[0].get('joints', [])) != 14:
        raise ValueError('Expected the authored 14-bone sculpt-02 skeleton. Rough-01 exports are stale.')
    names = [animation.get('name') for animation in document.get('animations', [])]
    states = {'available', 'listening', 'responding', 'working', 'needs_you', 'blocked', 'completed', 'paused'}
    expected = states | {'rest', 'quick_reaction', 'speech_test', 'satisfied_nod'}
    if set(names) != expected or len(names) != len(expected):
        raise ValueError('Missing or duplicate authored clip.')
    meshes = document.get('meshes', [])
    if len(meshes) != 1 or len(meshes[0].get('primitives', [])) != 1:
        raise ValueError('Expected one merged rough primitive.')
    primitive = meshes[0]['primitives'][0]
    if not {'POSITION', 'NORMAL', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0'}.issubset(primitive.get('attributes', {})):
        raise ValueError('Missing skinned vertex attributes.')
    bin_length = len(chunks[1][1])
    for view in document.get('bufferViews', []):
        if view.get('buffer') != 0 or view.get('byteOffset', 0) < 0 or view.get('byteLength', 0) < 0 or view.get('byteOffset', 0) + view['byteLength'] > bin_length:
            raise ValueError('Buffer view exceeds the embedded BIN chunk.')
    position = document['accessors'][primitive['attributes']['POSITION']]
    indices = document['accessors'][primitive['indices']]
    return {'status': 'ROUGH_STRUCTURE_CHECKED_NOT_VISUALLY_APPROVED', 'path': str(path), 'bytes': len(data), 'vertices': position['count'], 'triangles': indices['count'] // 3, 'bones': len(skins[0]['joints']), 'clips': names, 'externalResources': 0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path, nargs='?', default=PRODUCTION / 'output/atlas-rough.glb')
    args = parser.parse_args()
    print(json.dumps(inspect(args.path), indent=2))


if __name__ == '__main__':
    main()
