import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/native_workspace_access.dart';
import '../capture/entity_options.dart';
import 'listen_bridge.dart';
import 'listen_controller.dart';
import 'listen_detail.dart';
import 'listen_settings.dart';

class ListenWorkspace extends ConsumerStatefulWidget {
  const ListenWorkspace({super.key});
  @override
  ConsumerState<ListenWorkspace> createState() => _ListenWorkspaceState();
}

class _ListenWorkspaceState extends ConsumerState<ListenWorkspace>
    with WidgetsBindingObserver {
  final _title = TextEditingController();
  String _category = 'unfiled', _query = '';
  AuthorizedEntitySelection? _client;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(listenControllerProvider).refresh();
    });
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (!mounted ||
          WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
        return;
      }
      final location = GoRouter.of(context)
          .routerDelegate
          .currentConfiguration
          .uri;
      if (location.path != '/capture' ||
          location.queryParameters['section'] != 'listen') {
        return;
      }
      final controller = ref.read(listenControllerProvider);
      final processing =
          controller.conversations.any(
            (row) => !{'ready', 'error', 'failed'}.contains(row['status']),
          ) ||
          listenRows(controller.status?['sessions']).any(
            (row) =>
                {'uploading', 'queued', 'processing'}.contains(row['state']),
          );
      if (processing) controller.refresh();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    _title.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(listenControllerProvider).refresh();
    }
  }

  Future<void> _chooseClient() async {
    final selection = await showNativeEntitySelector(
      context,
      types: {'project'},
    );
    final access = ref.read(nativeWorkspaceAccessProvider);
    if (mounted &&
        access != null &&
        selection?.matchesCurrent(access) == true) {
      setState(() => _client = selection);
    }
  }

  void _start(ListenController controller) {
    final access = ref.read(nativeWorkspaceAccessProvider);
    if (access == null || !access.current) return;
    final project =
        _category == 'work' && _client?.matchesCurrent(access) == true
        ? _client!.option.id
        : null;
    controller.action(
      'startListen',
      grant: true,
      arguments: {
        'title': _title.text.trim(),
        'contextCategory': _category,
        'projectId': ?project,
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(listenControllerProvider);
    final scheme = Theme.of(context).colorScheme;
    final active = controller.activeSession;
    final local = listenRows(controller.status?['sessions'])
        .where(
          (row) => !{
            'ready',
            'listening',
            'paused',
            'interrupted',
          }.contains(row['state']),
        )
        .toList();
    final rows = controller.conversations
        .where(
          (row) => '${listenText(row['title'])} ${listenText(row['summary'])}'
              .toLowerCase()
              .contains(_query.toLowerCase()),
        )
        .toList();
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: controller.refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 48),
          children: [
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1000),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.hearing_rounded, size: 26),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            'Listen',
                            style: Theme.of(context).textTheme.headlineSmall,
                          ),
                        ),
                        IconButton(
                          tooltip: 'Refresh conversations',
                          onPressed: controller.loading
                              ? null
                              : controller.refresh,
                          icon: const Icon(Icons.refresh_rounded),
                        ),
                        if (controller.supported)
                          IconButton(
                            tooltip: 'Nightly call notes',
                            onPressed: () =>
                                context.go('/settings?section=listening'),
                            icon: const Icon(Icons.schedule_rounded),
                          ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Be in the conversation. Come back to what matters.',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 20),
                    if (controller.supported)
                      ListenSurface(
                        child: active == null
                            ? Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  Text(
                                    'Capture a conversation',
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleLarge,
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    'Listen records with your phone’s microphone, including while the screen is locked. ATLAS stays quiet.',
                                    style: TextStyle(
                                      color: scheme.onSurfaceVariant,
                                    ),
                                  ),
                                  const SizedBox(height: 20),
                                  TextField(
                                    controller: _title,
                                    maxLength: 160,
                                    decoration: const InputDecoration(
                                      labelText:
                                          'Conversation title (optional)',
                                      counterText: '',
                                      hintText: 'For example, Client catch-up',
                                    ),
                                  ),
                                  const SizedBox(height: 12),
                                  DropdownButtonFormField<String>(
                                    initialValue: _category,
                                    decoration: const InputDecoration(
                                      labelText: 'Save with',
                                      prefixIcon: Icon(Icons.folder_outlined),
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
                                    onChanged: (value) => setState(() {
                                      _category = value ?? 'unfiled';
                                      _client = null;
                                    }),
                                  ),
                                  if (_category == 'work')
                                    Padding(
                                      padding: const EdgeInsets.only(top: 8),
                                      child: OutlinedButton.icon(
                                        onPressed: _chooseClient,
                                        icon: const Icon(
                                          Icons.business_outlined,
                                        ),
                                        label: Text(
                                          _client?.option.label ?? 'Choose a client or project (optional)',
                                        ),
                                      ),
                                    ),
                                  const SizedBox(height: 16),
                                  Text(
                                    'Starting Listen allows Asael to process this audio in the cloud into notes, follow-ups and memory. Let people know you’re recording.',
                                    style: Theme.of(context).textTheme.bodySmall
                                        ?.copyWith(
                                          color: scheme.onSurfaceVariant,
                                        ),
                                  ),
                                  const SizedBox(height: 16),
                                  if (controller.status?['microphoneGranted'] !=
                                          true ||
                                      controller
                                              .status?['notificationsGranted'] !=
                                          true)
                                    OutlinedButton.icon(
                                      onPressed:
                                          controller.busy ||
                                              !controller.canManage
                                          ? null
                                          : () => controller.action(
                                              'requestPermissions',
                                            ),
                                      icon: const Icon(Icons.mic_none_rounded),
                                      label: const Text(
                                        'Allow microphone & recording controls',
                                      ),
                                    ),
                                  FilledButton.icon(
                                    onPressed:
                                        controller.busy ||
                                            !controller.canManage ||
                                            controller
                                                    .status?['microphoneGranted'] !=
                                                true ||
                                            controller
                                                    .status?['notificationsGranted'] !=
                                                true
                                        ? null
                                        : () => _start(controller),
                                    icon: const Icon(Icons.mic_rounded),
                                    label: const Text('Start listening'),
                                  ),
                                ],
                              )
                            : _ActiveRecording(
                                controller: controller,
                                session: active,
                              ),
                      ),
                    if (!controller.supported)
                      const ListenSurface(
                        child: Text(
                          'Start Listen on your Android phone. Your processed conversations are available here and to ATLAS across your devices.',
                        ),
                      ),
                    if (controller.error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 16),
                        child: Text(
                          controller.error!,
                          style: TextStyle(color: scheme.error),
                        ),
                      ),
                    if (controller.loading)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 16),
                        child: LinearProgressIndicator(),
                      ),
                    if (local.isNotEmpty) ...[
                      const SizedBox(height: 24),
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              'On this phone',
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                          ),
                          TextButton.icon(
                            onPressed: controller.busy
                                ? null
                                : () => controller.action(
                                    'uploadNow',
                                    grant: true,
                                  ),
                            icon: const Icon(
                              Icons.cloud_upload_outlined,
                              size: 18,
                            ),
                            label: const Text('Sync now'),
                          ),
                        ],
                      ),
                      for (final row in local)
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(
                            row['sourceKind'] == 'call'
                                ? Icons.call_outlined
                                : Icons.mic_none_rounded,
                          ),
                          title: Text(listenText(row['title'], 'Conversation')),
                          subtitle: Text(
                            '${listenState(row['state'])} · ${listenDuration(row['durationMs'])}'
                            '${listenText(row['message']).isEmpty ? '' : '\n${listenText(row['message'])}'}',
                          ),
                        ),
                    ],
                    const SizedBox(height: 28),
                    Text(
                      'Your conversations',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Summaries, people, decisions and follow-ups—with the words they came from.',
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                    if (controller.conversations.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      TextField(
                        onChanged: (value) => setState(() => _query = value),
                        decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.search_rounded),
                          hintText: 'Find a conversation',
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    if (rows.isEmpty && !controller.loading)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 24),
                        child: Text(
                          _query.isEmpty
                              ? 'Your conversation notes will appear here after processing. Record a conversation or enable Nightly call notes.'
                              : 'No conversations match that search.',
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                      ),
                    for (final row in rows)
                      _ConversationRow(
                        row: row,
                        onTap: () {
                          final access = ref.read(
                            nativeWorkspaceAccessProvider,
                          );
                          if (access == null || !access.current) return;
                          Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ListenDetail(
                                access: access,
                                id: listenText(row['id']),
                              ),
                            ),
                          );
                        },
                      ),
                    if (controller.supported) ...[
                      const SizedBox(height: 24),
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.nights_stay_outlined),
                        title: const Text('Nightly call notes'),
                        subtitle: Text(
                          controller.status?['callsEnabled'] == true
                              ? 'Enabled · scheduled for 11:30 PM India time'
                              : 'Turn today’s recorded calls into useful context.',
                        ),
                        trailing: const Icon(Icons.chevron_right_rounded),
                        onTap: () => context.go('/settings?section=listening'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActiveRecording extends StatelessWidget {
  const _ActiveRecording({required this.controller, required this.session});
  final ListenController controller;
  final ListenJson session;
  @override
  Widget build(BuildContext context) {
    final listening = session['state'] == 'listening';
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(
              listening
                  ? Icons.graphic_eq_rounded
                  : Icons.pause_circle_outline_rounded,
              color: scheme.primary,
              size: 30,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    listening ? 'Listening now' : 'Listening paused',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  Text(listenText(session['title'], 'Conversation')),
                ],
              ),
            ),
            Text(
              listenDuration(session['elapsedMs']),
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ],
        ),
        const SizedBox(height: 16),
        Text(
          listenText(
            session['reason'],
            listening
                ? 'Your audio is saved on this phone as you go. You can lock the screen and continue.'
                : 'The microphone is off. Resume when you’re ready.',
          ),
        ),
        const SizedBox(height: 20),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: controller.busy
                  ? null
                  : () => controller.action(
                      listening ? 'pauseListen' : 'resumeListen',
                    ),
              icon: Icon(listening ? Icons.pause_rounded : Icons.mic_rounded),
              label: Text(listening ? 'Pause' : 'Resume'),
            ),
            FilledButton.icon(
              onPressed: controller.busy
                  ? null
                  : () => controller.action('stopListen'),
              icon: const Icon(Icons.stop_rounded),
              label: const Text('Finish & make notes'),
            ),
          ],
        ),
      ],
    );
  }
}

