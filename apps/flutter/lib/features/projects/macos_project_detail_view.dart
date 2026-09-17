import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../../core/network/api_client.dart';
import '../macos_detail_support.dart';
import 'app_builder_view.dart';
import 'projects.dart';

enum _ProjectWorkspaceTab { plan, execution, artifacts, build }

/// The macOS project workspace. It uses the same governed repository as the
/// portable detail screen, but presents planning, execution, and evidence as a
/// persistent desktop document instead of a stack of mobile cards.
class MacosProjectDetailView extends StatefulWidget {
  const MacosProjectDetailView({
    super.key,
    required this.id,
    required this.repository,
    required this.api,
    this.focusWorkItemId,
  });

  final String id;
  final ProjectsRepository repository;
  final ApiClient api;
  final String? focusWorkItemId;

  @override
  State<MacosProjectDetailView> createState() => _MacosProjectDetailViewState();
}

class _MacosProjectDetailViewState extends State<MacosProjectDetailView> {
  Project? _project;
  Object? _error;
  bool _busy = true;
  _ProjectWorkspaceTab _tab = _ProjectWorkspaceTab.plan;
  String? _selectedArtifactId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant MacosProjectDetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.id != widget.id) {
      _project = null;
      _selectedArtifactId = null;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final project = await widget.repository.detail(widget.id);
      if (!mounted) return;
      setState(() {
        _project = project;
        if (project.artifacts.every((item) => item.id != _selectedArtifactId)) {
          _selectedArtifactId = project.artifacts.firstOrNull?.id;
        }
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      await _load();
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error;
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true): () =>
          macosNavigateBack(context, '/projects'),
      const SingleActivator(LogicalKeyboardKey.keyR, meta: true): _load,
    },
    child: Focus(autofocus: true, child: _buildPage(context)),
  );

  Widget _buildPage(BuildContext context) {
    final project = _project;
    return MacosPageScaffold(
      title: project?.title ?? 'Project',
      description:
          project?.objective ??
          'Plan the work, supervise execution, and inspect verified output.',
      icon: Icons.folder_open_outlined,
      actions: [
        IconButton(
          key: const Key('macos-project-detail-refresh'),
          tooltip: 'Refresh project (⌘R)',
          onPressed: _busy ? null : _load,
          icon: _busy
              ? const SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      primaryAction: project == null ? null : _primaryAction(project),
      toolbar: _ProjectToolbar(
        tab: _tab,
        busy: _busy,
        onTabChanged: (value) => setState(() => _tab = value),
      ),
      inspector: project == null
          ? null
          : _ProjectInspector(
              project: project,
              busy: _busy,
              onToggleComplete: () => _run(
                () => widget.repository
                    .update(project.id, {
                      'status': project.status == 'active'
                          ? 'completed'
                          : 'active',
                    })
                    .then((_) {}),
              ),
              onArchive: project.status == 'archived'
                  ? null
                  : () => _run(
                      () => widget.repository
                          .update(project.id, {'status': 'archived'})
                          .then((_) {}),
                    ),
            ),
      inspectorWidth: 340,
      inspectorMinWidth: 300,
      inspectorMaxWidth: 440,
      body: _projectBody(project),
    );
  }

  Widget _projectBody(Project? project) {
    if (_busy && project == null) return const MacosLoadingList(rows: 8);
    if (_error != null && project == null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'The project is unavailable',
        message: 'Asael could not load this project workspace. Check the connection and try again.',
        action: FilledButton.tonalIcon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
      );
    }
    if (project == null) {
      return const MacosEmptyState(
        icon: Icons.folder_off_outlined,
        title: 'Project not found',
        message:
            'This project is no longer available to the current workspace.',
      );
    }

    return Column(
      children: [
        if (_error != null)
          MacosDetailNotice(
            message: 'The last action did not finish: ${_error.toString()}',
            tone: MacosDetailTone.danger,
            action: TextButton(onPressed: _load, child: const Text('Retry')),
          ),
        Expanded(
          child: switch (_tab) {
            _ProjectWorkspaceTab.plan => _PlanWorkspace(
              project: project,
              busy: _busy,
              focusWorkItemId: widget.focusWorkItemId,
              onPlan: () =>
                  _run(() => widget.repository.plan(project.id).then((_) {})),
              onAddTask: () => _addTask(project),
              onStatusChanged: (task, status) => _run(
                () => widget.repository
                    .updateTask(project.id, task.id, {'status': status})
                    .then((_) {}),
              ),
              onApprove: (task) => _run(
                () => widget.repository
                    .execute(project.id, 'approve', taskId: task.id)
                    .then((_) {}),
              ),
            ),
            _ProjectWorkspaceTab.execution => _ExecutionWorkspace(
              project: project,
              busy: _busy,
              onAction: (action, {config}) => _run(
                () => widget.repository
                    .execute(project.id, action, config: config)
                    .then((_) {}),
              ),
            ),
            _ProjectWorkspaceTab.artifacts => _ArtifactsWorkspace(
              project: project,
              selectedArtifactId: _selectedArtifactId,
              onSelect: (artifact) =>
                  setState(() => _selectedArtifactId = artifact.id),
              onReflect: (artifact) => _reflect(project, artifact),
            ),
            _ProjectWorkspaceTab.build => AppBuilderView(
              project: project,
              api: widget.api,
            ),
          },
        ),
      ],
    );
  }

  Widget _primaryAction(Project project) {
    if (project.tasks.isEmpty) {
      return FilledButton.icon(
        key: const Key('macos-project-plan'),
        onPressed: _busy || project.status != 'active'
            ? null
            : () => _run(() => widget.repository.plan(project.id).then((_) {})),
        icon: const Icon(Icons.auto_awesome_rounded, size: 17),
        label: const Text('Create plan'),
      );
    }
    final canStart = project.status == 'active' && !project.activeExecution;
    return FilledButton.icon(
      key: const Key('macos-project-start'),
      onPressed: _busy || !canStart
          ? null
          : () => _run(
              () => widget.repository
                  .execute(
                    project.id,
                    'start',
                    config: ExecutionConfig(
                      autonomyMode: project.autonomyMode == 'autonomous'
                          ? 'autonomous'
                          : 'supervised',
                      taskBudget: project.taskBudget,
                      maxParallelTasks: project.maxParallelTasks,
                      requireApproval: project.requireApproval,
                    ),
                  )
                  .then((_) {}),
            ),
      icon: Icon(
        project.activeExecution ? Icons.bolt_rounded : Icons.play_arrow_rounded,
        size: 17,
      ),
      label: Text(project.activeExecution ? 'Execution active' : 'Start run'),
    );
  }

  Future<void> _addTask(Project project) async {
    final title = TextEditingController();
    final detail = TextEditingController();
    var priority = 'medium';
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Add project task'),
          content: SizedBox(
            width: 520,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  key: const Key('macos-project-task-title'),
                  controller: title,
                  autofocus: true,
                  decoration: const InputDecoration(labelText: 'Task'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: detail,
                  minLines: 2,
                  maxLines: 5,
                  decoration: const InputDecoration(
                    labelText: 'Context or acceptance criteria',
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  initialValue: priority,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: const [
                    DropdownMenuItem(value: 'low', child: Text('Low')),
                    DropdownMenuItem(value: 'medium', child: Text('Medium')),
                    DropdownMenuItem(value: 'high', child: Text('High')),
                  ],
                  onChanged: (value) {
                    if (value != null) setDialogState(() => priority = value);
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const Key('macos-project-task-submit'),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Add task'),
            ),
          ],
        ),
      ),
    );
    final taskTitle = title.text.trim();
    final taskDetail = detail.text.trim();
    title.dispose();
    detail.dispose();
    if (accepted != true || taskTitle.isEmpty) return;
    await _run(
      () => widget.repository
          .createTask(
            project.id,
            title: taskTitle,
            detail: taskDetail,
            priority: priority,
          )
          .then((_) {}),
    );
  }

  Future<void> _reflect(Project project, ProjectArtifact artifact) async {
    var verdict = artifact.verdict ?? 'useful';
    final lesson = TextEditingController(text: artifact.lesson);
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Artifact feedback'),
          content: SizedBox(
            width: 520,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: verdict,
                  decoration: const InputDecoration(labelText: 'Verdict'),
                  items: const [
                    DropdownMenuItem(value: 'useful', child: Text('Useful')),
                    DropdownMenuItem(
                      value: 'needs_work',
                      child: Text('Needs work'),
                    ),
                  ],
                  onChanged: (value) {
                    if (value != null) setDialogState(() => verdict = value);
                  },
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: lesson,
                  minLines: 3,
                  maxLines: 7,
                  decoration: const InputDecoration(
                    labelText: 'Lesson for future planning',
                    alignLabelWithHint: true,
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Save feedback'),
            ),
          ],
        ),
      ),
    );
    final lessonText = lesson.text.trim();
    lesson.dispose();
    if (accepted != true || lessonText.length < 3) return;
    await _run(
      () => widget.repository
          .reflect(
            project.id,
            artifact.id,
            verdict: verdict,
            lesson: lessonText,
          )
          .then((_) {}),
    );
  }
}

