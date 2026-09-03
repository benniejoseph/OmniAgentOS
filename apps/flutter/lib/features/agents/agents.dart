import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;

List<String> _strings(Object? value) =>
    (value as List? ?? const []).map((e) => e.toString()).toList();

class AgentSkill {
  const AgentSkill({
    required this.id,
    required this.name,
    required this.description,
    required this.category,
    required this.status,
    required this.instructions,
    required this.toolIds,
    required this.tags,
    this.builtIn = false,
  });
  final String id, name, description, category, status, instructions;
  final List<String> toolIds, tags;
  final bool builtIn;
  factory AgentSkill.fromJson(Json j) => AgentSkill(
    id: '${j['id']}',
    name: '${j['name'] ?? 'Skill'}',
    description: '${j['description'] ?? ''}',
    category: '${j['category'] ?? 'personal'}',
    status: '${j['status'] ?? 'active'}',
    instructions: '${j['instructions'] ?? ''}',
    toolIds: _strings(j['toolIds']),
    tags: _strings(j['tags']),
    builtIn: j['builtIn'] == true,
  );
}

class AgentProfile {
  const AgentProfile({
    required this.id,
    required this.name,
    required this.role,
    required this.description,
    required this.instructions,
    required this.status,
    required this.accent,
    required this.modelPolicy,
    required this.autonomy,
    required this.approvalPolicy,
    required this.memoryScope,
    required this.skillIds,
    required this.toolIds,
    this.builtIn = false,
  });
  final String id,
      name,
      role,
      description,
      instructions,
      status,
      accent,
      modelPolicy,
      autonomy,
      approvalPolicy,
      memoryScope;
  final List<String> skillIds, toolIds;
  final bool builtIn;
  factory AgentProfile.fromJson(Json j, {bool builtIn = false}) => AgentProfile(
    id: '${j['id']}',
    name: '${j['name'] ?? 'Agent'}',
    role: '${j['role'] ?? ''}',
    description: '${j['description'] ?? ''}',
    instructions: '${j['instructions'] ?? ''}',
    status: '${j['status'] ?? 'ready'}',
    accent: '${j['accent'] ?? 'emerald'}',
    modelPolicy: '${j['modelPolicy'] ?? 'auto'}',
    autonomy: '${j['autonomy'] ?? 'assist'}',
    approvalPolicy: '${j['approvalPolicy'] ?? 'risk_based'}',
    memoryScope: '${j['memoryScope'] ?? 'all'}',
    skillIds: _strings(j['skillIds']),
    toolIds: _strings(j['toolIds'] ?? j['tools']),
    builtIn: builtIn,
  );
}

class AgentPerformance {
  const AgentPerformance({
    required this.id,
    required this.name,
    required this.runs,
    required this.successRate,
    required this.averageLatencyMs,
    required this.memoriesLearned,
  });
  final String id, name;
  final int runs, averageLatencyMs, memoriesLearned;
  final double successRate;
  factory AgentPerformance.fromJson(Json j) => AgentPerformance(
    id: '${j['id'] ?? j['agentId']}',
    name: '${j['name'] ?? j['agentName'] ?? 'Agent'}',
    runs: (j['runs'] as num?)?.toInt() ?? (j['runCount'] as num?)?.toInt() ?? 0,
    successRate: (j['successRate'] as num?)?.toDouble() ?? 0,
    averageLatencyMs: (j['averageLatencyMs'] as num?)?.toInt() ?? 0,
    memoriesLearned: (j['memoriesLearned'] as num?)?.toInt() ?? 0,
  );
}

class AgentLedger {
  const AgentLedger({
    required this.agents,
    required this.skills,
    required this.performance,
  });
  final List<AgentProfile> agents;
  final List<AgentSkill> skills;
  final List<AgentPerformance> performance;
}

