import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;

class Mission {
  const Mission({
    required this.id,
    required this.title,
    required this.objective,
    required this.status,
    required this.priority,
    this.updatedAt,
  });
  final String id, title, objective, status, priority;
  final DateTime? updatedAt;
  bool get terminal =>
      const {'succeeded', 'failed', 'canceled', 'archived'}.contains(status);
  factory Mission.fromJson(Json j) => Mission(
    id: j['id'] as String,
    title: j['title'] as String? ?? 'Mission',
    objective: j['objective'] as String? ?? '',
    status: j['status'] as String? ?? 'draft',
    priority: j['priority'] as String? ?? 'normal',
    updatedAt: DateTime.tryParse(j['updatedAt'] as String? ?? ''),
  );
}

class MissionTask {
  const MissionTask({
    required this.id,
    required this.title,
    required this.status,
    required this.definitionOfDone,
  });
  final String id, title, status, definitionOfDone;
  factory MissionTask.fromJson(Json j) => MissionTask(
    id: j['id'] as String,
    title: j['title'] as String? ?? 'Task',
    status: j['status'] as String? ?? 'pending',
    definitionOfDone: j['definitionOfDone'] as String? ?? '',
  );
}

class MissionArtifact {
  const MissionArtifact({
    required this.id,
    required this.title,
    required this.kind,
    this.uri,
  });
  final String id, title, kind;
  final String? uri;
  factory MissionArtifact.fromJson(Json j) => MissionArtifact(
    id: j['id'] as String,
    title: j['title'] as String? ?? 'Artifact',
    kind: j['kind'] as String? ?? 'output',
    uri: j['uri'] as String?,
  );
}

class MissionEventPage {
  const MissionEventPage({
    required this.cursor,
    required this.changed,
    required this.status,
    required this.events,
  });
  final int cursor;
  final bool changed;
  final String status;
  final List<({int seq, String type, DateTime? at})> events;
  factory MissionEventPage.fromJson(Json json) {
    final mission = json['mission'] is Json
        ? json['mission'] as Json
        : <String, dynamic>{};
    return MissionEventPage(
      cursor: json['cursor'] as int? ?? 0,
      changed: json['changed'] as bool? ?? false,
      status: mission['status'] as String? ?? 'unknown',
      events: ((json['events'] as List?) ?? const [])
          .whereType<Json>()
          .map(
            (event) => (
              seq: event['seq'] as int? ?? 0,
              type: event['type'] as String? ?? 'updated',
              at: DateTime.tryParse(event['at'] as String? ?? ''),
            ),
          )
          .toList(),
    );
  }
}

class MissionDetail {
  const MissionDetail({
    required this.mission,
    required this.tasks,
    required this.artifacts,
  });
  final Mission mission;
  final List<MissionTask> tasks;
  final List<MissionArtifact> artifacts;
  factory MissionDetail.fromJson(Json j) => MissionDetail(
    mission: Mission.fromJson(j['mission'] as Json),
    tasks: ((j['tasks'] as List?) ?? const [])
        .whereType<Json>()
        .map(MissionTask.fromJson)
        .toList(),
    artifacts: ((j['artifacts'] as List?) ?? const [])
        .whereType<Json>()
        .map(MissionArtifact.fromJson)
        .toList(),
  );
}

abstract interface class MissionsRepository {
  Future<List<Mission>> list();
  Future<MissionDetail> detail(String id);
  Future<Mission> create({
    required String title,
    required String objective,
    String priority = 'normal',
  });
  Future<Mission> transition(String id, String status);
  Future<MissionEventPage> events(String id, {int afterSeq = 0});
}

class MissionsController extends ChangeNotifier {
  MissionsController(this.repository);
  final MissionsRepository repository;
  List<Mission> missions = const [];
  Object? error;
  bool loading = false;
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      missions = await repository.list();
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }
}

class MissionsView extends StatelessWidget {
  const MissionsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final MissionsController controller;
  final ValueChanged<Mission> onOpen;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (_, _) {
      if (controller.loading && controller.missions.isEmpty) {
        return const _MissionSkeleton();
      }
      if (controller.error != null && controller.missions.isEmpty) {
        return Center(
          child: FilledButton.tonal(
            onPressed: controller.refresh,
            child: const Text('Reconnect missions'),
          ),
        );
      }
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: const Text('Missions'),
              actions: [
                IconButton(
                  onPressed: controller.refresh,
                  tooltip: 'Refresh missions',
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            if (controller.missions.isEmpty)
              SliverFillRemaining(
                child: _MissionEmpty(onRefresh: controller.refresh),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
                sliver: SliverList.builder(
                  itemCount: controller.missions.length,
                  itemBuilder: (_, i) {
                    final m = controller.missions[i];
                    return _MissionRow(mission: m, onTap: () => onOpen(m));
                  },
                ),
              ),
          ],
        ),
      );
    },
  );
}

