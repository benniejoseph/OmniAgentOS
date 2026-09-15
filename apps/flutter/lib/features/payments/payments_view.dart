import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

class PaymentsView extends StatefulWidget {
  const PaymentsView({super.key, required this.api});
  final ApiClient api;

  @override
  State<PaymentsView> createState() => _PaymentsViewState();
}

class _PaymentsViewState extends State<PaymentsView> {
  Json? readiness, reviews, authenticators, transactions;
  Object? error;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final values = await Future.wait([
        widget.api.getJson(NativePaths.paymentsReadiness),
        widget.api.getJson(NativePaths.paymentsReviews),
        widget.api.getJson(NativePaths.paymentsAuthenticators),
        widget.api.getJson(NativePaths.paymentsTransactions),
      ]);
      readiness = values[0];
      reviews = values[1];
      authenticators = values[2];
      transactions = values[3];
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reviewItems = (reviews?['reviews'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final credentials = (authenticators?['credentials'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final transactionItems =
        (transactions?['transactions'] as List? ?? const [])
            .whereType<Map>()
            .toList();
    final trustPolicy = reviews?['trustPolicy'] is Map;
    return RefreshIndicator(
      onRefresh: _load,
      child: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 22, 16, 44),
            sliver: SliverToBoxAdapter(
              child: Align(
                alignment: Alignment.topLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1120),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'TRUSTED SURFACE',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.primary,
                          letterSpacing: 1.5,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 7),
                      Text(
                        'Payment mandates',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Inspect exact purchase terms, hardware signers, and evidence-derived payment state. Signing alone never submits a payment.',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 14),
                      _BoundaryNotice(
                        trustPolicy: trustPolicy,
                        readiness: readiness,
                      ),
                      if (error != null) ...[
                        const SizedBox(height: 10),
                        _ErrorNotice(error: error!, retry: _load),
                      ],
                      if (loading && reviews == null)
                        const Padding(
                          padding: EdgeInsets.all(48),
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else ...[
                        const SizedBox(height: 22),
                        _SectionHeading(
                          title: 'Mandates awaiting review',
                          count: reviewItems.length,
                        ),
                        const SizedBox(height: 8),
                        if (reviewItems.isEmpty)
                          const _Empty(
                            message:
                                'No purchase mandate is awaiting your review.',
                          )
                        else
                          for (final value in reviewItems)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 9),
                              child: _ReviewCard(review: Json.from(value)),
                            ),
                        const SizedBox(height: 22),
                        _SectionHeading(
                          title: 'Hardware-backed signers',
                          count: credentials
                              .where((item) => item['state'] == 'active')
                              .length,
                        ),
                        const SizedBox(height: 8),
                        if (credentials.isEmpty)
                          const _Empty(
                            message: 'No payment signer is registered.',
                          )
                        else
                          _Surface(
                            child: Column(
                              children: [
                                for (
                                  var index = 0;
                                  index < credentials.length;
                                  index++
                                ) ...[
                                  _CredentialRow(
                                    value: Json.from(credentials[index]),
                                  ),
                                  if (index != credentials.length - 1)
                                    const Divider(height: 1),
                                ],
                              ],
                            ),
                          ),
                        const SizedBox(height: 22),
                        _SectionHeading(
                          title: 'Payment evidence',
                          count: transactionItems.length,
                        ),
                        const SizedBox(height: 8),
                        if (transactionItems.isEmpty)
                          const _Empty(
                            message:
                                'No reconciled payment lifecycle is recorded.',
                          )
                        else
                          _Surface(
                            child: Column(
                              children: [
                                for (
                                  var index = 0;
                                  index < transactionItems.length;
                                  index++
                                ) ...[
                                  _TransactionRow(
                                    value: Json.from(transactionItems[index]),
                                  ),
                                  if (index != transactionItems.length - 1)
                                    const Divider(height: 1),
                                ],
                              ],
                            ),
                          ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BoundaryNotice extends StatelessWidget {
  const _BoundaryNotice({required this.trustPolicy, required this.readiness});
  final bool trustPolicy;
  final Json? readiness;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.tertiaryContainer
          .withValues(alpha: .55),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(
        color: Theme.of(context).colorScheme.tertiary.withValues(alpha: .25),
      ),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          trustPolicy ? Icons.verified_user_outlined : Icons.gpp_maybe_outlined,
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                trustPolicy
                    ? 'Reviewed signer policy loaded'
                    : 'Signing remains fail-closed',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 3),
              Text(
                readiness?['summary']?.toString() ??
                    (trustPolicy
                        ? 'The trusted payment boundary is available. Native signing will appear only when Android hardware-key attestation is enrolled.'
                        : 'No reviewed attestation trust policy is available. Asael cannot authorize or submit a payment.'),
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.review});
  final Json review;
  @override
  Widget build(BuildContext context) {
    final terms = _map(review['terms']),
        merchant = _map(terms['merchant']),
        totals = _map(terms['totals']);
    final items = (terms['items'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    return _Surface(
      child: ExpansionTile(
        leading: const Icon(Icons.receipt_long_outlined),
        title: Text(merchant['name']?.toString() ?? 'Purchase review'),
        subtitle: Text(
          '${_money(totals['totalAmountMinor'], totals['currency'])} · ${_humanize(review['state']?.toString() ?? 'pending')}',
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final item in items)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${item['quantity'] ?? 1} × ${item['title'] ?? 'Item'}',
                          ),
                        ),
                        Text(
                          _money(item['totalAmountMinor'], totals['currency']),
                        ),
                      ],
                    ),
                  ),
                const Divider(),
                Text(
                  'Exact terms digest',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 3),
                SelectableText(
                  review['exactTermsSha256']?.toString() ?? 'Unavailable',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                ),
                const SizedBox(height: 10),
                const Text(
                  'Authorization requires a human-present hardware signature. The mobile app keeps this review read-only until native Android signer attestation is enrolled.',
                  style: TextStyle(fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CredentialRow extends StatelessWidget {
  const _CredentialRow({required this.value});
  final Json value;
  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(
      value['state'] == 'active' ? Icons.key_rounded : Icons.key_off_rounded,
    ),
    title: Text(
      '${value['attestationFormat'] ?? 'Signer'} · ${_humanize(value['state']?.toString() ?? 'unknown')}',
    ),
    subtitle: Text(
      'AAGUID ${value['aaguid'] ?? 'unavailable'}',
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    ),
    trailing: Text(
      _short(value['credentialId']?.toString()),
      style: const TextStyle(fontFamily: 'monospace', fontSize: 10),
    ),
  );
}

class _TransactionRow extends StatelessWidget {
  const _TransactionRow({required this.value});
  final Json value;
  @override
  Widget build(BuildContext context) => ListTile(
    leading: const Icon(Icons.account_balance_wallet_outlined),
    title: Text(
      _humanize(
        value['state']?.toString() ?? value['status']?.toString() ?? 'recorded',
      ),
    ),
    subtitle: Text(
      value['merchantName']?.toString() ??
          value['transactionId']?.toString() ??
          'Evidence-derived transaction',
    ),
    trailing: value['totalAmountMinor'] == null
        ? null
        : Text(_money(value['totalAmountMinor'], value['currency'])),
  );
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({required this.title, required this.count});
  final String title;
  final int count;
  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(title, style: Theme.of(context).textTheme.titleLarge),
      ),
      Text(
        '$count',
        style: TextStyle(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
          fontWeight: FontWeight.w700,
        ),
      ),
    ],
  );
}

class _Surface extends StatelessWidget {
  const _Surface({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLowest,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
    ),
    clipBehavior: Clip.antiAlias,
    child: child,
  );
}

class _Empty extends StatelessWidget {
  const _Empty({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => _Surface(
    child: Padding(
      padding: const EdgeInsets.all(22),
      child: Row(
        children: [
          Icon(
            Icons.inbox_outlined,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(message)),
        ],
      ),
    ),
  );
}

class _ErrorNotice extends StatelessWidget {
  const _ErrorNotice({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.errorContainer,
    borderRadius: BorderRadius.circular(10),
    child: ListTile(
      leading: const Icon(Icons.warning_amber_rounded),
      title: const Text('Payment evidence could not refresh'),
      subtitle: Text(error.toString(), maxLines: 2),
      trailing: IconButton(
        onPressed: retry,
        icon: const Icon(Icons.refresh_rounded),
      ),
    ),
  );
}

Json _map(Object? value) =>
    value is Map ? Json.from(value) : <String, dynamic>{};
String _humanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
String _short(String? value) => value == null || value.isEmpty
    ? '—'
    : value.length <= 12
    ? value
    : '${value.substring(0, 6)}…${value.substring(value.length - 4)}';
String _money(Object? minor, Object? currency) {
  final amount = (minor as num?)?.toInt();
  if (amount == null) return 'Amount unavailable';
  return '${currency ?? ''} ${(amount / 100).toStringAsFixed(2)}'.trim();
}
