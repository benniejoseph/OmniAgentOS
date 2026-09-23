import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../app/theme/macos_app_theme.dart';
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
  'audio': 'Voice drafts, uploaded recordings, and meeting transcription',
  'audio_diarization': 'Speaker-aware transcription',
  'web_search': 'Live public-web research',
  'image_generation': 'Image creation and non-destructive editing',
  'video_generation': 'Video creation and conversational editing',
  'computer_use': 'Governed interaction with this Mac',
  'speech_synthesis': 'Spoken agent responses',
  'realtime_transcription': 'Live, in-the-moment voice transcription',
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
  int macosSection = 0;
  String macosQuery = '';

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
    if (usesMacosPresentation()) {
      return _buildMacosSettings(
        context,
        localComputer: localComputer,
        providers: providers,
        models: models,
        assignments: assignments,
        activeProviders: activeProviders,
        configured: configured,
        platform: platform,
        vault: vault,
      );
    }
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

  Widget _buildMacosSettings(
    BuildContext context, {
    required LocalComputerCoordinator localComputer,
    required List<Json> providers,
    required List<Json> models,
    required List<Json> assignments,
    required int activeProviders,
    required int configured,
    required Json platform,
    required Json vault,
  }) {
    final normalizedQuery = macosQuery.trim().toLowerCase();
    final visibleAssignments = _assignmentOrder
        .where((scope) {
          if (normalizedQuery.isEmpty) return true;
          final assignment = assignments
              .where((item) => item['scope'] == scope)
              .firstOrNull;
          return _humanize(scope).toLowerCase().contains(normalizedQuery) ||
              (_assignmentDescriptions[scope] ?? '').toLowerCase().contains(
                normalizedQuery,
              ) ||
              assignment.toString().toLowerCase().contains(normalizedQuery);
        })
        .toList(growable: false);
    final visibleProviders = providers
        .where((provider) {
          if (normalizedQuery.isEmpty) return true;
          return provider.toString().toLowerCase().contains(normalizedQuery);
        })
        .toList(growable: false);

    final section = switch (macosSection) {
      0 => _buildMacosGeneral(platform: platform, vault: vault),
      1 => _buildMacosRoutes(assignments, visibleAssignments),
      2 => _buildMacosProviders(visibleProviders),
      _ => _buildMacosComputer(localComputer),
    };

    return MacosPageScaffold(
      title: 'Settings',
      description: 'Configure every provider, model route, and native workspace capability.',
      icon: Icons.tune_rounded,
      actions: [
        IconButton(
          key: const ValueKey('macos-settings-refresh'),
          tooltip: loading ? 'Refreshing settings' : 'Refresh settings',
          onPressed: loading ? null : _load,
          icon: loading
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      toolbar: Row(
        children: [
          SizedBox(
            width: 300,
            child: TextField(
              key: ValueKey('macos-settings-search-$macosSection'),
              enabled: macosSection == 1 || macosSection == 2,
              onChanged: (value) => setState(() => macosQuery = value),
              decoration: InputDecoration(
                hintText: macosSection == 1
                    ? 'Search model routes'
                    : macosSection == 2
                    ? 'Search providers'
                    : 'Select Models or Providers to search',
                prefixIcon: const Icon(Icons.search_rounded, size: 17),
              ),
            ),
          ),
          const Spacer(),
          _MacSettingsToolbarMetric(
            label: 'Providers',
            value: '$activeProviders',
          ),
          const SizedBox(width: 18),
          _MacSettingsToolbarMetric(
            label: 'Routes',
            value: '$configured / ${_assignmentOrder.length}',
          ),
          const SizedBox(width: 18),
          _MacSettingsToolbarMetric(
            label: 'Models',
            value:
                '${models.where((item) => item['selectable'] == true).length}',
          ),
        ],
      ),
      inspectorWidth: 310,
      inspector: _MacSettingsInspector(
        activeProviders: activeProviders,
        configuredRoutes: configured,
        totalRoutes: _assignmentOrder.length,
        selectableModels: models
            .where((item) => item['selectable'] == true)
            .length,
        platform: platform,
        vault: vault,
      ),
      body: Column(
        children: [
          if (error != null)
            _MacSettingsErrorBanner(error: error!, retry: _load),
          Expanded(
            child: loading && snapshot == null
                ? const MacosLoadingList(rows: 8)
                : Row(
                    children: [
                      SizedBox(
                        width: 210,
                        child: _MacSettingsNavigation(
                          selected: macosSection,
                          onSelected: (value) => setState(() {
                            macosSection = value;
                            macosQuery = '';
                          }),
                        ),
                      ),
                      VerticalDivider(
                        width: 1,
                        color: MacosThemeColors.of(context).divider,
                      ),
                      Expanded(
                        child: AnimatedSwitcher(
                          duration: const Duration(milliseconds: 140),
                          child: KeyedSubtree(
                            key: ValueKey('macos-settings-$macosSection'),
                            child: section,
                          ),
                        ),
                      ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildMacosGeneral({
    required Json platform,
    required Json vault,
  }) => ListView(
    key: const ValueKey('macos-settings-general'),
    padding: const EdgeInsets.all(22),
    children: [
      const MacosSectionHeader(
        title: 'Workspace foundation',
        description: 'Authentication, storage, and credential boundaries for this private workspace.',
      ),
      const SizedBox(height: 10),
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
        const MacosSectionHeader(
          title: 'Desktop experience',
          description:
              'Quick Entry and independent windows are native to this Mac.',
        ),
        const SizedBox(height: 10),
        _Surface(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Row(
                  children: [
                    const Icon(Icons.keyboard_command_key_rounded),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Quick Entry shortcut',
                            style: TextStyle(fontWeight: FontWeight.w700),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'Open Asael from anywhere without changing windows.',
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 16),
                    SizedBox(
                      width: 230,
                      child: DropdownButtonFormField<DesktopQuickEntryShortcut>(
                        key: ValueKey(desktopShortcut?.shortcut),
                        initialValue: desktopShortcut?.shortcut,
                        isExpanded: true,
                        items: DesktopQuickEntryShortcut.values
                            .map(
                              (shortcut) => DropdownMenuItem(
                                value: shortcut,
                                child: Text(
                                  shortcut.label,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            )
                            .toList(),
                        onChanged: desktopSaving || desktopShortcut == null
                            ? null
                            : (value) {
                                if (value != null) {
                                  _setDesktopShortcut(value);
                                }
                              },
                      ),
                    ),
                  ],
                ),
                if (desktopShortcut case final shortcut?) ...[
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      shortcut.shortcut == DesktopQuickEntryShortcut.disabled
                          ? 'Global shortcut disabled. Quick Entry remains available from the Asael menu.'
                          : shortcut.registered
                          ? 'Shortcut is active system-wide.'
                          : 'That shortcut is owned by another application. Choose another preset.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color:
                            shortcut.shortcut !=
                                    DesktopQuickEntryShortcut.disabled &&
                                !shortcut.registered
                            ? Theme.of(context).colorScheme.error
                            : null,
                      ),
                    ),
                  ),
                ],
                if (desktopError != null) ...[
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Desktop preferences could not be updated.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                ],
                const Divider(height: 28),
                Row(
                  children: [
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Independent workspaces',
                            style: TextStyle(fontWeight: FontWeight.w700),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'Open another signed window using the same governed backend.',
                          ),
                        ],
                      ),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: () =>
                          appDesktopHostBridge.openWorkspaceWindow('/talk'),
                      icon: const Icon(Icons.open_in_new_rounded),
                      label: const Text('New conversation'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    ],
  );

  Widget _buildMacosRoutes(
    List<Json> assignments,
    List<String> visibleScopes,
  ) => ListView(
    key: const ValueKey('macos-settings-routes'),
    padding: const EdgeInsets.all(22),
    children: [
      MacosSectionHeader(
        title: 'Model routes',
        description:
            '${visibleScopes.length} of ${_assignmentOrder.length} roles. Every AI capability is configured here instead of hard-coded.',
      ),
      const SizedBox(height: 10),
      if (visibleScopes.isEmpty)
        const SizedBox(
          height: 280,
          child: MacosEmptyState(
            icon: Icons.route_outlined,
            title: 'No matching model routes',
            message: 'Try a role, capability, provider, or model name.',
          ),
        )
      else
        _Surface(
          child: Column(
            children: [
              for (var index = 0; index < visibleScopes.length; index++) ...[
                _AssignmentRow(
                  scope: visibleScopes[index],
                  assignment: assignments
                      .where((item) => item['scope'] == visibleScopes[index])
                      .firstOrNull,
                  saving: saving == visibleScopes[index],
                  onTap: () => _edit(visibleScopes[index]),
                ),
                if (index != visibleScopes.length - 1) const Divider(height: 1),
              ],
            ],
          ),
        ),
    ],
  );

  Widget _buildMacosProviders(List<Json> providers) => ListView(
    key: const ValueKey('macos-settings-providers'),
    padding: const EdgeInsets.all(22),
    children: [
      MacosSectionHeader(
        title: 'Provider connections',
        description:
            '${providers.length} connections match this view. Keys remain in the tenant credential vault.',
      ),
      const SizedBox(height: 10),
      if (providers.isEmpty)
        const SizedBox(
          height: 280,
          child: MacosEmptyState(
            icon: Icons.hub_outlined,
            title: 'No matching providers',
            message: 'Change the search to see another connection.',
          ),
        )
      else
        _Surface(
          child: Column(
            children: [
              for (var index = 0; index < providers.length; index++) ...[
                _ProviderRow(provider: providers[index]),
                if (index != providers.length - 1) const Divider(height: 1),
              ],
            ],
          ),
        ),
    ],
  );

  Widget _buildMacosComputer(LocalComputerCoordinator localComputer) =>
      ListView(
        key: const ValueKey('macos-settings-computer'),
        padding: const EdgeInsets.all(22),
        children: [
          const MacosSectionHeader(
            title: 'Computer use on this Mac',
            description: 'Permission state, signed helper, command broker, and the immediate kill switch.',
          ),
          const SizedBox(height: 10),
          _LocalComputerControl(coordinator: localComputer),
        ],
      );
}

const _macSettingsSections = <({String label, IconData icon})>[
  (label: 'General', icon: Icons.settings_outlined),
  (label: 'Models & roles', icon: Icons.route_outlined),
  (label: 'Providers', icon: Icons.hub_outlined),
  (label: 'This Mac', icon: Icons.laptop_mac_outlined),
];

class _MacSettingsNavigation extends StatelessWidget {
  const _MacSettingsNavigation({
    required this.selected,
    required this.onSelected,
  });

  final int selected;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return ListView(
      key: const ValueKey('macos-settings-navigation'),
      padding: const EdgeInsets.all(10),
      children: [
        for (var index = 0; index < _macSettingsSections.length; index++)
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Material(
              color: index == selected ? mac.selection : Colors.transparent,
              borderRadius: BorderRadius.circular(7),
              child: InkWell(
                key: ValueKey('macos-settings-section-$index'),
                borderRadius: BorderRadius.circular(7),
                onTap: () => onSelected(index),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 11,
                    vertical: 9,
                  ),
                  child: Row(
                    children: [
                      Icon(_macSettingsSections[index].icon, size: 17),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          _macSettingsSections[index].label,
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _MacSettingsToolbarMetric extends StatelessWidget {
  const _MacSettingsToolbarMetric({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(label, style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(width: 6),
      Text(value, style: Theme.of(context).textTheme.labelLarge),
    ],
  );
}

class _MacSettingsInspector extends StatelessWidget {
  const _MacSettingsInspector({
    required this.activeProviders,
    required this.configuredRoutes,
    required this.totalRoutes,
    required this.selectableModels,
    required this.platform,
    required this.vault,
  });

  final int activeProviders;
  final int configuredRoutes;
  final int totalRoutes;
  final int selectableModels;
  final Json platform;
  final Json vault;

  @override
  Widget build(BuildContext context) => ListView(
    key: const ValueKey('macos-settings-inspector'),
    padding: const EdgeInsets.all(16),
    children: [
      const MacosSectionHeader(
        title: 'Configuration summary',
        description: 'Current server truth for this private workspace.',
      ),
      const SizedBox(height: 14),
      _MacSettingsFact(label: 'Active providers', value: '$activeProviders'),
      _MacSettingsFact(
        label: 'Configured routes',
        value: '$configuredRoutes / $totalRoutes',
      ),
      _MacSettingsFact(label: 'Selectable models', value: '$selectableModels'),
      _MacSettingsFact(
        label: 'Authentication',
        value: platform['authEnforced'] == true ? 'Enforced' : 'Review',
      ),
      _MacSettingsFact(
        label: 'Database',
        value: platform['databaseConfigured'] == true
            ? 'Connected'
            : 'Not configured',
      ),
      _MacSettingsFact(
        label: 'Credential vault',
        value: vault['configured'] == true ? 'Ready' : 'Setup required',
      ),
      const SizedBox(height: 20),
      const MacosPane(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.memory_outlined, size: 18),
            SizedBox(width: 9),
            Expanded(
              child: Text(
                'Agent roles resolve their provider and model from these settings. Native UI code does not choose a hidden model.',
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

class _MacSettingsFact extends StatelessWidget {
  const _MacSettingsFact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        const SizedBox(width: 8),
        Text(value, style: Theme.of(context).textTheme.labelLarge),
      ],
    ),
  );
}

class _MacSettingsErrorBanner extends StatelessWidget {
  const _MacSettingsErrorBanner({required this.error, required this.retry});

  final Object error;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.error;
    return Container(
      constraints: const BoxConstraints(minHeight: 42),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .08),
        border: Border(bottom: BorderSide(color: color.withValues(alpha: .18))),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_off_rounded, color: color, size: 17),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              error.toString(),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          TextButton(onPressed: retry, child: const Text('Retry')),
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
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surfaceContainerLowest,
    shape: RoundedRectangleBorder(
      side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
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
