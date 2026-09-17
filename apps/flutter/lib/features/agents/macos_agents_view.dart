import 'package:flutter/material.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'agents.dart';

enum _AgentWorkspace { agents, skills, performance }

/// Desktop-native agent roster for macOS.
///
/// The portable [AgentsController] remains authoritative. This presenter adds
/// dense search/filter tools, a stable selection model, and a persistent
/// configuration/activity inspector without changing Android or web.
class MacosAgentsView extends StatefulWidget {
  const MacosAgentsView({super.key, required this.controller});

  final AgentsController controller;

  @override
  State<MacosAgentsView> createState() => _MacosAgentsViewState();
}

class _MacosAgentsViewState extends State<MacosAgentsView> {
  final _searchController = TextEditingController();
  _AgentWorkspace _workspace = _AgentWorkspace.agents;
  String _filter = 'all';
  String? _selectedAgentId;
  String? _selectedSkillId;
  String? _selectedPerformanceId;

  @override
  void initState() {
    super.initState();
    if (widget.controller.ledger == null) widget.controller.refresh();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final ledger = controller.ledger;
      final agents = _visibleAgents(ledger?.agents ?? const []);
      final skills = _visibleSkills(ledger?.skills ?? const []);
      final performance = _visiblePerformance(ledger?.performance ?? const []);
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
        description: 'Inspect the roster, capability assignments, policy, and observed outcomes.',
        icon: Icons.smart_toy_outlined,
        actions: [
          IconButton(
            key: const Key('macos-agents-refresh'),
            tooltip: 'Refresh agent roster',
            onPressed: controller.loading ? null : controller.refresh,
            icon: controller.loading
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
        primaryAction:
            controller.canMutate && _workspace != _AgentWorkspace.performance
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
          filters: _filtersFor(ledger),
          visibleCount: switch (_workspace) {
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
        inspector: _AgentInspector(
          key: const Key('macos-agents-inspector'),
          workspace: _workspace,
          agent: selectedAgent,
          skill: selectedSkill,
          performance: selectedPerformance,
          ledger: ledger,
          canMutate: controller.canMutate,
          onEditAgent: selectedAgent == null
              ? null
              : () => _editAgent(selectedAgent),
          onDeleteAgent: selectedAgent == null || !selectedAgent.manageable
              ? null
              : () => _confirmDelete(
                  selectedAgent.name,
                  () => controller.removeAgent(selectedAgent.id),
                ),
          onEditSkill: selectedSkill == null
              ? null
              : () => _editSkill(selectedSkill),
          onDeleteSkill: selectedSkill == null || !selectedSkill.manageable
              ? null
              : () => _confirmDelete(
                  selectedSkill.name,
                  () => controller.removeSkill(selectedSkill.id),
                ),
        ),
        body: _buildBody(
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
    required AgentLedger? ledger,
    required List<AgentProfile> agents,
    required List<AgentSkill> skills,
    required List<AgentPerformance> performance,
    required AgentProfile? selectedAgent,
    required AgentSkill? selectedSkill,
    required AgentPerformance? selectedPerformance,
  }) {
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

  List<String> _filtersFor(AgentLedger? ledger) {
    final values = switch (_workspace) {
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

  void _selectWorkspace(Set<_AgentWorkspace> values) {
    if (values.isEmpty) return;
    setState(() {
      _workspace = values.first;
      _filter = 'all';
    });
  }

  void _clearFilters() {
    _searchController.clear();
    setState(() => _filter = 'all');
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
      final compact = constraints.maxWidth < 820;
      return Row(
        children: [
          SegmentedButton<_AgentWorkspace>(
            key: const Key('macos-agents-workspace'),
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(
                value: _AgentWorkspace.agents,
                icon: Icon(Icons.smart_toy_outlined, size: 15),
                label: Text('Roster'),
              ),
              ButtonSegment(
                value: _AgentWorkspace.skills,
                icon: Icon(Icons.bolt_outlined, size: 15),
                label: Text('Skills'),
              ),
              ButtonSegment(
                value: _AgentWorkspace.performance,
                icon: Icon(Icons.query_stats_outlined, size: 15),
                label: Text('Outcomes'),
              ),
            ],
            selected: {workspace},
            onSelectionChanged: onWorkspaceChanged,
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: compact ? 210 : 290,
            child: TextField(
              key: const Key('macos-agents-search'),
              controller: searchController,
              onChanged: onSearchChanged,
              decoration: InputDecoration(
                hintText: switch (workspace) {
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
            width: compact ? 126 : 155,
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
          const Spacer(),
          if (!compact)
            Text(
              '$visibleCount visible',
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      );
    },
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
    required this.canMutate,
    required this.onEditAgent,
    required this.onDeleteAgent,
    required this.onEditSkill,
    required this.onDeleteSkill,
  });

  final _AgentWorkspace workspace;
  final AgentProfile? agent;
  final AgentSkill? skill;
  final AgentPerformance? performance;
  final AgentLedger? ledger;
  final bool canMutate;
  final VoidCallback? onEditAgent, onDeleteAgent, onEditSkill, onDeleteSkill;

  @override
  Widget build(BuildContext context) => switch (workspace) {
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
              canMutate: canMutate,
              onEdit: onEditAgent,
              onDelete: onDeleteAgent,
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
    required this.canMutate,
    required this.onEdit,
    required this.onDelete,
  });

  final AgentProfile agent;
  final AgentLedger? ledger;
  final bool canMutate;
  final VoidCallback? onEdit, onDelete;

  @override
  Widget build(BuildContext context) {
    final skillsById = {
      for (final skill in ledger?.skills ?? const <AgentSkill>[])
        skill.id: skill,
    };
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
        if (canMutate && agent.manageable) ...[
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
  const _InspectorSection({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 7),
      DefaultTextStyle.merge(
        style: Theme.of(context).textTheme.bodyMedium,
        child: child,
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
  late final _modelPolicy = TextEditingController(
    text: widget.agent?.modelPolicy ?? 'auto',
  );
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
    _modelPolicy.dispose();
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
                    child: TextFormField(
                      controller: _modelPolicy,
                      decoration: const InputDecoration(
                        labelText: 'Model policy',
                        helperText:
                            'Use auto or a policy configured in Settings',
                      ),
                      validator: _requiredField,
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
                      values: const ['ready', 'active', 'paused', 'disabled'],
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
                          onChanged: (value) => setState(() {
                            value == true
                                ? _selectedSkills.add(skill.id)
                                : _selectedSkills.remove(skill.id);
                          }),
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
        onPressed: _save,
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
      'modelPolicy': _modelPolicy.text.trim(),
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