class _ProjectToolbar extends StatelessWidget {
  const _ProjectToolbar({
    required this.tab,
    required this.busy,
    required this.onTabChanged,
  });

  final _ProjectWorkspaceTab tab;
  final bool busy;
  final ValueChanged<_ProjectWorkspaceTab> onTabChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      const MacosDetailBackButton(
        fallbackLocation: '/projects',
        label: 'Projects',
      ),
      const SizedBox(width: 10),
      Expanded(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SegmentedButton<_ProjectWorkspaceTab>(
            key: const Key('macos-project-detail-tabs'),
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(
                value: _ProjectWorkspaceTab.plan,
                icon: Icon(Icons.account_tree_outlined, size: 15),
                label: Text('Plan'),
              ),
              ButtonSegment(
                value: _ProjectWorkspaceTab.execution,
                icon: Icon(Icons.bolt_outlined, size: 15),
                label: Text('Execution'),
              ),
              ButtonSegment(
                value: _ProjectWorkspaceTab.artifacts,
                icon: Icon(Icons.fact_check_outlined, size: 15),
                label: Text('Artifacts'),
              ),
              ButtonSegment(
                value: _ProjectWorkspaceTab.build,
                icon: Icon(Icons.code_rounded, size: 15),
                label: Text('Build'),
              ),
            ],
            selected: {tab},
            onSelectionChanged: busy
                ? null
                : (values) => onTabChanged(values.first),
          ),
        ),
      ),
    ],
  );
}

