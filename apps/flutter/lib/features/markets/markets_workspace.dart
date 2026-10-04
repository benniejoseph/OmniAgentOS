import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import 'markets_contracts.dart';
import 'markets_controller.dart';
import 'markets_panels.dart';
import 'markets_providers.dart';

class NativeMarketsView extends ConsumerStatefulWidget {
  const NativeMarketsView({super.key, this.expectedApi, this.active = true});
  final ApiClient? expectedApi;
  final bool active;
  @override
  ConsumerState<NativeMarketsView> createState() => _NativeMarketsViewState();
}

class _NativeMarketsViewState extends ConsumerState<NativeMarketsView>
    with WidgetsBindingObserver {
  bool _foreground = true;
  MarketsController? _controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _controller?.setActive(widget.active && _foreground);
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.setActive(false, notify: false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final api = ref.watch(apiClientProvider),
        c = ref.watch(marketsControllerProvider);
    if (!identical(_controller, c)) {
      _controller?.setActive(false, notify: false);
      _controller = c;
    }
    final active =
        widget.active &&
        _foreground &&
        TickerMode.valuesOf(context).enabled &&
        (widget.expectedApi == null || identical(widget.expectedApi, api));
    if (!active) c.setActive(false, notify: false);
    if (active != c.active) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && identical(_controller, c)) c.setActive(active);
      });
    }
    return Scaffold(
      body: SafeArea(
        child: !active || !c.readable
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'Markets requires the current unlocked account and API session.',
                  ),
                ),
              )
            : _MarketWorkspace(
                key: ValueKey(c.repository.access.owner!.key),
                controller: c,
              ),
      ),
    );
  }
}

class _MarketWorkspace extends StatefulWidget {
  const _MarketWorkspace({super.key, required this.controller});
  final MarketsController controller;
  @override
  State<_MarketWorkspace> createState() => _MarketWorkspaceState();
}

