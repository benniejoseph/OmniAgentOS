from contextlib import ExitStack
from datetime import datetime,timedelta,timezone
import json
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch,Mock
import macos_install as I
from macos_bridge import validate_reply
from macos_manifest import NativeRefused,digest,tree_manifest
from macos_sign import write_provenance
from macos_ticket import StartupTicket,inspect_abandoned_ticket,retire_abandoned_ticket

class NativeInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.expected={'sourceRevision':'a'*40,'sourceSnapshotSha256':'b'*64,'version':'1.40.0','build':117,'ownerSha256':'c'*64}
    def bundle(self,path,build):
        (path/'Contents/MacOS').mkdir(parents=True);exe=path/'Contents/MacOS/omniagent';exe.write_text('fixture'+str(build));exe.chmod(0o755)
        (path/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'app.omniagent.omniagent','CFBundleExecutable':'omniagent','CFBundleShortVersionString':'1.40.0','CFBundleVersion':str(build)}))
        write_provenance(path,{'protocol':1,**{k:v for k,v in self.expected.items() if k!='ownerSha256'},'build':build});return path
    def test_ticket_is_exclusive_and_orphan_expiry_is_explicit(self):
        directory=self.root/'socket';ticket=StartupTicket(self.expected,directory)
        self.assertEqual(ticket.path.stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):StartupTicket(self.expected,directory)
        self.assertEqual(inspect_abandoned_ticket(directory)['status'],'owned_or_uncertain')
        value=dict(ticket.value,expiresAt=(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat());ticket.path.write_text(json.dumps(value))
        with patch('macos_ticket.os.kill',side_effect=ProcessLookupError):
            self.assertEqual(inspect_abandoned_ticket(directory)['status'],'expired_orphan')
            retire_abandoned_ticket(self.root/'orphan-evidence.json',directory)
        self.assertFalse(ticket.path.exists());self.assertTrue((self.root/'orphan-evidence.json').exists())
    def test_quarantine_proves_safe_stop_without_fabricating_owner(self):
        request={'protocol':1,'action':'quiesce','nonce':'d'*64,'expected':self.expected}
        reply={'protocol':1,'action':'quiesce','nonce':'d'*64,'binding':{**self.expected,'ownerSha256':None},'pid':123,'status':'quiesced','flutterReady':False,'authenticatedWorkspaceReady':False,'improvementRendered':False,'busyReasons':[],'quiescenceExpiresAt':(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat(),'startupQuarantined':True,'quarantineExpiresAt':(datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat(),'startupDecision':'pending'}
        self.assertEqual(validate_reply(reply,request,123)['status'],'quiesced')
        expired={**reply,'startupQuarantined':False,'quarantineExpiresAt':None,'startupDecision':'expired'}
        with self.assertRaisesRegex(NativeRefused,'readiness_unproven'):validate_reply(expired,request,123)
    def test_expiry_cannot_impersonate_successful_commit(self):
        process=Mock(pid=123);ticket=Mock(value={'nonce':'d'*64});signature={'codeSignatureSha256':'e'*64};app=self.bundle(self.root/'app',117)
        with patch.object(I,'query',return_value={'status':'ready','startupQuarantined':False,'startupDecision':'expired'}):
            with self.assertRaisesRegex(NativeRefused,'commit_unconfirmed'):I.commit_startup(app,self.expected,signature,process,ticket)
        ticket.remove.assert_not_called()
    def test_guarded_quit_keeps_nonce_and_never_signals_the_app(self):
        app=self.bundle(self.root/'quit.app',117);signature={'codeSignatureSha256':'e'*64}
        reply={'status':'quiesced','busyReasons':[],'pid':123,'nonce':'d'*64,'quiescenceExpiresAt':(datetime.now(timezone.utc)+timedelta(seconds=25)).isoformat()}
        with patch.object(I,'running_code'),patch.object(I,'query',return_value={**reply,'action':'quit'}) as query,patch.object(I.os,'waitpid',side_effect=ChildProcessError),patch.object(I.os,'kill',side_effect=ProcessLookupError) as kill:
            I.stop_quiesced(reply,app,signature,self.expected,deadline_monotonic=I.time.monotonic()+25)
        self.assertEqual(query.call_args.args[0],'quit');self.assertEqual(query.call_args.kwargs,{'expected_pid':123,'nonce':'d'*64});kill.assert_called_once_with(123,0)
    def test_uncertain_quit_with_live_process_holds_without_signal(self):
        app=self.bundle(self.root/'quit.app',117);signature={'codeSignatureSha256':'e'*64}
        reply={'status':'quiesced','busyReasons':[],'pid':123,'nonce':'d'*64,'quiescenceExpiresAt':(datetime.now(timezone.utc)+timedelta(seconds=25)).isoformat()}
        with patch.object(I,'running_code'),patch.object(I,'query',side_effect=OSError),patch.object(I,'owned_app_processes',return_value=[{'pid':123}]),patch.object(I.os,'kill') as kill:
            with self.assertRaisesRegex(NativeRefused,'quit_unconfirmed'):I.stop_quiesced(reply,app,signature,self.expected,deadline_monotonic=I.time.monotonic()+25)
        kill.assert_not_called()
    def run_install(self,failure=None):
        applications=self.root/'Applications';applications.mkdir();active=self.bundle(applications/'Asael.app',116);candidate=self.bundle(self.root/'signed/Asael.app',117)
        staging=applications/'.asael-native-publisher';staging.mkdir(mode=0o700)
        old=tree_manifest(active,'bundle');new=tree_manifest(candidate,'bundle');signature={'signingIdentitySha256':'s'*64,'designatedRequirementSha256':'r'*64,'codeSignatureSha256':'c'*64}
        baseline={'bundleSha256':old['manifestSha256'],'signingIdentitySha256':'s'*64,'designatedRequirementSha256':'r'*64}
        prepared={'path':str(candidate),'manifest':new,'signature':signature,'artifactSha256':'a'*64,'approvalSha256':'b'*64}
        process=Mock(pid=123);process.poll.return_value=1 if failure=='exited' else None
        quiet={'status':'quiesced','busyReasons':[],'pid':123};ack={'status':'ready','startupQuarantined':True};normal={'status':'ready','startupQuarantined':False,'startupDecision':'committed'}
        with ExitStack() as stack:
            for name,value in [('APPLICATIONS',applications),('APPLICATION',active)]:stack.enter_context(patch.object(I,name,value))
            stack.enter_context(patch.object(I,'inspect_abandoned_ticket',return_value={'status':'absent'}));stack.enter_context(patch.object(I,'signature_identity',return_value=signature))
            stack.enter_context(patch.object(I,'owned_app_processes',side_effect=[[{'pid':123,'path':'fixture'}],[]]))
            query=stack.enter_context(patch.object(I,'query',side_effect=[quiet,{'status':'held','busyReasons':['voice_active']}] if failure=='busy' else None,return_value=quiet))
            stop=stack.enter_context(patch.object(I,'stop_quiesced'))
            if failure=='busy':stop.side_effect=[None,NativeRefused('busy')]
            stack.enter_context(patch.object(I,'StartupTicket',return_value=Mock(value={'nonce':'d'*64})))
            stack.enter_context(patch.object(I,'launch_canary',return_value=process))
            stack.enter_context(patch.object(I,'wait_ready',side_effect=[NativeRefused('startup_failed'),ack] if failure else None,return_value=ack))
            stack.enter_context(patch.object(I,'commit_startup',return_value=normal))
            if failure=='busy':
                with self.assertRaisesRegex(NativeRefused,'rollback_requires_quiescence'):I.install_signed(prepared,baseline,'c'*64,self.root/'journal',staging)
                self.assertEqual(tree_manifest(active,'bundle')['manifestSha256'],new['manifestSha256']);return
            result=I.install_signed(prepared,baseline,'c'*64,self.root/'journal',staging)
        return result,active,old,new
    def test_success_is_exact_swapped_bundle_and_new_build(self):
        result,active,old,new=self.run_install();self.assertEqual(result['outcome'],'deployed');self.assertEqual(result['buildNumber'],'117');self.assertEqual(tree_manifest(active,'bundle'),new)
    def test_failed_startup_restores_actual_prior_build(self):
        result,active,old,new=self.run_install('exited');self.assertEqual(result['outcome'],'rolled_back');self.assertEqual(result['buildNumber'],'116');self.assertEqual(tree_manifest(active,'bundle'),old)
    def test_busy_candidate_is_retained_without_false_rollback(self):self.run_install('busy')
if __name__=='__main__':unittest.main()
