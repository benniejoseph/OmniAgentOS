typedef WatchJson = Map<String, dynamic>;
const watchContract = 'asael-availability-watches:1';
final watchIdPattern = RegExp(r'^watch_[a-f0-9]{48}$');

WatchJson watchMap(Object? value) {
  if (value is! Map || value.keys.any((key) => key is! String)) {
    throw const FormatException('The watch response is invalid.');
  }
  return Map<String, dynamic>.from(value);
}

String watchText(WatchJson value, String key, {int max = 700}) {
  final result = value[key];
  if (result is! String || result.isEmpty || result.length > max) {
    throw FormatException('The watch $key is invalid.');
  }
  return result;
}

DateTime? watchTime(Object? value) {
  if (value == null) return null;
  if (value is! String) {
    throw const FormatException('The watch date is invalid.');
  }
  final parsed = DateTime.tryParse(value);
  if (parsed == null || !parsed.isUtc) {
    throw const FormatException('The watch date is invalid.');
  }
  return parsed;
}

Uri watchPublicUrl(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host != 'www.district.in' ||
      uri.userInfo.isNotEmpty ||
      uri.hasPort ||
      uri.hasFragment) {
    throw const FormatException('The booking address is invalid.');
  }
  return uri;
}

int watchCount(
  WatchJson value,
  String key, {
  int minimum = 0,
  int maximum = 100000,
}) {
  final result = value[key];
  if (result is! int || result < minimum || result > maximum) {
    throw FormatException('The watch $key is invalid.');
  }
  return result;
}

void _requiredTime(Object? value) {
  if (watchTime(value) == null) {
    throw const FormatException('A required watch date is missing.');
  }
}

void _nullableText(WatchJson value, String key, int maximum) {
  if (value[key] != null) watchText(value, key, max: maximum);
}

WatchJson watchCheck(Object? value) {
  final check = watchMap(value);
  if (!RegExp(r'^availability-check:[a-f0-9]{64}$')
          .hasMatch(watchText(check, 'id')) ||
      !const {
        'queued',
        'running',
        'completed',
        'failed',
        'canceled',
      }.contains(check['state'])) {
    throw const FormatException('The saved watch check is invalid.');
  }
  watchCount(check, 'generation', minimum: 1);
  _requiredTime(check['scheduledFor']);
  watchTime(check['startedAt']);
  watchTime(check['finishedAt']);
  if (check['error'] != null) {
    final error = watchMap(check['error']);
    watchText(error, 'code', max: 100);
    watchText(error, 'message', max: 350);
  }
  if (check['observation'] != null) _observation(check['observation']);
  return Map<String, dynamic>.unmodifiable(check);
}

void _observation(Object? value) {
  final observation = watchMap(value);
  if (!const {
    'available',
    'not_listed',
    'sold_out',
  }.contains(observation['outcome'])) {
    throw const FormatException('The watch observation is invalid.');
  }
  _requiredTime(observation['checkedAt']);
  _requiredTime(observation['providerObservedAt']);
  watchCount(observation, 'matchingSessions', maximum: 2000);
  watchPublicUrl(watchText(observation, 'sourceUrl'));
}

