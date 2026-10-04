"""Root-run structural tests for the local server and GLB inspection, with no browser."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from inspect_glb import inspect
from serve import resolve_file


def fixture_document():
    return {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 4}],
            'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 4}],
            'skins': [{'joints': list(range(14))}],
            'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 0, 'COLOR_0': 0, 'JOINTS_0': 0, 'WEIGHTS_0': 0}, 'indices': 1}]}],
            'accessors': [{'count': 3}, {'count': 3}],
            'animations': [{'name': name} for name in ['available', 'listening', 'responding', 'working', 'needs_you', 'blocked', 'completed', 'paused', 'rest', 'quick_reaction', 'speech_test', 'satisfied_nod']]}


def glb(document):
    payload = json.dumps(document).encode()
    payload += b' ' * (-len(payload) % 4)
    body = struct.pack('<II', len(payload), 0x4E4F534A) + payload + struct.pack('<II', 4, 0x004E4942) + b'\0\0\0\0'
    return b'glTF' + struct.pack('<II', 2, len(body) + 12) + body


class StaticToolsTest(unittest.TestCase):
    def test_only_curated_local_paths_resolve(self):
        self.assertTrue(resolve_file('/source/model.json').is_file())
        self.assertTrue(resolve_file('/').is_file())
        for path in ('/api/companion/preferences', '/.env', '/source/../model.json', '/source/%2e%2e/model.json', '/source/%00model.json', '/source/%5cmodel.json', '/vendor/package.json', '/web//index.html'):
            self.assertIsNone(resolve_file(path), path)

    def test_glb_requires_self_contained_exact_rig_and_clip_structure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rough.glb'
            value = fixture_document()
            path.write_bytes(glb(value))
            inspected = inspect(path)
            self.assertEqual(inspected['bones'], 14)
            self.assertEqual(len(inspected['clips']), 12)
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
            value['bufferViews'][0]['byteLength'] = 8
            path.write_bytes(glb(value))
            with self.assertRaises(ValueError):
                inspect(path)


if __name__ == '__main__':
    unittest.main()
