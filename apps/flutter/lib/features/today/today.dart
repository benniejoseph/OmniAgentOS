import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';

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
    this.updatedAt,
    this.reminderState = 'none',
  });
  final String id, title, kind, status, reminderState;
  final TodayPriority priority;
  final DateTime? dueAt;
  final DateTime? updatedAt;
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
    updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? ''),
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
        if (item.updatedAt != null)
          'expectedUpdatedAt': item.updatedAt!.toUtc().toIso8601String(),
      });
      await refresh();
    } on ApiConflictException catch (value) {
      await refresh();
      error = value;
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
          title: 'Today is unavailable',
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
      final completed = data.items.where((item) => item.isDone).length;
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(
              child: _TodayHeader(
                acting: controller.acting,
                hasBrief: data.brief != null,
                onBrief: controller.generateBrief,
                onAdd: () => _addItem(context),
              ),
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
                      Expanded(
                        child: Text(
                          controller.error is ApiConflictException
                              ? 'Changed elsewhere · the newer server version is shown.'
                              : 'Update failed · showing the last available Today view.',
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
            if (data.brief case final brief?)
              SliverToBoxAdapter(child: _DailyBriefPanel(brief: brief)),
            SliverToBoxAdapter(
              child: _SectionHeading(
                title: 'Focus list',
                detail: '$pending open · $completed complete',
              ),
            ),
            if (data.items.isEmpty)
              SliverToBoxAdapter(
                child: _EmptyToday(onRefresh: controller.refresh),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverList.builder(
                  itemCount: items.length,
                  itemBuilder: (context, index) {
                    final item = items[index];
                    return _TodayRow(
                      item: item,
                      busy: controller.updating.contains(item.id),
                      focused: item.id == focusItemId,
                      onToggle: () => controller.toggle(item),
                    );
                  },
                ),
              ),
            SliverToBoxAdapter(child: _TodayContext(snapshot: data)),
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

class _TodayHeader extends StatelessWidget {
  const _TodayHeader({
    required this.acting,
    required this.hasBrief,
    required this.onBrief,
    required this.onAdd,
  });

  final bool acting;
  final bool hasBrief;
  final VoidCallback onBrief;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = MaterialLocalizations.of(context)
        .formatFullDate(DateTime.now());
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text('Today', style: theme.textTheme.headlineMedium),
          ),
          const SizedBox(height: 4),
          Text(
            date,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              FilledButton.icon(
                onPressed: acting ? null : onAdd,
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('Add focus'),
              ),
              OutlinedButton.icon(
                onPressed: acting ? null : onBrief,
                icon: const Icon(Icons.auto_awesome_outlined, size: 17),
                label: Text(hasBrief ? 'Refresh brief' : 'Create brief'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({
    required this.title,
    required this.detail,
    this.padding = const EdgeInsets.fromLTRB(20, 0, 20, 12),
  });

  final String title;
  final String detail;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(title, style: Theme.of(context).textTheme.titleLarge),
        ),
        const SizedBox(height: 4),
        Text(
          detail,
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ],
    ),
  );
}

class _DailyBriefPanel extends StatelessWidget {
  const _DailyBriefPanel({required this.brief});

  final DailyBrief brief;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final generated = brief.generatedAt?.toLocal();
    final locale = MaterialLocalizations.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text('Daily brief', style: theme.textTheme.titleMedium),
          ),
          if (generated != null) ...[
            const SizedBox(height: 4),
            Text(
              'Generated ${locale.formatShortDate(generated)} · '
              '${locale.formatTimeOfDay(TimeOfDay.fromDateTime(generated), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 12),
          Text(
            brief.summary.isEmpty
                ? 'The brief did not include a summary.'
                : brief.summary,
            style: theme.textTheme.bodyLarge?.copyWith(height: 1.5),
          ),
          if (brief.watchouts.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('Watch for', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            for (final watchout in brief.watchouts.take(2))
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.info_outline_rounded,
                      size: 18,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(watchout, style: theme.textTheme.bodyMedium),
                    ),
                  ],
                ),
              ),
          ],
          if (brief.focus.isNotEmpty)
            ExpansionTile(
              key: PageStorageKey<Object>(('today-brief-focus', brief)),
              title: const Text('Suggested focus'),
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(bottom: 8),
              shape: const Border(),
              collapsedShape: const Border(),
              expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
                  ? AnimationStyle.noAnimation
                  : const AnimationStyle(duration: Duration(milliseconds: 180)),
              children: [
                for (final focus in brief.focus.take(3))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          focus.title,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (focus.reason.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            focus.reason,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
              ],
            )
          else
            const SizedBox(height: 8),
        ],
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
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 180),
      opacity: busy ? .65 : 1,
      child: InkWell(
        onTap: busy ? null : onToggle,
        borderRadius: BorderRadius.circular(8),
        child: AnimatedContainer(
          duration: MediaQuery.disableAnimationsOf(context)
              ? Duration.zero
              : const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 4),
          decoration: BoxDecoration(
            color: focused
                ? scheme.primaryContainer.withValues(alpha: .72)
                : null,
            borderRadius: BorderRadius.circular(8),
            border: Border(
              bottom: BorderSide(
                color: focused ? scheme.primary : scheme.outlineVariant,
              ),
            ),
          ),
          child: Row(
            children: [
              Checkbox(
                value: item.isDone,
                onChanged: busy ? null : (_) => onToggle(),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.title,
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w500,
                        color: item.isDone
                            ? scheme.onSurfaceVariant
                            : scheme.onSurface,
                        decoration: item.isDone
                            ? TextDecoration.lineThrough
                            : null,
                      ),
                    ),
                    const SizedBox(height: 5),
                    Wrap(
                      spacing: 8,
                      runSpacing: 3,
                      children: [
                        _RowMeta(
                          label: item.kind,
                          color: scheme.onSurfaceVariant,
                        ),
                        _RowMeta(
                          label: item.priority.name,
                          color: priorityColor,
                        ),
                        if (item.dueAt != null)
                          _RowMeta(
                            label: _shortDate(item.dueAt!),
                            color: scheme.onSurfaceVariant,
                          ),
                        if (item.reminderState != 'none')
                          _RowMeta(
                            label: item.reminderState.replaceAll('_', ' '),
                            color: scheme.secondary,
                          ),
                      ],
                    ),
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

class _RowMeta extends StatelessWidget {
  const _RowMeta({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Text(
    label.replaceAll('_', ' '),
    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: color),
  );
}

class _TodayContext extends StatelessWidget {
  const _TodayContext({required this.snapshot});

  final TodaySnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    if (snapshot.projects.isEmpty && snapshot.threads.isEmpty) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 28, 20, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionHeading(
            title: 'Related work',
            padding: EdgeInsets.zero,
            detail:
                '${snapshot.projects.length} projects · ${snapshot.threads.length} conversations',
          ),
          if (snapshot.projects.isNotEmpty) ...[
            const SizedBox(height: 6),
            _ContextLabel(icon: Icons.folder_open_outlined, label: 'Projects'),
            for (final project in snapshot.projects.take(4))
              _ProjectContextRow(project: project),
          ],
          if (snapshot.threads.isNotEmpty) ...[
            const SizedBox(height: 20),
            _ContextLabel(
              icon: Icons.forum_outlined,
              label: 'Recent conversations',
            ),
            for (final thread in snapshot.threads.take(4))
              _ThreadContextRow(thread: thread),
          ],
        ],
      ),
    );
  }
}

