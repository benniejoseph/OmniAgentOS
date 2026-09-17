import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'accounts_view.dart';

typedef _Json = Map<String, dynamic>;

enum _AccountFilter { all, needsAttention, active, atRisk }

enum _AccountSort { attention, name, health, owner }

/// A macOS-only portfolio browser. It deliberately keeps the existing
/// Account 360 detail flow behind [onOpen] while making comparison and triage
/// useful at desktop scale.
class MacosAccountsView extends StatefulWidget {
  const MacosAccountsView({super.key, required this.api, required this.onOpen});

  final ApiClient api;
  final ValueChanged<CustomerAccountSummary> onOpen;

  @override
  State<MacosAccountsView> createState() => _MacosAccountsViewState();
}

class _MacosAccountsViewState extends State<MacosAccountsView> {
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search customer accounts');
  List<CustomerAccountSummary> _accounts = const [];
  Object? _error;
  bool _loading = true;
  _AccountFilter _filter = _AccountFilter.all;
  _AccountSort _sort = _AccountSort.attention;
  String? _selectedId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final responses = await Future.wait([
        widget.api.getJson(NativePaths.customersList, query: {'limit': 200}),
        widget.api.getJson(
          NativePaths.customersPortfolio,
          query: {'limit': 200},
        ),
      ]);
      final portfolio = _map(responses[1]['portfolio']);
      final intelligence = <String, _Json>{
        for (final value
            in (portfolio['accounts'] as List? ?? const []).whereType<Map>())
          if (value['accountId'] != null)
            value['accountId'].toString(): _Json.from(value),
      };
      final loaded = (responses[0]['accounts'] as List? ?? const [])
          .whereType<Map>()
          .map((value) {
            final account = _Json.from(value);
            return CustomerAccountSummary.fromJson(
              account,
              intelligence[account['accountId']?.toString()],
            );
          })
          .where((account) => account.id.isNotEmpty)
          .toList(growable: false);
      if (!mounted) return;
      setState(() {
        _accounts = loaded;
        if (loaded.every((account) => account.id != _selectedId)) {
          _selectedId = loaded.firstOrNull?.id;
        }
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final visible = _visibleAccounts();
    final selected = _selectedAccount(visible);
    final atRisk = _accounts
        .where(
          (account) =>
              account.lifecycle == 'at_risk' || account.health == 'at_risk',
        )
        .length;
    final needsAttention = _accounts.where(_requiresAttention).length;
    final approvals = _accounts.fold<int>(
      0,
      (sum, account) => sum + account.pendingApprovals,
    );

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
            _searchFocus.requestFocus,
        const SingleActivator(LogicalKeyboardKey.keyR, meta: true): _load,
        const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
            _moveSelection(visible, 1),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
            _moveSelection(visible, -1),
        const SingleActivator(LogicalKeyboardKey.enter): () {
          if (selected != null) widget.onOpen(selected);
        },
      },
      child: Focus(
        autofocus: true,
        child: MacosPageScaffold(
          title: 'Accounts',
          description: 'Customer health, ownership, risk, and approvals in one portfolio.',
          icon: Icons.domain_outlined,
          actions: [
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                ),
              ),
            IconButton(
              key: const Key('macos-accounts-refresh'),
              tooltip: 'Refresh accounts (⌘R)',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
          toolbar: _AccountsToolbar(
            searchController: _searchController,
            searchFocus: _searchFocus,
            filter: _filter,
            sort: _sort,
            visibleCount: visible.length,
            totalCount: _accounts.length,
            onSearchChanged: (_) => setState(() {}),
            onClearSearch: () {
              _searchController.clear();
              setState(() {});
            },
            onFilterChanged: (value) => setState(() => _filter = value),
            onSortChanged: (value) => setState(() => _sort = value),
          ),
          body: MacosResizableInspector(
            initialWidth: 360,
            minWidth: 300,
            maxWidth: 460,
            collapseBelow: 0,
            inspector: _AccountInspector(
              account: selected,
              onOpen: widget.onOpen,
            ),
            body: _AccountsBrowser(
              accounts: visible,
              selectedId: selected?.id,
              loading: _loading,
              error: _error,
              totalCount: _accounts.length,
              atRisk: atRisk,
              needsAttention: needsAttention,
              approvals: approvals,
              filtered:
                  _filter != _AccountFilter.all ||
                  _searchController.text.trim().isNotEmpty,
              onRetry: _load,
              onClearFilters: _clearFilters,
              onSelect: (account) => setState(() => _selectedId = account.id),
            ),
          ),
        ),
      ),
    );
  }

  List<CustomerAccountSummary> _visibleAccounts() {
    final query = _searchController.text.trim().toLowerCase();
    final values = _accounts.where((account) {
      final matchesQuery =
          query.isEmpty ||
          account.name.toLowerCase().contains(query) ||
          account.owner.toLowerCase().contains(query) ||
          account.lifecycle.toLowerCase().contains(query) ||
          account.health.toLowerCase().contains(query);
      if (!matchesQuery) return false;
      return switch (_filter) {
        _AccountFilter.all => true,
        _AccountFilter.needsAttention => _requiresAttention(account),
        _AccountFilter.active => account.lifecycle == 'active',
        _AccountFilter.atRisk =>
          account.lifecycle == 'at_risk' || account.health == 'at_risk',
      };
    }).toList();
    values.sort(
      (left, right) => switch (_sort) {
        _AccountSort.attention => _attentionScore(
          right,
        ).compareTo(_attentionScore(left)),
        _AccountSort.name => left.name.toLowerCase().compareTo(
          right.name.toLowerCase(),
        ),
        _AccountSort.health => (right.score ?? -1).compareTo(left.score ?? -1),
        _AccountSort.owner => left.owner.toLowerCase().compareTo(
          right.owner.toLowerCase(),
        ),
      },
    );
    return values;
  }

  CustomerAccountSummary? _selectedAccount(
    List<CustomerAccountSummary> visible,
  ) {
    if (visible.isEmpty) return null;
    for (final account in visible) {
      if (account.id == _selectedId) return account;
    }
    return visible.first;
  }

  void _moveSelection(List<CustomerAccountSummary> visible, int delta) {
    if (visible.isEmpty) return;
    final current = visible.indexWhere((account) => account.id == _selectedId);
    final next = current < 0
        ? 0
        : (current + delta).clamp(0, visible.length - 1);
    setState(() => _selectedId = visible[next].id);
  }

  void _clearFilters() {
    _searchController.clear();
    setState(() => _filter = _AccountFilter.all);
  }
}

