import 'package:flutter/material.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'projects.dart';

enum _ProjectFilter { all, active, inFlight, needsAttention, completed }

enum _ProjectSort { recentlyUpdated, name, progress, attention }

/// Finder-style project browser for macOS. The portable project detail page is
/// still opened through [onOpen], while browsing, filtering, and comparison stay
/// in a dense desktop master-detail workspace.
class MacosProjectsView extends StatefulWidget {
  const MacosProjectsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });

  final ProjectsController controller;
  final ValueChanged<Project> onOpen;

  @override
  State<MacosProjectsView> createState() => _MacosProjectsViewState();
}

class _MacosProjectsViewState extends State<MacosProjectsView> {
  final _searchController = TextEditingController();
  _ProjectFilter _filter = _ProjectFilter.all;
  _ProjectSort _sort = _ProjectSort.recentlyUpdated;
  String? _selectedId;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final visible = _visibleProjects(widget.controller.projects);
      final selected = _selectedProject(visible);
      return MacosPageScaffold(
        title: 'Projects',
        description: 'Durable outcomes, agent execution, and verified output.',
        icon: Icons.folder_open_outlined,
        actions: [
          IconButton(
            key: const Key('macos-projects-refresh'),
            tooltip: 'Refresh projects',
            onPressed: widget.controller.loading
                ? null
                : widget.controller.refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
        primaryAction: FilledButton.icon(
          key: const Key('macos-projects-create'),
          onPressed: widget.controller.acting
              ? null
              : () => _createProject(context),
          icon: const Icon(Icons.add_rounded, size: 17),
          label: const Text('New project'),
        ),
        toolbar: _ProjectsToolbar(
          searchController: _searchController,
          filter: _filter,
          sort: _sort,
          visibleCount: visible.length,
          totalCount: widget.controller.projects.length,
          onSearchChanged: (_) => setState(() {}),
          onClearSearch: () {
            _searchController.clear();
            setState(() {});
          },
          onFilterChanged: (value) => setState(() => _filter = value),
          onSortChanged: (value) => setState(() => _sort = value),
        ),
        inspector: widget.controller.projects.isEmpty && selected == null
            ? null
            : _ProjectInspector(project: selected, onOpen: widget.onOpen),
        inspectorWidth: 380,
        inspectorMinWidth: 320,
        inspectorMaxWidth: 520,
        body: _ProjectsBody(
          controller: widget.controller,
          visibleProjects: visible,
          selectedId: selected?.id,
          hasQueryOrFilter:
              _searchController.text.trim().isNotEmpty ||
              _filter != _ProjectFilter.all,
          onSelect: (project) => setState(() => _selectedId = project.id),
          onClearFilters: _clearFilters,
        ),
      );
    },
  );

  List<Project> _visibleProjects(List<Project> source) {
    final query = _searchController.text.trim().toLowerCase();
    final projects = source.where((project) {
      final matchesQuery =
          query.isEmpty ||
          project.title.toLowerCase().contains(query) ||
          project.objective.toLowerCase().contains(query);
      if (!matchesQuery) return false;
      return switch (_filter) {
        _ProjectFilter.all => true,
        _ProjectFilter.active => project.status == 'active',
        _ProjectFilter.inFlight => const {
          'running',
          'paused',
        }.contains(project.executionStatus),
        _ProjectFilter.needsAttention =>
          project.executionStatus == 'waiting_approval' ||
              project.executionStatus == 'failed' ||
              project.status == 'blocked',
        _ProjectFilter.completed =>
          project.status == 'completed' ||
              project.executionStatus == 'completed',
      };
    }).toList();

    projects.sort(
      (left, right) => switch (_sort) {
        _ProjectSort.recentlyUpdated => _compareUpdated(right, left),
        _ProjectSort.name => left.title.toLowerCase().compareTo(
          right.title.toLowerCase(),
        ),
        _ProjectSort.progress => right.progress.compareTo(left.progress),
        _ProjectSort.attention => _attentionScore(
          right,
        ).compareTo(_attentionScore(left)),
      },
    );
    return projects;
  }

