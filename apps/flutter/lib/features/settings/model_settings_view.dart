import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../core/platform/local_computer_bridge.dart';
import '../../generated/native_contract.g.dart';
import '../computer_use/local_computer.dart';

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

class ModelSettingsView extends ConsumerStatefulWidget {
  const ModelSettingsView({super.key, required this.api});
  final ApiClient api;

  @override
  ConsumerState<ModelSettingsView> createState() => _ModelSettingsViewState();
}

class _ModelSettingsViewState extends ConsumerState<ModelSettingsView> {
  Json? snapshot;
  Object? error;
  bool loading = true;
  String? saving;
  DesktopShortcutState? desktopShortcut;
  Object? desktopError;
  bool desktopSaving = false;

  @override
  void initState() {
    super.initState();
    _load();
    if (appDesktopHostBridge.supported) _loadDesktopPreferences();
  }

  Future<void> _loadDesktopPreferences() async {
    try {
      final state = await appDesktopHostBridge.getQuickEntryShortcut();
      if (mounted) setState(() => desktopShortcut = state);
    } catch (error) {
      if (mounted) setState(() => desktopError = error);
    }
  }

  Future<void> _setDesktopShortcut(DesktopQuickEntryShortcut shortcut) async {
    setState(() {
      desktopSaving = true;
      desktopError = null;
    });
    try {
      final state = await appDesktopHostBridge.setQuickEntryShortcut(shortcut);
      if (mounted) setState(() => desktopShortcut = state);
    } catch (error) {
      if (mounted) setState(() => desktopError = error);
    } finally {
      if (mounted) setState(() => desktopSaving = false);
    }
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
    final localComputer = ref.watch(localComputerCoordinatorProvider);
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
                        if (appDesktopHostBridge.supported) ...[
                          const SizedBox(height: 24),
                          Text(
                            'Desktop workspace',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 8),
                          _Surface(
                            child: Padding(
                              padding: const EdgeInsets.all(16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Icon(
                                        Icons.keyboard_command_key_rounded,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .primary,
                                      ),
                                      const SizedBox(width: 12),
                                      const Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              'Quick Entry shortcut',
                                              style: TextStyle(
                                                fontWeight: FontWeight.w700,
                                              ),
                                            ),
                                            Text(
                                              'Choose one global shortcut or leave it available from the menu bar only.',
                                            ),
                                          ],
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      SizedBox(
                                        width: 230,
                                        child:
                                            DropdownButtonFormField<
                                              DesktopQuickEntryShortcut
                                            >(
                                              key: ValueKey(
                                                desktopShortcut?.shortcut,
                                              ),
                                              initialValue:
                                                  desktopShortcut?.shortcut,
                                              items: DesktopQuickEntryShortcut
                                                  .values
                                                  .map(
                                                    (shortcut) =>
                                                        DropdownMenuItem(
                                                          value: shortcut,
                                                          child: Text(
                                                            shortcut.label,
                                                          ),
                                                        ),
                                                  )
                                                  .toList(),
                                              onChanged:
                                                  desktopSaving ||
                                                      desktopShortcut == null
                                                  ? null
                                                  : (value) {
                                                      if (value != null) {
                                                        _setDesktopShortcut(
                                                          value,
                                                        );
                                                      }
                                                    },
                                            ),
                                      ),
                                    ],
                                  ),
                                  if (desktopShortcut case final shortcut?) ...[
                                    const SizedBox(height: 8),
                                    Text(
                                      shortcut.shortcut ==
                                              DesktopQuickEntryShortcut.disabled
                                          ? 'Global shortcut disabled. Quick Entry remains in the Asael menu.'
                                          : shortcut.registered
                                          ? 'Shortcut is active system-wide.'
                                          : 'This shortcut is already owned by another application. Choose another preset.',
                                      style: TextStyle(
                                        color:
                                            shortcut.shortcut !=
                                                    DesktopQuickEntryShortcut
                                                        .disabled &&
                                                !shortcut.registered
                                            ? Theme.of(context)
                                                  .colorScheme
                                                  .error
                                            : Theme.of(context)
                                                  .colorScheme
                                                  .onSurfaceVariant,
                                      ),
                                    ),
                                  ],
                                  if (desktopError != null) ...[
                                    const SizedBox(height: 8),
                                    Text(
                                      'Desktop preferences could not be updated.',
                                      style: TextStyle(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .error,
                                      ),
                                    ),
                                  ],
                                  const Divider(height: 28),
                                  Row(
                                    children: [
                                      const Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              'Independent workspaces',
                                              style: TextStyle(
                                                fontWeight: FontWeight.w700,
                                              ),
                                            ),
                                            Text(
                                              'Open another signed Asael window with the same account and governed backend.',
                                            ),
                                          ],
                                        ),
                                      ),
                                      FilledButton.tonalIcon(
                                        onPressed: () => appDesktopHostBridge
                                            .openWorkspaceWindow('/talk'),
                                        icon: const Icon(
                                          Icons.open_in_new_rounded,
                                        ),
                                        label: const Text('New conversation'),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(height: 24),
                          Text(
                            'Local Computer Use',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 8),
                          _LocalComputerControl(coordinator: localComputer),
                        ],
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

class _LocalComputerControl extends StatelessWidget {
  const _LocalComputerControl({required this.coordinator});

