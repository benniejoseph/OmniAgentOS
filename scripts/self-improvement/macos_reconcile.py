"""Explicit completion-only reconciliation of an already terminal Mac install."""
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import re
from macos_manifest import NativeRefused,digest,private_directory,read_regular,require,verify_seal,tree_manifest
from macos_protocol import date,utcnow
from macos_sign import signature_identity
from macos_install import Journal,APPLICATION,expected_binding,executable
from macos_bridge import query

API='/api/self-improvement/release-controller'

def confirmed(response,cycle_id,receipt):
    expected={'deployed':'succeeded','rolled_back':'rolled_back','failed':'failed'}[receipt['outcome']]
    require(response.get('cycleId')==cycle_id and response.get('stage')==expected and all(response.get('receipt',{}).get(key)==value for key,value in receipt.items()),'native_reconciliation_completion_unconfirmed')

def exact_recorded_receipt(cycle,receipt):
    stored=cycle.get('releaseReceipt')
    require(isinstance(stored,dict) and {key:value for key,value in stored.items() if key!='serverHealthEvidenceSha256'}==receipt,'native_reconciliation_terminal_receipt_changed')

def release_retained_lock(attempt_id,directory):
    from macos_controller import write
    lock=Path.home()/'.asael/production-release.lock'
    if not lock.exists():return
    private_directory(lock);marker=lock/'owner.json';raw=read_regular(marker);owner=json.loads(raw)
    require(owner.get('attemptId')==attempt_id,'native_reconciliation_other_publication_lock')
    try:os.kill(owner['pid'],0)
    except ProcessLookupError:pass
    else:raise NativeRefused('native_reconciliation_publisher_still_active')
    evidence=directory/('retained-lock-'+digest(raw)+'.json')
    if not evidence.exists():write(evidence,{'at':utcnow(),'owner':owner,'terminalCompletionConfirmed':True})
    require(read_regular(marker)==raw,'native_reconciliation_lock_changed');marker.unlink();lock.rmdir()

