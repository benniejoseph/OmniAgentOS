"""Installed local validator/publisher integration. No credentials in child builds."""
import contextlib
import json
import os
from pathlib import Path
import threading
import uuid
from macos_manifest import NativeRefused,canonical,digest,private_directory,read_regular,require,verify_seal
from macos_protocol import utcnow,validate_request as validate_native_request,validate_receipt
from macos_sign import PROVENANCE,installed_baseline,prepare_signed,validate_approval
from macos_build import validate_snapshot,verify_toolchain
from macos_install import install_signed,expected_binding,executable
from macos_bridge import query,owned_app_processes
from macos_source import eligible

API='/api/self-improvement/native-controller'

class Lease:
    def __init__(self,app,route,fields,state_file=None):
        self.app=app;self.route=route;self.fields=fields;self.state_file=Path(state_file) if state_file else None;self.mutex=threading.Lock();self.stop=threading.Event();self.failed=threading.Event();self.persist(None)
    def persist(self,pending):
        if self.state_file:
            temporary=self.state_file.with_name('.lease-'+uuid.uuid4().hex+'.json');write(temporary,{'version':1,'route':self.route,'fields':self.fields,'pending':pending,'recordedAt':utcnow()});os.replace(temporary,self.state_file)
            fd=os.open(self.state_file.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
    def action(self,action,**fields):
        with self.mutex:
            self.live()
            body={'action':action,**self.fields,**fields}
            self.persist({'action':action,'requestSha256':digest(body),**({'receipt':fields['receipt'],'releaseUsage':fields.get('releaseUsage')} if action=='complete' else {})})
            try:
                value=self.app.request('POST',self.route,body)
                if action in ('heartbeat','recover_native_completion'):
                    token=value.get('leaseToken') or value.get('nextToken')
                    require(isinstance(token,str) and token!=self.fields['leaseToken'],'native_heartbeat_token_unconfirmed')
                    self.fields['leaseToken']=token
                self.persist(None);return value
            except Exception:
                self.failed.set();raise
    def __enter__(self):
        def heartbeat():
            while not self.stop.wait(30):
                try:self.action('heartbeat')
                except Exception:self.failed.set();return
        self.thread=threading.Thread(target=heartbeat,daemon=True);self.thread.start();return self
    def __exit__(self,*unused):self.stop.set();self.thread.join(timeout=35)
    def live(self):require(not self.failed.is_set(),'native_lease_heartbeat_failed')

@contextlib.contextmanager
def publication_lock(attempt_id):
    root=Path.home()/'.asael';root.mkdir(mode=0o700,exist_ok=True);private_directory(root);directory=root/'production-release.lock'
    try:directory.mkdir(mode=0o700)
    except FileExistsError:raise NativeRefused('native_other_publication_active') from None
    marker=directory/'owner.json';owner={'version':1,'token':str(uuid.uuid4()),'pid':os.getpid(),'startedAt':utcnow(),'attemptId':attempt_id};marker.write_bytes(canonical(owner)+b'\n');marker.chmod(0o600)
    state={'retain':False}
    try:yield state
    finally:
        require(json.loads(read_regular(marker))==owner,'native_publication_lock_changed')
        if not state['retain']:marker.unlink();directory.rmdir()

def write(path,value):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:stream.write(canonical(value)+b'\n');stream.flush();os.fsync(stream.fileno())

def validate_native_release(request,config):
    native=request.get('native');require(request.get('releaseTarget')=='macos_app' and request['candidate'].get('releaseTarget')=='macos_app' and native==request['validation'].get('native'),'native_release_target_changed')
    require(config.get('native',{}).get('enabled') is True and isinstance(native,dict),'native_publisher_not_installed')
    require(all(eligible(row['path']) for row in request['candidate']['changedFiles']),'native_protected_change_forbidden')
    artifact=native['artifact'];baseline=native['installedBaseline'];validate_approval(request['approval'],request,artifact,baseline)
    require(artifact['sourceManifestSha256']==request['candidate']['workspaceSha256'],'native_release_workspace_changed')
    require(request.get('pairedBaseline',native['pairedBaseline'])==native['pairedBaseline'],'native_release_pair_changed')
    return native

def serving_baseline(controller,request,observation):
    pair=request.get('pairedBaseline');expected=pair['webRevision'] if pair else request['previousRevision']
    require(observation['webRevision']==observation['workerRevision']==expected,'production_advanced')
    if pair:require(pair['workerRevision']==expected and pair['manifestSha256']==observation['manifestSha256'],'serving_baseline_changed')
    if expected!=request['previousRevision']:
        require(controller.git('merge-base',expected,request['previousRevision'])==expected,'native_ancestry_not_proven')
        changes=controller.git('diff','--name-only','--no-renames',expected,request['previousRevision']).splitlines()
        require(changes and all(eligible(path) for path in changes),'native_only_ancestry_not_proven')
        raw=controller.git('diff','--raw','--no-abbrev','--no-renames',expected,request['previousRevision']).splitlines();leaves=[]
        for entry in raw:
            metadata,path=entry.split('\t',1);before,after,old_oid,new_oid,status=metadata.split();before=before.removeprefix(':')
            require(eligible(path) and status in ('A','D','M') and before in ('000000','100644','100755') and after in ('000000','100644','100755') and not (before==after=='000000') and (before=='000000' or after=='000000' or before==after),'native_ancestry_mode_or_type_changed');leaves.append(path)
        require(leaves==changes,'native_ancestry_inventory_changed')
    return expected

def execute_validation(controller,request):
    config=controller.config;native=config.get('native',{});require(native.get('enabled') is True,'native_validator_not_installed')
    validate_native_request(request,controller.app.actor,config['allowedPolicySha256'])
    require(controller.git('remote','get-url','origin') in ('https://github.com/benniejoseph/OmniAgentOS.git','git@github.com:benniejoseph/OmniAgentOS.git'),'native_repository_changed')
    controller.git('fetch','origin',request['snapshot']['baseRevision'])
    root=controller.state/'native-validation';root.mkdir(mode=0o700,exist_ok=True);directory=root/request['requestSha256']
    require(not directory.exists(),'native_validation_existing_attempt_requires_reconciliation')
    # Baseline is independently measured before claiming; no paid model work.
    app=Path('/Applications/Asael.app');provenance=json.loads(read_regular(app/PROVENANCE,4096));baseline=installed_baseline(app,provenance['sourceRevision'])
    observed=controller.observe();require(observed['webRevision']==observed['workerRevision'],'native_server_pair_unhealthy')
    paired={key:observed[key] for key in ('webRevision','workerRevision','manifestSha256')}
    directory.mkdir(mode=0o700);write(directory/'request.json',request)
    claim=controller.app.request('POST',API,{'action':'claim','cycleId':request['cycleId'],'requestId':request['requestId'],'requestSha256':request['requestSha256'],'controllerId':config['controllerId']})['claim']
    require(claim['request']==request,'native_claim_changed')
    fields={'cycleId':request['cycleId'],'requestId':request['requestId'],'controllerId':config['controllerId'],'leaseToken':claim['leaseToken']}
    with Lease(controller.app,API,fields,directory/'lease.json') as lease:
        try:
            payload=lease.action('source');lease.live()
            receipt=validate_snapshot(controller.root,directory/'validation',request,payload,native['toolchain'],baseline,paired,config['controllerId'])
            write(directory/'receipt.json',receipt)
            location=directory/'validation/artifact-location.json'
            if location.exists():write(directory/'artifact-location.json',json.loads(read_regular(location)))
            lease.live()
            result=lease.action('complete',receipt=receipt);require(result.get('status')=='completed' and result.get('cycleId')==request['cycleId'] and result.get('requestId')==request['requestId'] and result.get('receiptSha256')==receipt['receiptSha256'],'native_completion_unconfirmed')
            write(directory/'delivered.json',{'at':utcnow(),'receiptSha256':receipt['receiptSha256']});return receipt
        except Exception as error:
            category=str(error) if isinstance(error,NativeRefused) else 'native_validation_failed'
            if directory.exists() and not (directory/'held.json').exists():write(directory/'held.json',{'at':utcnow(),'category':category})
            try:lease.action('hold',category=category)
            except Exception:pass
            raise NativeRefused(category) from None

def native_preflight(controller,request):
    from macos_sign import signature_identity
    native=request['validation']['native'];app=Path('/Applications/Asael.app');signature=signature_identity(app)
    require(signature['signingIdentitySha256']==native['installedBaseline']['signingIdentitySha256'] and signature['designatedRequirementSha256']==native['installedBaseline']['designatedRequirementSha256'],'native_installed_signature_changed')
    processes=owned_app_processes()
    if not processes:return True
    expected=expected_binding(app,digest([request['tenantId'],request['ownerActorId']]))
    primary=[row for row in processes if row['path']==str(executable(app))]
    ready=False
    if len(primary)==1 and all(row['pid']==primary[0]['pid'] or (row['parentPid']==primary[0]['pid'] and row['path'].startswith(str(app/'Contents/Helpers')+'/')) for row in processes):
        try:
            status=query('status',expected,executable(app),signature['codeSignatureSha256'],expected_pid=primary[0]['pid'])
            ready=status['status']=='ready' and not status['busyReasons'] and not status['startupQuarantined']
        except (NativeRefused,OSError,ValueError):pass
    if not ready:
        controller.app.request('POST','/api/self-improvement/release-controller',{'action':'status','controllerId':controller.config['controllerId'],'status':'held','category':'native_mac_waiting','observedAt':utcnow()})
    return ready


def execute_native_release(controller,request):
    from controller import API as RELEASE_API,validate_request,release_usage
    validate_request(request,controller.config,controller.app.actor);native=validate_native_release(request,controller.config)
    if not native_preflight(controller,request):return {'status':'waiting_for_mac','cycleId':request['cycleId'],'approvalRetained':True}
    directory=controller.state/digest({'cycleId':request['cycleId'],'candidateRevision':request['candidateRevision']})
    require(not directory.exists(),'native_release_existing_attempt_requires_reconciliation');directory.mkdir(mode=0o700);write(directory/'request.json',request)
    controller.checkout_guard(request)
    validation_root=controller.state/'native-validation'/native['requestSha256']
    validation_request=json.loads(read_regular(validation_root/'request.json'));validation_receipt=json.loads(read_regular(validation_root/'receipt.json'))
    validate_receipt(validation_request,validation_receipt)
    require(validation_receipt['receiptSha256']==native['receiptSha256'] and validation_receipt['artifact']==native['artifact'],'native_prepared_receipt_changed')
    location=json.loads(read_regular(validation_root/'artifact-location.json'));require(location['artifact']==native['artifact'] and Path(location['path']).resolve().is_relative_to(validation_root.resolve()),'native_prepared_artifact_missing')
    with publication_lock(directory.name) as publication:
        observed=controller.observe();serving_baseline(controller,request,observed)
        require(all(observed[key]==native['pairedBaseline'][key] for key in ('webRevision','workerRevision','manifestSha256')),'native_server_pair_changed')
        current=installed_baseline('/Applications/Asael.app',native['installedBaseline']['sourceRevision']);require(current==native['installedBaseline'],'native_installed_baseline_changed')
        claim=controller.app.request('POST',RELEASE_API,{'action':'claim','cycleId':request['cycleId'],'candidateRevision':request['candidateRevision'],'controllerId':controller.config['controllerId']})['claim']
        require(claim['request']==request and claim['releaseBudget']['reservedUsd']==0,'native_release_claim_changed');usage=release_usage(claim['releaseBudget'])
        fields={'cycleId':request['cycleId'],'controllerId':controller.config['controllerId'],'leaseToken':claim['leaseToken']}
        with Lease(controller.app,RELEASE_API,fields,directory/'lease.json') as lease:
            try:
                write(directory/'claimed.json',{'at':utcnow()});merged,tree=controller.merge(request);write(directory/'merged.json',{'mergedRevision':merged,'tree':tree})
                lease.live();binding=lease.action('prepare',mergedRevision=merged,sourceTree=tree,mergedTree=tree)['releaseBinding'];write(directory/'release-binding.json',binding);verify_seal('release_binding',binding,'releaseBindingSha256')
                require(binding['candidateRevision']==merged and binding['sourceCandidateRevision']==request['candidateRevision'] and binding['previousRevision']==request['previousRevision'] and binding['sourceTree']==binding['mergedTree']==tree and binding['native']=={**native,'approvalSha256':request['approval']['receiptSha256']} and binding['runner']=='asael_macos_publisher' and binding['validationSha256']==request['validationSha256'] and binding['policySha256']==request['policySha256'] and binding.get('releaseTarget')=='macos_app' and binding['candidateSha256']==request['candidate']['candidateSha256'] and binding['scope']==request['validation']['scope'] and binding['pullRequestUrl']==request['pullRequestUrl'] and binding.get('pairedBaseline')==request.get('pairedBaseline'),'native_release_binding_changed')
                prepared=prepare_signed(location['path'],directory/'signed/Asael.app',location['manifest'],request,merged,controller.config['native']['signing']);write(directory/'signed.json',prepared);lease.live()
                owner_sha=digest([request['tenantId'],request['ownerActorId']]);publication['retain']=True;result=install_signed(prepared,native['installedBaseline'],owner_sha,directory/'install-journal',controller.config['native']['stagingDirectory'])
                observed=controller.observe();require(all(observed[key]==native['pairedBaseline'][key] for key in ('webRevision','workerRevision','manifestSha256')),'native_server_pair_changed_during_install');publication['retain']=False
                install={'artifactSha256':native['artifact']['artifactSha256'],'baselineSha256':native['installedBaseline']['baselineSha256'],'unsignedBundleSha256':native['artifact']['unsignedBundleSha256'],'version':native['artifact']['version'],'buildNumber':native['artifact']['buildNumber'],**{key:value for key,value in result.items() if key!='outcome'}}
                receipt={'releaseBindingSha256':binding['releaseBindingSha256'],'outcome':result['outcome'],**observed,'behaviorEvidenceSha256':request['validationSha256'],'evidenceSha256':digest(result),'recordedAt':utcnow(),'nativeInstall':install};write(directory/'receipt.json',receipt)
                confirmed=lease.action('complete',receipt=receipt,releaseUsage=usage)
                require(confirmed.get('cycleId')==request['cycleId'] and confirmed.get('stage')=={'deployed':'succeeded','rolled_back':'rolled_back','failed':'failed'}[receipt['outcome']] and all(confirmed.get('receipt',{}).get(key)==value for key,value in receipt.items()),'native_release_completion_unconfirmed')
                write(directory/'delivered.json',{'at':utcnow(),'receiptSha256':digest(receipt)});return receipt
            except Exception as error:
                category=str(error) if isinstance(error,NativeRefused) else 'native_publication_failed'
                write(directory/'held.json',{'at':utcnow(),'category':category})
                try:lease.action('hold',candidateRevision=request['candidateRevision'],category=category,occurredAt=utcnow(),releaseUsage=usage)
                except Exception:pass
                raise NativeRefused(category) from None