  final LocalComputerCoordinator coordinator;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: coordinator,
    builder: (context, _) {
      final scheme = Theme.of(context).colorScheme;
      final native = coordinator.status;
      final phase = coordinator.phase;
      final (title, detail, icon, color) = switch (phase) {
        LocalComputerBrokerPhase.starting => (
          'Checking this Mac',
          'Reading the signed helper and macOS permission state.',
          Icons.sync_rounded,
          scheme.primary,
        ),
        LocalComputerBrokerPhase.unavailable => (
          'Local control unavailable',
          'Install the private signed Asael macOS build to use this device.',
          Icons.laptop_mac_outlined,
          scheme.onSurfaceVariant,
        ),
        LocalComputerBrokerPhase.disabled => (
          'This Mac is not enabled',
          'Enable it explicitly before an agent can receive governed actions.',
          Icons.pause_circle_outline_rounded,
          scheme.onSurfaceVariant,
        ),
        LocalComputerBrokerPhase.permissionsRequired => (
          'macOS access is required',
          'Grant Accessibility and Screen Recording, then enable this Mac.',
          Icons.admin_panel_settings_outlined,
          scheme.tertiary,
        ),
        LocalComputerBrokerPhase.ready => (
          'This Mac is ready',
          'Only explicitly targeted, governed commands can run here.',
          Icons.check_circle_outline_rounded,
          scheme.primary,
        ),
        LocalComputerBrokerPhase.active => (
          'Asael is controlling this Mac',
          'A visible, bounded local action is in progress.',
          Icons.radio_button_checked_rounded,
          scheme.error,
        ),
        LocalComputerBrokerPhase.stopped => (
          'Local control stopped',
          'The kill switch is active. Enable this Mac to start a new session.',
          Icons.stop_circle_outlined,
          scheme.error,
        ),
        LocalComputerBrokerPhase.degraded => (
          'Reconnecting',
          'No new local action will start until the governed service returns.',
          Icons.sync_problem_rounded,
          scheme.tertiary,
        ),
      };
      final accessGranted =
          native?.accessibility == LocalComputerPermission.granted &&
          native?.screenRecording == LocalComputerPermission.granted;
      final primary = coordinator.canClaimCommands;
      return _Surface(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Icon(icon, color: color),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  if (coordinator.changing)
                    const Padding(
                      padding: EdgeInsets.only(left: 12, top: 3),
                      child: SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                ],
              ),
              const Divider(height: 28),
              Wrap(
                spacing: 24,
                runSpacing: 10,
                children: [
                  _LocalPermissionState(
                    label: 'Accessibility',
                    value: native?.accessibility,
                  ),
                  _LocalPermissionState(
                    label: 'Screen Recording',
                    value: native?.screenRecording,
                  ),
                  _LocalPermissionState(
                    label: 'Signed helper',
                    ready: native?.helperInstalled == true,
                    fallback: native?.helperVersion ?? 'Checking',
                  ),
                  _LocalPermissionState(
                    label: 'Command broker',
                    ready: coordinator.device?.online == true,
                    fallback: coordinator.device?.online == true
                        ? 'Online'
                        : 'Waiting',
                  ),
                ],
              ),
              if (!primary) ...[
                const SizedBox(height: 12),
                Text(
                  'Auxiliary window · status and Stop now are available here. Enablement and command claiming stay with the main Asael window.',
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ],
              if (coordinator.lastError case final message?) ...[
                const SizedBox(height: 12),
                Text(
                  message,
                  style: TextStyle(color: scheme.error, fontSize: 12),
                ),
              ],
              const SizedBox(height: 14),
              Wrap(
                spacing: 9,
                runSpacing: 9,
                children: [
                  OutlinedButton.icon(
                    onPressed: coordinator.changing
                        ? null
                        : coordinator.refresh,
                    icon: const Icon(Icons.refresh_rounded, size: 18),
                    label: const Text('Refresh'),
                  ),
                  if (primary &&
                      native?.helperInstalled == true &&
                      !accessGranted)
                    FilledButton.tonalIcon(
                      onPressed: coordinator.changing
                          ? null
                          : coordinator.requestPermissions,
                      icon: const Icon(Icons.lock_open_rounded, size: 18),
                      label: const Text('Grant macOS access'),
                    ),
                  if (primary && accessGranted)
                    FilledButton.icon(
                      onPressed: coordinator.changing
                          ? null
                          : () =>
                                coordinator.setEnabled(native?.enabled != true),
                      icon: Icon(
                        native?.enabled == true
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded,
                        size: 18,
                      ),
                      label: Text(
                        native?.enabled == true
                            ? 'Disable this Mac'
                            : 'Enable this Mac',
                      ),
                    ),
                  if (native?.enabled == true || coordinator.active)
                    OutlinedButton.icon(
                      onPressed: coordinator.changing
                          ? null
                          : () => coordinator.stopNow(),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: scheme.error,
                      ),
                      icon: const Icon(Icons.stop_circle_outlined, size: 18),
                      label: const Text('Stop now'),
                    ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _LocalPermissionState extends StatelessWidget {
  const _LocalPermissionState({
    required this.label,
    this.value,
    this.ready,
    this.fallback,
  });

  final String label;
  final LocalComputerPermission? value;
  final bool? ready;
  final String? fallback;

  @override
  Widget build(BuildContext context) {
    final granted = ready ?? value == LocalComputerPermission.granted;
    final text =
        fallback ??
        switch (value) {
          LocalComputerPermission.granted => 'Granted',
          LocalComputerPermission.denied => 'Not granted',
          LocalComputerPermission.unknown || null => 'Checking',
        };
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: 176,
      child: Row(
        children: [
          Icon(
            granted ? Icons.check_circle_rounded : Icons.circle_outlined,
            size: 17,
            color: granted ? scheme.primary : scheme.onSurfaceVariant,
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 11.5,
                  ),
                ),
              ],
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