class _ConversationRow extends StatelessWidget {
  const _ConversationRow({required this.row, required this.onTap});
  final ListenJson row;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      ListTile(
        contentPadding: const EdgeInsets.symmetric(vertical: 8),
        leading: Icon(
          row['sourceKind'] == 'call'
              ? Icons.call_outlined
              : Icons.forum_outlined,
        ),
        title: Text(
          listenText(row['title'], 'Conversation'),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${listenDate(row['recordedAt'] ?? row['createdAt'])} · ${listenState(row['status'])}',
              ),
              if (listenText(row['summary']).isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    listenText(row['summary']),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              if (listenInt(row['actionCount']) > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    '${listenInt(row['actionCount'])} follow-ups to review',
                  ),
                ),
            ],
          ),
        ),
        trailing: const Icon(Icons.chevron_right_rounded),
        onTap: onTap,
      ),
      const Divider(height: 1),
    ],
  );
}

String listenState(Object? value) => switch (value) {
  'listening' => 'Listening',
  'paused' => 'Paused',
  'interrupted' => 'Paused',
  'queued' || 'pending' => 'Saved · waiting to sync',
  'uploading' => 'Syncing audio',
  'processing' || 'transcribing' || 'extracting' => 'Preparing your notes',
  'ready' || 'completed' => 'Ready',
  'error' || 'failed' => 'Needs attention',
  _ => 'Preparing your notes',
};

String listenDuration(Object? value) {
  final duration = Duration(milliseconds: listenInt(value));
  final minutes = duration.inMinutes, seconds = duration.inSeconds % 60;
  return minutes >= 60
      ? '${minutes ~/ 60}h ${minutes % 60}m'
      : '$minutes:${seconds.toString().padLeft(2, '0')}';
}

String listenDate(Object? value) {
  final date = DateTime.tryParse(listenText(value))?.toLocal();
  if (date == null) return 'Recently';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final hour = date.hour % 12 == 0 ? 12 : date.hour % 12;
  return '${date.day} ${months[date.month - 1]} · $hour:${date.minute.toString().padLeft(2, '0')} ${date.hour < 12 ? 'AM' : 'PM'}';
}
