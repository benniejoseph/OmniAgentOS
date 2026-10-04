import 'dart:math' as math;

import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;

Widget marketOverviewPanel({Json? overview, Json? bars}) =>
    _OverviewTab(overview: overview, bars: bars);
Widget marketEventsPanel({required Json events}) =>
    _EventsTab(events: events, loading: false);
Widget marketTechnicalPanel({required Json bars, required Json features}) =>
    _TechnicalTab(bars: bars, features: features, loading: false);
Widget marketBacktestPanel({
  Key? key,
  Json? bars,
  Json? backtests,
  Json? job,
  Json? configuration,
  ValueChanged<Json>? onConfigurationChanged,
  required bool blocked,
  required ValueChanged<Json> onRun,
}) => _BacktestTab(
  key: key,
  bars: bars,
  backtests: backtests,
  job: job,
  configuration: configuration,
  onConfigurationChanged: onConfigurationChanged,
  loading: false,
  running: blocked,
  onRun: onRun,
);
Widget marketJournalPanel({
  required Json journal,
  required bool blocked,
  required ValueChanged<String> onAction,
}) => _JournalTab(
  journal: journal,
  loading: false,
  action: blocked ? 'unavailable' : null,
  onAction: onAction,
);

class _OverviewTab extends StatelessWidget {
  const _OverviewTab({required this.overview, required this.bars});
  final Json? overview, bars;

