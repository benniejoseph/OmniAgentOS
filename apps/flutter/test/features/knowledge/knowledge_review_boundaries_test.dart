import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_api_repository.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:asael/features/knowledge/knowledge_review_contracts.dart';
import 'package:asael/features/knowledge/knowledge_reviews.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_review_fixtures.dart';

class ReviewApi extends Fake implements ApiClient {
  final paths = <String>[];
  NativeRequestAuthority? lastAuthority;
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
    lastAuthority = authority;
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
    lastAuthority = authority;
    body = data;
    this.headers = headers;
    return response!();
  }
}

void main() {
  test(
    'published reads encode full IDs and recovery uses only the raw-key hash',
    () async {
      final api = ReviewApi(),
          access = KnowledgeAccess()..update(reviewOwner, true);
      final repo = ApiKnowledgeRepository(api, access: access);
      addTearDown(repo.dispose);
      api.response = () => reviewList([reviewRow()]);
      await repo.listReviews();
      expect(
        api.paths.single,
        NativePaths.memoryReconciliationList(
          contract: memoryReviewReadContract,
          status: 'pending',
          limit: 50,
        ),
      );
      const id = 'review:outside/first+page';
      api.response = () => reviewRead(reviewRow(id: id));
      final hash = await memoryShaText('frozen-key');
      await repo.readReview(id, acceptanceKeySha256: hash);
      expect(
        api.paths.last,
        NativePaths.memoryReconciliationRead(id, acceptanceKeySha256: hash),
      );
      expect(api.lastAuthority!.canonicalUserId, reviewOwner.userId);
      expect(api.lastAuthority!.role, reviewOwner.role);
    },
  );
  test('owner-bound transport loses authority before a late private read can return', () async {
    final held = Completer<Map<String, dynamic>>(),
        api = ReviewApi(),
        access = KnowledgeAccess()..update(reviewOwner, true);
    final repo = ApiKnowledgeRepository(api, access: access);
    addTearDown(repo.dispose);
    api.response = () => held.future;
    final reading = repo.readReview('review:one');
    final failure = expectLater(reading, throwsFormatException);
    access.close(notify: false);
    expect(api.lastAuthority!.isCurrent(), isFalse);
    held.complete(await reviewRead(reviewRow()));
    await failure;
  });
  test(
    'PATCH carries exactly the persisted decision body and idempotency key',
    () async {
      final api = ReviewApi(),
          access = KnowledgeAccess()..update(reviewOwner, true);
      final repo = ApiKnowledgeRepository(api, access: access),
          sent = reviewSubmission();
      addTearDown(repo.dispose);
      api.response = () => reviewDecisionResponse(sent);
      await repo.submit(sent, () => true);
      expect(api.paths.single, NativePaths.memoryReconciliationResolve);
      expect(api.body, sent.body);
      expect(api.headers, {'Idempotency-Key': sent.key});
    },
  );
  testWidgets(
    'private review is readable at phone width and 200 percent text without a decision grant',
    (tester) async {
      final previousHitTestPolicy =
          WidgetController.hitTestWarningShouldBeFatal;
      WidgetController.hitTestWarningShouldBeFatal = true;
      addTearDown(() {
        WidgetController.hitTestWarningShouldBeFatal = previousHitTestPolicy;
      });
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 800);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final repo = ReviewRepository()..row = reviewRow(writable: false);
      final controller = reviewController(repo, MemoryKnowledgeRecoveryStore());
      await controller.reloadRecovery();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(body: KnowledgeReviews(controller: controller)),
        ),
      );
      await tester.pumpAndSettle();
      final inspect = find.widgetWithText(
        OutlinedButton,
        'Inspect exact review',
      );
      await tester.scrollUntilVisible(
        inspect,
        250,
        scrollable: find.byType(Scrollable).first,
      );
      // ensureVisible finishes by changing the scroll offset. Paint that frame
      // before checking or tapping the actual button at this text scale.
      await tester.pumpAndSettle();
      expect(inspect.hitTestable(), findsOneWidget);
      await tester.tap(inspect);
      await tester.pumpAndSettle();
      expect(repo.reads.single.id, 'review:one');
      await tester.scrollUntilVisible(
        find.textContaining('no current decision token'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('no current decision token'), findsOneWidget);
      final confirm = find.widgetWithText(OutlinedButton, 'Confirm candidate');
      await tester.scrollUntilVisible(
        confirm,
        400,
        maxScrolls: 100,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(confirm).top, greaterThanOrEqualTo(0));
      expect(tester.getRect(confirm).bottom, lessThanOrEqualTo(800));
      final button = tester.widget<OutlinedButton>(confirm);
      expect(button.onPressed, isNull);
      expect(find.text('Keep both'), findsNothing);
      expect(repo.submissions, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'mounted controller replacement clears exact private content and fences an old read',
    (tester) async {
      final first = ReviewRepository(),
          second = ReviewRepository()
            ..row = reviewRow(
              writable: false,
              content: 'Second owner private body',
            );
      final a = reviewController(first, MemoryKnowledgeRecoveryStore()),
          b = reviewController(second, MemoryKnowledgeRecoveryStore());
      addTearDown(a.dispose);
      addTearDown(b.dispose);
      await a.reloadRecovery();
      await b.reloadRecovery();
      Widget app(KnowledgeController controller) => MaterialApp(
        home: Scaffold(body: KnowledgeReviews(controller: controller)),
      );
      await tester.pumpWidget(app(a));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Inspect exact review'));
      await tester.pumpAndSettle();
      first.heldRead = Completer<MemoryReviewRead>();
      await tester.ensureVisible(find.text('Refresh exact review'));
      await tester.tap(find.text('Refresh exact review'));
      await tester.pump();
      await tester.pumpWidget(app(b));
      await tester.pumpAndSettle();
      expect(find.text('Private candidate content'), findsNothing);
      first.heldRead!.complete(
        await MemoryReviewRead.parse(
          await reviewRead(first.row),
          reviewOwner,
          'review:one',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Private candidate content'), findsNothing);
      expect(find.text('Exact review'), findsNothing);
      expect(second.submissions, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
