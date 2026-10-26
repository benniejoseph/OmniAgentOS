"""Install a fixed Flutter socket adapter beside (never into) the SDK."""
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlparse, unquote
from macos_manifest import digest, read_regular, require, tree_manifest

ADAPTER_PATH='lib/src/test/flutter_tester_device.dart'
ORIGINAL='    _server = await bind(host, /*port*/ 0);'
REPLACEMENT='''    // Trusted Asael runner: one preselected loopback port, no dynamic bind.
    final int? asaelPort = int.tryParse(platform.environment['ASAEL_NATIVE_TEST_PORT'] ?? '');
    if (asaelPort == null || asaelPort < 1024 || asaelPort > 65535) {
      throw StateError('Asael native test port is not configured.');
    }
    _server = await bind(InternetAddress.loopbackIPv4, asaelPort);'''
ADAPTER_SHA=digest({'version':1,'path':ADAPTER_PATH,'from':ORIGINAL,'to':REPLACEMENT})
XCODE_ADAPTER_PATH='lib/src/ios/xcodeproj.dart'
XCODE_ORIGINAL="      'xcodebuild',\n      '-clonedSourcePackagesDirPath',"
XCODE_REPLACEMENT="""      'xcodebuild',
      // The enclosing Asael sandbox is authoritative. Package manifests cannot
      // nest another macOS sandbox, resolve new versions, or update remotes.
      if (_platform.environment['ASAEL_NATIVE_FIXED_BUILD'] == '1') ...<String>[
        '-IDEPackageSupportDisableManifestSandbox=YES',
        '-disableAutomaticPackageResolution',
        '-onlyUsePackageVersionsFromResolvedFile',
        '-skipPackageUpdates',
      ],
      '-clonedSourcePackagesDirPath',"""
COMBINED_ADAPTER_SHA=digest({'version':2,'testPatchSha256':ADAPTER_SHA,'path':XCODE_ADAPTER_PATH,'from':XCODE_ORIGINAL,'to':XCODE_REPLACEMENT})
MANIFEST_SHIM='#!/bin/sh\nexport TMPDIR={tmp}\nexport HOME={home}\nexec {compiler} -module-cache-path {cache} "$@"\n'
MANIFEST_SHIM_SHA=digest(MANIFEST_SHIM.encode())
RSYNC_SHIM='#!/bin/sh\nfor argument do\n  [ "$argument" != "--" ] || exit 64\ndone\nexec /usr/bin/rsync "$@" --no-owner --no-group\n'
RSYNC_SHIM_SHA=digest(RSYNC_SHIM.encode())

def patch_xcode_adapter(raw):
    text=raw.decode();require(text.count(XCODE_ORIGINAL)==1,'native_flutter_xcode_adapter_source_changed')
    return text.replace(XCODE_ORIGINAL,XCODE_REPLACEMENT)

def provision_adapter(sdk,destination,expected_source_sha256,root_replacements=()):
    sdk=Path(sdk).resolve(); source=sdk/'packages/flutter_tools'; destination=Path(destination)
    require(not destination.exists() and destination.is_absolute(),'native_adapter_destination_invalid')
    raw=read_regular(source/ADAPTER_PATH)
    xcode_raw=read_regular(source/XCODE_ADAPTER_PATH)
    require(digest(raw)==expected_source_sha256 and raw.decode().count(ORIGINAL)==1,'native_flutter_adapter_source_changed')
    # Real copies: no hardlinks to a shared SDK and no SDK write permission later.
    destination.mkdir(mode=0o700,parents=True)
    for name in ('lib','bin'):
        shutil.copytree(source/name,destination/name,symlinks=False)
    (destination/ADAPTER_PATH).write_text(raw.decode().replace(ORIGINAL,REPLACEMENT))
    (destination/XCODE_ADAPTER_PATH).write_text(patch_xcode_adapter(xcode_raw))
    config_path=source/'.dart_tool/package_config.json'
    config=json.loads(read_regular(config_path)); roots=[]
    for package in config['packages']:
        uri=package['rootUri']; parsed=urlparse(uri)
        root=Path(unquote(parsed.path)) if parsed.scheme=='file' else (config_path.parent/unquote(uri)).resolve()
        for old,new in root_replacements:
            if root.is_relative_to(Path(old).resolve()):root=Path(new).resolve()/root.relative_to(Path(old).resolve());break
        if package['name']=='flutter_tools': root=destination
        require(root.is_dir(),'native_tool_dependency_missing')
        package['rootUri']=root.as_uri()+'/'; roots.append(str(root))
    (destination/'.dart_tool').mkdir(mode=0o700)
    (destination/'.dart_tool/package_config.json').write_text(json.dumps(config,separators=(',',':')))
    manifest=tree_manifest(destination,'bundle',maximum_bytes=100*1024*1024)
    receipt={'version':2,'sdk':str(sdk),'originalAdapterSourceSha256':digest(raw),'originalXcodeAdapterSourceSha256':digest(xcode_raw),'adapterPatchSha256':COMBINED_ADAPTER_SHA,
             'adapterManifest':manifest,'dependencyRoots':sorted(set(roots)),
             'dartExecutable':str(sdk/'bin/cache/dart-sdk/bin/dart'),'entrypoint':str(destination/'bin/flutter_tools.dart'),
             'packageConfig':str(destination/'.dart_tool/package_config.json')}
    destination.with_suffix('.receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    destination.with_suffix('.receipt.json').chmod(0o600)
    for folder,dirs,files in os.walk(destination):
        for name in files:(Path(folder)/name).chmod(0o400)
        for name in dirs:(Path(folder)/name).chmod(0o500)
    destination.chmod(0o500)
    return receipt
