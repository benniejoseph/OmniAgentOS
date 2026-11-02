"""Closed cross-language native validation protocol, independent of application code."""
from datetime import datetime, timezone
import base64
import binascii
import json
import re
import zlib
from macos_manifest import canonical, digest, require, seal, verify_seal
from macos_source import eligible

PROFILE='asael_macos_feature_v2'
PROFILE_BODY={'profile':PROFILE,'commands':['macos_analyze','macos_test_focused','macos_build'],
 'network':'isolated_flutter_test_loopback','credentials':'none','architecture':'arm64','version':2,
 'baselineChecks':['macos_analyze','macos_test_focused'],'testReportFailure':'unproven_test_report',
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

def evidence_text(value,maximum):
    if not isinstance(value,str):return False
    try:return 1<=len(value.encode('utf-16-le'))//2<=maximum
    except UnicodeError:return False

def encode_test_evidence(value):
    """Lossless bounded wire encoding; the named contract remains the evidence."""
    raw=canonical(value);require(0<len(raw)<=20*1024,'native_case_decoded_limit')
    compressor=zlib.compressobj(9,zlib.DEFLATED,-15)
    compressed=compressor.compress(raw)+compressor.flush()
    return {'version':1,'encoding':'deflate-raw-json-v1','decodedByteLength':len(raw),'decodedSha256':digest(raw),'data':base64.b64encode(compressed).decode('ascii')}

def decode_test_evidence(value):
    # Previously named evidence, and historical absence at the caller, are readable.
    require(isinstance(value,dict),'native_case_encoding_invalid')
    if 'encoding' not in value:return value
    require(set(value)=={'version','encoding','decodedByteLength','decodedSha256','data'} and type(value['version']) is int and value['version']==1 and value['encoding']=='deflate-raw-json-v1' and type(value['decodedByteLength']) is int and 0<value['decodedByteLength']<=20*1024 and isinstance(value['decodedSha256'],str) and re.fullmatch(r'[a-f0-9]{64}',value['decodedSha256']) and isinstance(value['data'],str) and 0<len(value['data'])<=28*1024,'native_case_encoding_invalid')
    try:
        compressed=base64.b64decode(value['data'],validate=True)
        require(base64.b64encode(compressed).decode('ascii')==value['data'],'native_case_base64_invalid')
        decoder=zlib.decompressobj(-15);raw=decoder.decompress(compressed,20*1024+1)
        require(len(raw)<=20*1024 and decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data,'native_case_deflate_invalid')
        require(len(raw)==value['decodedByteLength'] and digest(raw)==value['decodedSha256'],'native_case_decoded_changed')
        decoded=json.loads(raw.decode('utf-8'))
        require(isinstance(decoded,dict),'native_case_encoding_invalid')
        require(canonical(decoded)==raw,'native_case_json_noncanonical')
        return decoded
    except (binascii.Error,ValueError,UnicodeError,zlib.error):
        from macos_manifest import NativeRefused
        raise NativeRefused('native_case_encoding_invalid') from None

def command_policy(command,purpose,paths):
    return seal('native_command_policy',{'profile':PROFILE,'profileSha256':PROFILE_SHA,'command':command,'purpose':purpose,'paths':paths},'sha')['sha']

def request_checks(request):
    if request['purpose']=='baseline': return [('macos_analyze',None,request['analyzePaths']),('macos_test_focused','regression',request['focusedTestPaths'])]
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
        if 'testEvidence' in check:validate_test_evidence(check)
        if 'testReportFailure' in check:
            require(command=='macos_test_focused' and check['testReportFailure']=='unproven_test_report' and 'testSummary' not in check and not receipt['artifact'],'native_test_report_failure_invalid')
            continue
        if command=='macos_test_focused':
            summary=check.get('testSummary',{})
            require(summary.get('totalTests',0)>0 and summary['totalTests']==summary.get('passedTests',-1)+summary.get('failedTests',-1) and summary.get('pendingTests')==0 and sorted(summary.get('executedPaths',[]))==sorted(paths),'native_test_cases_unproven')
            require((check['exitCode']==0)==(summary['failedTests']==0),'native_test_status_conflict')
    artifact=receipt['artifact']
    if artifact:
        verify_seal('native_artifact',artifact,'artifactSha256'); base=receipt['installedBaseline']
        require(request['purpose']=='candidate' and artifact['sourceManifestSha256']==receipt['workspaceSha256'] and artifact['toolchainSha256']==receipt['toolchainSha256'] and artifact['builderProfileSha256']==PROFILE_SHA and artifact['version']==base['version'] and int(artifact['buildNumber'])==int(base['buildNumber'])+1,'native_artifact_binding_changed')
    return receipt

def validate_test_evidence(check):
    """Optional in historical receipts; never synthesize missing case proof."""
    evidence=decode_test_evidence(check['testEvidence']);summary=check.get('testSummary');cases=evidence.get('cases',[]);suites=evidence.get('suites',[])
    integer=lambda value,maximum:type(value) is int and 0<=value<=maximum
    text=evidence_text
    require(check['command']=='macos_test_focused' and not check.get('testReportFailure') and isinstance(summary,dict),'native_case_command_changed')
    try:bounded=len(canonical(evidence))<=20*1024
    except (UnicodeError,ValueError):bounded=False
    require(set(evidence)=={'version','outputSha256','complete','suites','cases','omittedCases'} and type(evidence['version']) is int and evidence['version']==1 and type(evidence['complete']) is bool and evidence['outputSha256']==check['outputSha256'] and bounded,'native_case_output_changed')
    require(isinstance(cases,list) and len(cases)<=256 and isinstance(suites,list) and len(suites)<=30 and integer(evidence['omittedCases'],10000),'native_case_bounds_changed')
    for suite in suites:
        require(isinstance(suite,dict) and set(suite)=={'id','path'} and integer(suite['id'],2**31-1) and isinstance(suite['path'],str) and suite['path'] in check['paths'] and suite['path'] in summary['executedPaths'],'native_case_suite_changed')
    require(len({row['id'] for row in suites})==len(suites) and len({row['path'] for row in suites})==len(suites),'native_case_duplicate_suite')
    for case in cases:
        require(isinstance(case,dict) and {'id','suiteId','name','status'}<=set(case)<= {'id','suiteId','name','status','line','failureMessages','omittedFailureMessages'} and integer(case['id'],2**31-1) and integer(case['suiteId'],2**31-1) and any(row['id']==case['suiteId'] for row in suites) and text(case['name'],500) and case['status'] in ('passed','failed','pending'),'native_case_identity_changed')
        if 'line' in case:require(integer(case['line'],1000000) and case['line']>0,'native_case_line_changed')
        if 'failureMessages' in case:require(isinstance(case['failureMessages'],list) and 1<=len(case['failureMessages'])<=3 and all(text(message,2000) for message in case['failureMessages']),'native_case_failure_changed')
        if 'omittedFailureMessages' in case:require(integer(case['omittedFailureMessages'],10000) and case['omittedFailureMessages']>0,'native_case_omission_changed')
    require(len({row['id'] for row in cases})==len(cases) and len(cases)+evidence['omittedCases']==summary['totalTests'],'native_case_count_changed')
    counts={status:sum(row['status']==status for row in cases) for status in ('passed','failed','pending')}
    require(all(count<=summary[status+'Tests'] for status,count in counts.items()),'native_case_status_changed')
    if evidence['complete']:
        require(evidence['omittedCases']==0 and {row['path'] for row in suites}==set(summary['executedPaths']) and all(count==summary[status+'Tests'] for status,count in counts.items()) and all(not row.get('omittedFailureMessages') and (row['status']!='failed' or row.get('failureMessages')) for row in cases),'native_case_completeness_unproven')