abstract interface class AgentsRepository {
  Future<AgentLedger> load();
  Future<AgentProfile> saveAgent(Json input, {String? id});
  Future<AgentSkill> saveSkill(Json input, {String? id});
  Future<void> deleteAgent(String id);
  Future<void> deleteSkill(String id);
}

class AgentsController extends ChangeNotifier {
  AgentsController(this.repository, {required this.canManage});
  final AgentsRepository repository;
  final bool canManage;
  AgentLedger? ledger;
  bool loading = false;
  Object? error;
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      ledger = await repository.load();
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> saveAgent(Json value, {String? id}) async {
    await repository.saveAgent(value, id: id);
    await refresh();
  }

  Future<void> saveSkill(Json value, {String? id}) async {
    await repository.saveSkill(value, id: id);
    await refresh();
  }

  Future<void> removeAgent(String id) async {
    await repository.deleteAgent(id);
    await refresh();
  }

  Future<void> removeSkill(String id) async {
    await repository.deleteSkill(id);
    await refresh();
  }
}

class AgentsView extends StatefulWidget {
  const AgentsView({super.key, required this.controller});
  final AgentsController controller;
  @override
  State<AgentsView> createState() => _AgentsViewState();
}

class _AgentsViewState extends State<AgentsView>
    with SingleTickerProviderStateMixin {
  late final TabController tabs;
  @override
  void initState() {
    super.initState();
    tabs = TabController(length: 3, vsync: this);
    if (widget.controller.ledger == null) widget.controller.refresh();
  }

  @override
  void dispose() {
    tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (_, _) {
      final c = widget.controller;
      return Scaffold(
        appBar: AppBar(
          title: const Text('Agent arsenal'),
          bottom: TabBar(
            controller: tabs,
            tabs: const [
              Tab(text: 'Agents'),
              Tab(text: 'Skills'),
              Tab(text: 'Performance'),
            ],
          ),
          actions: [
            if (c.canManage)
              IconButton(
                tooltip: 'Create',
                onPressed: () => tabs.index == 1 ? _editSkill() : _editAgent(),
                icon: const Icon(Icons.add_rounded),
              ),
            IconButton(
              onPressed: c.refresh,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        body: c.loading && c.ledger == null
            ? const _AgentSkeleton()
            : c.error != null && c.ledger == null
            ? _Retry(onTap: c.refresh)
            : AnimatedSwitcher(
                duration: _motionDuration(context),
                switchInCurve: Curves.easeOutQuart,
                child: TabBarView(
                  key: ValueKey(c.ledger),
                  controller: tabs,
                  children: [
                    _agents(c.ledger?.agents ?? const []),
                    _skills(c.ledger?.skills ?? const []),
                    _performance(c.ledger?.performance ?? const []),
                  ],
                ),
              ),
      );
    },
  );
  Widget _agents(List<AgentProfile> values) => values.isEmpty
      ? const _Empty(icon: Icons.hub_outlined, text: 'No agents configured')
      : LayoutBuilder(
          builder: (context, box) {
            final wide = box.maxWidth >= 760;
            return GridView.builder(
              padding: EdgeInsets.symmetric(
                horizontal: wide ? 32 : 16,
                vertical: 20,
              ),
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: wide ? 2 : 1,
                mainAxisExtent: 142,
                crossAxisSpacing: 12,
                mainAxisSpacing: 12,
              ),
              itemCount: values.length,
              itemBuilder: (_, i) {
                final a = values[i];
                return Card(
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => _showAgent(a),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          _AgentAvatar(agent: a),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        a.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium,
                                      ),
                                    ),
                                    _Status(a.status),
                                  ],
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  a.role,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                const Spacer(),
                                Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: [
                                    _MetaPill(
                                      icon: Icons.model_training_outlined,
                                      label: a.modelPolicy.replaceAll('_', ' '),
                                    ),
                                    _MetaPill(
                                      icon: Icons.shield_outlined,
                                      label: a.autonomy,
                                    ),
                                    _MetaPill(
                                      icon: Icons.bolt_outlined,
                                      label: '${a.skillIds.length} skills',
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                          if (!a.builtIn && widget.controller.canManage)
                            PopupMenuButton<String>(
                              onSelected: (v) => v == 'edit'
                                  ? _editAgent(a)
                                  : _confirmDelete(
                                      a.name,
                                      () => widget.controller.removeAgent(a.id),
                                    ),
                              itemBuilder: (_) => const [
                                PopupMenuItem(
                                  value: 'edit',
                                  child: Text('Edit'),
                                ),
                                PopupMenuItem(
                                  value: 'delete',
                                  child: Text('Delete'),
                                ),
                              ],
                            ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            );
          },
        );
  Widget _skills(List<AgentSkill> values) => values.isEmpty
      ? const _Empty(
          icon: Icons.auto_awesome_outlined,
          text: 'No skills available',
        )
      : ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: values.length,
          separatorBuilder: (_, _) => const Divider(),
          itemBuilder: (_, i) {
            final s = values[i];
            return ListTile(
              leading: const Icon(Icons.bolt_rounded),
              title: Text(s.name),
              subtitle: Text(
                '${s.category} · ${s.toolIds.length} tools\n${s.description}',
                maxLines: 3,
              ),
              isThreeLine: true,
              trailing: s.builtIn || !widget.controller.canManage
                  ? _Status(s.status)
                  : PopupMenuButton<String>(
                      onSelected: (v) => v == 'edit'
                          ? _editSkill(s)
                          : _confirmDelete(
                              s.name,
                              () => widget.controller.removeSkill(s.id),
                            ),
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'edit', child: Text('Edit')),
                        PopupMenuItem(value: 'delete', child: Text('Delete')),
                      ],
                    ),
            );
          },
        );
  Widget _performance(List<AgentPerformance> values) => values.isEmpty
      ? const _Empty(
          icon: Icons.query_stats_rounded,
          text: 'Performance appears after the first run',
        )
      : ListView.builder(
          padding: const EdgeInsets.all(16),
          itemCount: values.length,
          itemBuilder: (_, i) {
            final p = values[i];
            final rate = p.successRate > 1
                ? p.successRate / 100
                : p.successRate;
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          p.name,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      Text('${(rate * 100).round()}% success'),
                    ],
                  ),
                  const SizedBox(height: 8),
                  LinearProgressIndicator(value: rate.clamp(0, 1)),
                  const SizedBox(height: 8),
                  Text(
                    '${p.runs} runs · ${p.averageLatencyMs} ms avg · ${p.memoriesLearned} memories learned',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            );
          },
        );
  Future<void> _showAgent(AgentProfile a) => showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(a.name, style: Theme.of(context).textTheme.headlineSmall),
            Text(a.role),
            const SizedBox(height: 20),
            Text(a.description),
            const SizedBox(height: 16),
            Text('Policy', style: Theme.of(context).textTheme.titleMedium),
            Text(
              '${a.modelPolicy} · ${a.autonomy} · ${a.approvalPolicy} approvals · ${a.memoryScope} memory',
            ),
            const SizedBox(height: 16),
            Text(
              'Instructions',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(a.instructions),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              children: a.skillIds.map((s) => Chip(label: Text(s))).toList(),
            ),
          ],
        ),
      ),
    ),
  );
  Future<void> _editAgent([AgentProfile? a]) async {
    final result = await showDialog<Json>(
      context: context,
      builder: (_) => _AgentDialog(
        agent: a,
        skills: widget.controller.ledger?.skills ?? const [],
      ),
    );
    if (result != null) {
      await _run(() => widget.controller.saveAgent(result, id: a?.id));
    }
  }

  Future<void> _editSkill([AgentSkill? s]) async {
    final result = await showDialog<Json>(
      context: context,
      builder: (_) => _SkillDialog(skill: s),
    );
    if (result != null) {
      await _run(() => widget.controller.saveSkill(result, id: s?.id));
    }
  }

  Future<void> _confirmDelete(
    String name,
    Future<void> Function() action,
  ) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Delete $name?'),
        content: const Text('This cannot be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (yes == true) await _run(action);
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }
}

