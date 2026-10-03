import 'dart:async';

import 'package:asael/features/companion/companion_controller.dart';
import 'package:asael/features/companion/companion_entry.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:asael/features/companion/companion_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'companion_fixtures.dart';

void main() {
  testWidgets('ordinary entry uses the validated saved native destination', (
    tester,
  ) async {
    final repository = FakeCompanionRepository()
      ..response = CompanionResponse.fromJson(
        companionFixture(
          revision: 1,
          preferences: const CompanionPreferences(
            defaultDestination: 'activity',
          ),
        ),
      );
    final controller = CompanionController(repository);
    final router = GoRouter(
      initialLocation: '/companion-entry',
      routes: [
        GoRoute(
          path: '/companion-entry',
          builder: (_, _) => const CompanionDefaultEntry(fallback: '/today'),
        ),
        GoRoute(
          path: '/activity',
          builder: (_, _) => const Scaffold(body: Text('Activity destination')),
        ),
        GoRoute(
          path: '/today',
          builder: (_, _) => const Scaffold(body: Text('Today destination')),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          companionScopeProvider.overrideWithValue((
            deployment: 'https://test.invalid',
            tenantId: 'tenant',
            actorId: 'actor',
            role: 'viewer',
          )),
          companionControllerProvider.overrideWith((_) => controller),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Activity destination'), findsOneWidget);
    expect(repository.submissions, isEmpty);
  });
  testWidgets(
    'a disposed entry never reroutes a chosen destination after a late failed read',
    (tester) async {
      final repository = FakeCompanionRepository()
        ..heldRead = Completer<CompanionResponse>();
      final controller = CompanionController(repository);
      final router = GoRouter(
        initialLocation: '/companion-entry',
        routes: [
          GoRoute(
            path: '/companion-entry',
            builder: (_, _) => const CompanionDefaultEntry(fallback: '/today'),
          ),
          GoRoute(
            path: '/activity',
            builder: (_, _) => const Scaffold(body: Text('Explicit Activity')),
          ),
          GoRoute(
            path: '/today',
            builder: (_, _) => const Scaffold(body: Text('Today fallback')),
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            companionScopeProvider.overrideWithValue((
              deployment: 'https://test.invalid',
              tenantId: 'tenant',
              actorId: 'actor',
              role: 'viewer',
            )),
            companionControllerProvider.overrideWith((_) => controller),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pump();
      router.go('/activity');
      await tester.pumpAndSettle();
      repository.heldRead!.completeError(StateError('offline'));
      await tester.pumpAndSettle();
      expect(find.text('Explicit Activity'), findsOneWidget);
      expect(find.text('Today fallback'), findsNothing);
    },
  );
}
