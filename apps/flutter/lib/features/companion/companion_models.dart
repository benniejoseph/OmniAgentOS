import 'dart:convert';

typedef CompanionJson = Map<String, dynamic>;

const companionContract = 'asael-companion-preferences:1';
const companionMaximumRevision = 9007199254740991;
final _uuid = RegExp(
  r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
);

String? companionThreadId(Object? value) =>
    value is String && _uuid.hasMatch(value) ? value : null;

CompanionJson _object(Object? value, Set<String> keys) {
  if (value is! Map ||
      value.keys.any((key) => key is! String) ||
      value.length != keys.length ||
      !value.keys.every(keys.contains)) {
    throw const FormatException('Companion response could not be verified.');
  }
  return Map<String, dynamic>.from(value);
}

String _choice(Object? value, Set<String> choices) {
  if (value is! String || !choices.contains(value)) {
    throw const FormatException('Companion setting could not be verified.');
  }
  return value;
}

int _revision(Object? value) {
  if (value is! int || value < 0 || value > companionMaximumRevision) {
    throw const FormatException('Companion revision could not be verified.');
  }
  return value;
}

String _instant(Object? value) {
  final match = value is String
      ? RegExp(
          r'^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$',
        ).firstMatch(value)
      : null;
  if (match == null) {
    throw const FormatException('Companion timestamp could not be verified.');
  }
  final year = int.parse(match[1]!);
  final month = int.parse(match[2]!);
  final day = int.parse(match[3]!);
  final leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  final days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw const FormatException('Companion timestamp could not be verified.');
  }
  return value as String;
}

class CompanionPreferences {
  const CompanionPreferences({
    this.intensity = 'balanced',
    this.visible = true,
    this.motion = 'full',
    this.defaultDestination = 'assistant',
    this.preferredThreadId,
  });

  factory CompanionPreferences.fromJson(Object? value) {
    final row = _object(value, {
      'intensity',
      'visible',
      'motion',
      'defaultDestination',
      'preferredThreadId',
    });
    final id = row['preferredThreadId'];
    if (row['visible'] is! bool ||
        (id != null && companionThreadId(id) == null)) {
      throw const FormatException(
        'Companion preferences could not be verified.',
      );
    }
    return CompanionPreferences(
      intensity: _choice(row['intensity'], {'quiet', 'balanced', 'expressive'}),
      visible: row['visible'] as bool,
      motion: _choice(row['motion'], {'full', 'reduced', 'off'}),
      defaultDestination: _choice(row['defaultDestination'], {
        'assistant',
        'today',
        'activity',
        'work',
      }),
      preferredThreadId: id as String?,
    );
  }

  final String intensity;
  final bool visible;
  final String motion;
  final String defaultDestination;
  final String? preferredThreadId;

  CompanionPreferences copyWith({
    String? intensity,
    bool? visible,
    String? motion,
    String? defaultDestination,
    String? preferredThreadId,
    bool clearThread = false,
  }) => CompanionPreferences(
    intensity: intensity ?? this.intensity,
    visible: visible ?? this.visible,
    motion: motion ?? this.motion,
    defaultDestination: defaultDestination ?? this.defaultDestination,
    preferredThreadId: clearThread
        ? null
        : preferredThreadId ?? this.preferredThreadId,
  );

  CompanionJson toJson() => {
    'intensity': intensity,
    'visible': visible,
    'motion': motion,
    'defaultDestination': defaultDestination,
    'preferredThreadId': preferredThreadId,
  };

  @override
  bool operator ==(Object other) =>
      other is CompanionPreferences &&
      intensity == other.intensity &&
      visible == other.visible &&
      motion == other.motion &&
      defaultDestination == other.defaultDestination &&
      preferredThreadId == other.preferredThreadId;
  @override
  int get hashCode => Object.hash(
    intensity,
    visible,
    motion,
    defaultDestination,
    preferredThreadId,
  );
}

class CompanionSubmission {
  CompanionSubmission({
    required this.key,
    required this.expectedRevision,
    required this.draftAtStart,
    this.reset = false,
  }) {
    if (expectedRevision < 0 ||
        expectedRevision >= companionMaximumRevision ||
        !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key)) {
      throw const FormatException('Companion submission identity is invalid.');
    }
    CompanionPreferences.fromJson(draftAtStart.toJson());
  }
  final String key;
  final int expectedRevision;
  final CompanionPreferences draftAtStart;
  final bool reset;
  CompanionPreferences get submitted =>
      reset ? const CompanionPreferences() : draftAtStart;
  CompanionJson toJson() => {
    'action': reset ? 'reset' : 'save',
    'expectedRevision': expectedRevision,
    if (!reset) 'preferences': submitted.toJson(),
  };
  String get serializedBody => jsonEncode(toJson());
}

class CompanionReceipt {
  const CompanionReceipt({
    required this.outcome,
    required this.id,
    required this.revision,
    required this.savedAt,
    required this.preferences,
  });
  final String outcome;
  final String id;
  final int revision;
  final String savedAt;
  final CompanionPreferences preferences;
}

class CompanionResponse {
  const CompanionResponse({
    required this.revision,
    required this.persisted,
    required this.updatedAt,
    required this.preferences,
    required this.homeState,
    this.receipt,
  });