class _AccountsToolbar extends StatelessWidget {
  const _AccountsToolbar({
    required this.searchController,
    required this.searchFocus,
    required this.filter,
    required this.sort,
    required this.visibleCount,
    required this.totalCount,
    required this.onSearchChanged,
    required this.onClearSearch,
    required this.onFilterChanged,
    required this.onSortChanged,
  });

  final TextEditingController searchController;
  final FocusNode searchFocus;
  final _AccountFilter filter;
  final _AccountSort sort;
  final int visibleCount;
  final int totalCount;
  final ValueChanged<String> onSearchChanged;
  final VoidCallback onClearSearch;
  final ValueChanged<_AccountFilter> onFilterChanged;
  final ValueChanged<_AccountSort> onSortChanged;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 820;
      return Row(
        children: [
          SizedBox(
            width: compact ? 220 : 310,
            child: TextField(
              key: const Key('macos-accounts-search'),
              controller: searchController,
              focusNode: searchFocus,
              onChanged: onSearchChanged,
              decoration: InputDecoration(
                hintText: 'Search accounts or owners  ⌘F',
                prefixIcon: const Icon(Icons.search_rounded, size: 17),
                suffixIcon: searchController.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear search',
                        onPressed: onClearSearch,
                        icon: const Icon(Icons.close_rounded, size: 15),
                      ),
              ),
            ),
          ),
          const SizedBox(width: 9),
          _AccountFilterMenu(value: filter, onChanged: onFilterChanged),
          const SizedBox(width: 6),
          _AccountSortMenu(value: sort, onChanged: onSortChanged),
          const Spacer(),
          if (!compact)
            Text(
              visibleCount == totalCount
                  ? '$totalCount accounts'
                  : '$visibleCount of $totalCount accounts',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
        ],
      );
    },
  );
}

