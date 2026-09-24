import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';

typedef _Json = Map<String, dynamic>;

enum _PaymentSection { mandates, signers, evidence }

/// A review-only macOS payment workspace. No mutation or authorization
/// capability is exposed here: the server's deterministic Trusted Surface
/// remains the only place where an enrolled human-present signer may act.
class MacosPaymentsView extends StatefulWidget {
  const MacosPaymentsView({super.key, required this.api});

  final ApiClient api;

  @override
  State<MacosPaymentsView> createState() => _MacosPaymentsViewState();
}

class _MacosPaymentsViewState extends State<MacosPaymentsView> {
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search payment evidence');
  Future<void>? _loadInFlight;
  _Json? _readiness;
  _Json? _reviews;
  _Json? _authenticators;
  _Json? _transactions;
  Object? _error;
  bool _loading = true;
  _PaymentSection _section = _PaymentSection.mandates;
  final Map<_PaymentSection, String?> _selectedIds = {
    for (final section in _PaymentSection.values) section: null,
  };

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
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final primary = await Future.wait([
        widget.api.getJson(NativePaths.paymentsReadiness),
        widget.api.getJson(NativePaths.paymentsReviews),
      ]);
      if (!mounted) return;
      setState(() {
        _readiness = primary[0];
        _reviews = primary[1];
      });
      final secondary = await Future.wait([
        widget.api.getJson(NativePaths.paymentsAuthenticators),
        widget.api.getJson(NativePaths.paymentsTransactions),
      ]);
      if (!mounted) return;
      setState(() {
        _authenticators = secondary[0];
        _transactions = secondary[1];
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<_Json> get _mandates => (_reviews?['reviews'] as List? ?? const [])
      .whereType<Map>()
      .map(_Json.from)
      .toList(growable: false);

  List<_Json> get _signers =>
      (_authenticators?['credentials'] as List? ?? const [])
          .whereType<Map>()
          .map(_Json.from)
          .toList(growable: false);

  List<_Json> get _evidence =>
      (_transactions?['transactions'] as List? ?? const [])
          .whereType<Map>()
          .map(_Json.from)
          .toList(growable: false);

  @override
  Widget build(BuildContext context) {
    final mandates = _mandates;
    final signers = _signers;
    final evidence = _evidence;
    final visible = _visibleItems(switch (_section) {
      _PaymentSection.mandates => mandates,
      _PaymentSection.signers => signers,
      _PaymentSection.evidence => evidence,
    });
    final selected = _selectedItem(visible);

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
            _searchFocus.requestFocus,
        const SingleActivator(LogicalKeyboardKey.keyR, meta: true): _load,
        const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
            _moveSelection(visible, 1),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
            _moveSelection(visible, -1),
      },
      child: Focus(
        autofocus: true,
        child: MacosPageScaffold(
          title: 'Payment Review',
          description: 'Inspect exact mandates, hardware signers, and verified payment evidence.',
          icon: Icons.account_balance_wallet_outlined,
          actions: [
            const _ReadOnlyBadge(),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                ),
              ),
            IconButton(
              key: const Key('macos-payments-refresh'),
              tooltip: 'Refresh payment evidence (⌘R)',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
          toolbar: _PaymentsToolbar(
            section: _section,
            mandates: mandates.length,
            signers: signers.length,
            evidence: evidence.length,
            searchController: _searchController,
            searchFocus: _searchFocus,
            onSearch: (_) => setState(() {}),
            onClearSearch: () {
              _searchController.clear();
              setState(() {});
            },
            onSectionChanged: (value) => setState(() {
              _section = value;
              _searchController.clear();
            }),
          ),
          body: MacosResizableInspector(
            initialWidth: 360,
            minWidth: 310,
            maxWidth: 500,
            inspector: _PaymentInspector(section: _section, value: selected),
            body: _PaymentsBrowser(
              section: _section,
              values: visible,
              selectedId: selected == null ? null : _itemId(_section, selected),
              loading: _loading,
              error: _error,
              hasCachedData: switch (_section) {
                _PaymentSection.mandates => _reviews != null,
                _PaymentSection.signers => _authenticators != null,
                _PaymentSection.evidence => _transactions != null,
              },
              readiness: _readiness,
              trustPolicyLoaded: _reviews?['trustPolicy'] is Map,
              onRetry: _load,
              onSelect: (value) => setState(
                () => _selectedIds[_section] = _itemId(_section, value),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<_Json> _visibleItems(List<_Json> source) {
    final query = _searchController.text.trim().toLowerCase();
    if (query.isEmpty) return source;
    return source
        .where((item) => _searchText(_section, item).contains(query))
        .toList(growable: false);
  }

  _Json? _selectedItem(List<_Json> visible) {
    if (visible.isEmpty) return null;
    final selectedId = _selectedIds[_section];
    for (final value in visible) {
      if (_itemId(_section, value) == selectedId) return value;
    }
    return visible.first;
  }

  void _moveSelection(List<_Json> visible, int delta) {
    if (visible.isEmpty) return;
    final selectedId = _selectedIds[_section];
    final current = visible.indexWhere(
      (value) => _itemId(_section, value) == selectedId,
    );
    final next = current < 0
        ? 0
        : (current + delta).clamp(0, visible.length - 1);
    setState(() => _selectedIds[_section] = _itemId(_section, visible[next]));
  }
}

class _ReadOnlyBadge extends StatelessWidget {
  const _ReadOnlyBadge();

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: mac.hover,
        border: Border.all(color: mac.divider),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.visibility_outlined, size: 14, color: mac.warning),
          const SizedBox(width: 6),
          Text('READ ONLY', style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }
}

class _PaymentsToolbar extends StatelessWidget {
  const _PaymentsToolbar({
    required this.section,
    required this.mandates,
    required this.signers,
    required this.evidence,
    required this.searchController,
    required this.searchFocus,
    required this.onSearch,
    required this.onClearSearch,
    required this.onSectionChanged,
  });

  final _PaymentSection section;
  final int mandates, signers, evidence;
  final TextEditingController searchController;
  final FocusNode searchFocus;
  final ValueChanged<String> onSearch;
  final VoidCallback onClearSearch;
  final ValueChanged<_PaymentSection> onSectionChanged;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 820;
      return Row(
        children: [
          if (compact)
            _CompactPaymentSectionMenu(
              section: section,
              mandates: mandates,
              signers: signers,
              evidence: evidence,
              onChanged: onSectionChanged,
            )
          else
            SegmentedButton<_PaymentSection>(
              key: const Key('macos-payments-sections'),
              showSelectedIcon: false,
              segments: [
                ButtonSegment(
                  value: _PaymentSection.mandates,
                  icon: const Icon(Icons.receipt_long_outlined, size: 15),
                  label: Text('Mandates  $mandates'),
                ),
                ButtonSegment(
                  value: _PaymentSection.signers,
                  icon: const Icon(Icons.key_outlined, size: 15),
                  label: Text('Signers  $signers'),
                ),
                ButtonSegment(
                  value: _PaymentSection.evidence,
                  icon: const Icon(Icons.fact_check_outlined, size: 15),
                  label: Text('Evidence  $evidence'),
                ),
              ],
              selected: {section},
              onSelectionChanged: (values) => onSectionChanged(values.first),
            ),
          const Spacer(),
          SizedBox(
            width: compact ? 190 : 270,
            child: TextField(
              key: const Key('macos-payments-search'),
              controller: searchController,
              focusNode: searchFocus,
              onChanged: onSearch,
              decoration: InputDecoration(
                hintText: 'Search this view  ⌘F',
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
        ],
      );
    },
  );
}

class _CompactPaymentSectionMenu extends StatelessWidget {
  const _CompactPaymentSectionMenu({
    required this.section,
    required this.mandates,
    required this.signers,
    required this.evidence,
    required this.onChanged,
  });

  final _PaymentSection section;
  final int mandates, signers, evidence;
  final ValueChanged<_PaymentSection> onChanged;

  @override
  Widget build(BuildContext context) => PopupMenuButton<_PaymentSection>(
    key: const Key('macos-payments-sections'),
    tooltip: 'Choose payment view',
    initialValue: section,
    onSelected: onChanged,
    itemBuilder: (context) => [
      for (final value in _PaymentSection.values)
        PopupMenuItem(
          value: value,
          child: Row(
            children: [
              SizedBox(
                width: 22,
                child: value == section
                    ? Icon(
                        Icons.check_rounded,
                        size: 15,
                        color: Theme.of(context).colorScheme.primary,
                      )
                    : null,
              ),
              Text('${_sectionLabel(value)}  ${_count(value)}'),
            ],
          ),
        ),
    ],
    child: Container(
      height: 34,
      constraints: const BoxConstraints(minWidth: 132),
      padding: const EdgeInsets.symmetric(horizontal: 9),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: MacosThemeColors.of(context).divider),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(_sectionIcon(section), size: 15),
          const SizedBox(width: 7),
          Text('${_sectionLabel(section)}  ${_count(section)}'),
          const SizedBox(width: 5),
          const Icon(Icons.expand_more_rounded, size: 15),
        ],
      ),
    ),
  );

  int _count(_PaymentSection value) => switch (value) {
    _PaymentSection.mandates => mandates,
    _PaymentSection.signers => signers,
    _PaymentSection.evidence => evidence,
  };
}

class _PaymentsBrowser extends StatelessWidget {
  const _PaymentsBrowser({
    required this.section,
    required this.values,
    required this.selectedId,
    required this.loading,
    required this.error,
    required this.hasCachedData,
    required this.readiness,
    required this.trustPolicyLoaded,
    required this.onRetry,
    required this.onSelect,
  });

  final _PaymentSection section;
  final List<_Json> values;
  final String? selectedId;
  final bool loading, hasCachedData, trustPolicyLoaded;
  final Object? error;
  final _Json? readiness;
  final VoidCallback onRetry;
  final ValueChanged<_Json> onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      children: [
        _PaymentBoundaryNotice(
          readiness: readiness,
          trustPolicyLoaded: trustPolicyLoaded,
        ),
        if (error != null)
          _PaymentRefreshNotice(
            hasCachedData: hasCachedData,
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
            child: loading && !hasCachedData
                ? const MacosLoadingList(rows: 8)
                : values.isEmpty
                ? _PaymentEmptyState(section: section)
                : Column(
                    children: [
                      _PaymentTableHeader(section: section),
                      Expanded(
                        child: Scrollbar(
                          child: ListView.builder(
                            itemCount: values.length,
                            itemExtent: 62,
                            itemBuilder: (context, index) {
                              final value = values[index];
                              final id = _itemId(section, value);
                              return _PaymentTableRow(
                                key: Key('macos-payment-row-$id'),
                                section: section,
                                value: value,
                                selected: id == selectedId,
                                onSelect: () => onSelect(value),
                              );
                            },
                          ),
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }
}

class _PaymentBoundaryNotice extends StatelessWidget {
  const _PaymentBoundaryNotice({
    required this.readiness,
    required this.trustPolicyLoaded,
  });

  final _Json? readiness;
  final bool trustPolicyLoaded;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final readinessBody = _map(readiness?['readiness']);
    final capability = _map(readinessBody['capability']);
    final serverState = capability['state']?.toString();
    final transactionsPermitted = capability['transactionsPermitted'] == true;
    final status = serverState == null
        ? 'BOUNDARY UNKNOWN'
        : transactionsPermitted
        ? 'SERVER ENABLED'
        : 'PAYMENTS DISABLED';
    return Container(
      key: const Key('macos-payment-boundary'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
      decoration: BoxDecoration(
        color: mac.canvas,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 31,
            height: 31,
            decoration: BoxDecoration(
              color: mac.warning.withValues(alpha: .12),
              borderRadius: BorderRadius.circular(7),
            ),
            child: Icon(Icons.shield_outlined, size: 17, color: mac.warning),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 9,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      'Fail-closed payment boundary',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: mac.warning.withValues(alpha: .1),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        status,
                        style: Theme.of(context).textTheme.labelSmall
                            ?.copyWith(color: mac.warning),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  'This Mac workspace cannot authorize or submit a payment. Only verified signed receipts and independent provider reconciliation can establish payment state.${trustPolicyLoaded ? ' A reviewed signer policy is visible for inspection.' : ''}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PaymentTableHeader extends StatelessWidget {
  const _PaymentTableHeader({required this.section});

  final _PaymentSection section;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final style = Theme.of(context).textTheme.labelSmall;
    return LayoutBuilder(
      builder: (context, constraints) {
        final showSecondary = constraints.maxWidth >= 520;
        return Container(
          height: 33,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: mac.toolbar,
            border: Border(bottom: BorderSide(color: mac.divider)),
          ),
          child: Row(
            children: [
              const SizedBox(width: 24),
              Expanded(
                flex: 5,
                child: Text(switch (section) {
                  _PaymentSection.mandates => 'MERCHANT / MANDATE',
                  _PaymentSection.signers => 'HARDWARE SIGNER',
                  _PaymentSection.evidence => 'PAYMENT EVIDENCE',
                }, style: style),
              ),
              if (showSecondary)
                SizedBox(
                  width: 132,
                  child: Text(switch (section) {
                    _PaymentSection.mandates => 'TOTAL',
                    _PaymentSection.signers => 'ATTESTATION',
                    _PaymentSection.evidence => 'AMOUNT',
                  }, style: style),
                ),
              SizedBox(width: 116, child: Text('STATE', style: style)),
            ],
          ),
        );
      },
    );
  }
}

class _PaymentTableRow extends StatelessWidget {
  const _PaymentTableRow({
    super.key,
    required this.section,
    required this.value,
    required this.selected,
    required this.onSelect,
  });

  final _PaymentSection section;
  final _Json value;
  final bool selected;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final summary = _rowSummary(context, section, value);
    final state = _paymentState(section, value);
    final stateColor = _stateColor(context, state);
    return Semantics(
      button: true,
      selected: selected,
      label: '${summary.title}, ${summary.secondary}, ${_humanize(state)}',
      hint: 'Select to inspect the exact read-only record.',
      child: Material(
        color: selected ? mac.selection : Colors.transparent,
        child: InkWell(
          onTap: onSelect,
          canRequestFocus: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: mac.divider)),
            ),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final showSecondary = constraints.maxWidth >= 492;
                return Row(
                  children: [
                    SizedBox(
                      width: 24,
                      child: Icon(summary.icon, size: 15, color: summary.color),
                    ),
                    Expanded(
                      flex: 5,
                      child: Padding(
                        padding: const EdgeInsets.only(right: 14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              summary.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodyMedium
                                  ?.copyWith(fontWeight: FontWeight.w600),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              showSecondary
                                  ? summary.subtitle
                                  : '${summary.secondary} · ${summary.subtitle}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (showSecondary)
                      SizedBox(
                        width: 132,
                        child: Text(
                          summary.secondary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                    SizedBox(
                      width: 116,
                      child: Row(
                        children: [
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: stateColor,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 7),
                          Flexible(
                            child: Text(
                              _humanize(state),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.labelMedium
                                  ?.copyWith(color: stateColor),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  ({
    String title,
    String subtitle,
    String secondary,
    IconData icon,
    Color color,
  })
  _rowSummary(BuildContext context, _PaymentSection section, _Json value) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    return switch (section) {
      _PaymentSection.mandates => () {
        final terms = _map(value['terms']);
        final merchant = _map(terms['merchant']);
        final totals = _map(terms['totals']);
        return (
          title: merchant['name']?.toString() ?? 'Purchase mandate',
          subtitle:
              'Order ${terms['merchantOrderId'] ?? _short(value['reviewId']?.toString())}',
          secondary: _money(totals['totalAmountMinor'], totals['currency']),
          icon: Icons.receipt_long_outlined,
          color: mac.warning,
        );
      }(),
      _PaymentSection.signers => (
        title: value['signerProfile']?.toString() ?? 'Hardware signer',
        subtitle: 'AAGUID ${value['aaguid'] ?? 'unavailable'}',
        secondary: value['attestationFormat']?.toString() ?? 'Unknown',
        icon: value['state'] == 'active'
            ? Icons.key_rounded
            : Icons.key_off_outlined,
        color: value['state'] == 'active' ? mac.positive : scheme.error,
      ),
      _PaymentSection.evidence => (
        title:
            value['merchantName']?.toString() ??
            'Transaction ${_short(value['transactionId']?.toString())}',
        subtitle:
            'Revision ${value['lifecycleRevision'] ?? '—'} · ${_formatDate(value['updatedAt'])}',
        secondary: _money(
          value['amountMinor'] ?? value['totalAmountMinor'],
          value['currency'],
        ),
        icon: Icons.fact_check_outlined,
        color: scheme.primary,
      ),
    };
  }
}

class _PaymentEmptyState extends StatelessWidget {
  const _PaymentEmptyState({required this.section});

  final _PaymentSection section;

  @override
  Widget build(BuildContext context) => MacosEmptyState(
    icon: switch (section) {
      _PaymentSection.mandates => Icons.receipt_long_outlined,
      _PaymentSection.signers => Icons.key_off_outlined,
      _PaymentSection.evidence => Icons.fact_check_outlined,
    },
    title: switch (section) {
      _PaymentSection.mandates => 'No mandates awaiting review',
      _PaymentSection.signers => 'No hardware signers registered',
      _PaymentSection.evidence => 'No reconciled payment evidence',
    },
    message: switch (section) {
      _PaymentSection.mandates => 'A purchase mandate will appear only when exact merchant terms require human review.',
      _PaymentSection.signers => 'This view stays read-only. Signer registration is not available from the macOS client.',
      _PaymentSection.evidence => 'Only verified signed receipts and independent provider observations populate this ledger.',
    },
  );
}

class _PaymentInspector extends StatelessWidget {
  const _PaymentInspector({required this.section, required this.value});

  final _PaymentSection section;
  final _Json? value;

  @override
  Widget build(BuildContext context) {
    final item = value;
    if (item == null) {
      return MacosEmptyState(
        icon: Icons.manage_search_outlined,
        title: 'Select ${_sectionSingular(section)}',
        message: 'The exact read-only record and its trust boundary will remain visible here.',
      );
    }
    return Scrollbar(
      child: ListView(
        key: const Key('macos-payments-inspector'),
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 30),
        children: [
          switch (section) {
            _PaymentSection.mandates => _MandateInspector(value: item),
            _PaymentSection.signers => _SignerInspector(value: item),
            _PaymentSection.evidence => _EvidenceInspector(value: item),
          },
        ],
      ),
    );
  }
}

class _MandateInspector extends StatelessWidget {
  const _MandateInspector({required this.value});

  final _Json value;

  @override
  Widget build(BuildContext context) {
    final terms = _map(value['terms']);
    final merchant = _map(terms['merchant']);
    final totals = _map(terms['totals']);
    final instrument = _map(terms['paymentInstrument']);
    final shipping = _map(terms['shipping']);
    final items = (terms['items'] as List? ?? const [])
        .whereType<Map>()
        .map(_Json.from)
        .toList(growable: false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _InspectorTitle(
          icon: Icons.receipt_long_outlined,
          eyebrow: 'PURCHASE MANDATE',
          title: merchant['name']?.toString() ?? 'Purchase review',
          state: value['state']?.toString() ?? 'pending',
        ),
        const SizedBox(height: 22),
        _InspectorDefinition(
          rows: [
            (
              'Exact total',
              _money(totals['totalAmountMinor'], totals['currency']),
            ),
            ('Order', terms['merchantOrderId']?.toString() ?? '—'),
            ('Expires', _formatDate(terms['expiresAt'], includeTime: true)),
            ('Instrument', instrument['description']?.toString() ?? '—'),
            ('Ship to', _shippingSummary(shipping)),
          ],
        ),
        const SizedBox(height: 22),
        _InspectorLabel('BOUND ITEMS'),
        const SizedBox(height: 7),
        if (items.isEmpty)
          Text(
            'No item summary available.',
            style: Theme.of(context).textTheme.bodySmall,
          )
        else
          for (final item in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      '${item['quantity'] ?? 1} × ${item['title'] ?? 'Item'}',
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(_money(item['totalAmountMinor'], totals['currency'])),
                ],
              ),
            ),
        const SizedBox(height: 20),
        _DigestField(
          label: 'EXACT TERMS SHA-256',
          value: value['exactTermsSha256']?.toString(),
        ),
        const SizedBox(height: 18),
        const _InspectorBoundary(
          text: 'Review only. A visible mandate does not authorize payment. Human-present hardware verification and deterministic checks are still required on the trusted surface.',
        ),
      ],
    );
  }
}

class _SignerInspector extends StatelessWidget {
  const _SignerInspector({required this.value});

  final _Json value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _InspectorTitle(
        icon: Icons.key_outlined,
        eyebrow: 'HARDWARE SIGNER',
        title: value['signerProfile']?.toString() ?? 'Payment signer',
        state: value['state']?.toString() ?? 'unknown',
      ),
      const SizedBox(height: 22),
      _InspectorDefinition(
        rows: [
          ('Attestation', value['attestationFormat']?.toString() ?? '—'),
          ('AAGUID', value['aaguid']?.toString() ?? '—'),
          ('Revision', value['lifecycleRevision']?.toString() ?? '—'),
          ('Created', _formatDate(value['createdAt'], includeTime: true)),
          ('Last used', _formatDate(value['lastUsedAt'], includeTime: true)),
          ('Revoked', _formatDate(value['revokedAt'], includeTime: true)),
        ],
      ),
      const SizedBox(height: 20),
      _DigestField(
        label: 'CREDENTIAL REFERENCE',
        value: value['credentialId']?.toString(),
      ),
      const SizedBox(height: 14),
      _DigestField(
        label: 'TRUST POLICY SHA-256',
        value: value['trustPolicySha256']?.toString(),
      ),
      const SizedBox(height: 18),
      const _InspectorBoundary(
        text: 'Credential material is never shown to Asael, an agent, or a model. This workspace exposes only an instrument summary and cannot register, revoke, or invoke a signer.',
      ),
    ],
  );
}

class _EvidenceInspector extends StatelessWidget {
  const _EvidenceInspector({required this.value});

  final _Json value;

  @override
  Widget build(BuildContext context) {
    final status = _paymentState(_PaymentSection.evidence, value);
    final discrepancies = (value['discrepancyCodes'] as List? ?? const [])
        .map((item) => item.toString())
        .where((item) => item.isNotEmpty)
        .toList(growable: false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _InspectorTitle(
          icon: Icons.fact_check_outlined,
          eyebrow: 'RECONCILED EVIDENCE',
          title:
              value['merchantName']?.toString() ??
              'Payment ${_short(value['transactionId']?.toString())}',
          state: status,
        ),
        const SizedBox(height: 22),
        Text(
          _money(
            value['amountMinor'] ?? value['totalAmountMinor'],
            value['currency'],
          ),
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 20),
        _InspectorLabel('LIFECYCLE'),
        const SizedBox(height: 7),
        _LifecycleRow(label: 'Checkout', value: value['checkoutState']),
        _LifecycleRow(label: 'Payment', value: value['paymentState']),
        _LifecycleRow(
          label: 'Authorization',
          value: value['authorizationState'],
        ),
        _LifecycleRow(label: 'Capture', value: value['captureState']),
        _LifecycleRow(label: 'Settlement', value: value['settlementState']),
        _LifecycleRow(label: 'Refund', value: value['refundState']),
        _LifecycleRow(label: 'Dispute', value: value['disputeState']),
        _LifecycleRow(label: 'Fulfillment', value: value['fulfillmentState']),
        if (discrepancies.isNotEmpty) ...[
          const SizedBox(height: 18),
          _InspectorLabel('DISCREPANCIES'),
          const SizedBox(height: 7),
          for (final code in discrepancies)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Icon(
                    Icons.warning_amber_rounded,
                    size: 15,
                    color: MacosThemeColors.of(context).warning,
                  ),
                  const SizedBox(width: 7),
                  Expanded(child: Text(_humanize(code))),
                ],
              ),
            ),
        ],
        const SizedBox(height: 20),
        _DigestField(
          label: 'TRANSACTION REFERENCE',
          value: value['transactionId']?.toString(),
        ),
        const SizedBox(height: 14),
        _DigestField(
          label: 'PROJECTION SHA-256',
          value: value['projectionSha256']?.toString(),
        ),
        const SizedBox(height: 18),
        const _InspectorBoundary(
          text: 'Evidence-derived state only. Browser output, model claims, and remote success messages never establish that a payment is authorized, paid, or settled.',
        ),
      ],
    );
  }
}

class _InspectorTitle extends StatelessWidget {
  const _InspectorTitle({
    required this.icon,
    required this.eyebrow,
    required this.title,
    required this.state,
  });

  final IconData icon;
  final String eyebrow, title, state;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final color = _stateColor(context, state);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: mac.selection,
            borderRadius: BorderRadius.circular(9),
          ),
          child: Icon(
            icon,
            size: 18,
            color: Theme.of(context).colorScheme.primary,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(eyebrow, style: Theme.of(context).textTheme.labelSmall),
              const SizedBox(height: 3),
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 6),
              Row(
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: color,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _humanize(state),
                    style: Theme.of(context).textTheme.labelMedium
                        ?.copyWith(color: color),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _InspectorDefinition extends StatelessWidget {
  const _InspectorDefinition({required this.rows});

  final List<(String, String)> rows;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (final row in rows)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 92,
                child: Text(
                  row.$1,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              Expanded(
                child: Text(
                  row.$2,
                  textAlign: TextAlign.right,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            ],
          ),
        ),
    ],
  );
}

class _InspectorLabel extends StatelessWidget {
  const _InspectorLabel(this.value);

  final String value;

  @override
  Widget build(BuildContext context) =>
      Text(value, style: Theme.of(context).textTheme.labelSmall);
}

class _DigestField extends StatelessWidget {
  const _DigestField({required this.label, required this.value});

  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _InspectorLabel(label),
        const SizedBox(height: 6),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(9),
          decoration: BoxDecoration(
            color: mac.canvas,
            border: Border.all(color: mac.divider),
            borderRadius: BorderRadius.circular(6),
          ),
          child: SelectableText(
            value == null || value!.isEmpty ? 'Unavailable' : value!,
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(fontFamily: 'monospace', fontSize: 11.5),
          ),
        ),
      ],
    );
  }
}

class _LifecycleRow extends StatelessWidget {
  const _LifecycleRow({required this.label, required this.value});

  final String label;
  final Object? value;

  @override
  Widget build(BuildContext context) {
    final state = value?.toString() ?? 'unknown';
    final color = _stateColor(context, state);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(label)),
          Text(
            _humanize(state),
            style: Theme.of(context).textTheme.labelMedium
                ?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}

class _InspectorBoundary extends StatelessWidget {
  const _InspectorBoundary({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: mac.warning.withValues(alpha: .07),
        border: Border.all(color: mac.warning.withValues(alpha: .35)),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.lock_outline_rounded, size: 16, color: mac.warning),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: Theme.of(context).textTheme.bodySmall),
          ),
        ],
      ),
    );
  }
}

class _PaymentRefreshNotice extends StatelessWidget {
  const _PaymentRefreshNotice({
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
                  ? 'Showing the last available payment evidence. The latest refresh did not complete.'
                  : 'Payment evidence is unavailable. ${error.toString()}',
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

String _itemId(_PaymentSection section, _Json value) => switch (section) {
  _PaymentSection.mandates =>
    value['reviewId']?.toString() ??
        value['exactTermsSha256']?.toString() ??
        '',
  _PaymentSection.signers =>
    value['credentialId']?.toString() ?? value['aaguid']?.toString() ?? '',
  _PaymentSection.evidence =>
    value['transactionId']?.toString() ??
        value['projectionSha256']?.toString() ??
        '',
};

String _searchText(_PaymentSection section, _Json value) {
  final terms = _map(value['terms']);
  final merchant = _map(terms['merchant']);
  return switch (section) {
    _PaymentSection.mandates => [
      merchant['name'],
      terms['merchantOrderId'],
      value['state'],
      value['reviewId'],
    ],
    _PaymentSection.signers => [
      value['signerProfile'],
      value['attestationFormat'],
      value['aaguid'],
      value['state'],
      value['credentialId'],
    ],
    _PaymentSection.evidence => [
      value['merchantName'],
      value['canonicalStatus'],
      value['transactionId'],
      value['currency'],
    ],
  }.whereType<Object>().map((item) => item.toString().toLowerCase()).join(' ');
}

String _paymentState(_PaymentSection section, _Json value) => switch (section) {
  _PaymentSection.mandates => value['state']?.toString() ?? 'pending',
  _PaymentSection.signers => value['state']?.toString() ?? 'unknown',
  _PaymentSection.evidence =>
    value['canonicalStatus']?.toString() ??
        value['state']?.toString() ??
        value['status']?.toString() ??
        'recorded',
};

Color _stateColor(BuildContext context, String state) {
  final mac = MacosThemeColors.of(context);
  return switch (state) {
    'active' ||
    'authorized' ||
    'accepted' ||
    'paid' ||
    'settled' ||
    'fulfilled' ||
    'completed' => mac.positive,
    'pending' ||
    'awaiting_receipt' ||
    'processing' ||
    'requested' ||
    'partial' ||
    'partially_refunded' => mac.warning,
    'rejected' ||
    'declined' ||
    'failed' ||
    'discrepancy' ||
    'disputed' ||
    'revoked' ||
    'expired' ||
    'superseded' => Theme.of(context).colorScheme.error,
    _ => Theme.of(context).colorScheme.onSurfaceVariant,
  };
}

String _sectionSingular(_PaymentSection section) => switch (section) {
  _PaymentSection.mandates => 'a mandate',
  _PaymentSection.signers => 'a signer',
  _PaymentSection.evidence => 'payment evidence',
};

String _sectionLabel(_PaymentSection section) => switch (section) {
  _PaymentSection.mandates => 'Mandates',
  _PaymentSection.signers => 'Signers',
  _PaymentSection.evidence => 'Evidence',
};

IconData _sectionIcon(_PaymentSection section) => switch (section) {
  _PaymentSection.mandates => Icons.receipt_long_outlined,
  _PaymentSection.signers => Icons.key_outlined,
  _PaymentSection.evidence => Icons.fact_check_outlined,
};

String _shippingSummary(_Json value) {
  if (value.isEmpty) return '—';
  return [
    value['recipientName'],
    value['city'],
    value['country'],
  ].whereType<Object>().map((item) => item.toString()).join(', ');
}

_Json _map(Object? value) =>
    value is Map ? _Json.from(value) : <String, dynamic>{};

String _humanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _short(String? value) => value == null || value.isEmpty
    ? '—'
    : value.length <= 16
    ? value
    : '${value.substring(0, 8)}…${value.substring(value.length - 5)}';

String _money(Object? minor, Object? currency) {
  final amount = (minor as num?)?.toInt();
  if (amount == null) return 'Amount unavailable';
  return '${currency ?? ''} ${(amount / 100).toStringAsFixed(2)}'.trim();
}

String _formatDate(Object? value, {bool includeTime = false}) {
  final parsed = value == null ? null : DateTime.tryParse(value.toString());
  if (parsed == null) return '—';
  final local = parsed.toLocal();
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final date = '${months[local.month - 1]} ${local.day}, ${local.year}';
  if (!includeTime) return date;
  final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final minute = local.minute.toString().padLeft(2, '0');
  return '$date, $hour:$minute ${local.hour < 12 ? 'AM' : 'PM'}';
}
