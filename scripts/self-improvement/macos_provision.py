"""One-time offline toolchain provisioning from the reviewed SDK/cache. No secrets."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import re
import shlex
import subprocess
from urllib.parse import unquote,urlparse
from macos_manifest import canonical,digest,read_regular,require,tree_manifest
from macos_protocol import PROFILE_SHA
from macos_toolchain import ADAPTER_PATH,MANIFEST_SHIM_SHA,RSYNC_SHIM_SHA,provision_adapter

def clone_copy(source,destination):
    # APFS clone preserves storage efficiency without writable hardlinks.
    system=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
    system.clonefile.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint];system.clonefile.restype=ctypes.c_int
    if system.clonefile(os.fsencode(source),os.fsencode(destination),0)!=0:shutil.copy2(source,destination)
    return str(destination)

def copy_tree(source,destination):
    require(not Path(destination).exists(),'native_tool_snapshot_exists')
    return shutil.copytree(source,destination,symlinks=True,copy_function=clone_copy,ignore=shutil.ignore_patterns('.DS_Store'))

def manifest_reference(path,directory,name):
    manifest=tree_manifest(path,'bundle',maximum_bytes=8*1024*1024*1024,maximum_entries=300000)
    target=Path(directory)/(name+'.manifest.json');raw=canonical(manifest)+b'\n';target.write_bytes(raw);target.chmod(0o400)
    return {'path':str(Path(path).resolve()),'manifestFile':str(target),'manifestFileSha256':digest(raw)}

def generated_swift_packages(checkout,pub_cache,destination):
    """Freeze only reviewed local package inputs; no symlink can retain host access."""
    checkout=Path(checkout).resolve();pub_cache=Path(pub_cache).resolve();source=checkout/'apps/flutter/macos/Flutter/ephemeral/Packages';destination=Path(destination)
    require(not destination.exists() and not source.is_symlink() and {p.name for p in source.iterdir()}=={'.packages','FlutterGeneratedPluginSwiftPackage'},'native_generated_packages_layout_changed')
    require(all((source/name).is_dir() and not (source/name).is_symlink() for name in ('.packages','FlutterGeneratedPluginSwiftPackage')),'native_generated_packages_container_changed')
    destination.mkdir(mode=0o700);copy_tree(source/'FlutterGeneratedPluginSwiftPackage',destination/'FlutterGeneratedPluginSwiftPackage');(destination/'.packages').mkdir(mode=0o700)
    allowed=[pub_cache,checkout/'apps/flutter/build/macos/SourcePackages',source/'.packages/FlutterFramework'];packages=list((source/'.packages').iterdir())
    require(1<=len(packages)<=100,'native_generated_packages_bounds')
    for package in packages:
        require(re.fullmatch(r'[A-Za-z0-9_.+-]{1,150}',package.name),'native_generated_package_name_invalid');resolved=package.resolve()
        require(resolved.is_dir() and any(resolved==root or resolved.is_relative_to(root) for root in allowed),'native_generated_package_source_forbidden')
        copy_tree(resolved,destination/'.packages'/package.name)
    return manifest_reference(destination,destination.parent,'generated-swift-packages')

def write_sdk_launchers(sdk,adapter):
    """Both Xcode launchers use the pinned runtime, without Git/upgrades."""
    sdk=Path(sdk).resolve();dart=sdk/'bin/cache/dart-sdk/bin/dart'
    require(Path(adapter['dartExecutable']).resolve()==dart.resolve(),'native_sdk_launcher_runtime_changed')
    commands={'flutter':[str(dart),'--packages='+adapter['packageConfig'],adapter['entrypoint']],'dart':[str(dart)]}
    for name,argv in commands.items():
        target=sdk/'bin'/name;require(not target.is_symlink(),'native_sdk_launcher_symlink')
        target.write_text('#!/bin/sh\nexec '+' '.join(shlex.quote(value) for value in argv)+' "$@"\n');target.chmod(0o755)

def provision(checkout,sdk,pub_cache,swift_cache,developer,destination):
    checkout=Path(checkout).resolve();sdk=Path(sdk).resolve();pub_cache=Path(pub_cache).resolve();developer=Path(developer).resolve();destination=Path(destination).absolute()
    require(not destination.exists() and not destination.is_relative_to(checkout),'native_toolchain_destination_invalid');destination.mkdir(mode=0o700,parents=True)
    copied_sdk=destination/'flutter';copy_tree(sdk,copied_sdk)
    if (copied_sdk/'.git').exists():shutil.rmtree(copied_sdk/'.git')
    copied_pub=destination/'pub-cache';copied_pub.mkdir(mode=0o700)
    package_configs=[sdk/'packages/flutter_tools/.dart_tool/package_config.json',checkout/'apps/flutter/.dart_tool/package_config.json'];roots=set()
    for file in package_configs:
        for package in json.loads(read_regular(file))['packages']:
            uri=package['rootUri'];parsed=urlparse(uri);root=Path(unquote(parsed.path)) if parsed.scheme=='file' else (file.parent/unquote(uri)).resolve()
            if root.is_relative_to(pub_cache):roots.add(root)
            else:require(root.is_relative_to(sdk) or root==checkout/'apps/flutter','native_dependency_root_outside_reviewed_cache')
    for root in sorted(roots):
        target=copied_pub/root.relative_to(pub_cache);target.parent.mkdir(parents=True,exist_ok=True);copy_tree(root,target)
    replacements=[(sdk,copied_sdk),(pub_cache,copied_pub)]
    adapter=provision_adapter(copied_sdk,destination/'flutter-adapter',digest(read_regular(copied_sdk/'packages/flutter_tools'/ADAPTER_PATH)),replacements)
    write_sdk_launchers(copied_sdk,adapter)
    deps=destination/'dependencies';deps.mkdir(mode=0o700);files=[]
    for relative in ('.dart_tool/package_config.json','.dart_tool/package_graph.json','.flutter-plugins-dependencies'):
        original=checkout/'apps/flutter'/relative;require(original.is_file(),'native_dependency_metadata_missing');raw=read_regular(original)
        if relative=='.dart_tool/package_config.json':
            data=json.loads(raw)
            for package in data['packages']:
                uri=package['rootUri'];parsed=urlparse(uri);root=Path(unquote(parsed.path)) if parsed.scheme=='file' else (original.parent/unquote(uri)).resolve()
                for old,new in replacements:
                    if root.is_relative_to(old):root=new/root.relative_to(old);break
                package['rootUri']=root.as_uri()+'/'
            raw=canonical(data)
        for old,new in replacements:raw=raw.replace(str(old).encode(),str(new).encode())
        target=deps/(str(len(files))+'.json');target.write_bytes(raw);target.chmod(0o400);files.append({'target':relative,'path':str(target),'sha256':digest(raw)})
    copied_swift=destination/'SourcePackages';copy_tree(swift_cache,copied_swift)
    generated_ref=generated_swift_packages(checkout,pub_cache,destination/'generated-swift-packages')
    trees=[manifest_reference(copied_sdk,destination,'sdk'),manifest_reference(copied_pub,destination,'pub'),manifest_reference(destination/'flutter-adapter',destination,'adapter')]
    swift_ref={**manifest_reference(copied_swift,destination,'swift'),'workspaceStateOrigin':str(Path(swift_cache).resolve())}
    version=subprocess.run(['/usr/bin/xcodebuild','-version'],env={'PATH':'/usr/bin:/bin','DEVELOPER_DIR':str(developer),'HOME':'/var/empty'},capture_output=True,check=True).stdout;pins=[]
    compiler=developer/'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'
    for file in (developer/'usr/bin/xcodebuild',developer/'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang',developer/'Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend',compiler,developer/'Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-driver',Path('/usr/bin/rsync'),Path('/opt/homebrew/opt/node@24/bin/node')):
        resolved=file.resolve();pins.append({'path':str(resolved),'sha256':digest(read_regular(resolved,1024*1024*1024))})
    sdk_path=(developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk').resolve();require(sdk_path.is_relative_to(developer),'native_macos_sdk_identity_changed')
    sdk_identity={'path':str(sdk_path),'settings':[{'path':str(sdk_path/name),'sha256':digest(read_regular(sdk_path/name))} for name in ('SDKSettings.json','SDKSettings.plist')]}
    body={'version':1,'profileSha256':PROFILE_SHA,'sdk':str(copied_sdk),'pubCache':str(copied_pub),'developerDirectory':str(developer),'xcodeVersionSha256':digest(version),
          'dartExecutable':adapter['dartExecutable'],'entrypoint':adapter['entrypoint'],'packageConfig':adapter['packageConfig'],'adapterPatchSha256':adapter['adapterPatchSha256'],'originalAdapterSourceSha256':adapter['originalAdapterSourceSha256'],
          'originalXcodeAdapterSourceSha256':adapter['originalXcodeAdapterSourceSha256'],'swiftCompiler':str(compiler),'swiftCompilerResolved':str(compiler.resolve()),'swiftManifestShimSha256':MANIFEST_SHIM_SHA,'rsyncShimSha256':RSYNC_SHIM_SHA,
          'trees':trees,'files':pins,'macosSdk':sdk_identity,'additionalReadOnlyRoots':[],
          'dependencies':{'sourceSha256':{name:digest(read_regular(checkout/'apps/flutter'/name)) for name in ('pubspec.yaml','pubspec.lock','macos/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved')},'files':files,'swiftCache':swift_ref,'generatedSwiftPackages':generated_ref}}
    config={**body,'toolchainSha256':digest(body)};target=destination/'toolchain.json';target.write_bytes(canonical(config)+b'\n');target.chmod(0o400);return target
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for field in ('checkout','sdk','pub-cache','swift-cache','developer','destination'):parser.add_argument('--'+field,required=True)
    args=parser.parse_args();print(provision(args.checkout,args.sdk,args.pub_cache,args.swift_cache,args.developer,args.destination))