  Project? _selectedProject(List<Project> visible) {
    if (visible.isEmpty) return null;
    for (final project in visible) {
      if (project.id == _selectedId) return project;
    }
    return visible.first;
  }

  void _clearFilters() {
    _searchController.clear();
    setState(() => _filter = _ProjectFilter.all);
  }

  Future<void> _createProject(BuildContext context) async {
    final title = TextEditingController();
    final objective = TextEditingController();
    final objectiveFocus = FocusNode();
    final submit = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('New project'),
        content: SizedBox(
          width: 520,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                key: const Key('macos-project-title'),
                controller: title,
                autofocus: true,
                maxLength: 180,
                textInputAction: TextInputAction.next,
                onSubmitted: (_) => objectiveFocus.requestFocus(),
                decoration: const InputDecoration(labelText: 'Project name'),
              ),
              const SizedBox(height: 8),
              TextField(
                key: const Key('macos-project-objective'),
                controller: objective,
                focusNode: objectiveFocus,
                maxLength: 2000,
                minLines: 3,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: 'Successful outcome',
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
            key: const Key('macos-project-create-submit'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Create project'),
          ),
        ],
      ),
    );
    final projectTitle = title.text.trim();
    final projectObjective = objective.text.trim();
    title.dispose();
    objective.dispose();
    objectiveFocus.dispose();
    if (submit != true || projectTitle.isEmpty || projectObjective.isEmpty) {
      return;
    }

    final created = await widget.controller.create(
      title: projectTitle,
      objective: projectObjective,
    );
    if (created != null && mounted) {
      setState(() => _selectedId = created.id);
      widget.onOpen(created);
    }
  }
}

class _ProjectsToolbar extends StatelessWidget {
  const _ProjectsToolbar({
    required this.searchController,
    required this.filter,
    required this.sort,
    required this.visibleCount,
    required this.totalCount,
    required this.onSearchChanged,
    required this.onClearSearch,
    required this.onFilterChanged,
    required this.onSortChanged,
  });

  final TextEditingController searchController;
  final _ProjectFilter filter;
  final _ProjectSort sort;
  final int visibleCount;
  final int totalCount;
  final ValueChanged<String> onSearchChanged;
  final VoidCallback onClearSearch;
  final ValueChanged<_ProjectFilter> onFilterChanged;
  final ValueChanged<_ProjectSort> onSortChanged;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 760;
      return Row(
        children: [
          SizedBox(
            width: compact ? 220 : 320,
            child: TextField(
              key: const Key('macos-projects-search'),
              controller: searchController,
              onChanged: onSearchChanged,
              decoration: InputDecoration(
                hintText: 'Search projects',
                prefixIcon: const Icon(Icons.search_rounded, size: 17),
                suffixIcon: searchController.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear search',
                        onPressed: onClearSearch,
                        icon: const Icon(Icons.close_rounded, size: 15),
                      ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          _FilterMenu(value: filter, onChanged: onFilterChanged),
          const SizedBox(width: 8),
          _SortMenu(value: sort, onChanged: onSortChanged),
          const Spacer(),
          if (!compact)
            Text(
              visibleCount == totalCount
                  ? '$totalCount projects'
                  : '$visibleCount of $totalCount projects',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
        ],
      );
    },
  );
}

class _FilterMenu extends StatelessWidget {
  const _FilterMenu({required this.value, required this.onChanged});
  final _ProjectFilter value;
  final ValueChanged<_ProjectFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 9),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: mac.divider),
        borderRadius: BorderRadius.circular(7),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<_ProjectFilter>(
          key: const Key('macos-projects-filter'),
          value: value,
          isDense: true,
          icon: const Icon(Icons.expand_more_rounded, size: 16),
          items: _ProjectFilter.values
              .map(
                (filter) => DropdownMenuItem(
                  value: filter,
                  child: Text(_filterLabel(filter)),
                ),
              )
              .toList(),
          onChanged: (next) {
            if (next != null) onChanged(next);
          },
        ),
      ),
    );
  }
}

