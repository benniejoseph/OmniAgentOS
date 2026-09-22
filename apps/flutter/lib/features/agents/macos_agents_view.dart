import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'agent_council.dart';
import 'agents.dart';

enum _AgentWorkspace { liveWork, agents, skills, performance }

const _agentModelPolicies = <String>[
  'auto',
  'openai_fast',
  'openai_reasoning',
  'gemini_fast',
  'anthropic_fast',
  'anthropic_reasoning',
];

/// Desktop-native agent roster for macOS.
///
/// The portable [AgentsController] remains authoritative. This presenter adds
/// dense search/filter tools, a stable selection model, and a persistent
/// configuration/activity inspector without changing Android or web.
class MacosAgentsView extends StatefulWidget {
  const MacosAgentsView({
    super.key,
    required this.controller,
    this.councilController,
    this.onAssignWork,
  });

  final AgentsController controller;
  final AgentCouncilController? councilController;
  final ValueChanged<AgentProfile>? onAssignWork;

  @override
  State<MacosAgentsView> createState() => _MacosAgentsViewState();
}

class _MacosAgentsViewState extends State<MacosAgentsView>
    with WidgetsBindingObserver {
  static const _liveRefreshInterval = Duration(seconds: 20);

  final _searchController = TextEditingController();
  _AgentWorkspace _workspace = _AgentWorkspace.agents;
  String _filter = 'all';
  String? _selectedAgentId;
  String? _selectedSkillId;
  String? _selectedPerformanceId;
  String? _selectedExecutionId;
  String? _selectedTaskId;
  Timer? _liveRefreshTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.councilController != null) {
      _workspace = _AgentWorkspace.liveWork;
      if (widget.councilController?.projection == null &&
          widget.councilController?.loading != true) {
        widget.councilController?.refresh();
      }
      _syncLiveRefreshTimer();
    }
    if (widget.controller.ledger == null && !widget.controller.loading) {
      widget.controller.refresh();
    }
  }

  @override
  void didUpdateWidget(covariant MacosAgentsView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.councilController, widget.councilController)) {
      if (widget.councilController == null &&
          _workspace == _AgentWorkspace.liveWork) {
        _workspace = _AgentWorkspace.agents;
      }
      _syncLiveRefreshTimer();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _syncLiveRefreshTimer();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _liveRefreshTimer?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      widget.controller,
      if (widget.councilController != null) widget.councilController!,
    ]),
    builder: (context, _) {
      final controller = widget.controller;
      final councilController = widget.councilController;
      final council = councilController?.projection;
      final ledger = controller.ledger;
      final agents = _visibleAgents(ledger?.agents ?? const []);
      final skills = _visibleSkills(ledger?.skills ?? const []);
      final performance = _visiblePerformance(ledger?.performance ?? const []);
      final executions = _visibleExecutions(council?.executions ?? const []);
      final selectedExecution = _findExecution(
        executions,
        _selectedExecutionId,
      );
      final selectedMember = _findCouncilMember(
        selectedExecution,
        _selectedTaskId,
      );
      final selectedAgent = _findAgent(
        ledger?.agents ?? const [],
        _selectedAgentId,
      );
      final selectedSkill = _findSkill(
        ledger?.skills ?? const [],
        _selectedSkillId,
      );
      final selectedPerformance = _findPerformance(
        ledger?.performance ?? const [],
        _selectedPerformanceId,
      );

      return MacosPageScaffold(
        title: 'Agents',
        description: 'Follow delegated work, inspect authority and evidence, and manage the Agent roster.',
        icon: Icons.smart_toy_outlined,
        actions: [
          IconButton(
            key: const Key('macos-agents-refresh'),
            tooltip: _workspace == _AgentWorkspace.liveWork
                ? 'Refresh live work'
                : 'Refresh agent roster',
            onPressed: _workspace == _AgentWorkspace.liveWork
                ? (councilController == null || councilController.loading
                      ? null
                      : councilController.refresh)
                : (controller.loading ? null : controller.refresh),
            icon:
                ((_workspace == _AgentWorkspace.liveWork &&
                        councilController?.loading == true) ||
                    (_workspace != _AgentWorkspace.liveWork &&
                        controller.loading))
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
        primaryAction:
            ((_workspace == _AgentWorkspace.agents &&
                    controller.canMutateAgents) ||
                (_workspace == _AgentWorkspace.skills &&
                    controller.canMutateSkills))
            ? FilledButton.icon(
                key: const Key('macos-agents-create'),
                onPressed: _workspace == _AgentWorkspace.skills
                    ? () => _editSkill()
                    : () => _editAgent(),
                icon: const Icon(Icons.add_rounded, size: 17),
                label: Text(
                  _workspace == _AgentWorkspace.skills
                      ? 'New skill'
                      : 'New agent',
                ),
              )
            : null,
        toolbar: _AgentsToolbar(
          workspace: _workspace,
          searchController: _searchController,
          filter: _filter,
          filters: _filtersFor(ledger, council),
          visibleCount: switch (_workspace) {
            _AgentWorkspace.liveWork => executions.length,
            _AgentWorkspace.agents => agents.length,
            _AgentWorkspace.skills => skills.length,
            _AgentWorkspace.performance => performance.length,
          },
          onWorkspaceChanged: _selectWorkspace,
          onSearchChanged: (_) => setState(() {}),
          onClearSearch: () {
            _searchController.clear();
            setState(() {});
          },
          onFilterChanged: (value) => setState(() => _filter = value),
        ),
        inspectorWidth: 410,
        inspectorMinWidth: 330,
        inspectorMaxWidth: 560,
        inspector: _workspace == _AgentWorkspace.liveWork
            ? _AgentCouncilInspector(
                key: const Key('macos-agents-live-inspector'),
                execution: selectedExecution,
                member: selectedMember,
              )
            : _AgentInspector(
                key: const Key('macos-agents-inspector'),
                workspace: _workspace,
                agent: selectedAgent,
                skill: selectedSkill,
                performance: selectedPerformance,
                ledger: ledger,
                controller: controller,
                canMutate: _workspace == _AgentWorkspace.agents
                    ? controller.canMutateAgents
                    : controller.canMutateSkills,
                onEditAgent: selectedAgent == null
                    ? null
                    : () => _editAgent(selectedAgent),
                onDeleteAgent:
                    selectedAgent == null ||
                        !selectedAgent.manageable ||
                        !controller.canDeleteAgents
                    ? null
                    : () => _confirmDelete(
                        selectedAgent.name,
                        () => controller.removeAgent(selectedAgent.id),
                      ),
                onAssignWork:
                    selectedAgent == null ||
                        !selectedAgent.selectable ||
                        selectedAgent.status == 'paused' ||
                        widget.onAssignWork == null
                    ? null
                    : () => widget.onAssignWork?.call(selectedAgent),
                onEditSkill: selectedSkill == null
                    ? null
                    : () => _editSkill(selectedSkill),
                onDeleteSkill:
                    selectedSkill == null || !selectedSkill.manageable
                    ? null
                    : () => _confirmDelete(
                        selectedSkill.name,
                        () => controller.removeSkill(selectedSkill.id),
                      ),
              ),
        body: _buildBody(
          councilController: councilController,
          council: council,
          executions: executions,
          selectedExecution: selectedExecution,
          selectedMember: selectedMember,
          ledger: ledger,
          agents: agents,
          skills: skills,
          performance: performance,
          selectedAgent: selectedAgent,
          selectedSkill: selectedSkill,
          selectedPerformance: selectedPerformance,
        ),
      );
    },
  );

  Widget _buildBody({
    required AgentCouncilController? councilController,
    required AgentCouncilProjection? council,
    required List<AgentCouncilExecution> executions,
    required AgentCouncilExecution? selectedExecution,
    required AgentCouncilMember? selectedMember,
    required AgentLedger? ledger,
    required List<AgentProfile> agents,
    required List<AgentSkill> skills,
    required List<AgentPerformance> performance,
    required AgentProfile? selectedAgent,
    required AgentSkill? selectedSkill,
    required AgentPerformance? selectedPerformance,
  }) {
    if (_workspace == _AgentWorkspace.liveWork) {
      return _buildLiveWork(
        controller: councilController,
        projection: council,
        executions: executions,
        selectedExecution: selectedExecution,
        selectedMember: selectedMember,
      );
    }
    final controller = widget.controller;
    if (ledger == null && controller.loading) {
      return const MacosLoadingList(rows: 9);
    }
    if (ledger == null && controller.error != null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Agent roster is unavailable',
        message: '${controller.error}',
        action: FilledButton.tonal(
          onPressed: controller.refresh,
          child: const Text('Reconnect'),
        ),
      );
    }
    return switch (_workspace) {
      _AgentWorkspace.liveWork => const SizedBox.shrink(),
      _AgentWorkspace.agents => _AgentRoster(
        agents: agents,
        selectedId: selectedAgent?.id,
        filtered: _isFiltered,
        onSelect: (agent) => setState(() => _selectedAgentId = agent.id),
        onClearFilters: _clearFilters,
      ),
      _AgentWorkspace.skills => _SkillRoster(
        skills: skills,
        selectedId: selectedSkill?.id,
        filtered: _isFiltered,
        onSelect: (skill) => setState(() => _selectedSkillId = skill.id),
        onClearFilters: _clearFilters,
      ),
      _AgentWorkspace.performance => _PerformanceRoster(
        performance: performance,
        selectedId: selectedPerformance?.id,
        filtered: _isFiltered,
        onSelect: (item) => setState(() => _selectedPerformanceId = item.id),
        onClearFilters: _clearFilters,
      ),
    };
  }

  bool get _isFiltered =>
      _searchController.text.trim().isNotEmpty || _filter != 'all';

  List<String> _filtersFor(
    AgentLedger? ledger,
    AgentCouncilProjection? council,
  ) {
    final values = switch (_workspace) {
      _AgentWorkspace.liveWork =>
        (council?.executions ?? const <AgentCouncilExecution>[]).map(
          (execution) => _councilStatusGroup(execution.status),
        ),
      _AgentWorkspace.agents => (ledger?.agents ?? const <AgentProfile>[]).map(
        (agent) => agent.status,
      ),
      _AgentWorkspace.skills => (ledger?.skills ?? const <AgentSkill>[]).map(
        (skill) => skill.category,
      ),
      _AgentWorkspace.performance => const <String>['active', 'no_runs'],
    };
    return values.where((value) => value.trim().isNotEmpty).toSet().toList()
      ..sort();
  }

  List<AgentProfile> _visibleAgents(List<AgentProfile> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((agent) {
      final matchesFilter = _filter == 'all' || agent.status == _filter;
      final matchesQuery =
          query.isEmpty ||
          agent.name.toLowerCase().contains(query) ||
          agent.role.toLowerCase().contains(query) ||
          agent.description.toLowerCase().contains(query) ||
          agent.modelPolicy.toLowerCase().contains(query) ||
          agent.skillIds.any((skill) => skill.toLowerCase().contains(query));
      return matchesFilter && matchesQuery;
    }).toList()..sort((left, right) => left.name.compareTo(right.name));
  }

  List<AgentSkill> _visibleSkills(List<AgentSkill> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((skill) {
      final matchesFilter = _filter == 'all' || skill.category == _filter;
      final matchesQuery =
          query.isEmpty ||
          skill.name.toLowerCase().contains(query) ||
          skill.description.toLowerCase().contains(query) ||
          skill.instructions.toLowerCase().contains(query) ||
          skill.toolIds.any((tool) => tool.toLowerCase().contains(query)) ||
          skill.tags.any((tag) => tag.toLowerCase().contains(query));
      return matchesFilter && matchesQuery;
    }).toList()..sort((left, right) => left.name.compareTo(right.name));
  }

  List<AgentPerformance> _visiblePerformance(List<AgentPerformance> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((item) {
      final matchesFilter = switch (_filter) {
        'active' => item.runs > 0,
        'no_runs' => item.runs == 0,
        _ => true,
      };
      return matchesFilter &&
          (query.isEmpty || item.name.toLowerCase().contains(query));
    }).toList()..sort((left, right) => right.runs.compareTo(left.runs));
  }

  List<AgentCouncilExecution> _visibleExecutions(
    List<AgentCouncilExecution> source,
  ) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((execution) {
      final matchesFilter =
          _filter == 'all' || _councilStatusGroup(execution.status) == _filter;
      final matchesQuery =
          query.isEmpty ||
          execution.parentExecutionId.toLowerCase().contains(query) ||
          execution.currentWork.toLowerCase().contains(query) ||
          execution.members.any(
            (member) =>
                member.identity.name.toLowerCase().contains(query) ||
                member.identity.role.toLowerCase().contains(query) ||
                member.currentWork.toLowerCase().contains(query),
          );
      return matchesFilter && matchesQuery;
    }).toList()..sort(
      (left, right) => right.updatedAt.compareTo(left.updatedAt),
    );
  }

  void _selectWorkspace(Set<_AgentWorkspace> values) {
    if (values.isEmpty) return;
    setState(() {
      _workspace = values.first;
      _filter = 'all';
      _searchController.clear();
    });
    if (_workspace == _AgentWorkspace.liveWork &&
        widget.councilController?.projection == null &&
        widget.councilController?.loading != true) {
      widget.councilController?.refresh();
    }
    _syncLiveRefreshTimer();
  }

  void _clearFilters() {
    _searchController.clear();
    setState(() => _filter = 'all');
  }

  Widget _buildLiveWork({
    required AgentCouncilController? controller,
    required AgentCouncilProjection? projection,
    required List<AgentCouncilExecution> executions,
    required AgentCouncilExecution? selectedExecution,
    required AgentCouncilMember? selectedMember,
  }) {
    if (controller == null) {
      return const MacosEmptyState(
        icon: Icons.account_tree_outlined,
        title: 'Live work is unavailable',
        message: 'This installation does not include the Agent Council read projection.',
      );
    }
    if (projection == null && controller.loading) {
      return const MacosLoadingList(rows: 8);
    }
    if (projection == null && controller.error != null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Live work could not be loaded',
        message: '${controller.error}',
        action: FilledButton.tonalIcon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded, size: 17),
          label: const Text('Try again'),
        ),
      );
    }
    if (projection == null || projection.state == 'unavailable') {
      return MacosEmptyState(
        icon: Icons.sync_problem_outlined,
        title: 'Delegation ledger is unavailable',
        message: 'Asael could not verify the canonical Agent work projection. No health state is inferred.',
        action: FilledButton.tonalIcon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded, size: 17),
          label: const Text('Retry connection'),
        ),
      );
    }
    if (projection.state == 'empty') {
      return const MacosEmptyState(
        icon: Icons.account_tree_outlined,
        title: 'No delegated work yet',
        message: 'Live work appears here after Asael delegates a bounded task to a specialist Agent.',
      );
    }
    if (executions.isEmpty) {
      return _RosterEmpty(
        filtered: _isFiltered,
        icon: Icons.filter_alt_off_outlined,
        emptyTitle: 'No live work matches these filters',
        onClearFilters: _clearFilters,
      );
    }
    return _AgentCouncilWorkspace(
      projection: projection,
      executions: executions,
      selectedExecution: selectedExecution!,
      selectedMember: selectedMember!,
      refreshError: controller.error,
      onSelect: (execution, member) => setState(() {
        _selectedExecutionId = execution.parentExecutionId;
        _selectedTaskId = member.taskId;
      }),
    );
  }

  void _syncLiveRefreshTimer() {
    _liveRefreshTimer?.cancel();
    _liveRefreshTimer = null;
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final isVisible =
        lifecycle == null || lifecycle == AppLifecycleState.resumed;
    if (widget.councilController == null ||
        _workspace != _AgentWorkspace.liveWork ||
        !isVisible) {
      return;
    }
    _liveRefreshTimer = Timer.periodic(_liveRefreshInterval, (_) {
      final controller = widget.councilController;
      if (controller != null && !controller.loading) controller.refresh();
    });
  }

  Future<void> _editAgent([AgentProfile? agent]) async {
    if (agent != null && !agent.manageable) return;
    final value = await showDialog<Json>(
      context: context,
      builder: (_) => _MacosAgentDialog(
        agent: agent,
        skills: widget.controller.ledger?.skills ?? const [],
      ),
    );
    if (value != null) {
      await _run(() => widget.controller.saveAgent(value, id: agent?.id));
    }
  }

  Future<void> _editSkill([AgentSkill? skill]) async {
    if (skill != null && !skill.manageable) return;
    final value = await showDialog<Json>(
      context: context,
      builder: (_) => _MacosSkillDialog(skill: skill),
    );
    if (value != null) {
      await _run(() => widget.controller.saveSkill(value, id: skill?.id));
    }
  }

  Future<void> _confirmDelete(
    String name,
    Future<void> Function() action,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Delete $name?'),
        content: const SizedBox(
          width: 420,
          child: Text(
            'This removes the custom configuration and cannot be undone.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('macos-agent-confirm-delete'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed == true) await _run(action);
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('$error')));
    }
  }
}

