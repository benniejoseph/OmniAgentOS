import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import '../macos_detail_support.dart';
import 'customer_detail.dart';

/// A macOS Customer 360 fact browser backed by the existing governed account
/// projection. Facts stay searchable and inspectable without leaving the page.
class MacosCustomerDetailView extends StatefulWidget {
  const MacosCustomerDetailView({
    super.key,
    required this.id,
    required this.api,
  });

  final String id;
  final ApiClient api;

  @override
  State<MacosCustomerDetailView> createState() =>
      _MacosCustomerDetailViewState();
}

class _MacosCustomerDetailViewState extends State<MacosCustomerDetailView> {
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search customer facts');
  CustomerDetail? _customer;
  Object? _error;
  bool _loading = true;
  String? _selectedFactKey;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant MacosCustomerDetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.id != widget.id) {
      _customer = null;
      _selectedFactKey = null;
      _load();
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final customer = CustomerDetail.fromJson(
        await widget.api.getJson(NativePaths.customersGet(widget.id)),
      );
      if (!mounted) return;
      setState(() {
        _customer = customer;
        if (customer.facts.every((fact) => fact.key != _selectedFactKey)) {
          _selectedFactKey = customer.facts.firstOrNull?.key;
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
    final visible = _visibleFacts();
    final selected = _selectedFact(visible);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true): () =>
            macosNavigateBack(context, '/accounts'),
        const SingleActivator(LogicalKeyboardKey.keyR, meta: true): _load,
        const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
            _searchFocus.requestFocus,
        const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
            _moveSelection(visible, 1),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
            _moveSelection(visible, -1),
      },
      child: Focus(
        autofocus: true,
        child: MacosPageScaffold(
          title: _customer?.name ?? 'Customer 360',
          description: 'Evidence-backed account facts, freshness, and source confidence.',
          icon: Icons.domain_outlined,
          actions: [
            IconButton(
              key: const Key('macos-customer-detail-refresh'),
              tooltip: 'Refresh customer (⌘R)',
              onPressed: _loading ? null : _load,
              icon: _loading
                  ? const SizedBox.square(
                      dimension: 15,
                      child: CircularProgressIndicator(strokeWidth: 1.8),
                    )
                  : const Icon(Icons.refresh_rounded),
            ),
          ],
          toolbar: _CustomerToolbar(
            customer: _customer,
            searchController: _searchController,
            searchFocus: _searchFocus,
            visibleCount: visible.length,
            onChanged: (_) => setState(() {}),
            onClear: () {
              _searchController.clear();
              setState(() {});
            },
          ),
          inspector: _customer == null
              ? null
              : _CustomerInspector(
                  customer: _customer!,
                  selectedFact: selected,
                ),
          inspectorWidth: 370,
          inspectorMinWidth: 320,
          inspectorMaxWidth: 500,
          body: _body(visible, selected),
        ),
      ),
    );
  }

  List<CustomerFact> _visibleFacts() {
    final query = _searchController.text.trim().toLowerCase();
    final facts = _customer?.facts ?? const <CustomerFact>[];
    if (query.isEmpty) return facts;
    return facts
        .where(
          (fact) =>
              fact.key.toLowerCase().contains(query) ||
              fact.summary.toLowerCase().contains(query) ||
              fact.source.toLowerCase().contains(query),
        )
        .toList(growable: false);
  }

  CustomerFact? _selectedFact(List<CustomerFact> visible) {
    if (visible.isEmpty) return null;
    for (final fact in visible) {
      if (fact.key == _selectedFactKey) return fact;
    }
    return visible.first;
  }

  void _moveSelection(List<CustomerFact> visible, int delta) {
    if (visible.isEmpty) return;
    final current = visible.indexWhere((fact) => fact.key == _selectedFactKey);
    final next = current < 0
        ? 0
        : (current + delta).clamp(0, visible.length - 1);
    setState(() => _selectedFactKey = visible[next].key);
  }

  Widget _body(List<CustomerFact> visible, CustomerFact? selected) {
    final customer = _customer;
    if (_loading && customer == null) return const MacosLoadingList(rows: 9);
    if (_error != null && customer == null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Customer 360 is unavailable',
        message: 'The account projection could not be loaded. Reconnect and try again.',
        action: FilledButton.tonalIcon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
      );
    }
    if (customer == null) {
      return const MacosEmptyState(
        icon: Icons.domain_disabled_outlined,
        title: 'Customer not found',
        message:
            'This account is no longer available to the current workspace.',
      );
    }
    return Column(
      children: [
        if (_error != null)
          MacosDetailNotice(
            message:
                'Showing the last available Customer 360 projection. Refresh failed: $_error',
            action: TextButton(onPressed: _load, child: const Text('Retry')),
          ),
        _CustomerSummary(customer: customer),
        Expanded(
          child: visible.isEmpty
              ? MacosEmptyState(
                  icon: Icons.manage_search_rounded,
                  title: customer.facts.isEmpty
                      ? 'No customer facts yet'
                      : 'No facts match this search',
                  message: customer.facts.isEmpty
                      ? 'Evidence-backed account facts will appear as connected sources are indexed.'
                      : 'Try a fact name, value, or source system.',
                  action: _searchController.text.isEmpty
                      ? null
                      : TextButton(
                          onPressed: () {
                            _searchController.clear();
                            setState(() {});
                          },
                          child: const Text('Clear search'),
                        ),
                )
              : _FactsTable(
                  facts: visible,
                  selectedKey: selected?.key,
                  onSelect: (fact) =>
                      setState(() => _selectedFactKey = fact.key),
                ),
        ),
      ],
    );
  }
}