  @override
  Widget build(BuildContext context) {
    final values = _barCloses(bars);
    final first = values.isEmpty ? null : values.first;
    final last = values.isEmpty ? null : values.last;
    final change = first == null || last == null || first == 0
        ? null
        : ((last - first) / first) * 100;
    final agent = _map(overview?['agent']);
    final providers = (overview?['providers'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _PriceCanvas(
          values: values,
          last: last,
          change: change,
          asOf: bars?['asOf']?.toString(),
          source: bars?['snapshotSource']?.toString(),
        ),
        const SizedBox(height: 16),
        _SectionTitle(
          title: 'Research engine',
          detail:
              '${agent['name'] ?? 'Meridian'} · ${agent['provider'] ?? 'provider not assigned'} / ${agent['model'] ?? 'model not assigned'}',
        ),
        const SizedBox(height: 8),
        _PlainSurface(
          child: Column(
            children: [
              _EvidenceRow(
                icon: Icons.psychology_outlined,
                title: 'Meridian assignment',
                detail:
                    agent['note']?.toString() ??
                    'Market-research model assignment status is unavailable.',
                status: agent['assignmentState']?.toString() ?? 'unknown',
              ),
              const Divider(height: 1),
              for (var index = 0; index < providers.length; index++) ...[
                _EvidenceRow(
                  icon: providers[index]['configured'] == true
                      ? Icons.check_circle_outline_rounded
                      : Icons.key_off_outlined,
                  title: providers[index]['label']?.toString() ?? 'Provider',
                  detail: providers[index]['purpose']?.toString() ?? '',
                  status: providers[index]['status']?.toString() ?? 'unknown',
                ),
                if (index != providers.length - 1) const Divider(height: 1),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        _SectionTitle(
          title: 'Guardrails',
          detail: 'Evidence boundaries applied to every research result',
        ),
        const SizedBox(height: 8),
        _PlainSurface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final item
                  in (overview?['guardrails'] as List? ?? const []).take(8))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.shield_outlined, size: 17),
                      const SizedBox(width: 9),
                      Expanded(child: Text(item.toString())),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _EventsTab extends StatelessWidget {
  const _EventsTab({required this.events, required this.loading});
  final Json? events;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final items = (events?['events'] as List? ?? const [])
        .whereType<Map>()
        .take(60)
        .toList();
    if (loading && events == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(48),
          child: CircularProgressIndicator(),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionTitle(
          title: 'High-impact USD releases',
          detail:
              '${events?['total'] ?? items.length} official events · exact-time releases are replay eligible',
        ),
        const SizedBox(height: 8),
        if (items.isEmpty)
          const _EmptyState(
            icon: Icons.event_busy_outlined,
            message: 'No official macro events are indexed yet.',
          )
        else
          _PlainSurface(
            child: Column(
              children: [
                for (var index = 0; index < items.length; index++) ...[
                  _EventRow(event: Json.from(items[index])),
                  if (index != items.length - 1) const Divider(height: 1),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _TechnicalTab extends StatelessWidget {
  const _TechnicalTab({
    required this.bars,
    required this.features,
    required this.loading,
  });
  final Json? bars, features;
  final bool loading;
  @override
  Widget build(BuildContext context) {
    if (loading && features == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(48),
          child: CircularProgressIndicator(),
        ),
      );
    }
    final range = _map(features?['range']);
    final time = _map(features?['timeContext']);
    final layers = (features?['layers'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final detections = (features?['detections'] as List? ?? const [])
        .whereType<Map>()
        .take(30)
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _PriceCanvas(
          values: _barCloses(bars),
          last: (range['latestClose'] as num?)?.toDouble(),
          change: null,
          asOf: _map(features?['snapshot'])['asOf']?.toString(),
          source: 'immutable snapshot',
        ),
        const SizedBox(height: 16),
        _SectionTitle(
          title: 'Current structure',
          detail:
              '${_humanize(time['session']?.toString() ?? 'unknown')} · quarter ${time['ninetyMinuteQuarter'] ?? '—'} · ${_humanize(range['zone']?.toString() ?? 'unknown')}',
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final raw in layers)
              _LayerPill(
                label:
                    raw['label']?.toString() ??
                    raw['id']?.toString() ??
                    'Layer',
                count: (raw['count'] as num?)?.toInt() ?? 0,
              ),
          ],
        ),
        const SizedBox(height: 16),
        _SectionTitle(
          title: 'Latest detections',
          detail:
              'Deterministic foundations and clearly marked review candidates',
        ),
        const SizedBox(height: 8),
        if (detections.isEmpty)
          const _EmptyState(
            icon: Icons.layers_clear_outlined,
            message: 'No technical detections in this verified snapshot.',
          )
        else
          _PlainSurface(
            child: Column(
              children: [
                for (var index = 0; index < detections.length; index++) ...[
                  _DetectionRow(detection: Json.from(detections[index])),
                  if (index != detections.length - 1) const Divider(height: 1),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _BacktestTab extends StatefulWidget {
  const _BacktestTab({
    super.key,
    required this.bars,
    required this.backtests,
    required this.job,
    required this.loading,
    required this.running,
    required this.onRun,
    this.configuration,
    this.onConfigurationChanged,
  });
  final Json? bars, backtests, job;
  final bool loading, running;
  final ValueChanged<Json> onRun;
  final Json? configuration;
  final ValueChanged<Json>? onConfigurationChanged;

  @override
  State<_BacktestTab> createState() => _BacktestTabState();
}

class _BacktestTabState extends State<_BacktestTab> {
  String direction = 'both';
  String session = 'all';
  double rewardRiskRatio = 2;
  int maxHoldingBars = 24;
  double spreadBps = 2;
  double slippageBps = 1;
  double commissionBps = 0;
  int riskPerTradeBps = 100;

  @override
  void initState() {
    super.initState();
    final saved = widget.configuration;
    if (saved != null) {
      direction = saved['direction'] as String;
      session = saved['session'] as String;
      rewardRiskRatio = (saved['rewardRiskRatio'] as num).toDouble();
      maxHoldingBars = saved['maxHoldingBars'] as int;
      spreadBps = (saved['spreadBps'] as num).toDouble();
      slippageBps = (saved['slippageBps'] as num).toDouble();
      commissionBps = (saved['commissionBps'] as num).toDouble();
      riskPerTradeBps = saved['riskPerTradeBps'] as int;
    }
  }

  void edit(VoidCallback change) {
    setState(change);
    widget.onConfigurationChanged?.call(configuration);
  }

  Json get configuration => {
    'direction': direction,
    'session': session,
    'rewardRiskRatio': rewardRiskRatio,
    'maxHoldingBars': maxHoldingBars,
    'spreadBps': spreadBps,
    'slippageBps': slippageBps,
    'commissionBps': commissionBps,
    'riskPerTradeBps': riskPerTradeBps,
  };

  @override
  Widget build(BuildContext context) {
    final results = (widget.backtests?['backtests'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    final latest = results.isEmpty ? null : results.first;
    final overall = _map(latest?['metrics'])['overall'];
    final overallMetrics = _map(overall);
    final testMetrics = _map(_map(latest?['metrics'])['test']);
    if (widget.loading && widget.backtests == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(48),
          child: CircularProgressIndicator(),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionTitle(
          title: 'Backtest lab',
          detail: 'Retrospective research · immutable snapshot · no execution',
        ),
        const SizedBox(height: 8),
        _PlainSurface(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.rocket_launch_outlined, size: 24),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Liquidity-sweep reversal · foundation v1',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'A bar trades beyond the exact prior 20-bar boundary and closes back inside. Entry is on the next bar; the last 20% remains held out.',
                            style: TextStyle(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    _BacktestSelect<String>(
                      label: 'Direction',
                      value: direction,
                      values: const {
                        'both': 'Long + short',
                        'long_only': 'Long only',
                        'short_only': 'Short only',
                      },
                      onChanged: (value) => edit(() => direction = value),
                    ),
                    _BacktestSelect<String>(
                      label: 'Session',
                      value: session,
                      values: const {
                        'all': 'All sessions',
                        'london': 'London',
                        'new_york_am': 'New York AM',
                      },
                      onChanged: (value) => edit(() => session = value),
                    ),
                    _BacktestSelect<double>(
                      label: 'Reward / risk',
                      value: rewardRiskRatio,
                      values: {1: '1R', 1.5: '1.5R', 2: '2R', 3: '3R'},
                      onChanged: (value) => edit(() => rewardRiskRatio = value),
                    ),
                    _BacktestSelect<int>(
                      label: 'Max bars held',
                      value: maxHoldingBars,
                      values: const {12: '12', 24: '24', 48: '48', 96: '96'},
                      onChanged: (value) => edit(() => maxHoldingBars = value),
                    ),
                    _BacktestSelect<int>(
                      label: 'Risk / trade',
                      value: riskPerTradeBps,
                      values: const {
                        25: '0.25%',
                        50: '0.50%',
                        100: '1.00%',
                        200: '2.00%',
                      },
                      onChanged: (value) => edit(() => riskPerTradeBps = value),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  'Costs: ${spreadBps.toStringAsFixed(0)} bps spread · ${slippageBps.toStringAsFixed(0)} bps slippage each side · no commission',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: widget.bars == null || widget.running
                      ? null
                      : () => widget.onRun(configuration),
                  icon: Icon(
                    widget.running
                        ? Icons.lock_outline
                        : Icons.play_arrow_rounded,
                  ),
                  label: Text(
                    widget.running
                        ? 'Backtest action unavailable'
                        : 'Review immutable backtest',
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: const [
            _AssurancePill('60 / 20 / 20 chronological'),
            _AssurancePill('Next-bar entry'),
            _AssurancePill('Stop-first collision'),
            _AssurancePill('Single position'),
            _AssurancePill('No model call'),
          ],
        ),
        const SizedBox(height: 18),
        if (latest == null)
          const _EmptyState(
            icon: Icons.history_rounded,
            message: 'Select an exact sealed result above to inspect its metrics. New experiments use the selected immutable snapshot.',
          )
        else ...[
          _SectionTitle(
            title: 'Latest sealed result',
            detail:
                '${_shortDate(latest['createdAt']?.toString())} · ${latest['interval']} · ${overallMetrics['trades'] ?? 0} trades',
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _BacktestMetric(
                label: 'Net result',
                value: _signedR(overallMetrics['netR']),
                detail: 'Overall',
              ),
              _BacktestMetric(
                label: 'Win rate',
                value: _percent(overallMetrics['winRate']),
                detail:
                    '${overallMetrics['wins'] ?? 0} win · ${overallMetrics['losses'] ?? 0} loss',
              ),
              _BacktestMetric(
                label: 'Max drawdown',
                value: _percentValue(overallMetrics['maxDrawdownPercent']),
                detail: 'Fixed fractional risk',
              ),
              _BacktestMetric(
                label: 'Held-out test',
                value: _signedR(testMetrics['netR']),
                detail:
                    '${testMetrics['trades'] ?? 0} trades · ${_percent(testMetrics['winRate'])}',
              ),
            ],
          ),
          const SizedBox(height: 14),
          _BacktestTrades(trades: latest['trades']),
          for (final warning in (latest['warnings'] as List? ?? const []).take(
            4,
          ))
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.warning_amber_rounded, size: 17),
                  const SizedBox(width: 7),
                  Expanded(child: Text(warning.toString())),
                ],
              ),
            ),
        ],
      ],
    );
  }
}

class _BacktestSelect<T> extends StatelessWidget {
  const _BacktestSelect({
    required this.label,
    required this.value,
    required this.values,
    required this.onChanged,
  });
  final String label;
  final T value;
  final Map<T, String> values;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 178,
    child: DropdownButtonFormField<T>(
      initialValue: value,
      isExpanded: true,
      itemHeight: null,
      decoration: InputDecoration(labelText: label, isDense: true),
      items: [
        for (final entry in values.entries)
          DropdownMenuItem(
            value: entry.key,
            child: Text(entry.value, softWrap: true),
          ),
      ],
      onChanged: (next) {
        if (next != null) onChanged(next);
      },
    ),
  );
}

class _AssurancePill extends StatelessWidget {
  const _AssurancePill(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primary.withValues(alpha: .07),
      border: Border.all(
        color: Theme.of(context).colorScheme.primary.withValues(alpha: .18),
      ),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(label, style: const TextStyle(fontSize: 11)),
  );
}

class _BacktestMetric extends StatelessWidget {
  const _BacktestMetric({
    required this.label,
    required this.value,
    required this.detail,
  });
  final String label, value, detail;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 190,
    child: _PlainSurface(
      child: Padding(
        padding: const EdgeInsets.all(13),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
            const SizedBox(height: 3),
            Text(value, style: Theme.of(context).textTheme.titleLarge),
            Text(detail, style: const TextStyle(fontSize: 11)),
          ],
        ),
      ),
    ),
  );
}

class _BacktestTrades extends StatelessWidget {
  const _BacktestTrades({required this.trades});
  final Object? trades;

  @override
  Widget build(BuildContext context) {
    final items = (trades as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList()
        .reversed
        .take(6)
        .toList();
    if (items.isEmpty) {
      return const _EmptyState(
        icon: Icons.query_stats_rounded,
        message: 'No qualifying foundation signal occurred in this snapshot.',
      );
    }
    return _PlainSurface(
      child: Column(
        children: [
          for (var index = 0; index < items.length; index++) ...[
            Padding(
              padding: const EdgeInsets.all(13),
              child: Row(
                children: [
                  Icon(
                    items[index]['direction'] == 'long'
                        ? Icons.trending_up_rounded
                        : Icons.trending_down_rounded,
                    size: 19,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${_humanize(items[index]['direction']?.toString() ?? '')} · ${_humanize(items[index]['exitReason']?.toString() ?? '')}',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        Text(
                          '${_humanize(items[index]['split']?.toString() ?? '')} · ${_shortDate(items[index]['enteredAt']?.toString())}',
                          style: const TextStyle(fontSize: 11),
                        ),
                      ],
                    ),
                  ),
                  Text(
                    _signedR(items[index]['netR']),
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ],
              ),
            ),
            if (index != items.length - 1) const Divider(height: 1),
          ],
        ],
      ),
    );
  }
}

class _JournalTab extends StatelessWidget {
  const _JournalTab({
    required this.journal,
    required this.loading,
    required this.action,
    required this.onAction,
  });
  final Json? journal;
  final bool loading;
  final String? action;
  final ValueChanged<String> onAction;
  @override
  Widget build(BuildContext context) {
    final score = _map(journal?['scorecard']);
    final entries = (journal?['entries'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    if (loading && journal == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(48),
          child: CircularProgressIndicator(),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: action == null ? () => onAction('daily') : null,
              icon: action == 'daily'
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.today_outlined),
              label: const Text('Generate daily'),
            ),
            FilledButton.tonalIcon(
              onPressed: action == null ? () => onAction('weekly') : null,
              icon: action == 'weekly'
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.date_range_outlined),
              label: const Text('Generate weekly'),
            ),
            OutlinedButton.icon(
              onPressed: action == null ? () => onAction('score') : null,
              icon: action == 'score'
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.fact_check_outlined),
              label: const Text('Score due'),
            ),
          ],
        ),
        const SizedBox(height: 14),
        _PlainSurface(
          child: Wrap(
            spacing: 24,
            runSpacing: 16,
            children: [
              _MiniMetric('${score['total'] ?? 0}', 'Forecasts'),
              _MiniMetric('${score['resolved'] ?? 0}', 'Resolved'),
              _MiniMetric('${score['due'] ?? 0}', 'Due'),
              _MiniMetric(
                score['directionalAccuracy'] == null
                    ? '—'
                    : '${((score['directionalAccuracy'] as num) * 100).round()}%',
                'Accuracy',
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _SectionTitle(
          title: 'Sealed scenarios',
          detail: 'Uncalibrated research journal · no trade execution',
        ),
        const SizedBox(height: 8),
        if (entries.isEmpty)
          const _EmptyState(
            icon: Icons.auto_awesome_outlined,
            message:
                'No forward-shadow scenarios are sealed for this instrument.',
          )
        else
          Column(
            children: [
              for (final raw in entries)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _ForecastRow(entry: Json.from(raw)),
                ),
            ],
          ),
      ],
    );
  }
}

class _PriceCanvas extends StatelessWidget {
  const _PriceCanvas({
    required this.values,
    required this.last,
    required this.change,
    required this.asOf,
    required this.source,
  });
  final List<double> values;
  final double? last, change;
  final String? asOf, source;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(
      color: const Color(0xFF061C1E),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: const Color(0xFF1E5752)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          last?.toStringAsFixed(2) ?? 'Price unavailable',
          style: const TextStyle(
            color: Color(0xFFF3F8EF),
            fontSize: 25,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 16,
          runSpacing: 8,
          children: [
            Text(
              change == null
                  ? (source ?? 'Select a stored snapshot')
                  : '${change! >= 0 ? '+' : ''}${change!.toStringAsFixed(2)}% · ${source ?? 'snapshot'}',
              style: const TextStyle(color: Color(0xFF78E4C7)),
            ),
            Text(
              _shortDate(asOf),
              style: const TextStyle(color: Color(0xFFB6D3CE)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Semantics(
          label:
              '${values.length} stored closing prices. Exact OHLC values are available in the snapshot inspector.',
          child: SizedBox(
            height: 160,
            width: double.infinity,
            child: CustomPaint(painter: _LinePainter(values)),
          ),
        ),
      ],
    ),
  );
}

class _LinePainter extends CustomPainter {
  _LinePainter(this.values);
  final List<double> values;
  @override
  void paint(Canvas canvas, Size size) {
    final grid = Paint()
      ..color = const Color(0xFF123B3C)
      ..strokeWidth = 1;
    for (var index = 1; index < 5; index++) {
      canvas.drawLine(
        Offset(0, size.height * index / 5),
        Offset(size.width, size.height * index / 5),
        grid,
      );
    }
    if (values.length < 2) return;
    final visible = values.length > 160
        ? values.sublist(values.length - 160)
        : values;
    final minimum = visible.reduce(math.min),
        maximum = visible.reduce(math.max),
        span = maximum - minimum == 0 ? 1 : maximum - minimum;
    final path = Path();
    for (var index = 0; index < visible.length; index++) {
      final point = Offset(
        size.width * index / (visible.length - 1),
        size.height - ((visible[index] - minimum) / span * size.height),
      );
      if (index == 0) {
        path.moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = const Color(0xFF72E0C0)
        ..strokeWidth = 2.1
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(covariant _LinePainter oldDelegate) =>
      oldDelegate.values != values;
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.event});
  final Json event;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    child: Row(
      children: [
        Container(
          width: 4,
          height: 38,
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.error,
            borderRadius: BorderRadius.circular(9),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                event['name']?.toString() ?? 'USD release',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              Text(
                '${event['releaseDate'] ?? 'Date unavailable'} · ${event['timestampPrecision'] == 'instant' ? _shortDate(event['occurredAt']?.toString()) : 'time unconfirmed'}',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
        Text(
          event['valueStatus'] == 'observed_values' ? 'Observed' : 'Scheduled',
          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
        ),
      ],
    ),
  );
}

class _DetectionRow extends StatelessWidget {
  const _DetectionRow({required this.detection});
  final Json detection;
  @override
  Widget build(BuildContext context) {
    final candidate = detection['reviewState'] == 'candidate_rule';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            candidate ? Icons.rate_review_outlined : Icons.verified_outlined,
            color: candidate
                ? Theme.of(context).colorScheme.tertiary
                : Theme.of(context).colorScheme.primary,
            size: 20,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _humanize(detection['kind']?.toString() ?? 'feature'),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 2),
                Text(
                  detection['reason']?.toString() ?? '',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '${detection['price'] ?? '—'}',
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _ForecastRow extends StatelessWidget {
  const _ForecastRow({required this.entry});
  final Json entry;
  @override
  Widget build(BuildContext context) {
    final forecast = _map(entry['forecast']);
    final stance = forecast['stance']?.toString() ?? 'unknown';
    return _PlainSurface(
      child: Padding(
        padding: const EdgeInsets.all(15),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  stance == 'bullish'
                      ? Icons.trending_up_rounded
                      : stance == 'bearish'
                      ? Icons.trending_down_rounded
                      : Icons.trending_flat_rounded,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${_humanize(forecast['horizon']?.toString() ?? '')} · ${_humanize(stance)}',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                Text(
                  _humanize(entry['resolutionState']?.toString() ?? 'open'),
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.primary,
                    fontWeight: FontWeight.w700,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 9),
            Text(
              forecast['summary']?.toString() ??
                  'Scenario summary unavailable.',
            ),
            const SizedBox(height: 8),
            Text(
              '${_humanize(forecast['evidenceStrength']?.toString() ?? 'unknown')} evidence · uncalibrated',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlainSurface extends StatelessWidget {
  const _PlainSurface({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLowest,
      border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      borderRadius: BorderRadius.circular(12),
    ),
    child: child,
  );
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title, required this.detail});
  final String title, detail;
  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Expanded(
        child: Text(title, style: Theme.of(context).textTheme.titleLarge),
      ),
      Flexible(
        child: Text(
          detail,
          textAlign: TextAlign.end,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 12,
          ),
        ),
      ),
    ],
  );
}

class _EvidenceRow extends StatelessWidget {
  const _EvidenceRow({
    required this.icon,
    required this.title,
    required this.detail,
    required this.status,
  });
  final IconData icon;
  final String title, detail, status;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(14),
    child: Row(
      children: [
        Icon(icon, size: 20),
        const SizedBox(width: 11),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleSmall),
              Text(
                detail,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Text(
          _humanize(status),
          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 11),
        ),
      ],
    ),
  );
}

class _LayerPill extends StatelessWidget {
  const _LayerPill({required this.label, required this.count});
  final String label;
  final int count;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primary.withValues(alpha: .08),
      borderRadius: BorderRadius.circular(999),
      border: Border.all(
        color: Theme.of(context).colorScheme.primary.withValues(alpha: .2),
      ),
    ),
    child: Text(
      '$label  $count',
      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
    ),
  );
}

class _MiniMetric extends StatelessWidget {
  const _MiniMetric(this.value, this.label);
  final String value, label;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(12),
    child: Column(
      children: [
        Text(value, style: Theme.of(context).textTheme.titleLarge),
        Text(
          label,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 11,
          ),
        ),
      ],
    ),
  );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.icon, required this.message});
  final IconData icon;
  final String message;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(42),
    child: Column(
      children: [
        Icon(
          icon,
          size: 30,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        const SizedBox(height: 10),
        Text(message, textAlign: TextAlign.center),
      ],
    ),
  );
}

Json _map(Object? value) =>
    value is Map ? Json.from(value) : <String, dynamic>{};
List<double> _barCloses(Json? response) =>
    (response?['bars'] as List? ?? const [])
        .whereType<Map>()
        .map((value) => (value['close'] as num?)?.toDouble())
        .whereType<double>()
        .toList(growable: false);
String _humanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
String _shortDate(String? value) {
  final parsed = DateTime.tryParse(value ?? '');
  if (parsed == null) return 'Time unavailable';
  final date = parsed.toLocal();
  final hour = date.hour.toString().padLeft(2, '0');
  final minute = date.minute.toString().padLeft(2, '0');
  return '${date.day}/${date.month} $hour:$minute';
}

String _signedR(Object? value) {
  final amount = (value as num?)?.toDouble();
  if (amount == null) return '—';
  return '${amount >= 0 ? '+' : ''}${amount.toStringAsFixed(2)}R';
}

String _percent(Object? value) {
  final ratio = (value as num?)?.toDouble();
  return ratio == null ? '—' : '${(ratio * 100).toStringAsFixed(0)}%';
}

String _percentValue(Object? value) {
  final amount = (value as num?)?.toDouble();
  return amount == null ? '—' : '${amount.toStringAsFixed(1)}%';
}
