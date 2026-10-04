import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_api_repository.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_promotion_view.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:asael/features/knowledge/macos_knowledge_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_promotion_fixtures.dart';
import 'knowledge_review_fixtures.dart' show reviewOwner;

class PromotionApi extends Fake implements ApiClient {
  final paths = <String>[];
  NativeRequestAuthority? authority;
  Json? body, headers;
  Future<Json> Function()? response;
  @override
  Future<Json> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Json? query,
    CancelToken? cancelToken,
  }) {
    paths.add(path);
    this.authority = authority;
    return response!();
  }

  @override
  Future<Json> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Json? data,
    Json? headers,
  }) {
    paths.add(path);
    this.authority = authority;
    body = data;
    this.headers = headers;
    return response!();
  }
}

void main() {
  test('published paths preserve exact IDs, raw-key recovery and frozen PATCH body', () async {
    final api = PromotionApi(),
        access = KnowledgeAccess()..update(reviewOwner, true);
    final repo = ApiKnowledgeRepository(api, access: access);
    addTearDown(repo.dispose);
    api.response = () async => promotionList(await promotionRow());
    await repo.listPromotions();
    expect(
      api.paths.single,
      NativePaths.memoryPromotionsList(status: 'pending', limit: 25),
    );
    const id = 'promotion:outside/first+page';
    api.response = () async => promotionResponse(await promotionRow(id: id));
    final hash = await memoryShaText('exact-raw-key');
    await repo.readPromotion(id, acceptanceKeySha256: hash);
    expect(
      api.paths.last,
      NativePaths.memoryPromotionsRead(id, acceptanceKeySha256: hash),
    );
    final sent = await promotionSubmission();
    api.response = () async => promotionResponse(
      await promotionRow(decision: 'promote'),
      acceptance: await promotionAcceptance(sent),
      sent: sent,
    );
    await repo.submit(sent, () => true);
    expect(api.paths.last, NativePaths.memoryPromotionsDecide);
    expect(api.body, sent.body);
    expect(api.headers, {'Idempotency-Key': sent.key});
    expect(api.authority!.canonicalUserId, reviewOwner.userId);
  });

  test('replacing owner during an authorized promotion GET fences its late response', () async {
    final api = PromotionApi(),
        access = KnowledgeAccess()..update(reviewOwner, true),
        held = Completer<Json>();
    final repo = ApiKnowledgeRepository(api, access: access);
    addTearDown(repo.dispose);
    api.response = () => held.future;
    final read = repo.readPromotion(promotionId);
    final assertion = expectLater(read, throwsFormatException);
    access.close(notify: false);
    expect(api.authority!.isCurrent(), isFalse);
    held.complete(await promotionResponse(await promotionRow()));
    await assertion;
  });

  for (final phone in [true, false]) {
    testWidgets(
      'promotion review and explicit decision are reachable on ${phone ? '320px at 200% text' : 'Mac workspace'}',
      (tester) async {
        final previousPolicy = WidgetController.hitTestWarningShouldBeFatal;
        WidgetController.hitTestWarningShouldBeFatal = true;
        addTearDown(
          () => WidgetController.hitTestWarningShouldBeFatal = previousPolicy,
        );
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = phone
            ? const Size(320, 800)
            : const Size(1440, 1000);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        final repo = PromotionRepository(await promotionRow())
              ..heldSubmit = Completer<MemoryAcceptance>(),
            store = MemoryKnowledgeRecoveryStore();
        final controller = promotionController(repo, store);
        addTearDown(controller.dispose);
        await controller.reloadRecovery();
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(phone ? 2 : 1)),
              child: child!,
            ),
            home: phone
                ? KnowledgeView(controller: controller)
                : Scaffold(body: MacosKnowledgeView(controller: controller)),
          ),
        );
        await tester.pumpAndSettle();
        final entry = find.text('Promotions');
        await tester.ensureVisible(entry);
        await tester.pumpAndSettle();
        expect(entry.hitTestable(), findsOneWidget);
        await tester.tap(entry);
        await tester.pumpAndSettle();
        Future<void> reach(Finder target) async {
          final list = find
              .descendant(
                of: find.byType(KnowledgePromotions),
                matching: find.byType(Scrollable),
              )
              .first;
          for (
            var count = 0;
            count < 80 && target.evaluate().isEmpty;
            count++
          ) {
            final bounds = tester.getRect(list);
            final before = tester.state<ScrollableState>(list).position.pixels;
            await tester.dragFrom(
              Offset(bounds.left + 8, bounds.center.dy),
              const Offset(0, -240),
            );
            await tester.pumpAndSettle();
            expect(
              tester.state<ScrollableState>(list).position.pixels != before ||
                  target.evaluate().isNotEmpty,
              isTrue,
            );
          }
          expect(target, findsOneWidget);
          await tester.ensureVisible(target);
          await tester.pumpAndSettle();
          expect(target.hitTestable(), findsOneWidget);
        }

        final inspect = find.widgetWithText(
          OutlinedButton,
          'Inspect promotion sources',
        );
        await reach(inspect);
        await tester.tap(inspect);
        await tester.pumpAndSettle();
        expect(repo.reads.single.id, promotionId);
        final content = find.byWidgetPredicate(
          (widget) =>
              widget is SelectableText &&
              widget.data ==
                  'Prepare complete private review notes before each meeting.',
        );
        await reach(content);
        final promote = find.widgetWithText(
          OutlinedButton,
          'Promote to procedural memory',
        );
        await reach(promote);
        await tester.tap(promote);
        await tester.pumpAndSettle();
        final confirm = find.widgetWithText(FilledButton, 'Confirm promotion');
        await reach(confirm);
        await tester.tap(confirm);
        await tester.pumpAndSettle();
        expect(repo.submissions, hasLength(1));
        final sent = repo.submissions.single;
        expect((await store.read(reviewOwner))!['state'], 'pending');
        expect(controller.pendingChange!.key, sent.key);
        await tester.pumpWidget(const SizedBox.shrink());
        repo.heldSubmit!.complete(
          await MemoryAcceptance.parse(
            await promotionResponse(
              await promotionRow(decision: 'promote'),
              acceptance: await promotionAcceptance(sent),
              sent: sent,
            ),
            sent,
          ),
        );
        await tester.pumpAndSettle();
        expect(repo.submissions, hasLength(1));
        expect(tester.takeException(), isNull);
      },
    );
  }
}