class AvailabilityWatch {
  AvailabilityWatch._(
    this.raw,
    this.config,
    this.source,
    this.target,
    this.matches,
  );
  final WatchJson raw, config, source, target;
  final List<WatchJson> matches;
  String get id => raw['id'] as String;
  int get revision => raw['revision'] as int;
  String get state => raw['state'] as String;
  String get cinema => source['cinemaName'] as String;
  String get film => target['movieTitle'] as String? ?? 'Any movie';
  String get date => target['date'] as String;
  int get interval => config['intervalMinutes'] as int;
  int get checksUsed => raw['checksUsed'] as int;
  int get maxChecks => config['maxChecks'] as int;
  bool get canStop => const {'active', 'degraded', 'fulfilled'}.contains(state);
  WatchJson? get notification =>
      raw['notification'] == null ? null : watchMap(raw['notification']);
  WatchJson? get delivery =>
      raw['delivery'] == null ? null : watchMap(raw['delivery']);
  WatchJson? get lastError =>
      raw['lastError'] == null ? null : watchMap(raw['lastError']);
  String get statusLabel => switch (state) {
    'active' => 'Watching',
    'degraded' => 'Check failed',
    'fulfilled' => 'Booking found',
    'expired' => 'Expired',
    'stopped' => 'Stopped',
    'exhausted' => 'Check limit reached',
    _ => 'Unavailable',
  };
  factory AvailabilityWatch.fromJson(Object? value) {
    final raw = watchMap(value);
    final id = watchText(raw, 'id');
    if (raw['schemaVersion'] != 1 ||
        !watchIdPattern.hasMatch(id) ||
        raw['revision'] is! int ||
        (raw['revision'] as int) < 1 ||
        raw['generation'] is! int ||
        (raw['generation'] as int) < 1 ||
        !const {
          'active',
          'degraded',
          'fulfilled',
          'expired',
          'stopped',
          'exhausted',
        }.contains(raw['state'])) {
      throw const FormatException('The watch identity or state is invalid.');
    }
    final config = watchMap(raw['config']),
        source = watchMap(config['source']),
        target = watchMap(config['target']);
    if (source['provider'] != 'district' ||
        target['timezone'] != 'Asia/Kolkata' ||
        !const {'gold', 'any'}.contains(target['seatClass']) ||
        config['intervalMinutes'] is! int ||
        (config['intervalMinutes'] as int) < 1 ||
        (config['intervalMinutes'] as int) > 60 ||
        config['maxChecks'] is! int ||
        raw['checksUsed'] is! int ||
        !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(watchText(target, 'date'))) {
      throw const FormatException('The watch conditions are invalid.');
    }
    watchText(source, 'cinemaName', max: 180);
    final sourceUrl = watchPublicUrl(watchText(source, 'sourceUrl'));
    final cinemaId = watchText(source, 'cinemaId', max: 12);
    if (!RegExp(r'^[1-9]\d{0,11}$').hasMatch(cinemaId) ||
        sourceUrl.hasQuery ||
        !RegExp('^/movies/[a-z0-9-]+-CD$cinemaId\$').hasMatch(sourceUrl.path)) {
      throw const FormatException('The cinema page identity is invalid.');
    }
    _nullableText(target, 'movieTitle', 180);
    _nullableText(target, 'language', 60);
    for (final key in ['earliestTime', 'latestTime']) {
      if (target[key] != null &&
          (target[key] is! String ||
              !RegExp(r'^(?:[01]\d|2[0-3]):[0-5]\d$')
                  .hasMatch(target[key] as String))) {
        throw const FormatException('The showtime bounds are invalid.');
      }
    }
    final targetDate = DateTime.tryParse('${target['date']}T00:00:00Z');
    if (targetDate == null ||
        targetDate.toIso8601String().substring(0, 10) != target['date']) {
      throw const FormatException('The cinema date is invalid.');
    }
    watchCount(config, 'maxChecks', minimum: 1, maximum: 50000);
    watchCount(raw, 'checksUsed', maximum: 50000);
    watchCount(raw, 'consecutiveFailures', maximum: 50000);
    _requiredTime(config['expiresAt']);
    _requiredTime(raw['createdAt']);
    _requiredTime(raw['updatedAt']);
    if (raw['openingId'] != null &&
        (raw['openingId'] is! String ||
            !RegExp(r'^availability-opening:[a-f0-9]{64}$')
                .hasMatch(raw['openingId'] as String))) {
      throw const FormatException('The opening identity is invalid.');
    }
    if (raw['lastObservation'] != null) _observation(raw['lastObservation']);
    if (raw['lastError'] != null) {
      final error = watchMap(raw['lastError']);
      watchText(error, 'code', max: 100);
      watchText(error, 'message', max: 350);
      _requiredTime(error['at']);
    }
    if (raw['notification'] != null) {
      final notice = watchMap(raw['notification']);
      if (!const {
            'pending',
            'held',
            'disabled',
            'recorded',
            'expired',
            'canceled',
          }.contains(notice['state']) ||
          notice['pushDeliveryIds'] is! List ||
          (notice['pushDeliveryIds'] as List).length > 100 ||
          (notice['pushDeliveryIds'] as List).any(
            (id) => id is! String || id.isEmpty || id.length > 240,
          )) {
        throw const FormatException('The watch alert state is invalid.');
      }
      _nullableText(notice, 'notificationId', 240);
      _nullableText(notice, 'dispositionId', 240);
      watchTime(notice['nextAttemptAt']);
    }
    if (raw['delivery'] != null) {
      final delivery = watchMap(raw['delivery']);
      for (final key in [
        'queued',
        'running',
        'providerAccepted',
        'received',
        'opened',
        'failed',
        'eligibleDevices',
      ]) {
        watchCount(delivery, key);
      }
      final providers = watchMap(delivery['providers']);
      for (final key in ['apns', 'fcm']) {
        if (!const {
          'configured',
          'configuration_required',
        }.contains(providers[key])) {
          throw const FormatException(
            'The notification provider state is invalid.',
          );
        }
      }
    }
    for (final key in [
      'lastCheckedAt',
      'lastSuccessfulAt',
      'nextCheckAt',
      'createdAt',
      'updatedAt',
    ]) {
      watchTime(raw[key]);
    }
    final items = raw['matches'];
    if (items is! List || items.length > 80) {
      throw const FormatException('The matching sessions are invalid.');
    }
    final matches = items
        .map((value) {
          final match = watchMap(value);
          for (final key in [
            'movieTitle',
            'localTime',
            'seatClass',
            'language',
          ]) {
            watchText(match, key);
          }
          watchPublicUrl(watchText(match, 'bookingUrl'));
          _requiredTime(match['startsAt']);
          if (match['currency'] != 'INR' ||
              (match['price'] != null &&
                  (match['price'] is! num ||
                      !(match['price'] as num).isFinite ||
                      (match['price'] as num) < 0))) {
            throw const FormatException('The session price is invalid.');
          }
          if (match['availableSeats'] is! int ||
              (match['availableSeats'] as int) <= 0) {
            throw const FormatException('The available-seat count is invalid.');
          }
          return Map<String, dynamic>.unmodifiable(match);
        })
        .toList(growable: false);
    return AvailabilityWatch._(
      Map<String, dynamic>.unmodifiable(raw),
      config,
      source,
      target,
      matches,
    );
  }
}
