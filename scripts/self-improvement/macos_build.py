"""Fixed credential-free Mac checks. Candidate source never selects commands."""
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import time
import xml.etree.ElementTree as ET
from macos_manifest import NativeRefused,bundle_identity,canonical,digest,read_regular,require,seal,tree_manifest,verify_manifest
from macos_protocol import PROFILE_SHA,command_policy,request_checks,utcnow,validate_receipt
from macos_sandbox import sandbox_profile,clean_environment,choose_test_port
from macos_source import materialize,verify_admitted_rows
from macos_toolchain import MANIFEST_SHIM,MANIFEST_SHIM_SHA,RSYNC_SHIM,RSYNC_SHIM_SHA

MAX_OUTPUT=16*1024*1024

def parse_test_output(raw,root,paths,exit_code):
    suites={};tests={};done={};ended=False
    for line in raw.decode('utf-8',errors='replace').splitlines():
        if not line.startswith('{'):continue
        try:event=json.loads(line)
        except ValueError:continue
        kind=event.get('type')
        if kind=='suite':suites[event['suite']['id']]=event['suite']['path']
        if kind=='testStart':tests[event['test']['id']]=event['test']
        if kind=='testDone':
            require(event['testID'] not in done,'native_test_duplicate_done');done[event['testID']]=event
        if kind=='done':ended=True
    require(ended,'native_test_report_incomplete')
    counts={'totalTests':0,'passedTests':0,'failedTests':0,'pendingTests':0};executed=set()
    for test_id,event in done.items():
        if event.get('hidden'):continue
        test=tests.get(test_id);require(test and test['suiteID'] in suites,'native_test_suite_missing')
        absolute=Path(suites[test['suiteID']]).resolve();require(absolute.is_relative_to(Path(root).resolve()),'native_test_foreign_suite')
        path=absolute.relative_to(Path(root).resolve()).as_posix();require(path in paths,'native_test_foreign_suite');executed.add(path)
        counts['totalTests']+=1
        if event.get('skipped'):counts['pendingTests']+=1
        elif event.get('result')=='success':counts['passedTests']+=1
        elif event.get('result') in ('failure','error'):counts['failedTests']+=1
        else:raise NativeRefused('native_test_result_unknown')
    require(counts['totalTests']>0 and executed==set(paths) and counts['pendingTests']==0,'native_test_no_executed_cases')
    require((exit_code==0)==(counts['failedTests']==0),'native_test_exit_conflict')
    return {**counts,'executedPaths':sorted(executed)}

def run_bounded(argv,cwd,env,log,timeout=900):
    path=Path(log);require(not path.exists(),'native_check_log_exists')
    started=time.monotonic()
    with path.open('xb') as stream:
        process=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            while process.poll() is None:
                if time.monotonic()-started>timeout or path.stat().st_size>MAX_OUTPUT:
                    os.killpg(process.pid,signal.SIGTERM)
                    try:process.wait(timeout=5)
                    except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
                    raise NativeRefused('native_check_timeout_or_output_limit')
                time.sleep(.1)
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=5)
    raw=read_regular(path,MAX_OUTPUT);return process.returncode,raw,round((time.monotonic()-started)*1000)