Duration _motionDuration(BuildContext context) =>
    MediaQuery.maybeOf(context)?.disableAnimations == true
    ? Duration.zero
    : const Duration(milliseconds: 190);

class _AgentAvatar extends StatelessWidget {
  const _AgentAvatar({required this.agent});
  final AgentProfile agent;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 46,
      height: 46,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(13),
      ),
      child: Text(
        agent.name.characters.first.toUpperCase(),
        style: TextStyle(
          color: scheme.onPrimaryContainer,
          fontWeight: FontWeight.w800,
          fontSize: 17,
        ),
      ),
    );
  }
}

class _MetaPill extends StatelessWidget {
  const _MetaPill({required this.icon, required this.label});
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(8),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13),
        const SizedBox(width: 4),
        Text(label, style: Theme.of(context).textTheme.labelSmall),
      ],
    ),
  );
}

class _AgentSkeleton extends StatelessWidget {
  const _AgentSkeleton();
  @override
  Widget build(BuildContext context) => ListView.builder(
    padding: const EdgeInsets.all(20),
    itemCount: 5,
    itemBuilder: (_, i) => Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        height: 116,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest
              .withValues(alpha: .55),
          borderRadius: BorderRadius.circular(14),
        ),
      ),
    ),
  );
}

class _AgentDialog extends StatefulWidget {
  const _AgentDialog({this.agent, required this.skills});
  final AgentProfile? agent;
  final List<AgentSkill> skills;
  @override
  State<_AgentDialog> createState() => _AgentDialogState();
}