def reconcile_native_completion(controller,attempt_id):
    """Never invokes checkout, merge, signing, installation, launch or quit."""
    from macos_controller import Lease,write
    require(re.fullmatch('[a-f0-9]{64}',attempt_id or '') is not None,'native_reconciliation_attempt_invalid')
    directory=private_directory(controller.state/attempt_id)
    request=json.loads(read_regular(directory/'request.json'));binding=json.loads(read_regular(directory/'release-binding.json'));state=json.loads(read_regular(directory/'lease.json'))
    require(request.get('releaseTarget')=='macos_app' and attempt_id==digest({'cycleId':request['cycleId'],'candidateRevision':request['candidateRevision']}),'native_reconciliation_attempt_changed')
    require(request['tenantId']==controller.app.actor['tenantId'] and request['ownerActorId'] in controller.app.actor['actorIds'],'native_reconciliation_owner_changed')
    verify_seal('release_binding',binding,'releaseBindingSha256')
    native=request['validation']['native']
    require(binding.get('runner')=='asael_macos_publisher' and binding.get('releaseTarget')=='macos_app' and binding['sourceCandidateRevision']==request['candidateRevision'] and binding['previousRevision']==request['previousRevision'] and binding['native']=={**native,'approvalSha256':request['approval']['receiptSha256']} and binding['validationSha256']==request['validationSha256'] and binding['policySha256']==request['policySha256'],'native_reconciliation_binding_changed')
    fields=state['fields'];require(state['version']==1 and state['route']==API and fields['cycleId']==request['cycleId'] and fields['controllerId']==controller.config['controllerId'] and set(fields)=={'cycleId','controllerId','leaseToken'},'native_reconciliation_lease_changed')
    pending=state.get('pending')
    require(not pending or pending.get('action') in ('complete','hold'),'native_reconciliation_token_uncertain')
    cycle=controller.app.request('GET','/api/self-improvement?cycleId='+request['cycleId'])['cycle']
    require(cycle['id']==request['cycleId'] and cycle['scope']['tenantId']==request['tenantId'] and cycle['scope']['ownerActorId']==request['ownerActorId'] and cycle.get('release')==binding,'native_reconciliation_server_binding_changed')
    original=json.loads(read_regular(directory/'receipt.json')) if (directory/'receipt.json').exists() else None
    if cycle['stage'] in ('succeeded','rolled_back','failed'):
        # The exact original callback is a read-only acknowledgement on the server.
        candidates=([original] if original else [])+[json.loads(read_regular(path)) for path in sorted(directory.glob('reconciliation-[0-9][0-9][0-9][0-9].json'))]
        recorded={key:value for key,value in (cycle.get('releaseReceipt') or {}).items() if key!='serverHealthEvidenceSha256'}
        original=next((value for value in candidates if value==recorded),None)
        require(original is not None,'native_reconciliation_terminal_receipt_changed')
        exact_recorded_receipt(cycle,original)
        lease=Lease(controller.app,API,fields,directory/'lease.json')
        usage={'phaseId':'release:'+fields['controllerId'],'actualUsd':0,'evidenceSha256':digest({'nativeCompletionOnly':True,'receiptSha256':digest(original)})}
        confirmed(lease.action('complete',receipt=original,releaseUsage=usage),request['cycleId'],original)
        marker=directory/'reconciled-terminal.json'
        if not marker.exists():write(marker,{'at':utcnow(),'receiptSha256':digest(original),'mutatedApplication':False})
        release_retained_lock(attempt_id,directory)
        return {'status':'completion_acknowledged','cycleId':request['cycleId'],'receiptSha256':digest(original)}
    require(cycle['stage']=='releasing','native_reconciliation_not_releasing')
    expired=date(cycle['executionLeaseExpiresAt'])<=datetime.now(timezone.utc)
    if pending and pending['action']=='complete' and not expired:
        candidates=([original] if original else [])+[json.loads(read_regular(path)) for path in sorted(directory.glob('reconciliation-[0-9][0-9][0-9][0-9].json'))]
        original=pending.get('receipt')
        require(original in candidates and isinstance(pending.get('releaseUsage'),dict) and pending.get('requestSha256')==digest({'action':'complete',**fields,'receipt':original,'releaseUsage':pending['releaseUsage']}),'native_reconciliation_pending_receipt_missing')
        lease=Lease(controller.app,API,fields,directory/'lease.json')
        usage=pending['releaseUsage']
        confirmed(lease.action('complete',receipt=original,releaseUsage=usage),request['cycleId'],original)
        release_retained_lock(attempt_id,directory)
        return {'status':'completion_acknowledged','cycleId':request['cycleId'],'receiptSha256':digest(original)}
    prepared=json.loads(read_regular(directory/'signed.json'))
    baseline=native['installedBaseline'];journal_binding={'artifactSha256':prepared['artifactSha256'],'approvalSha256':prepared['approvalSha256'],'oldBundleSha256':baseline['bundleSha256'],'newBundleSha256':prepared['manifest']['manifestSha256']}
    journal=Journal(directory/'install-journal',journal_binding)
    require(journal.events and journal.events[-1]['stage'] in ('verified','rolled_back'),'native_reconciliation_install_not_terminal')
    event=journal.events[-1];outcome='deployed' if event['stage']=='verified' else 'rolled_back'
    expected_sha=prepared['manifest']['manifestSha256'] if outcome=='deployed' else baseline['bundleSha256']
    require(tree_manifest(APPLICATION,'bundle')['manifestSha256']==expected_sha,'native_reconciliation_installed_bundle_changed')
    signature=signature_identity(APPLICATION)
    require(signature['signingIdentitySha256']==baseline['signingIdentitySha256'] and signature['designatedRequirementSha256']==baseline['designatedRequirementSha256'],'native_reconciliation_signer_changed')
    expected=expected_binding(APPLICATION,digest([request['tenantId'],request['ownerActorId']]))
    require(expected['sourceRevision']==(binding['candidateRevision'] if outcome=='deployed' else baseline['sourceRevision']) and expected['version']==(native['artifact']['version'] if outcome=='deployed' else baseline['version']) and str(expected['build'])==(native['artifact']['buildNumber'] if outcome=='deployed' else baseline['buildNumber']),'native_reconciliation_installed_identity_changed')
    ready=query('status',expected,executable(APPLICATION),signature['codeSignatureSha256'])
    require(ready['status']=='ready' and not ready['startupQuarantined'],'native_reconciliation_startup_unproven')
    observed=controller.observe();require(all(observed[key]==native['pairedBaseline'][key] for key in ('webRevision','workerRevision','manifestSha256')),'native_reconciliation_serving_pair_changed')
    sequence=1
    while (directory/f'reconciliation-{sequence:04}.json').exists():sequence+=1
    receipt={'releaseBindingSha256':binding['releaseBindingSha256'],'outcome':outcome,**observed,'behaviorEvidenceSha256':request['validationSha256'],
             'evidenceSha256':digest({'installationReceiptSha256':event['eventSha256'],'startupEvidenceSha256':digest(ready),'observation':observed}), 'recordedAt':utcnow(),
             'nativeInstall':{'artifactSha256':native['artifact']['artifactSha256'],'baselineSha256':baseline['baselineSha256'],'unsignedBundleSha256':native['artifact']['unsignedBundleSha256'],
                              'version':expected['version'],'buildNumber':str(expected['build']),'installedBundleSha256':expected_sha,'startupEvidenceSha256':digest(ready),'installationReceiptSha256':event['eventSha256'],**signature}}
    write(directory/f'reconciliation-{sequence:04}.json',receipt)
    lease=Lease(controller.app,API,fields,directory/'lease.json')
    if expired:
        recovered=lease.action('recover_native_completion',releaseBindingSha256=binding['releaseBindingSha256'])
        require(recovered.get('recoveryOnly') is True and recovered.get('cycleId')==request['cycleId'] and recovered.get('releaseBindingSha256')==binding['releaseBindingSha256'] and isinstance(recovered.get('leaseToken'),str),'native_reconciliation_recovery_unconfirmed')
    usage={'phaseId':'release:'+fields['controllerId'],'actualUsd':0,'evidenceSha256':digest({'nativeCompletionOnly':True,'receiptSha256':digest(receipt)})}
    confirmed(lease.action('complete',receipt=receipt,releaseUsage=usage),request['cycleId'],receipt)
    write(directory/f'reconciliation-{sequence:04}-delivered.json',{'at':utcnow(),'receiptSha256':digest(receipt),'mutatedApplication':False})
    release_retained_lock(attempt_id,directory)
    return {'status':'completion_reconciled','cycleId':request['cycleId'],'receiptSha256':digest(receipt)}