class _ContextLabel extends StatelessWidget {
  const _ContextLabel({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Row(
      children: [
        Icon(icon, size: 16, color: Theme.of(context).colorScheme.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.titleSmall),
        ),
      ],
    ),
  );
}

class _ProjectContextRow extends StatelessWidget {
  const _ProjectContextRow({required this.project});

  final ({int completed, String id, String title, int total}) project;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final progress = project.total == 0
        ? 0.0
        : (project.completed / project.total).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  project.title,
                  style: Theme.of(context).textTheme.bodyMedium
                      ?.copyWith(fontWeight: FontWeight.w500),
                ),
                const SizedBox(height: 7),
                ClipRRect(
                  borderRadius: BorderRadius.circular(99),
                  child: LinearProgressIndicator(value: progress, minHeight: 3),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Text(
            '${project.completed}/${project.total}',
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _ThreadContextRow extends StatelessWidget {
  const _ThreadContextRow({required this.thread});

  final ({String id, String title}) thread;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(vertical: 10),
    decoration: BoxDecoration(
      border: Border(
        bottom: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
    ),
    child: Row(
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.tertiary,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            thread.title,
            style: Theme.of(context).textTheme.bodyMedium
                ?.copyWith(fontWeight: FontWeight.w500),
          ),
        ),
      ],
    ),
  );
}

class _TodaySkeleton extends StatelessWidget {
  const _TodaySkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
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
            Icons.checklist_rounded,
            size: 44,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 16),
          Text(
            'No focus items yet',
            style: Theme.of(context).textTheme.titleLarge,
            textAlign: TextAlign.center,
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
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 32),
          const SizedBox(height: 12),
          Text(
            title,
            style: Theme.of(context).textTheme.titleLarge,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          FilledButton.tonal(onPressed: action, child: const Text('Try again')),
        ],
      ),
    ),
  );
}