class _MarketWorkspaceState extends State<_MarketWorkspace> {
  late final TextEditingController start, end;
  MarketsController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    start = TextEditingController(text: c.startDate);
    end = TextEditingController(text: c.endDate);
    start.addListener(() => c.startDate = start.text);
    end.addListener(() => c.endDate = end.text);
  }

  @override
  void dispose() {
    start.dispose();
    end.dispose();
    super.dispose();
  }

  Future<void> inspect(String title, Object? data) {
    final expected = c, owner = c.repository.access.owner?.key;
    return showDialog<void>(
      context: context,
      builder: (context) => Consumer(
        builder: (context, ref, _) {
          final live = ref.watch(marketsControllerProvider),
              allowed =
                  identical(live, expected) &&
                  live.readable &&
                  live.repository.access.owner?.key == owner;
          return AlertDialog(
            title: Text(title),
            scrollable: true,
            content: SizedBox(
              width: 720,
              child: allowed
                  ? SelectableText(
                      const JsonEncoder.withIndent('  ').convert(data),
                    )
                  : const Text(
                      'Inspection is hidden until the current account is verified.',
                    ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Close inspection'),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> confirm(String action, MarketJson body) async {
    final owner = c.repository.access.owner?.key;
    if (!c.canSubmit(action)) return;
    final expected = c;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => Consumer(
        builder: (context, ref, _) {
          final live = ref.watch(marketsControllerProvider),
              allowed =
                  identical(live, expected) &&
                  live.readable &&
                  live.repository.access.owner?.key == owner &&
                  live.canSubmit(action);
          return AlertDialog(
            title: Text(switch (action) {
              'backtest' => 'Run retrospective backtest?',
              'events' => 'Import official release history?',
              'replays' => 'Build historical event replays?',
              'score' => 'Score up to two due forecasts?',
              _ => 'Generate $action research forecast?',
            }),
            scrollable: true,
            content: SizedBox(
              width: 640,
              child: !allowed
                  ? const Text(
                      'This decision is no longer current. Close it before another action.',
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text(
                          'This starts governed server work. Provider requests and model usage may occur. The exact submitted decision is saved before dispatch. An uncertain response is held for inspection and is never automatically retried.',
                        ),
                        const SizedBox(height: 16),
                        SelectableText(
                          const JsonEncoder.withIndent('  ').convert(body),
                        ),
                      ],
                    ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: allowed ? () => Navigator.pop(context, true) : null,
                child: const Text('Confirm exact request'),
              ),
            ],
          );
        },
      ),
    );
    if (accepted == true &&
        mounted &&
        owner == c.repository.access.owner?.key &&
        c.canSubmit(action)) {
      await c.submit(action, body);
    }
  }

  Future<void> backtest(MarketJson configuration) async {
    final snapshot = c.data('snapshot');
    if (snapshot == null) return;
    await confirm('backtest', {
      'snapshotId': snapshot['snapshotId'],
      'strategy': {
        'strategyId': 'foundation.liquidity_sweep_reversal.v1',
        'direction': configuration['direction'],
        'session': configuration['session'],
        'rewardRiskRatio': configuration['rewardRiskRatio'],
        'maxHoldingBars': configuration['maxHoldingBars'],
        'stopBufferRangeMultiplier': 0.1,
      },
      'costs': {
        'spreadBps': configuration['spreadBps'],
        'slippageBps': configuration['slippageBps'],
        'commissionBps': configuration['commissionBps'],
      },
      'initialEquity': 10000,
      'riskPerTradeBps': configuration['riskPerTradeBps'],
    });
  }

  void datedAction(String action) {
    final first = start.text.trim(), last = end.text.trim();
    bool valid(String text) =>
        RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(text) &&
        DateTime.tryParse('${text}T00:00:00Z')
                ?.toIso8601String()
                .substring(0, 10) ==
            text;
    if (!valid(first) || !valid(last) || first.compareTo(last) > 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Choose real ordered dates in YYYY-MM-DD format.'),
        ),
      );
      return;
    }
    unawaited(
      confirm(action, {
        'startDate': first,
        'endDate': last,
        if (action == 'replays') ...{
          'instrumentId': c.instrumentId,
          'interval': '5min',
          'maxEvents': 12,
        },
      }),
    );
  }

  Widget notice(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(text),
  );
  Widget state(String kind, {required Widget Function(MarketJson) ready}) {
    final data = c.data(kind);
    if (c.loading.contains(kind)) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: LinearProgressIndicator(),
      );
    }
    if (c.failures[kind] case final String error) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          notice(error),
          OutlinedButton(
            onPressed: () => c.refresh(kind),
            child: const Text('Refresh read'),
          ),
        ],
      );
    }
    if (data == null) {
      return notice('This source has not been read for the current selection.');
    }
    return ready(data);
  }

  Widget rows(
    String label,
    List<MarketJson> items,
    String Function(MarketJson) title, {
    String? detail,
  }) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: 20, bottom: 8),
        child: Text(label, style: Theme.of(context).textTheme.titleLarge),
      ),
      if (detail != null) notice(detail),
      if (items.isEmpty) notice('No records in this successful bounded read.'),
      for (final row in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: ListTile(
            contentPadding: const EdgeInsets.all(12),
            shape: RoundedRectangleBorder(
              side: BorderSide(color: Theme.of(context).dividerColor),
              borderRadius: BorderRadius.circular(12),
            ),
            title: Text(title(row)),
            subtitle: Text(
              (row['id'] ??
                      row['eventId'] ??
                      row['eventKey'] ??
                      row['snapshotId'] ??
                      '')
                  .toString(),
            ),
            onTap: () => inspect(label, row),
            trailing: const Icon(Icons.chevron_right),
          ),
        ),
    ],
  );
  Widget snapshots() => state(
    'snapshots',
    ready: (data) {
      final items = marketRows(data['snapshots'], 40),
          selected = c.data('snapshot')?['snapshotId'];
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          notice(
            items.isEmpty
                ? 'No stored snapshots for this instrument and interval. Fetch provider evidence explicitly to create one.'
                : '${items.length} stored snapshots shown${data['hasMore'] == true ? '; more history exists' : ''}. Select an exact snapshot.',
          ),
          for (final item in items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              selected: selected == item['snapshotId'],
              title: Text('${item['asOf']} · ${item['barCount']} bars'),
              subtitle: Text(
                '${item['providerSymbol']} · ${item['snapshotId']}',
              ),
              onTap: () => c.selectSnapshot(item),
              trailing: Icon(
                selected == item['snapshotId']
                    ? Icons.check_circle
                    : Icons.chevron_right,
              ),
            ),
        ],
      );
    },
  );
  Widget events() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      state(
        'events',
        ready: (data) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            marketEventsPanel(events: data),
            rows(
              'Exact release evidence',
              marketRows(data['events'], 100),
              (row) =>
                  '${row['name']} · ${row['releaseDate']} · ${row['timestampPrecision']}',
            ),
          ],
        ),
      ),
      state(
        'replays',
        ready: (data) => rows(
          'Historical event replays',
          marketRows(data['replays'], 100),
          (row) =>
              '${row['eventKey']} · ${row['occurredAt']} · ${row['direction']}',
          detail:
              '${data['replayedEvents']} replayed / ${data['eligibleEvents']} eligible; ${data['remainingEvents']} remaining. Only the returned window is listed.',
        ),
      ),
      state(
        'baselines',
        ready: (data) => rows(
          'Descriptive baselines',
          marketRows(data['groups'], 50),
          (row) =>
              '${row['eventKey']} · ${row['sampleSize']} samples · ${row['state']}',
          detail: 'At most 500 stored replays. Descriptive history is not a predictive probability.',
        ),
      ),
      const SizedBox(height: 16),
      OutlinedButton.icon(
        onPressed: c.loading.contains('calendar')
            ? null
            : () => c.refresh('calendar'),
        icon: const Icon(Icons.calendar_month_outlined),
        label: const Text('Fetch official calendar'),
      ),
      notice(
        'Calendar refresh contacts official sources. A source failure is separate from an empty calendar.',
      ),
      if (c.data('calendar') != null ||
          c.failures.containsKey('calendar') ||
          c.loading.contains('calendar'))
        state(
          'calendar',
          ready: (data) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final source in marketRows(data['sourceHealth'], 4))
                notice(
                  '${source['source']}: ${source['status']} — ${source['note']}',
                ),
              rows(
                'Official calendar',
                marketRows(data['events'], 120),
                (row) =>
                    '${row['name'] ?? row['eventKey']} · ${row['releaseDate']} · ${row['timestampPrecision']}',
              ),
            ],
          ),
        ),
      const SizedBox(height: 16),
      Text(
        'Historical date window',
        style: Theme.of(context).textTheme.titleLarge,
      ),
      Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          SizedBox(
            width: 250,
            child: TextField(
              controller: start,
              decoration: const InputDecoration(
                labelText: 'Start date YYYY-MM-DD',
              ),
            ),
          ),
          SizedBox(
            width: 250,
            child: TextField(
              controller: end,
              decoration: const InputDecoration(
                labelText: 'End date YYYY-MM-DD',
              ),
            ),
          ),
        ],
      ),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          OutlinedButton(
            onPressed: c.canSubmit('events')
                ? () => datedAction('events')
                : null,
            child: const Text('Review history import'),
          ),
          OutlinedButton(
            onPressed: c.canSubmit('replays')
                ? () => datedAction('replays')
                : null,
            child: const Text('Review replay build'),
          ),
        ],
      ),
    ],
  );
  Widget technical() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (c.data('snapshot') == null)
        snapshots()
      else
        state(
          'features',
          ready: (features) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              marketTechnicalPanel(
                bars: c.data('snapshot')!,
                features: features,
              ),
              rows(
                'Exact detector evidence',
                marketRows(features['detections'], 240),
                (row) =>
                    '${row['kind']} · ${row['reviewState']} · ${row['state']}',
              ),
            ],
          ),
        ),
      state(
        'analysis',
        ready: (data) => rows(
          'Saved analysis versions',
          marketRows(data['versions'], 40),
          (row) =>
              '${row['savedAt']} · ${row['candidateCount']} review candidates',
          detail:
              '${data['total']} total; bounded metadata only. Browser chart plugin state is not loaded or executed.',
        ),
      ),
    ],
  );
  Widget backtests() => state(
    'backtests',
    ready: (data) {
      final items = marketRows(data['backtests'], 20),
          chosen = items
              .where((row) => row['id'] == c.selectedBacktestId)
              .toList();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          notice(
            '${items.length} of ${data['total']} immutable results shown. Select an exact result to inspect its metrics. These are retrospective experiments.',
          ),
          for (final item in items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              selected: item['id'] == c.selectedBacktestId,
              title: Text('${item['createdAt']} · ${item['id']}'),
              subtitle: Text('Snapshot ${item['snapshotId']}'),
              onTap: () =>
                  setState(() => c.selectedBacktestId = item['id'] as String),
              trailing: IconButton(
                tooltip: 'Inspect exact result',
                onPressed: () => inspect('Backtest result and manifest', item),
                icon: const Icon(Icons.fact_check_outlined),
              ),
            ),
          marketBacktestPanel(
            key: ValueKey('backtest:${c.instrumentId}'),
            bars: c.data('snapshot'),
            backtests: {...data, 'backtests': chosen},
            job: null,
            configuration: c.backtestDrafts[c.instrumentId],
            onConfigurationChanged: (value) =>
                c.backtestDrafts[c.instrumentId] = marketFreeze(value),
            blocked: !c.canSubmit('backtest'),
            onRun: backtest,
          ),
          if (c.data('snapshot') == null) snapshots(),
        ],
      );
    },
  );
  Widget journal() => state(
    'journal',
    ready: (data) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        notice(
          'The scorecard covers this returned window only. Scenarios are uncalibrated research; no trade execution is available.',
        ),
        marketJournalPanel(
          journal: data,
          blocked:
              !c.canSubmit('daily') ||
              !c.canSubmit('weekly') ||
              !c.canSubmit('score'),
          onAction: (action) => confirm(action, {
            'instrumentId': c.instrumentId,
            if (action == 'score') 'maxForecasts': 2 else 'horizon': action,
          }),
        ),
        rows(
          'Forecast evidence and resolution',
          marketRows(data['entries'], 40),
          (row) =>
              '${marketMap(row['forecast'])['horizon']} · ${row['resolutionState']} · ${marketMap(row['forecast'])['id']}',
        ),
      ],
    ),
  );
  Widget receipts() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (c.recoveryError != null) notice(c.recoveryError!),
      if (c.unresolved)
        notice(
          'A prior request has an uncertain outcome. New actions are held. Reading evidence never resubmits that request or creates another child job.',
        ),
      if (!c.recoveryReady)
        OutlinedButton(
          onPressed: c.initialize,
          child: const Text('Reload protected intent state'),
        ),
      for (final intent in c.intents.reversed)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${intent['action']} · ${intent['state']}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                SelectableText('${intent['createdAt']}\n${intent['key']}'),
                if (intent['job'] != null)
                  notice(
                    'Job ${marketMap(intent['job'])['id']} · ${marketMap(intent['job'])['status']}',
                  ),
                if (c.failures['job:${intent['key']}'] != null)
                  notice(c.failures['job:${intent['key']}']!),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: () => inspect(
                        'Exact submitted decision and receipt',
                        intent,
                      ),
                      child: const Text('Inspect exact receipt'),
                    ),
                    if (intent['job'] != null)
                      OutlinedButton(
                        onPressed: () => c.inspectJob(intent),
                        child: const Text('Refresh job status'),
                      ),
                    if (intent['state'] == 'accepted' &&
                        (intent['job'] == null ||
                            [
                              'completed',
                              'failed',
                              'canceled',
                            ].contains(marketMap(intent['job'])['status'])))
                      TextButton(
                        onPressed: () =>
                            c.dismissAccepted(intent['key'] as String),
                        child: const Text('Dismiss completed receipt'),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
    ],
  );
  @override
  Widget build(BuildContext context) {
    final overview = c.data('overview'),
        instruments = overview == null
            ? <MarketJson>[]
            : marketRows(overview['instruments'], 20);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyR, meta: true): () =>
            c.refreshTab(),
        const SingleActivator(LogicalKeyboardKey.keyR, control: true): () =>
            c.refreshTab(),
      },
      child: Focus(
        autofocus: true,
        child: ListView(
          key: const PageStorageKey('markets-workspace-scroll'),
          padding: const EdgeInsets.all(20),
          children: [
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              spacing: 16,
              runSpacing: 12,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Markets',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const Text('Evidence-led research · no trade execution'),
                  ],
                ),
                OutlinedButton.icon(
                  onPressed: c.refreshTab,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh stored reads'),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                if (instruments.isNotEmpty)
                  SizedBox(
                    width: 280,
                    child: DropdownButtonFormField<String>(
                      initialValue:
                          instruments.any(
                            (row) => row['instrumentId'] == c.instrumentId,
                          )
                          ? c.instrumentId
                          : null,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        labelText: 'Exact instrument',
                      ),
                      items: [
                        for (final item in instruments)
                          DropdownMenuItem(
                            value: item['instrumentId'] as String,
                            child: Text(
                              item['label'] as String,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      onChanged: (value) {
                        if (value != null) c.selectMarket(value, c.interval);
                      },
                    ),
                  ),
                SizedBox(
                  width: 150,
                  child: DropdownButtonFormField<String>(
                    initialValue: c.interval,
                    decoration: const InputDecoration(labelText: 'Interval'),
                    items: [
                      for (final value in ['5min', '15min', '1h'])
                        DropdownMenuItem(value: value, child: Text(value)),
                    ],
                    onChanged: (value) {
                      if (value != null) c.selectMarket(c.instrumentId, value);
                    },
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: c.loading.contains('bars')
                      ? null
                      : c.providerRefresh,
                  icon: const Icon(Icons.cloud_download_outlined),
                  label: const Text('Fetch provider snapshot'),
                ),
              ],
            ),
            for (final item in instruments.where(
              (row) => row['instrumentId'] == c.instrumentId,
            ))
              notice(item['identityWarning'] as String),
            notice(
              'Stored snapshots retain their source time. Provider refresh may serve a recent cache or contact Twelve Data. No price is labeled live.',
            ),
            if (c.failures['bars'] != null) notice(c.failures['bars']!),
            if (c.loading.contains('bars')) const LinearProgressIndicator(),
            if (c.data('snapshot') case final MarketJson snapshot)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  Text('Selected evidence as of ${snapshot['asOf']}'),
                  TextButton(
                    onPressed: () => inspect('Exact price snapshot', snapshot),
                    child: const Text('Inspect selected snapshot'),
                  ),
                ],
              ),
            const SizedBox(height: 12),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final (index, label) in [
                    'Overview',
                    'Events',
                    'Technical',
                    'Backtests',
                    'Journal',
                  ].indexed)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: Text(label),
                        ),
                        selected: c.tab == index,
                        onSelected: (_) => c.selectTab(index),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            switch (c.tab) {
              1 => events(),
              2 => technical(),
              3 => backtests(),
              4 => journal(),
              _ => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  state(
                    'overview',
                    ready: (data) => marketOverviewPanel(
                      overview: data,
                      bars: c.data('snapshot'),
                    ),
                  ),
                  snapshots(),
                ],
              ),
            },
            const SizedBox(height: 20),
            receipts(),
          ],
        ),
      ),
    );
  }
}
