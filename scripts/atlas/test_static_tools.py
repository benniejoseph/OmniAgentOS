"""Root-run structural tests for the local server and GLB inspection, with no browser."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
from urllib.request import Request, urlopen
import zlib

from inspect_glb import inspect
from serve import resolve_file, running_server


def png_chunk(kind, payload):
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))


# The mesh remains a minimal structural fixture; its embedded image is a valid
# transparent 512x512 RGBA PNG, so each malformed case changes one contract.
FIXTURE_PNG = (b'\x89PNG\r\n\x1a\n'
               + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 512, 512, 8, 6, 0, 0, 0))
               + png_chunk(b'IDAT', zlib.compress(bytes((512 * 4 + 1) * 512)))
               + png_chunk(b'IEND', b''))
FIXTURE_BIN = b'\0\0\0\0' + FIXTURE_PNG


def fixture_document():
    return {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(FIXTURE_BIN)}],
            'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 4},
                            {'buffer': 0, 'byteOffset': 4, 'byteLength': len(FIXTURE_PNG)}],
            'images': [{'mimeType': 'image/png', 'bufferView': 1}],
            'textures': [{'source': 0, 'sampler': 0}],
            'samplers': [{'minFilter': 9729, 'magFilter': 9729, 'wrapS': 33071, 'wrapT': 33071}],
            'materials': [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}],
            'skins': [{'joints': list(range(14))}],
            'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 0, 'COLOR_0': 0, 'JOINTS_0': 0, 'WEIGHTS_0': 0, 'TEXCOORD_0': 2}, 'indices': 1, 'material': 0}]}],
            'accessors': [{'count': 3}, {'count': 3}, {'count': 3, 'type': 'VEC2', 'componentType': 5126}],
            'animations': [{'name': name} for name in ['available', 'listening', 'responding', 'working', 'needs_you', 'blocked', 'completed', 'paused', 'rest', 'quick_reaction', 'speech_test', 'satisfied_nod']]}


def glb(document, binary=FIXTURE_BIN):
    payload = json.dumps(document).encode()
    payload += b' ' * (-len(payload) % 4)
    binary += b'\0' * (-len(binary) % 4)
    body = struct.pack('<II', len(payload), 0x4E4F534A) + payload + struct.pack('<II', len(binary), 0x004E4942) + binary
    return b'glTF' + struct.pack('<II', 2, len(body) + 12) + body


class StaticToolsTest(unittest.TestCase):
    def test_only_curated_local_paths_resolve(self):
        self.assertTrue(resolve_file('/source/model.json').is_file())
        self.assertTrue(resolve_file('/').is_file())
        for path in ('/api/companion/preferences', '/.env', '/source/../model.json', '/source/%2e%2e/model.json', '/source/%00model.json', '/source/%5cmodel.json', '/vendor/package.json', '/web//index.html'):
            self.assertIsNone(resolve_file(path), path)

    def test_lab_csp_allows_only_self_and_blob_connections(self):
        with running_server() as url:
            with urlopen(Request(url, method='HEAD'), timeout=5) as response:
                self.assertEqual(response.status, 200)
                policy = response.headers['Content-Security-Policy']
        directives = dict(part.strip().split(maxsplit=1) for part in policy.split(';') if part.strip())
        self.assertEqual(directives['connect-src'].split(), ["'self'", 'blob:'])
        self.assertEqual(directives['default-src'], "'none'")

    def test_glb_requires_self_contained_exact_rig_and_clip_structure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            value = fixture_document()
            path.write_bytes(glb(value))
            inspected = inspect(path)
            self.assertEqual(inspected['bones'], 14)
            self.assertEqual(len(inspected['clips']), 12)
            self.assertEqual((inspected['materials'], inspected['textures'], inspected['images']), (1, 1, 1))
            self.assertEqual(inspected['textureDimensions'], [512, 512])
            self.assertEqual(inspected['externalResources'], 0)
            value['buffers'][0]['uri'] = 'https://example.invalid/mesh.bin'
            path.write_bytes(glb(value))
            with self.assertRaises(ValueError):
                inspect(path)
            value = fixture_document()
            value['animations'].pop()
            path.write_bytes(glb(value))
            with self.assertRaises(ValueError):
                inspect(path)
            value = fixture_document()
            value['skins'][0]['joints'].pop()
            path.write_bytes(glb(value))
            with self.assertRaises(ValueError):
                inspect(path)
            value = fixture_document()
            value['animations'][-1] = value['animations'][0].copy()
            path.write_bytes(glb(value))
            with self.assertRaises(ValueError):
                inspect(path)

    def test_glb_rejects_truncation_and_out_of_bounds_bin_views(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            path.write_bytes(glb(fixture_document())[:-1])
            with self.assertRaises(ValueError):
                inspect(path)
            value = fixture_document()
            value['bufferViews'][0]['byteLength'] = len(FIXTURE_BIN) + 1
            path.write_bytes(glb(value))
            with self.assertRaises(ValueError):
                inspect(path)

    def test_glb_requires_one_embedded_texture_resource_of_each_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            for collection in ('buffers', 'images', 'textures', 'samplers', 'materials'):
                for count in (0, 2):
                    with self.subTest(collection=collection, count=count):
                        value = fixture_document()
                        value[collection] = value[collection] * count
                        path.write_bytes(glb(value))
                        with self.assertRaisesRegex(ValueError, 'one embedded buffer|one material'):
                            inspect(path)
            value = fixture_document()
            value['images'][0]['uri'] = 'https://example.invalid/color.png'
            path.write_bytes(glb(value))
            with self.assertRaisesRegex(ValueError, 'no image or buffer URI'):
                inspect(path)

    def test_glb_rejects_wrong_texture_mapping_and_sampler(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            for key in ('source', 'sampler'):
                with self.subTest(texture=key):
                    value = fixture_document()
                    value['textures'][0][key] = 1
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'reference embedded image 0 and sampler 0'):
                        inspect(path)
            for key, invalid in (('minFilter', 9987), ('magFilter', 9728), ('wrapS', 10497), ('wrapT', 10497)):
                with self.subTest(sampler=key):
                    value = fixture_document()
                    value['samplers'][0][key] = invalid
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'linear texture filtering'):
                        inspect(path)
            for key, invalid in (('index', 1), ('texCoord', 1), ('extensions', {'KHR_texture_transform': {'offset': [0.1, 0]}})):
                with self.subTest(color_map=key):
                    value = fixture_document()
                    value['materials'][0]['pbrMetallicRoughness']['baseColorTexture'][key] = invalid
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'baseColorTexture 0'):
                        inspect(path)
            value = fixture_document()
            value['materials'][0]['normalTexture'] = {'index': 0}
            path.write_bytes(glb(value))
            with self.assertRaisesRegex(ValueError, 'only the authored base color map'):
                inspect(path)
            value = fixture_document()
            value['meshes'][0]['primitives'][0]['material'] = 1
            path.write_bytes(glb(value))
            with self.assertRaisesRegex(ValueError, 'use material 0'):
                inspect(path)

    def test_glb_rejects_invalid_embedded_image_views(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            for key, invalid in (('bufferView', -1), ('bufferView', 2), ('bufferView', True), ('mimeType', 'image/jpeg')):
                with self.subTest(image=key, invalid=invalid):
                    value = fixture_document()
                    value['images'][0][key] = invalid
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'valid embedded PNG buffer view'):
                        inspect(path)
            for key, invalid in (('byteOffset', -1), ('byteOffset', len(FIXTURE_BIN)), ('byteLength', len(FIXTURE_BIN)), ('buffer', 1)):
                with self.subTest(view=key):
                    value = fixture_document()
                    value['bufferViews'][1][key] = invalid
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'Buffer view exceeds'):
                        inspect(path)
            value = fixture_document()
            value['buffers'][0]['byteLength'] = len(FIXTURE_BIN) + 4
            path.write_bytes(glb(value))
            with self.assertRaisesRegex(ValueError, 'Invalid embedded buffer length'):
                inspect(path)
            value = fixture_document()
            value['bufferViews'][1]['byteLength'] = 32
            path.write_bytes(glb(value))
            with self.assertRaisesRegex(ValueError, 'PNG signature or IHDR header'):
                inspect(path)

    def test_glb_rejects_png_header_dimensions_and_encoding_changes(self):
        cases = ((0, b'\0', 'PNG signature or IHDR header'),
                 (8, struct.pack('>I', 12), 'PNG signature or IHDR header'),
                 (12, b'IDAT', 'PNG signature or IHDR header'),
                 (16, struct.pack('>I', 256), '512x512 color map'),
                 (20, struct.pack('>I', 256), '512x512 color map'),
                 (24, b'\x10', '8-bit RGBA PNG'),
                 (25, b'\x02', '8-bit RGBA PNG'),
                 (26, b'\x01', '8-bit RGBA PNG'),
                 (27, b'\x01', '8-bit RGBA PNG'),
                 (28, b'\x01', '8-bit RGBA PNG'))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            for offset, replacement, message in cases:
                with self.subTest(png_offset=offset):
                    binary = bytearray(FIXTURE_BIN)
                    binary[4 + offset:4 + offset + len(replacement)] = replacement
                    path.write_bytes(glb(fixture_document(), bytes(binary)))
                    with self.assertRaisesRegex(ValueError, message):
                        inspect(path)

    def test_glb_requires_uv_pairs_matching_position_count(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            value = fixture_document()
            del value['meshes'][0]['primitives'][0]['attributes']['TEXCOORD_0']
            path.write_bytes(glb(value))
            with self.assertRaisesRegex(ValueError, 'Missing skinned vertex attributes'):
                inspect(path)
            for invalid in (-1, 3, True):
                with self.subTest(uv_index=invalid):
                    value = fixture_document()
                    value['meshes'][0]['primitives'][0]['attributes']['TEXCOORD_0'] = invalid
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'Invalid TEXCOORD_0 accessor'):
                        inspect(path)
            for key, invalid in (('count', 2), ('type', 'VEC3'), ('componentType', 5123)):
                with self.subTest(uv=key):
                    value = fixture_document()
                    value['accessors'][2][key] = invalid
                    path.write_bytes(glb(value))
                    with self.assertRaisesRegex(ValueError, 'Float32 UV pair for every position'):
                        inspect(path)


if __name__ == '__main__':
    unittest.main()
