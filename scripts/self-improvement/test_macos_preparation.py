"""Exercise fixed native preparation and real report validation without a compiler."""
from contextlib import ExitStack
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import macos_build as B
from macos_manifest import NativeRefused, digest, seal
from macos_protocol import PROFILE_SHA, request_checks, validate_request, validate_receipt


class NativePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.fixture=json.loads((Path(__file__).parent/'fixtures/native-validation-v2.json').read_text())

    def request(self,purpose='baseline'):
        body={k:v for k,v in copy.deepcopy(self.fixture['request']).items() if k!='requestSha256'}
        body['purpose']=purpose
        result=seal('native_validation_request',body,'requestSha256')
        validate_request(result,{'tenantId':result['tenantId'],'actorId':result['ownerActorId']},[result['policySha256']],check_time=False)
        return result

    def report(self,root,paths,results=('success','failure')):
        events=[{'type':'suite','suite':{'id':1,'path':str(root/paths[0])}}]
        for index,result in enumerate(results):
            events.extend([{'type':'testStart','test':{'id':index,'suiteID':1,'name':'synthetic '+str(index)}},
                           {'type':'testDone','testID':index,'result':result,'skipped':False,'hidden':False}])
        events.append({'type':'done'})
        return ('\n'.join(json.dumps(event) for event in events)+'\n').encode()

    def run_checks(self,request,*,analysis_exit=0,test_output=None,test_exit=1):
        folder=self.root/('check-'+str(len(list(self.root.iterdir()))));seen=[]
        def materialize(repo,target,req,payload):
            (target/'apps/flutter').mkdir(parents=True);return []
        def run(argv,cwd,env,log,timeout):
            command=argv[-1];seen.append(command)
            if command=='macos_analyze':return analysis_exit,b'synthetic analyzer output',2
            if command=='macos_build':return 0,b'synthetic build output',3
            raw=test_output if test_output is not None else self.report(folder/'source',request['focusedTestPaths'])
            return test_exit,raw,4
        config={'sdk':'/fixed/sdk','pubCache':'/fixed/pub','entrypoint':'/fixed/tool/bin/flutter_tools.dart','developerDirectory':'/Applications/Xcode.app/Contents/Developer'}
        with ExitStack() as stack:
            for name,value in [('verify_toolchain',self.fixture['receipt']['toolchainSha256']),('provision_dependencies',None),('prepare_native_build',{}),('choose_test_port',55119),('verify_admitted_rows',request['snapshot']['workspaceSha256']),('utcnow','2026-10-26T17:01:00.000Z')]:
                stack.enter_context(patch.object(B,name,return_value=value))
            stack.enter_context(patch.object(B,'materialize',side_effect=materialize))
            stack.enter_context(patch.object(B,'fixed_commands',side_effect=lambda command,*args:[[command]]))
            stack.enter_context(patch.object(B,'run_bounded',side_effect=run))
            receipt=B.validate_snapshot(self.root,folder,request,{},config,self.fixture['receipt']['installedBaseline'],self.fixture['receipt']['pairedBaseline'],'synthetic-controller')
        self.assertEqual(json.loads((folder/'receipt.json').read_text()),receipt)
        validate_receipt(request,receipt)
        return receipt,seen

    def test_profile_requires_analyze_then_test_and_collects_both_after_analysis_failure(self):
        request=self.request()
        self.assertEqual(request['profileSha256'],PROFILE_SHA)
        self.assertEqual([row[0] for row in request_checks(request)],['macos_analyze','macos_test_focused'])
        receipt,seen=self.run_checks(request,analysis_exit=1)
        self.assertEqual(seen,['macos_analyze','macos_test_focused'])
        self.assertEqual([check['exitCode'] for check in receipt['checks']],[1,1])
        self.assertEqual(receipt['checks'][1]['testSummary'],{'totalTests':2,'passedTests':1,'failedTests':1,'pendingTests':0,'executedPaths':request['focusedTestPaths']})
        self.assertIsNone(receipt['artifact'])

    def test_completed_empty_malformed_or_partial_report_is_retained_unproven(self):
        for raw,exit_code in [(b'',0),(b'compiler error',1),(b'{broken\n',1),(b'{}\n',0),(b'{"type":"testDone"}\n',1),(b'{"type":"done"}\n',0)]:
            with self.subTest(raw=raw,exit_code=exit_code):
                receipt,_=self.run_checks(self.request(),test_output=raw,test_exit=exit_code)
                check=receipt['checks'][1]
                self.assertEqual(check['exitCode'],exit_code)
                self.assertEqual(check['outputSha256'],digest(raw))
                self.assertEqual(check['testReportFailure'],'unproven_test_report')
                self.assertNotIn('testSummary',check)
                self.assertIsNone(receipt['artifact'])

    def test_all_failed_real_cases_remain_recorded_for_the_server_control_gate(self):
        request=self.request();folder=self.root/'check-0'
        raw=self.report(folder/'source',request['focusedTestPaths'],('failure','failure'))
        receipt,_=self.run_checks(request,test_output=raw)
        self.assertEqual(receipt['checks'][1]['testSummary']['passedTests'],0)
        self.assertEqual(receipt['checks'][1]['testSummary']['failedTests'],2)

    def test_unproven_zero_exit_candidate_never_produces_an_artifact(self):
        receipt,seen=self.run_checks(self.request('candidate'),test_output=b'not a machine report',test_exit=0)
        self.assertEqual(seen,['macos_analyze','macos_test_focused','macos_test_focused','macos_build'])
        self.assertTrue(all(check['exitCode']==0 for check in receipt['checks']))
        self.assertIsNone(receipt['artifact'])
        self.assertEqual([check.get('testReportFailure') for check in receipt['checks']],[None,'unproven_test_report','unproven_test_report',None])

    def test_missing_or_reordered_baseline_and_false_summary_are_refused(self):
        request=self.request();receipt,_=self.run_checks(request)
        for kind in ('missing','order','contradictory'):
            changed=copy.deepcopy(receipt)
            if kind=='missing':changed['checks'].pop(0)
            if kind=='order':changed['checks'].reverse()
            if kind=='contradictory':changed['checks'][1]['testReportFailure']='unproven_test_report'
            changed=seal('native_validation_receipt',{k:v for k,v in changed.items() if k!='receiptSha256'},'receiptSha256')
            with self.subTest(kind=kind),self.assertRaises(NativeRefused):validate_receipt(request,changed)

    def test_legacy_profile_cannot_run_under_new_controller(self):
        old=json.loads((Path(__file__).parent/'fixtures/native-validation-v1.json').read_text())['request']
        with self.assertRaisesRegex(NativeRefused,'contract_changed'):
            validate_request(old,{'tenantId':old['tenantId'],'actorId':old['ownerActorId']},[old['policySha256']],check_time=False)
        target=self.root/'must-not-exist'
        with self.assertRaisesRegex(NativeRefused,'profile_changed'):
            B.validate_snapshot(self.root,target,old,{}, {}, {}, {},'synthetic-controller')
        self.assertFalse(target.exists())

if __name__=='__main__':unittest.main()
