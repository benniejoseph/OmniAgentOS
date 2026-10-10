import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'listen_bridge.dart';
import 'listen_controller.dart';
import 'listen_view.dart';

class ListenSurface extends StatelessWidget {
  const ListenSurface({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
    ),
    child: child,
  );
}

class ListenSettingsLink extends StatelessWidget {
  const ListenSettingsLink({super.key});
  @override
  Widget build(BuildContext context) => ListTile(
    contentPadding: EdgeInsets.zero,
    leading: const Icon(Icons.nights_stay_outlined),
    title: const Text('Nightly call notes'),
    subtitle: const Text('Recorded calls, summaries and memory · 11:30 PM'),
    trailing: const Icon(Icons.chevron_right_rounded),
    onTap: () => context.go('/settings?section=listening'),
  );
}

class ListenSettingsPage extends ConsumerStatefulWidget {
  const ListenSettingsPage({super.key});
  @override
  ConsumerState<ListenSettingsPage> createState() => _ListenSettingsPageState();
}

class _ListenSettingsPageState extends ConsumerState<ListenSettingsPage>
    with WidgetsBindingObserver {
  bool _consent = false;
  String _category = 'unfiled';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(listenControllerProvider).refresh();
    }
  }

  Future<void> _removeFolder(ListenController controller) async {
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove recorded calls access?'),
        content: const Text(
          'Nightly imports will stop. This does not delete your phone’s original recordings or notes already saved in Asael.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep access'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove access'),
          ),
        ],
      ),
    );
    if (accepted == true && mounted) {
      await controller.action('removeCallFolder');
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(listenControllerProvider);
    final status = controller.status ?? <String, dynamic>{};
    final enabled = status['callsEnabled'] == true;
    final selected = status['callFolderSelected'] == true;
    final scheme = Theme.of(context).colorScheme;
    final available = controller.canManage && !controller.busy;
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back to Settings',
          onPressed: () => context.go('/settings'),
          icon: const Icon(Icons.arrow_back_rounded),
        ),
        title: const Text('Nightly call notes'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 800),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.nights_stay_outlined,
                        size: 28,
                        color: scheme.primary,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          'A quieter end to your day',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Asael checks your recorded calls at 11:30 PM India time and turns new recordings into transcripts, summaries, people and relationship context, topics and follow-ups. Useful context becomes available to ATLAS in Memory and Knowledge.',
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Android may delay background work. Missed calls and calls that finish after the evening check are picked up on the next run. Your phone’s original recordings stay in their folder.',
                    style: TextStyle(color: scheme.onSurfaceVariant),
                  ),
                  const SizedBox(height: 24),
                  if (!controller.supported)
                    const ListenSurface(
                      child: Text(
                        'Set this up on your Android phone. The notes it creates are available on all your devices.',
                      ),
                    ),
                  if (controller.supported) ...[
                    ListenSurface(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              const Icon(Icons.folder_outlined),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'Recorded calls folder',
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium,
                                    ),
                                    Text(
                                      selected
                                          ? listenText(
                                              status['callFolderName'],
                                              'Folder connected',
                                            )
                                          : 'Not connected',
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          const Text(
                            'Choose Recordings → Call, or the folder used by your call recorder. Android will ask you to allow access to that folder.',
                          ),
                          const SizedBox(height: 12),
                          OutlinedButton.icon(
                            onPressed: available
                                ? () => controller.action(
                                    'chooseCallFolder',
                                    grant: true,
                                  )
                                : null,
                            icon: const Icon(Icons.create_new_folder_outlined),
                            label: Text(
                              selected
                                  ? 'Change folder'
                                  : 'Choose recorded calls folder',
                            ),
                          ),
                          if (selected)
                            TextButton(
                              onPressed: available
                                  ? () => _removeFolder(controller)
                                  : null,
                              child: const Text('Remove folder access'),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    ListenSurface(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              const Icon(Icons.schedule_rounded),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'Every evening · 11:30 PM',
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium,
                                    ),
                                    const Text('India time'),
                                  ],
                                ),
                              ),
                              if (enabled) const Chip(label: Text('Enabled')),
                            ],
                          ),
                          const SizedBox(height: 16),
                          if (!enabled) ...[
                            DropdownButtonFormField<String>(
                              initialValue: _category,
                              decoration: const InputDecoration(
                                labelText: 'Call context',
                              ),
                              items: const [
                                DropdownMenuItem(
                                  value: 'unfiled',
                                  child: Text('Choose later'),
                                ),
                                DropdownMenuItem(
                                  value: 'personal',
                                  child: Text('Personal'),
                                ),
                                DropdownMenuItem(
                                  value: 'work',
                                  child: Text('Work'),
                                ),
                              ],
                              onChanged: (value) => setState(
                                () => _category = value ?? 'unfiled',
                              ),
                            ),
                            const SizedBox(height: 8),
                            CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              controlAffinity: ListTileControlAffinity.leading,
                              value: _consent,
                              onChanged: (value) =>
                                  setState(() => _consent = value ?? false),
                              title: const Text(
                                'Automatically process my recorded calls',
                              ),
                              subtitle: const Text(
                                'Allow cloud transcription and analysis, with summaries and supported context saved to Memory and Knowledge. The first check starts with today’s calls.',
                              ),
                            ),
                            const SizedBox(height: 8),
                            FilledButton.icon(
                              onPressed: available && selected && _consent
                                  ? () => controller.action(
                                      'configureCalls',
                                      grant: true,
                                      arguments: {
                                        'enabled': true,
                                        'timeZone': 'Asia/Kolkata',
                                        'hour': 23,
                                        'minute': 30,
                                        'contextCategory': _category,
                                      },
                                    )
                                  : null,
                              icon: const Icon(Icons.nights_stay_outlined),
                              label: const Text('Enable nightly call notes'),
                            ),
                          ] else ...[
                            const Text(
                              'New recordings are processed automatically. Repeated checks skip calls already imported.',
                            ),
                            const SizedBox(height: 12),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                FilledButton.tonalIcon(
                                  onPressed: available
                                      ? () => controller.action(
                                          'scanCallsNow',
                                          grant: true,
                                        )
                                      : null,
                                  icon: const Icon(Icons.refresh_rounded),
                                  label: const Text('Check now'),
                                ),
                                TextButton(
                                  onPressed: available
                                      ? () => controller.action(
                                          'configureCalls',
                                          arguments: {
                                            'enabled': false,
                                            'timeZone': 'Asia/Kolkata',
                                            'hour': 23,
                                            'minute': 30,
                                          },
                                        )
                                      : null,
                                  child: const Text('Turn off nightly imports'),
                                ),
                              ],
                            ),
                          ],
                          if (listenText(status['lastScanAt']).isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 16),
                              child: Text(
                                'Last checked ${listenDate(status['lastScanAt'])}',
                              ),
                            ),
                          if (listenText(status['nextScanAt']).isNotEmpty &&
                              enabled)
                            Padding(
                              padding: const EdgeInsets.only(top: 4),
                              child: Text(
                                'Next scheduled check ${listenDate(status['nextScanAt'])}',
                              ),
                            ),
                          if (listenText(status['scanMessage']).isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Text(listenText(status['scanMessage'])),
                            ),
                          if (status['scanState'] == 'scanning' ||
                              controller.busy)
                            const Padding(
                              padding: EdgeInsets.only(top: 12),
                              child: LinearProgressIndicator(),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (controller.error != null)
                      Text(
                        controller.error!,
                        style: TextStyle(color: scheme.error),
                      ),
                    if (enabled && status['accessReady'] != true)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: OutlinedButton.icon(
                          onPressed: available
                              ? () =>
                                    controller.action('uploadNow', grant: true)
                              : null,
                          icon: const Icon(Icons.cloud_sync_outlined),
                          label: const Text('Reconnect listening access'),
                        ),
                      ),
                  ],
                  const SizedBox(height: 24),
                  TextButton.icon(
                    onPressed: () => context.go('/capture?section=listen'),
                    icon: const Icon(Icons.forum_outlined),
                    label: const Text('Open conversation notes'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