class _MissionRow extends StatelessWidget {
  const _MissionRow({required this.mission, required this.onTap});
  final Mission mission;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Material(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              _Status(status: mission.status),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            mission.title,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        _StatusLabel(status: mission.status),
                      ],
                    ),
                    if (mission.objective.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        mission.objective,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    const SizedBox(height: 9),
                    Text(
                      '${mission.priority} priority',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              const Icon(Icons.chevron_right_rounded),
            ],
          ),
        ),
      ),
    ),
  );
}

class _StatusLabel extends StatelessWidget {
  const _StatusLabel({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final color = _statusColor(context, status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

Color _statusColor(BuildContext context, String status) => switch (status) {
  'succeeded' => Colors.green.shade600,
  'failed' || 'canceled' => Theme.of(context).colorScheme.error,
  'running' || 'in_progress' => Theme.of(context).colorScheme.primary,
  _ => Theme.of(context).colorScheme.tertiary,
};

class _Status extends StatelessWidget {
  const _Status({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) => CircleAvatar(
    backgroundColor: _statusColor(context, status).withValues(alpha: .12),
    foregroundColor: _statusColor(context, status),
    child: Icon(
      status == 'succeeded'
          ? Icons.check_rounded
          : status == 'failed'
          ? Icons.error_outline
          : Icons.route_rounded,
    ),
  );
}

class _MissionSkeleton extends StatelessWidget {
  const _MissionSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 84, 16, 16),
    children: List.generate(
      5,
      (i) => Container(
        height: 98,
        margin: const EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(14),
        ),
      ),
    ),
  );
}

class _MissionEmpty extends StatelessWidget {
  const _MissionEmpty({required this.onRefresh});
  final VoidCallback onRefresh;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.route_outlined,
            size: 46,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 16),
          Text(
            'No missions yet',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 6),
          const Text(
            'Describe a complex outcome in Talk to create durable work.',
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

class MissionDetailView extends StatefulWidget {
  const MissionDetailView({
    super.key,
    required this.id,
    required this.repository,
  });
  final String id;
  final MissionsRepository repository;
  @override
  State<MissionDetailView> createState() => _MissionDetailViewState();
}

class _MissionDetailViewState extends State<MissionDetailView> {
  MissionDetail? detail;
  Object? error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final value = await widget.repository.detail(widget.id);
      if (mounted) {
        setState(() {
          detail = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = detail;
    return Scaffold(
      appBar: AppBar(title: Text(d?.mission.title ?? 'Mission')),
      body: error != null
          ? Center(
              child: FilledButton.tonal(
                onPressed: _load,
                child: const Text('Try again'),
              ),
            )
          : d == null
          ? const _MissionDetailSkeleton()
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  d.mission.objective,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 24),
                Text(
                  'Execution plan',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                ...d.tasks.map(
                  (t) => ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      t.status == 'succeeded'
                          ? Icons.check_circle
                          : Icons.radio_button_unchecked,
                    ),
                    title: Text(t.title),
                    subtitle: t.definitionOfDone.isEmpty
                        ? null
                        : Text(t.definitionOfDone),
                  ),
                ),
                if (d.artifacts.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Text(
                    'Artifacts',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  ...d.artifacts.map(
                    (a) => ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.description_outlined),
                      title: Text(a.title),
                      subtitle: Text(a.kind),
                    ),
                  ),
                ],
                if (!d.mission.terminal)
                  OutlinedButton.icon(
                    onPressed: () async {
                      await widget.repository.transition(
                        d.mission.id,
                        'canceled',
                      );
                      await _load();
                    },
                    icon: const Icon(Icons.stop_circle_outlined),
                    label: const Text('Cancel mission'),
                  ),
              ],
            ),
    );
  }
}

class _MissionDetailSkeleton extends StatelessWidget {
  const _MissionDetailSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: List.generate(
      4,
      (i) => Container(
        height: i == 0 ? 72 : 58,
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
      ),
    ),
  );
}