class _CustomerToolbar extends StatelessWidget {
  const _CustomerToolbar({
    required this.customer,
    required this.searchController,
    required this.searchFocus,
    required this.visibleCount,
    required this.onChanged,
    required this.onClear,
  });

  final CustomerDetail? customer;
  final TextEditingController searchController;
  final FocusNode searchFocus;
  final int visibleCount;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      const MacosDetailBackButton(
        fallbackLocation: '/accounts',
        label: 'Accounts',
      ),
      const SizedBox(width: 12),
      SizedBox(
        width: 280,
        child: TextField(
          key: const Key('macos-customer-fact-search'),
          controller: searchController,
          focusNode: searchFocus,
          onChanged: onChanged,
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search_rounded, size: 17),
            hintText: 'Search facts  ⌘F',
            suffixIcon: searchController.text.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear search',
                    onPressed: onClear,
                    icon: const Icon(Icons.close_rounded, size: 16),
                  ),
          ),
        ),
      ),
      if (customer != null) ...[
        const SizedBox(width: 12),
        MacosStatusBadge(
          label: macosHumanize(customer!.lifecycle),
          tone: macosToneForStatus(customer!.lifecycle),
        ),
        const Spacer(),
        Text(
          '$visibleCount of ${customer!.facts.length} facts',
          style: Theme.of(context).textTheme.labelSmall,
        ),
      ],
    ],
  );
}

class _CustomerSummary extends StatelessWidget {
  const _CustomerSummary({required this.customer});
  final CustomerDetail customer;

  @override
  Widget build(BuildContext context) {
    final fresh = customer.facts.where((fact) => !fact.stale).length;
    final average = customer.facts.isEmpty
        ? 0
        : (customer.facts.fold<int>(0, (sum, fact) => sum + fact.confidence) /
                  customer.facts.length)
              .round();
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 16),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: MacosThemeColors.of(context).divider),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  customer.name,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 3),
                Text(
                  'Customer 360 revision ${customer.revision}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          _SummaryMetric(value: '${customer.facts.length}', label: 'Facts'),
          const SizedBox(width: 26),
          _SummaryMetric(value: '$fresh', label: 'Fresh'),
          const SizedBox(width: 26),
          _SummaryMetric(
            value: customer.facts.isEmpty ? '—' : '$average%',
            label: 'Avg confidence',
          ),
        ],
      ),
    );
  }
}

