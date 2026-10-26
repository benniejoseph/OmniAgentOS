import copy
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
from macos_manifest import NativeRefused,canonical,digest,seal,tree_manifest
from macos_controller import Lease,native_preflight,write
from macos_reconcile import reconcile_native_completion
from install import SOURCES
import macos_reconcile as R

class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
    def test_rotating_token_is_durable_before_next_action(self):
        state=self.root/'lease.json';app=Mock();app.request.return_value={'leaseToken':'second','expiresAt':'2099-01-01T00:00:00Z'}
        lease=Lease(app,'/api/test',{'leaseToken':'first'},state);lease.action('heartbeat')
        saved=json.loads(state.read_text());self.assertEqual(saved['fields']['leaseToken'],'second');self.assertIsNone(saved['pending']);self.assertEqual(state.stat().st_mode&0o777,0o600)
    def test_lost_heartbeat_cannot_be_overwritten_by_hold(self):
        state=self.root/'lease.json';app=Mock();app.request.side_effect=OSError('synthetic lost response')
        lease=Lease(app,'/api/test',{'leaseToken':'first'},state)
        with self.assertRaises(OSError):lease.action('heartbeat')
        before=state.read_bytes()
        with self.assertRaisesRegex(NativeRefused,'heartbeat_failed'):lease.action('hold',category='failed')
        self.assertEqual(state.read_bytes(),before);self.assertEqual(app.request.call_count,1)
    def test_installed_copy_loads_all_runtime_modules_and_swift_cache_copy(self):
        installed=self.root/'installed';installed.mkdir();source=Path(__file__).parent
        for name in SOURCES:shutil.copyfile(source/name,installed/name)
        app=self.root/'candidate/apps/flutter';app.mkdir(parents=True);home=self.root/'home';home.mkdir();cache=self.root/'swift';cache.mkdir();(cache/'fixture.txt').write_text('trusted fixture')
        for name in ('pubspec.yaml','pubspec.lock'):(app/name).write_text('unchanged fixture')
        manifest=self.root/'swift.json';manifest.write_bytes(canonical(tree_manifest(cache,'bundle')))
        config={'dependencies':{'files':[],'sourceSha256':{name:digest((app/name).read_bytes()) for name in ('pubspec.yaml','pubspec.lock')},'swiftCache':{'path':str(cache),'manifestFile':str(manifest),'manifestFileSha256':digest(manifest.read_bytes())}}};file=self.root/'config.json';file.write_text(json.dumps(config))
        code='import sys,json,importlib;sys.path.insert(0,sys.argv[1]);[importlib.import_module(x[:-3]) for x in json.loads(sys.argv[5])];from macos_build import provision_dependencies;provision_dependencies(sys.argv[2],sys.argv[3],json.load(open(sys.argv[4])))'
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(installed),str(self.root/'candidate'),str(home),str(file),json.dumps(SOURCES)],env={'PATH':'/usr/bin:/bin','HOME':str(home)},capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr.decode());self.assertEqual((home/'SourcePackages/fixture.txt').read_text(),'trusted fixture');self.assertNotEqual((cache/'fixture.txt').stat().st_ino,(home/'SourcePackages/fixture.txt').stat().st_ino)
    def test_busy_mac_waits_without_claim_and_stopped_app_needs_no_reopen(self):
        signature={'signingIdentitySha256':'a'*64,'designatedRequirementSha256':'b'*64,'codeSignatureSha256':'c'*64};request={'tenantId':'t','ownerActorId':'actor:o','validation':{'native':{'installedBaseline':signature}}};controller=SimpleNamespace(app=Mock(),config={'controllerId':'test'})
        with patch('macos_sign.signature_identity',return_value=signature),patch('macos_controller.owned_app_processes',return_value=[]):self.assertTrue(native_preflight(controller,request))
        controller.app.request.assert_not_called();path='/Applications/Asael.app/Contents/MacOS/omniagent'
        with patch('macos_sign.signature_identity',return_value=signature),patch('macos_controller.owned_app_processes',return_value=[{'pid':123,'parentPid':1,'path':path}]),patch('macos_controller.executable',return_value=Path(path)),patch('macos_controller.expected_binding',return_value={}),patch('macos_controller.query',return_value={'status':'ready','busyReasons':['voice_active'],'startupQuarantined':False}):self.assertFalse(native_preflight(controller,request))
        self.assertEqual(controller.app.request.call_args.args[2]['action'],'status')

