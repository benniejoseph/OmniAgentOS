"""Reuse reviewed, unchanged asset compilation without granting host temp access."""
import json
from pathlib import Path
import plistlib
import shlex
import subprocess
from macos_manifest import canonical,digest,read_regular,require,tree_manifest,verify_manifest

CATALOG='apps/flutter/macos/Runner/Assets.xcassets'
OPTIONS=['--output-format','human-readable-text','--notices','--warnings','--app-icon','AppIcon','--enable-on-demand-resources','NO','--development-region','en','--target-device','mac','--minimum-deployment-target','12.0','--platform','macosx']
OUTPUTS=('AppIcon.icns','Assets.car','partial.plist','dependencies')

def recipe(argv):
    require(isinstance(argv,list) and len(argv)==24 and all(isinstance(v,str) for v in argv),'native_asset_recipe_changed')
    require(argv[2]=='--compile' and argv[8]=='--export-dependency-info' and argv[10]=='--output-partial-info-plist','native_asset_recipe_changed')
    require(argv[4:8]+argv[12:]==OPTIONS,'native_asset_recipe_changed')
    return {'compiler':argv[0],'catalog':argv[1],'output':argv[3],'dependencies':argv[9],'partial':argv[11],'options':OPTIONS}

def validate_partial(raw):
    try:value=plistlib.loads(raw)
    except Exception:raise ValueError('native_asset_partial_invalid') from None
    require(value=={'CFBundleIconFile':'AppIcon','CFBundleIconName':'AppIcon'},'native_asset_partial_changed')

def dependency_bytes(version,catalog,partial,output):
    return b'\0'+version+b'\0\x10'+catalog.encode()+b'\0@'+partial.encode()+b'\0@'+(output+'/AppIcon.icns').encode()+b'\0@'+(output+'/Assets.car').encode()+b'\0'

def freeze_asset_cache(checkout,receipt_path,build_manifest,destination):
    """Only a retained successful operator build may supply these dependencies."""
    checkout=Path(checkout).resolve();receipt_path=Path(receipt_path);destination=Path(destination)
    receipt_raw=read_regular(receipt_path);receipt=json.loads(receipt_raw);evidence=receipt_path.parent
    require(receipt.get('status')=='passed' and receipt.get('bundleIdentifier')=='app.omniagent.omniagent','native_asset_build_not_passed')
    source_raw=read_regular(evidence/'source-manifest.json',64*1024*1024);artifact_raw=read_regular(evidence/'unsigned-artifact-manifest.json',64*1024*1024)
    require(digest(source_raw)==receipt['sourceSnapshotSha256'] and digest(artifact_raw)==receipt['artifactManifestSha256'],'native_asset_build_binding_changed')
    for name,sha in receipt['logs'].items():
        require(name in ('flutter-config-only.log','xcodebuild-unsigned.log') and digest(read_regular(evidence/name,64*1024*1024))==sha,'native_asset_build_log_changed')
    require(set(receipt['logs'])=={'flutter-config-only.log','xcodebuild-unsigned.log'},'native_asset_build_logs_missing')
    source=json.loads(source_raw);catalog=checkout/CATALOG;catalog_manifest=tree_manifest(catalog,'bundle')
    recorded=[row for row in source['files'] if row['path'].startswith(CATALOG+'/')]
    require(recorded and all(row['kind']=='file' for row in recorded),'native_asset_source_invalid')
    require(all(row['kind'] in ('file','directory') for row in catalog_manifest['entries']),'native_asset_source_invalid')
    require({row['path'][len(CATALOG)+1:]:row['sha256'] for row in recorded}=={row['path']:row['sha256'] for row in catalog_manifest['entries'] if row['kind']=='file'},'native_asset_source_changed')
    manifest_raw=read_regular(build_manifest,16*1024*1024);commands=json.loads(manifest_raw)['commands']
    matches=[value for key,value in commands.items() if 'CompileAssetCatalogVariant thinned ' in key]
    require(len(matches)==1,'native_asset_compile_ambiguous');bound=recipe(matches[0]['args'])
    require(bound['catalog']==str(catalog) and bound['compiler']=='/Applications/Xcode.app/Contents/Developer/usr/bin/actool','native_asset_compile_binding_changed')
    derived=Path(receipt['reusedDerivedData']).resolve();require(all(Path(bound[key]).is_relative_to(derived) for key in ('output','partial','dependencies')),'native_asset_output_foreign')
    retained=json.loads(read_regular(evidence/'retained-artifact.json'));artifact=Path(retained['retainedPath']);rows=json.loads(artifact_raw)['files']
    blobs={name:read_regular(Path(bound['output'])/name,16*1024*1024) for name in OUTPUTS[:2]}
    for name,raw in blobs.items():
        expected=next((row for row in rows if row['path']=='Contents/Resources/'+name),None)
        require(expected and expected['kind']=='file' and digest(raw)==expected['sha256'] and read_regular(artifact/'Contents/Resources'/name,16*1024*1024)==raw,'native_asset_artifact_changed')
    blobs['partial.plist']=read_regular(bound['partial']);validate_partial(blobs['partial.plist'])
    blobs['dependencies']=read_regular(bound['dependencies']);version=blobs['dependencies'].split(b'\0')[1]
    require(version.startswith(b'actool-') and version[7:].isdigit() and blobs['dependencies']==dependency_bytes(version,bound['catalog'],bound['partial'],bound['output']),'native_asset_dependencies_changed')
    compiler=Path(bound['compiler']);result=subprocess.run([str(compiler),'--version','--output-format','human-readable-text'],env={'PATH':'/usr/bin:/bin','HOME':'/var/empty'},capture_output=True,timeout=30)
    require(result.returncode==0 and b'bundle-version: '+version[7:]+b'\n' in result.stdout,'native_asset_compiler_version_changed')
    require(not destination.exists(),'native_asset_cache_exists');destination.mkdir(mode=0o700)
    for name,raw in blobs.items():(destination/name).write_bytes(raw);(destination/name).chmod(0o400)
    body={'version':1,'generatorSha256':digest(read_regular(__file__)),'catalog':CATALOG,'catalogManifest':catalog_manifest,'compiler':str(compiler),'compilerSha256':digest(read_regular(compiler,64*1024*1024)),'compilerVersionSha256':digest(result.stdout),'dependencyVersion':version.decode(),'options':OPTIONS,'originalRecipe':bound,'buildReceiptSha256':digest(receipt_raw),'sourceReceiptSha256':digest(source_raw),'artifactReceiptSha256':digest(artifact_raw),'buildManifestSha256':digest(manifest_raw),'outputs':{name:digest(raw) for name,raw in blobs.items()}}
    record={**body,'cacheSha256':digest(body)};raw=canonical(record)+b'\n';target=destination/'asset-cache.json';target.write_bytes(raw);target.chmod(0o400)
    return {'path':str(destination),'recordSha256':digest(raw),'cacheSha256':record['cacheSha256']}