class _SummaryMetric extends StatelessWidget {
  const _SummaryMetric({required this.value, required this.label});
  final String value, label;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Text(value, style: Theme.of(context).textTheme.titleMedium),
      Text(label, style: Theme.of(context).textTheme.labelSmall),
    ],
  );
}

class _FactsTable extends StatelessWidget {
  const _FactsTable({
    required this.facts,
    required this.selectedKey,
    required this.onSelect,
  });
  final List<CustomerFact> facts;
  final String? selectedKey;
  final ValueChanged<CustomerFact> onSelect;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final showSource = constraints.maxWidth >= 820;
      return Column(
        children: [
          _FactTableHeader(showSource: showSource),
          Expanded(
            child: ListView.builder(
              itemCount: facts.length,
              itemBuilder: (context, index) => _FactRow(
                key: ValueKey('macos-customer-fact-${facts[index].key}'),
                fact: facts[index],
                selected: facts[index].key == selectedKey,
                showSource: showSource,
                onTap: () => onSelect(facts[index]),
              ),
            ),
          ),
        ],
      );
    },
  );
}

class _FactTableHeader extends StatelessWidget {
  const _FactTableHeader({required this.showSource});
  final bool showSource;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      height: 31,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 180,
            child: Text('FACT', style: Theme.of(context).textTheme.labelSmall),
          ),
          Expanded(
            child: Text('VALUE', style: Theme.of(context).textTheme.labelSmall),
          ),
          if (showSource)
            SizedBox(
              width: 210,
              child: Text(
                'SOURCE',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
          SizedBox(
            width: 100,
            child: Text(
              'CONFIDENCE',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ),
          SizedBox(
            width: 76,
            child: Text('STATE', style: Theme.of(context).textTheme.labelSmall),
          ),
        ],
      ),
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({
    super.key,
    required this.fact,
    required this.selected,
    required this.showSource,
    required this.onTap,
  });
  final CustomerFact fact;
  final bool selected, showSource;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Material(
      color: selected ? mac.selection : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: mac.divider)),
          ),
          child: Row(
            children: [
              SizedBox(
                width: 180,
                child: Text(
                  macosHumanize(fact.key),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Expanded(
                child: Text(
                  fact.summary,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (showSource)
                SizedBox(
                  width: 210,
                  child: Text(
                    fact.source,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              SizedBox(
                width: 100,
                child: Text(
                  '${fact.confidence}%',
                  style: const TextStyle(
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
              SizedBox(
                width: 76,
                child: MacosStatusBadge(
                  label: fact.stale ? 'Stale' : 'Fresh',
                  tone: fact.stale
                      ? MacosDetailTone.danger
                      : MacosDetailTone.positive,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CustomerInspector extends StatelessWidget {
  const _CustomerInspector({
    required this.customer,
    required this.selectedFact,
  });
  final CustomerDetail customer;
  final CustomerFact? selectedFact;

  @override
  Widget build(BuildContext context) {
    final fact = selectedFact;
    return ListView(
      children: [
        MacosInspectorSection(
          title: 'Account',
          child: Column(
            children: [
              MacosKeyValue(
                label: 'Lifecycle',
                value: macosHumanize(customer.lifecycle),
              ),
              MacosKeyValue(label: 'Revision', value: '${customer.revision}'),
              MacosKeyValue(label: 'Account ID', value: customer.id),
            ],
          ),
        ),
        MacosInspectorSection(
          title: 'Selected fact',
          description: fact == null
              ? 'Choose a fact to inspect its provenance.'
              : macosHumanize(fact.key),
          child: fact == null
              ? const Text('No fact selected.')
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SelectableText(
                      fact.summary,
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 14),
                    MacosKeyValue(label: 'Source', value: fact.source),
                    MacosKeyValue(
                      label: 'Freshness',
                      value: fact.stale ? 'Stale' : 'Fresh',
                    ),
                    MacosKeyValue(
                      label: 'Confidence',
                      value: '${fact.confidence}%',
                    ),
                    const SizedBox(height: 8),
                    LinearProgressIndicator(value: fact.confidence / 100),
                  ],
                ),
        ),
        const SizedBox(height: 20),
      ],
    );
  }
}
