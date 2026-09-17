import 'package:flutter/material.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../../core/network/api_exception.dart';
import 'today.dart';

/// Desktop presentation for Today. The repository and controller remain shared
/// with Android and web, while macOS gets a persistent operating board and
/// context inspector instead of the mobile Daybook composition.
class MacosTodayView extends StatelessWidget {
  const MacosTodayView({super.key, required this.controller, this.focusItemId});

  final TodayController controller;
  final String? focusItemId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final snapshot = controller.snapshot;
      final openCount =
          snapshot?.items.where((item) => !item.isDone).length ?? 0;
      final completeCount =
          snapshot?.items.where((item) => item.isDone).length ?? 0;

      return MacosPageScaffold(
        title: 'Today',
        description: 'Priorities, decisions, and the work already in motion.',
        icon: Icons.today_outlined,
        actions: [
          IconButton(
            key: const Key('macos-today-refresh'),
            tooltip: 'Refresh Today',
            onPressed: controller.loading ? null : controller.refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
          OutlinedButton.icon(
            key: const Key('macos-today-brief'),
            onPressed: controller.acting ? null : controller.generateBrief,
            icon: const Icon(Icons.auto_awesome_outlined, size: 16),
            label: Text(
              snapshot?.brief == null ? 'Create brief' : 'Refresh brief',
            ),
          ),
        ],
        primaryAction: FilledButton.icon(
          key: const Key('macos-today-add'),
          onPressed: controller.acting ? null : () => _addItem(context),
          icon: const Icon(Icons.add_rounded, size: 17),
          label: const Text('Add focus'),
        ),
        toolbar: _TodayToolbar(
          open: openCount,
          complete: completeCount,
          projects: snapshot?.projects.length ?? 0,
          conversations: snapshot?.threads.length ?? 0,
          refreshing: controller.loading,
        ),
        inspector: snapshot == null
            ? null
            : _TodayInspector(
                snapshot: snapshot,
                acting: controller.acting,
                onGenerateBrief: controller.generateBrief,
              ),
        inspectorWidth: 390,
        inspectorMinWidth: 330,
        inspectorMaxWidth: 520,
        body: _TodayBody(
          controller: controller,
          snapshot: snapshot,
          focusItemId: focusItemId,
        ),
      );
    },
  );

  Future<void> _addItem(BuildContext context) async {
    final result = await showDialog<({String title, TodayPriority priority})>(
      context: context,
      builder: (_) => const _AddFocusDialog(),
    );
    if (result != null) {
      await controller.add(result.title, priority: result.priority);
    }
  }
}

class _AddFocusDialog extends StatefulWidget {
  const _AddFocusDialog();

  @override
  State<_AddFocusDialog> createState() => _AddFocusDialogState();
}

class _AddFocusDialogState extends State<_AddFocusDialog> {
  final _title = TextEditingController();
  TodayPriority _priority = TodayPriority.medium;

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  void _submit() {
    final title = _title.text.trim();
    if (title.isEmpty) return;
    Navigator.pop(context, (title: title, priority: _priority));
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Add focus item'),
    content: SizedBox(
      width: 440,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            key: const Key('macos-today-add-title'),
            controller: _title,
            autofocus: true,
            maxLength: 280,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
            decoration: const InputDecoration(
              labelText: 'What needs attention?',
            ),
          ),
          const SizedBox(height: 10),
          DropdownButtonFormField<TodayPriority>(
            initialValue: _priority,
            decoration: const InputDecoration(labelText: 'Priority'),
            items: TodayPriority.values
                .map(
                  (value) => DropdownMenuItem(
                    value: value,
                    child: Text(_sentenceCase(value.name)),
                  ),
                )
                .toList(),
            onChanged: (value) {
              if (value != null) setState(() => _priority = value);
            },
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        key: const Key('macos-today-add-submit'),
        onPressed: _submit,
        child: const Text('Add focus'),
      ),
    ],
  );
}

class _TodayToolbar extends StatelessWidget {
  const _TodayToolbar({
    required this.open,
    required this.complete,
    required this.projects,
    required this.conversations,
    required this.refreshing,
  });

