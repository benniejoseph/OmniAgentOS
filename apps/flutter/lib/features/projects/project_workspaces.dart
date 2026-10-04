import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../core/network/api_client.dart';
import '../builder/native_builder_view.dart';
import '../builder/builder_external_opener.dart';
import 'project_lifecycle.dart';
import 'projects.dart';

class ProjectCollectionWorkspace extends StatefulWidget {
  const ProjectCollectionWorkspace({
    super.key,
    required this.controller,
    required this.onOpen,
    this.onOpenResponsibilities,
    this.desktop = false,
  });
  final ProjectsController controller;
  final ValueChanged<Project> onOpen;
  final VoidCallback? onOpenResponsibilities;
  final bool desktop;
  @override
  State<ProjectCollectionWorkspace> createState() =>
      _ProjectCollectionWorkspaceState();
}

class _ProjectCollectionWorkspaceState
    extends State<ProjectCollectionWorkspace> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search Work');
  final _dialogs = _WorkDialogs();
  String _filter = 'All projects', _sort = 'Recently updated';
  String? _selectedId;
  String? _scope;
  int _page = 0;
  @override
  void initState() {
    super.initState();
    _scope = widget.controller.access?.scope;
    widget.controller.addListener(_authorityChanged);
  }

  void _authorityChanged() {
    if (_scope == widget.controller.access?.scope) return;
    _scope = widget.controller.access?.scope;
    _search.clear();
    if (mounted) {
      setState(() {
        _selectedId = null;
        _page = 0;
      });
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_authorityChanged);
    _dialogs.close();
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ProjectCollectionWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_authorityChanged);
      widget.controller.addListener(_authorityChanged);
      _scope = widget.controller.access?.scope;
      _dialogs.close();
      _selectedId = null;
      _page = 0;
      _search.clear();
    }
  }

  List<Project> _visible() {
    final query = _search.text.trim().toLowerCase();
    final values = widget.controller.projects
        .where(
          (p) =>
              (query.isEmpty ||
                  '${p.title} ${p.objective} ${p.id}'.toLowerCase().contains(
                    query,
                  )) &&
              (switch (_filter) {
                'Active' => p.status == 'active',
                'In flight' => const {
                  'running',
                  'paused',
                  'waiting_approval',
                }.contains(p.executionStatus),
                'Needs attention' => const {
                  'waiting_approval',
                  'failed',
                }.contains(p.executionStatus),
                'Completed' =>
                  p.status == 'completed' || p.executionStatus == 'completed',
                _ => true,
              }),
        )
        .toList();
    values.sort(
      (a, b) => switch (_sort) {
        'Name' => a.title.toLowerCase().compareTo(b.title.toLowerCase()),
        'Progress' => b.progress.compareTo(a.progress),
        'Attention' => _attention(b).compareTo(_attention(a)),
        _ => (b.updatedAt ?? DateTime(1970)).compareTo(
          a.updatedAt ?? DateTime(1970),
        ),
      },
    );
    return values;
  }

  int _attention(Project p) => p.executionStatus == 'waiting_approval'
      ? 3
      : p.executionStatus == 'failed'
      ? 2
      : p.activeExecution
      ? 1
      : 0;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller, values = _visible();
      final index = _page
          .clamp(0, values.isEmpty ? 0 : (values.length - 1) ~/ 20)
          .toInt();
      final selected = _selectedId == null
          ? values.firstOrNull
          : values.where((p) => p.id == _selectedId).firstOrNull;
      final controls = Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          SizedBox(
            width: 280,
            child: TextField(
              key: const Key('macos-projects-search'),
              controller: _search,
              focusNode: _searchFocus,
              decoration: const InputDecoration(labelText: 'Search projects'),
              onChanged: (_) => setState(() => _page = 0),
            ),
          ),
          SizedBox(
            width: 220,
            child: DropdownButtonFormField<String>(
              key: const Key('macos-projects-filter'),
              initialValue: _filter,
              isExpanded: true,
              isDense: false,
              itemHeight: null,
              decoration: const InputDecoration(labelText: 'Project state'),
              items: [
                for (final value in [
                  'All projects',
                  'Active',
                  'In flight',
                  'Needs attention',
                  'Completed',
                ])
                  DropdownMenuItem(value: value, child: _Choice(value)),
              ],
              onChanged: (v) {
                if (v != null) {
                  setState(() {
                    _filter = v;
                    _page = 0;
                  });
                }
              },
            ),
          ),
          SizedBox(
            width: 220,
            child: DropdownButtonFormField<String>(
              initialValue: _sort,
              isExpanded: true,
              isDense: false,
              itemHeight: null,
              decoration: const InputDecoration(labelText: 'Sort projects'),
              items: [
                for (final value in [
                  'Recently updated',
                  'Name',
                  'Progress',
                  'Attention',
                ])
                  DropdownMenuItem(value: value, child: _Choice(value)),
              ],
              onChanged: (v) {
                if (v != null) setState(() => _sort = v);
              },
            ),
          ),
        ],
      );
      final body = ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _Notice(c.readLabel),
          if (c.error != null) _Notice(projectFailure(c.error!), danger: true),
          if (c.receipt != null) _Notice(c.receipt!),
          if (c.acting)
            const _Notice(
              'Creating project… Work already sent to the server may continue if you leave.',
            ),
          controls,
          if (c.loaded)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                '${c.fresh ? 'Loaded' : 'Last loaded'}: ${c.projects.length} projects · ${values.length} match. Counts describe this returned window.',
              ),
            ),
          if (!c.loaded && c.loading) const LinearProgressIndicator(),
          if (!c.loaded && !c.loading)
            const Text('Project counts and progress are unavailable.'),
          if (c.loaded && values.isEmpty)
            Text(
              c.projects.isEmpty
                  ? 'No projects were returned by the successful read.'
                  : 'No projects match these filters.',
            ),
          if (values.isNotEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'Project and objective',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          for (final p in values.skip(index * 20).take(20))
            _Panel(
              child: InkWell(
                key: Key('macos-project-row-${p.id}'),
                onTap: () {
                  setState(() => _selectedId = p.id);
                  if (!widget.desktop) widget.onOpen(p);
                },
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        p.title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(p.objective),
                      const SizedBox(height: 8),
                      Text('${p.status} · execution ${p.executionStatus}'),
                      Text(
                        '${p.completedTasks} of ${p.tasks.length} returned tasks closed · ${p.artifacts.length} returned artifacts',
                      ),
                      if (p.executionStatus == 'completed')
                        const Text(
                          'Execution completion alone does not verify an outcome.',
                        ),
                      _Metadata({
                        'Project ID': p.id,
                        'Updated':
                            p.updatedAt?.toIso8601String() ?? 'Not reported',
                      }),
                      if (!widget.desktop)
                        TextButton(
                          onPressed: () => widget.onOpen(p),
                          child: Text('Open ${p.title}'),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          if (values.length > 20)
            _Pager(
              index: index,
              count: values.length,
              size: 20,
              previous: () => setState(() => _page = index - 1),
              next: () => setState(() => _page = index + 1),
            ),
          if (widget.desktop && MediaQuery.sizeOf(context).width < 980)
            _inspector(selected),
        ],
      );
      final create = FilledButton.icon(
        key: const Key('macos-projects-create'),
        onPressed: c.canCreate ? () => _create(context) : null,
        icon: const Icon(Icons.add),
        label: const Text('New project'),
      );
      final refresh = IconButton(
        key: const Key('macos-projects-refresh'),
        tooltip: 'Refresh projects',
        onPressed: c.canRead && !c.acting ? c.refresh : null,
        icon: const Icon(Icons.refresh),
      );
      final responsibilities = widget.onOpenResponsibilities == null
          ? null
          : IconButton(
              key: const Key('work-responsibilities'),
              tooltip: 'Open Responsibilities',
              onPressed: widget.onOpenResponsibilities,
              icon: const Icon(Icons.event_repeat_outlined),
            );
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true): c.refresh,
          const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
              _searchFocus.requestFocus,
        },
        child: Focus(
          child: widget.desktop
              ? MacosPageScaffold(
                  title: 'Work',
                  description:
                      'Projects, governed execution and exact evidence.',
                  icon: Icons.folder_open_outlined,
                  actions: [?responsibilities, refresh],
                  primaryAction: create,
                  inspector: MediaQuery.sizeOf(context).width >= 980
                      ? _inspector(selected)
                      : null,
                  body: body,
                )
              : Scaffold(
                  appBar: AppBar(
                    title: const Text('Work'),
                    actions: [?responsibilities, refresh],
                  ),
                  body: body,
                  bottomNavigationBar: SafeArea(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: create,
                    ),
                  ),
                ),
        ),
      );
    },
  );
  Widget _inspector(Project? project) => Padding(
    key: const Key('macos-projects-inspector'),
    padding: const EdgeInsets.all(16),
    child: project == null
        ? const Text(
            'Select a project from the current filters to inspect its details.',
          )
        : SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  project.title,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                SelectableText(project.objective),
                _Metadata({
                  'Project ID': project.id,
                  'Tenant ID': project.tenantId.isEmpty
                      ? 'Not reported'
                      : project.tenantId,
                  'Owner actor ID': project.actorId.isEmpty
                      ? 'Not reported'
                      : project.actorId,
                  'Lifecycle': project.status,
                  'Execution': project.executionStatus,
                  'Task progress':
                      '${project.completedTasks} of ${project.tasks.length} tasks completed',
                }),
                FilledButton(
                  key: Key('macos-project-open-${project.id}'),
                  onPressed: () => widget.onOpen(project),
                  child: const Text('Open project'),
                ),
              ],
            ),
          ),
  );
  Future<void> _create(BuildContext context) async {
    final c = widget.controller, scope = widget.controller.access?.scope;
    final title = TextEditingController(text: c.createTitle),
        objective = TextEditingController(text: c.createObjective);
    final accepted = await _dialogs.show(
      context,
      listenable: c,
      current: () =>
          mounted &&
          c == widget.controller &&
          c.access?.scope == scope &&
          c.access?.closed != true,
      builder: (dialogContext) => StatefulBuilder(
        builder: (_, update) => AlertDialog(
          title: const Text('New project'),
          scrollable: true,
          content: SizedBox(
            width: 480,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  key: const Key('macos-project-title'),
                  controller: title,
                  autofocus: true,
                  maxLength: 180,
                  decoration: const InputDecoration(labelText: 'Project name'),
                  onChanged: (v) {
                    c.createTitle = v;
                    update(() {});
                  },
                ),
                TextField(
                  key: const Key('macos-project-objective'),
                  controller: objective,
                  minLines: 2,
                  maxLines: 6,
                  maxLength: 2000,
                  decoration: const InputDecoration(
                    labelText: 'Successful outcome',
                  ),
                  onChanged: (v) {
                    c.createObjective = v;
                    update(() {});
                  },
                ),
                const Text(
                  'Closing retains this local draft in the current Work session.',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                c.createTitle = c.createObjective = '';
                Navigator.pop(dialogContext, false);
              },
              child: const Text('Discard draft'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Close'),
            ),
            FilledButton(
              onPressed:
                  title.text.trim().isEmpty ||
                      objective.text.trim().isEmpty ||
                      !c.canCreate
                  ? null
                  : () => Navigator.pop(dialogContext, true),
              child: const Text('Create'),
            ),
          ],
        ),
      ),
    );
    title.dispose();
    objective.dispose();
    if (accepted != true ||
        !mounted ||
        c != widget.controller ||
        c.access?.scope != scope) {
      return;
    }
    final value = await c.create(
      title: c.createTitle.trim(),
      objective: c.createObjective.trim(),
    );
    if (value != null && mounted && c == widget.controller) {
      widget.onOpen(value);
    }
  }
}

