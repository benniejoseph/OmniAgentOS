import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from macos_manifest import NativeRefused, digest, seal, tree_manifest, verify_manifest
from macos_source import eligible, materialize, workspace_digest, workspace_rows
from macos_protocol import validate_request, validate_receipt

FIXTURE=Path(__file__).parent/'fixtures/native-validation-v1.json'
class NativeSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup); self.root=Path(self.temp.name)
        self.fixture=json.loads(FIXTURE.read_text()); self.request=copy.deepcopy(self.fixture['request'])
    def test_shared_typescript_protocol(self):
        validate_request(self.request,{'tenantId':self.request['tenantId'],'actorId':self.request['ownerActorId']},[self.request['policySha256']],check_time=False)
        validate_receipt(self.request,self.fixture['receipt'])
    def test_resealed_command_not_fixed(self):
        receipt=copy.deepcopy(self.fixture['receipt']); receipt['checks'][0]['paths']=['apps/flutter/lib/features/auth/login.dart']
        receipt=seal('native_validation_receipt',{k:v for k,v in receipt.items() if k!='receiptSha256'},'receiptSha256')
        with self.assertRaisesRegex(NativeRefused,'policy_changed'): validate_receipt(self.request,receipt)
    def test_private_and_control_plane_paths(self):
        for path in ['../test.dart','/test.dart','apps/flutter/lib/core/file.dart','apps/flutter/lib/features/self_improvement/page.dart','apps/flutter/lib/features/auth/login.dart','apps/flutter/test/security_test.dart','apps/flutter/test/auth/login_test.dart','apps/flutter/lib/features/talk/talk.dart','apps/flutter/lib/features/talk/action_approval_card.dart','apps/flutter/lib/features/inbox/inbox.dart','apps/flutter/lib/features/ambient_voice/settings.dart','apps/flutter/lib/features/integrations/page.dart','apps/flutter/lib/features/builder/task_binding.dart']:
            with self.subTest(path=path):
                try: accepted=eligible(path)
                except NativeRefused: accepted=False
                self.assertFalse(accepted)
    def test_exact_git_materialization_and_mutation_rejected(self):
        git=self.root/'base'; git.mkdir()
        for path,content in self.fixture['baseFiles'].items():
            file=git/path; file.parent.mkdir(parents=True,exist_ok=True); file.write_text(content)
        for args in [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','Fixture']]:
            subprocess.run(['/usr/bin/git',*args],cwd=git,check=True,capture_output=True)
        base=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],cwd=git,text=True).strip()
        snapshot=self.request['snapshot']; snapshot['baseRevision']=base
        snapshot=seal('native_source_snapshot',{k:v for k,v in snapshot.items() if k!='snapshotSha256'},'snapshotSha256')
        self.request['snapshot']=snapshot; self.request=seal('native_validation_request',{k:v for k,v in self.request.items() if k!='requestSha256'},'requestSha256')
        result=materialize(git,self.root/'output',self.request,{'snapshot':snapshot,'changes':self.fixture['files']})
        self.assertEqual(workspace_digest(result),snapshot['workspaceSha256'])
        bad=copy.deepcopy(self.fixture['files']); bad[0]['content']='changed'
        with self.assertRaisesRegex(NativeRefused,'changes_changed'):
            materialize(git,self.root/'bad',self.request,{'snapshot':snapshot,'changes':bad})
    def test_hardlink_symlink_and_bundle_escape(self):
        tree=self.root/'tree';tree.mkdir();(tree/'file').write_text('one')
        os.link(tree/'file',tree/'hard')
        with self.assertRaises(NativeRefused):tree_manifest(tree)
        (tree/'hard').unlink();(tree/'link').symlink_to('file')
        with self.assertRaises(NativeRefused):tree_manifest(tree)
        self.assertEqual(tree_manifest(tree,'bundle')['kind'],'bundle')
        (tree/'link').unlink();(tree/'link').symlink_to('/etc/passwd')
        with self.assertRaises(NativeRefused):tree_manifest(tree,'bundle')
    def test_manifest_detects_content_mode_and_extra_file(self):
        tree=self.root/'tree';tree.mkdir();file=tree/'file';file.write_text('one');manifest=tree_manifest(tree)
        verify_manifest(tree,manifest);file.chmod(0o755)
        with self.assertRaisesRegex(NativeRefused,'tree_changed'):verify_manifest(tree,manifest)
        file.chmod(0o644);(tree/'extra').write_text('new')
        with self.assertRaisesRegex(NativeRefused,'tree_changed'):verify_manifest(tree,manifest)
    def test_builder_locale_sort_is_independent_of_input_order(self):
        rows=[{'path':path,'sha256':digest(path.encode()),'mode':'100644'} for path in ['a/file.dart','a/File.dart','a/file_test.dart','a/file-test.dart']]
        self.assertEqual(workspace_digest(rows),workspace_digest(list(reversed(rows))))
if __name__=='__main__':unittest.main()
