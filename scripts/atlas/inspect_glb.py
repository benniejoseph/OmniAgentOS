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
    buffers = document.get('buffers', [])
    images = document.get('images', [])
    textures = document.get('textures', [])
    samplers = document.get('samplers', [])
    materials = document.get('materials', [])
    if len(buffers) != 1 or any('uri' in buffer for buffer in buffers) or any('uri' in image for image in images):
        raise ValueError('Asset must use one embedded buffer and no image or buffer URI.')
    if len(images) != 1 or len(textures) != 1 or len(samplers) != 1 or len(materials) != 1:
        raise ValueError('Expected one material, embedded PNG, color texture and sampler.')
    if textures[0].get('source') != 0 or textures[0].get('sampler') != 0 or textures[0].get('extensions'):
        raise ValueError('Expected the color texture to reference embedded image 0 and sampler 0.')
    if any(samplers[0].get(key) != value for key, value in {'minFilter': 9729, 'magFilter': 9729, 'wrapS': 33071, 'wrapT': 33071}.items()):
        raise ValueError('Expected linear texture filtering, no mipmap filtering and clamped S/T wrapping.')
    material = materials[0]
    pbr = material.get('pbrMetallicRoughness', {})
    color_map = pbr.get('baseColorTexture', {})
    if color_map.get('index') != 0 or color_map.get('texCoord', 0) != 0 or color_map.get('extensions'):
        raise ValueError('Expected baseColorTexture 0 using untransformed TEXCOORD_0.')
    if any(key in material for key in ('normalTexture', 'occlusionTexture', 'emissiveTexture')) or 'metallicRoughnessTexture' in pbr or material.get('extensions'):
        raise ValueError('Expected only the authored base color map.')
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
    if primitive.get('material') != 0:
        raise ValueError('Expected the merged primitive to use material 0.')
    if not {'POSITION', 'NORMAL', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0', 'TEXCOORD_0'}.issubset(primitive.get('attributes', {})):
        raise ValueError('Missing skinned vertex attributes.')
    bin_length = len(chunks[1][1])
    declared_length = buffers[0].get('byteLength')
    if type(declared_length) is not int or declared_length <= 0 or not 0 <= bin_length - declared_length <= 3:
        raise ValueError('Invalid embedded buffer length or BIN padding.')
    for view in document.get('bufferViews', []):
        offset, length = view.get('byteOffset', 0), view.get('byteLength')
        if view.get('buffer') != 0 or type(offset) is not int or type(length) is not int or offset < 0 or length < 0 or offset + length > declared_length:
            raise ValueError('Buffer view exceeds the embedded BIN chunk.')
    image = images[0]
    image_view = image.get('bufferView')
    views = document.get('bufferViews', [])
    if image.get('mimeType') != 'image/png' or type(image_view) is not int or not 0 <= image_view < len(views):
        raise ValueError('Expected a valid embedded PNG buffer view.')
    view = views[image_view]
    offset = view.get('byteOffset', 0)
    png = chunks[1][1][offset:offset + view['byteLength']]
    if len(png) < 33 or png[:8] != b'\x89PNG\r\n\x1a\n' or png[8:16] != b'\x00\x00\x00\rIHDR':
        raise ValueError('Invalid embedded PNG signature or IHDR header.')
    width, height = struct.unpack_from('>II', png, 16)
    if (width, height) != (512, 512):
        raise ValueError('Expected the authored 512x512 color map.')
    if png[24:29] != b'\x08\x06\x00\x00\x00':
        raise ValueError('Expected 8-bit RGBA PNG with compression/filter method 0 and no interlace.')
    position = document['accessors'][primitive['attributes']['POSITION']]
    indices = document['accessors'][primitive['indices']]
    uv_index = primitive['attributes']['TEXCOORD_0']
    accessors = document.get('accessors', [])
    if type(uv_index) is not int or not 0 <= uv_index < len(accessors):
        raise ValueError('Invalid TEXCOORD_0 accessor.')
    uv = accessors[uv_index]
    if uv.get('type') != 'VEC2' or uv.get('componentType') != 5126 or uv.get('count') != position['count']:
        raise ValueError('Expected a Float32 UV pair for every position.')
    return {'status': 'ROUGH_STRUCTURE_CHECKED_NOT_VISUALLY_APPROVED', 'path': str(path), 'bytes': len(data), 'vertices': position['count'], 'triangles': indices['count'] // 3, 'bones': len(skins[0]['joints']), 'clips': names, 'materials': len(materials), 'textures': len(textures), 'images': len(images), 'textureDimensions': [width, height], 'externalResources': 0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path, nargs='?', default=PRODUCTION / 'output/atlas-rough.glb')
    args = parser.parse_args()
    print(json.dumps(inspect(args.path), indent=2))


if __name__ == '__main__':
    main()
