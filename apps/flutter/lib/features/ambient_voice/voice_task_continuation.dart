/// Whole-utterance dispatch hints only. The service independently verifies the
/// prior owned task and its original human objective; matching grants no action
/// authority. Stop/wait qualifiers and suggestions-only questions never match.
bool isExplicitVoiceTaskContinuation(String caption) {
  if (caption.length > 300) return false;
  final text = caption.trim().toLowerCase().replaceAll(RegExp(r'\s+'), ' ');
  return _continuation.hasMatch(text);
}

final _continuation = RegExp(
  r'^(?:(?:asael|please|yes|okay|ok)[, ]+)*'
  r'(?:(?:can|could|would) you (?:please )?)?'
  r'(?:'
  r'try (?:again|it|(?:another|a different) (?:approach|way|method))'
  r'|think of (?:another|a different) (?:approach|way|method) and try it'
  r'|go ahead(?: and try (?:again|(?:another|a different) (?:approach|way|method)))?'
  r'|(?:proceed|continue)(?: with (?:that|it|the same task))?'
  r')'
  r'(?: please)?[.!?]*$',
);
