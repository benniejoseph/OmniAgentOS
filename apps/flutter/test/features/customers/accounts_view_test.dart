import 'package:asael/features/customers/accounts_view.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('combines account truth with portfolio intelligence', () {
    final account = CustomerAccountSummary.fromJson(
      {
        'accountId': 'customer-account:${'a' * 64}',
        'name': 'Acme',
        'lifecycle': 'at_risk',
        'owner': {'displayName': 'Bennie'},
      },
      {
        'accountId': 'customer-account:${'a' * 64}',
        'attention': 'urgent',
        'health': {'status': 'at_risk', 'scoreBasisPoints': 6250},
        'counts': {'openRisks': 3, 'pendingApprovals': 1},
      },
    );

    expect(account.name, 'Acme');
    expect(account.owner, 'Bennie');
    expect(account.attention, 'urgent');
    expect(account.score, 6250);
    expect(account.openRisks, 3);
    expect(account.pendingApprovals, 1);
  });
}
