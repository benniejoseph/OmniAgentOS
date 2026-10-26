"""Journaled same-volume app replacement. No side effects on import."""
import ctypes
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from macos_manifest import NativeRefused,bundle_identity,canonical,digest,private_directory,read_regular,require,tree_manifest,verify_manifest
from macos_bridge import query,running_code,owned_app_processes
from macos_protocol import utcnow
from macos_sign import PROVENANCE,signature_identity,validate_provenance
from macos_ticket import StartupTicket,inspect_abandoned_ticket

APPLICATIONS=Path('/Applications')
APPLICATION=APPLICATIONS/'Asael.app'

class Journal:
    def __init__(self,path,binding):
        self.path=Path(path);self.binding=binding
        self.path.mkdir(mode=0o700,parents=True,exist_ok=True);private_directory(self.path);self.events=[]
        for file in sorted(self.path.glob('[0-9][0-9][0-9][0-9].json')):
            event=json.loads(read_regular(file,1_000_000));body={key:value for key,value in event.items() if key!='eventSha256'}
            require(event.get('eventSha256')==digest(body) and event['sequence']==len(self.events) and event['binding']==binding and event['previousSha256']==(self.events[-1]['eventSha256'] if self.events else None),'native_install_journal_changed');self.events.append(event)
    def append(self,stage,details=None):
        body={'version':1,'sequence':len(self.events),'stage':stage,'binding':self.binding,'previousSha256':self.events[-1]['eventSha256'] if self.events else None,'at':utcnow(),'details':details or {}}
        event={**body,'eventSha256':digest(body)};path=self.path/f'{len(self.events):04}.json'
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:stream.write(canonical(event)+b'\n');stream.flush();os.fsync(stream.fileno())
        descriptor=os.open(self.path,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)
        self.events.append(event);return event

def atomic_swap(left,right):
    left,right=Path(left),Path(right)
    require(left.stat().st_dev==right.stat().st_dev and not left.is_symlink() and not right.is_symlink(),'native_install_volume_changed')
    lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True);lib.renameatx_np.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];lib.renameatx_np.restype=ctypes.c_int
    require(lib.renameatx_np(-2,os.fsencode(left),-2,os.fsencode(right),2)==0,'native_atomic_swap_failed')
    for parent in {left.parent,right.parent}:
        fd=os.open(parent,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)

def expected_binding(bundle,owner_sha):
    value=validate_provenance(json.loads(read_regular(Path(bundle)/PROVENANCE,4096)))
    return {key:value[key] for key in ('sourceRevision','sourceSnapshotSha256','version','build')}|{'ownerSha256':owner_sha}

def executable(bundle):return Path(bundle)/'Contents/MacOS'/bundle_identity(bundle)['CFBundleExecutable']

def stop_quiesced(reply,bundle,signature,expected,*,deadline_monotonic):
    require(reply['status']=='quiesced' and not reply['busyReasons'] and time.monotonic()<deadline_monotonic,'native_install_not_quiesced')
    from macos_protocol import date
    require((date(reply['quiescenceExpiresAt'])-datetime.now(timezone.utc)).total_seconds()>5,'native_install_quiescence_expired')
    running_code(reply['pid'],executable(bundle),signature['codeSignatureSha256'])
    try:
        acknowledged=query('quit',expected,executable(bundle),signature['codeSignatureSha256'],expected_pid=reply['pid'],nonce=reply['nonce'])
        require(acknowledged['status']=='quiesced','native_install_quit_unconfirmed')
    except (NativeRefused,OSError,ValueError):
        if not owned_app_processes():return
        raise NativeRefused('native_install_quit_unconfirmed') from None
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        try:
            try:os.waitpid(reply['pid'],os.WNOHANG)
            except ChildProcessError:pass
            os.kill(reply['pid'],0)
        except ProcessLookupError:return
        time.sleep(.2)
    raise NativeRefused('native_install_app_did_not_exit')