class _AccountFilterMenu extends StatelessWidget {
  const _AccountFilterMenu({required this.value, required this.onChanged});

  final _AccountFilter value;
  final ValueChanged<_AccountFilter> onChanged;

  @override
  Widget build(BuildContext context) => MenuAnchor(
    builder: (context, controller, _) => OutlinedButton.icon(
      key: const Key('macos-accounts-filter'),
      onPressed: () =>
          controller.isOpen ? controller.close() : controller.open(),
      icon: const Icon(Icons.filter_list_rounded, size: 16),
      label: Text(_filterLabel(value)),
    ),
    menuChildren: [
      for (final filter in _AccountFilter.values)
        MenuItemButton(
          onPressed: () => onChanged(filter),
          leadingIcon: SizedBox(
            width: 16,
            child: filter == value
                ? Icon(
                    Icons.check_rounded,
                    size: 15,
                    color: Theme.of(context).colorScheme.primary,
                  )
                : null,
          ),
          child: Text(_filterLabel(filter)),
        ),
    ],
  );
}

class _AccountSortMenu extends StatelessWidget {
  const _AccountSortMenu({required this.value, required this.onChanged});

  final _AccountSort value;
  final ValueChanged<_AccountSort> onChanged;

  @override
  Widget build(BuildContext context) => PopupMenuButton<_AccountSort>(
    key: const Key('macos-accounts-sort'),
    tooltip: 'Sort accounts',
    initialValue: value,
    onSelected: onChanged,
    itemBuilder: (context) => [
      for (final sort in _AccountSort.values)
        PopupMenuItem(
          value: sort,
          child: Row(
            children: [
              SizedBox(
                width: 22,
                child: sort == value
                    ? Icon(
                        Icons.check_rounded,
                        size: 15,
                        color: Theme.of(context).colorScheme.primary,
                      )
                    : null,
              ),
              Text(_sortLabel(sort)),
            ],
          ),
        ),
    ],
    child: const Padding(
      padding: EdgeInsets.all(7),
      child: Icon(Icons.swap_vert_rounded, size: 18),
    ),
  );
}

class _AccountsBrowser extends StatelessWidget {
  const _AccountsBrowser({
    required this.accounts,
    required this.selectedId,
    required this.loading,
    required this.error,
    required this.totalCount,
    required this.atRisk,
    required this.needsAttention,
    required this.approvals,
    required this.filtered,
    required this.onRetry,
    required this.onClearFilters,
    required this.onSelect,
  });

