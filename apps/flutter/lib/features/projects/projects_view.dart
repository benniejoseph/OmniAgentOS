import 'package:flutter/material.dart';

import 'projects.dart';

class ProjectsView extends StatelessWidget {
  const ProjectsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ProjectsController controller;
  final ValueChanged<Project> onOpen;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (_, _) => Scaffold(
      appBar: AppBar(
        title: const Text('Projects'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: controller.refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: controller.acting ? null : () => _create(context),
        icon: const Icon(Icons.add_rounded),
        label: const Text('New project'),
      ),
      body: RefreshIndicator(
        onRefresh: controller.refresh,
        child: controller.loading && controller.projects.isEmpty
            ? const _ProjectsSkeleton()
            : controller.error != null && controller.projects.isEmpty
            ? ListView(
                children: [
                  const SizedBox(height: 180),
                  _ErrorCard(
                    error: controller.error!,
                    retry: controller.refresh,
                  ),
                ],
              )
            : CustomScrollView(
                slivers: [
                  SliverToBoxAdapter(
                    child: _PortfolioSummary(projects: controller.projects),
                  ),
                  if (controller.projects.isEmpty)
                    const SliverFillRemaining(
                      child: Center(
                        child: Text(
                          'Turn an outcome into a durable agent plan.',
                        ),
                      ),
                    )
                  else
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
                      sliver: SliverList.builder(
                        itemCount: controller.projects.length,
                        itemBuilder: (_, i) {
                          final p = controller.projects[i];
                          return Card(
                            child: ListTile(
                              contentPadding: const EdgeInsets.all(16),
                              onTap: () => onOpen(p),
                              leading: _StatusIcon(status: p.executionStatus),
                              title: Text(
                                p.title,
                                style: const TextStyle(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              subtitle: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const SizedBox(height: 6),
                                  Text(
                                    p.objective,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 12),
                                  LinearProgressIndicator(value: p.progress),
                                  const SizedBox(height: 6),
                                  Text(
                                    '${p.completedTasks}/${p.tasks.length} tasks · ${p.status} · ${p.executionStatus}',
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelSmall,
                                  ),
                                ],
                              ),
                              trailing: const Icon(Icons.chevron_right_rounded),
                            ),
                          );
                        },
                      ),
                    ),
                ],
              ),
      ),
    ),
  );
  Future<void> _create(BuildContext context) async {
    final title = TextEditingController(), objective = TextEditingController();
    final submit = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('New project'),
        content: SizedBox(
          width: 480,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: title,
                autofocus: true,
                maxLength: 180,
                decoration: const InputDecoration(labelText: 'Project name'),
              ),
              TextField(
                controller: objective,
                maxLength: 2000,
                minLines: 2,
                maxLines: 4,
                decoration: const InputDecoration(
                  labelText: 'Successful outcome',
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (submit == true &&
        title.text.trim().isNotEmpty &&
        objective.text.trim().isNotEmpty) {
      final p = await controller.create(
        title: title.text.trim(),
        objective: objective.text.trim(),
      );
      if (p != null && context.mounted) onOpen(p);
    }
    title.dispose();
    objective.dispose();
  }
}

class ProjectDetailView extends StatefulWidget {
  const ProjectDetailView({
    super.key,
    required this.id,
    required this.repository,
  });
  final String id;
  final ProjectsRepository repository;
  @override
  State<ProjectDetailView> createState() => _ProjectDetailViewState();
}

class _ProjectDetailViewState extends State<ProjectDetailView> {
  Project? project;
  Object? error;
  bool busy = true;
  int tab = 0;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      project = await widget.repository.detail(widget.id);
    } catch (e) {
      error = e;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _run(Future<void> Function() fn) async {
    setState(() => busy = true);
    try {
      await fn();
      await _load();
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e;
          busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = project;
    return Scaffold(
      appBar: AppBar(
        title: Text(p?.title ?? 'Project'),
        actions: [
          IconButton(
            onPressed: busy ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: busy && p == null
          ? const Center(child: CircularProgressIndicator())
          : error != null && p == null
          ? _ErrorCard(error: error!, retry: _load)
          : p == null
          ? const SizedBox()
          : Column(
              children: [
                _ProjectHero(project: p),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: SegmentedButton<int>(
                    segments: const [
                      ButtonSegment(
                        value: 0,
                        label: Text('Plan'),
                        icon: Icon(Icons.account_tree_outlined),
                      ),
                      ButtonSegment(
                        value: 1,
                        label: Text('Execution'),
                        icon: Icon(Icons.bolt_outlined),
                      ),
                      ButtonSegment(
                        value: 2,
                        label: Text('Artifacts'),
                        icon: Icon(Icons.fact_check_outlined),
                      ),
                    ],
                    selected: {tab},
                    onSelectionChanged: (v) => setState(() => tab = v.first),
                  ),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(
                      error.toString(),
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                Expanded(
                  child: IndexedStack(
                    index: tab,
                    children: [_tasks(p), _execution(p), _artifacts(p)],
                  ),
                ),
              ],
            ),
    );
  }

  Widget _tasks(Project p) => ListView(
    padding: const EdgeInsets.all(12),
    children: [
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          FilledButton.icon(
            onPressed: busy || p.status != 'active'
                ? null
                : () => _run(() => widget.repository.plan(p.id).then((_) {})),
            icon: const Icon(Icons.auto_awesome_rounded),
            label: Text(p.tasks.isEmpty ? 'Plan with Atlas' : 'Extend plan'),
          ),
          OutlinedButton.icon(
            onPressed: busy || p.status != 'active' ? null : () => _addTask(p),
            icon: const Icon(Icons.add_task_rounded),
            label: const Text('Add task'),
          ),
          OutlinedButton.icon(
            onPressed: busy
                ? null
                : () => _run(
                    () => widget.repository
                        .update(p.id, {
                          'status': p.status == 'active'
                              ? 'completed'
                              : 'active',
                        })
                        .then((_) {}),
                  ),
            icon: Icon(
              p.status == 'active' ? Icons.check_rounded : Icons.replay_rounded,
            ),
            label: Text(p.status == 'active' ? 'Complete' : 'Reopen'),
          ),
          OutlinedButton.icon(
            onPressed: busy || p.status == 'archived'
                ? null
                : () => _run(
                    () => widget.repository
                        .update(p.id, {'status': 'archived'})
                        .then((_) {}),
                  ),
            icon: const Icon(Icons.archive_outlined),
            label: const Text('Archive'),
          ),
        ],
      ),
      const SizedBox(height: 12),
      ...p.tasks.map(
        (t) => Card(
          child: ListTile(
            onTap: busy ? null : () => _cycle(p, t),
            leading: Icon(
              t.done
                  ? Icons.check_circle_rounded
                  : t.status == 'doing'
                  ? Icons.pending_rounded
                  : Icons.circle_outlined,
            ),
            title: Text(t.title),
            subtitle: Text(
              '${t.agentId} · ${t.priority}${t.workflowStatus == null ? '' : ' · ${t.workflowStatus}'}\n${t.detail}',
              maxLines: 3,
            ),
            trailing: t.awaitingApproval
                ? IconButton(
                    tooltip: 'Approve',
                    onPressed: () => _run(
                      () => widget.repository
                          .execute(p.id, 'approve', taskId: t.id)
                          .then((_) {}),
                    ),
                    icon: const Icon(Icons.approval_rounded),
                  )
                : const Icon(Icons.chevron_right_rounded),
          ),
        ),
      ),
    ],
  );
  Widget _execution(Project p) {
    final canStart = p.status == 'active' && p.tasks.isNotEmpty;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Agent execution · ${p.executionStatus}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 10),
                LinearProgressIndicator(
                  value: p.taskBudget == 0
                      ? 0
                      : p.tasksDispatched / p.taskBudget,
                ),
                const SizedBox(height: 8),
                Text(
                  '${p.tasksDispatched} / ${p.taskBudget} dispatches · ${p.maxParallelTasks} parallel lane(s)',
                ),
                const SizedBox(height: 6),
                Text(
                  p.requireApproval
                      ? 'Approval required before workflows'
                      : 'Policy-gated autonomous execution',
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: busy || !canStart || p.activeExecution
                  ? null
                  : () => _run(
                      () => widget.repository
                          .execute(
                            p.id,
                            'start',
                            config: ExecutionConfig(
                              autonomyMode: p.autonomyMode == 'autonomous'
                                  ? 'autonomous'
                                  : 'supervised',
                              taskBudget: p.taskBudget,
                              maxParallelTasks: p.maxParallelTasks,
                              requireApproval: p.requireApproval,
                            ),
                          )
                          .then((_) {}),
                    ),
              icon: const Icon(Icons.play_arrow_rounded),
              label: const Text('Start'),
            ),
            OutlinedButton.icon(
              onPressed: busy || p.executionStatus != 'running'
                  ? null
                  : () => _run(
                      () =>
                          widget.repository.execute(p.id, 'pause').then((_) {}),
                    ),
              icon: const Icon(Icons.pause_rounded),
              label: const Text('Pause'),
            ),
            OutlinedButton.icon(
              onPressed: busy || p.executionStatus != 'paused'
                  ? null
                  : () => _run(
                      () => widget.repository
                          .execute(p.id, 'resume')
                          .then((_) {}),
                    ),
              icon: const Icon(Icons.replay_rounded),
              label: const Text('Resume'),
            ),
            OutlinedButton.icon(
              onPressed: busy || !p.activeExecution
                  ? null
                  : () => _run(
                      () =>
                          widget.repository.execute(p.id, 'sync').then((_) {}),
                    ),
              icon: const Icon(Icons.sync_rounded),
              label: const Text('Sync'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _artifacts(Project p) => p.artifacts.isEmpty
      ? const Center(child: Text('Verified outputs will appear here.'))
      : ListView.builder(
          padding: const EdgeInsets.all(12),
          itemCount: p.artifacts.length,
          itemBuilder: (_, i) {
            final a = p.artifacts[i];
            return Card(
              child: ExpansionTile(
                leading: Icon(
                  a.verified
                      ? Icons.verified_rounded
                      : Icons.error_outline_rounded,
                ),
                title: Text(a.title),
                subtitle: Text(
                  '${a.agentId} · ${a.status} · ${a.evidenceRefs.length} evidence refs',
                ),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SelectableText(a.content),
                        const SizedBox(height: 12),
                        Text(
                          'Evidence: ${a.evidenceRefs.isEmpty ? 'No references recorded' : a.evidenceRefs.join(', ')}',
                        ),
                        const SizedBox(height: 8),
                        OutlinedButton.icon(
                          onPressed: () => _reflect(p, a),
                          icon: const Icon(Icons.rate_review_outlined),
                          label: Text(
                            a.verdict == null
                                ? 'Add feedback'
                                : 'Update feedback',
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            );
          },
        );
  Future<void> _cycle(Project p, ProjectTask t) => _run(
    () => widget.repository
        .updateTask(p.id, t.id, {
          'status': t.status == 'open'
              ? 'doing'
              : t.status == 'doing'
              ? 'done'
              : 'open',
        })
        .then((_) {}),
  );
  Future<void> _addTask(Project p) async {
    final c = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Add task'),
        content: TextField(
          controller: c,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Task title'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(d, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(d, true),
            child: const Text('Add'),
          ),
        ],
      ),
    );
    if (ok == true && c.text.trim().isNotEmpty) {
      await _run(
        () => widget.repository
            .createTask(p.id, title: c.text.trim())
            .then((_) {}),
      );
    }
    c.dispose();
  }

  Future<void> _reflect(Project p, ProjectArtifact a) async {
    String verdict = a.verdict ?? 'useful';
    final lesson = TextEditingController(text: a.lesson);
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: const Text('Artifact feedback'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: verdict,
                items: const [
                  DropdownMenuItem(value: 'useful', child: Text('Useful')),
                  DropdownMenuItem(
                    value: 'needs_work',
                    child: Text('Needs work'),
                  ),
                ],
                onChanged: (v) => set(() => verdict = v!),
              ),
              TextField(
                controller: lesson,
                minLines: 2,
                maxLines: 5,
                decoration: const InputDecoration(
                  labelText: 'Lesson for future planning',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(d, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(d, true),
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    if (ok == true && lesson.text.trim().length >= 3) {
      await _run(
        () => widget.repository
            .reflect(p.id, a.id, verdict: verdict, lesson: lesson.text.trim())
            .then((_) {}),
      );
    }
    lesson.dispose();
  }
}

class _ProjectHero extends StatelessWidget {
  const _ProjectHero({required this.project});
  final Project project;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 6,
                children: [
                  Chip(label: Text(project.status)),
                  Chip(label: Text(project.executionStatus)),
                ],
              ),
              Text(
                project.title,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 4),
              Text(project.objective),
            ],
          ),
        ),
        SizedBox(
          width: 68,
          height: 68,
          child: Stack(
            fit: StackFit.expand,
            children: [
              CircularProgressIndicator(
                value: project.progress,
                strokeWidth: 7,
              ),
              Center(child: Text('${(project.progress * 100).round()}%')),
            ],
          ),
        ),
      ],
    ),
  );
}

class _PortfolioSummary extends StatelessWidget {
  const _PortfolioSummary({required this.projects});
  final List<Project> projects;
  @override
  Widget build(BuildContext context) {
    final tasks = projects.fold<int>(0, (s, p) => s + p.tasks.length),
        done = projects.fold<int>(0, (s, p) => s + p.completedTasks);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Expanded(
            child: _Metric(
              '${projects.where((p) => p.status == 'active').length}',
              'Active',
            ),
          ),
          Expanded(child: _Metric('$tasks', 'Tasks')),
          Expanded(
            child: _Metric(
              tasks == 0 ? '—' : '${(done / tasks * 100).round()}%',
              'Progress',
            ),
          ),
        ],
      ),
    );
  }
}

class _ProjectsSkeleton extends StatelessWidget {
  const _ProjectsSkeleton();
  @override
  Widget build(BuildContext context) {
    final tone = Theme.of(context).colorScheme.surfaceContainerHighest;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          height: 104,
          decoration: BoxDecoration(
            color: tone,
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        const SizedBox(height: 18),
        for (var i = 0; i < 4; i++)
          Container(
            height: 126,
            margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(
              color: tone.withValues(alpha: .62),
              borderRadius: BorderRadius.circular(14),
            ),
          ),
      ],
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric(this.value, this.label);
  final String value, label;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(value, style: Theme.of(context).textTheme.headlineSmall),
      Text(label),
    ],
  );
}

class _StatusIcon extends StatelessWidget {
  const _StatusIcon({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) => CircleAvatar(
    child: Icon(
      status == 'completed'
          ? Icons.check_rounded
          : status == 'failed'
          ? Icons.error_outline
          : status == 'running'
          ? Icons.bolt_rounded
          : Icons.folder_outlined,
    ),
  );
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Center(
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(error.toString()),
            const SizedBox(height: 12),
            FilledButton.tonal(onPressed: retry, child: const Text('Retry')),
          ],
        ),
      ),
    ),
  );
}
