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
  bool acting = false;
  final Set<String> updating = {};
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

  Future<bool> add(
    String title, {
    TodayPriority priority = TodayPriority.medium,
  }) async {
    if (acting) return false;
    acting = true;
    error = null;
    notifyListeners();
    try {
      await repository.create(title: title, priority: priority);
      await refresh();
      return true;
    } catch (value) {
      error = value;
      return false;
    } finally {
      acting = false;
      notifyListeners();
    }
  }

  Future<void> toggle(TodayItem item) async {
    if (!updating.add(item.id)) return;
    error = null;
    notifyListeners();
    try {
      await repository.update(item.id, {
        'status': item.isDone ? 'open' : 'done',
      });
      await refresh();
    } catch (value) {
      error = value;
    } finally {
      updating.remove(item.id);
      notifyListeners();
    }
  }

  Future<void> generateBrief() async {
    if (acting) return;
    acting = true;
    error = null;
    notifyListeners();
    try {
      await repository.generateBrief(force: true);
      await refresh();
    } catch (value) {
      error = value;
    } finally {
      acting = false;
      notifyListeners();
    }
  }
}

class TodayView extends StatelessWidget {
  const TodayView({super.key, required this.controller, this.focusItemId});
  final TodayController controller;
  final String? focusItemId;
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
      final items = [...data.items]
        ..sort((left, right) {
          if (left.id == focusItemId) return -1;
          if (right.id == focusItemId) return 1;
          return 0;
        });
      final pending = data.items.where((item) => !item.isDone).length;
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: const Text('Today'),
              actions: [
                IconButton(
                  onPressed: controller.acting
                      ? null
                      : controller.generateBrief,
                  tooltip: 'Refresh daily brief',
                  icon: const Icon(Icons.auto_awesome_rounded),
                ),
                IconButton(
                  onPressed: controller.acting ? null : () => _addItem(context),
                  tooltip: 'Add focus item',
                  icon: const Icon(Icons.add_task_rounded),
                ),
              ],
            ),
            if (controller.error != null)
              SliverToBoxAdapter(
                child: Container(
                  margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.errorContainer,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.cloud_off_outlined),
                      const SizedBox(width: 10),
                      const Expanded(
                        child: Text(
                          'Update failed · showing the last available Today view.',
                        ),
                      ),
                      TextButton(
                        onPressed: controller.refresh,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ),
            SliverToBoxAdapter(
              child: _TodayPulse(
                pending: pending,
                projects: data.projects.length,
                conversations: data.threads.length,
              ),
            ),
            if (data.brief case final brief?)
              SliverToBoxAdapter(child: _DailyBriefPanel(brief: brief)),
            if (data.items.isNotEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 10),
                  child: Row(
                    children: [
                      Text(
                        'Focus',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const Spacer(),
                      Text(
                        '$pending remaining',
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                      ),
                    ],
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
                  itemCount: items.length,
                  itemBuilder: (context, index) {
                    final item = items[index];
                    return _StaggeredReveal(
                      index: index,
                      child: _TodayRow(
                        item: item,
                        busy: controller.updating.contains(item.id),
                        focused: item.id == focusItemId,
                        onToggle: () => controller.toggle(item),
                      ),
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

  Future<void> _addItem(BuildContext context) async {
    final input = TextEditingController();
    final submit = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Add focus item'),
        content: TextField(
          controller: input,
          autofocus: true,
          maxLength: 280,
          decoration: const InputDecoration(labelText: 'What needs attention?'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Add'),
          ),
        ],
      ),
    );
    final title = input.text.trim();
    input.dispose();
    if (submit == true && title.isNotEmpty) await controller.add(title);
  }
}

class _TodayPulse extends StatelessWidget {
  const _TodayPulse({
    required this.pending,
    required this.projects,
    required this.conversations,
  });

  final int pending;
  final int projects;
  final int conversations;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 20),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: .045),
            blurRadius: 22,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'TODAY PULSE',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: scheme.primary,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '$pending',
                      style: Theme.of(context).textTheme.displaySmall
                          ?.copyWith(color: scheme.primary, fontSize: 42),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      pending == 1 ? 'open priority' : 'open priorities',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                  ],
                ),
              ),
              Container(
                width: 1,
                height: 50,
                color: Theme.of(context).dividerColor,
              ),
              const SizedBox(width: 20),
              Expanded(
                child: Column(
                  children: [
                    _PulseLine(label: 'Projects', value: projects),
                    const SizedBox(height: 9),
                    _PulseLine(label: 'Conversations', value: conversations),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _PulseLine extends StatelessWidget {
  const _PulseLine({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(
          label,
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ),
      Text('$value', style: Theme.of(context).textTheme.titleMedium),
    ],
  );
}

class _DailyBriefPanel extends StatelessWidget {
  const _DailyBriefPanel({required this.brief});

  final DailyBrief brief;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(24),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome_rounded, size: 17, color: scheme.primary),
              const SizedBox(width: 8),
              Text(
                'DAILY BRIEF',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: scheme.primary,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                ),
              ),
            ],
          ),
          const SizedBox(height: 13),
          Text(brief.summary, style: Theme.of(context).textTheme.titleMedium),
        ],
      ),
    );
  }
}

class _StaggeredReveal extends StatelessWidget {
  const _StaggeredReveal({required this.index, required this.child});

  final int index;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: 260 + (index.clamp(0, 6) * 45)),
      curve: const Cubic(.16, 1, .3, 1),
      child: child,
      builder: (context, value, child) => Opacity(
        opacity: value,
        child: Transform.translate(
          offset: Offset(0, 10 * (1 - value)),
          child: child,
        ),
      ),
    );
  }
}

class _TodayRow extends StatelessWidget {
  const _TodayRow({
    required this.item,
    required this.busy,
    required this.focused,
    required this.onToggle,
  });
  final TodayItem item;
  final bool busy;
  final bool focused;
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
      opacity: busy
          ? .45
          : item.isDone
          ? .58
          : 1,
      child: InkWell(
        onTap: busy ? null : onToggle,
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
          decoration: BoxDecoration(
            color: focused ? scheme.primaryContainer : null,
            borderRadius: BorderRadius.circular(12),
            border: focused ? Border.all(color: scheme.primary) : null,
          ),
          child: Row(
            children: [
              Checkbox(
                value: item.isDone,
                onChanged: busy ? null : (_) => onToggle(),
              ),
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