class _SortMenu extends StatelessWidget {
  const _SortMenu({required this.value, required this.onChanged});
  final _ProjectSort value;
  final ValueChanged<_ProjectSort> onChanged;

  @override
  Widget build(BuildContext context) => PopupMenuButton<_ProjectSort>(
    key: const Key('macos-projects-sort'),
    tooltip: 'Sort projects',
    initialValue: value,
    onSelected: onChanged,
    itemBuilder: (context) => _ProjectSort.values
        .map(
          (sort) => PopupMenuItem(
            value: sort,
            child: Row(
              children: [
                SizedBox(
                  width: 22,
                  child: sort == value
                      ? Icon(
                          Icons.check_rounded,
                          size: 15,
                          color: Theme.of(context).colorScheme.primary,
                        )
                      : null,
                ),
                Text(_sortLabel(sort)),
              ],
            ),
          ),
        )
        .toList(),
    child: Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: MacosThemeColors.of(context).divider),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.swap_vert_rounded, size: 16),
          const SizedBox(width: 6),
          Text(_sortLabel(value)),
          const SizedBox(width: 5),
          const Icon(Icons.expand_more_rounded, size: 15),
        ],
      ),
    ),
  );
}

class _ProjectsBody extends StatelessWidget {
  const _ProjectsBody({
    required this.controller,
    required this.visibleProjects,
    required this.selectedId,
    required this.hasQueryOrFilter,
    required this.onSelect,
    required this.onClearFilters,
  });

  final ProjectsController controller;
  final List<Project> visibleProjects;
  final String? selectedId;
  final bool hasQueryOrFilter;
  final ValueChanged<Project> onSelect;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    if (controller.loading && controller.projects.isEmpty) {
      return const MacosLoadingList(rows: 10);
    }
    if (controller.error != null && controller.projects.isEmpty) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Projects are unavailable',
        message: 'Asael could not load the current project projection. No empty or healthy state has been assumed.',
        action: FilledButton.icon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Retry loading'),
        ),
      );
    }

    return Column(
      children: [
        if (controller.loading) const LinearProgressIndicator(minHeight: 2),
        if (controller.error != null)
          _ProjectsTruthBanner(onRetry: controller.refresh),
        Expanded(
          child: visibleProjects.isEmpty
              ? MacosEmptyState(
                  icon: hasQueryOrFilter
                      ? Icons.search_off_rounded
                      : Icons.create_new_folder_outlined,
                  title: hasQueryOrFilter
                      ? 'No projects match'
                      : 'Create your first project',
                  message: hasQueryOrFilter
                      ? 'Try a different search or return to all project states.'
                      : 'Projects turn an outcome into tasks, governed execution, and verified artifacts.',
                  action: hasQueryOrFilter
                      ? OutlinedButton.icon(
                          onPressed: onClearFilters,
                          icon: const Icon(Icons.filter_alt_off_outlined),
                          label: const Text('Clear search and filters'),
                        )
                      : null,
                )
              : _ProjectsTable(
                  projects: visibleProjects,
                  selectedId: selectedId,
                  onSelect: onSelect,
                ),
        ),
      ],
    );
  }
}

class _ProjectsTruthBanner extends StatelessWidget {
  const _ProjectsTruthBanner({required this.onRetry});
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        color: scheme.errorContainer,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
        child: Row(
          children: [
            Icon(Icons.cloud_off_outlined, size: 17, color: scheme.error),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                'Refresh failed. The last available project projection remains visible.',
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: scheme.onErrorContainer),
              ),
            ),
            TextButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}

class _ProjectsTable extends StatelessWidget {
  const _ProjectsTable({
    required this.projects,
    required this.selectedId,
    required this.onSelect,
  });

