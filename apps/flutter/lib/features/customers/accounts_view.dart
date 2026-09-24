import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

class CustomerAccountSummary {
  const CustomerAccountSummary({
    required this.id,
    required this.name,
    required this.lifecycle,
    required this.owner,
    required this.attention,
    required this.health,
    required this.score,
    required this.openRisks,
    required this.pendingApprovals,
  });

  factory CustomerAccountSummary.fromJson(Json account, Json? intelligence) {
    final id =
        account['accountId']?.toString() ??
        intelligence?['accountId']?.toString() ??
        '';
    final health = _map(intelligence?['health']);
    final counts = _map(intelligence?['counts']);
    return CustomerAccountSummary(
      id: id,
      name:
          account['name']?.toString() ??
          intelligence?['name']?.toString() ??
          'Customer account',
      lifecycle:
          account['lifecycle']?.toString() ??
          intelligence?['lifecycle']?.toString() ??
          'unknown',
      owner:
          _map(account['owner'])['displayName']?.toString() ??
          intelligence?['ownerName']?.toString() ??
          'Unassigned',
      attention: intelligence?['attention']?.toString() ?? 'unknown',
      health: health['status']?.toString() ?? 'unknown',
      score: (health['scoreBasisPoints'] as num?)?.toInt(),
      openRisks: (counts['openRisks'] as num?)?.toInt() ?? 0,
      pendingApprovals: (counts['pendingApprovals'] as num?)?.toInt() ?? 0,
    );
  }

  final String id, name, lifecycle, owner, attention, health;
  final int? score;
  final int openRisks, pendingApprovals;
}

List<CustomerAccountSummary> customerAccountSummariesFromResponses(
  Json accountsResponse, [
  Json? portfolioResponse,
]) {
  final portfolio = _map(portfolioResponse?['portfolio']);
  final intelligence = <String, Json>{
    for (final value
        in (portfolio['accounts'] as List? ?? const []).whereType<Map>())
      if (value['accountId'] != null)
        value['accountId'].toString(): Json.from(value),
  };
  return (accountsResponse['accounts'] as List? ?? const [])
      .whereType<Map>()
      .map((value) {
        final account = Json.from(value);
        return CustomerAccountSummary.fromJson(
          account,
          intelligence[account['accountId']?.toString()],
        );
      })
      .where((value) => value.id.isNotEmpty)
      .toList(growable: false);
}

List<CustomerAccountSummary> mergeCustomerAccountCoreWithCachedIntelligence(
  List<CustomerAccountSummary> primary,
  List<CustomerAccountSummary> cached,
) {
  final cachedById = {for (final account in cached) account.id: account};
  return primary
      .map((account) {
        final previous = cachedById[account.id];
        if (previous == null) return account;
        return CustomerAccountSummary(
          id: account.id,
          name: account.name,
          lifecycle: account.lifecycle,
          owner: account.owner,
          attention: previous.attention,
          health: previous.health,
          score: previous.score,
          openRisks: previous.openRisks,
          pendingApprovals: previous.pendingApprovals,
        );
      })
      .toList(growable: false);
}

class AccountsView extends StatefulWidget {
  const AccountsView({super.key, required this.api, required this.onOpen});

  final ApiClient api;
  final ValueChanged<CustomerAccountSummary> onOpen;

  @override
  State<AccountsView> createState() => _AccountsViewState();
}

class _AccountsViewState extends State<AccountsView> {
  Future<void>? _loadInFlight;
  List<CustomerAccountSummary> accounts = const [];
  Object? error;
  bool loading = true;
  String filter = 'all';

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

