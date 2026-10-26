"""Fixed owner-local readiness transport with kernel peer/code identity checks."""
import ctypes
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import subprocess
import struct
import time
from macos_manifest import NativeRefused,canonical,digest,private_directory,require
from macos_sign import validate_provenance

REASONS={'build_mismatch','owner_mismatch','session_unavailable','workspace_locked','workspace_not_ready','route_not_rendered','unsaved_draft','inspection_incomplete','desktop_enabled','desktop_busy','capture_busy','auxiliary_window','voice_active','conversation_busy','host_unavailable','request_in_progress'}
SOCKET_DIRECTORY=Path.home()/'Library/Application Support/Asael/native-publisher'

def running_code(pid,expected_executable,expected_signature_sha256):
    """Measure the live kernel code object, not just bytes now found at its path."""
    require(type(pid)is int and pid>1,'native_peer_pid_invalid')
    system=ctypes.CDLL('/usr/lib/libSystem.B.dylib');path=ctypes.create_string_buffer(4096)
    system.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
    require(system.proc_pidpath(pid,path,len(path))>0 and path.value.decode()==str(expected_executable),'native_running_path_changed')
    security=ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security');cf=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cf.CFNumberCreate.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p];cf.CFNumberCreate.restype=ctypes.c_void_p
    cf.CFDictionaryCreate.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_long,ctypes.c_void_p,ctypes.c_void_p];cf.CFDictionaryCreate.restype=ctypes.c_void_p
    cf.CFDictionaryGetValue.argtypes=[ctypes.c_void_p,ctypes.c_void_p];cf.CFDictionaryGetValue.restype=ctypes.c_void_p
    cf.CFDataGetLength.argtypes=[ctypes.c_void_p];cf.CFDataGetLength.restype=ctypes.c_long
    cf.CFDataGetBytePtr.argtypes=[ctypes.c_void_p];cf.CFDataGetBytePtr.restype=ctypes.c_void_p
    cf.CFRelease.argtypes=[ctypes.c_void_p]
    security.SecCodeCopyGuestWithAttributes.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint32,ctypes.POINTER(ctypes.c_void_p)];security.SecCodeCopyGuestWithAttributes.restype=ctypes.c_int32
    security.SecCodeCopySigningInformation.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.POINTER(ctypes.c_void_p)];security.SecCodeCopySigningInformation.restype=ctypes.c_int32
    security.SecCodeCheckValidity.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p];security.SecCodeCheckValidity.restype=ctypes.c_int32
    number=ctypes.c_int(pid);number_ref=cf.CFNumberCreate(None,9,ctypes.byref(number))
    key=ctypes.c_void_p.in_dll(security,'kSecGuestAttributePid').value
    keys=(ctypes.c_void_p*1)(key);values=(ctypes.c_void_p*1)(number_ref)
    attributes=cf.CFDictionaryCreate(None,keys,values,1,None,None);code=ctypes.c_void_p();info=ctypes.c_void_p()
    try:
        require(security.SecCodeCopyGuestWithAttributes(None,attributes,0,ctypes.byref(code))==0 and security.SecCodeCheckValidity(code,0,None)==0,'native_running_signature_invalid')
        require(security.SecCodeCopySigningInformation(code,2,ctypes.byref(info))==0,'native_running_signature_unavailable')
        unique=cf.CFDictionaryGetValue(info,ctypes.c_void_p.in_dll(security,'kSecCodeInfoUnique').value)
        require(unique and 16<=cf.CFDataGetLength(unique)<=64,'native_running_signature_missing')
        raw=ctypes.string_at(cf.CFDataGetBytePtr(unique),cf.CFDataGetLength(unique))
        require(digest(raw.hex().encode())==expected_signature_sha256,'native_running_signature_changed')
    finally:
        for handle in (info,code,attributes,number_ref):
            if handle:cf.CFRelease(handle)
    return pid