class _AgentsToolbar extends StatelessWidget {
  const _AgentsToolbar({
    required this.workspace,
    required this.searchController,
    required this.filter,
    required this.filters,
    required this.visibleCount,
    required this.onWorkspaceChanged,
    required this.onSearchChanged,
    required this.onClearSearch,
    required this.onFilterChanged,
  });

  final _AgentWorkspace workspace;
  final TextEditingController searchController;
  final String filter;
  final List<String> filters;
  final int visibleCount;
  final ValueChanged<Set<_AgentWorkspace>> onWorkspaceChanged;
  final ValueChanged<String> onSearchChanged;
  final VoidCallback onClearSearch;
  final ValueChanged<String> onFilterChanged;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 1040;
      return Row(
        children: [
          SegmentedButton<_AgentWorkspace>(
            key: const Key('macos-agents-workspace'),
            showSelectedIcon: false,
            segments: [
              ButtonSegment(
                value: _AgentWorkspace.liveWork,
                icon: const Tooltip(
                  message: 'Live work',
                  child: Icon(Icons.account_tree_outlined, size: 15),
                ),
                label: compact ? null : const Text('Live work'),
              ),
              ButtonSegment(
                value: _AgentWorkspace.agents,
                icon: const Tooltip(
                  message: 'Roster',
                  child: Icon(Icons.smart_toy_outlined, size: 15),
                ),
                label: compact ? null : const Text('Roster'),
              ),
              ButtonSegment(
                value: _AgentWorkspace.skills,
                icon: const Tooltip(
                  message: 'Skills',
                  child: Icon(Icons.bolt_outlined, size: 15),
                ),
                label: compact ? null : const Text('Skills'),
              ),
              ButtonSegment(
                value: _AgentWorkspace.performance,
                icon: const Tooltip(
                  message: 'Outcomes',
                  child: Icon(Icons.query_stats_outlined, size: 15),
                ),
                label: compact ? null : const Text('Outcomes'),
              ),
            ],
            selected: {workspace},
            onSelectionChanged: onWorkspaceChanged,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              key: const Key('macos-agents-search'),
              controller: searchController,
              onChanged: onSearchChanged,
              decoration: InputDecoration(
                hintText: switch (workspace) {
                  _AgentWorkspace.liveWork => 'Search work or specialists',
                  _AgentWorkspace.agents => 'Search agents or models',
                  _AgentWorkspace.skills => 'Search skills or tools',
                  _AgentWorkspace.performance => 'Search outcomes',
                },
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
          const SizedBox(width: 8),
          SizedBox(
            width: compact ? 120 : 155,
            child: DropdownButtonFormField<String>(
              key: ValueKey('macos-agents-filter-$workspace-$filter'),
              initialValue: filter,
              isExpanded: true,
              decoration: const InputDecoration(),
              items: [
                const DropdownMenuItem(value: 'all', child: Text('All')),
                ...filters.map(
                  (value) => DropdownMenuItem(
                    value: value,
                    child: Text(_label(value), overflow: TextOverflow.ellipsis),
                  ),
                ),
              ],
              onChanged: (value) {
                if (value != null) onFilterChanged(value);
              },
            ),
          ),
          if (!compact) ...[
            const SizedBox(width: 12),
            Text(
              '$visibleCount visible',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      );
    },
  );
}

class _AgentCouncilWorkspace extends StatelessWidget {
  const _AgentCouncilWorkspace({
    required this.projection,
    required this.executions,
    required this.selectedExecution,
    required this.selectedMember,
    required this.refreshError,
    required this.onSelect,
  });

  final AgentCouncilProjection projection;
  final List<AgentCouncilExecution> executions;
  final AgentCouncilExecution selectedExecution;
  final AgentCouncilMember selectedMember;
  final Object? refreshError;
  final void Function(
    AgentCouncilExecution execution,
    AgentCouncilMember member,
  )
  onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      children: [
        _CouncilSummaryStrip(projection: projection),
        if (refreshError != null)
          Container(
            key: const Key('macos-agents-live-stale'),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.errorContainer,
              border: Border(bottom: BorderSide(color: mac.divider)),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.warning_amber_rounded,
                  size: 16,
                  color: Theme.of(context).colorScheme.onErrorContainer,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Showing the last verified projection. Refresh failed: $refreshError',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onErrorContainer,
                    ),
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final horizontal = constraints.maxWidth >= 760;
              final rail = _CouncilExecutionRail(
                executions: executions,
                selectedExecutionId: selectedExecution.parentExecutionId,
                selectedTaskId: selectedMember.taskId,
                horizontal: !horizontal,
                onSelect: onSelect,
              );
              final canvas = _CouncilMemberCanvas(
                execution: selectedExecution,
                member: selectedMember,
              );
              if (!horizontal) {
                return Column(
                  children: [
                    SizedBox(height: 154, child: rail),
                    Expanded(child: canvas),
                  ],
                );
              }
              return Row(
                children: [
                  SizedBox(width: 310, child: rail),
                  VerticalDivider(width: 1, color: mac.divider),
                  Expanded(child: canvas),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}

class _CouncilSummaryStrip extends StatelessWidget {
  const _CouncilSummaryStrip({required this.projection});

  final AgentCouncilProjection projection;

  @override
  Widget build(BuildContext context) {
    final summary = projection.summary;
    final mac = MacosThemeColors.of(context);
    return Container(
      key: const Key('macos-agents-live-summary'),
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 54),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          const Icon(Icons.account_tree_outlined, size: 17),
          const SizedBox(width: 9),
          Expanded(
            child: Wrap(
              spacing: 20,
              runSpacing: 5,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _CouncilSummaryValue(
                  value: '${summary.executionCount}',
                  label: 'runs',
                ),
                _CouncilSummaryValue(
                  value: '${summary.activeMemberCount}',
                  label: 'active',
                  emphasized: summary.activeMemberCount > 0,
                ),
                _CouncilSummaryValue(
                  value: '${summary.waitingMemberCount}',
                  label: 'waiting',
                  attention: summary.waitingMemberCount > 0,
                ),
                _CouncilSummaryValue(
                  value: '${summary.acceptedMemberCount}',
                  label: 'accepted',
                ),
                _CouncilSummaryValue(
                  value: _formatKnownMicrousd(
                    summary.knownEstimatedCostMicrousd,
                  ),
                  label: 'known spend',
                ),
              ],
            ),
          ),
          Text(
            'Updated ${_relativeTime(projection.generatedAt)}',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _CouncilSummaryValue extends StatelessWidget {
  const _CouncilSummaryValue({
    required this.value,
    required this.label,
    this.emphasized = false,
    this.attention = false,
  });

  final String value, label;
  final bool emphasized, attention;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = attention
        ? scheme.secondary
        : emphasized
        ? scheme.primary
        : scheme.onSurface;
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: value,
            style: TextStyle(color: color, fontWeight: FontWeight.w700),
          ),
          TextSpan(text: ' $label'),
        ],
      ),
      style: Theme.of(context).textTheme.bodySmall,
    );
  }
}

class _CouncilExecutionRail extends StatelessWidget {
  const _CouncilExecutionRail({
    required this.executions,
    required this.selectedExecutionId,
    required this.selectedTaskId,
    required this.horizontal,
    required this.onSelect,
  });

  final List<AgentCouncilExecution> executions;
  final String selectedExecutionId, selectedTaskId;
  final bool horizontal;
  final void Function(
    AgentCouncilExecution execution,
    AgentCouncilMember member,
  )
  onSelect;

  @override
  Widget build(BuildContext context) {
    if (horizontal) {
      final entries = [
        for (final execution in executions)
          for (final member in execution.members) (execution, member),
      ];
      return ListView.separated(
        key: const Key('macos-agents-live-rail'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.all(10),
        itemCount: entries.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final (execution, member) = entries[index];
          return SizedBox(
            width: 260,
            child: _CouncilMemberRailRow(
              execution: execution,
              member: member,
              selected: member.taskId == selectedTaskId,
              onTap: () => onSelect(execution, member),
            ),
          );
        },
      );
    }
    return Column(
      children: [
        _CouncilPaneHeader(
          title: 'Execution queue',
          detail: '${executions.length} recent · read only',
        ),
        Expanded(
          child: ListView.builder(
            key: const Key('macos-agents-live-rail'),
            itemCount: executions.length,
            itemBuilder: (context, index) {
              final execution = executions[index];
              final expanded =
                  execution.parentExecutionId == selectedExecutionId;
              return _CouncilExecutionGroup(
                execution: execution,
                expanded: expanded,
                selectedTaskId: selectedTaskId,
                onSelect: (member) => onSelect(execution, member),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _CouncilExecutionGroup extends StatelessWidget {
  const _CouncilExecutionGroup({
    required this.execution,
    required this.expanded,
    required this.selectedTaskId,
    required this.onSelect,
  });

  final AgentCouncilExecution execution;
  final bool expanded;
  final String selectedTaskId;
  final ValueChanged<AgentCouncilMember> onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Material(
          color: expanded ? mac.hover : Colors.transparent,
          child: InkWell(
            key: Key('macos-council-run-${execution.parentExecutionId}'),
            onTap: () => onSelect(execution.members.first),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 11, 12, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      _CouncilStatePill(state: execution.status),
                      const Spacer(),
                      Text(
                        _relativeTime(execution.updatedAt),
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ],
                  ),
                  const SizedBox(height: 7),
                  Text(
                    execution.currentWork,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${execution.members.length} specialist${execution.members.length == 1 ? '' : 's'} · ${_shortId(execution.parentExecutionId)}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (expanded)
          for (final member in execution.members)
            _CouncilMemberRailRow(
              execution: execution,
              member: member,
              selected: member.taskId == selectedTaskId,
              onTap: () => onSelect(member),
            ),
        Divider(height: 1, color: mac.divider),
      ],
    );
  }
}

class _CouncilMemberRailRow extends StatelessWidget {
  const _CouncilMemberRailRow({
    required this.execution,
    required this.member,
    required this.selected,
    required this.onTap,
  });

  final AgentCouncilExecution execution;
  final AgentCouncilMember member;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label:
          '${member.identity.name}, ${member.identity.role}, ${_councilStatusLabel(member.state)}',
      child: Material(
        color: selected ? mac.selection : Colors.transparent,
        child: InkWell(
          key: Key('macos-council-member-${member.taskId}'),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 58),
            padding: EdgeInsets.fromLTRB(horizontalPadding, 8, 10, 8),
            child: Row(
              children: [
                _CouncilAgentGlyph(identity: member.identity),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        member.identity.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        member.identity.role,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                _CouncilStateDot(state: member.state),
              ],
            ),
          ),
        ),
      ),
    );
  }

  double get horizontalPadding => selected ? 17 : 20;
}

class _CouncilMemberCanvas extends StatelessWidget {
  const _CouncilMemberCanvas({required this.execution, required this.member});

  final AgentCouncilExecution execution;
  final AgentCouncilMember member;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 13),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: mac.divider)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _CouncilAgentGlyph(identity: member.identity, size: 40),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            member.identity.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                        const SizedBox(width: 8),
                        _CouncilStatePill(state: member.state),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      member.identity.role,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              Text(
                'Revision ${member.lifecycleRevision}',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ],
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            key: const Key('macos-agents-live-canvas'),
            padding: const EdgeInsets.fromLTRB(18, 17, 18, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Current work',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 6),
                SelectableText(
                  member.currentWork,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 18),
                LayoutBuilder(
                  builder: (context, constraints) {
                    final split = constraints.maxWidth >= 700;
                    final messages = _CouncilExchangeSection.messages(
                      member.messages,
                    );
                    final outputs = _CouncilExchangeSection.outputs(
                      member.outputs,
                    );
                    if (!split) {
                      return Column(
                        children: [
                          messages,
                          const SizedBox(height: 18),
                          outputs,
                        ],
                      );
                    }
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: messages),
                        const SizedBox(width: 20),
                        Expanded(child: outputs),
                      ],
                    );
                  },
                ),
                const SizedBox(height: 20),
                _CouncilVerificationBoundary(member: member),
                const SizedBox(height: 14),
                Text(
                  'Run ${_shortId(execution.parentExecutionId)} · Task ${_shortId(member.taskId)} · Updated ${_formatTimestamp(member.updatedAt)}',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _CouncilExchangeSection extends StatelessWidget {
  const _CouncilExchangeSection._({
    required this.icon,
    required this.title,
    required this.state,
    required this.entries,
    required this.emptyMessage,
  });

  factory _CouncilExchangeSection.messages(AgentCouncilMessages messages) =>
      _CouncilExchangeSection._(
        icon: Icons.forum_outlined,
        title: 'Team messages',
        state: _label(messages.state),
        entries: messages.items
            .take(8)
            .map(
              (message) => _CouncilExchangeEntry(
                title: '${_label(message.direction)} · ${_label(message.kind)}',
                body: message.body,
                createdAt: message.createdAt,
              ),
            )
            .toList(growable: false),
        emptyMessage: messages.state == 'unavailable'
            ? 'Message evidence is unavailable for this task.'
            : 'No team messages have been recorded.',
      );

  factory _CouncilExchangeSection.outputs(
    AgentCouncilOutputs outputs,
  ) => _CouncilExchangeSection._(
    icon: Icons.inventory_2_outlined,
    title: 'Shared outputs',
    state: _label(outputs.state),
    entries: outputs.items
        .take(8)
        .map(
          (output) => _CouncilExchangeEntry(
            title: output.title,
            body: output.content.isEmpty
                ? '${_label(output.kind)} output, content not included in this projection.'
                : output.content,
            createdAt: output.createdAt,
          ),
        )
        .toList(growable: false),
    emptyMessage: outputs.state == 'unavailable'
        ? 'Output evidence is unavailable for this task.'
        : 'No shared outputs have been recorded.',
  );

  final IconData icon;
  final String title, state, emptyMessage;
  final List<_CouncilExchangeEntry> entries;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 16),
            const SizedBox(width: 7),
            Expanded(
              child: Text(title, style: Theme.of(context).textTheme.titleSmall),
            ),
            Text(state, style: Theme.of(context).textTheme.labelSmall),
          ],
        ),
        const SizedBox(height: 8),
        Container(
          decoration: BoxDecoration(
            border: Border.all(color: mac.divider),
            borderRadius: BorderRadius.circular(10),
          ),
          child: entries.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(14),
                  child: Text(
                    emptyMessage,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                )
              : Column(
                  children: [
                    for (var index = 0; index < entries.length; index++) ...[
                      entries[index],
                      if (index != entries.length - 1)
                        Divider(height: 1, color: mac.divider),
                    ],
                  ],
                ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Icon(
              Icons.shield_outlined,
              size: 13,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 5),
            Expanded(
              child: Text(
                'Shared content is untrusted until verified.',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _CouncilExchangeEntry extends StatelessWidget {
  const _CouncilExchangeEntry({
    required this.title,
    required this.body,
    required this.createdAt,
  });

  final String title, body, createdAt;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(11),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium,
              ),
            ),
            Text(
              _relativeTime(createdAt),
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
        const SizedBox(height: 5),
        Text(
          body,
          maxLines: 4,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    ),
  );
}

class _CouncilVerificationBoundary extends StatelessWidget {
  const _CouncilVerificationBoundary({required this.member});

  final AgentCouncilMember member;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final verifier = member.verifier;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border.all(color: mac.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          const Icon(Icons.verified_user_outlined, size: 19),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Independent verification',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 2),
                Text(
                  '${verifier.identity.name} · ${_label(verifier.method)}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              _CouncilStatePill(state: verifier.verdict),
              const SizedBox(height: 3),
              Text(
                verifier.score == null
                    ? 'Not scored'
                    : '${(verifier.score! * 100).round()}% score · ${(verifier.acceptanceThreshold * 100).round()}% required',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AgentCouncilInspector extends StatelessWidget {
  const _AgentCouncilInspector({
    super.key,
    required this.execution,
    required this.member,
  });

  final AgentCouncilExecution? execution;
  final AgentCouncilMember? member;

  @override
  Widget build(BuildContext context) {
    final execution = this.execution;
    final member = this.member;
    if (execution == null || member == null) {
      return const _InspectorPlaceholder(
        icon: Icons.account_tree_outlined,
        title: 'Select delegated work',
        message: 'Choose a specialist task to inspect its authority, limits, verification, and cost evidence.',
      );
    }
    final authority = member.authority;
    final budgets = authority.budgets;
    final verifiedAuthority = authority.source == 'delegation_grants';
    return SingleChildScrollView(
      key: const Key('macos-agents-live-inspector-scroll'),
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _CouncilAgentGlyph(identity: member.identity, size: 38),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      member.identity.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      'Definition v${member.identity.definitionVersion}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              const _SmallBadge(label: 'Read only'),
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Verification',
            children: [
              _MetaLine(
                label: 'Verdict',
                value: _councilStatusLabel(member.verifier.verdict),
              ),
              _MetaLine(
                label: 'Verifier',
                value: member.verifier.identity.name,
              ),
              _MetaLine(
                label: 'Confidence',
                value: member.confidence == null
                    ? 'Not recorded'
                    : '${(member.confidence! * 100).round()}%',
              ),
              _MetaLine(
                label: 'Verifier score',
                value: member.verifier.score == null
                    ? 'Not scored'
                    : '${(member.verifier.score! * 100).round()}%',
              ),
              _MetaLine(
                label: 'Acceptance threshold',
                value:
                    '${(member.verifier.acceptanceThreshold * 100).round()}%',
              ),
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Authority',
            children: [
              Row(
                children: [
                  Icon(
                    verifiedAuthority
                        ? Icons.verified_outlined
                        : Icons.warning_amber_rounded,
                    size: 16,
                    color: verifiedAuthority
                        ? Theme.of(context).colorScheme.primary
                        : Theme.of(context).colorScheme.secondary,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      verifiedAuthority
                          ? 'Verified delegation receipt'
                          : 'Historical authority unavailable',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 9),
              Text(authority.purpose),
              const SizedBox(height: 10),
              _MetaLine(
                label: 'Context grants',
                value: _authorityCount(
                  authority.contextState,
                  authority.contextGrantCount,
                ),
              ),
              _MetaLine(
                label: 'Capability grants',
                value: _authorityCount(
                  authority.capabilityState,
                  authority.capabilityGrantCount,
                ),
              ),
              _MetaLine(
                label: 'Governed tools',
                value: authority.toolState == 'unavailable'
                    ? 'Unavailable'
                    : '${authority.toolIds.length}',
              ),
              if (authority.toolIds.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: authority.toolIds
                      .map((tool) => _SmallBadge(label: tool))
                      .toList(growable: false),
                ),
              ],
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Budget limits',
            children: [
              _MetaLine(
                label: 'Model turns',
                value: _budgetValue(budgets.modelTurns),
              ),
              _MetaLine(label: 'Tokens', value: _budgetValue(budgets.tokens)),
              _MetaLine(
                label: 'Tool calls',
                value: _budgetValue(budgets.toolCalls),
              ),
              _MetaLine(
                label: 'Browser actions',
                value: _budgetValue(budgets.browserActions),
              ),
              _MetaLine(
                label: 'Wall time',
                value: budgets.wallTimeMs == null
                    ? 'Not recorded'
                    : _formatDuration(budgets.wallTimeMs!),
              ),
              _MetaLine(
                label: 'Cost limit',
                value: budgets.costMicrousd == null
                    ? 'Not recorded'
                    : _formatKnownMicrousd(budgets.costMicrousd!),
              ),
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Observed usage',
            children: [
              _MetaLine(label: 'Worker cost', value: _costLabel(member.cost)),
              _MetaLine(
                label: 'Verifier cost',
                value: _costLabel(execution.verifierCost),
              ),
              _MetaLine(
                label: 'Worker tokens',
                value: member.cost.receiptCount == 0
                    ? 'Not recorded'
                    : '${member.cost.totalTokens}',
              ),
              _MetaLine(
                label: 'Usage receipts',
                value: '${member.cost.receiptCount}',
              ),
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Scope and identity',
            children: [
              _MetaLine(
                label: 'Workspace',
                value: authority.workspaceId ?? 'Not scoped',
              ),
              _MetaLine(
                label: 'Project',
                value: authority.projectId ?? 'Not scoped',
              ),
              _MetaLine(
                label: 'Mission',
                value: authority.missionId ?? 'Not scoped',
              ),
              const SizedBox(height: 7),
              SelectableText(
                'Run ${execution.parentExecutionId}\nTask ${member.taskId}\nDelegation ${member.delegationId}',
                style: Theme.of(context).textTheme.labelSmall
                    ?.copyWith(fontFamily: 'monospace', height: 1.5),
              ),
            ],
          ),
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Model route',
            children: [
              Text(
                'Not recorded in this Council projection. Model assignments remain configurable in Settings and are verified on the run receipt.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CouncilPaneHeader extends StatelessWidget {
  const _CouncilPaneHeader({required this.title, required this.detail});

  final String title, detail;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      height: 45,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(title, style: Theme.of(context).textTheme.labelMedium),
          ),
          Text(detail, style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }
}

class _CouncilAgentGlyph extends StatelessWidget {
  const _CouncilAgentGlyph({required this.identity, this.size = 32});

  final AgentCouncilIdentity identity;
  final double size;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final seed = identity.agentId.codeUnits.fold<int>(
      0,
      (sum, code) => sum + code,
    );
    final colors = <Color>[
      scheme.primary,
      scheme.secondary,
      scheme.tertiary,
      scheme.onSurfaceVariant,
    ];
    final color = colors[seed % colors.length];
    final initial = identity.name.trim().isEmpty
        ? '?'
        : identity.name.trim().characters.first.toUpperCase();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color.withValues(alpha: .14),
        borderRadius: BorderRadius.circular(size * .24),
      ),
      child: Text(
        initial,
        style: Theme.of(context).textTheme.labelLarge
            ?.copyWith(color: color, fontWeight: FontWeight.w700),
      ),
    );
  }
}

class _CouncilStatePill extends StatelessWidget {
  const _CouncilStatePill({required this.state});

  final String state;

  @override
  Widget build(BuildContext context) {
    final color = _councilStateColor(context, state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            _councilStatusLabel(state),
            style: Theme.of(context).textTheme.labelSmall
                ?.copyWith(color: color, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class _CouncilStateDot extends StatelessWidget {
  const _CouncilStateDot({required this.state});

  final String state;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: _councilStatusLabel(state),
    child: Container(
      width: 9,
      height: 9,
      decoration: BoxDecoration(
        color: _councilStateColor(context, state),
        shape: BoxShape.circle,
      ),
    ),
  );
}

class _AgentRoster extends StatelessWidget {
  const _AgentRoster({
    required this.agents,
    required this.selectedId,
    required this.filtered,
    required this.onSelect,
    required this.onClearFilters,
  });

  final List<AgentProfile> agents;
  final String? selectedId;
  final bool filtered;
  final ValueChanged<AgentProfile> onSelect;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    if (agents.isEmpty) {
      return _RosterEmpty(
        filtered: filtered,
        icon: Icons.smart_toy_outlined,
        emptyTitle: 'No agents configured',
        onClearFilters: onClearFilters,
      );
    }
    return Column(
      children: [
        const _RosterHeader(
          primary: 'Agent and role',
          secondary: 'Model policy',
          tertiary: 'Autonomy',
          trailing: 'Status',
        ),
        Expanded(
          child: ListView.builder(
            itemCount: agents.length,
            itemBuilder: (context, index) {
              final agent = agents[index];
              return _AgentRow(
                key: Key('macos-agent-row-${agent.id}'),
                agent: agent,
                selected: agent.id == selectedId,
                onTap: () => onSelect(agent),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _AgentRow extends StatelessWidget {
  const _AgentRow({
    super.key,
    required this.agent,
    required this.selected,
    required this.onTap,
  });

  final AgentProfile agent;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: '${agent.name}, ${agent.role}, ${agent.status}',
      child: Material(
        color: selected ? mac.selection : Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: Container(
            height: 64,
            padding: const EdgeInsets.symmetric(horizontal: 18),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: mac.divider)),
            ),
            child: Row(
              children: [
                _AgentGlyph(agent: agent, size: 34),
                const SizedBox(width: 11),
                Expanded(
                  flex: 5,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              agent.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                          ),
                          if (agent.builtIn) ...[
                            const SizedBox(width: 6),
                            const _SmallBadge(label: 'Built-in'),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        agent.role,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    _label(agent.modelPolicy),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    _label(agent.autonomy),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: _StatusIndicator(status: agent.status),
                  ),
                ),
                const SizedBox(width: 4),
                const Icon(Icons.chevron_right_rounded, size: 16),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SkillRoster extends StatelessWidget {
  const _SkillRoster({
    required this.skills,
    required this.selectedId,
    required this.filtered,
    required this.onSelect,
    required this.onClearFilters,
  });

  final List<AgentSkill> skills;
  final String? selectedId;
  final bool filtered;
  final ValueChanged<AgentSkill> onSelect;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    if (skills.isEmpty) {
      return _RosterEmpty(
        filtered: filtered,
        icon: Icons.bolt_outlined,
        emptyTitle: 'No skills available',
        onClearFilters: onClearFilters,
      );
    }
    return Column(
      children: [
        const _RosterHeader(
          primary: 'Skill and purpose',
          secondary: 'Category',
          tertiary: 'Tools',
          trailing: 'Status',
        ),
        Expanded(
          child: ListView.builder(
            itemCount: skills.length,
            itemBuilder: (context, index) {
              final skill = skills[index];
              final selected = skill.id == selectedId;
              final mac = MacosThemeColors.of(context);
              return Semantics(
                button: true,
                selected: selected,
                label: '${skill.name}, ${skill.category} skill',
                child: Material(
                  color: selected ? mac.selection : Colors.transparent,
                  child: InkWell(
                    key: Key('macos-skill-row-${skill.id}'),
                    onTap: () => onSelect(skill),
                    child: Container(
                      height: 64,
                      padding: const EdgeInsets.symmetric(horizontal: 18),
                      decoration: BoxDecoration(
                        border: Border(bottom: BorderSide(color: mac.divider)),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: mac.hover,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Icon(Icons.bolt_outlined, size: 17),
                          ),
                          const SizedBox(width: 11),
                          Expanded(
                            flex: 5,
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Flexible(
                                      child: Text(
                                        skill.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleSmall,
                                      ),
                                    ),
                                    if (skill.builtIn) ...[
                                      const SizedBox(width: 6),
                                      const _SmallBadge(label: 'Built-in'),
                                    ],
                                  ],
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  skill.description,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Text(
                              _label(skill.category),
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Text(
                              '${skill.toolIds.length}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: _StatusIndicator(status: skill.status),
                            ),
                          ),
                          const SizedBox(width: 4),
                          const Icon(Icons.chevron_right_rounded, size: 16),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _PerformanceRoster extends StatelessWidget {
  const _PerformanceRoster({
    required this.performance,
    required this.selectedId,
    required this.filtered,
    required this.onSelect,
    required this.onClearFilters,
  });

  final List<AgentPerformance> performance;
  final String? selectedId;
  final bool filtered;
  final ValueChanged<AgentPerformance> onSelect;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    if (performance.isEmpty) {
      return _RosterEmpty(
        filtered: filtered,
        icon: Icons.query_stats_outlined,
        emptyTitle: 'Outcomes appear after the first run',
        onClearFilters: onClearFilters,
      );
    }
    return Column(
      children: [
        const _RosterHeader(
          primary: 'Agent',
          secondary: 'Runs',
          tertiary: 'Success',
          trailing: 'Average latency',
        ),
        Expanded(
          child: ListView.builder(
            itemCount: performance.length,
            itemBuilder: (context, index) {
              final item = performance[index];
              final rate = _normalizedRate(item.successRate);
              final selected = item.id == selectedId;
              final mac = MacosThemeColors.of(context);
              return Semantics(
                button: true,
                selected: selected,
                label: '${item.name}, ${(rate * 100).round()} percent success',
                child: Material(
                  color: selected ? mac.selection : Colors.transparent,
                  child: InkWell(
                    key: Key('macos-performance-row-${item.id}'),
                    onTap: () => onSelect(item),
                    child: Container(
                      height: 64,
                      padding: const EdgeInsets.symmetric(horizontal: 18),
                      decoration: BoxDecoration(
                        border: Border(bottom: BorderSide(color: mac.divider)),
                      ),
                      child: Row(
                        children: [
                          const SizedBox(width: 45),
                          Expanded(
                            flex: 5,
                            child: Text(
                              item.name,
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Text(
                              '${item.runs}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Padding(
                              padding: const EdgeInsets.only(right: 24),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: LinearProgressIndicator(
                                      value: rate,
                                      minHeight: 4,
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Text(
                                    '${(rate * 100).round()}%',
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelSmall,
                                  ),
                                ],
                              ),
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Text(
                                _latency(item.averageLatencyMs),
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ),
                          ),
                          const SizedBox(width: 20),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _RosterHeader extends StatelessWidget {
  const _RosterHeader({
    required this.primary,
    required this.secondary,
    required this.tertiary,
    required this.trailing,
  });

  final String primary, secondary, tertiary, trailing;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final style = Theme.of(context).textTheme.labelSmall;
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          const SizedBox(width: 45),
          Expanded(flex: 5, child: Text(primary, style: style)),
          Expanded(flex: 2, child: Text(secondary, style: style)),
          Expanded(flex: 2, child: Text(tertiary, style: style)),
          Expanded(
            flex: 2,
            child: Align(
              alignment: Alignment.centerRight,
              child: Text(trailing, style: style),
            ),
          ),
          const SizedBox(width: 20),
        ],
      ),
    );
  }
}

class _RosterEmpty extends StatelessWidget {
  const _RosterEmpty({
    required this.filtered,
    required this.icon,
    required this.emptyTitle,
    required this.onClearFilters,
  });

  final bool filtered;
  final IconData icon;
  final String emptyTitle;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) => MacosEmptyState(
    icon: icon,
    title: filtered ? 'No matching entries' : emptyTitle,
    message: filtered
        ? 'Change the search or filter to widen this view.'
        : 'This workspace will update as Asael gains activity.',
    action: filtered
        ? TextButton(
            onPressed: onClearFilters,
            child: const Text('Clear filters'),
          )
        : null,
  );
}

class _AgentInspector extends StatelessWidget {
  const _AgentInspector({
    super.key,
    required this.workspace,
    required this.agent,
    required this.skill,
    required this.performance,
    required this.ledger,
    required this.controller,
    required this.canMutate,
    required this.onEditAgent,
    required this.onDeleteAgent,
    required this.onAssignWork,
    required this.onEditSkill,
    required this.onDeleteSkill,
  });

  final _AgentWorkspace workspace;
  final AgentProfile? agent;
  final AgentSkill? skill;
  final AgentPerformance? performance;
  final AgentLedger? ledger;
  final AgentsController controller;
  final bool canMutate;
  final VoidCallback? onEditAgent,
      onDeleteAgent,
      onAssignWork,
      onEditSkill,
      onDeleteSkill;

  @override
  Widget build(BuildContext context) => switch (workspace) {
    _AgentWorkspace.liveWork => const _InspectorPlaceholder(
      icon: Icons.account_tree_outlined,
      title: 'Select delegated work',
      message: 'Authority and verification evidence appears here.',
    ),
    _AgentWorkspace.agents =>
      agent == null
          ? const _InspectorPlaceholder(
              icon: Icons.smart_toy_outlined,
              title: 'Select an agent',
              message: 'Policy, capabilities, and observed outcomes stay here.',
            )
          : _AgentDetail(
              agent: agent!,
              ledger: ledger,
              controller: controller,
              canMutate: canMutate,
              onEdit: onEditAgent,
              onDelete: onDeleteAgent,
              onAssignWork: onAssignWork,
            ),
    _AgentWorkspace.skills =>
      skill == null
          ? const _InspectorPlaceholder(
              icon: Icons.bolt_outlined,
              title: 'Select a skill',
              message:
                  'Instructions, tools, tags, and assignment remain visible.',
            )
          : _SkillDetail(
              skill: skill!,
              ledger: ledger,
              canMutate: canMutate,
              onEdit: onEditSkill,
              onDelete: onDeleteSkill,
            ),
    _AgentWorkspace.performance =>
      performance == null
          ? const _InspectorPlaceholder(
              icon: Icons.query_stats_outlined,
              title: 'Select an outcome record',
              message:
                  'Run volume, reliability, latency, and learning appear here.',
            )
          : _PerformanceDetail(performance: performance!),
  };
}

class _AgentDetail extends StatelessWidget {
  const _AgentDetail({
    required this.agent,
    required this.ledger,
    required this.controller,
    required this.canMutate,
    required this.onEdit,
    required this.onDelete,
    required this.onAssignWork,
  });

  final AgentProfile agent;
  final AgentLedger? ledger;
  final AgentsController controller;
  final bool canMutate;
  final VoidCallback? onEdit, onDelete, onAssignWork;

  @override
  Widget build(BuildContext context) {
    final skillsById = {
      for (final skill in ledger?.skills ?? const <AgentSkill>[])
        skill.id: skill,
    };
    final isExactMoltbookAgent = isExactMoltbookAgentBoundary(agent);
    AgentPerformance? performance;
    for (final item in ledger?.performance ?? const <AgentPerformance>[]) {
      if (item.id == agent.id || item.name == agent.name) {
        performance = item;
        break;
      }
    }
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _AgentGlyph(agent: agent, size: 44),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          agent.name,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                      if (agent.builtIn) ...[
                        const SizedBox(width: 7),
                        const _SmallBadge(label: 'Built-in'),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    agent.role,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            _StatusIndicator(status: agent.status),
          ],
        ),
        const SizedBox(height: 14),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            key: const Key('macos-agent-assign-work'),
            onPressed: onAssignWork,
            icon: const Icon(Icons.arrow_forward_rounded, size: 17),
            label: Text('Assign work to ${agent.name}'),
          ),
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Purpose',
          child: Text(
            agent.description.isEmpty
                ? 'No description is configured.'
                : agent.description,
          ),
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Operating policy',
          child: Column(
            children: [
              _MetaLine(label: 'Model', value: _label(agent.modelPolicy)),
              _MetaLine(label: 'Autonomy', value: _label(agent.autonomy)),
              _MetaLine(
                label: 'Approvals',
                value: _label(agent.approvalPolicy),
              ),
              _MetaLine(label: 'Memory', value: _label(agent.memoryScope)),
            ],
          ),
        ),
        if (performance != null) ...[
          const SizedBox(height: 18),
          _OutcomeSummary(performance: performance),
        ],
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Instructions',
          child: SelectableText(
            agent.instructions.isEmpty
                ? 'No operating instructions are configured.'
                : agent.instructions,
          ),
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Assigned skills (${agent.skillIds.length})',
          child: agent.skillIds.isEmpty
              ? Text(
                  'No skills assigned.',
                  style: Theme.of(context).textTheme.bodySmall,
                )
              : Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: agent.skillIds
                      .map(
                        (id) => Chip(label: Text(skillsById[id]?.name ?? id)),
                      )
                      .toList(),
                ),
        ),
        if (agent.toolIds.isNotEmpty) ...[
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Direct tools (${agent.toolIds.length})',
            child: SelectableText(agent.toolIds.join('\n')),
          ),
        ],
        if (isExactMoltbookAgent) ...[
          const SizedBox(height: 18),
          _MoltbookAgentConsole(
            key: ValueKey('moltbook-console-${agent.id}'),
            agent: agent,
            controller: controller,
          ),
        ],
        if (canMutate && agent.manageable && !isExactMoltbookAgent) ...[
          const SizedBox(height: 22),
          const Divider(),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton.tonalIcon(
                  key: const Key('macos-agent-edit'),
                  onPressed: onEdit,
                  icon: const Icon(Icons.edit_outlined, size: 16),
                  label: const Text('Edit agent'),
                ),
              ),
              const SizedBox(width: 8),
              if (onDelete != null)
                IconButton(
                  key: const Key('macos-agent-delete'),
                  tooltip: 'Delete agent',
                  onPressed: onDelete,
                  color: Theme.of(context).colorScheme.error,
                  icon: const Icon(Icons.delete_outline_rounded),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

class _MoltbookAgentConsole extends StatefulWidget {
  const _MoltbookAgentConsole({
    super.key,
    required this.agent,
    required this.controller,
  });

  final AgentProfile agent;
  final AgentsController controller;

  @override
  State<_MoltbookAgentConsole> createState() => _MoltbookAgentConsoleState();
}

class _MoltbookAgentConsoleState extends State<_MoltbookAgentConsole> {
  final _registrationKey = GlobalKey<FormState>();
  late final _externalName = TextEditingController(
    text: _defaultMoltbookName(widget.agent.name),
  );
  late final _description = TextEditingController(
    text: _defaultMoltbookDescription(widget.agent),
  );
  MoltbookProjection? _projection;
  Object? _error;
  bool _loading = false;
  bool _acting = false;
  bool _disclosureAccepted = false;
  bool _autonomyDisclosureAccepted = false;
  bool _heartbeatEnabled = true;

  @override
  void initState() {
    super.initState();
    if (widget.controller.moltbookAvailable) {
      Future<void>.microtask(_load);
    }
  }

  @override
  void dispose() {
    _externalName.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _load({bool older = false}) async {
    if (_loading || !widget.controller.moltbookAvailable) return;
    final cursor = older ? _projection?.nextCursor : null;
    if (older && cursor == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.controller.loadMoltbook(
        widget.agent.id,
        cursor: cursor,
      );
      if (!mounted) return;
      setState(() {
        if (older && _projection != null) {
          final byId = <String, MoltbookActivity>{
            for (final activity in _projection!.activities)
              activity.id: activity,
            for (final activity in page.activities) activity.id: activity,
          };
          _projection = MoltbookProjection(
            connection: page.connection ?? _projection!.connection,
            activities: byId.values.toList(),
            autonomy: page.autonomy ?? _projection!.autonomy,
            nextCursor: page.nextCursor,
          );
        } else {
          _projection = page;
        }
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _change(Json input) async {
    if (_acting) return;
    if (!widget.controller.canManageMoltbook) {
      setState(
        () => _error = StateError(
          'Moltbook controls are read-only for this account.',
        ),
      );
      return;
    }
    setState(() {
      _acting = true;
      _error = null;
    });
    try {
      await widget.controller.changeMoltbook(widget.agent.id, input);
      final projection = await widget.controller.loadMoltbook(widget.agent.id);
      if (mounted) setState(() => _projection = projection);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _register() async {
    if (!(_registrationKey.currentState?.validate() ?? false) ||
        !_disclosureAccepted) {
      return;
    }
    await _change({
      'action': 'register',
      'externalName': _externalName.text.trim(),
      'description': _description.text.trim(),
      'heartbeatEnabled': _heartbeatEnabled,
      'disclosureAccepted': true,
      'disclosureVersion': moltbookDisclosureVersion,
    });
  }

  Future<void> _enableAutonomy() async {
    if (!_autonomyDisclosureAccepted) return;
    await _change(const {
      'action': 'enable_autonomy',
      'disclosureAccepted': true,
      'disclosureVersion': moltbookAutonomyDisclosureVersion,
    });
    if (mounted) setState(() => _autonomyDisclosureAccepted = false);
  }

  Future<void> _openOfficial(String? value) async {
    final uri = exactMoltbookUri(value);
    if (uri == null) {
      setState(
        () => _error = StateError(
          'Asael refused a link that was not on the official Moltbook host.',
        ),
      );
      return;
    }
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      setState(() => _error = StateError('macOS could not open Moltbook.'));
    }
  }

  @override
  Widget build(BuildContext context) => _InspectorSection(
    title: 'Moltbook presence',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'A separate, observable public identity. Connection controls, autonomous engagement, daily limits, developing interests, and every external receipt remain visible here.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 10),
        if (widget.controller.moltbookAvailable &&
            !widget.controller.canManageMoltbook) ...[
          const _MoltbookNotice(
            icon: Icons.visibility_outlined,
            title: 'Read-only Moltbook access',
            message: 'You can inspect connection health, autonomy, budgets, interests, and receipts. An operator or admin must make changes.',
          ),
          const SizedBox(height: 10),
        ],
        if (!widget.controller.moltbookAvailable)
          const _MoltbookNotice(
            icon: Icons.lock_clock_outlined,
            title: 'Requires native contract v19',
            message: 'Update Asael before connecting this Agent to Moltbook.',
          )
        else if (_projection == null && _loading)
          const Center(
            child: Padding(
              padding: EdgeInsets.all(20),
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          )
        else if (_projection == null && _error != null)
          _MoltbookNotice(
            icon: Icons.cloud_off_outlined,
            title: 'Moltbook is unavailable',
            message: '$_error',
            action: TextButton.icon(
              key: const Key('moltbook-retry'),
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded, size: 16),
              label: const Text('Try again'),
            ),
          )
        else if (_projection?.connection == null)
          _registration(context)
        else
          _connection(context, _projection!.connection!),
      ],
    ),
  );

  Widget _registration(BuildContext context) => Form(
    key: _registrationKey,
    child: MacosPane(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.public_rounded, size: 18),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  'Join Moltbook',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            'Registration creates an external Moltbook Agent identity. Asael stores its credential privately and never displays it here.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const Key('moltbook-external-name'),
            controller: _externalName,
            enabled: !_acting && widget.controller.canManageMoltbook,
            decoration: const InputDecoration(
              labelText: 'Public Agent name',
              helperText: '2–32 letters, numbers, underscores, or hyphens',
            ),
            validator: (value) =>
                RegExp(r'^[A-Za-z0-9_-]{2,32}$').hasMatch(value?.trim() ?? '')
                ? null
                : 'Choose a valid public Agent name.',
          ),
          const SizedBox(height: 9),
          TextFormField(
            key: const Key('moltbook-description'),
            controller: _description,
            enabled: !_acting && widget.controller.canManageMoltbook,
            minLines: 2,
            maxLines: 4,
            maxLength: 1000,
            decoration: const InputDecoration(
              labelText: 'Public description',
              alignLabelWithHint: true,
            ),
            validator: (value) {
              final length = value?.trim().length ?? 0;
              return length >= 2 && length <= 1000
                  ? null
                  : 'Provide 2–1000 characters.';
            },
          ),
          Material(
            color: Colors.transparent,
            child: SwitchListTile.adaptive(
              key: const Key('moltbook-heartbeat-enabled'),
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _heartbeatEnabled,
              onChanged: _acting || !widget.controller.canManageMoltbook
                  ? null
                  : (value) => setState(() => _heartbeatEnabled = value),
              title: const Text('Monitor every four hours'),
              subtitle: const Text(
                'Read-only checks keep claim and connection health current.',
              ),
            ),
          ),
          Material(
            color: Colors.transparent,
            child: CheckboxListTile(
              key: const Key('moltbook-disclosure'),
              contentPadding: EdgeInsets.zero,
              dense: true,
              controlAffinity: ListTileControlAffinity.leading,
              value: _disclosureAccepted,
              onChanged: _acting || !widget.controller.canManageMoltbook
                  ? null
                  : (value) =>
                        setState(() => _disclosureAccepted = value == true),
              title: const Text(
                'I understand Moltbook activity and posts are public, Moltbook terms apply to posted content, and I—as the human owner—remain responsible for this Agent’s actions.',
              ),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              key: const Key('moltbook-register'),
              onPressed:
                  widget.controller.canManageMoltbook &&
                      _disclosureAccepted &&
                      !_acting
                  ? _register
                  : null,
              icon: _acting
                  ? const SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.public_rounded, size: 16),
              label: const Text('Create Moltbook identity'),
            ),
          ),
        ],
      ),
    ),
  );

  Widget _connection(BuildContext context, MoltbookConnection connection) {
    final claimUri = exactMoltbookUri(connection.claimUrl);
    final connectionReady =
        connection.status == 'claimed' &&
        connection.claimState == 'claimed' &&
        connection.credentialConfigured;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (connection.status == 'error') ...[
          const _MoltbookNotice(
            icon: Icons.report_gmailerrorred_rounded,
            title: 'Registration held for provider recovery',
            message: 'Asael cannot prove whether Moltbook created this identity, so it will not retry the registration. Refresh to check the provider state. If it remains unresolved, use Moltbook recovery or support before continuing.',
          ),
          const SizedBox(height: 10),
        ],
        MacosPane(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  _MoltbookHealthDot(health: connection.health),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          connection.externalName.isEmpty
                              ? 'Moltbook Agent'
                              : '@${connection.externalName}',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        Text(
                          '${_label(connection.health)} · ${_label(connection.status)}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  if (_loading || _acting)
                    const SizedBox.square(
                      dimension: 15,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                ],
              ),
              const SizedBox(height: 10),
              _MetaLine(label: 'Claim', value: _label(connection.claimState)),
              _MetaLine(
                label: 'Credential',
                value: connection.credentialConfigured
                    ? 'Stored privately'
                    : 'Unavailable',
              ),
              _MetaLine(
                label: 'Monitor',
                value: connection.heartbeatEnabled
                    ? 'Every four hours'
                    : 'Manual only',
              ),
              if (connection.lastHeartbeatAt != null)
                _MetaLine(
                  label: 'Last check',
                  value: _formatMoltbookTime(connection.lastHeartbeatAt!),
                ),
              if (connection.nextHeartbeatAt != null &&
                  connection.heartbeatEnabled)
                _MetaLine(
                  label: 'Next check',
                  value: _formatMoltbookTime(connection.nextHeartbeatAt!),
                ),
              if (connection.rateLimitRemaining != null)
                _MetaLine(
                  label: 'API budget',
                  value: connection.rateLimitLimit == null
                      ? '${connection.rateLimitRemaining} remaining'
                      : '${connection.rateLimitRemaining} of ${connection.rateLimitLimit} remaining',
                ),
              if (connection.consecutiveFailures > 0 ||
                  connection.lastErrorCode != null)
                _MetaLine(
                  label: 'Attention',
                  value:
                      '${connection.consecutiveFailures} consecutive failure${connection.consecutiveFailures == 1 ? '' : 's'}${connection.lastErrorCode == null ? '' : ' · ${_label(connection.lastErrorCode!)}'}',
                ),
            ],
          ),
        ),
        if (connection.claimState == 'pending') ...[
          const SizedBox(height: 10),
          Container(
            key: const Key('moltbook-claim-card'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.secondaryContainer,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Theme.of(context).colorScheme.outline),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Claim this Agent',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 4),
                const Text(
                  'Moltbook requires its official claim flow before this identity can participate.',
                ),
                if (connection.verificationCode != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Verification code',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  SelectableText(
                    connection.verificationCode!,
                    key: const Key('moltbook-verification-code'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ],
                const SizedBox(height: 10),
                FilledButton.tonalIcon(
                  key: const Key('moltbook-open-claim'),
                  onPressed:
                      claimUri == null || !widget.controller.canManageMoltbook
                      ? null
                      : () => _openOfficial(connection.claimUrl),
                  icon: const Icon(Icons.open_in_new_rounded, size: 16),
                  label: const Text('Open official claim page'),
                ),
                if (claimUri == null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      'No verified official claim link is available. Refresh the connection.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
              ],
            ),
          ),
        ],
        if ((connection.status == 'claimed' || connection.status == 'paused') &&
            connection.claimState == 'claimed') ...[
          const SizedBox(height: 12),
          _autonomy(
            context,
            _projection!.autonomy,
            connectionReady: connectionReady,
          ),
        ],
        const SizedBox(height: 10),
        Text('Connection', style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 6),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: [
            if (connection.status == 'paused')
              FilledButton.tonalIcon(
                key: const Key('moltbook-resume'),
                onPressed: _acting || !widget.controller.canManageMoltbook
                    ? null
                    : () => _change(const {'action': 'resume'}),
                icon: const Icon(Icons.play_arrow_rounded, size: 16),
                label: const Text('Resume'),
              )
            else if (connection.status != 'revoked') ...[
              OutlinedButton.icon(
                key: const Key('moltbook-refresh'),
                onPressed: _acting || !widget.controller.canManageMoltbook
                    ? null
                    : () => _change(const {'action': 'refresh'}),
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: Text(
                  connection.claimState == 'pending'
                      ? 'Refresh claim'
                      : 'Refresh',
                ),
              ),
              TextButton.icon(
                key: const Key('moltbook-pause'),
                onPressed: _acting || !widget.controller.canManageMoltbook
                    ? null
                    : () => _change(const {'action': 'pause'}),
                icon: const Icon(Icons.pause_rounded, size: 16),
                label: const Text('Pause'),
              ),
            ],
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          _MoltbookNotice(
            icon: Icons.warning_amber_rounded,
            title: 'Action needs attention',
            message: '$_error',
          ),
        ],
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: Text(
                'Recent activity',
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            IconButton(
              key: const Key('moltbook-activity-refresh'),
              tooltip: 'Refresh Moltbook activity',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded, size: 16),
            ),
          ],
        ),
        if (_projection!.activities.isEmpty)
          Text(
            'No Moltbook activity has been recorded yet.',
            style: Theme.of(context).textTheme.bodySmall,
          )
        else
          ..._projection!.activities.map(_activity),
        if (_projection!.nextCursor != null) ...[
          const SizedBox(height: 8),
          TextButton(
            key: const Key('moltbook-load-older'),
            onPressed: _loading ? null : () => _load(older: true),
            child: const Text('Load older activity'),
          ),
        ],
      ],
    );
  }

  Widget _autonomy(
    BuildContext context,
    MoltbookAutonomy? autonomy, {
    required bool connectionReady,
  }) {
    final status = autonomy?.status ?? 'not_enabled';
    final canEnable = autonomy == null || status == 'revoked';
    final statusCanRun = status == 'enabled' || status == 'running';
    final blocked =
        autonomy != null &&
        status != 'revoked' &&
        (!connectionReady || !autonomy.executable);
    final showBlockedNotice = !connectionReady || blocked;
    final active = statusCanRun && !blocked;
    final displayedStatus = statusCanRun && blocked ? 'blocked' : status;
    final canManage = widget.controller.canManageMoltbook;
    final mac = MacosThemeColors.of(context);
    return MacosPane(
      key: const Key('moltbook-autonomy-console'),
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 13, 14, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 34,
                  height: 34,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: active
                        ? mac.positive.withValues(alpha: .12)
                        : mac.hover,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Icon(
                    active ? Icons.auto_awesome_rounded : Icons.shield_outlined,
                    size: 18,
                    color: active ? mac.positive : null,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        blocked && statusCanRun
                            ? 'Autonomous engagement is blocked'
                            : active
                            ? 'Autonomous engagement is active'
                            : status == 'paused'
                            ? 'Autonomous engagement is paused'
                            : 'Autonomous engagement is off',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'This public Agent can independently read, post, reply, vote, follow, and join communities. Each check-in permits at most one public action, within strict daily budgets.',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                _MoltbookAutonomyStatus(status: displayedStatus),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
            child: Text(
              'DMs, verification, deletion, moderation, private Asael memory or files, and control of this Mac remain excluded.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
          if (showBlockedNotice) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: _MoltbookNotice(
                key: const Key('moltbook-autonomy-blocked'),
                icon: Icons.block_rounded,
                title: 'Autonomy cannot run',
                message: _moltbookBlockedMessage(
                  connectionReady
                      ? autonomy?.blockedReason
                      : 'connection_unavailable',
                ),
              ),
            ),
          ],
          Divider(height: 1, color: mac.divider),
          if (canEnable) ...[
            Material(
              color: Colors.transparent,
              child: CheckboxListTile(
                key: const Key('moltbook-autonomy-disclosure'),
                contentPadding: const EdgeInsets.fromLTRB(10, 5, 10, 0),
                controlAffinity: ListTileControlAffinity.leading,
                value: _autonomyDisclosureAccepted,
                onChanged: _acting || !canManage || !connectionReady
                    ? null
                    : (value) => setState(
                        () => _autonomyDisclosureAccepted = value == true,
                      ),
                title: const Text(
                  'I authorize this Agent to take these public actions without asking each time. I can pause or revoke this authority here at any time.',
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 13),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  key: const Key('moltbook-enable-autonomy'),
                  onPressed:
                      canManage &&
                          connectionReady &&
                          _autonomyDisclosureAccepted &&
                          !_acting
                      ? _enableAutonomy
                      : null,
                  icon: _acting
                      ? const SizedBox.square(
                          dimension: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.shield_rounded, size: 16),
                  label: Text(
                    status == 'revoked'
                        ? 'Grant new authority'
                        : 'Enable autonomy',
                  ),
                ),
              ),
            ),
          ] else ...[
            Padding(
              padding: const EdgeInsets.all(12),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (status == 'paused')
                    FilledButton.icon(
                      key: const Key('moltbook-resume-autonomy'),
                      onPressed:
                          _acting || !canManage || !connectionReady || blocked
                          ? null
                          : () => _change(const {'action': 'resume_autonomy'}),
                      icon: const Icon(Icons.play_arrow_rounded, size: 17),
                      label: const Text('Resume autonomy'),
                    )
                  else
                    FilledButton.icon(
                      key: const Key('moltbook-pause-autonomy'),
                      style: FilledButton.styleFrom(
                        backgroundColor: Theme.of(context).colorScheme.error,
                        foregroundColor: Theme.of(context).colorScheme.onError,
                      ),
                      onPressed: _acting || !canManage
                          ? null
                          : () => _change(const {'action': 'pause_autonomy'}),
                      icon: const Icon(Icons.pause_rounded, size: 17),
                      label: const Text('Pause now'),
                    ),
                  FilledButton.tonalIcon(
                    key: const Key('moltbook-run-autonomy-once'),
                    onPressed:
                        _acting ||
                            !canManage ||
                            !connectionReady ||
                            status != 'enabled' ||
                            !autonomy.executable
                        ? null
                        : () => _change(const {'action': 'run_autonomy_once'}),
                    icon: const Icon(Icons.bolt_rounded, size: 17),
                    label: const Text('Run once'),
                  ),
                  OutlinedButton.icon(
                    key: const Key('moltbook-revoke-autonomy'),
                    onPressed: _acting || !canManage
                        ? null
                        : () => _change(const {'action': 'revoke_autonomy'}),
                    icon: const Icon(Icons.gpp_bad_outlined, size: 17),
                    label: const Text('Revoke authority'),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: mac.divider),
            Padding(
              padding: const EdgeInsets.all(12),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final itemWidth = constraints.maxWidth >= 720
                      ? (constraints.maxWidth - 24) / 4
                      : constraints.maxWidth >= 420
                      ? (constraints.maxWidth - 8) / 2
                      : constraints.maxWidth;
                  return Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      SizedBox(
                        width: itemWidth,
                        child: _MoltbookAutonomyMetric(
                          icon: Icons.timer_outlined,
                          label: 'Cadence',
                          value: _formatMoltbookCadence(autonomy.cadenceMs),
                        ),
                      ),
                      SizedBox(
                        width: itemWidth,
                        child: _MoltbookAutonomyMetric(
                          icon: Icons.history_rounded,
                          label: 'Last cycle',
                          value: autonomy.lastCycleAt == null
                              ? 'Not run yet'
                              : _formatMoltbookTime(autonomy.lastCycleAt!),
                        ),
                      ),
                      SizedBox(
                        width: itemWidth,
                        child: _MoltbookAutonomyMetric(
                          icon: Icons.schedule_rounded,
                          label: 'Next cycle',
                          value: autonomy.nextCycleAt == null
                              ? 'Not scheduled'
                              : _formatMoltbookTime(autonomy.nextCycleAt!),
                        ),
                      ),
                      SizedBox(
                        width: itemWidth,
                        child: _MoltbookAutonomyMetric(
                          icon: Icons.receipt_long_outlined,
                          label: 'Last run',
                          value: _shortMoltbookId(autonomy.lastRunId),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
            Divider(height: 1, color: mac.divider),
            LayoutBuilder(
              builder: (context, constraints) {
                final wide = constraints.maxWidth >= 700;
                final budgets = _MoltbookBudgetList(
                  budgets: autonomy.budgets,
                  resetAt: autonomy.budgetResetAt,
                );
                final interests = _MoltbookInterestList(
                  interests: autonomy.interests,
                );
                if (!wide) {
                  return Column(
                    children: [
                      budgets,
                      Divider(height: 1, color: mac.divider),
                      interests,
                    ],
                  );
                }
                return IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(flex: 6, child: budgets),
                      VerticalDivider(width: 1, color: mac.divider),
                      Expanded(flex: 4, child: interests),
                    ],
                  ),
                );
              },
            ),
            if (autonomy.cycles.isNotEmpty) ...[
              Divider(height: 1, color: mac.divider),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 5),
                child: Row(
                  children: [
                    const Icon(Icons.receipt_long_outlined, size: 16),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        'Recent cycle receipts',
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                    ),
                    Text(
                      'No private reasoning',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              ...autonomy.cycles.map(
                (cycle) => _MoltbookCycleRow(cycle: cycle),
              ),
              const SizedBox(height: 7),
            ],
          ],
        ],
      ),
    );
  }

  Widget _activity(MoltbookActivity activity) {
    final uri = exactMoltbookUri(activity.externalUrl);
    return Padding(
      key: Key('moltbook-activity-${activity.id}'),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Icon(
              _moltbookActivityIcon(activity.status),
              size: 15,
              color: _moltbookActivityColor(context, activity.status),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(activity.summary),
                const SizedBox(height: 2),
                Text(
                  '${_label(activity.kind)} · ${_formatMoltbookTime(activity.createdAt)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          if (uri != null)
            IconButton(
              key: Key('moltbook-open-activity-${activity.id}'),
              tooltip: 'Open on Moltbook',
              onPressed: () => _openOfficial(activity.externalUrl),
              icon: const Icon(Icons.open_in_new_rounded, size: 15),
            ),
        ],
      ),
    );
  }
}

class _MoltbookAutonomyStatus extends StatelessWidget {
  const _MoltbookAutonomyStatus({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final color = switch (status) {
      'enabled' || 'running' => mac.positive,
      'blocked' => Theme.of(context).colorScheme.error,
      'paused' => Theme.of(context).colorScheme.tertiary,
      'revoked' => Theme.of(context).colorScheme.error,
      _ => Theme.of(context).colorScheme.outline,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .09),
        border: Border.all(color: color.withValues(alpha: .34)),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(shape: BoxShape.circle, color: color),
          ),
          const SizedBox(width: 6),
          Text(
            _label(status),
            style: Theme.of(context).textTheme.labelMedium
                ?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}

class _MoltbookAutonomyMetric extends StatelessWidget {
  const _MoltbookAutonomyMetric({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label, value;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Icon(
          icon,
          size: 16,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
      const SizedBox(width: 7),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: Theme.of(context).textTheme.labelSmall),
            const SizedBox(height: 1),
            Tooltip(
              message: value,
              child: Text(
                value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodyMedium
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

class _MoltbookBudgetList extends StatelessWidget {
  const _MoltbookBudgetList({required this.budgets, this.resetAt});

  final List<MoltbookActionBudget> budgets;
  final String? resetAt;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(14),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.speed_rounded, size: 16),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'Daily action budget',
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            Tooltip(
              message: resetAt == null
                  ? 'Actions are counted over the previous 24 hours.'
                  : 'The oldest counted action leaves the window at ${_formatMoltbookTime(resetAt!)}.',
              child: Text(
                'Rolling 24h',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ...budgets.map((budget) => _MoltbookBudgetRow(budget: budget)),
      ],
    ),
  );
}

class _MoltbookBudgetRow extends StatelessWidget {
  const _MoltbookBudgetRow({required this.budget});

  final MoltbookActionBudget budget;

  @override
  Widget build(BuildContext context) {
    final progress = budget.limit <= 0
        ? 0.0
        : (budget.used / budget.limit).clamp(0, 1).toDouble();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          SizedBox(
            width: 106,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  budget.label,
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                Text(
                  '${budget.remaining} remaining',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          Expanded(
            child: Semantics(
              label: '${budget.label} used',
              value: '${budget.used} of ${budget.limit}',
              child: ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(
                  value: progress,
                  minHeight: 5,
                  backgroundColor: MacosThemeColors.of(context).hover,
                ),
              ),
            ),
          ),
          const SizedBox(width: 9),
          SizedBox(
            width: 38,
            child: Text(
              '${budget.used}/${budget.limit}',
              textAlign: TextAlign.end,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class _MoltbookInterestList extends StatelessWidget {
  const _MoltbookInterestList({required this.interests});

  final List<MoltbookInterest> interests;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(14),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.auto_awesome_rounded, size: 16),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'Developing interests',
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            Text(
              'Evidence-backed',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (interests.isEmpty)
          Text(
            'Interests appear after an evidence-backed reading cycle.',
            style: Theme.of(context).textTheme.bodySmall,
          )
        else
          ...interests.map(
            (interest) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          interest.topic,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelMedium,
                        ),
                        Text(
                          '${interest.evidenceCount} evidence signal${interest.evidenceCount == 1 ? '' : 's'} · ${(interest.confidence * 100).round()}% confidence',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    width: 32,
                    height: 32,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: Theme.of(context).colorScheme.primary
                            .withValues(alpha: .35),
                      ),
                    ),
                    child: Tooltip(
                      message:
                          '${(interest.confidence * 100).round()}% confidence',
                      child: Text(
                        '${(interest.score * 100).round()}',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    ),
  );
}

class _MoltbookCycleRow extends StatelessWidget {
  const _MoltbookCycleRow({required this.cycle});

  final MoltbookCycleReceipt cycle;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final color = switch (cycle.status) {
      'succeeded' => mac.positive,
      'failed' => Theme.of(context).colorScheme.error,
      _ => Theme.of(context).colorScheme.tertiary,
    };
    return Padding(
      key: Key('moltbook-cycle-${cycle.id}'),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Row(
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(shape: BoxShape.circle, color: color),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _label(cycle.status),
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                Text(
                  '${_label(cycle.trigger ?? 'scheduled')} · ${_formatMoltbookTime(cycle.completedAt ?? cycle.createdAt ?? '')}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          Tooltip(
            message: cycle.runId ?? cycle.id,
            child: Text(
              _shortMoltbookId(cycle.runId ?? cycle.id),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class _MoltbookNotice extends StatelessWidget {
  const _MoltbookNotice({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title, message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: mac.hover,
        border: Border.all(color: mac.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 17),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 2),
                Text(message, style: Theme.of(context).textTheme.bodySmall),
                if (action != null) ...[const SizedBox(height: 5), action!],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String _moltbookBlockedMessage(String? reason) => switch (reason) {
  'connection_unavailable' => 'The Moltbook connection is paused, unclaimed, or missing its private credential. Restore the connection before resuming autonomy.',
  'authority_unavailable' => 'The standing authority no longer matches the active Agent, owner, policy, or tool boundary. Grant fresh authority before it can run.',
  _ => 'The current execution boundary could not be verified. Review the connection and authority before it can run.',
};

class _MoltbookHealthDot extends StatelessWidget {
  const _MoltbookHealthDot({required this.health});

  final String health;

  @override
  Widget build(BuildContext context) => Container(
    width: 10,
    height: 10,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: switch (health) {
        'healthy' => MacosThemeColors.of(context).positive,
        'pending' => Theme.of(context).colorScheme.secondary,
        'error' || 'revoked' => Theme.of(context).colorScheme.error,
        _ => Theme.of(context).colorScheme.outline,
      },
    ),
  );
}

String _defaultMoltbookName(String value) {
  var name = value.trim().replaceAll(RegExp(r'[^A-Za-z0-9_-]+'), '_');
  if (name.length > 32) name = name.substring(0, 32);
  if (name.length < 2) name = '${name.isEmpty ? 'Asael' : name}_Agent';
  return name;
}

String _defaultMoltbookDescription(AgentProfile agent) {
  final value = agent.description.trim().length >= 2
      ? agent.description.trim()
      : '${agent.name} is an Asael Agent.';
  return value.length <= 1000 ? value : value.substring(0, 1000);
}

String _formatMoltbookTime(String value) {
  final parsed = DateTime.tryParse(value)?.toLocal();
  if (parsed == null) return 'Time unavailable';
  String two(int number) => number.toString().padLeft(2, '0');
  return '${parsed.year}-${two(parsed.month)}-${two(parsed.day)} '
      '${two(parsed.hour)}:${two(parsed.minute)}';
}

String _formatMoltbookCadence(int milliseconds) {
  final hours = (milliseconds / Duration.millisecondsPerHour).round().clamp(
    1,
    24,
  );
  return 'Every ${hours}h';
}

String _shortMoltbookId(String? value) {
  if (value == null || value.isEmpty) return 'None yet';
  if (value.length <= 16) return value;
  return '${value.substring(0, 8)}…${value.substring(value.length - 5)}';
}

IconData _moltbookActivityIcon(String status) => switch (status) {
  'published' => Icons.public_rounded,
  'succeeded' => Icons.check_circle_outline_rounded,
  'pending_verification' => Icons.pending_actions_outlined,
  'uncertain' => Icons.warning_amber_rounded,
  _ => Icons.error_outline_rounded,
};

Color _moltbookActivityColor(BuildContext context, String status) =>
    switch (status) {
      'published' || 'succeeded' => MacosThemeColors.of(context).positive,
      'pending_verification' ||
      'uncertain' => Theme.of(context).colorScheme.secondary,
      _ => Theme.of(context).colorScheme.error,
    };

class _SkillDetail extends StatelessWidget {
  const _SkillDetail({
    required this.skill,
    required this.ledger,
    required this.canMutate,
    required this.onEdit,
    required this.onDelete,
  });

  final AgentSkill skill;
  final AgentLedger? ledger;
  final bool canMutate;
  final VoidCallback? onEdit, onDelete;

  @override
  Widget build(BuildContext context) {
    final assigned = (ledger?.agents ?? const <AgentProfile>[])
        .where((agent) => agent.skillIds.contains(skill.id))
        .toList();
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                skill.name,
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            if (skill.builtIn) ...[
              const _SmallBadge(label: 'Built-in'),
              const SizedBox(width: 7),
            ],
            _StatusIndicator(status: skill.status),
          ],
        ),
        const SizedBox(height: 5),
        Text(
          _label(skill.category),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Purpose',
          child: Text(
            skill.description.isEmpty
                ? 'No description is configured.'
                : skill.description,
          ),
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Instructions',
          child: SelectableText(
            skill.instructions.isEmpty
                ? 'No skill instructions are configured.'
                : skill.instructions,
          ),
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Available to (${assigned.length})',
          child: assigned.isEmpty
              ? Text(
                  'Not assigned to an agent.',
                  style: Theme.of(context).textTheme.bodySmall,
                )
              : Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: assigned
                      .map((agent) => Chip(label: Text(agent.name)))
                      .toList(),
                ),
        ),
        if (skill.toolIds.isNotEmpty) ...[
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Tools (${skill.toolIds.length})',
            child: SelectableText(skill.toolIds.join('\n')),
          ),
        ],
        if (skill.tags.isNotEmpty) ...[
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Tags',
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: skill.tags
                  .map((tag) => Chip(label: Text(tag)))
                  .toList(),
            ),
          ),
        ],
        if (canMutate && skill.manageable) ...[
          const SizedBox(height: 22),
          const Divider(),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton.tonalIcon(
                  key: const Key('macos-skill-edit'),
                  onPressed: onEdit,
                  icon: const Icon(Icons.edit_outlined, size: 16),
                  label: const Text('Edit skill'),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                key: const Key('macos-skill-delete'),
                tooltip: 'Delete skill',
                onPressed: onDelete,
                color: Theme.of(context).colorScheme.error,
                icon: const Icon(Icons.delete_outline_rounded),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _PerformanceDetail extends StatelessWidget {
  const _PerformanceDetail({required this.performance});

  final AgentPerformance performance;

  @override
  Widget build(BuildContext context) {
    final rate = _normalizedRate(performance.successRate);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(performance.name, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 5),
        Text('Observed outcomes', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 22),
        Text(
          '${(rate * 100).round()}%',
          style: Theme.of(context).textTheme.headlineLarge,
        ),
        Text('successful runs', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        LinearProgressIndicator(value: rate, minHeight: 6),
        const SizedBox(height: 22),
        Row(
          children: [
            Expanded(
              child: _CompactStat(value: '${performance.runs}', label: 'runs'),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _CompactStat(
                value: _latency(performance.averageLatencyMs),
                label: 'average',
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        _CompactStat(
          value: '${performance.memoriesFormed}',
          label: 'durable memories formed',
        ),
        const SizedBox(height: 18),
        Text(
          'Outcome records are observational. Use them to compare reliability '
          'and latency before changing an agent policy.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _OutcomeSummary extends StatelessWidget {
  const _OutcomeSummary({required this.performance});

  final AgentPerformance performance;

  @override
  Widget build(BuildContext context) {
    final rate = _normalizedRate(performance.successRate);
    return _InspectorSection(
      title: 'Observed outcomes',
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: LinearProgressIndicator(value: rate, minHeight: 5),
              ),
              const SizedBox(width: 10),
              Text(
                '${(rate * 100).round()}%',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ],
          ),
          const SizedBox(height: 9),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              '${performance.runs} runs · ${_latency(performance.averageLatencyMs)} average · '
              '${performance.memoriesFormed} memories',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class _InspectorPlaceholder extends StatelessWidget {
  const _InspectorPlaceholder({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title, message;

  @override
  Widget build(BuildContext context) =>
      MacosEmptyState(icon: icon, title: title, message: message);
}

class _InspectorSection extends StatelessWidget {
  const _InspectorSection({required this.title, this.child, this.children})
    : assert((child == null) != (children == null));

  final String title;
  final Widget? child;
  final List<Widget>? children;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 7),
      DefaultTextStyle.merge(
        style: Theme.of(context).textTheme.bodyMedium,
        child:
            child ??
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: children!,
            ),
      ),
    ],
  );
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.label, required this.value});

  final String label, value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 7),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 86,
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        Expanded(child: SelectableText(value)),
      ],
    ),
  );
}

class _CompactStat extends StatelessWidget {
  const _CompactStat({required this.value, required this.label});

  final String value, label;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: mac.hover,
        border: Border.all(color: mac.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: Theme.of(context).textTheme.titleMedium),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _AgentGlyph extends StatelessWidget {
  const _AgentGlyph({required this.agent, required this.size});

  final AgentProfile agent;
  final double size;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: mac.selection,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Text(
        agent.name.trim().isEmpty ? '?' : agent.name.trim()[0].toUpperCase(),
        style: TextStyle(
          color: Theme.of(context).colorScheme.primary,
          fontWeight: FontWeight.w700,
          fontSize: size * .38,
        ),
      ),
    );
  }
}

class _StatusIndicator extends StatelessWidget {
  const _StatusIndicator({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final active = const {
      'ready',
      'active',
      'running',
      'learning',
    }.contains(status.toLowerCase());
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(
            color: active
                ? mac.positive
                : Theme.of(context).colorScheme.outline,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 6),
        Text(_label(status), style: Theme.of(context).textTheme.labelMedium),
      ],
    );
  }
}

class _SmallBadge extends StatelessWidget {
  const _SmallBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: mac.hover,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: mac.divider),
      ),
      child: Text(label, style: Theme.of(context).textTheme.labelSmall),
    );
  }
}

class _MacosAgentDialog extends StatefulWidget {
  const _MacosAgentDialog({required this.skills, this.agent});

  final List<AgentSkill> skills;
  final AgentProfile? agent;

  @override
  State<_MacosAgentDialog> createState() => _MacosAgentDialogState();
}

class _MacosAgentDialogState extends State<_MacosAgentDialog> {
  final _formKey = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.agent?.name);
  late final _role = TextEditingController(text: widget.agent?.role);
  late final _description = TextEditingController(
    text: widget.agent?.description,
  );
  late final _instructions = TextEditingController(
    text: widget.agent?.instructions,
  );
  late String _modelPolicy =
      _agentModelPolicies.contains(widget.agent?.modelPolicy)
      ? widget.agent!.modelPolicy
      : 'auto';
  late final _toolIds = TextEditingController(
    text: widget.agent?.toolIds.join(', '),
  );
  late final List<AgentSkill> _selectableSkills = widget.skills
      .where((skill) => skill.selectable)
      .toList(growable: false);
  late final Set<String> _selectedSkills = filterSelectableSkillIds(
    _selectableSkills,
    widget.agent?.skillIds ?? const [],
  );
  late String _status = widget.agent?.status ?? 'ready';
  late String _autonomy = widget.agent?.autonomy ?? 'assist';
  late String _approval = widget.agent?.approvalPolicy ?? 'risk_based';
  late String _memory = widget.agent?.memoryScope ?? 'all';
  late final String _accent = widget.agent?.accent ?? 'emerald';

  @override
  void dispose() {
    _name.dispose();
    _role.dispose();
    _description.dispose();
    _instructions.dispose();
    _toolIds.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.agent == null ? 'New agent' : 'Edit agent'),
    content: SizedBox(
      width: 680,
      height: 620,
      child: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: TextFormField(
                      key: const Key('macos-agent-name'),
                      controller: _name,
                      autofocus: true,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Name'),
                      validator: _requiredField,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: TextFormField(
                      key: const Key('macos-agent-role'),
                      controller: _role,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Role'),
                      validator: _requiredField,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextFormField(
                controller: _description,
                minLines: 2,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Purpose and responsibility',
                  alignLabelWithHint: true,
                ),
                validator: (value) => value == null || value.trim().length < 2
                    ? 'Provide a short purpose of at least 2 characters.'
                    : null,
              ),
              const SizedBox(height: 10),
              TextFormField(
                key: const Key('macos-agent-instructions'),
                controller: _instructions,
                minLines: 5,
                maxLines: 8,
                decoration: const InputDecoration(
                  labelText: 'Operating instructions',
                  alignLabelWithHint: true,
                ),
                validator: (value) => value == null || value.trim().length < 10
                    ? 'Provide at least 10 characters of operating guidance.'
                    : null,
              ),
              const SizedBox(height: 16),
              Text('Policy', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: _dropdown(
                      label: 'Model policy',
                      value: _modelPolicy,
                      values: _agentModelPolicies,
                      onChanged: (value) =>
                          setState(() => _modelPolicy = value),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _dropdown(
                      label: 'Autonomy',
                      value: _autonomy,
                      values: const ['assist', 'governed', 'execute'],
                      onChanged: (value) => setState(() => _autonomy = value),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: _dropdown(
                      label: 'Approvals',
                      value: _approval,
                      values: const ['always', 'risk_based', 'read_only'],
                      onChanged: (value) => setState(() => _approval = value),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _dropdown(
                      label: 'Memory scope',
                      value: _memory,
                      values: const ['session', 'project', 'all'],
                      onChanged: (value) => setState(() => _memory = value),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _dropdown(
                      label: 'Status',
                      value: _status,
                      values: const ['ready', 'learning', 'paused'],
                      onChanged: (value) => setState(() => _status = value),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Text(
                'Capabilities',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _toolIds,
                decoration: const InputDecoration(
                  labelText: 'Direct tool IDs, comma separated',
                ),
              ),
              const SizedBox(height: 10),
              if (_selectableSkills.isEmpty)
                Text(
                  'No assignable skills are available.',
                  style: Theme.of(context).textTheme.bodySmall,
                )
              else
                MacosPane(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            '${_selectedSkills.length}/$maxAssignedAgentSkills selected · every assigned Skill stays in the Agent context',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ),
                      ),
                      for (final skill in _selectableSkills)
                        CheckboxListTile(
                          dense: true,
                          value: _selectedSkills.contains(skill.id),
                          title: Text(skill.name),
                          subtitle: skill.description.isEmpty
                              ? null
                              : Text(
                                  skill.description,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                          onChanged:
                              canSelectAgentSkill(_selectedSkills, skill.id)
                              ? (value) => setState(() {
                                  value == true
                                      ? _selectedSkills.add(skill.id)
                                      : _selectedSkills.remove(skill.id);
                                })
                              : null,
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        key: const Key('macos-agent-save'),
        onPressed: _selectedSkills.length > maxAssignedAgentSkills
            ? null
            : _save,
        child: const Text('Save agent'),
      ),
    ],
  );

  Widget _dropdown({
    required String label,
    required String value,
    required List<String> values,
    required ValueChanged<String> onChanged,
  }) => DropdownButtonFormField<String>(
    initialValue: value,
    decoration: InputDecoration(labelText: label),
    items: values
        .map((item) => DropdownMenuItem(value: item, child: Text(_label(item))))
        .toList(),
    onChanged: (item) {
      if (item != null) onChanged(item);
    },
  );

  void _save() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    Navigator.pop(context, <String, dynamic>{
      'name': _name.text.trim(),
      'role': _role.text.trim(),
      'description': _description.text.trim(),
      'instructions': _instructions.text.trim(),
      'status': _status,
      'accent': _accent,
      'modelPolicy': _modelPolicy,
      'autonomy': _autonomy,
      'approvalPolicy': _approval,
      'memoryScope': _memory,
      'skillIds': _selectedSkills.toList(),
      'toolIds': _split(_toolIds.text),
    });
  }
}

class _MacosSkillDialog extends StatefulWidget {
  const _MacosSkillDialog({this.skill});

  final AgentSkill? skill;

  @override
  State<_MacosSkillDialog> createState() => _MacosSkillDialogState();
}

class _MacosSkillDialogState extends State<_MacosSkillDialog> {
  final _formKey = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.skill?.name);
  late final _description = TextEditingController(
    text: widget.skill?.description,
  );
  late final _instructions = TextEditingController(
    text: widget.skill?.instructions,
  );
  late final _tools = TextEditingController(
    text: widget.skill?.toolIds.join(', '),
  );
  late final _tags = TextEditingController(text: widget.skill?.tags.join(', '));
  late String _category = widget.skill?.category ?? 'personal';
  late String _status = widget.skill?.status ?? 'active';

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _instructions.dispose();
    _tools.dispose();
    _tags.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.skill == null ? 'New skill' : 'Edit skill'),
    content: SizedBox(
      width: 620,
      child: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            children: [
              TextFormField(
                key: const Key('macos-skill-name'),
                controller: _name,
                autofocus: true,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: 'Name'),
                validator: _requiredField,
              ),
              const SizedBox(height: 10),
              TextFormField(
                controller: _description,
                minLines: 2,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Purpose',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 10),
              TextFormField(
                key: const Key('macos-skill-instructions'),
                controller: _instructions,
                minLines: 5,
                maxLines: 8,
                decoration: const InputDecoration(
                  labelText: 'Instructions',
                  alignLabelWithHint: true,
                ),
                validator: (value) => value == null || value.trim().length < 10
                    ? 'Provide at least 10 characters of guidance.'
                    : null,
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: _category,
                      decoration: const InputDecoration(labelText: 'Category'),
                      items:
                          const [
                                'research',
                                'creation',
                                'analysis',
                                'memory',
                                'automation',
                                'personal',
                              ]
                              .map(
                                (value) => DropdownMenuItem(
                                  value: value,
                                  child: Text(_label(value)),
                                ),
                              )
                              .toList(),
                      onChanged: (value) {
                        if (value != null) setState(() => _category = value);
                      },
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: _status,
                      decoration: const InputDecoration(labelText: 'Status'),
                      items: const ['active', 'paused', 'disabled']
                          .map(
                            (value) => DropdownMenuItem(
                              value: value,
                              child: Text(_label(value)),
                            ),
                          )
                          .toList(),
                      onChanged: (value) {
                        if (value != null) setState(() => _status = value);
                      },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextFormField(
                controller: _tools,
                decoration: const InputDecoration(
                  labelText: 'Tool IDs, comma separated',
                ),
              ),
              const SizedBox(height: 10),
              TextFormField(
                controller: _tags,
                decoration: const InputDecoration(
                  labelText: 'Tags, comma separated',
                ),
              ),
            ],
          ),
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        key: const Key('macos-skill-save'),
        onPressed: _save,
        child: const Text('Save skill'),
      ),
    ],
  );

  void _save() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    Navigator.pop(context, <String, dynamic>{
      'name': _name.text.trim(),
      'description': _description.text.trim(),
      'instructions': _instructions.text.trim(),
      'category': _category,
      'status': _status,
      'toolIds': _split(_tools.text),
      'tags': _split(_tags.text),
      'knowledgeTags': <String>[],
    });
  }
}

String? _requiredField(String? value) =>
    value == null || value.trim().isEmpty ? 'This field is required.' : null;

List<String> _split(String value) => value
    .split(',')
    .map((item) => item.trim())
    .where((item) => item.isNotEmpty)
    .toList();

AgentCouncilExecution? _findExecution(
  List<AgentCouncilExecution> values,
  String? id,
) {
  if (values.isEmpty) return null;
  if (id != null) {
    for (final value in values) {
      if (value.parentExecutionId == id) return value;
    }
  }
  return values.first;
}

AgentCouncilMember? _findCouncilMember(
  AgentCouncilExecution? execution,
  String? taskId,
) {
  if (execution == null || execution.members.isEmpty) return null;
  if (taskId != null) {
    for (final member in execution.members) {
      if (member.taskId == taskId) return member;
    }
  }
  return execution.members.first;
}

String _councilStatusGroup(String status) => switch (status) {
  'queued' || 'running' || 'resuming' => 'active',
  'waiting' || 'waiting_clarification' || 'waiting_approval' => 'waiting',
  'completed' || 'result_accepted' || 'accepted' => 'completed',
  'failed' || 'rejected' || 'expired' => 'failed',
  'canceled' => 'canceled',
  _ => 'unavailable',
};

String _councilStatusLabel(String status) => switch (status) {
  'waiting_clarification' => 'Needs clarification',
  'waiting_approval' => 'Needs approval',
  'completed_proposed' => 'Proposed result',
  'result_accepted' => 'Accepted result',
  'not_recorded' => 'Not recorded',
  'receipt_only' => 'Receipt only',
  'historical_unavailable' => 'Historical evidence unavailable',
  _ => _label(status),
};

Color _councilStateColor(BuildContext context, String state) {
  final scheme = Theme.of(context).colorScheme;
  final mac = MacosThemeColors.of(context);
  if (const {'running', 'working', 'resuming'}.contains(state)) {
    return scheme.primary;
  }
  if (const {'completed', 'accepted', 'result_accepted'}.contains(state)) {
    return mac.positive;
  }
  if (const {
    'queued',
    'proposed',
    'pending',
    'waiting',
    'waiting_clarification',
    'waiting_approval',
    'completed_proposed',
    'challenged',
  }.contains(state)) {
    return mac.warning;
  }
  if (const {'failed', 'rejected', 'expired'}.contains(state)) {
    return scheme.error;
  }
  return scheme.onSurfaceVariant;
}

String _relativeTime(String value) {
  final timestamp = DateTime.tryParse(value)?.toLocal();
  if (timestamp == null) return 'Unknown time';
  final difference = DateTime.now().difference(timestamp);
  if (difference.isNegative || difference.inSeconds < 45) return 'just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
  if (difference.inHours < 24) return '${difference.inHours}h ago';
  if (difference.inDays < 7) return '${difference.inDays}d ago';
  return _formatTimestamp(value);
}

String _formatTimestamp(String value) {
  final timestamp = DateTime.tryParse(value)?.toLocal();
  if (timestamp == null) return 'Unknown time';
  final hour = timestamp.hour % 12 == 0 ? 12 : timestamp.hour % 12;
  final minute = timestamp.minute.toString().padLeft(2, '0');
  final period = timestamp.hour < 12 ? 'AM' : 'PM';
  return '${timestamp.day}/${timestamp.month}/${timestamp.year} · $hour:$minute $period';
}

String _shortId(String value) => value.length <= 12
    ? value
    : '${value.substring(0, 6)}…${value.substring(value.length - 4)}';

String _formatKnownMicrousd(int value) {
  if (value <= 0) return r'$0.00';
  if (value < 10_000) return r'<$0.01';
  return '\$${(value / 1_000_000).toStringAsFixed(2)}';
}

String _costLabel(AgentCouncilCost cost) => switch (cost.state) {
  'not_recorded' => 'Not recorded',
  'unknown' => 'Unknown',
  'partial' => '${_formatKnownMicrousd(cost.knownEstimatedCostMicrousd)} known',
  _ => _formatKnownMicrousd(cost.knownEstimatedCostMicrousd),
};

String _budgetValue(int? value) => value == null ? 'Not recorded' : '$value';

String _formatDuration(int milliseconds) {
  if (milliseconds < 1000) return '$milliseconds ms';
  final seconds = milliseconds / 1000;
  if (seconds < 60) return '${seconds.toStringAsFixed(seconds < 10 ? 1 : 0)} s';
  return '${(seconds / 60).toStringAsFixed(1)} min';
}

String _authorityCount(String state, int count) => switch (state) {
  'unavailable' => 'Unavailable',
  'none' => 'None',
  _ => '$count granted',
};

AgentProfile? _findAgent(List<AgentProfile> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return values.first;
}

AgentSkill? _findSkill(List<AgentSkill> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return values.first;
}

AgentPerformance? _findPerformance(List<AgentPerformance> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return values.first;
}

double _normalizedRate(double rate) =>
    (rate > 1 ? rate / 100 : rate).clamp(0, 1).toDouble();

String _latency(int milliseconds) => milliseconds >= 1000
    ? '${(milliseconds / 1000).toStringAsFixed(1)} s'
    : '$milliseconds ms';

String _label(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
