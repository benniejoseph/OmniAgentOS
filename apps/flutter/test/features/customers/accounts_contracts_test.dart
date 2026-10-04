import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  test('receipt canonical numbers match the server decimal and exponent boundaries', () {
    expect(
      accountCanonical([
        0.0,
        -0.0,
        1.0,
        0.000001,
        0.0000001,
        1e20,
        1e21,
        -1e-7,
      ]),
      '[0,0,1,0.000001,1e-7,100000000000000000000,1e+21,-1e-7]',
    );
  });
  test(
    'exact shared account owner stays distinct from the authenticated reader',
    () async {
      final value = await AccountsSnapshot.parse(
        await accountListResponse(),
        accountOwner(),
      );
      expect(value.accounts.single.owner, 'Other workspace member');
      expect(
        value.accounts.single.raw['ownerActorId'],
        'actor:$accountOtherUser',
      );
      expect(
        () => value.accounts.single.raw['name'] = 'overwrite',
        throwsUnsupportedError,
      );
    },
  );
  test('same-email recreated user changes local visibility identity', () {
    final current = AccountsOwner.fromSession(accountSession(), accountApi)!;
    final recreated = AccountsOwner.fromSession(
      accountSession(user: accountOtherUser),
      accountApi,
    )!;
    expect(current.key, isNot(recreated.key));
    expect(
      AccountsOwner.fromSession(accountSession(user: 'invalid'), accountApi),
      isNull,
    );
    expect(
      AccountsOwner.fromSession(accountSession(role: 'owner'), accountApi),
      isNull,
    );
  });
  test(
    'rejects wrong exact account and forged request actor/role receipts',
    () async {
      final body = await accountDetailResponse();
      await expectLater(
        CustomerDetail.parse(body, accountOwner(), otherCustomerId),
        throwsFormatException,
      );
      await expectLater(
        CustomerDetail.parse(body, accountOwner(role: 'admin'), customerId),
        throwsFormatException,
      );
      await expectLater(
        CustomerDetail.parse(
          body,
          accountOwner(),
          customerId,
          workspaceId: 'workspace:foreign',
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'retains full distinct fact identities when semantic keys collide',
    () async {
      final detail = await CustomerDetail.parse(
        await accountDetailResponse(conflicts: true),
        accountOwner(),
        customerId,
      );
      expect(detail.facts.map((row) => row.key).toSet(), hasLength(1));
      expect(detail.facts.map((row) => row.id).toSet(), hasLength(2));
      expect(detail.facts.first.conflictingIds, [detail.facts.last.id]);
      expect(detail.conflictCount, 2);
      expect(detail.facts.first.source['sourceRevisionSha256'], 'b' * 64);
    },
  );
  test(
    'rejects malformed facts, nested extras and substituted immutable evidence',
    () async {
      final body = await accountDetailResponse();
      (body['account'] as Map)['factsByKind']['risk'] = [];
      await expectLater(
        CustomerDetail.parse(body, accountOwner(), customerId),
        throwsFormatException,
      );
      final extra = await accountListResponse();
      (extra['context'] as Map)['untrusted'] = true;
      await expectLater(
        AccountsSnapshot.parse(extra, accountOwner()),
        throwsFormatException,
      );
      final substituted = await accountListResponse();
      (substituted['accounts'] as List).first['name'] = 'Other account';
      await expectLater(
        AccountsSnapshot.parse(substituted, accountOwner()),
        throwsFormatException,
      );
    },
  );
  test(
    'bounds rows and rejects duplicate exact accounts before display',
    () async {
      final body = await accountListResponse(),
          row = (await accountListResponse())['accounts'][0];
      body['accounts'] = List.generate(201, (_) => row);
      await expectLater(
        AccountsSnapshot.parse(body, accountOwner()),
        throwsFormatException,
      );
      body['accounts'] = [row, row];
      await expectLater(
        AccountsSnapshot.parse(body, accountOwner()),
        throwsFormatException,
      );
    },
  );
  test('unknown health remains nullable and exact revision changes prevent merging', () async {
    final list = await AccountsSnapshot.parse(
      await accountListResponse(),
      accountOwner(),
    );
    final current = await AccountsPortfolio.parse(
      await accountPortfolioResponse(),
      accountOwner(),
    );
    expect(
      current.forAccount(list.accounts.single)!.health['scoreBasisPoints'],
      isNull,
    );
    expect(
      current.forAccount(list.accounts.single)!.health['status'],
      'unknown',
    );
    final newer = await AccountsPortfolio.parse(
      await accountPortfolioResponse(revision: 2),
      accountOwner(),
    );
    expect(newer.forAccount(list.accounts.single), isNull);
  });
  test(
    'canonical timestamps reject calendar rollover and noncanonical offsets',
    () {
      for (final value in [
        '2026-02-30T10:00:00.000Z',
        '2026-10-04T24:00:00.000Z',
        '2026-10-04T10:00:00Z',
        '2026-10-04T10:00:00.000+00:00',
      ]) {
        expect(() => accountDate(value), throwsFormatException);
      }
      expect(accountDate(accountStamp), accountStamp);
    },
  );
}
