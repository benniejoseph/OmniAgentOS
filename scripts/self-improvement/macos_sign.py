"""Trusted fixed signing transform; credentials are loaded only after exact approval."""
import argparse
import contextlib
import uuid
import ctypes
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from macos_manifest import bundle_identity,canonical,digest,read_regular,require,seal,tree_manifest,verify_manifest,verify_seal

PROVENANCE='Contents/Resources/asael-native-release.json'

def validate_provenance(value):
    require(isinstance(value,dict) and set(value)=={'protocol','sourceRevision','sourceSnapshotSha256','version','build'} and value['protocol']==1,'native_provenance_contract_invalid')
    require(re.fullmatch(r'[a-f0-9]{40}',str(value['sourceRevision'])) and re.fullmatch(r'[a-f0-9]{64}',str(value['sourceSnapshotSha256'])) and re.fullmatch(r'\d+\.\d+\.\d+',str(value['version'])) and type(value['build'])is int and 1<=value['build']<=999999999,'native_provenance_binding_invalid')
    return value

def write_provenance(bundle,value):
    """Shared by the supervised first package and subsequent approved publisher."""
    validate_provenance(value);identity=bundle_identity(bundle)
    require(identity['CFBundleIdentifier']=='app.omniagent.omniagent' and identity['CFBundleShortVersionString']==value['version'] and int(identity['CFBundleVersion'])==value['build'],'native_provenance_bundle_mismatch')
    path=Path(bundle)/PROVENANCE;require(not path.exists() and not path.is_symlink(),'native_provenance_already_present')
    path.parent.mkdir(parents=True,exist_ok=True);raw=canonical(value)+b'\n';path.write_bytes(raw);path.chmod(0o644);return digest(raw)