def verify_toolchain(config):
    require(config.get('version')==1 and config.get('profileSha256')==PROFILE_SHA,'native_toolchain_profile_changed')
    body={key:value for key,value in config.items() if key!='toolchainSha256'}
    require(config.get('toolchainSha256')==digest(body),'native_toolchain_fingerprint_changed')
    # Each frozen compiler, SDK, dependency tree, wrapper and Xcode metadata input
    # is pinned by the installer. The controller never follows candidate settings.
    require(config.get('trees') and config.get('files'),'native_toolchain_pins_missing')
    for tree in config['trees']:
        manifest=tree.get('manifest')
        if manifest is None:
            raw=read_regular(tree['manifestFile'],64*1024*1024);require(digest(raw)==tree['manifestFileSha256'],'native_toolchain_manifest_changed');manifest=json.loads(raw)
        verify_manifest(tree['path'],manifest,'bundle',maximum_bytes=8*1024*1024*1024,maximum_entries=300000)
    for file in config['files']:require(digest(read_regular(file['path'],1024*1024*1024))==file['sha256'],'native_toolchain_file_changed')
    if config.get('swiftCompiler'):
        compiler=Path(config['swiftCompiler']);require(compiler.is_absolute() and str(compiler.resolve())==config.get('swiftCompilerResolved') and config['swiftCompilerResolved'] in {file['path'] for file in config['files']} and config.get('swiftManifestShimSha256')==MANIFEST_SHIM_SHA,'native_swift_compiler_unpinned')
    if config.get('rsyncShimSha256'):
        require(config['rsyncShimSha256']==RSYNC_SHIM_SHA and '/usr/bin/rsync' in {file['path'] for file in config['files']},'native_rsync_unpinned')
    if config.get('assetCache'):
        from macos_assets import read_asset_cache
        asset=read_asset_cache(config['assetCache']);require(asset['compiler'] in {file['path'] for file in config['files']},'native_asset_compiler_unpinned')
    for field in ('dartExecutable','entrypoint','packageConfig','sdk','pubCache','developerDirectory'):
        require(Path(config[field]).is_absolute(),'native_toolchain_path_invalid')
    version=subprocess.run(['/usr/bin/xcodebuild','-version'],env={'PATH':'/usr/bin:/bin','HOME':'/var/empty','DEVELOPER_DIR':config['developerDirectory']},capture_output=True,timeout=30)
    require(version.returncode==0 and digest(version.stdout)==config['xcodeVersionSha256'],'native_xcode_version_changed')
    sdk=config.get('macosSdk',{});selected=(Path(config['developerDirectory'])/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk').resolve()
    require(sdk.get('path')==str(selected) and selected.is_relative_to(Path(config['developerDirectory']).resolve()) and sdk.get('settings'),'native_macos_sdk_identity_changed')
    require({Path(item['path']).name for item in sdk['settings']}=={'SDKSettings.json','SDKSettings.plist'} and len(sdk['settings'])==2,'native_macos_sdk_metadata_missing')
    for item in sdk['settings']:
        require(Path(item['path']).parent==selected and digest(read_regular(item['path']))==item['sha256'],'native_macos_sdk_metadata_changed')
    return config['toolchainSha256']

def provision_dependencies(root,home,config):
    """Use a reviewed cache for the unchanged pubspec/lock, no package resolution."""
    app=Path(root)/'apps/flutter';cache=config['dependencies']
    for name in ('pubspec.yaml','pubspec.lock'):
        require(digest(read_regular(app/name))==cache['sourceSha256'][name],'native_dependency_source_changed')
    for item in cache['files']:
        relative=item['target'];require(relative in ('.dart_tool/package_config.json','.dart_tool/package_graph.json','.flutter-plugins-dependencies'),'native_dependency_target_forbidden')
        raw=read_regular(item['path'],128*1024*1024);require(digest(raw)==item['sha256'],'native_dependency_cache_changed')
        if relative=='.dart_tool/package_config.json':
            data=json.loads(raw)
            for package in data['packages']:
                if package['name']=='asael':package['rootUri']=app.as_uri()+'/'
                else:require(package['rootUri'].startswith('file:'),'native_dependency_relative_root_forbidden')
            raw=canonical(data)
        destination=app/relative;destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True);destination.write_bytes(raw)

    if cache.get('generatedSwiftPackages'):provision_generated_packages(root,config)

    if cache.get('swiftCache'):
        from macos_provision import copy_tree
        pinned=cache['swiftCache'];raw=read_regular(pinned['manifestFile'],64*1024*1024);require(digest(raw)==pinned['manifestFileSha256'],'native_swift_cache_manifest_changed')
        verify_manifest(pinned['path'],json.loads(raw),'bundle',maximum_bytes=8*1024*1024*1024,maximum_entries=300000)
        copy_tree(pinned['path'],Path(home)/'SourcePackages')
        if pinned.get('workspaceStateOrigin'):relocate_swift_artifacts(Path(home)/'SourcePackages',pinned['workspaceStateOrigin'])
        # Flutter's config-only prefetch uses build/macos/SourcePackages. Point
        # that fixed location at the same private cache used by xcodebuild.
        flutter_cache=app/'build/macos/SourcePackages';flutter_cache.parent.mkdir(parents=True,exist_ok=True)
        require(not flutter_cache.exists() and not flutter_cache.is_symlink(),'native_flutter_swift_cache_exists')
        flutter_cache.symlink_to(Path(home)/'SourcePackages',target_is_directory=True)

