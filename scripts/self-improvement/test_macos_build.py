from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from macos_manifest import NativeRefused,digest
from macos_provision import generated_swift_packages,write_sdk_launchers
from macos_build import provision_generated_packages,prepare_native_build,relocate_swift_artifacts,validate_workspace_projection
from macos_toolchain import MANIFEST_SHIM_SHA,RSYNC_SHIM_SHA,RSYNC_SHIM,XCODE_ORIGINAL,patch_xcode_adapter
import macos_build as B

class NativeBuildPrerequisites(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
    def package_fixture(self):
        checkout=self.root/'checkout';source=checkout/'apps/flutter/macos/Flutter/ephemeral/Packages';generated=source/'FlutterGeneratedPluginSwiftPackage';generated.mkdir(parents=True);(generated/'Package.swift').write_text('reviewed generated package')
        (source/'.packages').mkdir();pub=self.root/'pub';plugin=pub/'fixture';plugin.mkdir(parents=True);(plugin/'Package.swift').write_text('reviewed plugin')
        (source/'.packages/fixture').symlink_to(plugin,target_is_directory=True)
        return checkout,pub,source
    def test_generated_package_closure_is_real_and_drift_rejects_before_use(self):
        checkout,pub,source=self.package_fixture();ref=generated_swift_packages(checkout,pub,self.root/'frozen');config={'dependencies':{'generatedSwiftPackages':ref}}
        target=self.root/'candidate';provision_generated_packages(target,config);copied=target/'apps/flutter/macos/Flutter/ephemeral/Packages/.packages/fixture'
        self.assertFalse(copied.is_symlink());self.assertEqual((copied/'Package.swift').read_text(),'reviewed plugin')
        (self.root/'frozen/.packages/fixture/Package.swift').write_text('changed package')
        with self.assertRaisesRegex(NativeRefused,'native_tree_changed'):provision_generated_packages(self.root/'another',config)
        self.assertFalse((self.root/'another').exists())
    def test_foreign_generated_package_source_is_refused(self):
        checkout,pub,source=self.package_fixture();link=source/'.packages/fixture';link.unlink();foreign=self.root/'foreign';foreign.mkdir();(foreign/'Package.swift').write_text('not an approved dependency');link.symlink_to(foreign,target_is_directory=True)
        with self.assertRaisesRegex(NativeRefused,'source_forbidden'):generated_swift_packages(checkout,pub,self.root/'frozen')
    def test_manifest_shim_restores_private_paths_and_preserves_arguments(self):
        root=self.root/'source with spaces';home=self.root/'home with spaces';root.mkdir();home.mkdir();compiler=self.root/'swiftc fixture';compiler.write_text('#!/bin/sh\nprintf "%s\\n" "$TMPDIR" "$HOME" "$@"\n');compiler.chmod(0o500)
        relative='macos/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved';lock=root/'apps/flutter'/relative;lock.parent.mkdir(parents=True);lock.write_text('{"pins":[]}');(root/'apps/flutter/macos/Runner.xcworkspace/contents.xcworkspacedata').write_text('<Workspace version="1.0"><FileRef location="group:Runner.xcodeproj"/></Workspace>')
        config={'swiftCompiler':str(compiler),'swiftCompilerResolved':str(compiler),'files':[{'path':str(compiler)},{'path':'/usr/bin/rsync'}],'swiftManifestShimSha256':MANIFEST_SHIM_SHA,'rsyncShimSha256':RSYNC_SHIM_SHA,'dependencies':{'sourceSha256':{relative:digest(lock.read_bytes())}}}
        env=prepare_native_build(root,home,config);wrapper=Path(env['SWIFT_EXEC_MANIFEST'])
        run=subprocess.run([str(wrapper),'--example=a b','literal;$(not-executed)'],env={},capture_output=True,check=True,text=True)
        self.assertEqual(run.stdout.splitlines(),[str(home/'tmp')+'/',str(home),'-module-cache-path',str(home/'SwiftModuleCache'),'--example=a b','literal;$(not-executed)'])
        self.assertFalse(wrapper.is_relative_to(home));self.assertEqual(wrapper.stat().st_mode&0o777,0o500);self.assertEqual(env['ASAEL_NATIVE_FIXED_BUILD'],'1')
        self.assertEqual(env['PATH'],str(wrapper.parent)+':/usr/bin:/bin:/usr/sbin:/sbin');self.assertEqual((wrapper.parent/'rsync').read_text(),RSYNC_SHIM)
        self.assertEqual((root/'apps/flutter/macos/Runner.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved').read_bytes(),lock.read_bytes())
        with self.assertRaisesRegex(NativeRefused,'already_present'):prepare_native_build(root,home,config)
    def test_workspace_projection_refuses_extra_projects_and_alternate_references(self):
        file=self.root/'apps/flutter/macos/Runner.xcworkspace/contents.xcworkspacedata';file.parent.mkdir(parents=True)
        valid='<Workspace version="1.0"><FileRef location="group:Runner.xcodeproj"/></Workspace>';file.write_text(valid);self.assertEqual(validate_workspace_projection(self.root),digest(file.read_bytes()))
        for text in (valid.replace('</Workspace>','<FileRef location="group:Other.xcodeproj"/></Workspace>'),valid.replace('group:Runner.xcodeproj','absolute:/foreign/Runner.xcodeproj'),valid.replace('<FileRef','<Group'),'<broken', '<!DOCTYPE Workspace>'+valid):
            with self.subTest(text=text):
                file.write_text(text)
                with self.assertRaisesRegex(NativeRefused,'projection_changed'):validate_workspace_projection(self.root)
    def test_both_sdk_launchers_use_fixed_runtime_without_git_or_upgrade(self):
        sdk=self.root/'SDK with spaces';runtime=sdk/'bin/cache/dart-sdk/bin/dart';runtime.parent.mkdir(parents=True);runtime.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n');runtime.chmod(0o500)
        adapter={'dartExecutable':str(runtime),'packageConfig':'/pinned/packages.json','entrypoint':'/pinned/adapter.dart'};write_sdk_launchers(sdk,adapter)
        dart=subprocess.run([str(sdk/'bin/dart'),'backend.dart','a b'],env={},capture_output=True,check=True,text=True);self.assertEqual(dart.stdout.splitlines(),['backend.dart','a b'])
        flutter=subprocess.run([str(sdk/'bin/flutter'),'assemble','a b'],env={},capture_output=True,check=True,text=True);self.assertEqual(flutter.stdout.splitlines(),['--packages=/pinned/packages.json','/pinned/adapter.dart','assemble','a b'])
        with self.assertRaisesRegex(NativeRefused,'runtime_changed'):write_sdk_launchers(sdk,{**adapter,'dartExecutable':'/foreign/dart'})
    def test_rsync_override_is_after_archive_flags_and_rejects_option_separator(self):
        wrapper=self.root/'rsync';wrapper.write_text(RSYNC_SHIM);wrapper.chmod(0o500)
        self.assertIn('"$@" --no-owner --no-group',wrapper.read_text())
        run=subprocess.run([str(wrapper),'-a','--','/should/not/be/read','/must/not/be/written'],env={},capture_output=True)
        self.assertEqual(run.returncode,64);self.assertEqual(run.stdout,b'');self.assertEqual(run.stderr,b'')
    def test_xcode_override_is_fixed_and_guarded_by_build_environment(self):
        result=patch_xcode_adapter(XCODE_ORIGINAL.encode());self.assertIn("_platform.environment['ASAEL_NATIVE_FIXED_BUILD'] == '1'",result)
        for flag in ('-IDEPackageSupportDisableManifestSandbox=YES','-disableAutomaticPackageResolution','-onlyUsePackageVersionsFromResolvedFile','-skipPackageUpdates'):self.assertIn(flag,result)
        with self.assertRaisesRegex(NativeRefused,'source_changed'):patch_xcode_adapter((XCODE_ORIGINAL*2).encode())
    def test_cached_artifact_relocation_is_confined_and_preserves_version_and_checksum(self):
        cache=self.root/'cache';artifact=cache/'artifacts/a/tool.xcframework';artifact.mkdir(parents=True);origin='/original/SourcePackages';entry={'path':origin+'/artifacts/a/tool.xcframework','source':{'checksum':'reviewed'},'version':'1.2.3'};state=cache/'workspace-state.json';state.write_text(json.dumps({'object':{'artifacts':[entry]},'version':7}))
        relocate_swift_artifacts(cache,origin);actual=json.loads(state.read_text());self.assertEqual(actual['object']['artifacts'][0],{**entry,'path':str(artifact)});self.assertEqual(actual['version'],7)
        actual['object']['artifacts'][0]['path']='/foreign/artifact';state.write_text(json.dumps(actual));before=state.read_bytes()
        with self.assertRaisesRegex(NativeRefused,'path_forbidden'):relocate_swift_artifacts(cache,origin)
        self.assertEqual(state.read_bytes(),before)
    def test_build_gets_fresh_source_and_home_after_executable_tests(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/native-validation-v1.json').read_text());request=fixture['request'];request['purpose']='candidate';folder=self.root/'validation';seen=[];materialized=[]
        def materialize(repo,target,req,payload):
            target.mkdir();(target/'apps/flutter').mkdir(parents=True);materialized.append(target);return []
        def run(argv,cwd,env,log,timeout):
            command=argv[-1];seen.append((command,cwd,env['HOME']))
            if command=='macos_test_focused':
                (cwd/'.dart_tool').mkdir(exist_ok=True);(cwd/'.dart_tool/poison').write_text('executable test leftover')
            if command=='macos_build':
                self.assertEqual(cwd,folder/'build-source/apps/flutter');self.assertEqual(Path(env['HOME']),folder/'build-home');self.assertFalse((cwd/'.dart_tool/poison').exists());return 1,b'fixture compilation failure',1
            return 0,b'fixture check',1
        config={'sdk':'/fixed/sdk','pubCache':'/fixed/pub','entrypoint':'/fixed/tool/bin/flutter_tools.dart','developerDirectory':'/Applications/Xcode.app/Contents/Developer'}
        with ExitStack() as stack:
            stack.enter_context(patch.object(B,'verify_toolchain',return_value='a'*64));stack.enter_context(patch.object(B,'materialize',side_effect=materialize));stack.enter_context(patch.object(B,'provision_dependencies'))
            stack.enter_context(patch.object(B,'prepare_native_build',return_value={}))
            stack.enter_context(patch.object(B,'verify_admitted_rows',return_value=request['snapshot']['workspaceSha256']));stack.enter_context(patch.object(B,'fixed_commands',side_effect=lambda command,*args:[[command]]));stack.enter_context(patch.object(B,'run_bounded',side_effect=run));stack.enter_context(patch.object(B,'validate_receipt'));stack.enter_context(patch.object(B,'parse_test_output',return_value={'totalTests':1,'passedTests':1,'failedTests':0,'pendingTests':0,'executedPaths':[]}))
            receipt=B.validate_snapshot(self.root,folder,request,{},config,fixture['receipt']['installedBaseline'],fixture['receipt']['pairedBaseline'],'fixture')
        self.assertEqual([row[0] for row in seen],['macos_analyze','macos_test_focused','macos_test_focused','macos_build']);self.assertEqual(materialized,[folder/'source',folder/'build-source']);self.assertEqual(len(receipt['checks']),4);self.assertIsNone(receipt['artifact'])

if __name__=='__main__':unittest.main()
