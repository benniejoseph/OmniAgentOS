import 'package:flutter/material.dart';

import 'agent_council.dart';

/// Shared macOS/Android inspector for the immutable authority actually bound
/// to one delegated child execution.
class AgentTaskAuthorityView extends StatefulWidget {
  const AgentTaskAuthorityView({
    super.key,
    required this.controller,
    required this.taskId,
    this.compact = false,
  });

  final AgentCouncilController controller;
  final String taskId;
  final bool compact;

  @override
  State<AgentTaskAuthorityView> createState() => _AgentTaskAuthorityViewState();
}

class _AgentTaskAuthorityViewState extends State<AgentTaskAuthorityView> {
  @override
  void initState() {
    super.initState();
    Future<void>.microtask(
      () => widget.controller.loadTaskDetail(widget.taskId, refresh: true),
    );
  }

  @override
  void didUpdateWidget(covariant AgentTaskAuthorityView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.taskId != widget.taskId) {
      Future<void>.microtask(
        () => widget.controller.loadTaskDetail(widget.taskId, refresh: true),
      );
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final detail = widget.controller.taskDetail(widget.taskId);
      final loading = widget.controller.isLoadingTaskDetail(widget.taskId);
      final error = widget.controller.taskDetailError(widget.taskId);
      if (detail == null && loading) {
        return const Padding(
          padding: EdgeInsets.all(24),
          child: Center(child: CircularProgressIndicator()),
        );
      }
      if (detail == null) {
        return _AuthorityNotice(
          message: error == null
              ? 'Exact signed-grant authority is unavailable.'
              : '$error',
          onRetry: () =>
              widget.controller.loadTaskDetail(widget.taskId, refresh: true),
        );
      }
      final authority = detail.authority;
      final validation = authority.validation;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                validation.status == 'current'
                    ? Icons.verified_user_outlined
                    : validation.status == 'changed'
                    ? Icons.warning_amber_rounded
                    : Icons.help_outline_rounded,
                size: 18,
                color: validation.status == 'current'
                    ? Theme.of(context).colorScheme.primary
                    : Theme.of(context).colorScheme.secondary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Signed grants · ${_label(validation.status)}',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              if (loading)
                const SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                )
              else
                IconButton(
                  key: Key('agent-task-authority-refresh-${widget.taskId}'),
                  tooltip: 'Revalidate signed grants',
                  onPressed: () => widget.controller.loadTaskDetail(
                    widget.taskId,
                    refresh: true,
                  ),
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.refresh_rounded, size: 17),
                ),
            ],
          ),
          const SizedBox(height: 7),
          Text(
            'These pins are immutable for this task. Stop the task or manage the source capability; signed grants cannot be edited or revoked in place.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          _DigestLine(label: 'Contract', value: authority.contractSha256),
          _DigestLine(
            label: 'Grant request',
            value: authority.grantRequestSha256,
          ),
          if (validation.category != null)
            _ValueLine(
              label: 'Validation',
              value:
                  '${_label(validation.category!)}${validation.validatedAt == null ? '' : ' · ${_timestamp(validation.validatedAt!)}'}',
            ),
          const SizedBox(height: 14),
          _GrantGroup(
            icon: Icons.visibility_outlined,
            title: 'Native read tools',
            count: authority.nativeReadTools.length,
            children: [
              for (final grant in authority.nativeReadTools)
                _GrantTile(
                  key: ValueKey('agent-authority-native-${grant.toolId}'),
                  title: grant.toolId,
                  fields: const {'Authority': 'Read-only governed tool'},
                ),
            ],
          ),
          _GrantGroup(
            icon: Icons.menu_book_outlined,
            title: 'Skills',
            count: authority.skills.length,
            children: [
              for (final grant in authority.skills)
                _GrantTile(
                  key: ValueKey(
                    'agent-authority-skill-${grant.capabilityGrantId}',
                  ),
                  title: '${grant.skillId} · v${grant.skillVersion}',
                  fields: {
                    'Capability grant ID': grant.capabilityGrantId,
                    'Skill version ID': grant.skillVersionId,
                    'Skill SHA-256': grant.skillSha256,
                  },
                ),
            ],
          ),
          _GrantGroup(
            icon: Icons.extension_outlined,
            title: 'Plugins',
            count: authority.plugins.length,
            children: [
              for (final grant in authority.plugins)
                _GrantTile(
                  key: ValueKey(
                    'agent-authority-plugin-${grant.capabilityGrantId}',
                  ),
                  title: '${grant.pluginId} · ${grant.pluginVersion}',
                  fields: {
                    'Capability grant ID': grant.capabilityGrantId,
                    'Installation ID': grant.installationId,
                    'Installation revision': '${grant.installationRevision}',
                    'Installation SHA-256': grant.installationSha256,
                    'Manifest SHA-256': grant.manifestSha256,
                    'Component IDs': grant.componentIds.isEmpty
                        ? 'None pinned'
                        : grant.componentIds.join('\n'),
                  },
                ),
            ],
          ),
          _GrantGroup(
            icon: Icons.hub_outlined,
            title: 'MCP servers',
            count: authority.mcpServers.length,
            children: [
              for (final grant in authority.mcpServers)
                _GrantTile(
                  key: ValueKey(
                    'agent-authority-mcp-${grant.capabilityGrantId}',
                  ),
                  title: grant.serverId,
                  fields: {
                    'Capability grant ID': grant.capabilityGrantId,
                    'Server version ID': grant.serverVersionId,
                    'Server contract SHA-256': grant.serverContractSha256,
                    'Governed tool IDs': grant.governedToolIds.isEmpty
                        ? 'None pinned'
                        : grant.governedToolIds.join('\n'),
                    'Connector target IDs': grant.connectorTargetIds.isEmpty
                        ? 'None pinned'
                        : grant.connectorTargetIds.join('\n'),
                  },
                ),
            ],
          ),
          if (error != null) ...[
            const SizedBox(height: 8),
            Text(
              'Refresh failed; showing the last verified detail. $error',
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
          ],
        ],
      );
    },
  );
}