def launch_canary(bundle,log):
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(Path.home()),'LANG':'en_US.UTF-8','TMPDIR':os.environ.get('TMPDIR','/tmp')};stream=Path(log).open('xb')
    try:return subprocess.Popen([str(executable(bundle)),'--asael-update-canary'],env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
    finally:stream.close()

def wait_ready(bundle,expected,signature,process,timeout=60,nonce=None):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        require(process.poll() is None,'native_candidate_exited_before_ready')
        try:
            value=query('status',expected,executable(bundle),signature['codeSignatureSha256'],expected_pid=process.pid,nonce=nonce)
            if value['status']=='ready':return value
        except (NativeRefused,OSError,ValueError):pass
        time.sleep(1)
    raise NativeRefused('native_candidate_startup_unproven')

def commit_startup(bundle,expected,signature,process,ticket):
    try:query('commit',expected,executable(bundle),signature['codeSignatureSha256'],expected_pid=process.pid,nonce=ticket.value['nonce'])
    except (NativeRefused,OSError,ValueError):pass
    # A lost commit response is reconciled with actual admission state, not retried.
    reply=query('status',expected,executable(bundle),signature['codeSignatureSha256'],expected_pid=process.pid,nonce=ticket.value['nonce'])
    require(reply['status']=='ready' and not reply['startupQuarantined'] and reply['startupDecision']=='committed','native_startup_commit_unconfirmed')
    ticket.remove();return reply


def observed_layout(application,backup,old_sha,new_sha):
    def measured(path):return tree_manifest(path,'bundle')['manifestSha256'] if Path(path).exists() else None
    active,retained=measured(application),measured(backup)
    if active==old_sha and retained==new_sha:return 'prior_installed'
    if active==new_sha and retained==old_sha:return 'candidate_installed'
    return 'reconciliation_required'

def install_signed(prepared,baseline,owner_sha,journal_directory,staging_directory):
    """Only after exact approval and server release claim. Never blind replay."""
    application=APPLICATION;staging_root=private_directory(staging_directory)
    require(staging_root.parent==APPLICATIONS and application.stat().st_dev==staging_root.stat().st_dev,'native_install_staging_location_invalid')
    require(inspect_abandoned_ticket()['status']=='absent','native_startup_ticket_requires_reconciliation')
    new_sha=prepared['manifest']['manifestSha256'];old_sha=baseline['bundleSha256']
    binding={'artifactSha256':prepared['artifactSha256'],'approvalSha256':prepared['approvalSha256'],'oldBundleSha256':old_sha,'newBundleSha256':new_sha}
    journal=Journal(journal_directory,binding);backup=staging_root/('Asael-'+prepared['artifactSha256'][:24]+'.app')
    if journal.events:raise NativeRefused('native_install_resume_'+observed_layout(application,backup,old_sha,new_sha))
    require(not backup.exists(),'native_install_staging_exists');verify_manifest(prepared['path'],prepared['manifest'],'bundle')
    require(tree_manifest(application,'bundle')['manifestSha256']==old_sha,'native_installed_baseline_changed')
    prior_signature=signature_identity(application)
    require(prior_signature['signingIdentitySha256']==baseline['signingIdentitySha256'] and prior_signature['designatedRequirementSha256']==baseline['designatedRequirementSha256'],'native_installed_signature_changed')
    shutil.copytree(prepared['path'],backup,symlinks=True);verify_manifest(backup,prepared['manifest'],'bundle')
    old_expected=expected_binding(application,owner_sha);new_expected=expected_binding(backup,owner_sha);journal.append('prepared',{'stagedPath':str(backup)})
    if owned_app_processes():
        started=time.monotonic();quiesced=query('quiesce',old_expected,executable(application),prior_signature['codeSignatureSha256'])
        require(quiesced['status']=='quiesced','native_install_busy');journal.append('quiesced',{'evidenceSha256':digest(quiesced),'pid':quiesced['pid']})
        stop_quiesced(quiesced,application,prior_signature,old_expected,deadline_monotonic=started+25);journal.append('prior_stopped')
    else:journal.append('prior_already_stopped')
    require(not owned_app_processes(),'native_helper_or_app_still_running')
    journal.append('swap_intent');atomic_swap(application,backup);journal.append('swapped');process=None;ticket=None
    try:
        require(observed_layout(application,backup,old_sha,new_sha)=='candidate_installed','native_install_swap_unproven')
        signature=signature_identity(application);require(signature==prepared['signature'],'native_installed_candidate_signature_changed')
        ticket=StartupTicket(new_expected);journal.append('startup_ticket_created',{'ticketSha256':digest(ticket.value)})
        process=launch_canary(application,Path(journal_directory)/'candidate.log');journal.append('candidate_started',{'pid':process.pid})
        ready=wait_ready(application,new_expected,signature,process,nonce=ticket.value['nonce'])
        require(ready['startupQuarantined'],'native_startup_quarantine_missing');journal.append('commit_intent')
        ack=commit_startup(application,new_expected,signature,process,ticket);ticket=None
        event=journal.append('verified',{'startupEvidenceSha256':digest(ack)})
        return {'outcome':'deployed','version':new_expected['version'],'buildNumber':str(new_expected['build']),'installedBundleSha256':new_sha,'startupEvidenceSha256':digest(ack),'installationReceiptSha256':event['eventSha256'],**signature}
    except Exception:
        if process is not None and process.poll() is None:
            try:
                started=time.monotonic();quiet=query('quiesce',new_expected,executable(application),prepared['signature']['codeSignatureSha256'],expected_pid=process.pid,nonce=ticket.value['nonce'] if ticket else None)
                stop_quiesced(quiet,application,prepared['signature'],new_expected,deadline_monotonic=started+25)
            except Exception:
                journal.append('rollback_held',{'category':'candidate_quiescence_unproven'});raise NativeRefused('native_rollback_requires_quiescence') from None
        if ticket is not None:ticket.remove();ticket=None
        require(observed_layout(application,backup,old_sha,new_sha)=='candidate_installed','native_rollback_layout_changed')
        journal.append('rollback_intent');atomic_swap(application,backup);journal.append('prior_restored')
        prior_ticket=StartupTicket(old_expected);prior=launch_canary(application,Path(journal_directory)/'rollback.log')
        wait_ready(application,old_expected,prior_signature,prior,nonce=prior_ticket.value['nonce'])
        ack=commit_startup(application,old_expected,prior_signature,prior,prior_ticket)
        require(observed_layout(application,backup,old_sha,new_sha)=='prior_installed','native_rollback_unproven')
        event=journal.append('rolled_back',{'startupEvidenceSha256':digest(ack)})
        return {'outcome':'rolled_back','version':old_expected['version'],'buildNumber':str(old_expected['build']),'installedBundleSha256':old_sha,'startupEvidenceSha256':digest(ack),'installationReceiptSha256':event['eventSha256'],**prior_signature}
