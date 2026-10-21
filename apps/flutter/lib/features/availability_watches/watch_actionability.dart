/// Presentation eligibility for an already recorded opening. Matches the server
/// contract, including legacy watches whose saved expiry exceeds the show window.
bool availabilityOpeningActionable(Map<String, dynamic> watch, DateTime now) {
  if (watch['state'] != 'fulfilled') return false;
  final config = watch['config'];
  if (config is! Map) return false;
  final target = config['target'];
  if (target is! Map) return false;
  final date = target['date'], latest = target['latestTime'];
  if (date is! String ||
      !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date) ||
      latest != null &&
          (latest is! String ||
              !RegExp(r'^(?:[01]\d|2[0-3]):[0-5]\d$').hasMatch(latest))) {
    return false;
  }
  final parsedDate = DateTime.tryParse('${date}T00:00:00Z');
  if (parsedDate == null ||
      !parsedDate.toIso8601String().startsWith('${date}T')) {
    return false;
  }
  final expires = config['expiresAt'];
  if (expires is! String) return false;
  final explicitEnd = DateTime.tryParse(expires);
  final opportunityEnd = DateTime.tryParse(
    '$date'
    'T${latest == null ? '23:59:59.999' : '$latest:00.000'}+05:30',
  );
  if (explicitEnd == null ||
      !explicitEnd.isUtc ||
      opportunityEnd == null ||
      !explicitEnd.isAfter(now) ||
      !opportunityEnd.isAfter(now)) {
    return false;
  }
  final matches = watch['matches'];
  return matches is List &&
      matches.any((match) {
        if (match is! Map || match['startsAt'] is! String) return false;
        final startsAt = DateTime.tryParse(match['startsAt'] as String);
        return startsAt != null && startsAt.isUtc && startsAt.isAfter(now);
      });
}
