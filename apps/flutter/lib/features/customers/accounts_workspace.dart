import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import 'accounts_contracts.dart';
import 'accounts_controller.dart';
import 'accounts_providers.dart';
import 'accounts_action_widgets.dart';
import 'accounts_advanced_panels.dart';

// Expansion stores a bool; scrolling stores a double. Every persisted widget
// has a distinct identity and is fenced by the exact controller/owner/account.
PageStorageKey<Object> accountsStorageKey(
  AccountsController controller,
  String identity,
) => PageStorageKey<Object>((
  controller,
  controller.repository.access.owner?.key,
  controller.accountId,
  identity,
));

/// All private reads originate from the current session/API provider. The
/// optional legacy API argument only fences old router adapters during handoff.
class NativeAccountsView extends ConsumerStatefulWidget {
  const NativeAccountsView({
    super.key,
    this.accountId,
    this.expectedApi,
    this.onOpen,
    this.active = true,
  });
  final String? accountId;
  final ApiClient? expectedApi;
  final ValueChanged<CustomerAccountSummary>? onOpen;
  final bool active;
  @override
  ConsumerState<NativeAccountsView> createState() => _NativeAccountsViewState();
}

class _NativeAccountsViewState extends ConsumerState<NativeAccountsView>
    with WidgetsBindingObserver {
  bool _resumed = true;
  AccountsController? _controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _resumed =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _resumed = state == AppLifecycleState.resumed;
    if (!_resumed) {
      _controller?.setActive(false);
    }
    if (mounted) {
      setState(() {});
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.setActive(false, notify: false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(accountsControllerProvider(widget.accountId));
    if (!identical(_controller, controller)) {
      _controller?.setActive(false, notify: false);
      _controller = controller;
    }
    final active =
        widget.active &&
        _resumed &&
        TickerMode.valuesOf(context).enabled &&
        (ModalRoute.of(context)?.isCurrent ?? true) &&
        (widget.expectedApi == null ||
            identical(widget.expectedApi, ref.watch(apiClientProvider)));
    controller.setActive(active, notify: false);
    if (active && controller.readable) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            identical(_controller, controller) &&
            controller.readable) {
          controller.initialize();
        }
      });
    }
    return AccountsWorkspace(
      key: ValueKey((
        controller,
        controller.repository.access.owner?.key,
        widget.accountId,
      )),
      controller: controller,
      onOpen: widget.onOpen,
    );
  }
}

class AccountsWorkspace extends StatefulWidget {
  const AccountsWorkspace({super.key, required this.controller, this.onOpen});
  final AccountsController controller;
  final ValueChanged<CustomerAccountSummary>? onOpen;
  @override
  State<AccountsWorkspace> createState() => _AccountsWorkspaceState();
}