  final List<CustomerAccountSummary> accounts;
  final String? selectedId;
  final bool loading;
  final Object? error;
  final int totalCount, atRisk, needsAttention, approvals;
  final bool filtered;
  final VoidCallback onRetry, onClearFilters;
  final ValueChanged<CustomerAccountSummary> onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      children: [
        _PortfolioStrip(
          total: totalCount,
          atRisk: atRisk,
          needsAttention: needsAttention,
          approvals: approvals,
        ),
        if (error != null)
          _RefreshNotice(
            hasCachedData: totalCount > 0,
            error: error!,
            retry: onRetry,
          ),
        Expanded(
          child: Container(
            margin: const EdgeInsets.fromLTRB(16, 12, 12, 16),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              border: Border.all(color: mac.divider),
              borderRadius: BorderRadius.circular(9),
            ),
            clipBehavior: Clip.antiAlias,
            child: loading && totalCount == 0
                ? const MacosLoadingList(rows: 9)
                : accounts.isEmpty
                ? MacosEmptyState(
                    icon: filtered
                        ? Icons.filter_alt_off_outlined
                        : Icons.domain_disabled_outlined,
                    title: filtered
                        ? 'No matching accounts'
                        : 'No accounts yet',
                    message: filtered
                        ? 'Adjust the search or return to the complete portfolio.'
                        : 'Customer accounts will appear here when the portfolio projection is available.',
                    action: filtered
                        ? OutlinedButton(
                            onPressed: onClearFilters,
                            child: const Text('Clear filters'),
                          )
                        : null,
                  )
                : LayoutBuilder(
                    builder: (context, constraints) {
                      final showOwner = constraints.maxWidth >= 610;
                      final showHealth = constraints.maxWidth >= 735;
                      return Column(
                        children: [
                          _AccountTableHeader(
                            showOwner: showOwner,
                            showHealth: showHealth,
                          ),
                          Expanded(
                            child: Scrollbar(
                              child: ListView.builder(
                                itemCount: accounts.length,
                                itemExtent: 61,
                                itemBuilder: (context, index) {
                                  final account = accounts[index];
                                  return _AccountTableRow(
                                    key: Key('macos-account-row-${account.id}'),
                                    account: account,
                                    selected: account.id == selectedId,
                                    showOwner: showOwner,
                                    showHealth: showHealth,
                                    onSelect: () => onSelect(account),
                                  );
                                },
                              ),
                            ),
                          ),
                        ],
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }
}

class _PortfolioStrip extends StatelessWidget {
  const _PortfolioStrip({
    required this.total,
    required this.atRisk,
    required this.needsAttention,
    required this.approvals,
  });

  final int total, atRisk, needsAttention, approvals;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      key: const Key('macos-accounts-summary'),
      height: 54,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: mac.canvas,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) => Row(
          children: [
            _SummaryValue(
              icon: Icons.domain_outlined,
              value: '$total',
              label: 'Portfolio',
              color: Theme.of(context).colorScheme.primary,
            ),
            const _SummaryDivider(),
            _SummaryValue(
              icon: Icons.health_and_safety_outlined,
              value: '$needsAttention',
              label: constraints.maxWidth < 610
                  ? 'Attention'
                  : 'Need attention',
              color: mac.warning,
            ),
            const _SummaryDivider(),
            _SummaryValue(
              icon: Icons.warning_amber_rounded,
              value: '$atRisk',
              label: 'At risk',
              color: Theme.of(context).colorScheme.error,
            ),
            if (constraints.maxWidth >= 540) ...[
              const _SummaryDivider(),
              _SummaryValue(
                icon: Icons.approval_outlined,
                value: '$approvals',
                label: 'Approvals',
                color: mac.positive,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SummaryValue extends StatelessWidget {
  const _SummaryValue({
    required this.icon,
    required this.value,
    required this.label,
    required this.color,
  });

  final IconData icon;
  final String value, label;
  final Color color;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(icon, size: 15, color: color),
        const SizedBox(width: 7),
        Text(
          value,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(color: color),
        ),
        const SizedBox(width: 5),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.labelMedium,
          ),
        ),
      ],
    ),
  );
}

class _SummaryDivider extends StatelessWidget {
  const _SummaryDivider();

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 25,
    child: VerticalDivider(color: MacosThemeColors.of(context).divider),
  );
}

class _AccountTableHeader extends StatelessWidget {
  const _AccountTableHeader({
    required this.showOwner,
    required this.showHealth,
  });

  final bool showOwner, showHealth;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.labelSmall;
    final mac = MacosThemeColors.of(context);
    return Container(
      height: 33,
      padding: const EdgeInsets.symmetric(horizontal: 13),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          const SizedBox(width: 23),
          Expanded(flex: 5, child: Text('ACCOUNT', style: style)),
          if (showOwner)
            SizedBox(width: 142, child: Text('OWNER', style: style)),
          if (showHealth)
            SizedBox(width: 132, child: Text('HEALTH', style: style)),
          SizedBox(width: 112, child: Text('SIGNALS', style: style)),
        ],
      ),
    );
  }
}

class _AccountTableRow extends StatelessWidget {
  const _AccountTableRow({
    super.key,
    required this.account,
    required this.selected,
    required this.showOwner,
    required this.showHealth,
    required this.onSelect,
  });

