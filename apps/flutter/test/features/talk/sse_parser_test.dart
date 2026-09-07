import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/talk/talk.dart';

class _TalkRepository implements TalkRepository {
  final calls = <({String message, String mode, String strategy})>[];
  var failNext = false;

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
  }) async* {
    calls.add((message: message, mode: mode, strategy: strategy));
    if (failNext) {
      failNext = false;
      throw StateError('offline');
    }
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Ready'},
    );
  }
}

void main() {
  test('parses SSE across arbitrary byte boundaries', () async {
    final source =
        'event: status\r\ndata: {"type":"status","label":"Thinking"}\r\n\r\nevent: delta\ndata: {"type":"delta",\ndata: "text":"Hello"}\n\n';
    final bytes = utf8.encode(source);
    final chunks = <List<int>>[
      bytes.sublist(0, 7),
      bytes.sublist(7, 31),
      bytes.sublist(31, 68),
      bytes.sublist(68),
    ];
    final events = await parseSse(Stream.fromIterable(chunks)).toList();
    expect(events.map((e) => e.event), ['status', 'delta']);
    expect(events.first.data['label'], 'Thinking');
    expect(events.last.data['text'], 'Hello');
  });

  test('flushes final event without trailing newline', () async {
    final events = await parseSse(
      Stream.value(
        utf8.encode('event: done\ndata: {"type":"done","response":"Ready"}'),
      ),
    ).toList();
    expect(events.single.data['response'], 'Ready');
  });

  test(
    'maps Direct to strategy and retries without duplicating the user',
    () async {
      final repository = _TalkRepository()..failNext = true;
      final controller = TalkController(repository);

      await controller.send('Do this', strategy: 'direct');
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.failed, isTrue);
      expect(controller.canRetry, isTrue);

      await controller.retryLast();
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.text, 'Ready');
      expect(repository.calls, [
        (message: 'Do this', mode: 'orchestrate', strategy: 'direct'),
        (message: 'Do this', mode: 'orchestrate', strategy: 'direct'),
      ]);
    },
  );
}
