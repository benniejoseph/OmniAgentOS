String? verbalApprovalDecision(String text) {
  final value = text
      .toLowerCase()
      .trim()
      .replaceFirst(RegExp(r'[.!?,]+$'), '')
      .trim()
      .replaceAll(RegExp(r'\s+'), ' ');
  if (const {
    'yes',
    'yes please',
    'approve',
    'i approve',
    'approve this action',
    'yes approve this action',
    'go ahead',
  }.contains(value)) {
    return 'approve';
  }
  if (const {
    'no',
    'no thanks',
    'reject',
    'i reject',
    'reject this action',
    'do not do that',
    "don't do that",
    'cancel this action',
  }.contains(value)) {
    return 'reject';
  }
  return null;
}

/// A presentation must precede the actual microphone speech-start and commit.
/// Neither assistant transcripts nor model function arguments enter this gate.
class VerbalApprovalGate {
  String? _presentationId;
  DateTime? _expiresAt;
  String? _speechPresentation;
  String? _itemId;
  bool get armed =>
      _presentationId != null && _expiresAt!.isAfter(DateTime.now());
  void present(String id, DateTime expiresAt) {
    clear();
    _presentationId = id;
    _expiresAt = expiresAt;
  }

  void speechStarted() {
    _speechPresentation = armed ? _presentationId : null;
    _itemId = null;
  }

  void committed(String id) =>
      _itemId = _speechPresentation == _presentationId ? id : null;
  ({String presentationId, String decision})? consume(String id, String text) {
    final decision = verbalApprovalDecision(text);
    if (decision == null && _itemId == id) {
      clear();
      return null;
    }
    if (!armed ||
        _itemId != id ||
        _speechPresentation != _presentationId ||
        decision == null) {
      return null;
    }
    final result = (presentationId: _presentationId!, decision: decision);
    clear();
    return result;
  }

  void clear() {
    _presentationId = null;
    _expiresAt = null;
    _speechPresentation = null;
    _itemId = null;
  }
}
