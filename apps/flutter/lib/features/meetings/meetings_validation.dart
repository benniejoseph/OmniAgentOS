typedef MeetingJson = Map<String, dynamic>;

const meetingAccessClasses = [
  'owner_private',
  'project_members',
  'workspace_members',
];
const meetingSourceKinds = [
  'calendar_event',
  'capture_recording',
  'capture_asset',
  'source_revision',
];
const meetingMediaRoles = [
  'calendar',
  'recording',
  'transcript',
  'attachment',
  'reference',
];

void meetingRequire(
  bool condition, [
  String message = 'The Meeting response is incomplete or inconsistent.',
]) {
  if (!condition) {
    throw FormatException(message);
  }
}

MeetingJson meetingMap(Object? value) {
  meetingRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

String meetingText(Object? value, {int max = 240, bool empty = false}) {
  meetingRequire(
    value is String &&
        value.length <= max &&
        (empty || value.trim().isNotEmpty),
  );
  return value as String;
}

String? meetingNullableText(Object? value, {int max = 240}) =>
    value == null ? null : meetingText(value, max: max);
String meetingId(Object? value, {int max = 260}) {
  final text = meetingText(value, max: max);
  meetingRequire(
    text.trim() == text &&
        RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(text),
  );
  return text;
}

String? meetingNullableId(Object? value) =>
    value == null ? null : meetingId(value);
String meetingHash(Object? value) {
  final text = meetingText(value, max: 64);
  meetingRequire(RegExp(r'^[a-f0-9]{64}$').hasMatch(text));
  return text;
}

int meetingInt(
  Object? value, {
  int minimum = 0,
  int maximum = 9007199254740991,
}) {
  meetingRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

double? meetingNullableNumber(Object? value) {
  if (value == null) {
    return null;
  }
  meetingRequire(value is num && value.isFinite && value >= 0);
  return (value as num).toDouble();
}

String meetingMember(Object? value, Iterable<String> members) {
  meetingRequire(value is String && members.contains(value));
  return value as String;
}

DateTime meetingDate(Object? value) {
  final text = meetingText(value, max: 30);
  meetingRequire(
    RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$').hasMatch(text),
  );
  final date = DateTime.tryParse(text);
  meetingRequire(date != null && date.toUtc().toIso8601String() == text);
  return date!;
}

DateTime? meetingNullableDate(Object? value) =>
    value == null ? null : meetingDate(value);
List<T> meetingList<T>(
  Object? value,
  int maximum,
  T Function(MeetingJson) parse,
) {
  meetingRequire(value is List && value.length <= maximum);
  return List<T>.unmodifiable(
    (value as List).map((item) => parse(meetingMap(item))),
  );
}

void meetingUnique(Iterable<String> ids) {
  final values = ids.toList();
  meetingRequire(values.toSet().length == values.length);
}

Object? freezeMeeting(Object? value, [int depth = 0]) {
  meetingRequire(depth <= 24);
  if (value is Map) {
    return Map<String, dynamic>.unmodifiable(
      meetingMap(value)
          .map((key, item) => MapEntry(key, freezeMeeting(item, depth + 1))),
    );
  }
  if (value is List) {
    return List<Object?>.unmodifiable(
      value.map((item) => freezeMeeting(item, depth + 1)),
    );
  }
  meetingRequire(
    value == null ||
        value is String ||
        value is bool ||
        value is num && value.isFinite,
  );
  return value;
}
