import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:omniagent/app/navigation/app_destination.dart';
import 'package:omniagent/app/navigation/destination_placeholder.dart';
import 'package:omniagent/app/theme/app_theme.dart';
import 'package:omniagent/core/state/resource_state.dart';
import 'package:omniagent/features/auth/domain/app_session.dart';

void main() {
  test('session supports nested mobile API payloads', () {
    final session = AppSession.fromJson({
      'user': {'id': 'user-1', 'email': 'pilot@omni.test', 'name': 'Pilot'},
      'workspace': {'name': 'Flight Deck'},
    });

    expect(session.userId, 'user-1');
    expect(session.displayName, 'Pilot');
    expect(session.workspaceName, 'Flight Deck');
  });

  test('resource state dispatches its ready value', () {
    const state = ResourceReady<int>(42);
    final value = state.when(
      idle: () => 0,
      loading: () => -1,
      ready: (data) => data,
      failed: (_) => -2,
    );
    expect(value, 42);
  });

  testWidgets('destination surface exposes its semantic content', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: DestinationPlaceholder(destination: appDestinations.first),
      ),
    );

    expect(find.text('Today'), findsOneWidget);
    expect(
      find.text('Live priorities, briefings, and system pulse.'),
      findsOneWidget,
    );
    expect(find.byType(Card), findsOneWidget);
  });
}