def relocate_swift_artifacts(cache,origin):
    """Relocate only the pinned cache's artifact paths, never URLs or versions."""
    cache=Path(cache).resolve();origin=Path(origin)
    require(origin.is_absolute(),'native_swift_cache_origin_invalid')
    target=cache/'workspace-state.json';data=json.loads(read_regular(target,16*1024*1024));artifacts=data.get('object',{}).get('artifacts')
    require(isinstance(artifacts,list) and len(artifacts)<=100,'native_swift_artifact_state_invalid')
    for item in artifacts:
        path=Path(item['path']);require(path.is_absolute() and '..' not in path.parts and path.is_relative_to(origin/'artifacts'),'native_swift_artifact_path_forbidden')
        relocated=cache/path.relative_to(origin);require(relocated.exists() and relocated.resolve().is_relative_to(cache/'artifacts'),'native_swift_artifact_missing')
        item['path']=str(relocated)
    target.write_bytes(canonical(data)+b'\n')

def prepare_native_build(root,home,config):
    """Xcode drops the manifest child's environment; restore fixed private paths."""
    root=Path(root).resolve();home=Path(home).resolve();compiler=Path(config['swiftCompiler'])
    validate_workspace_projection(root)
    require(str(compiler.resolve())==config['swiftCompilerResolved'] and config['swiftCompilerResolved'] in {file['path'] for file in config['files']} and config['swiftManifestShimSha256']==MANIFEST_SHIM_SHA,'native_swift_compiler_unpinned')
    directory=root/'.asael-native-tools';require(not directory.exists(),'native_build_tools_already_present');directory.mkdir(mode=0o700)
    wrapper=directory/'swiftc-manifest';raw=MANIFEST_SHIM.format(tmp=shlex.quote(str(home/'tmp')+'/'),home=shlex.quote(str(home)),compiler=shlex.quote(str(compiler)),cache=shlex.quote(str(home/'SwiftModuleCache'))).encode();wrapper.write_bytes(raw);wrapper.chmod(0o500)
    lock=root/'apps/flutter/macos/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved';expected=config['dependencies']['sourceSha256']['macos/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved'];raw=read_regular(lock);require(digest(raw)==expected,'native_swift_lock_changed')
    target=root/'apps/flutter/macos/Runner.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved';require(not target.exists(),'native_generated_swift_lock_exists');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
    install_rsync_shim(directory,config)
    if config.get('assetCache'):
        from macos_assets import prepare_asset_cache
        prepare_asset_cache(root,home,directory,config['assetCache'])
    directory.chmod(0o500)
    return {'SWIFT_EXEC_MANIFEST':str(wrapper),'ASAEL_NATIVE_FIXED_BUILD':'1','PATH':str(directory)+':/usr/bin:/bin:/usr/sbin:/sbin'}

def install_rsync_shim(directory,config):
    require(config.get('rsyncShimSha256')==RSYNC_SHIM_SHA and '/usr/bin/rsync' in {file['path'] for file in config['files']},'native_rsync_unpinned')
    target=Path(directory)/'rsync';require(not target.exists() and not target.is_symlink(),'native_rsync_shim_exists');target.write_text(RSYNC_SHIM);target.chmod(0o500)