class _PlanWorkspace extends StatelessWidget {
  const _PlanWorkspace({
    required this.project,
    required this.busy,
    required this.focusWorkItemId,
    required this.onPlan,
    required this.onAddTask,
    required this.onStatusChanged,
    required this.onApprove,
  });

  final Project project;
  final bool busy;
  final String? focusWorkItemId;
  final VoidCallback onPlan;
  final VoidCallback onAddTask;
  final void Function(ProjectTask task, String status) onStatusChanged;
  final ValueChanged<ProjectTask> onApprove;

  @override
  Widget build(BuildContext context) {
    final tasks = [...project.tasks]
      ..sort((left, right) {
        if (left.id == focusWorkItemId) return -1;
        if (right.id == focusWorkItemId) return 1;
        return left.position.compareTo(right.position);
      });
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 12),
          child: MacosSectionHeader(
            title: 'Work plan',
            description:
                '${project.completedTasks} of ${project.tasks.length} tasks complete',
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                OutlinedButton.icon(
                  onPressed: busy || project.status != 'active'
                      ? null
                      : onAddTask,
                  icon: const Icon(Icons.add_rounded, size: 16),
                  label: const Text('Add task'),
                ),
                const SizedBox(width: 8),
                FilledButton.tonalIcon(
                  onPressed: busy || project.status != 'active' ? null : onPlan,
                  icon: const Icon(Icons.auto_awesome_rounded, size: 16),
                  label: Text(tasks.isEmpty ? 'Create plan' : 'Extend plan'),
                ),
              ],
            ),
          ),
        ),
        const _TaskColumnHeader(),
        Expanded(
          child: tasks.isEmpty
              ? MacosEmptyState(
                  icon: Icons.account_tree_outlined,
                  title: 'This project has no work plan',
                  message: 'Ask Asael to decompose the objective, or add the first task yourself.',
                  action: FilledButton.icon(
                    onPressed: busy || project.status != 'active'
                        ? null
                        : onPlan,
                    icon: const Icon(Icons.auto_awesome_rounded),
                    label: const Text('Create plan'),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.only(bottom: 18),
                  itemCount: tasks.length,
                  itemBuilder: (context, index) => _TaskRow(
                    key: ValueKey('macos-project-task-${tasks[index].id}'),
                    task: tasks[index],
                    focused: tasks[index].id == focusWorkItemId,
                    busy: busy,
                    onStatusChanged: (status) =>
                        onStatusChanged(tasks[index], status),
                    onApprove: tasks[index].awaitingApproval
                        ? () => onApprove(tasks[index])
                        : null,
                  ),
                ),
        ),
      ],
    );
  }
}