  final List<Project> projects;
  final String? selectedId;
  final ValueChanged<Project> onSelect;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final showProgress = constraints.maxWidth >= 620;
      final showTasks = constraints.maxWidth >= 780;
      final showUpdated = constraints.maxWidth >= 980;
      return Column(
        children: [
          _ProjectTableHeader(
            showProgress: showProgress,
            showTasks: showTasks,
            showUpdated: showUpdated,
          ),
          Expanded(
            child: Scrollbar(
              child: ListView.builder(
                itemCount: projects.length,
                itemBuilder: (context, index) {
                  final project = projects[index];
                  return _ProjectTableRow(
                    key: Key('macos-project-row-${project.id}'),
                    project: project,
                    selected: project.id == selectedId,
                    showProgress: showProgress,
                    showTasks: showTasks,
                    showUpdated: showUpdated,
                    onSelect: () => onSelect(project),
                  );
                },
              ),
            ),
          ),
        ],
      );
    },
  );
}

class _ProjectTableHeader extends StatelessWidget {
  const _ProjectTableHeader({
    required this.showProgress,
    required this.showTasks,
    required this.showUpdated,
  });
  final bool showProgress;
  final bool showTasks;
  final bool showUpdated;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final style = Theme.of(context).textTheme.labelSmall
        ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant);
    return Container(
      height: 36,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          SizedBox(width: 124, child: Text('Status', style: style)),
          Expanded(flex: 5, child: Text('Project and objective', style: style)),
          if (showProgress)
            SizedBox(width: 154, child: Text('Progress', style: style)),
          if (showTasks)
            SizedBox(width: 82, child: Text('Tasks', style: style)),
          if (showUpdated)
            SizedBox(width: 118, child: Text('Updated', style: style)),
          const SizedBox(width: 20),
        ],
      ),
    );
  }
}

class _ProjectTableRow extends StatelessWidget {
  const _ProjectTableRow({
    super.key,
    required this.project,
    required this.selected,
    required this.showProgress,
    required this.showTasks,
    required this.showUpdated,
    required this.onSelect,
  });

