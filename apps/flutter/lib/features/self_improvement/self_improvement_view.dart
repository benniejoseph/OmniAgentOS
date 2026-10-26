import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../core/update/native_update_protocol.dart';
import '../../app/theme/macos_app_theme.dart';
import 'self_improvement_controller.dart';
import 'self_improvement_models.dart';
import 'self_improvement_settings.dart';
import 'self_improvement_widgets.dart';

class SelfImprovementView extends StatefulWidget {
  const SelfImprovementView({
    super.key,
    required this.controller,
    this.cycleId,
    this.onOpenRun,
  });
  final SelfImprovementController controller;
  final String? cycleId;
  final ValueChanged<String>? onOpenRun;
  @override
  State<SelfImprovementView> createState() => _SelfImprovementViewState();
}

class _SelfImprovementViewState extends State<SelfImprovementView> {
  String? _selectedId, _configurationId;
  String _query = '';
  String? _decisionError;
  bool _editing = false, _showDetail = false;
  final _search = TextEditingController();
  SelfImprovementController get controller => widget.controller;
  bool get _canAct =>
      controller.current &&
      controller.canManage &&
      !controller.loading &&
      !controller.acting &&
      !controller.refreshRequired &&
      _decisionError == null;

  @override
  void initState() {
    super.initState();
    _selectedId = widget.cycleId;
    _showDetail = widget.cycleId != null;
  }

