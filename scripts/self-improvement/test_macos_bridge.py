"""Process inventory regressions; no app actions, arguments, or credentials."""
from contextlib import ExitStack
import ctypes
import errno
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

import macos_bridge as bridge
from macos_manifest import NativeRefused


APP='/Applications/Asael.app/Contents/MacOS/omniagent'
HELPER='/Applications/Asael.app/Contents/Helpers/AsaelCredentialBroker.app/Contents/MacOS/AsaelCredentialBroker'


def mappings(paths,*,pid=90,parent=1,uid=501):
    return f'p{pid}\0R{parent}\0u{uid}\0\n'.encode()+b''.join(b'ftxt\0n'+path.encode()+b'\0\n' for path in paths)


def result(stdout,code=0,stderr=b''):
    return SimpleNamespace(stdout=stdout,returncode=code,stderr=stderr)


class ProcessInventoryTests(unittest.TestCase):
    def inventory(self,rows,paths,*,fallback=None,gone=()):
        def lookup(pid,buffer,unused):
            value=paths[pid]
            if isinstance(value,int):ctypes.set_errno(value);return 0
            buffer.value=value.encode();return len(buffer.value)
        def exists(pid,signal):
            self.assertEqual(signal,0)
            if pid in gone:raise ProcessLookupError()
        library=SimpleNamespace(proc_pidpath=Mock(side_effect=lookup))
        stack=ExitStack();self.addCleanup(stack.close)
        commands=stack.enter_context(patch.object(bridge.subprocess,'run',side_effect=[result(rows),*(fallback or [])]))
        stack.enter_context(patch.object(bridge.ctypes,'CDLL',return_value=library))
        stack.enter_context(patch.object(bridge.os,'getuid',return_value=501))
        signals=stack.enter_context(patch.object(bridge.os,'kill',side_effect=exists))
        return commands,signals

    def test_actual_enoent_pattern_preserves_primary_and_helper(self):
        # A still-live process can retain mapped code from an obsolete updater
        # path even when proc_pidpath cannot resolve its original vnode path.
        commands,signals=self.inventory(b'501 90 1\n501 91 1\n501 92 91\n502 93 1\n',
            {90:errno.ENOENT,91:APP,92:HELPER},fallback=[result(mappings([
                '/Users/fixture/Library/Caches/updater/Previous.app/Contents/MacOS/crash-handler',
                '/usr/lib/dyld']))])
        self.assertEqual(bridge.owned_app_processes(),[
            {'pid':91,'parentPid':1,'path':APP},
            {'pid':92,'parentPid':91,'path':HELPER}])
        self.assertEqual(commands.call_args_list[0].args[0],['/bin/ps','-axo','uid=,pid=,ppid='])
        self.assertEqual(commands.call_args_list[1].args[0],['/usr/sbin/lsof','-a','-p','90','-d','txt','-F0pRun'])
        self.assertEqual(commands.call_args_list[1].kwargs['env'],{'PATH':'/usr/bin:/bin','HOME':'/var/empty'})
        signals.assert_called_once_with(90,0)

    def test_deleted_or_relocated_asael_executables_are_not_excluded(self):
        for path in (APP,APP+' (deleted)','/tmp/Old.app/Contents/MacOS/omniagent',
                '/tmp/Old.app/Contents/MacOS/AsaelComputerUseHelper',
                '/tmp/Old.app/Contents/MacOS/AsaelCommandRunnerHelper',
                '/tmp/Old.app/Contents/MacOS/AsaelCredentialBroker'):
            with self.subTest(path=path):
                self.inventory(b'501 90 1\n',{90:errno.ENOENT},fallback=[result(mappings(['/usr/lib/dyld',path]))])
                self.assertEqual(bridge.owned_app_processes(),[{'pid':90,'parentPid':1,'path':path.removesuffix(' (deleted)')}])

    def test_disappeared_process_needs_no_fallback(self):
        commands,_=self.inventory(b'501 90 1\n501 91 1\n',{90:errno.ESRCH,91:APP},gone=(90,))
        self.assertEqual(bridge.owned_app_processes(),[{'pid':91,'parentPid':1,'path':APP}])
        self.assertEqual(commands.call_count,1)

    def test_live_permission_or_unknown_path_failures_remain_closed(self):
        for error in (errno.EPERM,errno.EACCES,errno.ESRCH,0):
            with self.subTest(error=error):
                commands,_=self.inventory(b'501 90 1\n',{90:error})
                with self.assertRaisesRegex(NativeRefused,'inventory_unproven'):bridge.owned_app_processes()
                self.assertEqual(commands.call_count,1)

    def test_mapping_failure_warning_or_missing_output_refuses(self):
        for value in (result(b'',1),result(b''),result(mappings(['/usr/lib/dyld']),stderr=b'warning'),
                result(mappings(['/usr/lib/dyld']),code=1),result(b'x'*2_000_000)):
            with self.subTest(code=value.returncode,size=len(value.stdout)):
                with patch.object(bridge.subprocess,'run',return_value=value):
                    with self.assertRaisesRegex(NativeRefused,'inventory_unproven'):bridge.mapped_app_process_path(90,1,501)

    def test_mapping_identity_and_full_record_bounds_are_required(self):
        valid=mappings(['/usr/lib/dyld'])
        invalid=(mappings(['/usr/lib/dyld'],pid=91),mappings(['/usr/lib/dyld'],parent=2),
            mappings(['/usr/lib/dyld'],uid=502),mappings([]),valid[:-1],valid[:-2],
            valid+valid,valid.replace(b'ftxt',b'fmem'),valid.replace(b'\0n/',b'\0nrelative/'),
            mappings(['/tmp/../Other']),mappings(['/tmp//Other']),mappings(['/tmp/escaped\\name']),
            mappings(['/tmp/line\nname']),mappings(['/tmp/control\x01']),mappings(['/'+'x'*4096]),
            valid.replace(b'/usr/lib/dyld',b'/tmp/\xff'),mappings([APP,HELPER]))
        for data in invalid:
            with self.subTest(data=data[:80]),patch.object(bridge.subprocess,'run',return_value=result(data)):
                with self.assertRaisesRegex(NativeRefused,'inventory_unproven'):bridge.mapped_app_process_path(90,1,501)

    def test_mapping_timeout_does_not_become_empty_inventory(self):
        with patch.object(bridge.subprocess,'run',side_effect=bridge.subprocess.TimeoutExpired('lsof',10)):
            with self.assertRaises(bridge.subprocess.TimeoutExpired):bridge.mapped_app_process_path(90,1,501)

    def test_direct_process_paths_do_not_invoke_fallback(self):
        commands,signals=self.inventory(b'501 91 1\n501 92 91\n',{91:APP,92:HELPER})
        self.assertEqual(len(bridge.owned_app_processes()),2)
        self.assertEqual(commands.call_count,1);signals.assert_not_called()


if __name__=='__main__':unittest.main()