  final Project project;
  final bool selected;
  final bool showProgress;
  final bool showTasks;
  final bool showUpdated;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label:
          '${project.title}, ${_statusLabel(project.executionStatus)}, ${(project.progress * 100).round()} percent complete',
      hint:
          'Select for details. Use Open project in the inspector to continue.',
      child: Material(
        color: selected ? mac.selection : Colors.transparent,
        child: InkWell(
          onTap: onSelect,
          canRequestFocus: true,
          child: Container(
            constraints: const BoxConstraints(minHeight: 62),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: mac.divider)),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 124,
                  child: _ProjectStatus(status: project.executionStatus),
                ),
                Expanded(
                  flex: 5,
                  child: Padding(
                    padding: const EdgeInsets.only(right: 18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          project.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          project.objective.isEmpty
                              ? 'No successful outcome recorded.'
                              : project.objective,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ),
                if (showProgress)
                  SizedBox(
                    width: 154,
                    child: Row(
                      children: [
                        Expanded(
                          child: LinearProgressIndicator(
                            value: project.progress,
                            minHeight: 4,
                          ),
                        ),
                        const SizedBox(width: 9),
                        SizedBox(
                          width: 34,
                          child: Text(
                            '${(project.progress * 100).round()}%',
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                        ),
                      ],
                    ),
                  ),
                if (showTasks)
                  SizedBox(
                    width: 82,
                    child: Text(
                      '${project.completedTasks}/${project.tasks.length}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                if (showUpdated)
                  SizedBox(
                    width: 118,
                    child: Text(
                      project.updatedAt == null
                          ? 'Unknown'
                          : _relativeTime(project.updatedAt!),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                Icon(
                  Icons.chevron_right_rounded,
                  size: 18,
                  color: selected
                      ? Theme.of(context).colorScheme.primary
                      : Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProjectStatus extends StatelessWidget {
  const _ProjectStatus({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final descriptor = _statusDescriptor(context, status);
    return Row(
      children: [
        Icon(descriptor.icon, size: 15, color: descriptor.color),
        const SizedBox(width: 7),
        Flexible(
          child: Text(
            descriptor.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.labelMedium
                ?.copyWith(color: descriptor.color),
          ),
        ),
      ],
    );
  }
}

class _ProjectInspector extends StatelessWidget {
  const _ProjectInspector({required this.project, required this.onOpen});
  final Project? project;
  final ValueChanged<Project> onOpen;

  @override
  Widget build(BuildContext context) {
    final value = project;
    if (value == null) {
      return const MacosEmptyState(
        icon: Icons.info_outline_rounded,
        title: 'Select a project',
        message:
            'Project details and execution state will remain visible here.',
      );
    }
    final status = _statusDescriptor(context, value.executionStatus);
    final verifiedArtifacts = value.artifacts
        .where((item) => item.verified)
        .length;
    return Scrollbar(
      child: ListView(
        key: const Key('macos-projects-inspector'),
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: status.color.withValues(alpha: .12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(status.icon, color: status.color, size: 18),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      value.title,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      status.label,
                      style: Theme.of(context).textTheme.labelMedium
                          ?.copyWith(color: status.color),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          SelectableText(
            value.objective.isEmpty
                ? 'No successful outcome has been recorded.'
                : value.objective,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: Key('macos-project-open-${value.id}'),
            onPressed: () => onOpen(value),
            icon: const Icon(Icons.open_in_new_rounded, size: 16),
            label: const Text('Open project'),
          ),
          const SizedBox(height: 20),
          const Divider(),
          const SizedBox(height: 18),
          MacosSectionHeader(
            title: 'Progress',
            description:
                '${value.completedTasks} of ${value.tasks.length} tasks complete',
            trailing: Text(
              '${(value.progress * 100).round()}%',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          const SizedBox(height: 10),
          LinearProgressIndicator(value: value.progress, minHeight: 5),
          const SizedBox(height: 20),
          const Divider(),
          const SizedBox(height: 18),
          MacosSectionHeader(
            title: 'Project state',
            description: 'Server-reported planning and execution settings.',
          ),
          const SizedBox(height: 10),
          _InspectorFact(
            icon: Icons.flag_outlined,
            label: 'Lifecycle',
            value: _sentenceCase(value.status),
          ),
          _InspectorFact(
            icon: Icons.tune_rounded,
            label: 'Autonomy',
            value: _sentenceCase(value.autonomyMode),
          ),
          _InspectorFact(
            icon: Icons.approval_outlined,
            label: 'Approval',
            value: value.requireApproval ? 'Required' : 'Policy governed',
          ),
          _InspectorFact(
            icon: Icons.bolt_outlined,
            label: 'Dispatch budget',
            value: '${value.tasksDispatched} of ${value.taskBudget}',
          ),
          _InspectorFact(
            icon: Icons.call_split_rounded,
            label: 'Parallel lanes',
            value: '${value.maxParallelTasks}',
          ),
          _InspectorFact(
            icon: Icons.fact_check_outlined,
            label: 'Verified artifacts',
            value: '$verifiedArtifacts of ${value.artifacts.length}',
          ),
          _InspectorFact(
            icon: Icons.event_outlined,
            label: 'Target date',
            value: value.targetDate == null
                ? 'Not set'
                : _calendarDate(value.targetDate!),
          ),
          _InspectorFact(
            icon: Icons.update_rounded,
            label: 'Updated',
            value: value.updatedAt == null
                ? 'Unknown'
                : _relativeTime(value.updatedAt!),
          ),
          if (value.tasks.isNotEmpty) ...[
            const SizedBox(height: 18),
            const Divider(),
            const SizedBox(height: 18),
            MacosSectionHeader(
              title: 'Recent tasks',
              description: 'A compact preview of the current plan.',
            ),
            const SizedBox(height: 8),
            for (final task in value.tasks.take(5))
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      task.done
                          ? Icons.check_circle_rounded
                          : task.status == 'doing'
                          ? Icons.pending_rounded
                          : Icons.radio_button_unchecked_rounded,
                      size: 15,
                      color: task.done
                          ? MacosThemeColors.of(context).positive
                          : Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        task.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _InspectorFact extends StatelessWidget {
  const _InspectorFact({
    required this.icon,
    required this.label,
    required this.value,
  });
  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Icon(icon, size: 15),
        const SizedBox(width: 8),
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: Theme.of(context).textTheme.labelMedium,
          ),
        ),
      ],
    ),
  );
}

({Color color, IconData icon, String label}) _statusDescriptor(
  BuildContext context,
  String status,
) {
  final scheme = Theme.of(context).colorScheme;
  final mac = MacosThemeColors.of(context);
  return switch (status) {
    'running' => (
      color: scheme.primary,
      icon: Icons.play_circle_outline_rounded,
      label: 'Running',
    ),
    'waiting_approval' => (
      color: mac.warning,
      icon: Icons.approval_outlined,
      label: 'Needs approval',
    ),
    'paused' => (
      color: mac.warning,
      icon: Icons.pause_circle_outline_rounded,
      label: 'Paused',
    ),
    'completed' => (
      color: mac.positive,
      icon: Icons.check_circle_outline_rounded,
      label: 'Completed',
    ),
    'failed' => (
      color: scheme.error,
      icon: Icons.error_outline_rounded,
      label: 'Failed',
    ),
    'idle' => (
      color: scheme.onSurfaceVariant,
      icon: Icons.circle_outlined,
      label: 'Idle',
    ),
    _ => (
      color: scheme.onSurfaceVariant,
      icon: Icons.help_outline_rounded,
      label: status.isEmpty ? 'Unknown' : _sentenceCase(status),
    ),
  };
}

int _compareUpdated(Project left, Project right) {
  final leftValue = left.updatedAt;
  final rightValue = right.updatedAt;
  if (leftValue == null && rightValue == null) return 0;
  if (leftValue == null) return -1;
  if (rightValue == null) return 1;
  return leftValue.compareTo(rightValue);
}

int _attentionScore(Project project) => switch (project.executionStatus) {
  'failed' => 4,
  'waiting_approval' => 3,
  'running' => 2,
  'paused' => 1,
  _ => project.status == 'blocked' ? 4 : 0,
};

String _filterLabel(_ProjectFilter value) => switch (value) {
  _ProjectFilter.all => 'All states',
  _ProjectFilter.active => 'Active',
  _ProjectFilter.inFlight => 'In flight',
  _ProjectFilter.needsAttention => 'Needs attention',
  _ProjectFilter.completed => 'Completed',
};

String _sortLabel(_ProjectSort value) => switch (value) {
  _ProjectSort.recentlyUpdated => 'Recently updated',
  _ProjectSort.name => 'Name',
  _ProjectSort.progress => 'Progress',
  _ProjectSort.attention => 'Attention first',
};

String _statusLabel(String value) =>
    value.isEmpty ? 'Unknown' : _sentenceCase(value.replaceAll('_', ' '));

String _sentenceCase(String value) => value.isEmpty
    ? value
    : '${value.substring(0, 1).toUpperCase()}${value.substring(1)}';

String _calendarDate(DateTime value) {
  final local = value.toLocal();
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${months[local.month - 1]} ${local.day}, ${local.year}';
}

String _relativeTime(DateTime value) {
  final difference = DateTime.now().difference(value.toLocal());
  if (difference.isNegative || difference.inMinutes < 1) return 'Just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes} min ago';
  if (difference.inHours < 24) return '${difference.inHours} hr ago';
  if (difference.inDays == 1) return 'Yesterday';
  if (difference.inDays < 7) return '${difference.inDays} days ago';
  return _calendarDate(value);
}