def checked(argv,*,env=None,timeout=120):
    result=subprocess.run(argv,env=env or {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/var/empty'},stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout)
    require(result.returncode==0 and len(result.stdout)+len(result.stderr)<=2_000_000,'native_signing_command_refused')
    return result.stdout,result.stderr

def signature_identity(bundle):
    checked(['/usr/bin/codesign','--verify','--deep','--strict','--all-architectures',str(bundle)])
    _,requirement=checked(['/usr/bin/codesign','-d','-r-',str(bundle)])
    lines=[line for line in requirement.decode().splitlines() if line.startswith('designated => ')]
    require(len(lines)==1,'native_designated_requirement_missing')
    _,metadata=checked(['/usr/bin/codesign','-d','--verbose=4','--arch','arm64',str(bundle)])
    hashes=re.findall(rb'^CDHash=([a-f0-9]+)$',metadata,re.M);require(len(hashes)==1 and b'(runtime)' in metadata,'native_code_signature_missing_or_unhardened')
    with tempfile.TemporaryDirectory(prefix='asael-cert-') as folder:
        prefix=Path(folder)/'certificate';checked(['/usr/bin/codesign','-d','--extract-certificates',str(prefix),str(bundle)])
        leaf=read_regular(str(prefix)+'0',100_000)
    return {'signingIdentitySha256':digest(leaf),'designatedRequirementSha256':digest(lines[0].encode()),'codeSignatureSha256':digest(hashes[0])}

def installed_baseline(bundle,source_revision):
    require(re.fullmatch(r'[a-f0-9]{40}',source_revision),'native_baseline_revision_invalid')
    identity=bundle_identity(bundle);signature=signature_identity(bundle);manifest=tree_manifest(bundle,'bundle')
    require(identity['CFBundleIdentifier']=='app.omniagent.omniagent','native_baseline_identifier_invalid')
    return seal('native_installed_baseline',{'bundleIdentifier':identity['CFBundleIdentifier'],'version':identity['CFBundleShortVersionString'],'buildNumber':identity['CFBundleVersion'],'bundleSha256':manifest['manifestSha256'],'sourceRevision':source_revision,'signingIdentitySha256':signature['signingIdentitySha256'],'designatedRequirementSha256':signature['designatedRequirementSha256']},'baselineSha256')

def validate_approval(approval,request,artifact,baseline):
    from macos_protocol import date
    from datetime import datetime,timezone
    verify_seal('approval',approval,'receiptSha256');verify_seal('native_artifact',artifact,'artifactSha256');verify_seal('native_installed_baseline',baseline,'baselineSha256')
    require(approval.get('decision')=='approved' and approval['tenantId']==request['tenantId'] and approval['ownerActorId']==request['ownerActorId'] and approval['candidateSha256']==request['candidate']['candidateSha256'] and approval['policySha256']==request['policySha256'] and approval['validationSha256']==request['validationSha256'],'native_approval_scope_changed')
    require(approval.get('nativeArtifactSha256')==artifact['artifactSha256'] and approval.get('nativeBaselineSha256')==baseline['baselineSha256'],'native_approval_artifact_changed')
    require(date(approval['approvedAt'])<=datetime.now(timezone.utc)<date(approval['expiresAt']),'native_approval_expired')

def unlock_private_keychain(config):
    # Security.framework keeps the password out of argv, environment and logs.
    path=Path(config['keychain']);password_path=Path(config['passwordFile'])
    for item in (path,password_path):
        info=item.lstat();require(item.is_absolute() and not item.is_symlink() and info.st_uid==os.getuid() and not info.st_mode&0o077,'native_signing_reference_invalid')
    password=read_regular(password_path,4096).rstrip(b'\r\n');require(password and b'\0' not in password,'native_signing_password_invalid')
    framework=ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security');core=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    framework.SecKeychainOpen.argtypes=[ctypes.c_char_p,ctypes.POINTER(ctypes.c_void_p)];framework.SecKeychainOpen.restype=ctypes.c_int32
    framework.SecKeychainUnlock.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_bool];framework.SecKeychainUnlock.restype=ctypes.c_int32
    core.CFRelease.argtypes=[ctypes.c_void_p];handle=ctypes.c_void_p();require(framework.SecKeychainOpen(os.fsencode(path),ctypes.byref(handle))==0,'native_signing_keychain_unavailable')
    buffer=ctypes.create_string_buffer(password)
    try:require(framework.SecKeychainUnlock(handle,len(password),buffer,True)==0,'native_signing_keychain_locked')
    finally:ctypes.memset(buffer,0,len(buffer));password=b'';core.CFRelease(handle)

@contextlib.contextmanager
def signing_lock(config):
    root=Path(config['keychain']).parent;lock=root/'.install.lock';token='native-publisher:'+str(os.getpid())+':'+uuid.uuid4().hex
    try:os.symlink(token,lock)
    except FileExistsError:
        from macos_manifest import NativeRefused
        raise NativeRefused('native_signing_lease_busy') from None
    try:yield
    finally:
        require(lock.is_symlink() and os.readlink(lock)==token,'native_signing_lease_changed');lock.unlink()


def prepare_signed(unsigned,destination,manifest,request,merged_revision,config):
    native=request['validation']['native'];artifact=native['artifact'];baseline=native['installedBaseline'];approval=request.get('approval')
    require(approval is not None,'native_exact_owner_approval_required');validate_approval(approval,request,artifact,baseline)
    require(manifest['manifestSha256']==artifact['unsignedBundleSha256'],'native_approved_bundle_changed');verify_manifest(unsigned,manifest,'bundle')
    require(re.fullmatch(r'[a-f0-9]{40}',merged_revision),'native_merged_revision_invalid')
    destination=Path(destination);require(not destination.exists(),'native_signed_destination_exists');shutil.copytree(unsigned,destination,symlinks=True)
    require({helper['target'] for helper in config['frozenHelpers']}=={'Contents/Helpers/AsaelComputerUseHelper.app','Contents/Helpers/AsaelCommandRunnerHelper.app','Contents/Helpers/AsaelCredentialBroker.app'} and len(config['frozenHelpers'])==3,'native_frozen_helpers_incomplete')
    frozen=[]
    for helper in config['frozenHelpers']:
        require(re.fullmatch(r'Contents/(?:Helpers|Library/LoginItems|Resources)/[A-Za-z0-9_. -]+(?:\.app)?',helper['target']),'native_frozen_helper_target_invalid')
        verify_manifest(helper['path'],helper['manifest'],'bundle');target=destination/helper['target'];require(not target.exists(),'native_frozen_helper_collision')
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(helper['path'],target,symlinks=True);frozen.append(target)
    provenance={'protocol':1,'sourceRevision':merged_revision,'sourceSnapshotSha256':artifact['sourceManifestSha256'],'version':artifact['version'],'build':int(artifact['buildNumber'])}
    provenance_sha=write_provenance(destination,provenance)
    entitlements=Path(config['entitlements']['path']);require(digest(read_regular(entitlements))==config['entitlements']['sha256'],'native_entitlements_changed')
    require(config['mode']=='private' and config['signingIdentitySha256']==baseline['signingIdentitySha256'] and config['designatedRequirementSha256']==baseline['designatedRequirementSha256'],'native_signing_identity_changed')
    with signing_lock(config):
        targets=[]
        for folder,dirs,files in os.walk(destination,followlinks=False):
            for name in [*dirs,*files]:
                path=Path(folder)/name
                if path.is_symlink() or any(path==item or path.is_relative_to(item) for item in frozen):continue
                if path.is_dir() and path.suffix in ('.framework','.app','.xpc','.appex','.bundle'):targets.append(path)
                elif path.is_file():
                    with path.open('rb') as stream:magic=stream.read(4)
                    if magic in (b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'):targets.append(path)
        for path in sorted(set(targets),key=lambda value:len(value.parts),reverse=True)+[destination]:
            argv=['/usr/bin/codesign','--force','--sign',config['identity'],'--keychain',config['keychain'],'--options','runtime','--timestamp=none']
            if path==destination:argv+=['--entitlements',str(entitlements)]
            elif path.suffix=='.appex':
                extension=config['extensionEntitlements'];require(digest(read_regular(extension['path']))==extension['sha256'],'native_extension_entitlements_changed');argv+=['--entitlements',extension['path']]
            unlock_private_keychain(config)
            checked([*argv,str(path)])
    signature=signature_identity(destination)
    require(signature['signingIdentitySha256']==baseline['signingIdentitySha256'] and signature['designatedRequirementSha256']==baseline['designatedRequirementSha256'],'native_signed_identity_changed')
    for helper in config['frozenHelpers']:verify_manifest(destination/helper['target'],helper['manifest'],'bundle')
    signed=tree_manifest(destination,'bundle')
    return {'path':str(destination),'manifest':signed,'signature':signature,'provenanceSha256':provenance_sha,'artifactSha256':artifact['artifactSha256'],'approvalSha256':approval['receiptSha256']}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Write fixed provenance into an unsigned supervised package; no signing or installation.')
    parser.add_argument('--bundle',required=True);parser.add_argument('--provenance',required=True);args=parser.parse_args()
    print(json.dumps({'provenanceSha256':write_provenance(args.bundle,json.loads(read_regular(args.provenance,4096)))}))
