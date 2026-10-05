import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'payment_read_state.dart';

typedef Json = Map<String, dynamic>;

class PaymentsView extends StatefulWidget {
  const PaymentsView({super.key, required this.api, this.authority});
  final ApiClient api;
  final NativeRequestAuthority? authority;

  @override
  State<PaymentsView> createState() => _PaymentsViewState();
}

class _PaymentsViewState extends State<PaymentsView> {
  Future<void>? _loadInFlight;
  final _readiness = PaymentReadState();
  final _reviews = PaymentReadState(collectionKey: 'reviews');
  final _authenticators = PaymentReadState(collectionKey: 'credentials');
  final _transactions = PaymentReadState(collectionKey: 'transactions');
  Json? get readiness => _readiness.value;
  Json? get reviews => _reviews.value;
  Json? get authenticators => _authenticators.value;
  Json? get transactions => _transactions.value;
  bool loading = true;

  Future<Json> _read(String path) => widget.authority == null
      ? widget.api.getJsonFresh(path)
      : widget.api.getJsonAuthorized(path, authority: widget.authority!);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() {
    final inFlight = _loadInFlight;
    if (inFlight != null) return inFlight;
    final operation = _performLoad();
    _loadInFlight = operation;
    return operation.whenComplete(() {
      if (identical(_loadInFlight, operation)) _loadInFlight = null;
    });
  }

  Future<void> _loadSource(String path, PaymentReadState source) async {
    try {
      final value = await _read(path);
      if (!mounted) return;
      setState(() => source.complete(value));
    } catch (error) {
      if (mounted) setState(() => source.fail(error));
    }
  }

  Future<void> _performLoad() async {
    setState(() {
      loading = true;
      for (final source in [
        _readiness,
        _reviews,
        _authenticators,
        _transactions,
      ]) {
        source.begin();
      }
    });
    await Future.wait([
      _loadSource(NativePaths.paymentsReadiness, _readiness),
      _loadSource(NativePaths.paymentsReviews, _reviews),
    ]);
    if (!mounted) return;
    await Future.wait([
      _loadSource(NativePaths.paymentsAuthenticators, _authenticators),
      _loadSource(NativePaths.paymentsTransactions, _transactions),
    ]);
    if (mounted) setState(() => loading = false);
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
                      const NativeWorkspaceBrowserButton(
                        path: '/app/payments',
                        label: 'Review and manage signers in browser',
                      ),
                      const SizedBox(height: 14),
                      _BoundaryNotice(
                        trustPolicy: trustPolicy,
                        readiness: readiness,
                      ),
                      if (_readiness.error != null)
                        _sourceNotice('Payment readiness', _readiness),
                      _section(
                        'Mandates awaiting review',
                        _reviews,
                        reviewItems.length,
                        empty: 'No purchase mandate is awaiting your review.',
                        children: [
                          for (final value in reviewItems)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 9),
                              child: _ReviewCard(review: Json.from(value)),
                            ),
                        ],
                      ),
                      _section(
                        'Hardware-backed signers',
                        _authenticators,
                        credentials
                            .where((item) => item['state'] == 'active')
                            .length,
                        empty: 'No payment signer is registered.',
                        children: [
                          if (credentials.isNotEmpty)
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
                        ],
                        isEmpty: credentials.isEmpty,
                      ),
                      _section(
                        'Payment evidence',
                        _transactions,
                        transactionItems.length,
                        empty: 'No reconciled payment lifecycle is recorded.',
                        children: [
                          if (transactionItems.isNotEmpty)
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
                      ),
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

  Widget _sourceNotice(String title, PaymentReadState source) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: _ErrorNotice(
      message: source.value == null
          ? '$title could not be loaded.'
          : '$title could not refresh. Showing the last available result.',
      retry: loading ? null : _load,
    ),
  );

  Widget _section(
    String title,
    PaymentReadState source,
    int count, {
    required String empty,
    required List<Widget> children,
    bool? isEmpty,
  }) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const SizedBox(height: 22),
      _SectionHeading(title: title, count: source.current ? count : null),
      const SizedBox(height: 8),
      if (source.error != null) _sourceNotice(title, source),
      if (source.loading) const LinearProgressIndicator(),
      if (source.value != null)
        if (isEmpty ?? count == 0)
          _Empty(
            message: source.current
                ? empty
                : 'The last available result contained no entries.',
          )
        else
          ...children,
    ],
  );
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
                        ? 'The trusted payment boundary is available. Native signing will appear only after this platform has an enrolled hardware-backed attestation policy.'
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
                  'Authorization requires a human-present hardware signature. Native clients keep this review read-only until a platform signer and its attestation policy are enrolled.',
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
  final int? count;
  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(title, style: Theme.of(context).textTheme.titleLarge),
      ),
      Text(
        count?.toString() ?? '—',
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
  Widget build(BuildContext context) => SizedBox(
    width: double.infinity,
    child: Material(
      color: Theme.of(context).colorScheme.surfaceContainerLowest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: child,
    ),
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
  const _ErrorNotice({required this.message, required this.retry});
  final String message;
  final VoidCallback? retry;
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.errorContainer,
    borderRadius: BorderRadius.circular(10),
    child: ListTile(
      leading: const Icon(Icons.warning_amber_rounded),
      title: Text(message),
      trailing: IconButton(
        tooltip: 'Retry payment reads',
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
