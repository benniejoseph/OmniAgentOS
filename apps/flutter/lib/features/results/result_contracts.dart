import 'dart:convert';

import 'package:flutter/foundation.dart';

typedef ResultJson = Map<String, dynamic>;

void resultRequire(
  bool condition, [
  String message = 'Results returned incomplete or conflicting metadata.',
]) {
  if (!condition) {
    throw FormatException(message);
  }
}

ResultJson resultRecord(Object? value) {
  resultRequire(value is Map<String, dynamic>);
  return value as ResultJson;
}

String resultText(Object? value, {bool empty = false, int maximum = 4000000}) {
  resultRequire(
    value is String && value.length <= maximum && (empty || value.isNotEmpty),
  );
  return value as String;
}

String? resultOptionalText(Object? value) =>
    value == null ? null : resultText(value, empty: true);
String resultMember(Object? value, Iterable<String> values) {
  resultRequire(value is String && values.contains(value));
  return value as String;
}

int resultCount(Object? value, {int maximum = 9007199254740991}) {
  resultRequire(value is int && value >= 0 && value <= maximum);
  return value as int;
}

DateTime resultDate(Object? value) {
  final text = resultText(value, maximum: 40);
  final parts = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$',
  ).firstMatch(text);
  resultRequire(parts != null);
  final match = parts!;
  final year = int.parse(match[1]!),
      month = int.parse(match[2]!),
      day = int.parse(match[3]!);
  resultRequire(
    month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= DateTime.utc(year, month + 1, 0).day &&
        int.parse(match[4]!) <= 23 &&
        int.parse(match[5]!) <= 59 &&
        int.parse(match[6]!) <= 59 &&
        (match[7] == null ||
            int.parse(match[7]!) <= 23 && int.parse(match[8]!) <= 59),
  );
  final date = DateTime.tryParse(text);
  resultRequire(date != null);
  return date!.toUtc();
}

DateTime? resultOptionalDate(Object? value) =>
    value == null ? null : resultDate(value);
List<String> resultStrings(Object? value, {int maximum = 512}) {
  resultRequire(value is List && value.length <= maximum);
  return List.unmodifiable((value as List).map((item) => resultText(item)));
}

/// Route keys are decoded by the router once. IDs may themselves contain
/// colons, slashes, percent escapes or Unicode; never split/decode them again.
class ResultKey {
  const ResultKey(this.kind, this.id);
  final String kind, id;
  String get value => '$kind:$id';
  factory ResultKey.parse(String value) {
    final colon = value.indexOf(':');
    resultRequire(colon > 0, 'This result key is not supported.');
    final kind = resultMember(value.substring(0, colon), [
      'agent',
      'workflow',
      'approval',
    ]);
    final id = value.substring(colon + 1);
    resultRequire(
      id.isNotEmpty &&
          id.length <= 200 &&
          id.trim() == id &&
          !RegExp(r'[\u0000-\u001f\u007f]').hasMatch(id),
      'This result key does not contain a valid exact identity.',
    );
    return ResultKey(kind, id);
  }
}

class ResultCanonical {
  ResultCanonical.fromJson(Object? value, {required String domain}) {
    final record = resultRecord(value);
    resultRequire(record['schemaVersion'] == 1 && record['domain'] == domain);
    status = resultMember(record['status'], [
      'preview',
      'running',
      'waiting',
      'blocked',
      'partial',
      'unverified',
      'failed',
      'canceled',
      'succeeded',
    ]);
    basis = resultMember(record['basis'], [
      'legacy_status',
      'terminal_receipt',
    ]);
    source = resultMember(record['source'], [
      'legacy_adapter',
      'outcome_evaluator',
      'unknown',
    ]);
    sourceStatus = resultText(record['sourceStatus'], maximum: 160);
    verificationState = resultMember(record['verificationState'], [
      'verified',
      'partially_verified',
      'unverified',
      'not_applicable',
      'unassessed',
    ]);
    if (basis == 'legacy_status') {
      resultRequire(
        source == 'legacy_adapter' && verificationState == 'unassessed',
      );
    }
    if (status == 'succeeded') {
      resultRequire(
        domain != 'approval' &&
            basis == 'terminal_receipt' &&
            source == 'outcome_evaluator' &&
            verificationState == 'verified' &&
            sourceStatus == 'succeeded',
      );
    }
  }
  late final String status, basis, source, sourceStatus, verificationState;
  String get label => switch (status) {
    'preview' => 'Preview',
    'running' => 'Running',
    'waiting' => 'Waiting',
    'blocked' => 'Blocked',
    'partial' => 'Partial',
    'unverified' => 'Outcome unverified',
    'failed' => 'Failed',
    'canceled' => 'Canceled',
    'succeeded' => 'Verified success',
    _ => 'Unavailable',
  };
}

