"""Deny-by-default native build sandbox with one explicit Flutter test socket."""
import json
import os
from pathlib import Path
import socket
from macos_manifest import require

def choose_test_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]

def sandbox_profile(root,home,readable,*,port=None,developer_directory=None):
    root=Path(root).resolve(); home=Path(home).resolve()
    require(home!=root and not home.is_relative_to(root),'native_build_home_invalid')
    quote=lambda value:json.dumps(str(value))
    reads={'/System','/usr','/bin','/sbin','/dev','/private/var/db/dyld',str(root),str(home),*[str(Path(p).resolve()) for p in readable]}
    if developer_directory:
        reads.add(str(Path(developer_directory).resolve().parent))
        reads.add('/Library/Developer/PrivateFrameworks')
        reads.add('/Library/Apple/System/Library/PrivateFrameworks')
    writes=[home,root/'apps/flutter/.dart_tool',root/'apps/flutter/build',root/'apps/flutter/macos/Flutter/ephemeral',root/'apps/flutter/.flutter-plugins-dependencies']
    lines=['(version 1)','(deny default)','(allow process-exec process-fork sysctl-read)','(allow signal (target same-sandbox))',
           '(allow ipc-posix-shm)','(allow file-read-metadata)','(allow file-read* (literal "/"))',
           '(allow file-read* (literal "/Library/Preferences/com.apple.dt.Xcode.plist"))',
           *[f'(allow file-read* (subpath {quote(p)}))' for p in sorted(reads)],
           '(allow file-write* '+ ' '.join(f'(subpath {quote(p)})' for p in writes)+' (literal "/dev/null"))',
           '(deny file-read* (regex #"(^|/)[.]env([./]|$)"))',
           '(deny file-read* (regex #"(^|/)(credentials([.]json)?|[.]netrc|[.]npmrc|[.]git-credentials|id_rsa|id_ed25519)$"))',
           *[f'(deny file-read* (subpath {quote(Path.home()/p)}))' for p in ('Library/Keychains','.ssh','.asael','Library/Application Support/Asael/signing-v2')],
           f'(deny file-read* (subpath {quote(root/".git")}))']
    if port is not None:
        require(type(port)is int and 1024<=port<=65535,'native_test_port_invalid')
        lines += [f'(allow network-bind (local ip "localhost:{port}"))',
                  f'(allow network-inbound (local ip "localhost:{port}"))',
                  f'(allow network-outbound (remote ip "localhost:{port}"))']
    return '\n'.join(lines)+'\n'

def clean_environment(home,sdk,pub_cache,*,port=None,developer_directory=None):
    home=Path(home).resolve()
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'TMPDIR':str(home/'tmp')+'/',
         'LANG':'en_US.UTF-8','USER':'asael-builder','LOGNAME':'asael-builder','CI':'true','FLUTTER_ROOT':str(Path(sdk).resolve()),'PUB_CACHE':str(Path(pub_cache).resolve()),
         'FLUTTER_ALREADY_LOCKED':'true','FLUTTER_SUPPRESS_ANALYTICS':'true','DART_SUPPRESS_ANALYTICS':'true',
         'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
    if port is not None:env['ASAEL_NATIVE_TEST_PORT']=str(port)
    if developer_directory:env['DEVELOPER_DIR']=str(Path(developer_directory).resolve())
    return env