  final int open;
  final int complete;
  final int projects;
  final int conversations;
  final bool refreshing;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          Icon(
            refreshing ? Icons.sync_rounded : Icons.calendar_today_outlined,
            size: 15,
            color: refreshing
                ? Theme.of(context).colorScheme.primary
                : Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 7),
          Text(
            refreshing ? 'Refreshing server truth' : _longDate(DateTime.now()),
            style: Theme.of(context).textTheme.labelMedium,
          ),
          _ToolbarDivider(color: mac.divider),
          _ToolbarFact(
            icon: Icons.radio_button_unchecked_rounded,
            label: '$open open',
          ),
          _ToolbarFact(
            icon: Icons.check_circle_outline_rounded,
            label: '$complete complete',
          ),
          _ToolbarFact(
            icon: Icons.folder_open_outlined,
            label: '$projects active projects',
          ),
          _ToolbarFact(
            icon: Icons.forum_outlined,
            label: '$conversations conversations',
          ),
        ],
      ),
    );
  }
}

class _ToolbarDivider extends StatelessWidget {
  const _ToolbarDivider({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 1,
    height: 19,
    color: color,
    margin: const EdgeInsets.symmetric(horizontal: 13),
  );
}

class _ToolbarFact extends StatelessWidget {
  const _ToolbarFact({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(right: 18),
    child: Row(
      children: [
        Icon(icon, size: 14),
        const SizedBox(width: 6),
        Text(label, style: Theme.of(context).textTheme.labelMedium),
      ],
    ),
  );
}

class _TodayBody extends StatelessWidget {
  const _TodayBody({
    required this.controller,
    required this.snapshot,
    required this.focusItemId,
  });

  final TodayController controller;
  final TodaySnapshot? snapshot;
  final String? focusItemId;

  @override
  Widget build(BuildContext context) {
    final data = snapshot;
    if (controller.loading && data == null) {
      return const MacosLoadingList(rows: 9);
    }
    if (data == null) {
      if (controller.error != null) {
        return MacosEmptyState(
          icon: Icons.cloud_off_outlined,
          title: 'Today is unavailable',
          message: 'Asael could not load the current Today projection. No empty or healthy state has been assumed.',
          action: FilledButton.icon(
            onPressed: controller.refresh,
            icon: const Icon(Icons.refresh_rounded),
            label: const Text('Retry loading'),
          ),
        );
      }
      return MacosEmptyState(
        icon: Icons.today_outlined,
        title: 'Load your day',
        message: 'Refresh to retrieve priorities, the daily brief, and current project context.',
        action: FilledButton.icon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Load Today'),
        ),
      );
    }

    final items = [...data.items]
      ..sort((left, right) {
        if (left.id == focusItemId && right.id != focusItemId) return -1;
        if (right.id == focusItemId && left.id != focusItemId) return 1;
        if (left.isDone != right.isDone) return left.isDone ? 1 : -1;
        final priority = right.priority.index.compareTo(left.priority.index);
        if (priority != 0) return priority;
        return _compareDates(left.dueAt, right.dueAt);
      });
    final open = items.where((item) => !item.isDone).length;