class _AccountsWorkspaceState extends State<AccountsWorkspace> {
  final _search = TextEditingController(),
      _searchFocus = FocusNode(debugLabel: 'Search returned customer records');
  String _filter = 'all', _kind = 'all';
  String? _selectedFactId;
  int _visible = 50;
  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant AccountsWorkspace old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, widget.controller)) {
      _search.clear();
      _selectedFactId = null;
      _visible = 50;
      _filter = 'all';
      _kind = 'all';
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      if (!controller.readable) {
        return const Scaffold(
          body: Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'Customer records are hidden. An active view and verified current session are required.',
              ),
            ),
          ),
        );
      }
      final detail = controller.detail.value,
          overview = controller.overview.value,
          selected = controller.accountId != null;
      final query = _search.text.trim().toLowerCase();
      final accounts = (overview?.accounts ?? const <CustomerAccountSummary>[])
          .where(
            (row) =>
                (_filter == 'all' || row.lifecycle == _filter) &&
                [
                  row.name,
                  row.id,
                  row.owner,
                ].any((value) => value.toLowerCase().contains(query)),
          )
          .toList();
      final facts = (detail?.facts ?? const <CustomerFact>[])
          .where(
            (row) =>
                (_kind == 'all' || row.kind == _kind) &&
                [
                  row.key,
                  row.id,
                  row.summary,
                  row.source['sourceLabel'] as String,
                ].any((value) => value.toLowerCase().contains(query)),
          )
          .toList();
      CustomerFact? focused;
      for (final row in detail?.facts ?? const <CustomerFact>[]) {
        if (row.id == _selectedFactId) {
          focused = row;
        }
      }
      final selectedFact = focused;
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
              _searchFocus.requestFocus,
          const SingleActivator(LogicalKeyboardKey.keyF, control: true):
              _searchFocus.requestFocus,
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true): () {
            controller.refresh();
          },
        },
        child: Focus(
          autofocus: true,
          child: Scaffold(
            appBar: AppBar(
              title: Text(selected ? 'Customer account' : 'Customer Accounts'),
              actions: [
                IconButton(
                  tooltip: 'Refresh customer sources',
                  onPressed: controller.busy ? null : controller.refresh,
                  icon: const Icon(Icons.refresh),
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                ),
              ],
            ),
            body: RefreshIndicator(
              onRefresh: controller.refresh,
              child: ListView(
                key: accountsStorageKey(controller, 'scroll'),
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 36),
                children: [
                  Text(
                    selected
                        ? detail?.name ?? 'Exact customer account'
                        : 'Customer portfolio',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Customer relationship records. Connection and login accounts are separate. Recommendations do not authorize actions.',
                  ),
                  if (selected) _Value('Exact account', controller.accountId),
                  _ReadStatus(
                    label: selected ? 'Account evidence' : 'Account list',
                    source: selected ? controller.detail : controller.overview,
                    refresh: controller.refreshCore,
                  ),
                  _ReadStatus(
                    label: 'Portfolio intelligence',
                    source: controller.intelligence,
                    refresh: controller.refreshIntelligence,
                  ),
                  Text(
                    'Up to 200 accounts per source. No continuation or whole-workspace completeness is supplied by this API. ${controller.workspaceId == null ? 'Workspace not yet verified.' : 'Workspace: ${controller.workspaceId}'}',
                  ),
                  const SizedBox(height: 14),
                  AccountActionsPanel(controller: controller),
                  AccountsAdvancedPanels(controller: controller),
                  const SizedBox(height: 14),
                  TextField(
                    key: const Key('customer-record-search'),
                    controller: _search,
                    focusNode: _searchFocus,
                    decoration: InputDecoration(
                      labelText: selected
                          ? 'Search returned facts'
                          : 'Search returned accounts',
                      prefixIcon: const Icon(Icons.search),
                      border: const OutlineInputBorder(),
                    ),
                    onChanged: (_) => setState(() => _visible = 50),
                  ),
                  const SizedBox(height: 12),
                  if (!selected) ...[
                    DropdownButtonFormField<String>(
                      initialValue: _filter,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        labelText: 'Lifecycle',
                        border: OutlineInputBorder(),
                      ),
                      items: [
                        for (final value in ['all', ...accountLifecycles])
                          DropdownMenuItem(
                            value: value,
                            child: Text(_label(value)),
                          ),
                      ],
                      onChanged: (value) => setState(() {
                        _filter = value!;
                        _visible = 50;
                      }),
                    ),
                    const SizedBox(height: 12),
                    if (overview != null && accounts.isEmpty)
                      const Text(
                        'No matching customer accounts in this returned snapshot.',
                      ),
                    for (final account in accounts.take(_visible))
                      _AccountCard(
                        controller: controller,
                        account: account,
                        intelligence: controller.intelligenceFor(account),
                        stale:
                            controller.intelligence.state !=
                            AccountReadState.current,
                        onOpen: widget.onOpen == null
                            ? null
                            : () {
                                if (controller.readable) {
                                  widget.onOpen!(account);
                                }
                              },
                      ),
                    if (accounts.length > _visible)
                      _More(
                        onPressed: () => setState(() => _visible += 50),
                        remaining: accounts.length - _visible,
                      ),
                    if (overview != null)
                      _Receipt(
                        controller: controller,
                        receipt: overview.receipt,
                      ),
                  ] else if (detail != null) ...[
                    _AccountCard(
                      controller: controller,
                      account: detail.account,
                      intelligence: controller.intelligenceFor(detail.account),
                      stale:
                          controller.intelligence.state !=
                          AccountReadState.current,
                    ),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        Chip(
                          label: Text('${detail.facts.length} current facts'),
                        ),
                        Chip(
                          label: Text(
                            '${detail.conflictCount} conflicting facts',
                          ),
                        ),
                        Chip(label: Text('${detail.staleCount} stale facts')),
                      ],
                    ),
                    Text(
                      '${detail.historyCount} recorded revisions reported by the server. Historical revision contents are not available through this read. Evaluated ${detail.evaluatedAt}.',
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _kind,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        labelText: 'Fact kind',
                        border: OutlineInputBorder(),
                      ),
                      items: [
                        for (final value in ['all', ...accountKinds])
                          DropdownMenuItem(
                            value: value,
                            child: Text(_label(value)),
                          ),
                      ],
                      onChanged: (value) => setState(() {
                        _kind = value!;
                        _visible = 50;
                      }),
                    ),
                    const SizedBox(height: 12),
                    if (facts.isEmpty)
                      const Text(
                        'No matching current facts in this account projection.',
                      ),
                    if (_selectedFactId != null && selectedFact == null)
                      const Text(
                        'The previously selected exact fact is no longer present. Select another fact explicitly.',
                      ),
                    if (selectedFact != null)
                      _FactInspector(
                        key: ValueKey(selectedFact.revisionId),
                        fact: selectedFact,
                        onClose: () => setState(() => _selectedFactId = null),
                      ),
                    for (final fact in facts.take(_visible))
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                fact.key,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              Text(fact.summary),
                              Text(
                                '${_label(fact.kind)} · ${_label(fact.freshness)}${fact.conflictingIds.isEmpty ? '' : ' · Conflicting evidence'}',
                              ),
                              SelectableText(fact.id),
                              TextButton.icon(
                                onPressed: () =>
                                    setState(() => _selectedFactId = fact.id),
                                icon: const Icon(Icons.fact_check_outlined),
                                label: const Text('Inspect exact fact'),
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(48, 48),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    if (facts.length > _visible)
                      _More(
                        onPressed: () => setState(() => _visible += 50),
                        remaining: facts.length - _visible,
                      ),
                    _Receipt(controller: controller, receipt: detail.receipt),
                  ],
                  const SizedBox(height: 20),
                  const Text(
                    'Available here: account identity, current facts, provenance, conflicts and bounded portfolio intelligence. Creation, editing, CRM sync, health evaluation and workflows require separately published native contracts.',
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

String _label(String value) => value.replaceAll('_', ' ');

class _Value extends StatelessWidget {
  const _Value(this.label, this.value);
  final String label;
  final Object? value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelLarge),
        SelectableText(value?.toString() ?? 'Not recorded'),
      ],
    ),
  );
}

