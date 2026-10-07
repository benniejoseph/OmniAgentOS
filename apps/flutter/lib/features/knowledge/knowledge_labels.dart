/// Presentation labels only. Stored identities and mutation contracts stay exact.
String memoryFriendlyLabel(String value) {
  const labels = <String, String>{
    'all': 'All',
    'semantic': 'Facts',
    'episodic': 'Experiences',
    'procedural': 'How-to',
    'preference': 'Preference',
    'commitment': 'Commitment',
    'decision': 'Decision',
    'summary': 'Summary',
    'working': 'Recent context',
    'user': 'Personal',
    'user_private': 'Private',
    'candidate': 'Needs review',
    'contradicted': 'Conflicting',
    'superseded': 'Replaced',
    'active': 'Active',
    'archived': 'Archived',
    'trace': 'Recall',
    'concept': 'Topic',
    'organization': 'Organization',
    'work_item': 'Work item',
    'person': 'Person',
    'asset': 'File',
    'episode': 'Experience',
    'procedure': 'How-to',
    'task': 'Commitment',
  };
  if (labels.containsKey(value)) return labels[value]!;
  final words = value.replaceAll('_', ' ').trim();
  return words.isEmpty
      ? 'Not recorded'
      : '${words[0].toUpperCase()}${words.substring(1)}';
}

String memoryFriendlyDate(DateTime? value) {
  if (value == null) return 'Date unavailable';
  final local = value.toLocal();
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${months[local.month - 1]} ${local.day}, ${local.year}';
}

final _generatedGraphRunLabel = RegExp(
  r'^(?:source[\s_-]+)?run[\s:_-]+[a-f0-9]{8}(?:[\s-]+[a-f0-9]{1,12})*$',
  caseSensitive: false,
);

/// Keeps generated provenance out of primary labels without changing its record.
String memoryGraphName(String value, {required String fallback}) =>
    _generatedGraphRunLabel.hasMatch(value.trim()) ? fallback : value;

String memoryGraphSummary(String value) {
  final tag = RegExp(
    r'^Tag signal:\s*(.+)$',
    caseSensitive: false,
  ).firstMatch(value.trim());
  if (tag != null && _generatedGraphRunLabel.hasMatch(tag.group(1)!)) {
    return 'Connects this item to a recorded assistant task.';
  }
  // The original summary remains available in the selected technical reference.
  final footer = RegExp(
    r'(?:^|\r?\n)[ \t]*Source run:[ \t]*[a-f0-9]{8}(?:-[a-f0-9]{1,12}){0,4}[ \t]*(?:\r?\n|$)',
    caseSensitive: false,
  ).firstMatch(value);
  return footer == null ? value : value.substring(0, footer.start).trimRight();
}

bool memoryRetiredPlaceholder(String title) =>
    RegExp(r'^\s*\[retired\]', caseSensitive: false).hasMatch(title);

String memoryDisplayTitle(String title, DateTime? updatedAt) {
  final generated = RegExp(
    r'^Assistant inference from run\s+[a-f0-9]{8}(?:-[a-f0-9]{1,12}){0,4}(?:…|\.{3})?$',
    caseSensitive: false,
  ).hasMatch(title.trim());
  if (!generated && !memoryRetiredPlaceholder(title)) return title;
  final suffix = updatedAt == null ? '' : ' · ${memoryFriendlyDate(updatedAt)}';
  return '${generated ? 'Assistant note' : 'Retired memory'}$suffix';
}