    return Column(
      children: [
        if (controller.loading) const LinearProgressIndicator(minHeight: 2),
        if (controller.error != null)
          _TodayTruthBanner(
            error: controller.error!,
            onRetry: controller.refresh,
          ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: MacosPane(
              padding: EdgeInsets.zero,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 12, 12),
                    child: MacosSectionHeader(
                      title: 'Focus list',
                      description: open == 0
                          ? 'No open work needs attention.'
                          : '$open item${open == 1 ? '' : 's'} still need attention.',
                      trailing: Text(
                        '${items.length} total',
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                      ),
                    ),
                  ),
                  const Divider(),
                  Expanded(
                    child: items.isEmpty
                        ? const MacosEmptyState(
                            icon: Icons.task_alt_rounded,
                            title: 'The focus list is clear',
                            message: 'Add a focus item when something should be visible in today’s operating view.',
                          )
                        : Scrollbar(
                            child: ListView.separated(
                              padding: const EdgeInsets.only(bottom: 8),
                              itemCount: items.length,
                              separatorBuilder: (_, _) =>
                                  const Divider(indent: 50, endIndent: 12),
                              itemBuilder: (context, index) {
                                final item = items[index];
                                return _TodayItemRow(
                                  key: Key('macos-today-item-${item.id}'),
                                  item: item,
                                  focused: item.id == focusItemId,
                                  busy: controller.updating.contains(item.id),
                                  onToggle: () => controller.toggle(item),
                                );
                              },
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _TodayTruthBanner extends StatelessWidget {
  const _TodayTruthBanner({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final conflict = error is ApiConflictException;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        color: conflict ? scheme.secondaryContainer : scheme.errorContainer,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
        child: Row(
          children: [
            Icon(
              conflict ? Icons.sync_problem_outlined : Icons.cloud_off_outlined,
              size: 17,
              color: conflict ? scheme.onSecondaryContainer : scheme.error,
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                conflict
                    ? 'This item changed elsewhere. The newer server version is shown.'
                    : 'An update failed. The last available Today projection remains visible.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: conflict
                      ? scheme.onSecondaryContainer
                      : scheme.onErrorContainer,
                ),
              ),
            ),
            TextButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}

class _TodayItemRow extends StatelessWidget {
  const _TodayItemRow({
    super.key,
    required this.item,
    required this.focused,
    required this.busy,
    required this.onToggle,
  });

  final TodayItem item;
  final bool focused;
  final bool busy;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    final priorityColor = switch (item.priority) {
      TodayPriority.high => scheme.error,
      TodayPriority.medium => mac.warning,
      TodayPriority.low => scheme.onSurfaceVariant,
    };
    final status = item.isDone ? 'Complete' : 'Open';
    final metadata = <String>[
      _sentenceCase(item.kind),
      '${_sentenceCase(item.priority.name)} priority',
      if (item.dueAt != null) 'Due ${_shortDate(item.dueAt!)}',
      if (item.reminderState != 'none')
        _sentenceCase(item.reminderState.replaceAll('_', ' ')),
    ];

    return Semantics(
      button: true,
      checked: item.isDone,
      label: '${item.title}, $status, ${metadata.join(', ')}',
      hint: item.isDone ? 'Mark as open' : 'Mark as complete',
      child: Material(
        color: focused ? mac.selection : Colors.transparent,
        child: InkWell(
          onTap: busy ? null : onToggle,
          canRequestFocus: true,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 14, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 32,
                  height: 30,
                  child: busy
                      ? const Padding(
                          padding: EdgeInsets.all(7),
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Checkbox(
                          value: item.isDone,
                          onChanged: (_) => onToggle(),
                        ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        item.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          decoration: item.isDone
                              ? TextDecoration.lineThrough
                              : null,
                          color: item.isDone
                              ? scheme.onSurfaceVariant
                              : scheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        metadata.join('  ·  '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 16),
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: item.isDone ? mac.positive : priorityColor,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 7),
                      Text(
                        status,
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: item.isDone ? mac.positive : priorityColor,
                            ),
                      ),
                    ],
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

class _TodayInspector extends StatelessWidget {
  const _TodayInspector({
    required this.snapshot,
    required this.acting,
    required this.onGenerateBrief,
  });

  final TodaySnapshot snapshot;
  final bool acting;
  final VoidCallback onGenerateBrief;

  @override
  Widget build(BuildContext context) => Scrollbar(
    child: ListView(
      key: const Key('macos-today-inspector'),
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
      children: [
        _BriefSection(
          brief: snapshot.brief,
          acting: acting,
          onGenerate: onGenerateBrief,
        ),
        const SizedBox(height: 20),
        const Divider(),
        const SizedBox(height: 18),
        _ProjectContext(projects: snapshot.projects),
        const SizedBox(height: 20),
        const Divider(),
        const SizedBox(height: 18),
        _ConversationContext(threads: snapshot.threads),
      ],
    ),
  );
}

class _BriefSection extends StatelessWidget {
  const _BriefSection({
    required this.brief,
    required this.acting,
    required this.onGenerate,
  });

  final DailyBrief? brief;
  final bool acting;
  final VoidCallback onGenerate;

  @override
  Widget build(BuildContext context) {
    final data = brief;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MacosSectionHeader(
          title: 'Daily brief',
          description: data?.generatedAt == null
              ? 'A concise reading of current priorities.'
              : 'Generated ${_relativeTime(data!.generatedAt!)}',
          trailing: Icon(
            Icons.auto_awesome_outlined,
            size: 17,
            color: Theme.of(context).colorScheme.primary,
          ),
        ),
        const SizedBox(height: 14),
        if (data == null) ...[
          Text(
            'No brief has been generated for this projection.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: acting ? null : onGenerate,
            icon: const Icon(Icons.auto_awesome_outlined, size: 16),
            label: const Text('Create daily brief'),
          ),
        ] else ...[
          SelectableText(
            data.summary.isEmpty
                ? 'The generated brief did not include a summary.'
                : data.summary,
            style: Theme.of(context).textTheme.bodyMedium
                ?.copyWith(fontWeight: FontWeight.w500),
          ),
          if (data.focus.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              'Recommended focus',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 7),
            for (final focus in data.focus.take(4))
              Padding(
                padding: const EdgeInsets.only(bottom: 9),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Padding(
                      padding: EdgeInsets.only(top: 3),
                      child: Icon(Icons.arrow_forward_rounded, size: 14),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            focus.title,
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(fontWeight: FontWeight.w600),
                          ),
                          if (focus.reason.isNotEmpty)
                            Text(
                              focus.reason,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (data.watchouts.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.secondaryContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.warning_amber_rounded, size: 16),
                      const SizedBox(width: 7),
                      Text(
                        'Watchouts',
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  for (final watchout in data.watchouts.take(4))
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text('• $watchout'),
                    ),
                ],
              ),
            ),
          ],
        ],
      ],
    );
  }
}

class _ProjectContext extends StatelessWidget {
  const _ProjectContext({required this.projects});
  final List<({int completed, String id, String title, int total})> projects;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      MacosSectionHeader(
        title: 'Active projects',
        description: projects.isEmpty
            ? 'No project context is attached.'
            : '${projects.length} project${projects.length == 1 ? '' : 's'} in view',
      ),
      const SizedBox(height: 10),
      if (projects.isEmpty)
        Text(
          'Project progress will appear here when work is active.',
          style: Theme.of(context).textTheme.bodySmall,
        )
      else
        for (final project in projects.take(6))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        project.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium
                            ?.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      '${project.completed}/${project.total}',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                LinearProgressIndicator(
                  value: project.total == 0
                      ? 0
                      : (project.completed / project.total).clamp(0, 1),
                  minHeight: 3,
                ),
              ],
            ),
          ),
    ],
  );
}

class _ConversationContext extends StatelessWidget {
  const _ConversationContext({required this.threads});
  final List<({String id, String title})> threads;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      MacosSectionHeader(
        title: 'Recent conversations',
        description: threads.isEmpty
            ? 'No recent conversation context.'
            : '${threads.length} recent thread${threads.length == 1 ? '' : 's'}',
      ),
      const SizedBox(height: 8),
      if (threads.isEmpty)
        Text(
          'Conversations that inform current work will appear here.',
          style: Theme.of(context).textTheme.bodySmall,
        )
      else
        for (final thread in threads.take(7))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Row(
              children: [
                Icon(
                  Icons.chat_bubble_outline_rounded,
                  size: 15,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    thread.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
    ],
  );
}

int _compareDates(DateTime? left, DateTime? right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left.compareTo(right);
}

String _sentenceCase(String value) => value.isEmpty
    ? value
    : '${value.substring(0, 1).toUpperCase()}${value.substring(1)}';

String _longDate(DateTime value) {
  const weekdays = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return '${weekdays[value.weekday - 1]}, ${months[value.month - 1]} ${value.day}';
}

String _shortDate(DateTime value) {
  final local = value.toLocal();
  final hour = local.hour == 0
      ? 12
      : local.hour > 12
      ? local.hour - 12
      : local.hour;
  final minute = local.minute.toString().padLeft(2, '0');
  final period = local.hour >= 12 ? 'PM' : 'AM';
  return '${local.month}/${local.day}, $hour:$minute $period';
}

String _relativeTime(DateTime value) {
  final difference = DateTime.now().difference(value.toLocal());
  if (difference.isNegative || difference.inMinutes < 1) return 'just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes} min ago';
  if (difference.inHours < 24) return '${difference.inHours} hr ago';
  if (difference.inDays == 1) return 'yesterday';
  return '${difference.inDays} days ago';
}
