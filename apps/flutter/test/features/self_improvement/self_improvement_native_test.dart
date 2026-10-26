import 'dart:convert';
import 'dart:io';

import 'package:asael/features/self_improvement/self_improvement_models.dart';
import 'package:asael/features/self_improvement/self_improvement_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

ImprovementJson nativeCycle() => improvementObject(
  improvementObject(
    jsonDecode(
      File('test/fixtures/self_improvement_public_response.json')
          .readAsStringSync(),
    ),
  )['nativeCycle'],
);

void main() {
  test('reads an actual server-projected Mac receipt without requiring server deployment', () {
    final cycle = SelfImprovementCycle.fromJson(nativeCycle());
    expect(cycle.stage, 'succeeded');
    expect(cycle.candidate!.isMacUpdate, isTrue);
    expect(cycle.validation!.native!.buildNumber, 117);
    expect(cycle.releaseReceipt!.nativeInstall!['buildNumber'], '117');
    expect(
      cycle.releaseReceipt!.webRevision,
      isNot(cycle.release!['candidateRevision']),
    );
  });

  test(
    'rejects a changed package approval, installed identity or server pair',
    () {
      for (final mutation in <void Function(ImprovementJson)>[
        (value) => value['approval']['nativeArtifactSha256'] = 'f' * 64,
        (value) => value['releaseReceipt']['webRevision'] = 'f' * 40,
        (value) =>
            value['releaseReceipt']['nativeInstall']['signingIdentitySha256'] =
                'f' * 64,
        (value) =>
            value['releaseReceipt']['nativeInstall']['buildNumber'] = '118',
        (value) => value['candidate'].remove('releaseTarget'),
      ]) {
        final value = nativeCycle();
        mutation(value);
        expect(
          () => SelfImprovementCycle.fromJson(value),
          throwsFormatException,
        );
      }
    },
  );

  test(
    'a rolled-back Mac update must identify the retained previous bundle',
    () {
      final value = nativeCycle();
      final baseline =
          value['validation']['native']['installedBaseline'] as Map;
      value['stage'] = 'rolled_back';
      value['releaseReceipt']['outcome'] = 'rolled_back';
      value['releaseReceipt']['nativeInstall']['installedBundleSha256'] =
          baseline['bundleSha256'];
      value['releaseReceipt']['nativeInstall']['version'] = baseline['version'];
      value['releaseReceipt']['nativeInstall']['buildNumber'] =
          baseline['buildNumber'];
      expect(SelfImprovementCycle.fromJson(value).stage, 'rolled_back');
      value['releaseReceipt']['nativeInstall']['installedBundleSha256'] =
          '0' * 64;
      expect(() => SelfImprovementCycle.fromJson(value), throwsFormatException);
    },
  );

  test('a later web rollback identifies the serving pair before the Mac-only source advance', () {
    final fixture = improvementObject(
      jsonDecode(
        File('test/fixtures/self_improvement_public_response.json')
            .readAsStringSync(),
      ),
    );
    final value = improvementObject(
      improvementObject(fixture['exactCycle'])['cycle'],
    );
    final serving = 'e' * 40;
    final manifest = 'f' * 64;
    value['stage'] = 'rolled_back';
    value['release']['pairedBaseline'] = {
      'webRevision': serving,
      'workerRevision': serving,
      'manifestSha256': manifest,
    };
    value['releaseReceipt']['outcome'] = 'rolled_back';
    value['releaseReceipt']['webRevision'] = serving;
    value['releaseReceipt']['workerRevision'] = serving;
    value['releaseReceipt']['manifestSha256'] = manifest;
    expect(SelfImprovementCycle.fromJson(value).stage, 'rolled_back');
    value['releaseReceipt']['webRevision'] =
        value['release']['previousRevision'];
    expect(() => SelfImprovementCycle.fromJson(value), throwsFormatException);
  });

  testWidgets('a held Mac validation offers one explicit Stop check action', (
    tester,
  ) async {
    final value = nativeCycle()
      ..['stage'] = 'validating'
      ..['approval'] = null
      ..['release'] = null
      ..['releaseReceipt'] = null;
    value['nativeCheck'] = {
      'requestId': 'self_native_${'8' * 64}',
      'requestSha256': '9' * 64,
      'purpose': 'candidate',
      'status': 'held',
      'holdCategory': 'native_validation_expired',
      'canStop': true,
    };
    var stops = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ImprovementCycleEvidence(
              cycle: SelfImprovementCycle.fromJson(value),
              onStopNativeCheck: () => stops++,
            ),
          ),
        ),
      ),
    );
    await tester.ensureVisible(find.text('Stop check'));
    await tester.tap(find.text('Stop check'));
    expect(stops, 1);
    expect(find.text('Approve Mac update'), findsNothing);
    value['stage'] = 'cancelled';
    (value['nativeCheck'] as Map<String, Object?>)['canStop'] = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ImprovementCycleEvidence(
              cycle: SelfImprovementCycle.fromJson(value),
              onStopNativeCheck: () => stops++,
            ),
          ),
        ),
      ),
    );
    expect(
      find.text('The Mac check was stopped. Its evidence is retained.'),
      findsOneWidget,
    );
    expect(find.textContaining('Mac check needs attention'), findsNothing);
    expect(find.text('Stop check'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offers one explicit approval for the tested Mac package', (
    tester,
  ) async {
    final value = nativeCycle()
      ..['stage'] = 'review_required'
      ..['approval'] = null
      ..['release'] = null
      ..['releaseReceipt'] = null
      ..['releaseEligibility'] = 'owner_review';
    var approvals = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ImprovementCycleEvidence(
              cycle: SelfImprovementCycle.fromJson(value),
              onApprove: () => approvals++,
            ),
          ),
        ),
      ),
    );
    expect(find.text('Asael 1.40.0 (117)'), findsOneWidget);
    final button = find.text('Approve Mac update');
    await tester.ensureVisible(button);
    await tester.tap(button);
    expect(approvals, 1);
    expect(find.text('Approve for manual release'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
