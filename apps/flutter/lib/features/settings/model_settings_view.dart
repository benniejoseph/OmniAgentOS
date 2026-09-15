import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

const _assignmentOrder = [
  'main_agent',
  'orchestrator',
  'planner',
  'verifier',
  'council',
  'market_research',
  'code_builder',
  'memory',
  'embeddings',
  'vision',
  'audio',
  'audio_diarization',
  'web_search',
  'image_generation',
  'video_generation',
  'computer_use',
  'speech_synthesis',
  'realtime_transcription',
];

const _assignmentDescriptions = <String, String>{
  'main_agent': 'Everyday conversation and direct tasks',
  'orchestrator': 'Planning, delegation, and task routing',
  'planner': 'Project and durable workflow planning',
  'verifier': 'Evidence-bound workflow and Council review',
  'council': 'Specialist review and synthesis',
  'market_research': 'Macro, news-impact, and trading scenarios',
  'code_builder': 'Forge app building and code verification',
  'memory': 'Consolidation and recall decisions',
  'embeddings': 'Document and memory vector indexing',
  'vision': 'Image and visual document understanding',
  'audio': 'Recording and meeting transcription',
  'audio_diarization': 'Speaker-aware transcription',
  'web_search': 'Live public-web research',
  'image_generation': 'Image creation and non-destructive editing',
  'video_generation': 'Video creation and conversational editing',
  'computer_use': 'Governed browser and desktop interaction',
  'speech_synthesis': 'Spoken agent responses',
  'realtime_transcription': 'Live voice-command transcription',
};

class ModelSettingsView extends StatefulWidget {
  const ModelSettingsView({super.key, required this.api});
  final ApiClient api;

  @override
  State<ModelSettingsView> createState() => _ModelSettingsViewState();
}