class _AgentDialogState extends State<_AgentDialog> {
  late final name = TextEditingController(text: widget.agent?.name);
  late final role = TextEditingController(text: widget.agent?.role);
  late final description = TextEditingController(
    text: widget.agent?.description,
  );
  late final instructions = TextEditingController(
    text: widget.agent?.instructions,
  );
  late Set<String> selected = {...?widget.agent?.skillIds};
  String model = 'auto',
      autonomy = 'assist',
      approval = 'risk_based',
      memory = 'all',
      accent = 'emerald',
      status = 'ready';
  @override
  void initState() {
    super.initState();
    final a = widget.agent;
    if (a != null) {
      model = a.modelPolicy;
      autonomy = a.autonomy;
      approval = a.approvalPolicy;
      memory = a.memoryScope;
      accent = a.accent;
      status = a.status;
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.agent == null ? 'New agent' : 'Edit agent'),
    content: SizedBox(
      width: 560,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: name,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            TextField(
              controller: role,
              decoration: const InputDecoration(labelText: 'Role'),
            ),
            TextField(
              controller: description,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Description'),
            ),
            TextField(
              controller: instructions,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Operating instructions',
              ),
            ),
            _drop('Model', model, const [
              'auto',
              'openai_fast',
              'openai_reasoning',
              'gemini_fast',
              'anthropic_fast',
              'anthropic_reasoning',
            ], (v) => setState(() => model = v)),
            _drop('Autonomy', autonomy, const [
              'assist',
              'governed',
              'execute',
            ], (v) => setState(() => autonomy = v)),
            _drop('Approvals', approval, const [
              'always',
              'risk_based',
              'read_only',
            ], (v) => setState(() => approval = v)),
            _drop('Memory', memory, const [
              'session',
              'project',
              'all',
            ], (v) => setState(() => memory = v)),
            const Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text('Assigned skills'),
              ),
            ),
            ...widget.skills.map(
              (s) => CheckboxListTile(
                dense: true,
                value: selected.contains(s.id),
                title: Text(s.name),
                onChanged: (v) => setState(
                  () => v == true ? selected.add(s.id) : selected.remove(s.id),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          if (name.text.trim().isEmpty ||
              role.text.trim().isEmpty ||
              instructions.text.trim().length < 10) {
            return;
          }
          Navigator.pop(context, {
            'name': name.text.trim(),
            'role': role.text.trim(),
            'description': description.text.trim(),
            'instructions': instructions.text.trim(),
            'status': status,
            'accent': accent,
            'modelPolicy': model,
            'autonomy': autonomy,
            'approvalPolicy': approval,
            'memoryScope': memory,
            'skillIds': selected.toList(),
            'toolIds': <String>[],
          });
        },
        child: const Text('Save'),
      ),
    ],
  );
  Widget _drop(
    String label,
    String value,
    List<String> values,
    ValueChanged<String> onChanged,
  ) => DropdownButtonFormField<String>(
    initialValue: value,
    decoration: InputDecoration(labelText: label),
    items: values
        .map(
          (v) =>
              DropdownMenuItem(value: v, child: Text(v.replaceAll('_', ' '))),
        )
        .toList(),
    onChanged: (v) => onChanged(v!),
  );
}

