import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

class MarketsView extends StatefulWidget {
  const MarketsView({super.key, required this.api});
  final ApiClient api;

  @override
  State<MarketsView> createState() => _MarketsViewState();
}

class _MarketsViewState extends State<MarketsView> {
  Json? overview, bars, events, features, journal;
  Object? error;
  String instrumentId = 'xauusd.spot';
  String interval = '15min';
  int tab = 0;
  bool loading = true;
  String? action;

  @override
  void initState() {
    super.initState();
    _loadFoundation();
  }

  Future<void> _loadFoundation() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final value = await widget.api.getJson(NativePaths.marketOverview);
      final instruments = (value['instruments'] as List? ?? const [])
          .whereType<Map>()
          .toList();
      if (instruments.isNotEmpty &&
          !instruments.any((item) => item['id'] == instrumentId)) {
        instrumentId = instruments.first['id']?.toString() ?? instrumentId;
      }
      overview = value;
      await _loadBars();
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _loadBars() async {
    bars = await widget.api.getJson(
      NativePaths.marketBars,
      query: {
        'instrumentId': instrumentId,
        'interval': interval,
        'outputSize': 480,
      },
    );
    features = null;
  }

  Future<void> _refreshCurrent() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      if (tab == 0) {
        overview = await widget.api.getJson(NativePaths.marketOverview);
        await _loadBars();
      } else if (tab == 1) {
        events = await widget.api.getJson(
          NativePaths.marketEvents,
          query: {'limit': 100},
        );
      } else if (tab == 2) {
        if (bars == null) {
          await _loadBars();
        }
        final snapshotId = bars?['snapshotId']?.toString();
        if (snapshotId != null) {
          features = await widget.api.getJson(
            NativePaths.marketFeatures,
            query: {'snapshotId': snapshotId},
          );
        }
      } else {
        journal = await widget.api.getJson(
          NativePaths.marketJournal,
          query: {'instrumentId': instrumentId, 'limit': 40},
        );
      }
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _selectInstrument(String value) async {
    if (value == instrumentId) return;
    setState(() {
      instrumentId = value;
      loading = true;
      error = null;
      bars = null;
      features = null;
      journal = null;
    });
    try {
      await _loadBars();
      if (tab == 2 || tab == 3) await _refreshCurrent();
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _selectInterval(String value) async {
    if (value == interval) return;
    setState(() {
      interval = value;
      loading = true;
      error = null;
      bars = null;
      features = null;
    });
    try {
      await _loadBars();
      if (tab == 2) await _refreshCurrent();
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _selectTab(int value) async {
    setState(() => tab = value);
    if ((value == 1 && events == null) ||
        (value == 2 && features == null) ||
        (value == 3 && journal == null)) {
      await _refreshCurrent();
    }
  }

  Future<void> _journalAction(String value) async {
    setState(() {
      action = value;
      error = null;
    });
    try {
      if (value == 'score') {
        await widget.api.postJson(
          NativePaths.marketJournalScore,
          data: {'instrumentId': instrumentId, 'maxForecasts': 2},
          headers: _idempotency('score'),
        );
      } else {
        await widget.api.postJson(
          NativePaths.marketJournalGenerate,
          data: {'instrumentId': instrumentId, 'horizon': value},
          headers: _idempotency('forecast-$value'),
        );
      }
      journal = await widget.api.getJson(
        NativePaths.marketJournal,
        query: {'instrumentId': instrumentId, 'limit': 40},
      );
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => action = null);
    }
  }

  Map<String, dynamic> _idempotency(String purpose) => {
    'idempotency-key':
        'mobile-market-$purpose-${DateTime.now().microsecondsSinceEpoch}',
  };

  @override
  Widget build(BuildContext context) {
    final instruments = (overview?['instruments'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    return RefreshIndicator(
      onRefresh: _refreshCurrent,
      child: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 22, 16, 8),
            sliver: SliverToBoxAdapter(
              child: Align(
                alignment: Alignment.topLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1320),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'MARKET INTELLIGENCE · RESEARCH ONLY',
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .primary,
                                        letterSpacing: 1.35,
                                        fontWeight: FontWeight.w800,
                                      ),
                                ),
                                const SizedBox(height: 7),
                                Text(
                                  'Trading Market News',
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineMedium,
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  'Macro evidence, immutable price snapshots, ICT structure, and Meridian’s forward-shadow journal.',
                                  style: TextStyle(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          _PhaseBadge(
                            phase: overview?['phase']?.toString(),
                            loading: loading,
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Wrap(
                        spacing: 10,
                        runSpacing: 10,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          DropdownButton<String>(
                            value: instrumentId,
                            items: [
                              for (final item in instruments)
                                DropdownMenuItem(
                                  value: item['id']?.toString(),
                                  child: Text(
                                    item['symbol']?.toString() ??
                                        item['name']?.toString() ??
                                        item['id']?.toString() ??
                                        'Instrument',
                                  ),
                                ),
                            ],
                            onChanged: loading
                                ? null
                                : (value) {
                                    if (value != null) _selectInstrument(value);
                                  },
                          ),
                          SegmentedButton<String>(
                            segments: const [
                              ButtonSegment(value: '5min', label: Text('5m')),
                              ButtonSegment(value: '15min', label: Text('15m')),
                              ButtonSegment(value: '1h', label: Text('1h')),
                            ],
                            selected: {interval},
                            onSelectionChanged: loading
                                ? null
                                : (value) => _selectInterval(value.first),
                          ),
                          IconButton.filledTonal(
                            tooltip: 'Refresh market evidence',
                            onPressed: loading ? null : _refreshCurrent,
                            icon: const Icon(Icons.refresh_rounded),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: SegmentedButton<int>(
                          segments: const [
                            ButtonSegment(
                              value: 0,
                              label: Text('Overview'),
                              icon: Icon(Icons.show_chart_rounded),
                            ),
                            ButtonSegment(
                              value: 1,
                              label: Text('News impact'),
                              icon: Icon(Icons.calendar_month_outlined),
                            ),
                            ButtonSegment(
                              value: 2,
                              label: Text('ICT + Quarterly'),
                              icon: Icon(Icons.layers_outlined),
                            ),
                            ButtonSegment(
                              value: 3,
                              label: Text('Forecast journal'),
                              icon: Icon(Icons.auto_awesome_outlined),
                            ),
                          ],
                          selected: {tab},
                          onSelectionChanged: (value) =>
                              _selectTab(value.first),
                        ),
                      ),
                      if (error != null) ...[
                        const SizedBox(height: 12),
                        _MarketError(error: error!, retry: _refreshCurrent),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (loading && overview == null)
            const SliverFillRemaining(
              child: Center(child: CircularProgressIndicator()),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 44),
              sliver: SliverToBoxAdapter(
                child: Align(
                  alignment: Alignment.topLeft,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 1320),
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 180),
                      child: switch (tab) {
                        0 => _OverviewTab(
                          key: const ValueKey('overview'),
                          overview: overview,
                          bars: bars,
                        ),
                        1 => _EventsTab(
                          key: const ValueKey('events'),
                          events: events,
                          loading: loading,
                        ),
                        2 => _TechnicalTab(
                          key: const ValueKey('technicals'),
                          bars: bars,
                          features: features,
                          loading: loading,
                        ),
                        _ => _JournalTab(
                          key: const ValueKey('journal'),
                          journal: journal,
                          loading: loading,
                          action: action,
                          onAction: _journalAction,
                        ),
                      },
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

class _OverviewTab extends StatelessWidget {
  const _OverviewTab({super.key, required this.overview, required this.bars});
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
  const _EventsTab({super.key, required this.events, required this.loading});
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
    super.key,
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
            message: 'Technical candidates are unavailable for this snapshot.',
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

class _JournalTab extends StatelessWidget {
  const _JournalTab({
    super.key,
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
          child: Row(
            children: [
              Expanded(
                child: _MiniMetric('${score['total'] ?? 0}', 'Forecasts'),
              ),
              Expanded(
                child: _MiniMetric('${score['resolved'] ?? 0}', 'Resolved'),
              ),
              Expanded(child: _MiniMetric('${score['due'] ?? 0}', 'Due')),
              Expanded(
                child: _MiniMetric(
                  score['directionalAccuracy'] == null
                      ? '—'
                      : '${((score['directionalAccuracy'] as num) * 100).round()}%',
                  'Accuracy',
                ),
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
    height: 238,
    width: double.infinity,
    decoration: BoxDecoration(
      color: const Color(0xFF061C1E),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: const Color(0xFF1E5752)),
    ),
    child: Stack(
      children: [
        Positioned.fill(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 64, 14, 22),
            child: CustomPaint(painter: _LinePainter(values)),
          ),
        ),
        Positioned(
          left: 18,
          top: 16,
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
              const SizedBox(height: 3),
              Text(
                change == null
                    ? (source ?? 'waiting for snapshot')
                    : '${change! >= 0 ? '+' : ''}${change!.toStringAsFixed(2)}% · ${source ?? 'snapshot'}',
                style: TextStyle(
                  color: change != null && change! < 0
                      ? const Color(0xFFFF9A9A)
                      : const Color(0xFF78E4C7),
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
        Positioned(
          right: 18,
          top: 18,
          child: Text(
            _shortDate(asOf),
            style: const TextStyle(color: Color(0xFF86A9A4), fontSize: 11),
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

class _PhaseBadge extends StatelessWidget {
  const _PhaseBadge({required this.phase, required this.loading});
  final String? phase;
  final bool loading;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primary.withValues(alpha: .1),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (loading)
          const SizedBox.square(
            dimension: 12,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        else
          const Icon(Icons.circle, size: 9),
        const SizedBox(width: 6),
        Text(
          loading ? 'Syncing' : _humanize(phase ?? 'unknown'),
          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 11),
        ),
      ],
    ),
  );
}

class _MarketError extends StatelessWidget {
  const _MarketError({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.errorContainer,
    borderRadius: BorderRadius.circular(10),
    child: ListTile(
      leading: const Icon(Icons.warning_amber_rounded),
      title: const Text('Market evidence could not refresh'),
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