class _ModelSettingsViewState extends State<ModelSettingsView> {
  Json? snapshot;
  Object? error;
  bool loading = true;
  String? saving;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      snapshot = await widget.api.getJson(
        NativePaths.settingsGet,
        query: {'ownerScope': 'readable'},
      );
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _edit(String scope) async {
    final data = snapshot;
    if (data == null) return;
    final assignments = (data['assignments'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    final current = assignments
        .where((item) => item['scope'] == scope)
        .firstOrNull;
    if (current != null && current['manageable'] != true) {
      setState(
        () => error = StateError('This retained model route is read only.'),
      );
      return;
    }
    final models = (data['models'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .where((item) => item['selectable'] == true)
        .toList();
    final providers = (data['providers'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .where(
          (item) =>
              item['source'] == 'tenant_vault' &&
              item['status'] == 'connected' &&
              item['enabled'] == true &&
              item['manageable'] == true,
        )
        .toList();
    final result = await showDialog<Json>(
      context: context,
      builder: (context) => _AssignmentDialog(
        scope: scope,
        current: current,
        models: models,
        providers: providers,
      ),
    );
    if (result == null) return;
    setState(() {
      saving = scope;
      error = null;
    });
    try {
      await widget.api.putJson(
        NativePaths.settingsAssignmentsUpdate,
        data: {'scope': scope, ...result},
      );
      await _load();
    } catch (value) {
      if (mounted) setState(() => error = value);
    } finally {
      if (mounted) setState(() => saving = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final providers = (snapshot?['providers'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    final models = (snapshot?['models'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    final assignments = (snapshot?['assignments'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    final activeProviders = providers
        .where(
          (item) => item['status'] == 'connected' && item['enabled'] == true,
        )
        .length;
    final configured = assignments
        .where((item) => item['manageable'] == true)
        .length;
    final platform = _map(snapshot?['platform']);
    final vault = _map(snapshot?['vault']);
    return RefreshIndicator(
      onRefresh: _load,
      child: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 22, 16, 44),
            sliver: SliverToBoxAdapter(
              child: Align(
                alignment: Alignment.topLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1240),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'CONTROL PLANE',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.primary,
                          letterSpacing: 1.5,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 7),
                      Text(
                        'Settings',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Provider status and model routing shared by every web and mobile agent surface.',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 16),
                      Wrap(
                        spacing: 9,
                        runSpacing: 9,
                        children: [
                          _Metric('$activeProviders', 'Providers'),
                          _Metric(
                            '$configured / ${_assignmentOrder.length}',
                            'Routes',
                          ),
                          _Metric(
                            '${models.where((item) => item['selectable'] == true).length}',
                            'Models',
                          ),
                        ],
                      ),
                      if (error != null) ...[
                        const SizedBox(height: 12),
                        _SettingsError(error: error!, retry: _load),
                      ],
                      if (loading && snapshot == null)
                        const Padding(
                          padding: EdgeInsets.all(48),
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else ...[
                        const SizedBox(height: 24),
                        Text(
                          'Workspace foundation',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        _Surface(
                          child: Column(
                            children: [
                              _StatusRow(
                                icon: Icons.lock_outline_rounded,
                                title: 'Authentication',
                                value: platform['authEnforced'] == true
                                    ? 'Enforced'
                                    : 'Development mode',
                                ok: platform['authEnforced'] == true,
                              ),
                              const Divider(height: 1),
                              _StatusRow(
                                icon: Icons.storage_outlined,
                                title: 'Storage',
                                value:
                                    '${platform['storageBackend'] ?? 'unknown'} · ${platform['databaseConfigured'] == true ? 'database configured' : 'database missing'}',
                                ok: platform['databaseConfigured'] == true,
                              ),
                              const Divider(height: 1),
                              _StatusRow(
                                icon: Icons.key_outlined,
                                title: 'Credential vault',
                                value: vault['configured'] == true
                                    ? 'Ready · ${vault['activeKeyId'] ?? 'active key'}'
                                    : 'Setup required',
                                ok: vault['configured'] == true,
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                'Model routes',
                                style: Theme.of(context).textTheme.titleLarge,
                              ),
                            ),
                            Text(
                              'Tap a role to edit',
                              style: TextStyle(
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        _Surface(
                          child: Column(
                            children: [
                              for (
                                var index = 0;
                                index < _assignmentOrder.length;
                                index++
                              ) ...[
                                _AssignmentRow(
                                  scope: _assignmentOrder[index],
                                  assignment: assignments
                                      .where(
                                        (item) =>
                                            item['scope'] ==
                                            _assignmentOrder[index],
                                      )
                                      .firstOrNull,
                                  saving: saving == _assignmentOrder[index],
                                  onTap: () => _edit(_assignmentOrder[index]),
                                ),
                                if (index != _assignmentOrder.length - 1)
                                  const Divider(height: 1),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),
                        Text(
                          'Provider connections',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        _Surface(
                          child: Column(
                            children: [
                              for (
                                var index = 0;
                                index < providers.length;
                                index++
                              ) ...[
                                _ProviderRow(provider: providers[index]),
                                if (index != providers.length - 1)
                                  const Divider(height: 1),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AssignmentDialog extends StatefulWidget {
  const _AssignmentDialog({
    required this.scope,
    required this.current,
    required this.models,
    required this.providers,
  });
  final String scope;
  final Json? current;
  final List<Json> models, providers;
  @override
  State<_AssignmentDialog> createState() => _AssignmentDialogState();
}

class _AssignmentDialogState extends State<_AssignmentDialog> {
  late String provider, modelId, fallbackProvider, fallbackModelId;
  late bool consent;
  @override
  void initState() {
    super.initState();
    provider =
        widget.current?['provider']?.toString() ??
        widget.providers.firstOrNull?['provider']?.toString() ??
        widget.models.firstOrNull?['provider']?.toString() ??
        '';
    modelId = widget.current?['modelId']?.toString() ?? '';
    fallbackProvider = widget.current?['fallbackProvider']?.toString() ?? '';
    fallbackModelId = widget.current?['fallbackModelId']?.toString() ?? '';
    consent = widget.current?['allowCrossProviderFallback'] == true;
  }

  @override
  Widget build(BuildContext context) {
    final providerNames = <String>{
      ...widget.providers.map((item) => item['provider']?.toString() ?? ''),
      ...widget.models.map((item) => item['provider']?.toString() ?? ''),
    }..remove('');
    final primaryModels = widget.models
        .where(
          (item) =>
              item['provider'] == provider && _supports(widget.scope, item),
        )
        .toList();
    final fallbackModels = widget.models
        .where(
          (item) =>
              item['provider'] == fallbackProvider &&
              _supports(widget.scope, item),
        )
        .toList();
    final specialized = const {
      'embeddings',
      'vision',
      'audio',
      'audio_diarization',
      'web_search',
      'image_generation',
      'video_generation',
      'computer_use',
      'speech_synthesis',
      'realtime_transcription',
    }.contains(widget.scope);
    final crosses = fallbackProvider.isNotEmpty && fallbackProvider != provider;
    final valid =
        provider.isNotEmpty &&
        modelId.isNotEmpty &&
        (specialized ||
            (fallbackProvider.isEmpty == fallbackModelId.isEmpty)) &&
        (!crosses || consent);
    return AlertDialog(
      title: Text(_humanize(widget.scope)),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: provider.isEmpty ? null : provider,
                decoration: const InputDecoration(
                  labelText: 'Primary provider',
                ),
                items: [
                  for (final value in providerNames)
                    DropdownMenuItem(
                      value: value,
                      child: Text(_humanize(value)),
                    ),
                ],
                onChanged: (value) => setState(() {
                  provider = value ?? '';
                  modelId = '';
                }),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue:
                    primaryModels.any((item) => item['modelId'] == modelId)
                    ? modelId
                    : null,
                decoration: const InputDecoration(labelText: 'Primary model'),
                items: [
                  for (final model in primaryModels)
                    DropdownMenuItem(
                      value: model['modelId']?.toString(),
                      child: Text(
                        model['displayName']?.toString() ??
                            model['modelId']?.toString() ??
                            'Model',
                      ),
                    ),
                ],
                onChanged: (value) => setState(() => modelId = value ?? ''),
              ),
              if (!specialized) ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: fallbackProvider.isEmpty
                      ? ''
                      : fallbackProvider,
                  decoration: const InputDecoration(
                    labelText: 'Fallback provider',
                  ),
                  items: [
                    const DropdownMenuItem(
                      value: '',
                      child: Text('No fallback'),
                    ),
                    for (final value in providerNames)
                      DropdownMenuItem(
                        value: value,
                        child: Text(_humanize(value)),
                      ),
                  ],
                  onChanged: (value) => setState(() {
                    fallbackProvider = value ?? '';
                    fallbackModelId = '';
                    consent = false;
                  }),
                ),
                if (fallbackProvider.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue:
                        fallbackModels.any(
                          (item) => item['modelId'] == fallbackModelId,
                        )
                        ? fallbackModelId
                        : null,
                    decoration: const InputDecoration(
                      labelText: 'Fallback model',
                    ),
                    items: [
                      for (final model in fallbackModels)
                        DropdownMenuItem(
                          value: model['modelId']?.toString(),
                          child: Text(
                            model['displayName']?.toString() ??
                                model['modelId']?.toString() ??
                                'Model',
                          ),
                        ),
                    ],
                    onChanged: (value) =>
                        setState(() => fallbackModelId = value ?? ''),
                  ),
                ],
                if (crosses)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: consent,
                    onChanged: (value) =>
                        setState(() => consent = value == true),
                    title: const Text('Allow cross-provider disclosure'),
                    subtitle: const Text(
                      'If the primary fails, the same authorized context may be sent to the fallback provider.',
                    ),
                  ),
              ],
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
          onPressed: valid
              ? () => Navigator.pop(context, <String, dynamic>{
                  'provider': provider,
                  'modelId': modelId,
                  if (!specialized && fallbackProvider.isNotEmpty)
                    'fallbackProvider': fallbackProvider,
                  if (!specialized && fallbackModelId.isNotEmpty)
                    'fallbackModelId': fallbackModelId,
                  if (!specialized && crosses && consent)
                    'crossProviderFallbackConsent': true,
                })
              : null,
          child: const Text('Save route'),
        ),
      ],
    );
  }
}

class _AssignmentRow extends StatelessWidget {
  const _AssignmentRow({
    required this.scope,
    required this.assignment,
    required this.saving,
    required this.onTap,
  });
  final String scope;
  final Json? assignment;
  final bool saving;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final active = assignment?['runtimeReadiness'] == 'active';
    return ListTile(
      onTap: saving ? null : onTap,
      leading: saving
          ? const SizedBox.square(
              dimension: 21,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(
              active
                  ? Icons.check_circle_outline_rounded
                  : Icons.circle_outlined,
              color: active ? Theme.of(context).colorScheme.primary : null,
            ),
      title: Text(
        _humanize(scope),
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        assignment == null
            ? _assignmentDescriptions[scope] ?? 'Not assigned'
            : '${assignment!['displayModelId'] ?? assignment!['modelId'] ?? 'model'} · ${_humanize(assignment!['provider']?.toString() ?? 'unknown')}\n${_assignmentDescriptions[scope] ?? ''}',
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right_rounded),
    );
  }
}

class _ProviderRow extends StatelessWidget {
  const _ProviderRow({required this.provider});
  final Json provider;
  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(
      provider['status'] == 'connected'
          ? Icons.cloud_done_outlined
          : Icons.cloud_off_outlined,
    ),
    title: Text(
      provider['label']?.toString() ??
          _humanize(provider['provider']?.toString() ?? 'provider'),
    ),
    subtitle: Text(
      '${_humanize(provider['status']?.toString() ?? 'unknown')} · ${_humanize(provider['source']?.toString() ?? 'unknown')}',
    ),
    trailing: provider['catalogRefreshedAt'] == null
        ? null
        : const Icon(Icons.inventory_2_outlined, size: 18),
  );
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.icon,
    required this.title,
    required this.value,
    required this.ok,
  });
  final IconData icon;
  final String title, value;
  final bool ok;
  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(
      icon,
      color: ok
          ? Theme.of(context).colorScheme.primary
          : Theme.of(context).colorScheme.error,
    ),
    title: Text(title),
    subtitle: Text(value),
    trailing: Icon(ok ? Icons.check_rounded : Icons.warning_amber_rounded),
  );
}

class _Metric extends StatelessWidget {
  const _Metric(this.value, this.label);
  final String value, label;
  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 104),
    padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
    decoration: BoxDecoration(
      border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(value, style: Theme.of(context).textTheme.titleLarge),
        Text(
          label,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 11,
          ),
        ),
      ],
    ),
  );
}

class _Surface extends StatelessWidget {
  const _Surface({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLowest,
      border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      borderRadius: BorderRadius.circular(12),
    ),
    clipBehavior: Clip.antiAlias,
    child: child,
  );
}

class _SettingsError extends StatelessWidget {
  const _SettingsError({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.errorContainer,
    borderRadius: BorderRadius.circular(10),
    child: ListTile(
      leading: const Icon(Icons.warning_amber_rounded),
      title: const Text('Settings could not be synchronized'),
      subtitle: Text(error.toString(), maxLines: 2),
      trailing: IconButton(
        onPressed: retry,
        icon: const Icon(Icons.refresh_rounded),
      ),
    ),
  );
}

Json _map(Object? value) =>
    value is Map ? Json.from(value) : <String, dynamic>{};
String _humanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
bool _supports(String scope, Json model) {
  final capabilities = (model['capabilities'] as List? ?? const [])
      .map((value) => value.toString())
      .toSet();
  return switch (scope) {
    'embeddings' => capabilities.contains('embeddings'),
    'vision' => capabilities.contains('vision'),
    'audio' || 'audio_diarization' || 'realtime_transcription' =>
      capabilities.contains('audio') || capabilities.contains('transcription'),
    'web_search' => capabilities.contains('web_search'),
    'image_generation' => capabilities.contains('image_generation'),
    'video_generation' => capabilities.contains('video_generation'),
    'computer_use' => capabilities.contains('computer_use'),
    'speech_synthesis' => capabilities.contains('speech_synthesis'),
    _ =>
      capabilities.isEmpty ||
          capabilities.contains('text') ||
          capabilities.contains('reasoning'),
  };
}
