"""Materialize an exact Builder snapshot using local Git blobs, never candidate scripts."""
import os
import json
from pathlib import Path
import re
import subprocess
import unicodedata
from macos_manifest import NativeRefused, digest, read_regular, relative_path, require, seal, verify_seal

EXCLUDED = {'.git','.next','node_modules','.vercel','coverage','.turbo','.dart_tool','.gradle','pods','.build','.ssh','.aws','.azure','.gnupg','.kube'}
PRIVATE = {'.npmrc','.netrc','.pypirc','.git-credentials','credentials.json','credentials','id_rsa','id_ed25519'}

def excluded(value):
    parts = value.lower().split('/')
    return any(part in EXCLUDED or part in PRIVATE or part == '.env' or part.startswith('.env.') or
               re.search(r'\.(pem|p12|pfx|key|keystore|jks)$',part) or part.endswith('.tsbuildinfo') for part in parts) or value == 'next-env.d.ts' or '/.config/gcloud/' in '/'+value.lower()+'/'

def eligible(value):
    relative_path(value); normalized=value.lower()
    protected=bool(re.search(r'/(?:auth|self_improvement|settings|command|security|ambient_voice|computer_use|integrations)(?:/|_)',normalized) or
                   re.search(r'(?:approval|consent|authority|governance|credential|permission|task_binding)',normalized.split('/')[-1]) or
                   re.search(r'/(?:talk/talk|inbox/(?:inbox|macos_inbox_view)|agents/agent_control_view)(?:_test)?\.dart$',normalized))
    return not protected and bool(re.fullmatch(r'apps/flutter/lib/features/[a-z0-9_]+/[A-Za-z0-9_/]+\.dart',value) or
                                  re.fullmatch(r'apps/flutter/test/[A-Za-z0-9_/]+_test\.dart',value))

def workspace_rows(root):
    root = Path(root).resolve(); rows=[]; total=0; identities=set()
    for folder, directories, files in os.walk(root,followlinks=False):
        directories[:] = [name for name in directories if not excluded((Path(folder)/name).relative_to(root).as_posix())]
        for name in [*directories,*files]:
            path=Path(folder)/name; rel=path.relative_to(root).as_posix()
            if excluded(rel): continue
            relative_path(rel); require(len(rel)<=240 and not path.is_symlink(),'native_workspace_path_invalid')
            identity=unicodedata.normalize('NFC',rel).casefold()
            require(identity not in identities,'native_case_or_unicode_collision'); identities.add(identity)
            if path.is_dir(): continue
            raw=read_regular(path,128*1024*1024); total+=len(raw)
            require(total<=512*1024*1024 and len(rows)<10000,'native_workspace_bounds')
            rows.append({'path':rel,'sha256':digest(raw),'mode':'100755' if path.stat().st_mode&0o111 else '100644'})
    return sorted(rows,key=lambda row:row['path'])

def workspace_digest(rows):
    # Builder uses V8 localeCompare; invoke fixed trusted code over row data only.
    script="const fs=require('fs'),crypto=require('crypto');const rows=JSON.parse(fs.readFileSync(0,'utf8'));rows.sort((a,b)=>a.path.localeCompare(b.path));process.stdout.write(crypto.createHash('sha256').update(rows.map(r=>r.path+'\\0'+r.sha256+'\\0'+r.mode).join('\\n')).digest('hex'));"
    result=subprocess.run(['/opt/homebrew/opt/node@24/bin/node','-e',script],input=json.dumps(rows).encode(),capture_output=True,timeout=30,env={'PATH':'/usr/bin:/bin','HOME':'/var/empty','LANG':'en_US.UTF-8'})
    require(result.returncode==0 and re.fullmatch(rb'[a-f0-9]{64}',result.stdout),'native_workspace_sort_failed')
    return result.stdout.decode()

def git(root,args):
    env={'PATH':'/usr/bin:/bin','HOME':'/var/empty','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','LC_ALL':'C'}
    result=subprocess.run(['/usr/bin/git','-c','core.hooksPath=/dev/null',*args],cwd=root,env=env,capture_output=True,timeout=60)
    require(result.returncode==0 and len(result.stdout)<=512*1024*1024,'native_git_read_failed')
    return result.stdout