  Future<void> _performLoad() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final accountResponse = await widget.api.getJson(
        NativePaths.customersList,
        query: {'limit': 200},
      );
      if (!mounted) return;
      final primary = customerAccountSummariesFromResponses(accountResponse);
      setState(() {
        accounts = mergeCustomerAccountCoreWithCachedIntelligence(
          primary,
          accounts,
        );
      });
      final portfolioResponse = await widget.api.getJson(
        NativePaths.customersPortfolio,
        query: {'limit': 200},
      );
      if (!mounted) return;
      setState(() {
        accounts = customerAccountSummariesFromResponses(
          accountResponse,
          portfolioResponse,
        );
      });
    } catch (value) {
      if (mounted) setState(() => error = value);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final visible = filter == 'all'
        ? accounts
        : accounts
              .where(
                (account) => filter == 'attention'
                    ? const {'urgent', 'attention'}.contains(account.attention)
                    : account.lifecycle == filter,
              )
              .toList();
    final atRisk = accounts
        .where((account) => account.lifecycle == 'at_risk')
        .length;
    final approvals = accounts.fold<int>(
      0,
      (total, account) => total + account.pendingApprovals,
    );
    return RefreshIndicator(
      onRefresh: _load,
      child: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 22, 16, 8),
            sliver: SliverToBoxAdapter(
              child: Align(
                alignment: Alignment.topLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1180),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'CUSTOMER 360',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.primary,
                          letterSpacing: 1.5,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 7),
                      Text(
                        'Accounts',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Health, risks, commitments, and evidence from the same workspace projection as web.',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 18),
                      Wrap(
                        spacing: 10,
                        runSpacing: 10,
                        children: [
                          _Metric(
                            value: '${accounts.length}',
                            label: 'Accounts',
                          ),
                          _Metric(value: '$atRisk', label: 'At risk'),
                          _Metric(value: '$approvals', label: 'Approvals'),
                        ],
                      ),
                      const SizedBox(height: 14),
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: SegmentedButton<String>(
                          segments: const [
                            ButtonSegment(value: 'all', label: Text('All')),
                            ButtonSegment(
                              value: 'attention',
                              label: Text('Needs attention'),
                            ),
                            ButtonSegment(
                              value: 'active',
                              label: Text('Active'),
                            ),
                            ButtonSegment(
                              value: 'at_risk',
                              label: Text('At risk'),
                            ),
                          ],
                          selected: {filter},
                          onSelectionChanged: (value) =>
                              setState(() => filter = value.first),
                        ),
                      ),
                      if (error != null) ...[
                        const SizedBox(height: 12),
                        _ErrorNotice(error: error!, retry: _load),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (loading && accounts.isEmpty)
            const SliverFillRemaining(
              child: Center(child: CircularProgressIndicator()),
            )
          else if (visible.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Text(
                  error == null
                      ? 'No accounts match this view.'
                      : 'Account data is unavailable.',
                ),
              ),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
              sliver: SliverList.separated(
                itemCount: visible.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) => _AccountRow(
                  account: visible[index],
                  onTap: () => widget.onOpen(visible[index]),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AccountRow extends StatelessWidget {
  const _AccountRow({required this.account, required this.onTap});
  final CustomerAccountSummary account;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final attention = const {'urgent', 'attention'}.contains(account.attention);
    return Material(
      color: scheme.surfaceContainerLowest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: attention
              ? scheme.error.withValues(alpha: .35)
              : scheme.outlineVariant,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(15),
          child: Row(
            children: [
              CircleAvatar(
                backgroundColor: attention
                    ? scheme.errorContainer
                    : scheme.primaryContainer,
                child: Icon(
                  attention
                      ? Icons.priority_high_rounded
                      : Icons.business_rounded,
                  color: attention ? scheme.onErrorContainer : scheme.primary,
                ),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      account.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${_humanize(account.lifecycle)} · ${_humanize(account.health)} · ${account.owner}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                    if (account.openRisks > 0 ||
                        account.pendingApprovals > 0) ...[
                      const SizedBox(height: 5),
                      Text(
                        '${account.openRisks} open risk${account.openRisks == 1 ? '' : 's'} · ${account.pendingApprovals} pending approval${account.pendingApprovals == 1 ? '' : 's'}',
                        style: TextStyle(
                          color: attention
                              ? scheme.error
                              : scheme.onSurfaceVariant,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (account.score != null)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Text(
                    '${(account.score! / 100).round()}%',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
              const Icon(Icons.chevron_right_rounded),
            ],
          ),
        ),
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.value, required this.label});
  final String value, label;
  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 108),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
    decoration: BoxDecoration(
      border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(value, style: Theme.of(context).textTheme.titleLarge),
        Text(
          label,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 12,
          ),
        ),
      ],
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
      leading: const Icon(Icons.cloud_off_rounded),
      title: const Text('Accounts could not refresh'),
      subtitle: Text(
        error.toString(),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
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
