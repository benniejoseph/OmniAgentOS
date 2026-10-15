import 'dart:async';

import 'package:asael/features/ambient_voice/voice_task_binding.dart';
import 'package:flutter_test/flutter_test.dart';

const _firstCaption = "Open YouTube and play the first video from 2819's channel.";
const _secondCaption = 'Now open my project.';
const _firstInput = (itemId: 'human-1', text: _firstCaption);
const _secondInput = (itemId: 'human-2', text: _secondCaption);

VoiceTaskBinding ready() => VoiceTaskBinding()
  ..speechStarted()
  ..committed('human-1')
  ..responseStarted('response-1');

void main() {
  test('function waits for its exact final caption persistence', () async {
    final binding = ready();
    final save = Completer<bool>();
    var completed = false;
    final claim = binding.claim('response-1').then((value) {
      completed = true;
      return value;
    });
    await Future<void>.delayed(Duration.zero);
    expect(completed, isFalse);
    unawaited(binding.captionSaved('human-1', _firstCaption, save.future));
    await Future<void>.delayed(Duration.zero);
    expect(completed, isFalse);
    save.complete(true);
    expect(await claim, _firstInput);
  });
  test('caption may save before the function request', () async {
    final binding = ready();
    await binding.captionSaved('human-1', _firstCaption, Future.value(true));
    expect(await binding.claim('response-1'), _firstInput);
  });
  test('failed and missing captions do not dispatch work', () async {
    final failed = ready();
    await failed.captionSaved('human-1', _firstCaption, Future.value(false));
    expect(await failed.claim('response-1'), isNull);
    expect(await ready().claim('response-1', timeout: Duration.zero), isNull);
  });
  test('a later caption cannot substitute for an earlier response', () async {
    final binding = ready();
    final claim = binding.claim('response-1');
    binding.speechStarted();
    binding.committed('human-2');
    binding.responseStarted('response-2');
    await binding.captionSaved('human-2', _secondCaption, Future.value(true));
    await binding.captionSaved('human-1', _firstCaption, Future.value(true));
    expect(await claim, isNull);
    expect(await binding.claim('response-2'), _secondInput);
  });
  test(
    'one input cannot start repeated or parallel function requests',
    () async {
      final binding = ready();
      final claim = binding.claim('response-1');
      binding.responseStarted('response-2');
      expect(await binding.claim('response-1'), isNull);
      expect(await binding.claim('response-2'), isNull);
      await binding.captionSaved('human-1', _firstCaption, Future.value(true));
      expect(await claim, _firstInput);
      expect(await binding.claim('response-1'), isNull);
    },
  );
  test('unknown responses and captions have no task binding', () async {
    final binding = VoiceTaskBinding();
    await binding.captionSaved('orphan', _firstCaption, Future.value(true));
    binding.responseStarted('response-1');
    expect(await binding.claim('response-1'), isNull);
    expect(await ready().claim('different-response'), isNull);
  });
  test('interrupt and teardown fence delayed successful saves', () async {
    for (final close in [false, true]) {
      final binding = ready();
      final save = Completer<bool>();
      final claim = binding.claim('response-1');
      unawaited(binding.captionSaved('human-1', _firstCaption, save.future));
      close ? binding.close() : binding.speechStarted();
      save.complete(true);
      expect(await claim, isNull);
    }
  });
  test('duplicate caption receipts cannot replace a pending saved caption', () async {
    for (final duplicateSaved in [false, true]) {
      final binding = ready();
      final save = Completer<bool>();
      unawaited(binding.captionSaved('human-1', _firstCaption, save.future));
      var resolved = false;
      final claim = binding.claim('response-1').then((value) {
        resolved = true;
        return value;
      });
      await binding.captionSaved(
        'human-1',
        'A different final caption must not replace it.',
        Future.value(duplicateSaved),
      );
      await Future<void>.delayed(Duration.zero);
      expect(resolved, isFalse);
      save.complete(true);
      expect(await claim, _firstInput);
    }
  });
  test('a claimed caption stays exact after a later user input', () async {
    final binding = ready();
    await binding.captionSaved('human-1', _firstCaption, Future.value(true));
    final first = await binding.claim('response-1');
    binding.speechStarted();
    binding.committed('human-2');
    binding.responseStarted('response-2');
    await binding.captionSaved('human-2', _secondCaption, Future.value(true));
    expect(first, _firstInput);
    expect(await binding.claim('response-2'), _secondInput);
  });
  test('empty saved text cannot supply a caption for the user bubble', () async {
    final binding = ready();
    await binding.captionSaved('human-1', '', Future.value(true));
    expect(await binding.claim('response-1'), isNull);
  });
}
