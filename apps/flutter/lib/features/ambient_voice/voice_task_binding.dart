import 'dart:async';

/// Pins a work response to its committed human audio item. Captions may finish
/// after the model asks for work; neither event order nor a later user turn may
/// substitute a different item while its save is pending.
class VoiceTaskBinding {
  int _generation = 0;
  bool _closed = false;
  String? _currentInput;
  final _inputs = <String, _Input>{};
  final _responses = <String, ({String itemId, int generation})>{};

  void speechStarted() {
    _generation++;
    _currentInput = null;
    for (final input in _inputs.values) {
      if (!input.saved.isCompleted) input.saved.complete(null);
    }
  }

  void committed(String itemId) {
    if (_closed || _inputs.containsKey(itemId)) return;
    _currentInput = itemId;
    _inputs[itemId] = _Input(_generation);
  }

  void responseStarted(String responseId) {
    final item = _currentInput;
    if (_closed || item == null || _responses.containsKey(responseId)) return;
    _responses[responseId] = (itemId: item, generation: _generation);
  }

  Future<void> captionSaved(
    String itemId,
    String text,
    Future<bool> saved,
  ) async {
    final input = _inputs[itemId];
    if (_closed || input == null || input.saving || input.saved.isCompleted) {
      return;
    }
    input.saving = true;
    bool success;
    try {
      success = await saved;
    } catch (_) {
      success = false;
    }
    if (!input.saved.isCompleted) {
      input.saved.complete(success && text.isNotEmpty ? text : null);
    }
  }

  Future<({String itemId, String text})?> claim(
    String responseId, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final response = _responses[responseId];
    final input = response == null ? null : _inputs[response.itemId];
    if (_closed ||
        response == null ||
        input == null ||
        input.claimed ||
        response.generation != _generation ||
        input.generation != _generation) {
      return null;
    }
    // One committed utterance starts at most one work request, including two
    // function calls emitted before its final caption has arrived.
    input.claimed = true;
    final text = await input.saved.future.timeout(
      timeout,
      onTimeout: () => null,
    );
    return text != null &&
            !_closed &&
            response.generation == _generation &&
            _currentInput == response.itemId
        ? (itemId: response.itemId, text: text)
        : null;
  }

  void close() {
    _closed = true;
    speechStarted();
    _responses.clear();
    _inputs.clear();
  }
}

class _Input {
  _Input(this.generation);
  final int generation;
  final saved = Completer<String?>();
  bool saving = false;
  bool claimed = false;
}