  final CustomerAccountSummary account;
  final bool selected, showOwner, showHealth;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final attention = _requiresAttention(account);
    return Semantics(
      button: true,
      selected: selected,
      label:
          '${account.name}, ${_humanize(account.health)}, ${account.openRisks} risks, ${account.pendingApprovals} approvals',
      hint: 'Select for account details. Use Open Account in the inspector.',
      child: Material(
        color: selected ? mac.selection : Colors.transparent,
        child: InkWell(
          onTap: onSelect,
          canRequestFocus: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: mac.divider)),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 23,
                  child: Icon(
                    attention
                        ? Icons.error_outline_rounded
                        : Icons.domain_outlined,
                    size: 15,
                    color: attention
                        ? mac.warning
                        : Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                Expanded(
                  flex: 5,
                  child: Padding(
                    padding: const EdgeInsets.only(right: 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          account.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _humanize(account.lifecycle),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ),
                if (showOwner)
                  SizedBox(
                    width: 142,
                    child: Text(
                      account.owner,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                if (showHealth)
                  SizedBox(width: 132, child: _HealthLabel(account: account)),
                SizedBox(
                  width: 112,
                  child: Text(
                    '${account.openRisks} risk${account.openRisks == 1 ? '' : 's'}  ·  ${account.pendingApprovals} due',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: attention
                          ? mac.warning
                          : Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _HealthLabel extends StatelessWidget {
  const _HealthLabel({required this.account});

  final CustomerAccountSummary account;

  @override
  Widget build(BuildContext context) {
    final descriptor = _healthDescriptor(context, account.health);
    return Row(
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(
            color: descriptor.color,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 7),
        Flexible(
          child: Text(
            account.score == null
                ? descriptor.label
                : '${descriptor.label}  ${(account.score! / 100).round()}%',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.labelMedium
                ?.copyWith(color: descriptor.color),
          ),
        ),
      ],
    );
  }
}

class _AccountInspector extends StatelessWidget {
  const _AccountInspector({required this.account, required this.onOpen});

  final CustomerAccountSummary? account;
  final ValueChanged<CustomerAccountSummary> onOpen;

  @override
  Widget build(BuildContext context) {
    final value = account;
    if (value == null) {
      return const MacosEmptyState(
        icon: Icons.info_outline_rounded,
        title: 'Select an account',
        message: 'Health, ownership, risks, and approval signals will remain visible here.',
      );
    }
    final health = _healthDescriptor(context, value.health);
    final mac = MacosThemeColors.of(context);
    return Scrollbar(
      child: ListView(
        key: const Key('macos-accounts-inspector'),
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: mac.selection,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Center(
                  child: Text(
                    _initials(value.name),
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      value.name,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${_humanize(value.lifecycle)} account',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: Key('macos-account-open-${value.id}'),
            onPressed: () => onOpen(value),
            icon: const Icon(Icons.open_in_new_rounded, size: 16),
            label: const Text('Open Account'),
          ),
          const SizedBox(height: 22),
          Text('HEALTH', style: Theme.of(context).textTheme.labelSmall),
          const SizedBox(height: 8),
          Row(
            children: [
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  color: health.color,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  health.label,
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(color: health.color),
                ),
              ),
              if (value.score != null)
                Text(
                  '${(value.score! / 100).round()}%',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
            ],
          ),
          if (value.score != null) ...[
            const SizedBox(height: 10),
            LinearProgressIndicator(
              value: (value.score! / 10000).clamp(0, 1),
              minHeight: 5,
              color: health.color,
              backgroundColor: mac.hover,
            ),
          ],
          const SizedBox(height: 22),
          _InspectorSection(
            title: 'ACCOUNT SUMMARY',
            children: [
              _InspectorRow(label: 'Owner', value: value.owner),
              _InspectorRow(
                label: 'Lifecycle',
                value: _humanize(value.lifecycle),
              ),
              _InspectorRow(
                label: 'Attention',
                value: _humanize(value.attention),
              ),
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'OPEN SIGNALS',
            children: [
              _SignalRow(
                icon: Icons.warning_amber_rounded,
                label: 'Open risks',
                value: value.openRisks,
                color: value.openRisks > 0
                    ? mac.warning
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              _SignalRow(
                icon: Icons.approval_outlined,
                label: 'Pending approvals',
                value: value.pendingApprovals,
                color: value.pendingApprovals > 0
                    ? Theme.of(context).colorScheme.primary
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ],
          ),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.all(11),
            decoration: BoxDecoration(
              color: mac.canvas,
              border: Border.all(color: mac.divider),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              'This portfolio is a summary projection. Open the account to inspect exact facts, evidence, history, and workflows.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class _InspectorSection extends StatelessWidget {
  const _InspectorSection({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: Theme.of(context).textTheme.labelSmall),
      const SizedBox(height: 6),
      ...children,
    ],
  );
}

class _InspectorRow extends StatelessWidget {
  const _InspectorRow({required this.label, required this.value});

  final String label, value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 86,
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        Expanded(
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
      ],
    ),
  );
}

class _SignalRow extends StatelessWidget {
  const _SignalRow({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  final IconData icon;
  final String label;
  final int value;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(label)),
        Text(
          '$value',
          style: Theme.of(context).textTheme.titleSmall?.copyWith(color: color),
        ),
      ],
    ),
  );
}

class _RefreshNotice extends StatelessWidget {
  const _RefreshNotice({
    required this.hasCachedData,
    required this.error,
    required this.retry,
  });

  final bool hasCachedData;
  final Object error;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      color: scheme.errorContainer,
      child: Row(
        children: [
          Icon(Icons.cloud_off_outlined, size: 16, color: scheme.error),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              hasCachedData
                  ? 'Showing the last available portfolio. The latest refresh did not complete.'
                  : 'The account portfolio is unavailable. ${error.toString()}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: scheme.onErrorContainer),
            ),
          ),
          TextButton(onPressed: retry, child: const Text('Try Again')),
        ],
      ),
    );
  }
}

bool _requiresAttention(CustomerAccountSummary account) =>
    const {'urgent', 'attention'}.contains(account.attention) ||
    account.lifecycle == 'at_risk' ||
    account.health == 'at_risk' ||
    account.openRisks > 0 ||
    account.pendingApprovals > 0;

int _attentionScore(CustomerAccountSummary account) {
  var score = 0;
  if (account.attention == 'urgent') score += 100;
  if (account.attention == 'attention') score += 70;
  if (account.lifecycle == 'at_risk' || account.health == 'at_risk') {
    score += 40;
  }
  score += account.openRisks * 4;
  score += account.pendingApprovals * 3;
  return score;
}

({String label, Color color}) _healthDescriptor(
  BuildContext context,
  String value,
) {
  final mac = MacosThemeColors.of(context);
  return switch (value) {
    'healthy' || 'good' || 'strong' => (label: 'Healthy', color: mac.positive),
    'watch' || 'attention' || 'fair' => (label: 'Watch', color: mac.warning),
    'at_risk' ||
    'critical' ||
    'poor' => (label: 'At risk', color: Theme.of(context).colorScheme.error),
    _ => (
      label: 'Not evaluated',
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    ),
  };
}

String _filterLabel(_AccountFilter value) => switch (value) {
  _AccountFilter.all => 'All accounts',
  _AccountFilter.needsAttention => 'Needs attention',
  _AccountFilter.active => 'Active',
  _AccountFilter.atRisk => 'At risk',
};

String _sortLabel(_AccountSort value) => switch (value) {
  _AccountSort.attention => 'Attention first',
  _AccountSort.name => 'Name',
  _AccountSort.health => 'Health score',
  _AccountSort.owner => 'Owner',
};

String _initials(String value) {
  final words = value
      .trim()
      .split(RegExp(r'\s+'))
      .where((word) => word.isNotEmpty)
      .take(2)
      .toList();
  if (words.isEmpty) return 'A';
  return words.map((word) => word[0].toUpperCase()).join();
}

_Json _map(Object? value) =>
    value is Map ? _Json.from(value) : <String, dynamic>{};

String _humanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
