import copy
from datetime import datetime,timedelta,timezone
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from macos_manifest import NativeRefused,digest,tree_manifest
from macos_build import fixed_commands,parse_test_output,verify_toolchain
from macos_protocol import PROFILE_SHA
from macos_bridge import running_code,validate_reply
from macos_install import Journal,atomic_swap,observed_layout
from macos_sign import write_provenance
from macos_controller import serving_baseline

class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
    def bundle(self,path,build='117'):
        (path/'Contents/MacOS').mkdir(parents=True);exe=path/'Contents/MacOS/omniagent';exe.write_bytes(b'fixture');exe.chmod(0o755)
        (path/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'app.omniagent.omniagent','CFBundleExecutable':'omniagent','CFBundleShortVersionString':'1.40.0','CFBundleVersion':build}));return path
    def test_shared_provenance_and_no_overwrite(self):
        app=self.bundle(self.root/'Asael.app');value={'protocol':1,'sourceRevision':'a'*40,'sourceSnapshotSha256':'b'*64,'version':'1.40.0','build':117}
        result=write_provenance(app,value);self.assertEqual(result,digest((app/'Contents/Resources/asael-native-release.json').read_bytes()))
        with self.assertRaisesRegex(NativeRefused,'already_present'):write_provenance(app,value)
    def test_provenance_rejects_extra_authority_and_wrong_bundle(self):
        app=self.bundle(self.root/'Asael.app');value={'protocol':1,'sourceRevision':'a'*40,'sourceSnapshotSha256':'b'*64,'version':'1.40.0','build':118}
        with self.assertRaisesRegex(NativeRefused,'bundle_mismatch'):write_provenance(app,value)
        with self.assertRaisesRegex(NativeRefused,'contract_invalid'):write_provenance(app,{**value,'command':'anything'})
    def test_test_parser_excludes_loading_and_requires_all_requested_cases(self):
        path='apps/flutter/test/real_test.dart';events=[{'type':'suite','suite':{'id':0,'path':str(self.root/path)}},{'type':'testStart','test':{'id':1,'suiteID':0}},{'type':'testDone','testID':1,'hidden':True,'result':'success'},{'type':'testStart','test':{'id':2,'suiteID':0}},{'type':'testDone','testID':2,'hidden':False,'skipped':False,'result':'failure'},{'type':'done','success':False}]
        raw='\n'.join(json.dumps(item) for item in events).encode();summary=parse_test_output(raw,self.root,[path],1)
        self.assertEqual((summary['totalTests'],summary['failedTests']),(1,1))
        with self.assertRaisesRegex(NativeRefused,'exit_conflict'):parse_test_output(raw,self.root,[path],0)
        with self.assertRaisesRegex(NativeRefused,'no_executed_cases'):parse_test_output(raw,self.root,[path,'apps/flutter/test/absent_test.dart'],1)
        empty='\n'.join(json.dumps(item) for item in events if item.get('testID')!=2 and item.get('test',{}).get('id')!=2).encode()
        with self.assertRaisesRegex(NativeRefused,'no_executed_cases'):parse_test_output(empty,self.root,[path],1)
    def test_fixed_command_has_no_candidate_shell_and_no_vm_service(self):
        config={'dartExecutable':'/fixed/dart','packageConfig':'/fixed/packages.json','entrypoint':'/fixed/tool.dart','macosSdk':{'path':'/fixed/macos.sdk'}}
        commands=fixed_commands('macos_test_focused',['apps/flutter/test/real_test.dart'],self.root,self.root/'home',config,{'buildNumber':'116','version':'1.40.0'},'a'*64)
        self.assertIn('--concurrency=1',commands[0]);self.assertIn('--disable-dds',commands[0]);self.assertIn('--no-enable-vmservice',commands[0]);self.assertNotIn('/bin/sh',commands[0])
        commands=fixed_commands('macos_build',[],self.root,self.root/'home',config,{'buildNumber':'116','version':'1.40.0'},'a'*64)
        self.assertIn('--build-number=117',commands[0]);self.assertIn('CODE_SIGNING_ALLOWED=NO',commands[1]);self.assertFalse(any('SOURCE_REVISION' in part for line in commands for part in line))
        self.assertIn('SDKROOT=/fixed/macos.sdk',commands[1]);self.assertEqual(commands[1][1:3],['-jobs','1'])
        self.assertIn('-project',commands[1]);self.assertIn(str(self.root/'apps/flutter/macos/Runner.xcodeproj'),commands[1]);self.assertNotIn('-workspace',commands[1])
    def test_xcode_and_selected_sdk_metadata_drift_are_rejected(self):
        developer=self.root/'Developer';sdk=developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk';sdk.mkdir(parents=True)
        for name in ('SDKSettings.json','SDKSettings.plist'):(sdk/name).write_text('reviewed SDK metadata')
        cache=self.root/'cache';cache.mkdir();(cache/'tool').write_text('reviewed compiler');version=b'Xcode fixed\nBuild version fixed\n'
        body={'version':1,'profileSha256':PROFILE_SHA,'developerDirectory':str(developer),'xcodeVersionSha256':digest(version),'trees':[{'path':str(cache),'manifest':tree_manifest(cache,'bundle')}],'files':[{'path':str(cache/'tool'),'sha256':digest((cache/'tool').read_bytes())}],**{field:str(cache/'tool') for field in ('dartExecutable','entrypoint','packageConfig','sdk','pubCache')},'macosSdk':{'path':str(sdk),'settings':[{'path':str(sdk/name),'sha256':digest((sdk/name).read_bytes())} for name in ('SDKSettings.json','SDKSettings.plist')]}}
        config={**body,'toolchainSha256':digest(body)}
        with patch('macos_build.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=version)):
            self.assertEqual(verify_toolchain(config),config['toolchainSha256'])
            (sdk/'SDKSettings.json').write_text('drifted SDK metadata')
            with self.assertRaisesRegex(NativeRefused,'sdk_metadata_changed'):verify_toolchain(config)
        with patch('macos_build.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=b'changed version')):
            with self.assertRaisesRegex(NativeRefused,'xcode_version_changed'):verify_toolchain(config)
    def test_journal_detects_mutation_and_is_not_replayed(self):
        journal=Journal(self.root/'journal',{'artifact':'one'});journal.append('prepared');journal.append('swap_intent')
        self.assertEqual(len(Journal(self.root/'journal',{'artifact':'one'}).events),2)
        file=self.root/'journal/0000.json';record=json.loads(file.read_text());record['stage']='verified';file.write_text(json.dumps(record))
        with self.assertRaisesRegex(NativeRefused,'journal_changed'):Journal(self.root/'journal',{'artifact':'one'})
    @unittest.skipUnless(os.uname().sysname=='Darwin','Darwin atomic replacement')
    def test_actual_atomic_swap_and_recovery_observation(self):
        old=self.bundle(self.root/'active.app','116');new=self.bundle(self.root/'backup.app','117');old_sha=tree_manifest(old,'bundle')['manifestSha256'];new_sha=tree_manifest(new,'bundle')['manifestSha256']
        self.assertEqual(observed_layout(old,new,old_sha,new_sha),'prior_installed');atomic_swap(old,new)
        self.assertEqual(observed_layout(old,new,old_sha,new_sha),'candidate_installed');atomic_swap(old,new)
        self.assertEqual(observed_layout(old,new,old_sha,new_sha),'prior_installed')
    def test_bridge_rejects_peer_spoof_and_quiescence_with_work(self):
        expected={'sourceRevision':'a'*40,'sourceSnapshotSha256':'b'*64,'version':'1.40.0','build':117,'ownerSha256':'c'*64};request={'protocol':1,'action':'status','nonce':'d'*64,'expected':expected}
        reply={'protocol':1,'action':'status','nonce':'d'*64,'binding':expected,'pid':123,'status':'ready','flutterReady':True,'authenticatedWorkspaceReady':True,'improvementRendered':True,'busyReasons':[],'quiescenceExpiresAt':None,'startupQuarantined':False,'quarantineExpiresAt':None,'startupDecision':'none'}
        self.assertEqual(validate_reply(reply,request,123)['status'],'ready')
        with self.assertRaisesRegex(NativeRefused,'identity_changed'):validate_reply(reply,request,456)
        reply={**reply,'status':'quiesced','action':'quiesce','busyReasons':['voice_active'],'quiescenceExpiresAt':(datetime.now(timezone.utc)+timedelta(seconds=25)).isoformat()}
        with self.assertRaisesRegex(NativeRefused,'quiescence_unproven'):validate_reply(reply,{**request,'action':'quiesce'},123)
    @unittest.skipUnless(os.uname().sysname=='Darwin','Darwin process code identity')
    def test_actual_running_code_cdhash_binding(self):
        metadata=subprocess.run(['/usr/bin/codesign','-d','--verbose=4','--arch','arm64','/bin/sleep'],capture_output=True,check=True).stderr
        expected=digest(re.search(rb'^CDHash=([a-f0-9]+)$',metadata,re.M).group(1));process=subprocess.Popen(['/bin/sleep','10'])
        try:
            running_code(process.pid,'/bin/sleep',expected)
            with self.assertRaisesRegex(NativeRefused,'signature_changed'):running_code(process.pid,'/bin/sleep','0'*64)
        finally:process.terminate();process.wait(timeout=5)
    def test_native_only_ancestry_allows_real_serving_predecessor(self):
        class Controller:
            def git(self,*args):
                if args[0]=='merge-base':return 'a'*40
                if '--raw' in args:return ':100644 100644 '+('a'*40)+' '+('b'*40)+' M\tapps/flutter/lib/features/inbox/view.dart'
                return 'apps/flutter/lib/features/inbox/view.dart'
        request={'previousRevision':'b'*40,'pairedBaseline':{'webRevision':'a'*40,'workerRevision':'a'*40,'manifestSha256':'c'*64}};observed=copy.deepcopy(request['pairedBaseline'])
        self.assertEqual(serving_baseline(Controller(),request,observed),'a'*40)
        with patch.object(Controller,'git',side_effect=['a'*40,'src/lib/auth/session.ts']):
            with self.assertRaisesRegex(NativeRefused,'native_only_ancestry'):serving_baseline(Controller(),request,observed)

        with patch.object(Controller,'git',side_effect=['a'*40,'apps/flutter/lib/features/inbox/view.dart',':100644 100755 '+('a'*40)+' '+('b'*40)+' M\tapps/flutter/lib/features/inbox/view.dart']):
            with self.assertRaisesRegex(NativeRefused,'mode_or_type'):serving_baseline(Controller(),request,observed)

if __name__=='__main__':unittest.main()
