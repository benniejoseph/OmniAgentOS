"""Bounded owned startup ticket. An expired ticket never grants rollback authority."""
from datetime import datetime,timedelta,timezone
import json
import os
from pathlib import Path
import secrets
from macos_manifest import canonical,private_directory,read_regular,require
from macos_bridge import SOCKET_DIRECTORY
from macos_protocol import date

class StartupTicket:
    def __init__(self,expected,directory=SOCKET_DIRECTORY):
        self.directory=Path(directory);self.directory.mkdir(mode=0o700,parents=True,exist_ok=True);private_directory(self.directory)
        self.path=self.directory/'startup-ticket.json'
        self.value={'protocol':1,'nonce':secrets.token_hex(32),'expected':expected,'publisherPid':os.getpid(),'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=90)).isoformat(timespec='milliseconds').replace('+00:00','Z')}
        raw=canonical(self.value)+b'\n';require(len(raw)<=4096,'native_startup_ticket_bounds')
        with os.fdopen(os.open(self.path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
    def remove(self):
        require(json.loads(read_regular(self.path,4096))==self.value,'native_startup_ticket_changed');self.path.unlink()

def inspect_abandoned_ticket(directory=SOCKET_DIRECTORY):
    """Read-only diagnosis; recovery cannot overwrite a live/ambiguous publisher."""
    root=private_directory(directory);path=root/'startup-ticket.json'
    if not path.exists():return {'status':'absent'}
    value=json.loads(read_regular(path,4096));require(set(value)=={'protocol','nonce','expected','publisherPid','expiresAt'},'native_startup_ticket_invalid')
    require(type(value['publisherPid'])is int and value['publisherPid']>1,'native_startup_ticket_invalid')
    alive=True
    try:os.kill(value['publisherPid'],0)
    except ProcessLookupError:alive=False
    expired=date(value['expiresAt'])<=datetime.now(timezone.utc)
    return {'status':'expired_orphan' if expired and not alive else 'owned_or_uncertain','ticket':value}

def retire_abandoned_ticket(evidence_file,directory=SOCKET_DIRECTORY):
    """Explicit reconciliation only; native already releases its 90s quarantine."""
    observation=inspect_abandoned_ticket(directory);require(observation['status']=='expired_orphan','native_startup_ticket_still_owned')
    raw=canonical(observation)+b'\n'
    with os.fdopen(os.open(evidence_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
    path=Path(directory)/'startup-ticket.json';require(json.loads(read_regular(path,4096))==observation['ticket'],'native_startup_ticket_changed');path.unlink()
    return observation
