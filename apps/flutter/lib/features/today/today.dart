import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;

enum TodayPriority { low, medium, high }

class TodayItem {
  const TodayItem({
    required this.id,
    required this.title,
    required this.kind,
    required this.priority,
    required this.status,
    this.dueAt,
    this.reminderState = 'none',
  });
  final String id, title, kind, status, reminderState;
  final TodayPriority priority;
  final DateTime? dueAt;
  bool get isDone => status == 'done';
  factory TodayItem.fromJson(Json json) => TodayItem(
    id: json['id'] as String,
    title: json['title'] as String,
    kind: json['kind'] as String? ?? 'task',
    priority: TodayPriority.values.firstWhere(
      (v) => v.name == json['priority'],
      orElse: () => TodayPriority.medium,
    ),
    status: json['status'] as String? ?? 'open',
    reminderState: json['reminderState'] as String? ?? 'none',
    dueAt: DateTime.tryParse(json['dueAt'] as String? ?? ''),
  );
}

class DailyBrief {
  const DailyBrief({
    required this.summary,
    required this.focus,
    required this.watchouts,
    required this.generatedAt,
  });
  final String summary;
  final List<({String title, String reason})> focus;
  final List<String> watchouts;
  final DateTime? generatedAt;
  factory DailyBrief.fromJson(Json json) => DailyBrief(
    summary: json['summary'] as String? ?? '',
    focus: ((json['focus'] as List?) ?? const [])
        .whereType<Json>()
        .map(
          (e) => (
            title: e['title'] as String? ?? '',
            reason: e['reason'] as String? ?? '',
          ),
        )
        .toList(),
    watchouts: ((json['watchouts'] as List?) ?? const [])
        .whereType<String>()
        .toList(),
    generatedAt: DateTime.tryParse(json['generatedAt'] as String? ?? ''),
  );
}

class TodaySnapshot {
  const TodaySnapshot({
    required this.items,
    this.brief,
    required this.threads,
    required this.projects,
  });
  final List<TodayItem> items;
  final DailyBrief? brief;
  final List<({String id, String title})> threads;
  final List<({String id, String title, int completed, int total})> projects;
  factory TodaySnapshot.fromJson(Json json) => TodaySnapshot(
    items: ((json['items'] as List?) ?? const [])
        .whereType<Json>()
        .map(TodayItem.fromJson)
        .toList(),
    brief: json['brief'] is Json
        ? DailyBrief.fromJson(json['brief'] as Json)
        : null,
    threads: ((json['threads'] as List?) ?? const [])
        .whereType<Json>()
        .map(
          (e) => (
            id: e['id'] as String,
            title: e['title'] as String? ?? 'Conversation',
          ),
        )
        .toList(),
    projects: ((json['projects'] as List?) ?? const [])
        .whereType<Json>()
        .map(
          (e) => (
            id: e['id'] as String,
            title: e['title'] as String? ?? 'Project',
            completed: e['completedTasks'] as int? ?? 0,
            total: e['totalTasks'] as int? ?? 0,
          ),
        )
        .toList(),
  );
}

abstract interface class TodayRepository {
  Future<TodaySnapshot> load();
  Future<TodayItem> create({
    required String title,
    String kind = 'task',
    TodayPriority priority = TodayPriority.medium,
    DateTime? dueAt,
  });
  Future<TodayItem> update(String id, Json changes);
  Future<DailyBrief?> generateBrief({bool force = false});
}

class TodayController extends ChangeNotifier {
  TodayController(this.repository);
  final TodayRepository repository;
  TodaySnapshot? snapshot;
  Object? error;
  bool loading = false;
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      snapshot = await repository.load();
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> add(
    String title, {
    TodayPriority priority = TodayPriority.medium,
  }) async {
    await repository.create(title: title, priority: priority);
    await refresh();
  }

  Future<void> toggle(TodayItem item) async {
    await repository.update(item.id, {'status': item.isDone ? 'open' : 'done'});
    await refresh();
  }
}

