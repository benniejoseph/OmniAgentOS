"""Focused regressions for real codesign readback layouts; no signing keys."""
from pathlib import Path
import unittest
from unittest.mock import patch

from macos_manifest import NativeRefused,digest
import macos_sign as signing


# Exact requirement and stream placement captured from signed Asael 115/116.
REQUIREMENT=b'designated => identifier "app.omniagent.omniagent" and certificate root = H"27eb85fbd194b0b48c339574100f97d792a77960"'
DIAGNOSTIC=b'Executable=/Applications/Asael.app/Contents/MacOS/omniagent\n'
CDHASH=b'8fada4af74a81e66c9ac2b8db399e4939b776570'


class SignatureReadbackTests(unittest.TestCase):
    def test_actual_stdout_layout_produces_exact_signature_identity(self):
        calls=[]
        def command(argv):
            calls.append(argv)
            if '--verify' in argv:return b'',b''
            if '-r-' in argv:return REQUIREMENT+b'\n',DIAGNOSTIC
            if '--verbose=4' in argv:
                return b'',DIAGNOSTIC+b'CodeDirectory v=20500 size=8888 flags=0x10000(runtime) hashes=267+7 location=embedded\nCDHash='+CDHASH+b'\n'
            if argv[2].startswith('--extract-certificates='):
                self.assertEqual(len(argv),4)
                self.assertEqual(argv[3],'/Applications/Asael.app')
                prefix=argv[2].split('=',1)[1]
                self.assertTrue(Path(prefix).is_absolute())
                Path(prefix+'0').write_bytes(b'public certificate fixture')
                return b'',b''
            self.fail('Unexpected command')
        with patch.object(signing,'checked',side_effect=command):
            result=signing.signature_identity('/Applications/Asael.app')
        self.assertEqual(result,{'signingIdentitySha256':digest(b'public certificate fixture'),
            'designatedRequirementSha256':digest(REQUIREMENT),'codeSignatureSha256':digest(CDHASH)})
        self.assertEqual(calls[0],['/usr/bin/codesign','--verify','--deep','--strict','--all-architectures','/Applications/Asael.app'])
        self.assertEqual(len(calls),4)

    def test_stderr_layout_remains_supported_without_hash_normalization(self):
        self.assertEqual(signing.designated_requirement(b'',DIAGNOSTIC+REQUIREMENT+b'\n'),REQUIREMENT)

    def test_duplicate_and_missing_declarations_refuse(self):
        for stdout,stderr in [(REQUIREMENT+b'\n'+REQUIREMENT+b'\n',DIAGNOSTIC),
                (REQUIREMENT+b'\n',REQUIREMENT+b'\n'),(b'',DIAGNOSTIC)]:
            with self.subTest(stdout=stdout,stderr=stderr),self.assertRaisesRegex(NativeRefused,'missing_or_ambiguous'):
                signing.designated_requirement(stdout,stderr)

    def test_malformed_or_unbounded_declarations_refuse(self):
        for line in [b'designated => ',b'designated =>',b'designated=identifier "x"',
                b' '+REQUIREMENT,REQUIREMENT+b' ',REQUIREMENT+b'\x00',
                b'designated => identifier\t"x"',REQUIREMENT+b'\xff',b'designated => '+b'x'*16_385]:
            with self.subTest(line=line),self.assertRaisesRegex(NativeRefused,'invalid'):
                signing.designated_requirement(line+b'\n',DIAGNOSTIC)
        with self.assertRaisesRegex(NativeRefused,'invalid'):
            signing.designated_requirement(REQUIREMENT+b'\n',b'x'*65_537)

    def test_requirement_failure_precedes_metadata_or_certificate_reads(self):
        with patch.object(signing,'checked',side_effect=[(b'',b''),(b'',DIAGNOSTIC)]) as command:
            with self.assertRaisesRegex(NativeRefused,'missing_or_ambiguous'):
                signing.signature_identity('/Applications/Asael.app')
        self.assertEqual(command.call_count,2)

    def test_unhardened_signature_is_still_rejected(self):
        with patch.object(signing,'checked',side_effect=[(b'',b''),(REQUIREMENT+b'\n',DIAGNOSTIC),
                (b'',DIAGNOSTIC+b'CodeDirectory v=20400 flags=0x0(none)\nCDHash='+CDHASH+b'\n')]) as command:
            with self.assertRaisesRegex(NativeRefused,'missing_or_unhardened'):
                signing.signature_identity('/Applications/Asael.app')
        self.assertEqual(command.call_count,3)


if __name__=='__main__':unittest.main()