class _ReadStatus extends StatelessWidget {
  const _ReadStatus({
    required this.label,
    required this.source,
    required this.refresh,
  });
  final String label;
  final AccountRead<Object?> source;
  final Future<void> Function() refresh;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$label · ${_label(source.state.name)}',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          if (source.loading)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: LinearProgressIndicator(),
            ),
          if (source.message != null) Text(source.message!),
          if ([
            AccountReadState.unavailable,
            AccountReadState.stale,
            AccountReadState.forbidden,
          ].contains(source.state))
            TextButton(
              onPressed: refresh,
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              child: Text('Refresh $label'),
            ),
        ],
      ),
    ),
  );
}

class _AccountCard extends StatelessWidget {
  const _AccountCard({
    required this.controller,
    required this.account,
    required this.intelligence,
    required this.stale,
    this.onOpen,
  });
  final AccountsController controller;
  final CustomerAccountSummary account;
  final CustomerPortfolioItem? intelligence;
  final bool stale;
  final VoidCallback? onOpen;
  @override
  Widget build(BuildContext context) {
    final row = intelligence;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(account.name, style: Theme.of(context).textTheme.titleLarge),
            Text('${_label(account.lifecycle)} · ${account.owner}'),
            _Value('Account', account.id),
            _Value('Revision', account.revisionId),
            _Value('Account SHA-256', account.sha256),
            if (row == null)
              const Text(
                'Health and attention are unavailable for this exact account revision. Missing intelligence is not a healthy status.',
              )
            else ...[
              Text(
                '${stale ? 'Older snapshot · ' : ''}Attention: ${_label(row.attention)}',
              ),
              Text(
                'Health: ${_label(row.health['status'] as String)} · ${row.health['current'] == true ? 'current evaluation' : 'evaluation not current'}',
              ),
              if (row.health['scoreBasisPoints'] != null)
                Text(
                  'Score ${(row.health['scoreBasisPoints'] as int) / 100}% · coverage ${(row.health['coverageBasisPoints'] as int) / 100}% · confidence ${(row.health['confidenceBasisPoints'] as int) / 100}%',
                ),
              _Value('Health evaluated at', row.health['evaluatedAt']),
              Text(
                '${row.counts['openRisks']} open risks · ${row.counts['pendingApprovals']} related approvals · ${row.counts['overdueCommitments']} overdue commitments',
              ),
              _Recommendation(
                controller: controller,
                accountId: account.id,
                value: row.recommendation,
              ),
            ],
            if (onOpen != null)
              FilledButton.tonalIcon(
                onPressed: onOpen,
                style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                icon: const Icon(Icons.open_in_new),
                label: const Text('Open exact customer account'),
              ),
          ],
        ),
      ),
    );
  }
}

