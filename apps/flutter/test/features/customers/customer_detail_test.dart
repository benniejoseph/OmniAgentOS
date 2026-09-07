import 'package:asael/features/customers/customer_detail.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses the governed Customer 360 projection', () {
    final customer = CustomerDetail.fromJson({
      'account': {
        'account': {
          'accountId': 'customer-account:${'a' * 64}',
          'name': 'Acme',
          'lifecycle': 'active',
          'revision': 3,
        },
        'facts': [
          {
            'fact': {
              'factKey': 'renewal.status',
              'value': {'status': 'on_track'},
              'source': {
                'sourceKind': 'salesforce',
                'sourceId': 'opportunity-1',
              },
              'confidenceBasisPoints': 9250,
            },
            'freshness': {'status': 'fresh'},
          },
        ],
      },
    });

    expect(customer.name, 'Acme');
    expect(customer.revision, 3);
    expect(customer.facts.single.summary, 'on_track');
    expect(customer.facts.single.source, 'salesforce · opportunity-1');
    expect(customer.facts.single.confidence, 93);
    expect(customer.facts.single.stale, isFalse);
  });

  test('rejects a projection without an account identity', () {
    expect(
      () => CustomerDetail.fromJson({
        'account': {'account': <String, dynamic>{}},
      }),
      throwsFormatException,
    );
  });
}