class _GrantGroup extends StatelessWidget {
  const _GrantGroup({
    required this.icon,
    required this.title,
    required this.count,
    required this.children,
  });

  final IconData icon;
  final String title;
  final int count;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => ExpansionTile(
    tilePadding: EdgeInsets.zero,
    childrenPadding: const EdgeInsets.only(bottom: 8),
    leading: Icon(icon, size: 18),
    title: Text('$title · $count'),
    initiallyExpanded: count > 0 && count <= 3,
    children: count == 0
        ? [
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'None pinned.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ]
        : children,
  );
}

class _GrantTile extends StatelessWidget {
  const _GrantTile({super.key, required this.title, required this.fields});

  final String title;
  final Map<String, String> fields;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 6),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(9),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(title, style: Theme.of(context).textTheme.labelMedium),
        for (final field in fields.entries) ...[
          const SizedBox(height: 4),
          Text(field.key, style: Theme.of(context).textTheme.labelSmall),
          SelectableText(
            field.value,
            style: field.key.contains('SHA-256')
                ? Theme.of(context).textTheme.labelSmall
                      ?.copyWith(fontFamily: 'monospace')
                : Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    ),
  );
}

class _DigestLine extends StatelessWidget {
  const _DigestLine({required this.label, required this.value});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelSmall),
        SelectableText(value, style: Theme.of(context).textTheme.bodySmall),
      ],
    ),
  );
}

class _ValueLine extends StatelessWidget {
  const _ValueLine({required this.label, required this.value});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 88,
          child: Text(label, style: Theme.of(context).textTheme.labelSmall),
        ),
        Expanded(child: Text(value)),
      ],
    ),
  );
}

class _AuthorityNotice extends StatelessWidget {
  const _AuthorityNotice({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(message),
        const SizedBox(height: 8),
        TextButton.icon(
          onPressed: onRetry,
          icon: const Icon(Icons.refresh_rounded, size: 16),
          label: const Text('Retry authority check'),
        ),
      ],
    ),
  );
}

String _label(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _timestamp(String value) {
  final parsed = DateTime.tryParse(value)?.toLocal();
  return parsed == null ? 'Unavailable' : parsed.toString();
}