def validate_workspace_projection(root):
    # The workspace adds no targets or schemes: avoid LaunchServices-dependent
    # workspace type discovery without granting candidate code host services.
    raw=read_regular(Path(root)/'apps/flutter/macos/Runner.xcworkspace/contents.xcworkspacedata',4096)
    require(b'<!DOCTYPE' not in raw.upper() and b'<!ENTITY' not in raw.upper(),'native_workspace_projection_changed')
    try:workspace=ET.fromstring(raw)
    except ET.ParseError:raise NativeRefused('native_workspace_projection_changed') from None
    children=list(workspace)
    require(workspace.tag=='Workspace' and workspace.attrib=={'version':'1.0'} and len(children)==1 and not (workspace.text or '').strip(),'native_workspace_projection_changed')
    reference=children[0]
    require(reference.tag=='FileRef' and reference.attrib=={'location':'group:Runner.xcodeproj'} and not list(reference) and not (reference.text or '').strip() and not (reference.tail or '').strip(),'native_workspace_projection_changed')
    return digest(raw)

def provision_generated_packages(root,config):
    from macos_provision import copy_tree
    pinned=config['dependencies']['generatedSwiftPackages'];raw=read_regular(pinned['manifestFile'],64*1024*1024)
    require(digest(raw)==pinned['manifestFileSha256'],'native_generated_packages_manifest_changed')
    manifest=json.loads(raw);verify_manifest(pinned['path'],manifest,'bundle',maximum_bytes=8*1024*1024*1024,maximum_entries=300000)
    target=Path(root)/'apps/flutter/macos/Flutter/ephemeral/Packages';target.parent.mkdir(parents=True,exist_ok=True);copy_tree(pinned['path'],target);verify_manifest(target,manifest,'bundle',maximum_bytes=8*1024*1024*1024,maximum_entries=300000)

def fixed_commands(command,paths,root,home,config,baseline,snapshot_sha):
    app=Path(root)/'apps/flutter';relative=[str(Path(path).relative_to('apps/flutter')) for path in paths]
    flutter=[config['dartExecutable'],'--packages='+config['packageConfig'],config['entrypoint'],'--no-version-check']
    if command=='macos_analyze':return [[*flutter,'analyze','--no-pub','--no-fatal-infos',*relative]]
    if command=='macos_test_focused':return [[*flutter,'test','--no-pub','--no-enable-vmservice','--disable-dds','--concurrency=1','--reporter=json',*relative]]
    require(command=='macos_build','native_command_forbidden')
    build=str(int(baseline['buildNumber'])+1)
    return [[*flutter,'build','macos','--config-only','--release','--no-pub','--build-name='+baseline['version'],'--build-number='+build,'--dart-define=ASAEL_SOURCE_SNAPSHOT_SHA256='+snapshot_sha],
            ['/usr/bin/xcodebuild','-jobs','1','-quiet','-project',str(app/'macos/Runner.xcodeproj'),'-scheme','Runner','-configuration','Release','-derivedDataPath',str(Path(home)/'DerivedData'),'-destination','generic/platform=macOS','-IDEPackageSupportDisableManifestSandbox=YES','-disableAutomaticPackageResolution','-onlyUsePackageVersionsFromResolvedFile','-skipPackageUpdates','-clonedSourcePackagesDirPath',str(Path(home)/'SourcePackages'),'SDKROOT='+config['macosSdk']['path'],*(['ASSETCATALOG_EXEC='+str(Path(root)/'.asael-native-tools/actool')] if config.get('assetCache') else []),'CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO','CODE_SIGN_IDENTITY=','ARCHS=arm64','ONLY_ACTIVE_ARCH=YES','build']]

