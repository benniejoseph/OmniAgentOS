import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:record/record.dart';

import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

class SseEvent {
  const SseEvent({required this.event, required this.data});
  final String event;
  final Json data;
}

/// Handles arbitrary network chunk boundaries, CRLF, comments, multi-line data,
/// and a final event without a trailing blank line.
Stream<SseEvent> parseSse(Stream<List<int>> bytes) async* {
  var buffer = '';
  var eventName = 'message';
  final data = <String>[];
  SseEvent? flush() {
    if (data.isEmpty) {
      eventName = 'message';
      return null;
    }
    final raw = data.join('\n');
    data.clear();
    final name = eventName;
    eventName = 'message';
    final decoded = jsonDecode(raw);
    return SseEvent(
      event: name,
      data: NativeConversationEvents.parse(name, decoded),
    );
  }

  await for (final chunk in bytes.transform(utf8.decoder)) {
    buffer += chunk;
    while (true) {
      final newline = buffer.indexOf('\n');
      if (newline < 0) break;
      var line = buffer.substring(0, newline);
      buffer = buffer.substring(newline + 1);
      if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
      if (line.isEmpty) {
        final value = flush();
        if (value != null) yield value;
        continue;
      }
      if (line.startsWith(':')) continue;
      final colon = line.indexOf(':');
      final field = colon < 0 ? line : line.substring(0, colon);
      var value = colon < 0 ? '' : line.substring(colon + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      if (field == 'event') eventName = value;
      if (field == 'data') data.add(value);
    }
  }
  if (buffer.isNotEmpty) {
    var line = buffer;
    if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
    if (line.startsWith('data:')) data.add(line.substring(5).trimLeft());
  }
  final value = flush();
  if (value != null) yield value;
}

enum TalkRole { user, assistant }

class TalkMessage {
  const TalkMessage({
    required this.role,
    required this.text,
    this.streaming = false,
    this.failed = false,
  });
  final TalkRole role;
  final String text;
  final bool streaming, failed;
  TalkMessage copyWith({String? text, bool? streaming, bool? failed}) =>
      TalkMessage(
        role: role,
        text: text ?? this.text,
        streaming: streaming ?? this.streaming,
        failed: failed ?? this.failed,
      );
}

abstract interface class TalkRepository {
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
  });
  Future<String> transcribeVoice(Uint8List bytes);
}

class TalkController extends ChangeNotifier {
  TalkController(this.repository);
  final TalkRepository repository;
  final messages = <TalkMessage>[];
  String? threadId;
  String? status;
  bool sending = false;
  bool transcribing = false;
  Object? voiceError;
  Future<void> send(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
  }) async {
    return _send(input, mode: mode, strategy: strategy);
  }

  String? _retryInput;
  String? _retryMode;
  String? _retryStrategy;

  bool get canRetry => !sending && _retryInput != null;

  Future<void> retryLast() async {
    final input = _retryInput;
    if (input == null || sending) return;
    await _send(
      input,
      mode: _retryMode ?? 'orchestrate',
      strategy: _retryStrategy ?? 'auto',
      replaceFailedResponse: true,
    );
  }

  Future<String?> transcribeVoice(Uint8List bytes) async {
    if (transcribing || bytes.isEmpty || bytes.length > 10 * 1024 * 1024) {
      return null;
    }
    transcribing = true;
    voiceError = null;
    status = 'Transcribing voice draft';
    notifyListeners();
    try {
      return await repository.transcribeVoice(bytes);
    } catch (error) {
      voiceError = error;
      return null;
    } finally {
      transcribing = false;
      status = null;
      notifyListeners();
    }
  }

  Future<void> _send(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
    bool replaceFailedResponse = false,
  }) async {
    final text = input.trim();
    if (text.isEmpty || sending) return;
    if (replaceFailedResponse && messages.lastOrNull?.failed == true) {
      messages[messages.length - 1] = const TalkMessage(
        role: TalkRole.assistant,
        text: '',
        streaming: true,
      );
    } else {
      messages.add(TalkMessage(role: TalkRole.user, text: text));
      messages.add(
        const TalkMessage(role: TalkRole.assistant, text: '', streaming: true),
      );
    }
    sending = true;
    status = 'Connecting';
    notifyListeners();
    try {
      await for (final event in repository.send(
        message: text,
        threadId: threadId,
        mode: mode,
        strategy: strategy,
      )) {
        if (event.data['threadId'] is String) {
          threadId = event.data['threadId'] as String;
        }
        switch (event.event) {
          case 'delta':
            messages[messages.length - 1] = messages.last.copyWith(
              text: messages.last.text + (event.data['text'] as String? ?? ''),
            );
          case 'status':
            status = event.data['label'] as String? ?? 'Working';
          case 'delegated':
            messages[messages.length - 1] = messages.last.copyWith(
              text:
                  event.data['acknowledgement'] as String? ??
                  'Moved to a durable mission.',
              streaming: false,
            );
            status = 'Delegated';
          case 'done':
            messages[messages.length - 1] = messages.last.copyWith(
              text: event.data['response'] as String? ?? messages.last.text,
              streaming: false,
            );
            status = null;
          case 'waiting_approval':
            status = 'Waiting for approval';
          case 'error':
            throw StateError(
              event.data['message'] as String? ?? 'Agent failed',
            );
        }
        notifyListeners();
      }
      _retryInput = null;
      _retryMode = null;
      _retryStrategy = null;
    } catch (_) {
      messages[messages.length - 1] = messages.last.copyWith(
        text: messages.last.text.isEmpty
            ? 'I could not reach Asael. Tap retry when you’re back online.'
            : messages.last.text,
        streaming: false,
        failed: true,
      );
      _retryInput = text;
      _retryMode = mode;
      _retryStrategy = strategy;
    } finally {
      sending = false;
      status = null;
      notifyListeners();
    }
  }
}

