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
