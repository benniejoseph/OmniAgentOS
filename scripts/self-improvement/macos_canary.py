"""Run an explicit synthetic isolation canary. Never reads real credential values."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from macos_manifest import canonical,digest,require
from macos_sandbox import sandbox_profile,choose_test_port

PROGRAM=r'''
import ctypes,json,socket,sys,threading
port=int(sys.argv[1]);other=int(sys.argv[2]);private=sys.argv[3]
result={}
server=socket.socket();server.bind(('127.0.0.1',port));server.listen()
thread=threading.Thread(target=lambda:server.accept()[0].close());thread.start()
client=socket.create_connection(('127.0.0.1',port),2);client.close();thread.join(2);server.close();result['exactLoopbackAllowed']=not thread.is_alive()
for key,address in [('otherLoopbackDenied',('127.0.0.1',other)),('externalDenied',('1.1.1.1',443))]:
 try:
  client=socket.create_connection(address,1);client.close();result[key]=False
 except PermissionError:result[key]=True
 except OSError as e:result[key]=e.errno in (1,13)
try:open(private,'rb').read(1);result['privateFileDenied']=False
except PermissionError:result['privateFileDenied']=True
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib');bootstrap=ctypes.c_uint.in_dll(lib,'bootstrap_port').value;service=ctypes.c_uint()
status=lib.bootstrap_look_up(bootstrap,b'com.apple.securityd',ctypes.byref(service))
result['keychainServiceDenied']=status!=0;result['keychainLookupStatus']=status
print(json.dumps(result,sort_keys=True))
'''

def run(directory,developer_directory=None):
    root=Path(directory).absolute();root.mkdir(mode=0o700,parents=True,exist_ok=False)
    home=root/'home';home.mkdir(mode=0o700);(home/'tmp').mkdir(mode=0o700);source=root/'source';source.mkdir(mode=0o700)
    private=root/'outside-readable-roots.txt';private.write_text('synthetic boundary canary, not a credential');private.chmod(0o600)
    port=choose_test_port()
    with socket.socket() as other:
        other.bind(('127.0.0.1',0));other.listen();other_port=other.getsockname()[1]
        profile=sandbox_profile(source,home,['/opt/homebrew'],port=port,developer_directory=developer_directory)
        profile_path=root/'boundary.sb';profile_path.write_text(profile)
        result=subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile_path),sys.executable,'-B','-c',PROGRAM,str(port),str(other_port),str(private)],capture_output=True,timeout=15,env={'HOME':str(home),'PATH':'/usr/bin:/bin'})
    require(result.returncode==0,'native_boundary_canary_process_failed')
    actual=json.loads(result.stdout)
    receipt={'kind':'native-isolation-boundary-canary','profileSha256':digest(profile.encode()),'scriptSha256':digest(PROGRAM.encode()),'observations':actual,'stdoutSha256':digest(result.stdout),'stderrSha256':digest(result.stderr),'productionTouched':False}
    (root/'receipt.json').write_bytes(canonical(receipt)+b'\n')
    require(all(actual.get(key)is True for key in ('exactLoopbackAllowed','otherLoopbackDenied','externalDenied','privateFileDenied','keychainServiceDenied')),'native_boundary_canary_failed')
    return receipt
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--directory',required=True);parser.add_argument('--developer-directory');args=parser.parse_args();print(json.dumps(run(args.directory,args.developer_directory),indent=2))