class TalkView extends StatefulWidget {
  const TalkView({super.key, required this.controller});
  final TalkController controller;
  @override
  State<TalkView> createState() => _TalkViewState();
}

class _TalkViewState extends State<TalkView> {
  final input = TextEditingController();
  final scroll = ScrollController();
  final recorder = AudioRecorder();
  String strategy = 'auto';
  bool recording = false;
  String? recordingError;
  @override
  void dispose() {
    input.dispose();
    scroll.dispose();
    unawaited(recorder.dispose());
    super.dispose();
  }

  void submit() {
    final value = input.text;
    input.clear();
    widget.controller.send(value, mode: 'orchestrate', strategy: strategy);
  }

  Future<void> toggleVoiceDraft() async {
    if (widget.controller.transcribing || widget.controller.sending) return;
    setState(() => recordingError = null);
    if (recording) {
      setState(() => recording = false);
      try {
        final path = await recorder.stop();
        if (path == null) throw StateError('Voice recording was not saved.');
        final file = File(path);
        final bytes = await file.readAsBytes();
        try {
          await file.delete();
        } catch (_) {
          // The OS may have already cleared the temporary recording.
        }
        final transcript = await widget.controller.transcribeVoice(bytes);
        if (!mounted || transcript == null || transcript.trim().isEmpty) return;
        final existing = input.text.trim();
        input.text = existing.isEmpty
            ? transcript.trim()
            : '$existing\n${transcript.trim()}';
        input.selection = TextSelection.collapsed(offset: input.text.length);
      } catch (_) {
        if (mounted) {
          setState(() {
            recordingError = 'Voice draft could not be transcribed. Your typed draft is unchanged.';
          });
        }
      }
      return;
    }

    try {
      if (!await recorder.hasPermission()) {
        throw StateError('Microphone permission was not granted.');
      }
      final path =
          '${Directory.systemTemp.path}/asael-voice-${DateTime.now().microsecondsSinceEpoch}.m4a';
      await recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 64000,
          sampleRate: 24000,
          numChannels: 1,
        ),
        path: path,
      );
      if (mounted) setState(() => recording = true);
    } catch (_) {
      if (mounted) {
        setState(() {
          recordingError =
              'Microphone access is required to create a voice draft.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Talk'),
      actions: [
        Padding(
          padding: const EdgeInsets.only(right: 12),
          child: Center(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(99),
              ),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.shield_outlined, size: 15),
                  SizedBox(width: 5),
                  Text('Supervised'),
                ],
              ),
            ),
          ),
        ),
      ],
    ),
    body: ListenableBuilder(
      listenable: widget.controller,
      builder: (_, _) => Column(
        children: [
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 180),
            child: widget.controller.status != null
                ? Container(
                    key: ValueKey(widget.controller.status),
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 9,
                    ),
                    color: Theme.of(context).colorScheme.surfaceContainerLow,
                    child: Row(
                      children: [
                        const SizedBox.square(
                          dimension: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        const SizedBox(width: 10),
                        Text(
                          widget.controller.status!,
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                      ],
                    ),
                  )
                : const SizedBox.shrink(key: ValueKey('idle')),
          ),
          Expanded(
            child: widget.controller.messages.isEmpty
                ? const _TalkEmpty()
                : ListView.builder(
                    controller: scroll,
                    padding: const EdgeInsets.all(16),
                    itemCount: widget.controller.messages.length,
                    itemBuilder: (_, i) {
                      final m = widget.controller.messages[i];
                      return Align(
                        alignment: m.role == TalkRole.user
                            ? Alignment.centerRight
                            : Alignment.centerLeft,
                        child: Container(
                          constraints: const BoxConstraints(maxWidth: 640),
                          margin: const EdgeInsets.only(bottom: 14),
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: m.role == TalkRole.user
                                ? Theme.of(context).colorScheme.primaryContainer
                                : Theme.of(context)
                                      .colorScheme
                                      .surfaceContainerHigh,
                            borderRadius: BorderRadius.only(
                              topLeft: const Radius.circular(14),
                              topRight: const Radius.circular(14),
                              bottomLeft: Radius.circular(
                                m.role == TalkRole.user ? 14 : 4,
                              ),
                              bottomRight: Radius.circular(
                                m.role == TalkRole.user ? 4 : 14,
                              ),
                            ),
                            border: m.failed
                                ? Border.all(
                                    color: Theme.of(context).colorScheme.error,
                                  )
                                : null,
                          ),
                          child: m.streaming && m.text.isEmpty
                              ? const SizedBox.square(
                                  dimension: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    SelectableText(m.text),
                                    if (m.failed &&
                                        i ==
                                            widget.controller.messages.length -
                                                1) ...[
                                      const SizedBox(height: 8),
                                      TextButton.icon(
                                        onPressed: widget.controller.canRetry
                                            ? widget.controller.retryLast
                                            : null,
                                        icon: const Icon(Icons.refresh_rounded),
                                        label: const Text('Retry'),
                                      ),
                                    ],
                                  ],
                                ),
                        ),
                      );
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                border: Border(
                  top: BorderSide(color: Theme.of(context).dividerColor),
                ),
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 820),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          _ModeChip(
                            label: 'Orchestrate',
                            selected: strategy == 'auto',
                            onTap: () => setState(() => strategy = 'auto'),
                          ),
                          const SizedBox(width: 8),
                          _ModeChip(
                            label: 'Direct',
                            selected: strategy == 'direct',
                            onTap: () => setState(() => strategy = 'direct'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (recording || widget.controller.transcribing)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Row(
                            children: [
                              Icon(
                                recording
                                    ? Icons.mic_rounded
                                    : Icons.graphic_eq,
                                color: recording
                                    ? Theme.of(context).colorScheme.error
                                    : Theme.of(context).colorScheme.primary,
                              ),
                              const SizedBox(width: 8),
                              Text(
                                recording
                                    ? 'Recording · tap stop to review transcript'
                                    : 'Turning voice into an editable draft…',
                              ),
                            ],
                          ),
                        ),
                      if (recordingError != null ||
                          widget.controller.voiceError != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Text(
                              recordingError ?? 'Voice transcription is temporarily unavailable.',
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            ),
                          ),
                        ),
                      TextField(
                        controller: input,
                        minLines: 1,
                        maxLines: 5,
                        textInputAction: TextInputAction.send,
                        onSubmitted:
                            widget.controller.sending ||
                                widget.controller.transcribing ||
                                recording
                            ? null
                            : (_) => submit(),
                        decoration: InputDecoration(
                          hintText: 'Describe an outcome or ask a question',
                          filled: true,
                          suffixIcon: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                tooltip: recording
                                    ? 'Stop and transcribe voice draft'
                                    : 'Record voice draft',
                                onPressed:
                                    widget.controller.sending ||
                                        widget.controller.transcribing
                                    ? null
                                    : toggleVoiceDraft,
                                color: recording
                                    ? Theme.of(context).colorScheme.error
                                    : null,
                                icon: Icon(
                                  recording
                                      ? Icons.stop_circle_outlined
                                      : Icons.mic_none_rounded,
                                ),
                              ),
                              IconButton(
                                tooltip: 'Send message',
                                onPressed:
                                    widget.controller.sending || recording
                                    ? null
                                    : submit,
                                icon: const Icon(Icons.arrow_upward_rounded),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class _ModeChip extends StatelessWidget {
  const _ModeChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => ChoiceChip(
    label: Text(label),
    selected: selected,
    onSelected: (_) => onTap(),
    showCheckmark: false,
    visualDensity: VisualDensity.compact,
  );
}

class _TalkEmpty extends StatelessWidget {
  const _TalkEmpty();
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.hub_outlined,
            size: 48,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 20),
          Text(
            'What should we work on?',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Ask a question, investigate a topic, or describe an outcome. Complex work can become a durable mission.',
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );
}
