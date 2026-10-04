import 'package:flutter/material.dart';

import '../../core/network/native_workspace_access.dart';
import 'meetings_calendar_controller.dart';
import 'meetings_widgets.dart';

class MeetingCalendarPanel extends StatefulWidget {
  const MeetingCalendarPanel({
    super.key,
    required this.controller,
    this.active = true,
  });
  final MeetingCalendarController controller;
  final bool active;
  @override
  State<MeetingCalendarPanel> createState() => _MeetingCalendarPanelState();
}

class _MeetingCalendarPanelState extends State<MeetingCalendarPanel>
    with WidgetsBindingObserver {
  bool _reviewing = false;
  bool get _foreground =>
      WidgetsBinding.instance.lifecycleState == null ||
      WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  void _activate() {
    if (mounted) {
      widget.controller.setActive(widget.active && _foreground);
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _activate());
  }

  @override
  void didUpdateWidget(covariant MeetingCalendarPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.setActive(false);
    }
    if (oldWidget.controller != widget.controller ||
        oldWidget.active != widget.active) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _activate());
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _activate();
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.setActive(false);
    super.dispose();
  }

  Future<void> _review() async {
    if (_reviewing) {
      return;
    }
    final controller = widget.controller;
    setState(() => _reviewing = true);
    try {
      await controller.refresh();
      if (!mounted ||
          !identical(widget.controller, controller) ||
          !controller.canSync) {
        return;
      }
      final reviewed = controller.status!, connection = reviewed.connection!;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Sync Google Calendar?'),
          content: SingleChildScrollView(
            child: Text(
              'Account: ${connection.email}\nAuthorization generation: ${connection.generation}\n\n'
              'Import Calendar events into your personal workspace. This destination is independent of the Meeting workspace currently selected. '
              'A sync may import or remove Calendar sources. The saved receipt will report the observed result.',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Sync Calendar'),
            ),
          ],
        ),
      );
      if (confirmed == true &&
          mounted &&
          identical(widget.controller, controller) &&
          controller.canSync) {
        await controller.submit(reviewed);
      }
    } finally {
      if (mounted) {
        setState(() => _reviewing = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller,
          connection = controller.status?.connection;
      final settlement = controller.result?.sync.settlement;
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Google Calendar',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              const Text(
                'Calendar events sync into your personal workspace, independently of the selected Meeting workspace.',
              ),
              if (!controller.available)
                const Text(
                  'Unlock and restore the current account session to read Calendar status.',
                )
              else if (controller.loading)
                const Text(
                  'Reading the connected account and Calendar coverage…',
                )
              else if (controller.status != null && connection == null)
                const Text(
                  'No Google Calendar connection is available for this account.',
                ),
              if (connection != null) ...[
                Text('Account: ${connection.email}'),
                Text(
                  'Authorization generation ${connection.generation} · ${connection.ready ? 'Calendar read access available' : 'Calendar authorization needs attention'}',
                ),
                if (connection.raw['lastSyncedAt'] != null)
                  Text(
                    'Last connection sync: ${connection.raw['lastSyncedAt']}',
                  ),
                if (connection.raw['coverage'] != null)
                  Text(
                    'Calendar coverage: ${(connection.raw['coverage'] as Map)['status']} · backfill ${(connection.raw['coverage'] as Map)['backfillState']}',
                  ),
              ],
              if (settlement != null) ...[
                const SizedBox(height: 8),
                Text('Recorded Calendar result: ${settlement['status']}'),
                Text(
                  '${settlement['imported']} imported · ${settlement['removed']} removed · cursor ${settlement['cursorAdvanced'] == true ? 'advanced' : 'not advanced'}',
                ),
                Text(
                  'Backfill: ${(settlement['coverage'] as Map)['backfillState']} · observed ${settlement['settledAt']}',
                ),
              ],
              if (controller.uncertain)
                const MeetingNotice(
                  'A previous Calendar request has no confirmed completion. Further syncs are held; recovery only reads that exact request.',
                ),
              if (controller.error != null)
                MeetingNotice(controller.error!, error: true),
              if (controller.storageError != null)
                MeetingNotice(controller.storageError!, error: true),
              if (controller.owner?.canManage == false)
                const Text(
                  'An operator or administrator role is required to start a Calendar sync.',
                ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton(
                    onPressed:
                        controller.canRead &&
                            !controller.loading &&
                            !controller.busy &&
                            !controller.recovering
                        ? controller.refresh
                        : null,
                    child: const Text('Refresh Calendar'),
                  ),
                  FilledButton(
                    onPressed: controller.canSync && !_reviewing
                        ? _review
                        : null,
                    child: Text(
                      controller.busy
                          ? 'Saving sync request…'
                          : _reviewing
                          ? 'Reviewing account…'
                          : 'Sync Calendar',
                    ),
                  ),
                  if (controller.uncertain)
                    OutlinedButton(
                      onPressed: controller.canRecover
                          ? controller.recover
                          : null,
                      child: Text(
                        controller.recovering
                            ? 'Reading exact receipt…'
                            : 'Check exact sync receipt',
                      ),
                    ),
                  if (controller.recoveryBlocked)
                    OutlinedButton(
                      onPressed:
                          controller.available &&
                              !controller.busy &&
                              !controller.recovering &&
                              !controller.loading
                          ? controller.reloadRecovery
                          : null,
                      child: const Text('Reload protected recovery'),
                    ),
                  if (controller.available &&
                      controller.status != null &&
                      (connection == null || !connection.ready))
                    const NativeWorkspaceBrowserButton(
                      path: '/app/connectors',
                      label: 'Connect or authorize Google',
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
