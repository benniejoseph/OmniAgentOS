"""Closed cross-language native validation protocol, independent of application code."""
from datetime import datetime, timezone
import re
from macos_manifest import digest, require, seal, verify_seal
from macos_source import eligible

PROFILE='asael_macos_feature_v1'
PROFILE_BODY={'profile':PROFILE,'commands':['macos_analyze','macos_test_focused','macos_build'],
 'network':'isolated_flutter_test_loopback','credentials':'none','architecture':'arm64','version':1,
 'testConcurrency':1,'dds':False,'testPort':'controller_reserved_exact_loopback'}
PROFILE_SHA=digest(PROFILE_BODY)

def date(value):
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        require(parsed.tzinfo is not None,'native_time_invalid'); return parsed
    except (ValueError,TypeError,AttributeError):
        from macos_manifest import NativeRefused
        raise NativeRefused('native_time_invalid') from None

def utcnow(): return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def command_policy(command,purpose,paths):
    return seal('native_command_policy',{'profile':PROFILE,'profileSha256':PROFILE_SHA,'command':command,'purpose':purpose,'paths':paths},'sha')['sha']

def request_checks(request):
    if request['purpose']=='baseline': return [('macos_test_focused','regression',request['focusedTestPaths'])]
    return [('macos_analyze',None,request['analyzePaths']),('macos_test_focused','regression',request['focusedTestPaths']),
            ('macos_test_focused','adjacent',request['adjacentTestPaths']),('macos_build',None,[])]

def validate_request(request,owner,policies,*,check_time=True):
    verify_seal('native_validation_request',request,'requestSha256')
    fields={'version','requestId','cycleId','tenantId','ownerActorId','projectId','sessionId','checkpointId','purpose','releaseTarget','profile','profileSha256','policySha256','snapshot','focusedTestPaths','adjacentTestPaths','analyzePaths','createdAt','expiresAt','requestSha256'}
    require(set(request)==fields and request['version']==1 and request['releaseTarget']=='macos_app' and request['profile']==PROFILE and request['profileSha256']==PROFILE_SHA,'native_request_contract_changed')
    require(re.fullmatch(r'self_native_[a-f0-9]{64}',request['requestId']) and request['purpose'] in ('baseline','candidate'),'native_request_invalid')
    require(request['tenantId']==owner['tenantId'] and request['ownerActorId'] in owner.get('actorIds',[owner['actorId']]) and request['policySha256'] in policies,'native_request_authority_changed')
    snapshot=request['snapshot']; verify_seal('native_source_snapshot',snapshot,'snapshotSha256')
    require(all(snapshot[key]==request[key] for key in ('cycleId','projectId','sessionId','checkpointId')),'native_request_scope_changed')
    require(date(request['createdAt'])<date(request['expiresAt']),'native_request_time_invalid')
    if check_time: require(date(request['createdAt'])<=datetime.now(timezone.utc)<date(request['expiresAt']),'native_request_expired')
    tests=request['focusedTestPaths']+request['adjacentTestPaths']; analyze=request['analyzePaths']
    require(1<=len(request['focusedTestPaths'])<=6 and 1<=len(request['adjacentTestPaths'])<=6 and 1<=len(analyze)<=20,'native_request_path_count_invalid')
    require(len(set(tests))==len(tests) and len(set(analyze))==len(analyze),'native_request_path_duplicate')
    require(all(eligible(path) and path.startswith('apps/flutter/test/') for path in tests) and all(eligible(path) for path in analyze),'native_request_path_forbidden')
    files=snapshot['files']; paths=[row['path'] for row in files]
    require(1<=len(files)<=30 and paths==sorted(set(paths)) and all(eligible(path) for path in paths),'native_source_paths_invalid')
    return request

def validate_receipt(request,receipt):
    verify_seal('native_validation_receipt',receipt,'receiptSha256')
    require(receipt['requestId']==request['requestId'] and receipt['requestSha256']==request['requestSha256'] and receipt['snapshotSha256']==request['snapshot']['snapshotSha256'] and receipt['workspaceSha256']==request['snapshot']['workspaceSha256'] and receipt['builderProfileSha256']==PROFILE_SHA,'native_receipt_binding_changed')
    verify_seal('native_installed_baseline',receipt['installedBaseline'],'baselineSha256')
    paired=receipt['pairedBaseline']; require(paired['webRevision']==paired['workerRevision'],'native_paired_baseline_changed')
    require(date(request['createdAt'])<=date(receipt['completedAt'])<=date(request['expiresAt']),'native_receipt_time_invalid')
    checks=request_checks(request); require(len(checks)==len(receipt['checks']),'native_check_count_invalid')
    for (command,purpose,paths),check in zip(checks,receipt['checks']):
        require((check['command'],check.get('purpose'),check['paths'])==(command,purpose,paths) and check['policySha256']==command_policy(command,purpose,paths),'native_check_policy_changed')
        require(check['workspaceBeforeSha256']==check['workspaceAfterSha256']==receipt['workspaceSha256'],'native_check_source_changed')
        require(date(request['createdAt'])<=date(check['startedAt'])<=date(check['completedAt'])<=date(receipt['completedAt']),'native_check_time_invalid')
        if command=='macos_test_focused':
            summary=check.get('testSummary',{})
            require(summary.get('totalTests',0)>0 and summary['totalTests']==summary.get('passedTests',-1)+summary.get('failedTests',-1) and summary.get('pendingTests')==0 and sorted(summary.get('executedPaths',[]))==sorted(paths),'native_test_cases_unproven')
            require((check['exitCode']==0)==(summary['failedTests']==0),'native_test_status_conflict')
    artifact=receipt['artifact']
    if artifact:
        verify_seal('native_artifact',artifact,'artifactSha256'); base=receipt['installedBaseline']
        require(request['purpose']=='candidate' and artifact['sourceManifestSha256']==receipt['workspaceSha256'] and artifact['toolchainSha256']==receipt['toolchainSha256'] and artifact['builderProfileSha256']==PROFILE_SHA and artifact['version']==base['version'] and int(artifact['buildNumber'])==int(base['buildNumber'])+1,'native_artifact_binding_changed')
    return receipt
