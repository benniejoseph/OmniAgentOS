import 'package:asael/features/availability_watches/watch_actionability.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Map<String, dynamic> watch({
    String? latest = '12:00',
    String expiry = '2026-10-19T18:29:59.999Z',
    String start = '2026-10-19T06:30:00Z',
  }) => {
    'state': 'fulfilled',
    'config': {
      'expiresAt': expiry,
      'target': {'date': '2026-10-19', 'latestTime': latest},
    },
    'matches': [
      {'startsAt': start},
    ],
  };
  test('old saved end-of-day expiry cannot extend a noon IST watch', () {
    expect(
      availabilityOpeningActionable(
        watch(),
        DateTime.parse('2026-10-19T06:29:59Z'),
      ),
      true,
    );
    expect(
      availabilityOpeningActionable(
        watch(start: '2026-10-19T07:00:00Z'),
        DateTime.parse('2026-10-19T06:30:00Z'),
      ),
      false,
    );
  });
  test('last matching show already started is no longer actionable', () {
    expect(
      availabilityOpeningActionable(
        watch(start: '2026-10-19T05:30:00Z'),
        DateTime.parse('2026-10-19T05:30:00Z'),
      ),
      false,
    );
  });
  test('an earlier explicit expiry and malformed match both fail closed', () {
    final now = DateTime.parse('2026-10-19T05:00:00Z');
    expect(
      availabilityOpeningActionable(watch(expiry: now.toIso8601String()), now),
      false,
    );
    expect(availabilityOpeningActionable(watch(start: 'invalid'), now), false);
    expect(
      availabilityOpeningActionable({...watch(), 'state': 'stopped'}, now),
      false,
    );
    expect(
      availabilityOpeningActionable({...watch(), 'matches': []}, now),
      false,
    );
  });
  test('unbounded show window uses end of date in IST', () {
    expect(
      availabilityOpeningActionable(
        watch(latest: null, start: '2026-10-19T18:29:59.999Z'),
        DateTime.parse('2026-10-19T18:29:59Z'),
      ),
      true,
    );
    expect(
      availabilityOpeningActionable(
        watch(latest: null, start: '2026-10-19T19:00:00Z'),
        DateTime.parse('2026-10-19T18:29:59.999Z'),
      ),
      false,
    );
  });
}