class _TaskColumnHeader extends StatelessWidget {
  const _TaskColumnHeader();

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      height: 30,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border.symmetric(horizontal: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          const SizedBox(width: 28),
          Expanded(
            child: Text('TASK', style: Theme.of(context).textTheme.labelSmall),
          ),
          SizedBox(
            width: 92,
            child: Text('OWNER', style: Theme.of(context).textTheme.labelSmall),
          ),
          SizedBox(
            width: 78,
            child: Text(
              'PRIORITY',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ),
          SizedBox(
            width: 96,
            child: Text(
              'STATUS',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ),
          const SizedBox(width: 36),
        ],
      ),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    super.key,
    required this.task,
    required this.focused,
    required this.busy,
    required this.onStatusChanged,
    required this.onApprove,
  });

  final ProjectTask task;
  final bool focused, busy;
  final ValueChanged<String> onStatusChanged;
  final VoidCallback? onApprove;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      constraints: const BoxConstraints(minHeight: 58),
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
      decoration: BoxDecoration(
        color: focused ? mac.selection : Colors.transparent,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 28,
            child: Icon(
              task.done
                  ? Icons.check_circle_rounded
                  : task.status == 'doing'
                  ? Icons.timelapse_rounded
                  : Icons.circle_outlined,
              size: 17,
              color: task.done
                  ? mac.positive
                  : task.status == 'doing'
                  ? mac.warning
                  : Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(task.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                if (task.detail.isNotEmpty)
                  Text(
                    task.detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            ),
          ),
          SizedBox(
            width: 92,
            child: Text(
              task.agentId,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          SizedBox(
            width: 78,
            child: Text(
              macosHumanize(task.priority),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
          SizedBox(
            width: 96,
            child: MacosStatusBadge(
              label: macosHumanize(task.workflowStatus ?? task.status),
              tone: macosToneForStatus(task.workflowStatus ?? task.status),
            ),
          ),
          SizedBox(
            width: 36,
            child: onApprove != null
                ? IconButton(
                    tooltip: 'Approve this task',
                    onPressed: busy ? null : onApprove,
                    icon: const Icon(Icons.approval_outlined, size: 17),
                  )
                : PopupMenuButton<String>(
                    tooltip: 'Change task status',
                    enabled: !busy,
                    onSelected: onStatusChanged,
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'open', child: Text('Mark open')),
                      PopupMenuItem(
                        value: 'doing',
                        child: Text('Mark in progress'),
                      ),
                      PopupMenuItem(
                        value: 'done',
                        child: Text('Mark complete'),
                      ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _ExecutionWorkspace extends StatelessWidget {
  const _ExecutionWorkspace({
    required this.project,
    required this.busy,
    required this.onAction,
  });

  final Project project;
  final bool busy;
  final void Function(String action, {ExecutionConfig? config}) onAction;

  @override
  Widget build(BuildContext context) {
    final dispatchProgress = project.taskBudget == 0
        ? 0.0
        : (project.tasksDispatched / project.taskBudget).clamp(0.0, 1.0);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        MacosPane(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              MacosSectionHeader(
                title: 'Execution control',
                description: 'Governed agent dispatch with explicit budget and approval policy.',
                trailing: MacosStatusBadge(
                  label: macosHumanize(project.executionStatus),
                  tone: macosToneForStatus(project.executionStatus),
                ),
              ),
              const SizedBox(height: 20),
              LinearProgressIndicator(value: dispatchProgress),
              const SizedBox(height: 8),
              Text(
                '${project.tasksDispatched} of ${project.taskBudget} dispatches used',
              ),
              const SizedBox(height: 20),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.icon(
                    key: const Key('macos-project-execution-start'),
                    onPressed:
                        busy ||
                            project.activeExecution ||
                            project.tasks.isEmpty ||
                            project.status != 'active'
                        ? null
                        : () => onAction(
                            'start',
                            config: ExecutionConfig(
                              autonomyMode: project.autonomyMode == 'autonomous'
                                  ? 'autonomous'
                                  : 'supervised',
                              taskBudget: project.taskBudget,
                              maxParallelTasks: project.maxParallelTasks,
                              requireApproval: project.requireApproval,
                            ),
                          ),
                    icon: const Icon(Icons.play_arrow_rounded, size: 17),
                    label: const Text('Start'),
                  ),
                  OutlinedButton.icon(
                    onPressed: busy || project.executionStatus != 'running'
                        ? null
                        : () => onAction('pause'),
                    icon: const Icon(Icons.pause_rounded, size: 17),
                    label: const Text('Pause'),
                  ),
                  OutlinedButton.icon(
                    onPressed: busy || project.executionStatus != 'paused'
                        ? null
                        : () => onAction('resume'),
                    icon: const Icon(Icons.replay_rounded, size: 17),
                    label: const Text('Resume'),
                  ),
                  OutlinedButton.icon(
                    onPressed: busy || !project.activeExecution
                        ? null
                        : () => onAction('sync'),
                    icon: const Icon(Icons.sync_rounded, size: 17),
                    label: const Text('Sync state'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        LayoutBuilder(
          builder: (context, constraints) {
            final tiles = [
              _ExecutionMetric(
                label: 'Autonomy',
                value: macosHumanize(project.autonomyMode),
              ),
              _ExecutionMetric(
                label: 'Parallel lanes',
                value: '${project.maxParallelTasks}',
              ),
              _ExecutionMetric(
                label: 'Approval gate',
                value: project.requireApproval ? 'Required' : 'Policy based',
              ),
              _ExecutionMetric(
                label: 'Tasks complete',
                value: '${project.completedTasks} / ${project.tasks.length}',
              ),
            ];
            return Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                for (final tile in tiles)
                  SizedBox(
                    width: constraints.maxWidth >= 700
                        ? (constraints.maxWidth - 12) / 2
                        : constraints.maxWidth,
                    child: tile,
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _ExecutionMetric extends StatelessWidget {
  const _ExecutionMetric({required this.label, required this.value});
  final String label, value;

  @override
  Widget build(BuildContext context) => MacosPane(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 4),
        Text(value, style: Theme.of(context).textTheme.titleMedium),
      ],
    ),
  );
}

class _ArtifactsWorkspace extends StatelessWidget {
  const _ArtifactsWorkspace({
    required this.project,
    required this.selectedArtifactId,
    required this.onSelect,
    required this.onReflect,
  });

  final Project project;
  final String? selectedArtifactId;
  final ValueChanged<ProjectArtifact> onSelect;
  final ValueChanged<ProjectArtifact> onReflect;

  @override
  Widget build(BuildContext context) {
    if (project.artifacts.isEmpty) {
      return const MacosEmptyState(
        icon: Icons.fact_check_outlined,
        title: 'No verified output yet',
        message: 'Artifacts appear here as project tasks finish and their evidence is checked.',
      );
    }
    final selected = project.artifacts.firstWhere(
      (item) => item.id == selectedArtifactId,
      orElse: () => project.artifacts.first,
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        final rail = _ArtifactRail(
          artifacts: project.artifacts,
          selectedId: selected.id,
          onSelect: onSelect,
        );
        final document = _ArtifactDocument(
          artifact: selected,
          onReflect: () => onReflect(selected),
        );
        if (constraints.maxWidth < 720) {
          return Column(
            children: [
              SizedBox(height: 210, child: rail),
              const Divider(height: 1),
              Expanded(child: document),
            ],
          );
        }
        return Row(
          children: [
            SizedBox(width: 280, child: rail),
            const VerticalDivider(width: 1),
            Expanded(child: document),
          ],
        );
      },
    );
  }
}

class _ArtifactRail extends StatelessWidget {
  const _ArtifactRail({
    required this.artifacts,
    required this.selectedId,
    required this.onSelect,
  });
  final List<ProjectArtifact> artifacts;
  final String selectedId;
  final ValueChanged<ProjectArtifact> onSelect;

  @override
  Widget build(BuildContext context) => ListView.builder(
    padding: const EdgeInsets.symmetric(vertical: 8),
    itemCount: artifacts.length,
    itemBuilder: (context, index) {
      final artifact = artifacts[index];
      return ListTile(
        selected: artifact.id == selectedId,
        leading: Icon(
          artifact.verified ? Icons.verified_outlined : Icons.policy_outlined,
          size: 18,
        ),
        title: Text(
          artifact.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${artifact.agentId} · ${macosHumanize(artifact.status)}',
        ),
        onTap: () => onSelect(artifact),
      );
    },
  );
}

class _ArtifactDocument extends StatelessWidget {
  const _ArtifactDocument({required this.artifact, required this.onReflect});
  final ProjectArtifact artifact;
  final VoidCallback onReflect;

  @override
  Widget build(BuildContext context) => SelectionArea(
    child: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                artifact.title,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
            ),
            MacosStatusBadge(
              label: macosHumanize(artifact.status),
              tone: macosToneForStatus(artifact.status),
              icon: artifact.verified ? Icons.verified_rounded : null,
            ),
          ],
        ),
        const SizedBox(height: 5),
        Text(
          '${artifact.agentId} · ${artifact.evidenceRefs.length} evidence references',
        ),
        const SizedBox(height: 22),
        Text(artifact.content, style: const TextStyle(height: 1.58)),
        const SizedBox(height: 24),
        MacosPane(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const MacosSectionHeader(title: 'Evidence'),
              const SizedBox(height: 8),
              if (artifact.evidenceRefs.isEmpty)
                const Text('No evidence references were recorded.')
              else
                for (final reference in artifact.evidenceRefs)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        const Icon(Icons.link_rounded, size: 16),
                        const SizedBox(width: 8),
                        Expanded(child: SelectableText(reference)),
                      ],
                    ),
                  ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            onPressed: onReflect,
            icon: const Icon(Icons.rate_review_outlined, size: 17),
            label: Text(
              artifact.verdict == null ? 'Add feedback' : 'Update feedback',
            ),
          ),
        ),
      ],
    ),
  );
}

class _ProjectInspector extends StatelessWidget {
  const _ProjectInspector({
    required this.project,
    required this.busy,
    required this.onToggleComplete,
    required this.onArchive,
  });

  final Project project;
  final bool busy;
  final VoidCallback onToggleComplete;
  final VoidCallback? onArchive;

  @override
  Widget build(BuildContext context) => ListView(
    children: [
      MacosInspectorSection(
        title: 'Progress',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '${(project.progress * 100).round()}%',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const Spacer(),
                MacosStatusBadge(
                  label: macosHumanize(project.status),
                  tone: macosToneForStatus(project.status),
                ),
              ],
            ),
            const SizedBox(height: 10),
            LinearProgressIndicator(value: project.progress),
            const SizedBox(height: 7),
            Text(
              '${project.completedTasks} of ${project.tasks.length} tasks completed',
            ),
          ],
        ),
      ),
      MacosInspectorSection(
        title: 'Execution',
        child: Column(
          children: [
            MacosKeyValue(
              label: 'State',
              value: macosHumanize(project.executionStatus),
            ),
            MacosKeyValue(
              label: 'Autonomy',
              value: macosHumanize(project.autonomyMode),
            ),
            MacosKeyValue(
              label: 'Budget',
              value: '${project.tasksDispatched} / ${project.taskBudget}',
            ),
            MacosKeyValue(
              label: 'Parallel',
              value: '${project.maxParallelTasks} lanes',
            ),
            MacosKeyValue(
              label: 'Approval',
              value: project.requireApproval ? 'Required' : 'Policy based',
            ),
          ],
        ),
      ),
      MacosInspectorSection(
        title: 'Project',
        child: Column(
          children: [
            MacosKeyValue(label: 'Identifier', value: project.id),
            MacosKeyValue(
              label: 'Target',
              value: project.targetDate == null
                  ? 'Not scheduled'
                  : MaterialLocalizations.of(context)
                        .formatMediumDate(project.targetDate!.toLocal()),
            ),
            MacosKeyValue(
              label: 'Updated',
              value: project.updatedAt == null
                  ? 'Unknown'
                  : MaterialLocalizations.of(context)
                        .formatMediumDate(project.updatedAt!.toLocal()),
            ),
          ],
        ),
      ),
      MacosInspectorSection(
        title: 'Project actions',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            OutlinedButton.icon(
              key: const Key('macos-project-toggle-complete'),
              onPressed: busy ? null : onToggleComplete,
              icon: Icon(
                project.status == 'active'
                    ? Icons.check_rounded
                    : Icons.replay_rounded,
                size: 17,
              ),
              label: Text(
                project.status == 'active' ? 'Mark complete' : 'Reopen project',
              ),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: busy ? null : onArchive,
              icon: const Icon(Icons.archive_outlined, size: 17),
              label: const Text('Archive project'),
            ),
          ],
        ),
      ),
      const SizedBox(height: 20),
    ],
  );
}