  factory CompanionResponse.fromJson(
    Object? value, {
    CompanionSubmission? submission,
  }) {
    final row = _object(value, {
      'schemaVersion',
      'contract',
      'snapshot',
      'home',
      'destination',
      if (submission != null) 'mutation',
    });
    if (row['schemaVersion'] != 1 || row['contract'] != companionContract) {
      throw const FormatException('Companion contract is unavailable.');
    }
    final snapshot = _object(row['snapshot'], {
      'revision',
      'persisted',
      'updatedAt',
      'preferences',
    });
    final revision = _revision(snapshot['revision']);
    final preferences = CompanionPreferences.fromJson(snapshot['preferences']);
    final updatedAt = snapshot['updatedAt'] == null
        ? null
        : _instant(snapshot['updatedAt']);
    if (revision == 0
        ? snapshot['persisted'] != false ||
              updatedAt != null ||
              preferences != const CompanionPreferences()
        : snapshot['persisted'] != true || updatedAt == null) {
      throw const FormatException(
        'Saved Companion state could not be verified.',
      );
    }
    final home = _object(row['home'], {
      'state',
      'preferredThreadId',
      'href',
      'fallbackHref',
    });
    final homeState = _choice(home['state'], {
      'not_set',
      'available',
      'unavailable',
      'unconfirmed',
    });
    final id = preferences.preferredThreadId;
    final href = homeState == 'available' && id != null
        ? '/app/command?thread=$id'
        : null;
    if (home['preferredThreadId'] != id ||
        (id == null) != (homeState == 'not_set') ||
        home['href'] != href ||
        home['fallbackHref'] != '/app/command') {
      throw const FormatException(
        'Home conversation identity could not be verified.',
      );
    }
    final destination = _object(row['destination'], {'href', 'state'});
    final expectedHref = switch (preferences.defaultDestination) {
      'today' => '/app',
      'activity' => '/app/activity',
      'work' => '/app/projects',
      _ => href ?? '/app/command',
    };
    final fallback =
        preferences.defaultDestination == 'assistant' &&
        id != null &&
        href == null;
    if (destination['href'] != expectedHref ||
        destination['state'] != (fallback ? 'fallback' : 'configured')) {
      throw const FormatException('Default destination could not be verified.');
    }
    CompanionReceipt? receipt;
    if (submission != null) {
      final mutation = _object(row['mutation'], {
        'outcome',
        'receiptId',
        'revision',
        'savedAt',
        'preferences',
      });
      final receiptId = mutation['receiptId'];
      final mutationRevision = _revision(mutation['revision']);
      final accepted = CompanionPreferences.fromJson(mutation['preferences']);
      final savedAt = _instant(mutation['savedAt']);
      if (receiptId is! String ||
          !RegExp(r'^companion:[a-f0-9]{64}$').hasMatch(receiptId) ||
          mutationRevision != submission.expectedRevision + 1 ||
          mutationRevision > revision ||
          accepted != submission.submitted ||
          (mutationRevision == revision &&
              (accepted != preferences || savedAt != updatedAt))) {
        throw const FormatException(
          'The preference submission is not yet confirmed.',
        );
      }
      receipt = CompanionReceipt(
        outcome: _choice(mutation['outcome'], {'saved', 'replayed'}),
        id: receiptId,
        revision: mutationRevision,
        savedAt: savedAt,
        preferences: accepted,
      );
    }
    return CompanionResponse(
      revision: revision,
      persisted: snapshot['persisted'] as bool,
      updatedAt: updatedAt,
      preferences: preferences,
      homeState: homeState,
      receipt: receipt,
    );
  }

  final int revision;
  final bool persisted;
  final String? updatedAt;
  final CompanionPreferences preferences;
  final String homeState;
  final CompanionReceipt? receipt;
  String? get availableThreadId =>
      homeState == 'available' ? preferences.preferredThreadId : null;
  String get nativeDestination => switch (preferences.defaultDestination) {
    'today' => '/today',
    'activity' => '/activity',
    'work' => '/projects',
    _ =>
      availableThreadId == null ? '/talk' : '/talk?thread=$availableThreadId',
  };
}

class CompanionConversation {
  const CompanionConversation(this.id, this.title, this.updatedAt, this.mode);
  final String id;
  final String title;
  final String updatedAt;
  final String mode;
}

({List<CompanionConversation> threads, int omitted})
parseCompanionConversations(
  Object? value, {
  required String tenantId,
  required String actorId,
}) {
  final rows = value is Map ? value['threads'] : null;
  if (rows is! List || rows.length > 100) {
    throw const FormatException('Owned conversations are unavailable.');
  }
  final accepted = <CompanionConversation>[];
  final counts = <String, int>{};
  for (final row in rows) {
    if (row is! Map) continue;
    final id = companionThreadId(row['id']);
    final title = row['title'];
    if (id == null ||
        row['tenantId'] != tenantId ||
        row['actorId'] != actorId ||
        title is! String ||
        title.isEmpty ||
        title.length > 2000) {
      continue;
    }
    try {
      accepted.add(
        CompanionConversation(
          id,
          title,
          _instant(row['updatedAt']),
          _choice(row['mode'], {'orchestrate', 'research', 'execute', 'learn'}),
        ),
      );
      counts[id] = (counts[id] ?? 0) + 1;
    } on FormatException {
      continue;
    }
  }
  final unique = accepted
      .where((row) => counts[row.id] == 1)
      .toList(growable: false);
  return (
    threads: List.unmodifiable(unique),
    omitted: rows.length - unique.length,
  );
}