def validate_snapshot(git_root,directory,request,payload,config,baseline,paired,controller_id):
    require(request.get('profileSha256')==PROFILE_SHA,'native_request_profile_changed')
    folder=Path(directory);require(not folder.exists(),'native_validation_directory_exists');folder.mkdir(mode=0o700,parents=True)
    root=folder/'source';home=folder/'home';home.mkdir(mode=0o700);(home/'tmp').mkdir(mode=0o700)
    toolchain=verify_toolchain(config);rows=materialize(git_root,root,request,payload);provision_dependencies(root,home,config)
    checks=[];artifact=None;port=choose_test_port()
    readable=[config['sdk'],config['pubCache'],str(Path(config['entrypoint']).parent.parent),*config.get('additionalReadOnlyRoots',[])]
    for command,purpose,paths in request_checks(request):
        if command=='macos_build':
            # Executable tests cannot seed generated inputs for the signed artifact.
            root=folder/'build-source';home=folder/'build-home';home.mkdir(mode=0o700);(home/'tmp').mkdir(mode=0o700)
            rows=materialize(git_root,root,request,payload);provision_dependencies(root,home,config)
        before=verify_admitted_rows(root,rows);started=utcnow();exit_code=0;all_output=b'';duration=0
        profile=folder/(str(len(checks))+'-check.sb');profile.write_text(sandbox_profile(root,home,readable,port=port if command=='macos_test_focused' else None,developer_directory=config['developerDirectory']))
        env=clean_environment(home,config['sdk'],config['pubCache'],port=port if command=='macos_test_focused' else None,developer_directory=config['developerDirectory'])
        if command=='macos_build':env.update(prepare_native_build(root,home,config))
        for index,argv in enumerate(fixed_commands(command,paths,root,home,config,baseline,request['snapshot']['workspaceSha256'])):
            exit_code,raw,elapsed=run_bounded(['/usr/bin/sandbox-exec','-f',str(profile),*argv],root/'apps/flutter',env,folder/f'{len(checks)}-{index}.log',timeout=1800 if command=='macos_build' else 900)
            all_output+=raw;duration+=elapsed
            if exit_code:break
        check={'command':command,'paths':paths,'policySha256':command_policy(command,purpose,paths),'exitCode':exit_code,'durationMs':duration,'outputSha256':digest(all_output),'outputTail':all_output.decode('utf-8',errors='replace')[-4000:],'workspaceBeforeSha256':before,'workspaceAfterSha256':verify_admitted_rows(root,rows),'startedAt':started,'completedAt':utcnow()}
        if purpose:check['purpose']=purpose
        if command=='macos_test_focused':
            try:check['testSummary']=parse_test_output(all_output,root,paths,exit_code)
            except (NativeRefused,ValueError,KeyError,TypeError):
                # The command completed, but compilation/empty/malformed output
                # is not executed test evidence. Preserve its real exit code.
                check['testReportFailure']='unproven_test_report'
        checks.append(check)
    if request['purpose']=='candidate' and all(check['exitCode']==0 and not check.get('testReportFailure') for check in checks):
        bundles=list((home/'DerivedData/Build/Products/Release').glob('*.app'));require(len(bundles)==1,'native_unsigned_bundle_ambiguous')
        bundle=bundles[0];identity=bundle_identity(bundle);require(identity['CFBundleIdentifier']=='app.omniagent.omniagent' and identity['CFBundleShortVersionString']==baseline['version'] and identity['CFBundleVersion']==str(int(baseline['buildNumber'])+1),'native_unsigned_bundle_identity_changed')
        manifest=tree_manifest(bundle,'bundle');(folder/'unsigned-bundle-manifest.json').write_bytes(canonical(manifest)+b'\n')
        artifact=seal('native_artifact',{'artifactId':'native_artifact_'+request['requestId'][12:],'unsignedBundleSha256':manifest['manifestSha256'],'bundleIdentifier':'app.omniagent.omniagent','version':identity['CFBundleShortVersionString'],'buildNumber':identity['CFBundleVersion'],'sourceManifestSha256':request['snapshot']['workspaceSha256'],'toolchainSha256':toolchain,'builderProfileSha256':PROFILE_SHA,'architecture':'arm64'},'artifactSha256')
        (folder/'artifact-location.json').write_bytes(canonical({'artifact':artifact,'path':str(bundle),'manifest':manifest})+b'\n')
    verify_toolchain(config)
    receipt=seal('native_validation_receipt',{'version':1,'requestId':request['requestId'],'requestSha256':request['requestSha256'],'snapshotSha256':request['snapshot']['snapshotSha256'],'controllerId':controller_id,'workspaceSha256':request['snapshot']['workspaceSha256'],'toolchainSha256':toolchain,'builderProfileSha256':PROFILE_SHA,'checks':checks,'artifact':artifact,'installedBaseline':baseline,'pairedBaseline':paired,'completedAt':utcnow()},'receiptSha256')
    validate_receipt(request,receipt);(folder/'receipt.json').write_bytes(canonical(receipt)+b'\n');return receipt