class ProjectDocumentWorkspace extends StatefulWidget {
  const ProjectDocumentWorkspace({
    super.key,
    required this.id,
    required this.repository,
    required this.api,
    this.focusWorkItemId,
    this.initiallyBuild = false,
    this.focusArtifactId,
    this.onBuilderLocationChanged,
    this.onInspectResult,
    this.desktop = false,
  });
  final String id;
  final ProjectsRepository repository;
  final ApiClient api;
  final String? focusWorkItemId, focusArtifactId;
  final bool initiallyBuild;
  final void Function(bool, String?)? onBuilderLocationChanged;

  /// Receives a canonical native Results key, for example `workflow:<full ID>`.
  final ValueChanged<String>? onInspectResult;
  final bool desktop;
  @override
  State<ProjectDocumentWorkspace> createState() =>
      _ProjectDocumentWorkspaceState();
}

class _ProjectDocumentWorkspaceState extends State<ProjectDocumentWorkspace> {
  late ProjectDetailController c;
  final _dialogs = _WorkDialogs();
  final _budget = TextEditingController(),
      _parallel = TextEditingController(),
      _planning = TextEditingController();
  int _tab = 0, _tasksPage = 0, _artifactsPage = 0;
  bool _buildVisited = false;
  String? _selectedArtifact, _scope;
  @override
  void initState() {
    super.initState();
    _bind();
  }