class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
    def fixture(self,terminal=False,pending=None):
        shared=json.loads((Path(__file__).parent/'fixtures/native-validation-v1.json').read_text())['receipt'];native={key:shared[key] for key in ('artifact','installedBaseline','pairedBaseline')}
        request={'cycleId':'self_cycle_'+'a'*64,'releaseTarget':'macos_app','tenantId':'t','ownerActorId':'actor:o','candidateRevision':'b'*40,'previousRevision':'a'*40,'validation':{'native':native},'validationSha256':'c'*64,'policySha256':'d'*64,'approval':{'receiptSha256':'e'*64}}
        binding=seal('release_binding',{'runner':'asael_macos_publisher','releaseTarget':'macos_app','candidateRevision':'f'*40,'sourceCandidateRevision':request['candidateRevision'],'previousRevision':request['previousRevision'],'native':{**native,'approvalSha256':'e'*64},'validationSha256':'c'*64,'policySha256':'d'*64},'releaseBindingSha256')
        attempt=digest({'cycleId':request['cycleId'],'candidateRevision':request['candidateRevision']});directory=self.root/attempt;directory.mkdir(mode=0o700)
        fields={'cycleId':request['cycleId'],'controllerId':'fixture','leaseToken':'old-token'}
        for name,value in [('request',request),('release-binding',binding),('lease',{'version':1,'route':R.API,'fields':fields,'pending':pending})]:write(directory/(name+'.json'),value)
        receipt={'releaseBindingSha256':binding['releaseBindingSha256'],'outcome':'deployed','nativeInstall':{'fixture':'retained'},'recordedAt':'2020-01-01T00:00:00Z'}
        cycle={'id':request['cycleId'],'scope':{'tenantId':'t','ownerActorId':'actor:o'},'release':binding,'stage':'succeeded' if terminal else 'releasing','executionLeaseExpiresAt':(datetime.now(timezone.utc)-timedelta(seconds=60)).isoformat()};actions=[]
        if terminal:cycle['releaseReceipt']={**receipt,'serverHealthEvidenceSha256':'1'*64};write(directory/'receipt.json',receipt)
        def call(method,route,body=None):
            if method=='GET':return {'cycle':copy.deepcopy(cycle)}
            actions.append(body)
            if body['action']=='recover_native_completion':return {'cycleId':request['cycleId'],'leaseToken':'new-token','expiresAt':'2099-01-01T00:00:00Z','releaseBindingSha256':binding['releaseBindingSha256'],'recoveryOnly':True}
            if body['action']=='complete':return {'cycleId':request['cycleId'],'stage':'succeeded','receipt':body['receipt']}
            raise AssertionError('unexpected mutation')
        controller=SimpleNamespace(state=self.root,config={'controllerId':'fixture'},app=SimpleNamespace(actor={'tenantId':'t','actorIds':['actor:o']},request=call),observe=Mock(return_value=native['pairedBaseline']))
        return controller,attempt,directory,request,binding,cycle,actions
    def test_terminal_callback_replays_exact_receipt_without_install_or_health(self):
        controller,attempt,directory,request,binding,cycle,actions=self.fixture(terminal=True,pending={'action':'complete'})
        with patch.object(R,'release_retained_lock'):result=reconcile_native_completion(controller,attempt)
        self.assertEqual(result['status'],'completion_acknowledged');self.assertEqual([a['action'] for a in actions],['complete']);self.assertEqual(actions[0]['receipt']['recordedAt'],'2020-01-01T00:00:00Z');controller.observe.assert_not_called()
    def test_uncertain_rotating_token_blocks_before_any_request(self):
        controller,attempt,*_=self.fixture(pending={'action':'heartbeat'});controller.app.request=Mock()
        with self.assertRaisesRegex(NativeRefused,'token_uncertain'):reconcile_native_completion(controller,attempt)
        controller.app.request.assert_not_called()
    def test_nonterminal_install_does_not_gain_recovery_authority(self):
        controller,attempt,directory,request,binding,cycle,actions=self.fixture();write(directory/'signed.json',{'artifactSha256':'a','approvalSha256':'b','manifest':{'manifestSha256':'c'}})
        with patch.object(R,'Journal',return_value=SimpleNamespace(events=[{'stage':'swapped'}])):
            with self.assertRaisesRegex(NativeRefused,'install_not_terminal'):reconcile_native_completion(controller,attempt)
        self.assertEqual(actions,[])
    def test_expired_terminal_install_recovers_completion_only_with_fresh_observation(self):
        controller,attempt,directory,request,binding,cycle,actions=self.fixture();native=request['validation']['native'];write(directory/'signed.json',{'artifactSha256':'a','approvalSha256':'b','manifest':{'manifestSha256':'c'*64}})
        signature={key:native['installedBaseline'][key] for key in ('signingIdentitySha256','designatedRequirementSha256')};signature['codeSignatureSha256']='f'*64
        expected={'sourceRevision':binding['candidateRevision'],'sourceSnapshotSha256':native['artifact']['sourceManifestSha256'],'version':native['artifact']['version'],'build':int(native['artifact']['buildNumber']),'ownerSha256':digest(['t','actor:o'])}
        with patch.object(R,'Journal',return_value=SimpleNamespace(events=[{'stage':'verified','eventSha256':'e'*64}])),patch.object(R,'tree_manifest',return_value={'manifestSha256':'c'*64}),patch.object(R,'signature_identity',return_value=signature),patch.object(R,'expected_binding',return_value=expected),patch.object(R,'executable',return_value=Path('/Applications/Asael.app/Contents/MacOS/omniagent')),patch.object(R,'query',return_value={'status':'ready','startupQuarantined':False}),patch.object(R,'release_retained_lock'):
            result=reconcile_native_completion(controller,attempt)
        self.assertEqual(result['status'],'completion_reconciled');self.assertEqual([a['action'] for a in actions],['recover_native_completion','complete']);self.assertEqual(actions[1]['leaseToken'],'new-token');self.assertEqual(actions[1]['releaseUsage']['actualUsd'],0);self.assertTrue((directory/'reconciliation-0001.json').exists())

if __name__=='__main__':unittest.main()
