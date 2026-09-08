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
      final completed = data.items.where((item) => item.isDone).length;
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(
              child: _TodayHero(
                acting: controller.acting,
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
                completed: completed,
                projects: data.projects.length,
                conversations: data.threads.length,
              ),
            ),
            if (data.brief case final brief?)
              SliverToBoxAdapter(child: _DailyBriefPanel(brief: brief)),
            SliverToBoxAdapter(
              child: _SectionHeading(
                eyebrow: 'PRIORITIES',
                title: 'Focus',
                detail: '$pending remaining · $completed complete',
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

class _TodayHero extends StatelessWidget {
  const _TodayHero({
    required this.acting,
    required this.onBrief,
    required this.onAdd,
  });

  final bool acting;
  final VoidCallback onBrief;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final scheme = Theme.of(context).colorScheme;
    final greeting = switch (now.hour) {
      < 12 => 'Good morning.',
      < 17 => 'Good afternoon.',
      _ => 'Good evening.',
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 22, 20, 14),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            right: -42,
            top: -55,
            child: IgnorePointer(
              child: Container(
                width: 176,
                height: 176,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: scheme.secondary.withValues(alpha: .2),
                  ),
                ),
                child: Center(
                  child: Container(
                    width: 116,
                    height: 116,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(
                        colors: [
                          scheme.secondary.withValues(alpha: .28),
                          scheme.secondary.withValues(alpha: .06),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  SizedBox(
                    width: 72,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${now.day}',
                          style: Theme.of(context).textTheme.displaySmall
                              ?.copyWith(
                                fontFamily: 'serif',
                                fontSize: 57,
                                fontWeight: FontWeight.w400,
                                height: .8,
                              ),
                        ),
                        const SizedBox(height: 9),
                        Container(
                          width: 38,
                          height: 3,
                          decoration: BoxDecoration(
                            color: scheme.primary,
                            borderRadius: BorderRadius.circular(99),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '${_weekdays[now.weekday - 1]}\n${_months[now.month - 1]}',
                          style: TextStyle(
                            color: scheme.onSurfaceVariant,
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            height: 1.35,
                            letterSpacing: .8,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'YOUR DAYBOOK',
                          style: TextStyle(
                            color: scheme.primary,
                            fontSize: 10.5,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.25,
                          ),
                        ),
                        const SizedBox(height: 5),
                        Text(
                          greeting,
                          style: Theme.of(context).textTheme.displaySmall
                              ?.copyWith(
                                fontFamily: 'serif',
                                fontSize: 38,
                                fontWeight: FontWeight.w400,
                                height: .96,
                              ),
                        ),
                        const SizedBox(height: 9),
                        Text(
                          'One view of your work, decisions, and recent evidence.',
                          style: TextStyle(
                            color: scheme.onSurfaceVariant,
                            fontSize: 13,
                            height: 1.45,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: acting ? null : onBrief,
                      icon: const Icon(Icons.auto_awesome_outlined, size: 17),
                      label: const Text('Refresh brief'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: acting ? null : onAdd,
                      icon: const Icon(Icons.add_rounded, size: 18),
                      label: const Text('Add focus'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

const _weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const _months = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

class _TodayPulse extends StatelessWidget {
  const _TodayPulse({
    required this.pending,
    required this.completed,
    required this.projects,
    required this.conversations,
  });

  final int pending;
  final int completed;
  final int projects;
  final int conversations;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 8, 20, 22),
      padding: const EdgeInsets.symmetric(vertical: 15),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: scheme.outlineVariant),
          bottom: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'OPERATING LINE',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: scheme.primary,
              fontWeight: FontWeight.w700,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 11),
          Wrap(
            spacing: 7,
            runSpacing: 7,
            children: [
              _PulsePill(
                label: '$pending open',
                color: pending > 0 ? scheme.secondary : scheme.tertiary,
              ),
              _PulsePill(label: '$completed complete', color: scheme.tertiary),
              _PulsePill(label: '$projects projects', color: scheme.primary),
              _PulsePill(
                label: '$conversations conversations',
                color: scheme.primary,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _PulsePill extends StatelessWidget {
  const _PulsePill({required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surface.withValues(alpha: .72),
      border: Border.all(color: color.withValues(alpha: .35)),
      borderRadius: BorderRadius.circular(99),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 7),
        Text(
          label,
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
        ),
      ],
    ),
  );
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({
    required this.eyebrow,
    required this.title,
    required this.detail,
  });

  final String eyebrow;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 6, 20, 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          flex: 3,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                eyebrow,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.primary,
                  fontSize: 9.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.15,
                ),
              ),
              const SizedBox(height: 2),
              Text(title, style: Theme.of(context).textTheme.titleLarge),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Flexible(
          flex: 2,
          child: Text(
            detail,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.end,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 11,
            ),
          ),
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
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      decoration: BoxDecoration(
        color: scheme.primaryContainer.withValues(alpha: .78),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.primary.withValues(alpha: .24)),
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
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.2,
                ),
              ),
            ],
          ),
          const SizedBox(height: 13),
          Text(brief.summary, style: Theme.of(context).textTheme.titleMedium),
          if (brief.focus.isNotEmpty) ...[
            const SizedBox(height: 16),
            for (var index = 0; index < brief.focus.take(3).length; index++)
              Padding(
                padding: const EdgeInsets.only(bottom: 9),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${index + 1}'.padLeft(2, '0'),
                      style: TextStyle(
                        color: scheme.primary,
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            brief.focus[index].title,
                            style: const TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (brief.focus[index].reason.isNotEmpty)
                            Text(
                              brief.focus[index].reason,
                              style: TextStyle(
                                color: scheme.onSurfaceVariant,
                                fontSize: 11,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (brief.watchouts.isNotEmpty) ...[
            const Divider(height: 22),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.warning_amber_rounded,
                  size: 16,
                  color: scheme.secondary,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    brief.watchouts.take(2).join(' · '),
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 11,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
          ],
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
        borderRadius: BorderRadius.circular(8),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
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
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
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
    label.toUpperCase(),
    style: TextStyle(
      color: color,
      fontSize: 9.5,
      fontWeight: FontWeight.w600,
      letterSpacing: .45,
    ),
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
            eyebrow: 'ACTIVE CONTEXT',
            title: 'Around your work',
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
        Text(label, style: Theme.of(context).textTheme.titleSmall),
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
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
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
            style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 10.5),
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
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
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
