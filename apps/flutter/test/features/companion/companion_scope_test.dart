import 'dart:async';

import 'package:asael/features/companion/companion_models.dart';
import 'package:asael/features/companion/companion_providers.dart';
import 'package:asael/features/companion/companion_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';
import 'package:flutter_test/flutter_test.dart';

import 'companion_fixtures.dart';

void main() {
  test('deployment, tenant, actor and role replacement dispose all old editor state', () async {
    const original = (
      deployment: 'https://a.invalid',
      tenantId: 'tenant',
      actorId: 'actor',
      role: 'viewer',
    );
    for (final replacement in <CompanionScope>[
      (
        deployment: 'https://b.invalid',
        tenantId: 'tenant',
        actorId: 'actor',
        role: 'viewer',
      ),
      (
        deployment: 'https://a.invalid',
        tenantId: 'other',
        actorId: 'actor',
        role: 'viewer',
      ),
      (
        deployment: 'https://a.invalid',
        tenantId: 'tenant',
        actorId: 'other',
        role: 'viewer',
      ),
      (
        deployment: 'https://a.invalid',
        tenantId: 'tenant',
        actorId: 'actor',
        role: 'admin',
      ),
    ]) {
      final source = StateProvider<CompanionScope?>((_) => original);
      final oldRepository = FakeCompanionRepository()
        ..heldSave = Completer<CompanionResponse>();
      final newRepository = FakeCompanionRepository();
      final container = ProviderContainer(
        overrides: [
          companionScopeProvider.overrideWith((ref) => ref.watch(source)),
          companionRepositoryProvider.overrideWith(
            (ref) => ref.watch(companionScopeProvider) == original
                ? oldRepository
                : newRepository,
          ),
        ],
      );
      final old = container.read(companionControllerProvider);
      await old.refresh();
      old.edit(const CompanionPreferences(intensity: 'quiet'));
      final write = old.save();
      final submitted = oldRepository.submissions.single;
      container.read(source.notifier).state = replacement;
      final current = container.read(companionControllerProvider);
      await current.refresh();
      expect(current, isNot(same(old)));
      expect(old.disposed, true);
      oldRepository.heldSave!.complete(
        CompanionResponse.fromJson(
          companionFixture(
            revision: 1,
            preferences: submitted.submitted,
            submission: submitted,
          ),
          submission: submitted,
        ),
      );
      await write;
      expect(current.draft, const CompanionPreferences());
      expect(current.receipt, isNull);
      container.dispose();
    }
  });
}