  void _bind() {
    _tab = widget.initiallyBuild ? 3 : 0;
    _buildVisited = widget.initiallyBuild;
    _selectedArtifact = widget.focusArtifactId;
    c = ProjectDetailController(widget.repository, widget.id);
    _scope = c.access?.scope;
    c.addListener(_changed);
    unawaited(c.refresh());
  }

  void _changed() {
    if (_scope != c.access?.scope) {
      _scope = c.access?.scope;
      _selectedArtifact = null;
      _tab = _tasksPage = _artifactsPage = 0;
      _buildVisited = false;
    }
    _selectedArtifact ??= c.project?.artifacts.firstOrNull?.id;
    for (final entry in [
      (_budget, c.execution.budget),
      (_parallel, c.execution.parallel),
      (_planning, c.planningContext),
    ]) {
      if (entry.$1.text != entry.$2) {
        entry.$1.value = TextEditingValue(
          text: entry.$2,
          selection: TextSelection.collapsed(offset: entry.$2.length),
        );
      }
    }
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant ProjectDocumentWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.id != widget.id ||
        oldWidget.repository != widget.repository) {
      _dialogs.close();
      c.removeListener(_changed);
      c.dispose();
      _tab = _tasksPage = _artifactsPage = 0;
      _buildVisited = false;
      _selectedArtifact = null;
      _bind();
    }
    if (oldWidget.focusWorkItemId != widget.focusWorkItemId) {
      if (!widget.initiallyBuild) _tab = 0;
      _tasksPage = 0;
    }
    if (oldWidget.focusArtifactId != widget.focusArtifactId &&
        (widget.focusArtifactId != null || widget.initiallyBuild)) {
      _selectedArtifact = widget.focusArtifactId;
    }
    if (oldWidget.initiallyBuild != widget.initiallyBuild) {
      _tab = widget.initiallyBuild
          ? 3
          : _tab == 3
          ? 0
          : _tab;
      _buildVisited |= widget.initiallyBuild;
    }
  }

  @override
  void dispose() {
    _dialogs.close();
    c.removeListener(_changed);
    c.dispose();
    _budget.dispose();
    _parallel.dispose();
    _planning.dispose();
    super.dispose();
  }

  Widget _header(Project p) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(p.title, style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 8),
      SelectableText(p.objective),
      Text('${p.status} · execution ${p.executionStatus}'),
      ExpansionTile(
        title: const Text('Exact project identity'),
        children: [
          _Metadata({
            'Project ID': p.id,
            'Tenant ID': p.tenantId.isEmpty ? 'Not reported' : p.tenantId,
            'Owner actor ID': p.actorId.isEmpty ? 'Not reported' : p.actorId,
            'Target date': p.targetDate?.toIso8601String() ?? 'Not set',
            'Created': p.createdAt?.toIso8601String() ?? 'Not reported',
            'Last changed': p.updatedAt?.toIso8601String() ?? 'Not reported',
          }),
        ],
      ),
      Text('${p.completedTasks} of ${p.tasks.length} tasks completed'),
      const Text(
        'Closed tasks and legacy completion do not prove a verified outcome.',
      ),
      _Notice(c.readLabel),
      if (c.readError != null) _Notice(c.readError!, danger: true),
      if (c.blocked != null) _Notice(c.blocked!),
      if (c.actionError != null) _Notice(c.actionError!, danger: true),
      if (c.acting)
        _Notice(
          '${c.action}… Leaving this view does not cancel work already sent to the server.',
        ),
      if (c.receipt case final receipt?)
        _Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${receipt.label}: response confirmed',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const Text(
                'This accepted response is separate from the current detail read.',
              ),
              _Metadata({
                'Project ID': receipt.projectId,
                'Returned resource ID': receipt.resourceId,
                'Confirmed locally at': receipt.confirmedAt.toIso8601String(),
                'Returned details': receipt.detail,
              }),
            ],
          ),
        ),
    ],
  );
  @override
  Widget build(BuildContext context) {
    final p = c.project;
    final tabs = SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.all(12),
      child: SegmentedButton<int>(
        key: const Key('macos-project-detail-tabs'),
        segments: const [
          ButtonSegment(value: 0, label: Text('Plan')),
          ButtonSegment(value: 1, label: Text('Execution')),
          ButtonSegment(value: 2, label: Text('Artifacts')),
          ButtonSegment(value: 3, label: Text('Build')),
        ],
        selected: {_tab},
        onSelectionChanged: (values) {
          setState(() {
            _tab = values.first;
            _buildVisited |= _tab == 3;
          });
          widget.onBuilderLocationChanged?.call(_tab == 3, _selectedArtifact);
        },
      ),
    );
    final body = p == null
        ? ListView(
            padding: const EdgeInsets.all(20),
            children: [
              _Notice(c.readLabel),
              if (c.loading) const LinearProgressIndicator(),
              if (c.readError != null) _Notice(c.readError!, danger: true),
              FilledButton.tonal(
                onPressed: c.readable ? c.refresh : null,
                child: const Text('Retry project read'),
              ),
            ],
          )
        : Column(
            children: [
              tabs,
              Expanded(
                child: IndexedStack(
                  index: _tab,
                  children: [
                    _plan(p),
                    _execution(p),
                    _artifacts(p),
                    _buildVisited ? _builder(p) : const SizedBox.shrink(),
                  ],
                ),
              ),
            ],
          );
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyR, meta: true): c.refresh,
        const SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true): () {
          if (Navigator.canPop(context)) Navigator.pop(context);
        },
      },
      child: Focus(
        child: Scaffold(
          appBar: AppBar(
            title: const Text('Project'),
            actions: [
              IconButton(
                key: const Key('macos-project-detail-refresh'),
                tooltip: 'Refresh project',
                onPressed: c.readable && !c.acting ? c.refresh : null,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: body,
        ),
      ),
    );
  }

  Widget _builder(Project p) {
    final artifact = p.artifacts
        .where(
          (item) =>
              item.id == _selectedArtifact &&
              p.tasks.any(
                (task) =>
                    task.id == item.taskId &&
                    task.surface?.artifactMetadata.any(
                          (entry) => entry['artifactId'] == item.id,
                        ) ==
                        true,
              ),
        )
        .firstOrNull;
    return Column(
      children: [
        if (_selectedArtifact != null && artifact == null)
          const Padding(
            padding: EdgeInsets.all(16),
            child: _Notice(
              'The requested artifact is unavailable in this current canonical Work snapshot. Builder still opens the exact project; no artifact content or write target is inferred.',
            ),
          ),
        Expanded(
          child: NativeBuilderView(
            key: ValueKey('build-${p.id}-${c.access?.scope}'),
            projectId: p.id,
            exactArtifactId: artifact?.id,
            desktop: widget.desktop,
            active: _tab == 3 && c.readable && !c.loading && !c.acting,
            externalOpener: UrlLauncherBuilderOpener(),
          ),
        ),
      ],
    );
  }

  List<Widget> _statusActions(Project p) => [
    OutlinedButton(
      key: const Key('macos-project-toggle-complete'),
      onPressed: c.writable
          ? () => c.updateStatus(p.status == 'active' ? 'completed' : 'active')
          : null,
      child: Text(p.status == 'active' ? 'Complete' : 'Reopen'),
    ),
    OutlinedButton(
      onPressed: c.writable && p.status != 'archived'
          ? () => _archive(p)
          : null,
      child: const Text('Archive'),
    ),
  ];
  Widget _plan(Project p) {
    final ordered = [...p.tasks]
      ..sort((a, b) {
        if (a.id == widget.focusWorkItemId && b.id != widget.focusWorkItemId) {
          return -1;
        }
        if (b.id == widget.focusWorkItemId && a.id != widget.focusWorkItemId) {
          return 1;
        }
        return a.position.compareTo(b.position);
      });
    final page = _tasksPage
        .clamp(0, ordered.isEmpty ? 0 : (ordered.length - 1) ~/ 20)
        .toInt();
    final shown = ordered.skip(page * 20).take(20).toList();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _header(p),
        const SizedBox(height: 16),
        TextField(
          controller: _planning,
          maxLength: 4000,
          minLines: 2,
          maxLines: 5,
          enabled: !c.acting,
          decoration: const InputDecoration(
            labelText: 'Planning context (optional)',
          ),
          onChanged: (v) => c.edit(() => c.planningContext = v),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton(
              onPressed: c.writable && p.status == 'active'
                  ? () => c.perform(
                      'Plan project',
                      () => widget.repository.plan(
                        p.id,
                        context: c.planningContext.trim(),
                      ),
                    )
                  : null,
              child: Text(p.tasks.isEmpty ? 'Plan with ATLAS' : 'Extend plan'),
            ),
            OutlinedButton(
              onPressed: c.writable && p.status == 'active'
                  ? () => _taskForm(p)
                  : null,
              child: const Text('Add task'),
            ),
            ..._statusActions(p),
          ],
        ),
        if (widget.focusWorkItemId != null)
          _Notice(
            p.tasks.any((task) => task.id == widget.focusWorkItemId)
                ? 'Selected work item: ${widget.focusWorkItemId}'
                : 'Selected work item ${widget.focusWorkItemId} is not present in this bounded detail snapshot.',
          ),
        if (p.tasks.isEmpty)
          const _Notice(
            'No tasks were returned in this successful project snapshot.',
          ),
        for (final group in ['Ready', 'Working', 'Needs you', 'Closed'])
          if (shown.any((t) => t.group == group)) ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(group, style: Theme.of(context).textTheme.titleLarge),
            ),
            for (final task in shown.where((t) => t.group == group))
              _task(p, task),
          ],
        if (ordered.length > 20)
          _Pager(
            index: page,
            count: ordered.length,
            size: 20,
            previous: () => setState(() => _tasksPage = page - 1),
            next: () => setState(() => _tasksPage = page + 1),
          ),
      ],
    );
  }

  Widget _task(Project p, ProjectTask task) => _Panel(
    key: ValueKey(task.id),
    selected: task.id == widget.focusWorkItemId,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(task.title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        SelectableText(task.detail),
        _Metadata({
          'Work item ID': task.id,
          'Executing Agent': task.agentId,
          'Priority': task.priority,
          'Task state': task.status,
          'Outcome': task.outcomeLabel,
          'Workflow': task.executionLabel,
          'Workflow run ID': task.workflowRunId ?? 'Not started',
          'Dependency IDs': task.dependsOn.isEmpty
              ? 'None returned'
              : task.dependsOn.join('\n'),
          'Origin': task.origin,
          'Due': task.dueAt?.toIso8601String() ?? 'Not set',
          'Last changed': task.updatedAt?.toIso8601String() ?? 'Not reported',
          'Dispatch attempt': '${task.dispatchAttempt}',
          'AI cost': task.surface?.costLabel ?? 'Cost unavailable',
        }),
        if (task.executionError != null)
          _Notice(task.executionError!, danger: true),
        if (task.surface case final surface?)
          ExpansionTile(
            title: const Text('Canonical identity, usage and evidence'),
            childrenPadding: const EdgeInsets.all(12),
            children: [
              _Metadata({
                'Workspace ID': surface.workspaceId ?? 'Local projection',
                'Persistence': surface.persistence,
                'Status revision': '${surface.revision}',
                'Projection digest':
                    surface.projectionSha256 ?? 'Not persisted',
                'Source revision digest':
                    surface.sourceRevisionSha256 ?? 'Not persisted',
                'Current step': surface.currentStep ?? 'Not reported',
                'Progress': surface.progressPercent == null
                    ? 'Unavailable'
                    : '${surface.progressPercent}%',
                'Usage receipts': '${surface.usageReceiptCount}',
                'Unknown-cost receipts': '${surface.unknownCostReceiptCount}',
                'Recorded tokens': '${surface.totalTokens}',
                'Assigned principals': surface.agents
                    .map(
                      (a) =>
                          '${a['agentId']} · ${a['principalId'] ?? 'principal not reported'} · generation ${a['principalGeneration'] ?? 'not reported'}',
                    )
                    .join('\n'),
                'Artifact identities': surface.artifactMetadata
                    .map(
                      (a) =>
                          '${a['artifactId']} · ${a['evidenceCount']} evidence references',
                    )
                    .join('\n'),
              }),
            ],
          ),
        if (task.movementBlocked)
          const Text(
            'Task movement is unavailable while its workflow is active or its current status is unknown.',
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton(
              onPressed:
                  c.writable && p.status == 'active' && !task.movementBlocked
                  ? () => c.advance(task)
                  : null,
              child: Text('${task.done ? 'Reopen' : 'Advance'} ${task.title}'),
            ),
            if (task.awaitingApproval)
              FilledButton(
                onPressed: c.writable && p.status == 'active'
                    ? () => c.control('approve', task: task)
                    : null,
                child: Text('Approve ${task.title}'),
              ),
            if (task.retryable)
              FilledButton(
                onPressed: c.writable && p.status == 'active'
                    ? () => c.control('retry', task: task)
                    : null,
                child: Text('Retry ${task.title}'),
              ),
            if (task.workflowRunId != null && widget.onInspectResult != null)
              TextButton(
                onPressed: () =>
                    widget.onInspectResult!('workflow:${task.workflowRunId}'),
                child: Text('Inspect ${task.title} workflow'),
              ),
          ],
        ),
      ],
    ),
  );
  Widget _execution(Project p) {
    final draft = c.execution, config = c.execution.config;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _header(p),
        _Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Execution control',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text('${p.tasksDispatched} of ${p.taskBudget} dispatches used'),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                key: ValueKey('mode-${draft.mode}'),
                initialValue: draft.mode,
                isExpanded: true,
                isDense: false,
                itemHeight: null,
                decoration: const InputDecoration(labelText: 'Operating mode'),
                items: [
                  for (final mode in ['manual', 'supervised', 'autonomous'])
                    DropdownMenuItem(value: mode, child: _Choice(mode)),
                ],
                onChanged: c.acting
                    ? null
                    : (v) {
                        if (v != null) c.edit(() => draft.mode = v);
                      },
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _budget,
                enabled: !c.acting,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Task budget',
                  helperText: '1–50 dispatches',
                ),
                onChanged: (v) => c.edit(() => draft.budget = v),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _parallel,
                enabled: !c.acting,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Parallel agents',
                  helperText: '1–3 workflows at a time',
                ),
                onChanged: (v) => c.edit(() => draft.parallel = v),
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Require approval before workflows'),
                value: draft.approval,
                onChanged: c.acting
                    ? null
                    : (v) => c.edit(() => draft.approval = v ?? true),
              ),
              Text(
                draft.conflict
                    ? 'Saved execution settings changed. Your draft is retained; review the current values before applying it.'
                    : draft.dirty
                    ? 'Unsaved execution settings'
                    : 'Execution settings match the current snapshot.',
              ),
              if (config == null)
                const _Notice(
                  'Enter a whole task budget from 1 to 50 and parallel-agent limit from 1 to 3.',
                ),
              if (draft.dirty || draft.conflict)
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    TextButton(
                      onPressed: c.acting
                          ? null
                          : () => c.edit(() => draft.reset(p)),
                      child: const Text('Discard execution draft'),
                    ),
                    if (draft.conflict)
                      TextButton(
                        onPressed: c.acting ? null : () => c.edit(draft.review),
                        child: const Text(
                          'I reviewed current settings; keep my draft',
                        ),
                      ),
                  ],
                ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton(
                    onPressed:
                        c.writable &&
                            p.status == 'active' &&
                            draft.dirty &&
                            !draft.conflict &&
                            config != null
                        ? () => _control('configure', config)
                        : null,
                    child: const Text('Save execution settings'),
                  ),
                  FilledButton(
                    key: const Key('macos-project-execution-start'),
                    onPressed:
                        c.writable &&
                            p.status == 'active' &&
                            !p.activeExecution &&
                            p.tasks.isNotEmpty &&
                            !draft.conflict &&
                            config != null &&
                            config.autonomyMode != 'manual' &&
                            config.taskBudget > p.tasksDispatched
                        ? () => _control('start', config)
                        : null,
                    child: const Text('Start'),
                  ),
                  OutlinedButton(
                    onPressed:
                        c.writable &&
                            p.status == 'active' &&
                            p.executionStatus == 'running'
                        ? () => c.control('pause')
                        : null,
                    child: const Text('Pause'),
                  ),
                  OutlinedButton(
                    onPressed:
                        c.writable &&
                            p.status == 'active' &&
                            p.executionStatus == 'paused'
                        ? () => c.control('resume')
                        : null,
                    child: const Text('Resume'),
                  ),
                  OutlinedButton(
                    onPressed:
                        c.writable && p.status == 'active' && p.activeExecution
                        ? () => c.control('sync')
                        : null,
                    child: const Text('Sync state'),
                  ),
                ],
              ),
              const Text(
                'Execution remains governed by the existing workflow and approval policy. Saving configuration does not verify an outcome.',
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _control(String command, ExecutionConfig config) async {
    final controller = c;
    if (await controller.control(command, config: config) &&
        mounted &&
        controller == c &&
        c.project != null) {
      c.edit(() => c.execution.reset(c.project!));
    }
  }

  Widget _artifacts(Project p) {
    final page = _artifactsPage
        .clamp(0, p.artifacts.isEmpty ? 0 : (p.artifacts.length - 1) ~/ 20)
        .toInt();
    final selected = _selectedArtifact == null
        ? p.artifacts.firstOrNull
        : p.artifacts.where((a) => a.id == _selectedArtifact).firstOrNull;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _header(p),
        if (p.artifacts.isEmpty)
          const _Notice(
            'No artifacts were returned in this successful project snapshot.',
          ),
        for (final artifact in p.artifacts.skip(page * 20).take(20))
          OutlinedButton(
            onPressed: () => setState(() => _selectedArtifact = artifact.id),
            child: Text('${artifact.title}\n${artifact.id}'),
          ),
        if (p.artifacts.length > 20)
          _Pager(
            index: page,
            count: p.artifacts.length,
            size: 20,
            previous: () => setState(() => _artifactsPage = page - 1),
            next: () => setState(() => _artifactsPage = page + 1),
          ),
        if (_selectedArtifact != null && selected == null)
          const _Notice(
            'The selected artifact is not in this current bounded snapshot. Select another artifact to inspect it.',
          ),
        if (selected != null)
          _Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  selected.title,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                _Metadata({
                  'Artifact ID': selected.id,
                  'Work item ID': selected.taskId,
                  'Workflow run ID': selected.workflowRunId,
                  'Executing Agent': selected.agentId,
                  'Artifact state': selected.statusLabel,
                  'Memory ID': selected.memoryId ?? 'Not reported',
                  'Source memory ID': selected.sourceMemoryId ?? 'Not reported',
                  'Reflection memory ID':
                      selected.reflectionMemoryId ?? 'Not reported',
                  'Created':
                      selected.createdAt?.toIso8601String() ?? 'Not reported',
                  'Feedback': selected.verdict ?? 'Not reviewed',
                }),
                SelectableText(selected.content),
                const SizedBox(height: 16),
                Text(
                  'Evidence references',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (selected.evidenceRefs.isEmpty)
                  const Text('No evidence references were returned.'),
                for (final reference in selected.evidenceRefs)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: SelectableText(reference),
                  ),
                if (selected.lesson != null) SelectableText(selected.lesson!),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: c.writable
                          ? () => _feedback(p, selected)
                          : null,
                      child: Text(
                        selected.verdict == null
                            ? 'Add feedback'
                            : 'Update feedback',
                      ),
                    ),
                    if (widget.onInspectResult != null)
                      TextButton(
                        onPressed: () => widget.onInspectResult!(
                          'workflow:${selected.workflowRunId}',
                        ),
                        child: const Text('Inspect source workflow'),
                      ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }

  Future<void> _archive(Project p) async {
    final controller = c, scope = c.access?.scope;
    final accepted = await _dialogs.show(
      context,
      listenable: controller,
      current: () =>
          mounted &&
          c == controller &&
          controller.access?.scope == scope &&
          controller.access?.closed != true,
      builder: (ctx) => AlertDialog(
        title: const Text('Archive project'),
        scrollable: true,
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(p.title),
            SelectableText(p.id),
            const Text(
              'The project remains a stored record. Existing governed workflow constraints still apply.',
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep project'),
          ),
          FilledButton(
            onPressed: controller.writable
                ? () => Navigator.pop(ctx, true)
                : null,
            child: const Text('Confirm archive'),
          ),
        ],
      ),
    );
    if (accepted == true &&
        mounted &&
        c == controller &&
        controller.access?.scope == scope) {
      await c.perform(
        'Archive project',
        () => widget.repository.update(p.id, {'status': 'archived'}),
        expectedVersion: p.version,
      );
    }
  }

  Future<void> _taskForm(Project p) async {
    final controller = c,
        scope = c.access?.scope,
        title = TextEditingController(text: c.taskTitle),
        detail = TextEditingController(text: c.taskDetail);
    final accepted = await _dialogs.show(
      context,
      listenable: controller,
      current: () =>
          mounted &&
          c == controller &&
          controller.access?.scope == scope &&
          controller.access?.closed != true,
      builder: (ctx) => StatefulBuilder(
        builder: (_, update) => AlertDialog(
          title: const Text('Add project task'),
          scrollable: true,
          content: SizedBox(
            width: 480,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  key: const Key('macos-project-task-title'),
                  controller: title,
                  autofocus: true,
                  maxLength: 240,
                  decoration: const InputDecoration(labelText: 'Task'),
                  onChanged: (v) {
                    controller.taskTitle = v;
                    update(() {});
                  },
                ),
                TextField(
                  controller: detail,
                  maxLength: 1000,
                  minLines: 2,
                  maxLines: 6,
                  decoration: const InputDecoration(
                    labelText: 'Context or acceptance criteria',
                  ),
                  onChanged: (v) => controller.taskDetail = v,
                ),
                DropdownButtonFormField<String>(
                  initialValue: controller.taskPriority,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: [
                    for (final v in ['low', 'medium', 'high'])
                      DropdownMenuItem(value: v, child: Text(v)),
                  ],
                  onChanged: (v) {
                    if (v != null) controller.taskPriority = v;
                  },
                ),
                DropdownButtonFormField<String>(
                  initialValue: controller.taskAgent,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Executing Agent',
                  ),
                  items: [
                    for (final v in [
                      'atlas',
                      'scout',
                      'forge',
                      'sentinel',
                      'mnemosyne',
                    ])
                      DropdownMenuItem(value: v, child: Text(v)),
                  ],
                  onChanged: (v) {
                    if (v != null) controller.taskAgent = v;
                  },
                ),
                const Text('Closing retains the local task draft.'),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                controller.taskTitle = controller.taskDetail = '';
                Navigator.pop(ctx, false);
              },
              child: const Text('Discard draft'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Close'),
            ),
            FilledButton(
              key: const Key('macos-project-task-submit'),
              onPressed: title.text.trim().isEmpty || !controller.writable
                  ? null
                  : () => Navigator.pop(ctx, true),
              child: const Text('Add task'),
            ),
          ],
        ),
      ),
    );
    title.dispose();
    detail.dispose();
    if (accepted != true ||
        !mounted ||
        controller != c ||
        controller.access?.scope != scope) {
      return;
    }
    final name = c.taskTitle.trim(),
        taskContext = c.taskDetail.trim(),
        priority = c.taskPriority,
        agent = c.taskAgent;
    if (await c.perform(
          'Add task',
          () => widget.repository.createTask(
            p.id,
            title: name,
            detail: taskContext,
            priority: priority,
            agentId: agent,
          ),
          expectedVersion: p.version,
        ) &&
        mounted &&
        c == controller) {
      c.edit(() {
        c.taskTitle = c.taskDetail = '';
      });
    }
  }

  Future<void> _feedback(Project p, ProjectArtifact artifact) async {
    final controller = c, scope = c.access?.scope;
    final draft = c.feedback.putIfAbsent(
      artifact.id,
      () => ProjectFeedbackDraft(
        verdict: artifact.verdict ?? 'useful',
        lesson: artifact.lesson ?? '',
      ),
    );
    final lesson = TextEditingController(text: draft.lesson);
    final accepted = await _dialogs.show(
      context,
      listenable: controller,
      current: () =>
          mounted &&
          c == controller &&
          controller.access?.scope == scope &&
          controller.access?.closed != true,
      builder: (ctx) => StatefulBuilder(
        builder: (_, update) => AlertDialog(
          title: const Text('Artifact feedback'),
          scrollable: true,
          content: SizedBox(
            width: 480,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SelectableText(artifact.id),
                DropdownButtonFormField<String>(
                  initialValue: draft.verdict,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Verdict'),
                  items: const [
                    DropdownMenuItem(value: 'useful', child: Text('Useful')),
                    DropdownMenuItem(
                      value: 'needs_work',
                      child: Text('Needs work'),
                    ),
                  ],
                  onChanged: (v) {
                    if (v != null) draft.verdict = v;
                  },
                ),
                TextField(
                  controller: lesson,
                  maxLength: 1200,
                  minLines: 3,
                  maxLines: 7,
                  decoration: const InputDecoration(
                    labelText: 'Lesson for future planning',
                  ),
                  onChanged: (v) {
                    draft.lesson = v;
                    update(() {});
                  },
                ),
                const Text(
                  'Closing retains this local feedback draft. Saving uses the existing governed memory service.',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                controller.feedback.remove(artifact.id);
                Navigator.pop(ctx, false);
              },
              child: const Text('Discard draft'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Close'),
            ),
            FilledButton(
              onPressed: lesson.text.trim().length < 3 || !controller.writable
                  ? null
                  : () => Navigator.pop(ctx, true),
              child: const Text('Save feedback'),
            ),
          ],
        ),
      ),
    );
    lesson.dispose();
    if (accepted != true ||
        !mounted ||
        controller != c ||
        controller.access?.scope != scope) {
      return;
    }
    final verdict = draft.verdict, submitted = draft.lesson.trim();
    if (await c.perform(
          'Save artifact feedback',
          () => widget.repository.reflect(
            p.id,
            artifact.id,
            verdict: verdict,
            lesson: submitted,
          ),
          expectedVersion: p.version,
        ) &&
        mounted &&
        c == controller) {
      c.feedback.remove(artifact.id);
    }
  }
}