enum ResultsSource { runs, workflows, approvals, evaluations, createdFiles }

enum ResultsAvailability {
  unknown,
  loading,
  ready,
  partial,
  restricted,
  unavailable,
}

class ResultsRead {
  const ResultsRead({
    this.state = ResultsAvailability.unknown,
    this.loaded = false,
    this.error,
    this.checkedAt,
    this.omitted = 0,
  });
  final ResultsAvailability state;
  final bool loaded;
  final String? error;
  final DateTime? checkedAt;
  final int omitted;
  bool get fresh =>
      state == ResultsAvailability.ready ||
      state == ResultsAvailability.partial;
  bool get retained => loaded && !fresh;
  ResultsRead pending() => ResultsRead(
    state: ResultsAvailability.loading,
    loaded: loaded,
    checkedAt: checkedAt,
  );
  ResultsRead failed(String message, {bool restricted = false}) => ResultsRead(
    state: restricted
        ? ResultsAvailability.restricted
        : ResultsAvailability.unavailable,
    loaded: restricted ? false : loaded,
    error: message,
    checkedAt: checkedAt,
  );
  String get label => switch (state) {
    ResultsAvailability.unknown => 'Not checked',
    ResultsAvailability.loading =>
      loaded ? 'Refreshing · last loaded' : 'Loading',
    ResultsAvailability.ready => 'Current returned window',
    ResultsAvailability.partial => 'Partial · $omitted records omitted',
    ResultsAvailability.restricted => 'Access restricted',
    ResultsAvailability.unavailable =>
      loaded ? 'Refresh unavailable · last loaded' : 'Unavailable',
  };
}

String resultsSourceLabel(ResultsSource source) => switch (source) {
  ResultsSource.runs => 'Agent runs',
  ResultsSource.workflows => 'Workflows',
  ResultsSource.approvals => 'Approvals',
  ResultsSource.evaluations => 'Evaluations',
  ResultsSource.createdFiles => 'Created files',
};

/// One authority signal for this repository composition. Pausing the same
/// session keeps filters, while owner/role/deployment changes discard content.
class ResultsAccess extends ChangeNotifier {
  ResultsAccess({
    required this.deployment,
    this.tenantId,
    this.actorId,
    this.role,
    this.ready = true,
    this.cancellationAvailable = true,
  });
  final String deployment;
  String? tenantId, actorId, role;
  bool ready, cancellationAvailable, closed = false;
  int generation = 0;
  String get owner => jsonEncode([deployment, tenantId, actorId]);
  String get scope => jsonEncode([deployment, tenantId, actorId, role]);
  bool get readable => ready && !closed;
  bool get writable =>
      readable &&
      cancellationAvailable &&
      const {'operator', 'admin', 'system', 'owner'}.contains(role);
  void update({
    String? tenant,
    String? actor,
    String? nextRole,
    required bool available,
    bool clear = false,
  }) {
    final before = scope, wasReadable = readable;
    if (available || clear) {
      tenantId = tenant;
      actorId = actor;
      role = nextRole;
    }
    ready = available;
    if (before != scope || wasReadable != readable) {
      generation++;
      notifyListeners();
    }
  }

  void close() {
    if (!closed) {
      closed = true;
      generation++;
      notifyListeners();
    }
  }
}