def materialize(git_root,destination,request,payload):
    verify_seal('native_validation_request',request,'requestSha256')
    snapshot=payload.get('snapshot'); changes=payload.get('changes')
    require(snapshot==request['snapshot'] and isinstance(changes,list) and 1<=len(changes)<=30,'native_source_scope_changed')
    verify_seal('native_source_snapshot',snapshot,'snapshotSha256')
    require(digest({'contract':'asael-self-improvement','version':1,'kind':'native_source_changes','value':changes})==snapshot['changesSha256'],'native_source_changes_changed')
    require([row['path'] for row in changes]==sorted(set(row['path'] for row in changes)),'native_source_order_invalid')
    require([{key:row[key] for key in ('path','beforeSha256','afterSha256','mode')} for row in changes]==snapshot['files'],'native_source_descriptors_changed')
    base=snapshot['baseRevision']; require(re.fullmatch(r'[a-f0-9]{40}',base),'native_base_invalid')
    require(git(git_root,['rev-parse',base+'^{commit}']).decode().strip()==base,'native_base_not_available')
    root=Path(destination); require(not root.exists(),'native_source_destination_exists'); root.mkdir(mode=0o700)
    # Git's immutable object reader does not execute filters, hooks or build steps.
    entries=git(git_root,['ls-tree','-rzl','--full-tree',base]).split(b'\0'); total=0; blobs=[]; identities=set()
    for entry in entries:
        if not entry: continue
        metadata,raw_path=entry.split(b'\t',1); mode,kind,oid,size=metadata.decode().split(); path=raw_path.decode('utf-8')
        relative_path(path); require(len(path)<=240,'native_source_path_too_long')
        if excluded(path): continue
        require(kind=='blob' and mode in ('100644','100755') and size.isdigit(),'native_base_entry_unsupported')
        identity=unicodedata.normalize('NFC',path).casefold()
        require(identity not in identities,'native_case_or_unicode_collision'); identities.add(identity)
        total+=int(size); require(int(size)<=128*1024*1024 and total<=512*1024*1024 and len(blobs)<10000,'native_source_size_exceeded')
        blobs.append((path,mode,oid,int(size)))
    # Batch immutable Git blobs once, without candidate filters or hooks.
    env={'PATH':'/usr/bin:/bin','HOME':'/var/empty','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','LC_ALL':'C'}
    result=subprocess.run(['/usr/bin/git','-c','core.hooksPath=/dev/null','cat-file','--batch'],cwd=git_root,env=env,
        input=('\n'.join(row[2] for row in blobs)+'\n').encode(),capture_output=True,timeout=120)
    require(result.returncode==0 and len(result.stdout)<=total+len(blobs)*100,'native_git_read_failed')
    cursor=0
    for path,mode,oid,size in blobs:
        end=result.stdout.index(b'\n',cursor); require(result.stdout[cursor:end]==f'{oid} blob {size}'.encode(),'native_git_blob_changed')
        cursor=end+1; raw=result.stdout[cursor:cursor+size]; cursor+=size
        require(result.stdout[cursor:cursor+1]==b'\n' and len(raw)==size,'native_git_blob_changed'); cursor+=1
        target=root/path; target.parent.mkdir(mode=0o700,parents=True,exist_ok=True); target.write_bytes(raw); target.chmod(0o755 if mode=='100755' else 0o644)
    require(cursor==len(result.stdout),'native_git_blob_changed')
    for change in changes:
        require(set(change)=={'path','beforeSha256','afterSha256','mode','content'} and eligible(change['path']),'native_source_change_forbidden')
        target=root/change['path']; require(target.resolve().is_relative_to(root.resolve()),'native_source_change_escape')
        before=digest(read_regular(target)) if target.exists() else None
        if before is not None:require(('100755' if target.stat().st_mode&0o111 else '100644')==change['mode'],'native_source_mode_changed')
        require(before==change['beforeSha256'] and before!=change['afterSha256'] and change['mode'] in ('100644','100755'),'native_source_before_changed')
        content=change['content']
        if content is None:
            require(change['afterSha256'] is None and target.exists(),'native_source_delete_invalid'); target.unlink()
        else:
            require(isinstance(content,str),'native_source_content_invalid'); raw=content.encode('utf-8')
            require(len(raw)<=1048576 and digest(raw)==change['afterSha256'],'native_source_after_changed')
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True); target.write_bytes(raw); target.chmod(0o755 if change['mode']=='100755' else 0o644)
    wire=[{key:row[key] for key in ('path','beforeSha256','afterSha256','mode','content')} for row in changes]
    wire_bytes=json.dumps(wire,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
    require(len(wire_bytes)==snapshot['byteCount'] and len(wire_bytes)<=4*1024*1024,'native_source_byte_count_changed')
    rows=workspace_rows(root); require(workspace_digest(rows)==snapshot['workspaceSha256'],'native_workspace_digest_changed')
    return rows

def verify_admitted_rows(root,rows):
    root=Path(root).resolve()
    for row in rows:
        target=root/row['path']; require(target.resolve().is_relative_to(root) and not target.is_symlink(),'native_source_path_changed')
        require(digest(read_regular(target))==row['sha256'] and ('100755' if target.stat().st_mode&0o111 else '100644')==row['mode'],'native_source_changed_during_check')
    return workspace_digest(rows)
