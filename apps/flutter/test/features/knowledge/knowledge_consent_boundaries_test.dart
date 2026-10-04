import 'dart:async';

import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_api_repository.dart';
import 'package:asael/features/knowledge/knowledge_consent_contracts.dart';
import 'package:asael/features/knowledge/knowledge_consent_view.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:asael/features/knowledge/macos_knowledge_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_consent_fixtures.dart';
import 'knowledge_review_fixtures.dart' show reviewOwner;

class _ConsentApi extends Fake implements ApiClient {
  final paths = <String>[];
  NativeRequestAuthority? authority;
  Map<String, dynamic>? body, headers;
  Future<Map<String, dynamic>> Function()? response;
  @override
  Future<Map<String, dynamic>> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) {
    paths.add(path);
    this.authority = authority;
    expect(query, isNull);
    return response!();
  }

  @override
  Future<Map<String, dynamic>> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) {
    paths.add(path);
    this.authority = authority;
    body = data;
    this.headers = headers;
    return response!();
  }
}

void main() {
  test('current GET, exact decision GET and PATCH use distinct generated contract paths and exact credentials', () async {
    final api = _ConsentApi(),
        access = KnowledgeAccess()..update(reviewOwner, true);
    final repo = ApiKnowledgeRepository(api, access: access),
        snapshot = await consentCurrent();
    addTearDown(repo.dispose);
    api.response = () => consentResponse(snapshot);
    await repo.readConsent();
    expect(
      api.paths.last,
      NativePaths.memoryPersonalContextConsentGet(
        contract: memoryConsentReadContract,
      ),
    );
    final sent = consentSubmission(snapshot),
        hash = await memoryShaText('consent-fixed-key');
    api.response = () => consentResponse(snapshot, keyHash: hash);
    await repo.readConsent(acceptanceKeySha256: hash);
    expect(
      api.paths.last,
      NativePaths.memoryPersonalContextConsentDecisionGet(hash),
    );
    final acceptance = await consentAcceptance(sent);
    final activated = await consentCurrent(active: true);
    api.response = () =>
        consentResponse(activated, acceptance: acceptance, sent: sent);
    await repo.submit(sent, () => true);
    expect(api.paths.last, NativePaths.memoryPersonalContextConsentDecide);
    expect(api.body, sent.body);
    expect(api.headers, {'Idempotency-Key': sent.key});
    expect(api.authority!.canonicalUserId, reviewOwner.userId);
  });
  test(
    'same-owner repository replacement cancels late private consent reads',
    () async {
      final api = _ConsentApi(),
          access = KnowledgeAccess()..update(reviewOwner, true);
      final held = Completer<Map<String, dynamic>>(),
          repo = ApiKnowledgeRepository(api, access: access);
      api.response = () => held.future;
      final reading = repo.readConsent();
      final failure = expectLater(reading, throwsFormatException);
      repo.dispose();
      expect(api.authority!.isCurrent(), isFalse);
      held.complete(await consentResponse(await consentCurrent()));
      await failure;
    },
  );
  testWidgets(
    'phone Personal recall shows the full notice at 200 percent and does not optimistically enable during a held write',
    (tester) async {
      final previousPolicy = WidgetController.hitTestWarningShouldBeFatal;
      WidgetController.hitTestWarningShouldBeFatal = true;
      addTearDown(() {
        WidgetController.hitTestWarningShouldBeFatal = previousPolicy;
      });
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 900);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final repo = ConsentRepository(await consentCurrent())
        ..heldSubmit = Completer<MemoryAcceptance>();
      final controller = consentController(
        repo,
        MemoryKnowledgeRecoveryStore(),
      );
      addTearDown(controller.dispose);
      await controller.reloadRecovery();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: KnowledgeView(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      final tab = find.widgetWithText(Tab, 'Personal recall');
      await tester.ensureVisible(tab);
      await tester.pumpAndSettle();
      expect(tab.hitTestable(), findsOneWidget);
      await tester.tap(tab);
      await tester.pumpAndSettle();
      final scroll = find
          .descendant(
            of: find.byType(KnowledgePersonalRecall),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.text(consentText),
        300,
        scrollable: scroll,
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<SelectableText>(
              find.byWidgetPredicate(
                (widget) =>
                    widget is SelectableText && widget.data == consentText,
              ),
            )
            .maxLines,
        isNull,
      );
      final enable = find.widgetWithText(
        OutlinedButton,
        'Enable personal recall',
      );
      await tester.scrollUntilVisible(enable, 300, scrollable: scroll);
      await tester.pumpAndSettle();
      expect(enable.hitTestable(), findsOneWidget);
      await tester.tap(enable);
      await tester.pumpAndSettle();
      final confirm = find.widgetWithText(
        FilledButton,
        'Confirm enable personal recall',
      );
      await tester.scrollUntilVisible(confirm, 300, scrollable: scroll);
      await tester.pumpAndSettle();
      expect(confirm.hitTestable(), findsOneWidget);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(repo.submissions, hasLength(1));
      expect(controller.acceptedChange, isNull);
      expect(controller.pendingChange, isNotNull);
      final off = find.text(
        'Last verified read: personal automatic recall is off.',
      );
      await tester.scrollUntilVisible(off, -300, scrollable: scroll);
      await tester.pumpAndSettle();
      expect(off, findsOneWidget);
      expect(
        find.text('Last verified read: personal automatic recall is on.'),
        findsNothing,
      );
      repo.heldSubmit!.completeError(StateError('Response lost'));
      await tester.pumpAndSettle();
      expect(controller.pendingChange, isNotNull);
      expect(repo.submissions, hasLength(1));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'macOS recall entry remains independently readable and loses notice on owner replacement',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1440, 1000);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final repo = ConsentRepository(await consentCurrent(writable: false))
        ..failCatalogue = true;
      final controller = consentController(
        repo,
        MemoryKnowledgeRecoveryStore(),
      );
      addTearDown(controller.dispose);
      await controller.reloadRecovery();
      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: MacosKnowledgeView(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, 'Personal recall'));
      await tester.pumpAndSettle();
      expect(find.text(consentText), findsOneWidget);
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Enable personal recall'),
            )
            .onPressed,
        isNull,
      );
      repo.access.update(null, false);
      await tester.pumpAndSettle();
      expect(find.text(consentText), findsNothing);
      expect(controller.available, isFalse);
      expect(repo.submissions, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