/// Dialogs retain same-scope drafts, but never expose an old owner's form.
/// Removing a page closes only its own routes, not unrelated overlays.
class _WorkDialogs {
  final _routes = <DialogRoute<bool>>{};
  Future<bool?> show(
    BuildContext context, {
    required Listenable listenable,
    required bool Function() current,
    required WidgetBuilder builder,
  }) async {
    // Once invalidated, A → B → A cannot revive an earlier private form.
    var valid = true;
    void invalidate() {
      if (!current()) valid = false;
    }

    listenable.addListener(invalidate);
    final route = DialogRoute<bool>(
      context: context,
      builder: (ctx) => ListenableBuilder(
        listenable: listenable,
        builder: (ctx, _) => valid && current()
            ? builder(ctx)
            : AlertDialog(
                title: const Text('Work access changed'),
                content: const Text(
                  'The previous form is no longer available in this session.',
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text('Close'),
                  ),
                ],
              ),
      ),
    );
    _routes.add(route);
    final accepted = await Navigator.of(
      context,
      rootNavigator: true,
    ).push(route);
    // Keep form controllers alive until the dialog transition has unmounted.
    await route.completed;
    _routes.remove(route);
    listenable.removeListener(invalidate);
    return valid && current() ? accepted : false;
  }

  void close() {
    final pending = List<DialogRoute<bool>>.of(_routes);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final route in pending) {
        if (route.isActive) route.navigator?.removeRoute(route, false);
      }
    });
  }
}