class TodayView extends StatelessWidget {
  const TodayView({super.key, required this.controller});
  final TodayController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final data = controller.snapshot;
      if (controller.loading && data == null) return const _TodaySkeleton();
      if (controller.error != null && data == null) {
        return _Message(
          icon: Icons.cloud_off_rounded,
          title: 'Today is offline',
          action: controller.refresh,
        );
      }
      if (data == null) {
        return _Message(
          icon: Icons.today_rounded,
          title: 'Plan your day',
          action: controller.refresh,
        );
      }
      final pending = data.items.where((item) => !item.isDone).length;
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: const Text('Today'),
              actions: [
                IconButton(
                  onPressed: controller.refresh,
                  tooltip: 'Refresh today',
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _MetricChip(
                      icon: Icons.bolt_rounded,
                      label: '$pending open',
                    ),
                    _MetricChip(
                      icon: Icons.route_rounded,
                      label: '${data.projects.length} projects',
                    ),
                    _MetricChip(
                      icon: Icons.forum_outlined,
                      label: '${data.threads.length} active threads',
                    ),
                  ],
                ),
              ),
            ),
            if (data.brief case final brief?)
              SliverToBoxAdapter(
                child: Container(
                  margin: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              Icons.auto_awesome_rounded,
                              size: 18,
                              color: Theme.of(context).colorScheme.primary,
                            ),
                            const SizedBox(width: 8),
                            const Text(
                              'Daily brief',
                              style: TextStyle(fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                        const SizedBox(height: 10),
                        Text(
                          brief.summary,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            if (data.items.isEmpty)
              SliverFillRemaining(
                child: _EmptyToday(onRefresh: controller.refresh),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverList.builder(
                  itemCount: data.items.length,
                  itemBuilder: (context, index) {
                    final item = data.items[index];
                    return _TodayRow(
                      item: item,
                      onToggle: () => controller.toggle(item),
                    );
                  },
                ),
              ),
            const SliverPadding(padding: EdgeInsets.only(bottom: 96)),
          ],
        ),
      );
    },
  );
}

class _MetricChip extends StatelessWidget {
  const _MetricChip({required this.icon, required this.label});
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) => Chip(
    avatar: Icon(icon, size: 16),
    label: Text(label),
    side: BorderSide.none,
    visualDensity: VisualDensity.compact,
  );
}

class _TodayRow extends StatelessWidget {
  const _TodayRow({required this.item, required this.onToggle});
  final TodayItem item;
  final VoidCallback onToggle;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final priorityColor = switch (item.priority) {
      TodayPriority.high => scheme.error,
      TodayPriority.medium => scheme.tertiary,
      TodayPriority.low => scheme.secondary,
    };
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 180),
      opacity: item.isDone ? .58 : 1,
      child: InkWell(
        onTap: onToggle,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
          child: Row(
            children: [
              Checkbox(value: item.isDone, onChanged: (_) => onToggle()),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.title,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        decoration: item.isDone
                            ? TextDecoration.lineThrough
                            : null,
                      ),
                    ),
                    if (item.dueAt != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        _shortDate(item.dueAt!),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
              Icon(
                item.kind == 'reminder'
                    ? Icons.notifications_none_rounded
                    : Icons.bolt_rounded,
                size: 18,
                color: priorityColor,
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _shortDate(DateTime value) {
    final local = value.toLocal();
    return '${local.day}/${local.month} at ${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }
}

class _TodaySkeleton extends StatelessWidget {
  const _TodaySkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(20, 72, 20, 20),
    children: const [
      _Skeleton(width: 132, height: 34),
      SizedBox(height: 28),
      _Skeleton(height: 116),
      SizedBox(height: 28),
      _Skeleton(height: 58),
      SizedBox(height: 10),
      _Skeleton(height: 58),
      SizedBox(height: 10),
      _Skeleton(height: 58),
    ],
  );
}

class _Skeleton extends StatelessWidget {
  const _Skeleton({this.width = double.infinity, required this.height});
  final double width, height;
  @override
  Widget build(BuildContext context) => Container(
    width: width,
    height: height,
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(12),
    ),
  );
}

class _EmptyToday extends StatelessWidget {
  const _EmptyToday({required this.onRefresh});
  final VoidCallback onRefresh;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.check_circle_outline_rounded,
            size: 44,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 16),
          Text(
            'Your day is clear',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 6),
          const Text(
            'New focus items and reminders will appear here.',
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 18),
          OutlinedButton.icon(
            onPressed: onRefresh,
            icon: const Icon(Icons.refresh_rounded),
            label: const Text('Check again'),
          ),
        ],
      ),
    ),
  );
}

class _Message extends StatelessWidget {
  const _Message({
    required this.icon,
    required this.title,
    required this.action,
  });
  final IconData icon;
  final String title;
  final VoidCallback action;
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 48),
        const SizedBox(height: 12),
        Text(title),
        const SizedBox(height: 12),
        FilledButton.tonal(onPressed: action, child: const Text('Try again')),
      ],
    ),
  );
}