def read_asset_cache(reference):
    folder=Path(reference['path']);raw=read_regular(folder/'asset-cache.json',4*1024*1024);require(digest(raw)==reference['recordSha256'],'native_asset_cache_changed');record=json.loads(raw)
    require(record.get('version')==1 and record['cacheSha256']==reference['cacheSha256']==digest({k:v for k,v in record.items() if k!='cacheSha256'}) and record['catalog']==CATALOG and record['options']==OPTIONS and record['generatorSha256']==digest(read_regular(__file__)),'native_asset_cache_changed')
    require(set(record['outputs'])==set(OUTPUTS),'native_asset_outputs_changed')
    for name,sha in record['outputs'].items():require(digest(read_regular(folder/name,16*1024*1024))==sha,'native_asset_output_changed')
    validate_partial(read_regular(folder/'partial.plist'))
    require(digest(read_regular(record['compiler'],64*1024*1024))==record['compilerSha256'],'native_asset_compiler_changed')
    return record

def prepare_asset_cache(root,home,directory,reference):
    root=Path(root);home=Path(home);directory=Path(directory);record=read_asset_cache(reference)
    verify_manifest(root/CATALOG,record['catalogManifest'],'bundle')
    cache=directory/'assets';require(not cache.exists(),'native_asset_staging_exists');cache.mkdir(mode=0o700)
    for name in OUTPUTS[:3]:(cache/name).write_bytes(read_regular(Path(reference['path'])/name,16*1024*1024));(cache/name).chmod(0o400)
    lines=['#!/bin/sh','set -eu']
    for index,variant in enumerate(('thinned','unthinned')):
        base=home/'DerivedData/Build/Intermediates.noindex/Runner.build/Release/Runner.build';output=base/'assetcatalog_output'/variant;partial=base/('assetcatalog_generated_info.plist_'+variant);deps=base/('assetcatalog_dependencies_'+variant)
        argv=[str(root/CATALOG),'--compile',str(output),*OPTIONS[:4],'--export-dependency-info',str(deps),'--output-partial-info-plist',str(partial),*OPTIONS[4:]]
        lines.extend([f'match_{index}() {{',f'  [ "$#" -eq {len(argv)} ] || return 1'])
        for value in argv:lines.extend(['  [ "$1" = '+shlex.quote(value)+' ] || return 1','  shift'])
        lines.extend(['}','if match_'+str(index)+' "$@"; then','  /bin/mkdir -p '+shlex.quote(str(output))])
        for name in OUTPUTS[:2]:lines.append('  /bin/cp -f '+shlex.quote(str(cache/name))+' '+shlex.quote(str(output/name)))
        dep_raw=read_regular(Path(reference['path'])/'dependencies')
        old=record['originalRecipe'];require(dep_raw==dependency_bytes(record['dependencyVersion'].encode(),old['catalog'],old['partial'],old['output']),'native_asset_dependencies_changed')
        fixed=cache/('dependencies-'+variant);fixed.write_bytes(dependency_bytes(record['dependencyVersion'].encode(),str(root/CATALOG),str(partial),str(output)));fixed.chmod(0o400)
        lines.extend(['  /bin/cp -f '+shlex.quote(str(cache/'partial.plist'))+' '+shlex.quote(str(partial)),'  /bin/cp -f '+shlex.quote(str(fixed))+' '+shlex.quote(str(deps)),"  printf '%s\\n' "+shlex.quote('Asael: reused pinned asset compilation '+record['cacheSha256']),'  exit 0','fi'])
    lines.extend(['if [ "$#" -eq 3 ] && [ "$1" = "--version" ] && [ "$2" = "--output-format" ]; then','  case "$3" in xml1|human-readable-text) exec '+shlex.quote(record['compiler'])+' "$@" ;; esac','fi','exit 64'])
    # SwiftBuild keys its version plist lookup from the executable basename.
    target=directory/'actool';require(not target.exists(),'native_asset_shim_exists');target.write_text('\n'.join(lines)+'\n');target.chmod(0o500);cache.chmod(0o500)
    return target
