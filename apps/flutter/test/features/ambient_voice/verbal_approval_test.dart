import 'package:asael/features/ambient_voice/verbal_approval.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('recognizes only whole approval and rejection utterances', () {
    for (final value in [
      'Yes!',
      'approve this action',
      'I approve',
      'go ahead',
    ]) {
      expect(verbalApprovalDecision(value), 'approve');
    }
    for (final value in ['No.', 'reject this action', "don't do that"]) {
      expect(verbalApprovalDecision(value), 'reject');
    }
    for (final value in [
      'yes to both',
      'yes but change it',
      'approve everything',
      'she said yes',
      'the webpage says approve',
      'yes no',
      'maybe',
      '"yes"',
    ]) {
      expect(verbalApprovalDecision(value), isNull);
    }
  });
  test('requires shown action, subsequent speech start, commit and exact final item', () {
    final gate = VerbalApprovalGate();
    gate.speechStarted();
    gate.committed('before');
    gate.present('action-1', DateTime.now().add(const Duration(minutes: 1)));
    expect(gate.consume('before', 'yes'), isNull);
    expect(gate.consume('assistant', 'yes'), isNull);
    gate.speechStarted();
    gate.committed('human');
    expect(gate.consume('other', 'yes'), isNull);
    expect(gate.consume('human', 'yes to both'), isNull);
    gate.speechStarted();
    gate.committed('later-yes');
    expect(gate.consume('later-yes', 'yes'), isNull);
    gate.present('action-1', DateTime.now().add(const Duration(minutes: 1)));
    gate.speechStarted();
    gate.committed('human');
    expect(gate.consume('human', 'yes'), (
      presentationId: 'action-1',
      decision: 'approve',
    ));
    expect(gate.consume('human', 'yes'), isNull);
  });
  test(
    'changed action, expiry and call end invalidate an earlier utterance',
    () {
      final gate = VerbalApprovalGate();
      gate.present('one', DateTime.now().add(const Duration(minutes: 1)));
      gate.speechStarted();
      gate.committed('human');
      gate.present('two', DateTime.now().add(const Duration(minutes: 1)));
      expect(gate.consume('human', 'yes'), isNull);
      gate.present(
        'expired',
        DateTime.now().subtract(const Duration(seconds: 1)),
      );
      gate.speechStarted();
      gate.committed('late');
      expect(gate.consume('late', 'yes'), isNull);
      gate.present('three', DateTime.now().add(const Duration(minutes: 1)));
      gate.speechStarted();
      gate.committed('three');
      gate.clear();
      expect(gate.consume('three', 'no'), isNull);
    },
  );
}