class _Recommendation extends StatelessWidget {
  const _Recommendation({
    required this.controller,
    required this.accountId,
    required this.value,
  });
  final AccountsController controller;
  final String accountId;
  final AccountJson value;
  @override
  Widget build(BuildContext context) => ExpansionTile(
    key: accountsStorageKey(
      controller,
      'recommendation:$accountId:${value['recommendationId']}:${value['recommendationSha256']}',
    ),
    title: const Text('Suggested next action · not authoritative'),
    childrenPadding: const EdgeInsets.all(12),
    children: [
      _Value('Suggestion', value['title']),
      _Value('Reason', value['reason']),
      _Value('Recommendation', value['recommendationId']),
      _Value('Digest', value['recommendationSha256']),
      _Value('Confidence', '${(value['confidenceBasisPoints'] as int) / 100}%'),
      _Value('Freshness', (value['freshness'] as Map)['status']),
      for (final text in value['uncertainty'] as List)
        _Value('Uncertainty', text),
      for (final raw in value['evidence'] as List) ...[
        _Value('Evidence', (raw as Map)['label']),
        _Value('Exact reference', raw['refId']),
        _Value('Revision', raw['revisionId']),
        _Value('SHA-256', raw['sha256']),
        _Value('Observed', raw['observedAt']),
      ],
    ],
  );
}

class _FactInspector extends StatelessWidget {
  const _FactInspector({super.key, required this.fact, required this.onClose});
  final CustomerFact fact;
  final VoidCallback onClose;
  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    label: 'Exact customer fact inspector',
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Exact fact evidence',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            TextButton(
              onPressed: onClose,
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              child: const Text('Close fact inspector'),
            ),
            _Value('Fact', fact.id),
            _Value('Revision', fact.revisionId),
            _Value('Fact SHA-256', fact.fact['factSha256']),
            _Value('Meaning', fact.key),
            _Value(
              'Confidence',
              '${(fact.fact['confidenceBasisPoints'] as int) / 100}%',
            ),
            _Value('Freshness', fact.freshness),
            for (final entry in fact.value.entries)
              _Value('Value · ${entry.key}', entry.value),
            for (final entry in fact.source.entries)
              _Value('Source · ${entry.key}', entry.value),
            _Value(
              'Semantic owner',
              (fact.fact['owner'] as Map)['displayName'],
            ),
            _Value('Owner identity', (fact.fact['owner'] as Map)['ownerId']),
            for (final field in [
              'validFrom',
              'validTo',
              'staleAfter',
              'recordedByActorId',
              'recordedAt',
            ])
              _Value(field, fact.fact[field]),
            if (fact.conflictingIds.isEmpty)
              const Text(
                'No competing value is reported in this returned projection.',
              )
            else ...[
              const Text(
                'Unresolved competing values remain visible. This view does not choose a winner.',
              ),
              for (final id in fact.conflictingIds)
                _Value('Conflicting fact', id),
            ],
          ],
        ),
      ),
    ),
  );
}

class _Receipt extends StatelessWidget {
  const _Receipt({required this.controller, required this.receipt});
  final AccountsController controller;
  final AccountJson receipt;
  @override
  Widget build(BuildContext context) => ExpansionTile(
    key: accountsStorageKey(controller, 'receipt:${receipt['receiptSha256']}'),
    title: const Text('Verified read receipt'),
    childrenPadding: const EdgeInsets.all(12),
    children: [
      const Text(
        'Digest verification binds these returned fields to their receipt. Current server authorization remains the access boundary.',
      ),
      for (final field in [
        'operation',
        'occurredAt',
        'resourceCount',
        'authoritySha256',
        'outcomeSha256',
        'receiptSha256',
      ])
        _Value(field, receipt[field]),
    ],
  );
}

class _More extends StatelessWidget {
  const _More({required this.onPressed, required this.remaining});
  final VoidCallback onPressed;
  final int remaining;
  @override
  Widget build(BuildContext context) => TextButton(
    onPressed: onPressed,
    style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
    child: Text('Show up to 50 more from this snapshot ($remaining remaining)'),
  );
}