  @override
  void didUpdateWidget(covariant SelfImprovementView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, controller)) {
      _editing = false;
      _query = '';
      _search.clear();
      _configurationId = null;
      _decisionError = null;
      _selectedId = widget.cycleId;
      _showDetail = widget.cycleId != null;
    } else if (oldWidget.cycleId != widget.cycleId) {
      _selectedId = widget.cycleId;
      _showDetail = widget.cycleId != null;
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() => _decisionError = null);
    await controller.refresh(cycleId: _selectedId ?? widget.cycleId);
  }

  Future<void> _decide(Future<bool> Function() action) async {
    try {
      final accepted = await action();
      final selected = controller.selectedCycle;
      if (mounted && accepted && selected != null && controller.current) {
        setState(() {
          _selectedId = selected.id;
          _showDetail = true;
        });
      }
    } catch (error) {
      if (mounted && controller.current) {
        setState(
          () => _decisionError = error is FormatException
              ? error.message
              : error is StateError
              ? error.message
              : 'This decision could not be confirmed. Refresh before continuing.',
        );
      }
    }
  }

  void _settings() {
    if (!_canAct) return;
    setState(() => _editing = true);
    unawaited(controller.loadSetup());
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final snapshot = controller.snapshot;
      if (!controller.current) {
        return const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Unlock your current Asael account to read Self-improvement.',
            ),
          ),
        );
      }
      final cycles = snapshot?.cycles ?? const <SelfImprovementCycle>[];
      if (_selectedId == null && cycles.isNotEmpty) {
        _selectedId = cycles.first.id;
      }
      final selectedId = _selectedId;
      final selected = controller.selectedCycle?.id == selectedId
          ? controller.selectedCycle
          : _findCycle(cycles, selectedId);
      final configurations =
          snapshot?.configurations ?? const <SelfImprovementConfiguration>[];
      final configuration =
          _findConfiguration(
            configurations,
            _configurationId ?? selected?.configurationId,
          ) ??
          (configurations.isNotEmpty ? configurations.first : null);
      final active =
          cycles.any(
            (cycle) =>
                !cycle.terminal && cycle.configurationId == configuration?.id,
          ) ||
          (selected != null &&
              !selected.terminal &&
              selected.configurationId == configuration?.id);
      final visibleCycles = cycles
          .where(
            (cycle) =>
                _query.isEmpty ||
                '${cycle.summary} ${improvementLabel(cycle.stage)}'
                    .toLowerCase()
                    .contains(_query.toLowerCase()),
          )
          .toList();
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true): () {
            if (!controller.loading && !controller.acting) {
              unawaited(_refresh());
            }
          },
          const SingleActivator(LogicalKeyboardKey.keyR, control: true): () {
            if (!controller.loading && !controller.acting) {
              unawaited(_refresh());
            }
          },
        },
        child: Focus(
          child: MacosPageScaffold(
            title: 'Self-improvement',
            description:
                'Asael investigates, repairs and verifies its own work.',
            icon: Icons.auto_fix_high_outlined,
            actions: [
              IconButton(
                key: const Key('improvement-refresh'),
                tooltip: 'Refresh improvement status',
                onPressed: controller.loading || controller.acting
                    ? null
                    : _refresh,
                icon: const Icon(Icons.refresh_rounded),
              ),
              if (!_editing && snapshot != null)
                IconButton(
                  key: const Key('improvement-settings'),
                  tooltip: 'Improvement settings',
                  onPressed: _canAct && snapshot.githubConfigured
                      ? _settings
                      : null,
                  icon: const Icon(Icons.tune_rounded),
                ),
            ],
            body: Column(
              children: [
                if (controller.loading || controller.acting)
                  const LinearProgressIndicator(minHeight: 2),
                if (_decisionError != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: ImprovementNotice(_decisionError!, error: true),
                  ),
                if (controller.error != null ||
                    (!controller.loading &&
                        snapshot != null &&
                        controller.refreshRequired))
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: ImprovementNotice(
                      controller.refreshRequired
                          ? 'Fresh state is required. The last read or action could not be confirmed. Refresh before another decision; nothing will be replayed automatically. ${controller.error ?? ''}'
                          : controller.error!,
                      error: true,
                    ),
                  ),
                if (controller.lastOutcome != null &&
                    !controller.refreshRequired)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: ImprovementNotice(_outcome(controller.lastOutcome!)),
                  ),
                Expanded(
                  child: _editing
                      ? SelfImprovementSettings(
                          key: ValueKey(('settings', configuration?.id)),
                          controller: controller,
                          configuration: configuration,
                          onClose: () => setState(() => _editing = false),
                        )
                      : snapshot == null
                      ? _empty(
                          controller.loading
                              ? 'Reading improvement status…'
                              : 'Improvement status is unavailable',
                          controller.loading
                              ? 'Your saved settings and history will appear here.'
                              : 'Refresh to read the current state. No new work has been started.',
                        )
                      : Column(
                          children: [
                            _summary(context, snapshot, configuration, active),
                            const Divider(height: 1),
                            Expanded(
                              child: configuration == null && cycles.isEmpty
                                  ? _empty(
                                      'Give Asael time to improve',
                                      'Choose a work project, a budget and a daily schedule. Its investigations and evidence will stay here.',
                                      action: FilledButton(
                                        onPressed:
                                            _canAct && snapshot.githubConfigured
                                            ? _settings
                                            : null,
                                        child: const Text(
                                          'Set up daily improvement',
                                        ),
                                      ),
                                    )
                                  : LayoutBuilder(
                                      builder: (context, constraints) {
                                        final wide =
                                            constraints.maxWidth >= 860 &&
                                            MediaQuery.textScalerOf(context)
                                                    .scale(16) <=
                                                24;
                                        final detail = _detail(
                                          context,
                                          selected,
                                          selectedId,
                                          configuration,
                                          active,
                                          showBack: !wide,
                                        );
                                        return wide
                                            ? Row(
                                                crossAxisAlignment:
                                                    CrossAxisAlignment.stretch,
                                                children: [
                                                  SizedBox(
                                                    width: 282,
                                                    child: _ledger(
                                                      context,
                                                      visibleCycles,
                                                      selectedId,
                                                    ),
                                                  ),
                                                  const VerticalDivider(
                                                    width: 1,
                                                  ),
                                                  Expanded(child: detail),
                                                ],
                                              )
                                            : _showDetail
                                            ? detail
                                            : _ledger(
                                                context,
                                                visibleCycles,
                                                selectedId,
                                              );
                                      },
                                    ),
                            ),
                          ],
                        ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  Widget _summary(
    BuildContext context,
    SelfImprovementSnapshot snapshot,
    SelfImprovementConfiguration? configuration,
    bool active,
  ) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 14, 24, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (configuration != null) ...[
            if (snapshot.configurations.length > 1)
              DropdownButton<String>(
                value: configuration.id,
                isExpanded: true,
                items: [
                  for (var i = 0; i < snapshot.configurations.length; i++)
                    DropdownMenuItem(
                      value: snapshot.configurations[i].id,
                      child: Text('Improvement schedule ${i + 1}'),
                    ),
                ],
                onChanged: (id) => setState(() => _configurationId = id),
              ),
            Wrap(
              spacing: 20,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  configuration.paused
                      ? 'New cycles paused'
                      : 'Daily at ${configuration.dailyHour.toString().padLeft(2, '0')}:00 · ${configuration.timeZone}',
                  style: theme.textTheme.titleSmall,
                ),
                Text(
                  '${improvementMoney(configuration.policy.dailyBudgetUsd)} / UTC day · ${improvementMoney(configuration.policy.maxCycleBudgetUsd)} / cycle',
                  style: theme.textTheme.bodyMedium,
                ),
                FilledButton.icon(
                  key: const Key('improvement-run'),
                  onPressed: _canAct && !configuration.paused && !active
                      ? () => unawaited(
                          _decide(() => controller.run(configuration)),
                        )
                      : null,
                  icon: const Icon(Icons.play_arrow_rounded, size: 18),
                  label: const Text('Run now'),
                ),
                OutlinedButton(
                  key: const Key('improvement-pause'),
                  onPressed: _canAct
                      ? () => unawaited(
                          _decide(
                            () => controller.setPaused(
                              configuration,
                              !configuration.paused,
                            ),
                          ),
                        )
                      : null,
                  child: Text(
                    configuration.paused
                        ? 'Resume schedule'
                        : 'Pause new cycles',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              configuration.paused
                  ? 'Pausing stops new cycles. Existing work and release evidence remain available.'
                  : 'Next scheduled check: ${improvementDate(context, configuration.nextDueAt)}.',
              style: theme.textTheme.bodySmall,
            ),
            if (!configuration.policy.notifyOutcomes)
              Text(
                'Outcome notifications are off for new cycles.',
                style: theme.textTheme.bodySmall,
              ),
          ],
          if (!snapshot.githubConfigured)
            const ImprovementNotice(
              'The source repository connection is unavailable. Existing history remains readable; setup needs the connection restored.',
            ),
          _publisher(context, snapshot.controller),
        ],
      ),
    );
  }

  Widget _publisher(
    BuildContext context,
    SelfImprovementControllerPresence presence,
  ) {
    final label = switch (presence.status) {
      'online' =>
        presence.activity == 'held'
            ? 'Mac publisher needs attention'
            : 'Mac publisher online',
      'offline' => 'Mac publisher offline',
      _ => 'Mac publisher not connected',
    };
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      dense: true,
      leading: Icon(
        presence.status == 'online' && presence.activity != 'held'
            ? Icons.cloud_done_outlined
            : Icons.cloud_off_outlined,
        size: 18,
      ),
      title: Text(label, style: Theme.of(context).textTheme.labelLarge),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (presence.lastSeenAt != null)
                Text(
                  'Last contact: ${improvementDate(context, presence.lastSeenAt)}.',
                ),
              if (presence.category != null)
                Text(improvementHoldMessage(presence.category!)),
              const SizedBox(height: 6),
              const Text(
                'Publishing needs the enrolled background service on this Mac, its accepted policy and a network connection. This status reports its last heartbeat.',
              ),
              const SizedBox(height: 6),
              const Text(
                'Closing Asael does not stop background work. Use Pause new cycles to stop new investigations.',
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ],
    );
  }

  Widget _ledger(
    BuildContext context,
    List<SelfImprovementCycle> cycles,
    String? selectedId,
  ) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Cycle history',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            TextField(
              key: nativeUpdateTransientSearchKey,
              controller: _search,
              decoration: const InputDecoration(
                hintText: 'Find a cycle',
                prefixIcon: Icon(Icons.search, size: 18),
              ),
              onChanged: (value) => setState(() => _query = value),
            ),
          ],
        ),
      ),
      Expanded(
        child: cycles.isEmpty
            ? _empty(
                _query.isNotEmpty ? 'No matching cycles' : 'No cycles yet',
                _query.isNotEmpty ? 'Try another search.' : 'The first investigation will appear after its scheduled start or Run now.',
              )
            : ListView.separated(
                key: const PageStorageKey('improvement-cycle-ledger'),
                itemCount: cycles.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, index) {
                  final cycle = cycles[index],
                      selected = cycle.id == selectedId;
                  return ListTile(
                    key: ValueKey('improvement-cycle-${cycle.id}'),
                    selected: selected,
                    selectedTileColor: MacosThemeColors.of(context).selection,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 8,
                    ),
                    title: ImprovementStatus(cycle.stage),
                    subtitle: Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            cycle.summary.isEmpty
                                ? 'Investigation in progress'
                                : cycle.summary,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 5),
                          Text(
                            '${improvementDate(context, cycle.createdAt)} · ${cycle.usageState == 'known' ? improvementMoney(cycle.spendUsd) : 'Cost pending'}',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    onTap: () => setState(() {
                      _selectedId = cycle.id;
                      _showDetail = true;
                    }),
                  );
                },
              ),
      ),
    ],
  );

  Widget _detail(
    BuildContext context,
    SelfImprovementCycle? cycle,
    String? selectedId,
    SelfImprovementConfiguration? configuration,
    bool active, {
    required bool showBack,
  }) {
    if (cycle == null) {
      return _empty(
        selectedId == null ? 'Select a cycle' : 'This cycle is unavailable',
        selectedId == null
            ? 'Its investigation, checks and release result appear here.'
            : 'The requested cycle could not be read for this account. Refresh to check again.',
        action: showBack
            ? TextButton(
                onPressed: () => setState(() => _showDetail = false),
                child: const Text('Back to history'),
              )
            : null,
      );
    }
    final matchingConfig = configuration?.id == cycle.configurationId
        ? configuration
        : _findConfiguration(
            controller.snapshot?.configurations ?? [],
            cycle.configurationId,
          );
    return SingleChildScrollView(
      key: ValueKey('improvement-detail-${cycle.id}'),
      padding: const EdgeInsets.all(24),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 860),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (showBack)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: TextButton.icon(
                    onPressed: () => setState(() => _showDetail = false),
                    icon: const Icon(Icons.arrow_back, size: 18),
                    label: const Text('Cycle history'),
                  ),
                ),
              ImprovementCycleEvidence(
                cycle: cycle,
                onStopNativeCheck: _canAct && cycle.canStopNativeCheck
                    ? () => unawaited(
                        _decide(() => controller.stopNativeCheck(cycle)),
                      )
                    : null,
                onApprove: _canAct && cycle.canApprove
                    ? () => unawaited(
                        _decide(() => controller.review(cycle, 'approve')),
                      )
                    : null,
                onReject: _canAct && cycle.canApprove
                    ? () => unawaited(
                        _decide(() => controller.review(cycle, 'reject')),
                      )
                    : null,
                onDiscard: _canAct && cycle.discardAvailable && cycle.canReject
                    ? () => unawaited(
                        _decide(() => controller.review(cycle, 'reject')),
                      )
                    : null,
                onRetry:
                    _canAct &&
                        !active &&
                        matchingConfig != null &&
                        !matchingConfig.paused &&
                        cycle.canRetrySetup
                    ? () => unawaited(
                        _decide(
                          () => controller.retrySetup(matchingConfig, cycle),
                        ),
                      )
                    : null,
                onOpenRun: widget.onOpenRun,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _empty(String title, String description, {Widget? action}) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(description),
            if (action != null)
              Padding(padding: const EdgeInsets.only(top: 16), child: action),
          ],
        ),
      ),
    ),
  );
  SelfImprovementCycle? _findCycle(
    List<SelfImprovementCycle> values,
    String? id,
  ) {
    for (final value in values) {
      if (value.id == id) return value;
    }
    return null;
  }

  SelfImprovementConfiguration? _findConfiguration(
    List<SelfImprovementConfiguration> values,
    String? id,
  ) {
    for (final value in values) {
      if (value.id == id) return value;
    }
    return null;
  }

  String _outcome(String value) => switch (value) {
    'configure' => 'Settings saved. Policy changes still require matching publisher enrollment.',
    'pause' => 'Schedule state saved.',
    'review' => 'Your decision was recorded for this exact repair.',
    'stop_native_check' =>
      'The held Mac check was stopped. Its evidence is retained.',
    'manual_release_required' =>
      'Your review was recorded. A trusted operator must publish this repair.',
    'claimed' || 'run' || 'retry' =>
      'The cycle request was accepted. Its recorded state is shown below.',
    'duplicate' =>
      'This request was already recorded. Its saved state is shown below.',
    _ => 'Request outcome: ${improvementLabel(value)}.',
  };
}