class _SkillDialog extends StatefulWidget {
  const _SkillDialog({this.skill});
  final AgentSkill? skill;
  @override
  State<_SkillDialog> createState() => _SkillDialogState();
}

class _SkillDialogState extends State<_SkillDialog> {
  late final name = TextEditingController(text: widget.skill?.name);
  late final description = TextEditingController(
    text: widget.skill?.description,
  );
  late final instructions = TextEditingController(
    text: widget.skill?.instructions,
  );
  late final tools = TextEditingController(
    text: widget.skill?.toolIds.join(', '),
  );
  late final tags = TextEditingController(text: widget.skill?.tags.join(', '));
  String category = 'personal', status = 'active';
  @override
  void initState() {
    super.initState();
    category = widget.skill?.category ?? 'personal';
    status = widget.skill?.status ?? 'active';
  }

  List<String> split(String v) =>
      v.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.skill == null ? 'New skill' : 'Edit skill'),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: name,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            TextField(
              controller: description,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Description'),
            ),
            TextField(
              controller: instructions,
              maxLines: 5,
              decoration: const InputDecoration(labelText: 'Instructions'),
            ),
            DropdownButtonFormField<String>(
              initialValue: category,
              decoration: const InputDecoration(labelText: 'Category'),
              items: const [
                'research',
                'creation',
                'analysis',
                'memory',
                'automation',
                'personal',
              ].map((v) => DropdownMenuItem(value: v, child: Text(v))).toList(),
              onChanged: (v) => setState(() => category = v!),
            ),
            TextField(
              controller: tools,
              decoration: const InputDecoration(
                labelText: 'Tool IDs, comma separated',
              ),
            ),
            TextField(
              controller: tags,
              decoration: const InputDecoration(
                labelText: 'Tags, comma separated',
              ),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          if (name.text.trim().isEmpty ||
              instructions.text.trim().length < 10) {
            return;
          }
          Navigator.pop(context, {
            'name': name.text.trim(),
            'description': description.text.trim(),
            'instructions': instructions.text.trim(),
            'category': category,
            'status': status,
            'toolIds': split(tools.text),
            'tags': split(tags.text),
            'knowledgeTags': <String>[],
          });
        },
        child: const Text('Save'),
      ),
    ],
  );
}

class _Status extends StatelessWidget {
  const _Status(this.value);
  final String value;
  @override
  Widget build(BuildContext context) =>
      Chip(label: Text(value), visualDensity: VisualDensity.compact);
}

class _Empty extends StatelessWidget {
  const _Empty({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [Icon(icon, size: 42), const SizedBox(height: 12), Text(text)],
    ),
  );
}

class _Retry extends StatelessWidget {
  const _Retry({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Center(
    child: FilledButton.tonal(
      onPressed: onTap,
      child: const Text('Reconnect agent arsenal'),
    ),
  );
}
