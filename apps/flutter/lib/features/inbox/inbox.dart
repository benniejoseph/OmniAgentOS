import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;

class ApprovalItem {
  const ApprovalItem({
    required this.id,
    required this.kind,
    required this.title,
    required this.status,
    required this.riskLevel,
    required this.input,
    this.reason,
    this.createdAt,
  });
  final String id, kind, title, status;
  final int riskLevel;
  final Json input;
  final String? reason;
  final DateTime? createdAt;
  factory ApprovalItem.fromJson(Json j) => ApprovalItem(
    id: j['id'] as String,
    kind: j['kind'] as String,
    title: j['title'] as String? ?? 'Approval',
    status: j['status'] as String? ?? 'pending',
    riskLevel: j['riskLevel'] as int? ?? 1,
    input: j['input'] is Json ? j['input'] as Json : <String, dynamic>{},
    reason: j['reason'] as String?,
    createdAt: DateTime.tryParse(j['createdAt'] as String? ?? ''),
  );
}

class ApprovalQueue {
  const ApprovalQueue({
    required this.items,
    required this.tools,
    required this.workflows,
    required this.sloPolicies,
  });
  final List<ApprovalItem> items;
  final int tools, workflows, sloPolicies;
  factory ApprovalQueue.fromJson(Json j) {
    final stats = j['stats'] is Json ? j['stats'] as Json : <String, dynamic>{};
    return ApprovalQueue(
      items: ((j['items'] as List?) ?? const [])
          .whereType<Json>()
          .map(ApprovalItem.fromJson)
          .toList(),
      tools: stats['tools'] as int? ?? 0,
      workflows: stats['workflows'] as int? ?? 0,
      sloPolicies: stats['sloPolicies'] as int? ?? 0,
    );
  }
}

abstract interface class InboxRepository {
  Future<ApprovalQueue> load();
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  });
}

class InboxController extends ChangeNotifier {
  InboxController(this.repository);
  final InboxRepository repository;
  ApprovalQueue? queue;
  Object? error;
  bool loading = false;
  final Set<String> deciding = {};
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      queue = await repository.load();
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> decide(ApprovalItem item, bool approve, {String? reason}) async {
    deciding.add(item.id);
    notifyListeners();
    try {
      await repository.decide(item, approve: approve, reason: reason);
      await refresh();
    } catch (e) {
      error = e;
    } finally {
      deciding.remove(item.id);
      notifyListeners();
    }
  }
}

class InboxView extends StatelessWidget {
  const InboxView({super.key, required this.controller});
  final InboxController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (_, _) {
      final q = controller.queue;
      if (controller.loading && q == null) {
        return const _InboxSkeleton();
      }
      if (controller.error != null && q == null) {
        return Center(
          child: FilledButton.tonal(
            onPressed: controller.refresh,
            child: const Text('Reconnect inbox'),
          ),
        );
      }
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: const Text('Approval inbox'),
              actions: [
                IconButton(
                  onPressed: controller.refresh,
                  tooltip: 'Refresh approvals',
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            if (q != null && q.items.isNotEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _QueueChip(
                        icon: Icons.build_outlined,
                        label: '${q.tools} tools',
                      ),
                      _QueueChip(
                        icon: Icons.account_tree_outlined,
                        label: '${q.workflows} workflows',
                      ),
                      _QueueChip(
                        icon: Icons.monitor_heart_outlined,
                        label: '${q.sloPolicies} policies',
                      ),
                    ],
                  ),
                ),
              ),
            if (q == null || q.items.isEmpty)
              SliverFillRemaining(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.verified_user_outlined,
                        size: 48,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Nothing needs your approval',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Consequential actions will wait here for your decision.',
                      ),
                    ],
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.only(bottom: 32),
                sliver: SliverList.builder(
                  itemCount: q.items.length,
                  itemBuilder: (_, i) => ApprovalCard(
                    item: q.items[i],
                    busy: controller.deciding.contains(q.items[i].id),
                    onDecision: (value) => controller.decide(q.items[i], value),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}

class _QueueChip extends StatelessWidget {
  const _QueueChip({required this.icon, required this.label});
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) => Chip(
    avatar: Icon(icon, size: 16),
    label: Text(label),
    side: BorderSide.none,
    visualDensity: VisualDensity.compact,
  );
}

class ApprovalCard extends StatelessWidget {
  const ApprovalCard({
    super.key,
    required this.item,
    required this.busy,
    required this.onDecision,
  });
  final ApprovalItem item;
  final bool busy;
  final ValueChanged<bool> onDecision;
  @override
  Widget build(BuildContext context) {
    final color = item.riskLevel >= 3
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.tertiary;
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 180),
      opacity: busy ? .62 : 1,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: color.withValues(alpha: item.riskLevel >= 3 ? .45 : .18),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    item.kind == 'tool'
                        ? Icons.build_outlined
                        : item.kind == 'workflow'
                        ? Icons.account_tree_outlined
                        : Icons.monitor_heart_outlined,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      item.title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: .12),
                      borderRadius: BorderRadius.circular(99),
                    ),
                    child: Text(
                      'Risk ${item.riskLevel}',
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              if (item.reason?.isNotEmpty ?? false)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(item.reason!),
                ),
              if (item.input.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    item.input.entries
                        .take(3)
                        .map((e) => '${e.key}: ${e.value}')
                        .join('\n'),
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: busy ? null : () => onDecision(false),
                      child: const Text('Reject action'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: busy ? null : () => onDecision(true),
                      child: busy
                          ? const SizedBox.square(
                              dimension: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Approve action'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InboxSkeleton extends StatelessWidget {
  const _InboxSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 84, 16, 16),
    children: List.generate(
      3,
      (i) => Container(
        height: 178,
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(14),
        ),
      ),
    ),
  );
}