class _Panel extends StatelessWidget {
  const _Panel({super.key, required this.child, this.selected = false});
  final Widget child;
  final bool selected;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Material(
      color: Theme.of(context).colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: selected
              ? Theme.of(context).colorScheme.primary
              : Theme.of(context).colorScheme.outline,
          width: selected ? 2 : 1,
        ),
      ),
      child: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  );
}

class _Choice extends StatelessWidget {
  const _Choice(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: 48),
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Align(alignment: Alignment.centerLeft, child: Text(text)),
    ),
  );
}

class _Notice extends StatelessWidget {
  const _Notice(this.text, {this.danger = false});
  final String text;
  final bool danger;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Text(
        text,
        style: TextStyle(
          color: danger ? Theme.of(context).colorScheme.error : null,
        ),
      ),
    ),
  );
}

class _Metadata extends StatelessWidget {
  const _Metadata(this.items);
  final Map<String, String> items;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final entry in items.entries)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.key, style: Theme.of(context).textTheme.bodySmall),
                SelectableText(
                  entry.value.isEmpty ? 'None returned' : entry.value,
                ),
              ],
            ),
          ),
      ],
    ),
  );
}

class _Pager extends StatelessWidget {
  const _Pager({
    required this.index,
    required this.count,
    required this.size,
    required this.previous,
    required this.next,
  });
  final int index, count, size;
  final VoidCallback previous, next;
  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 12,
    runSpacing: 8,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      OutlinedButton(
        onPressed: index == 0 ? null : previous,
        child: const Text('Previous'),
      ),
      Text(
        '${index * size + 1}–${((index + 1) * size).clamp(0, count)} of $count returned records',
      ),
      OutlinedButton(
        onPressed: (index + 1) * size >= count ? null : next,
        child: const Text('Next'),
      ),
    ],
  );
}