def validate_reply(value,request,peer_pid):
    require(isinstance(value,dict) and set(value)=={'protocol','action','nonce','binding','pid','status','flutterReady','authenticatedWorkspaceReady','improvementRendered','busyReasons','quiescenceExpiresAt','startupQuarantined','quarantineExpiresAt','startupDecision'},'native_bridge_reply_contract_changed')
    require(value['protocol']==1 and value['action']==request['action'] and value['nonce']==request['nonce'] and value['pid']==peer_pid,'native_bridge_reply_identity_changed')
    binding=value['binding'];expected=request['expected'];require(set(binding)==set(expected),'native_bridge_binding_contract_changed')
    require(all(binding[key]==expected[key] for key in expected if key!='ownerSha256') and binding['ownerSha256'] in (None,expected['ownerSha256']),'native_bridge_binding_changed')
    require(value['status'] in ('held','ready','quiesced') and all(type(value[key])is bool for key in ('flutterReady','authenticatedWorkspaceReady','improvementRendered')),'native_bridge_status_invalid')
    reasons=value['busyReasons'];require(isinstance(reasons,list) and len(reasons)==len(set(reasons)) and set(reasons)<=REASONS,'native_bridge_reason_invalid')
    require(type(value['startupQuarantined'])is bool and value['startupDecision'] in ('none','pending','committed','expired'),'native_bridge_quarantine_invalid')
    require(value['startupQuarantined']==(value['startupDecision']=='pending'),'native_bridge_quarantine_state_changed')
    if value['startupQuarantined']:
        from macos_protocol import date
        require(5<(date(value['quarantineExpiresAt'])-datetime.now(timezone.utc)).total_seconds()<=91,'native_bridge_quarantine_expired')
    else:require(value['quarantineExpiresAt'] is None,'native_bridge_unexpected_quarantine')
    if value['status']=='ready' or (value['status']=='quiesced' and not value['startupQuarantined']):
        require(binding==expected and value['flutterReady'] and value['authenticatedWorkspaceReady'] and value['improvementRendered'],'native_bridge_readiness_unproven')
    if value['status']=='quiesced':
        require(request['action'] in ('quiesce','quit') and not reasons,'native_bridge_quiescence_unproven')
        from macos_protocol import date
        remaining=(date(value['quiescenceExpiresAt'])-datetime.now(timezone.utc)).total_seconds();require(5<remaining<=31,'native_bridge_quiescence_expired')
    else:require(value['quiescenceExpiresAt'] is None,'native_bridge_unexpected_lease')
    return value

def query(action,expected,executable,signature_sha256,*,expected_pid=None,nonce=None,directory=SOCKET_DIRECTORY):
    require(action in ('status','quiesce','commit','quit'),'native_bridge_action_forbidden')
    validate_provenance({'protocol':1,**{key:expected[key] for key in ('sourceRevision','sourceSnapshotSha256','version','build')}})
    directory=private_directory(directory);path=directory/'bridge.sock';info=path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid==os.getuid() and info.st_mode&0o777==0o600,'native_bridge_socket_invalid')
    request={'protocol':1,'action':action,'nonce':nonce or secrets.token_hex(32),'expected':expected};raw=canonical(request)+b'\n';require(len(raw)<=4096,'native_bridge_request_bounds')
    started=time.monotonic()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(8);client.connect(str(path));peer_pid=struct.unpack('i',client.getsockopt(0,2,4))[0]
        require(expected_pid is None or peer_pid==expected_pid,'native_bridge_process_changed')
        running_code(peer_pid,executable,signature_sha256);client.sendall(raw);response=b''
        while b'\n' not in response and len(response)<=4096:
            chunk=client.recv(4097-len(response));require(chunk,'native_bridge_response_incomplete');response+=chunk
        require(response.endswith(b'\n') and response.count(b'\n')==1 and len(response)<=4096,'native_bridge_response_bounds')
    value=validate_reply(json.loads(response),request,peer_pid)
    require(time.monotonic()-started<8,'native_bridge_response_stale')
    return value


def owned_app_processes():
    """Read PID/UID and executable paths only, never process command arguments."""
    result=subprocess.run(['/bin/ps','-axo','uid=,pid=,ppid='],env={'PATH':'/usr/bin:/bin','HOME':'/var/empty'},capture_output=True,timeout=10)
    require(result.returncode==0 and len(result.stdout)<2_000_000,'native_process_inventory_unavailable')
    system=ctypes.CDLL('/usr/lib/libSystem.B.dylib');system.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32];found=[]
    for line in result.stdout.decode().splitlines():
        uid,pid,parent_pid=map(int,line.split())
        if uid!=os.getuid():continue
        buffer=ctypes.create_string_buffer(4096)
        if system.proc_pidpath(pid,buffer,len(buffer))<=0:
            try:os.kill(pid,0)
            except ProcessLookupError:continue
            raise NativeRefused('native_process_inventory_unproven')
        path=buffer.value.decode()
        if path.startswith('/Applications/Asael.app/') or path.endswith(('/Contents/MacOS/omniagent','/AsaelComputerUseHelper','/AsaelCommandRunnerHelper','/AsaelCredentialBroker')):found.append({'pid':pid,'parentPid':parent_pid,'path':path})
    return found
