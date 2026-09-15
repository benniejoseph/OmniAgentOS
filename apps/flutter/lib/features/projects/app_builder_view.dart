import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'projects.dart';

typedef Json = Map<String, dynamic>;

class AppBuilderView extends StatefulWidget {
  const AppBuilderView({super.key, required this.project, required this.api});
  final Project project;
  final ApiClient api;

  @override
  State<AppBuilderView> createState() => _AppBuilderViewState();
}

class _AppBuilderViewState extends State<AppBuilderView> {
  Json? snapshot, file;
  List<Json> tree = const [];
  final editor = TextEditingController();
  Object? error;
  bool loading = true;
  String? action, commandOutput;

  Json? get session => snapshot?['session'] is Map
      ? Json.from(snapshot!['session'] as Map)
      : null;
  bool get ready => const {'ready', 'running'}.contains(session?['status']);
  bool get dirty => file != null && editor.text != file?['content']?.toString();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    editor.dispose();
    super.dispose();
  }

  Future<void> _load({String? preferredPath}) async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      snapshot = await widget.api.getJson(
        NativePaths.workspacesBuilderGet(widget.project.id),
      );
      if (ready) {
        await _loadTree(
          preferredPath: preferredPath ?? file?['path']?.toString(),
        );
      }
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _loadTree({String? preferredPath}) async {
    final active = session;
    if (active == null) return;
    final response = await widget.api.getJson(
      NativePaths.workspacesBuilderGet(widget.project.id),
      query: {'view': 'tree', 'sessionId': active['id']},
    );
    tree = (response['entries'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList(growable: false);
    final files = tree.where((item) => item['kind'] == 'file').toList();
    final target =
        preferredPath != null &&
            files.any((item) => item['path'] == preferredPath)
        ? preferredPath
        : files.any((item) => item['path'] == 'app/page.tsx')
        ? 'app/page.tsx'
        : files.firstOrNull?['path']?.toString();
    if (target != null) await _loadFile(target);
  }

  Future<void> _loadFile(String path) async {
    final active = session;
    if (active == null) return;
    final response = await widget.api.getJson(
      NativePaths.workspacesBuilderGet(widget.project.id),
      query: {'view': 'file', 'sessionId': active['id'], 'path': path},
    );
    file = response['file'] is Map ? Json.from(response['file'] as Map) : null;
    editor.text = file?['content']?.toString() ?? '';
    if (mounted) setState(() {});
  }

  Future<Json> _mutate(Json data, String purpose) => widget.api.postJson(
    NativePaths.workspacesBuilderUpdate(widget.project.id),
    data: data,
    headers: {
      'idempotency-key':
          'mobile-builder-$purpose-${DateTime.now().microsecondsSinceEpoch}',
    },
  );

  Future<void> _create() async {
    await _act('create', () async {
      snapshot = await _mutate({'action': 'create'}, 'create');
      if (ready) await _loadTree();
    });
  }

  Future<void> _save() async {
    final active = session, selected = file;
    if (active == null || selected == null || !dirty) return;
    await _act('save', () async {
      await _mutate({
        'action': 'file.update',
        'sessionId': active['id'],
        'path': selected['path'],
        'expectedSha256': selected['sha256'],
        'content': editor.text,
      }, 'save');
      await _load(preferredPath: selected['path']?.toString());
    });
  }

  Future<void> _runCommand(String command) async {
    final active = session;
    if (active == null || dirty) return;
    await _act(command, () async {
      final result = await _mutate({
        'action': 'command.run',
        'sessionId': active['id'],
        'command': command,
      }, 'command-$command');
      final output = _map(result['result']);
      commandOutput = [output['stdout'], output['stderr']]
          .where((value) => value?.toString().trim().isNotEmpty ?? false)
          .join('\n');
      if (commandOutput!.isEmpty) {
        commandOutput =
            '$command finished with exit ${output['exitCode'] ?? 'unknown'}.';
      }
      snapshot = await widget.api.getJson(
        NativePaths.workspacesBuilderGet(widget.project.id),
      );
    });
  }

  Future<void> _checkpoint() async {
    final active = session;
    if (active == null || dirty) return;
    await _act('checkpoint', () async {
      snapshot = await _mutate({
        'action': 'checkpoint.create',
        'sessionId': active['id'],
        'expectedSessionRevision': active['revision'],
        'reason': 'manual',
        'label': 'Mobile revision ${active['revision']}',
      }, 'checkpoint');
    });
  }

  Future<void> _restore(Json checkpoint) async {
    final active = session;
    if (active == null || dirty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Restore checkpoint?'),
        content: Text(
          'Restore “${checkpoint['label'] ?? 'saved revision'}”? Asael will keep an automatic safety snapshot of the current files.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Restore'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _act('restore', () async {
      snapshot = await _mutate({
        'action': 'checkpoint.restore',
        'sessionId': active['id'],
        'checkpointId': checkpoint['id'],
        'expectedSessionRevision': active['revision'],
      }, 'restore');
      await _loadTree();
    });
  }

  Future<void> _verify() async {
    final active = session;
    if (active == null || dirty) return;
    await _act('verify', () async {
      final sealed = await _mutate({
        'action': 'checkpoint.create',
        'sessionId': active['id'],
        'expectedSessionRevision': active['revision'],
        'reason': 'before_sentinel',
        'label': 'Mobile verification · revision ${active['revision']}',
      }, 'before-verify');
      final sealedSession = _map(sealed['session']);
      final checkpoint = _map(sealed['checkpoint']);
      final verified = await _mutate({
        'action': 'verification.run',
        'sessionId': sealedSession['id'],
        'checkpointId': checkpoint['id'],
        'expectedSessionRevision': sealedSession['revision'],
      }, 'verify');
      commandOutput = _verificationSummary(_map(verified['verification']));
      snapshot = await widget.api.getJson(
        NativePaths.workspacesBuilderGet(widget.project.id),
      );
    });
  }

  Future<void> _act(String name, Future<void> Function() callback) async {
    setState(() {
      action = name;
      error = null;
    });
    try {
      await callback();
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => action = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (loading && snapshot == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (session == null) {
      return _EmptyBuilder(
        project: widget.project,
        error: error,
        loading: action == 'create',
        onCreate: _create,
        onRetry: _load,
      );
    }
    final checkpoints = (snapshot?['checkpoints'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .toList();
    final activity = (snapshot?['activity'] as List? ?? const [])
        .whereType<Map>()
        .map(Json.from)
        .take(20)
        .toList();
    final width = MediaQuery.sizeOf(context).width;
    return Column(
      children: [
        _BuilderStatus(
          snapshot: snapshot!,
          dirty: dirty,
          busy: action,
          onRefresh: _load,
          onCheckpoint: _checkpoint,
          onVerify: _verify,
        ),
        if (error != null) _BuilderError(error: error!, retry: _load),
        Expanded(
          child: width >= 900
              ? Row(
                  children: [
                    SizedBox(
                      width: 250,
                      child: _FileRail(
                        tree: tree,
                        selectedPath: file?['path']?.toString(),
                        onOpen: dirty ? null : _loadFile,
                      ),
                    ),
                    const VerticalDivider(width: 1),
                    Expanded(
                      child: _Editor(
                        file: file,
                        controller: editor,
                        dirty: dirty,
                        busy: action,
                        output: commandOutput,
                        onChanged: () => setState(() {}),
                        onSave: _save,
                        onCommand: _runCommand,
                      ),
                    ),
                    const VerticalDivider(width: 1),
                    SizedBox(
                      width: 280,
                      child: _RecoveryRail(
                        checkpoints: checkpoints,
                        activity: activity,
                        currentCheckpointId: session?['currentCheckpointId']
                            ?.toString(),
                        onRestore: _restore,
                      ),
                    ),
                  ],
                )
              : _MobileBuilderBody(
                  tree: tree,
                  file: file,
                  controller: editor,
                  dirty: dirty,
                  busy: action,
                  output: commandOutput,
                  checkpoints: checkpoints,
                  activity: activity,
                  currentCheckpointId: session?['currentCheckpointId']
                      ?.toString(),
                  onOpen: dirty ? null : _loadFile,
                  onChanged: () => setState(() {}),
                  onSave: _save,
                  onCommand: _runCommand,
                  onRestore: _restore,
                ),
        ),
      ],
    );
  }
}

class _BuilderStatus extends StatelessWidget {
  const _BuilderStatus({
    required this.snapshot,
    required this.dirty,
    required this.busy,
    required this.onRefresh,
    required this.onCheckpoint,
    required this.onVerify,
  });
  final Json snapshot;
  final bool dirty;
  final String? busy;
  final VoidCallback onRefresh, onCheckpoint, onVerify;
  @override
  Widget build(BuildContext context) {
    final session = _map(snapshot['session']);
    final latestVerification = (snapshot['verifications'] as List? ?? const [])
        .whereType<Map>()
        .firstOrNull;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(
            color: Theme.of(context).colorScheme.outlineVariant,
          ),
        ),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Icon(
            session['status'] == 'ready'
                ? Icons.code_rounded
                : Icons.hourglass_top_rounded,
            color: Theme.of(context).colorScheme.primary,
          ),
          Text(
            'Build Studio · ${_humanize(session['status']?.toString() ?? 'unknown')} · revision ${session['revision'] ?? '—'}',
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          if (dirty) const Chip(label: Text('Unsaved')),
          const SizedBox(width: 6),
          OutlinedButton.icon(
            onPressed: busy == null && !dirty ? onCheckpoint : null,
            icon: const Icon(Icons.bookmark_add_outlined, size: 17),
            label: const Text('Checkpoint'),
          ),
          OutlinedButton.icon(
            onPressed: busy == null && !dirty ? onVerify : null,
            icon: const Icon(Icons.verified_outlined, size: 17),
            label: Text(latestVerification == null ? 'Verify' : 'Verify again'),
          ),
          IconButton(
            tooltip: 'Refresh Build Studio',
            onPressed: busy == null ? onRefresh : null,
            icon: busy == null
                ? const Icon(Icons.refresh_rounded)
                : const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
          ),
        ],
      ),
    );
  }
}

class _FileRail extends StatelessWidget {
  const _FileRail({
    required this.tree,
    required this.selectedPath,
    required this.onOpen,
  });
  final List<Json> tree;
  final String? selectedPath;
  final ValueChanged<String>? onOpen;
  @override
  Widget build(BuildContext context) {
    final files = tree.where((item) => item['kind'] == 'file').toList();
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 6),
          child: Text(
            'FILES · ${files.length}',
            style: Theme.of(context).textTheme.labelMedium,
          ),
        ),
        for (final item in files)
          ListTile(
            dense: true,
            selected: item['path'] == selectedPath,
            leading: const Icon(Icons.insert_drive_file_outlined, size: 18),
            title: Text(
              item['path']?.toString() ?? 'File',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5),
            ),
            onTap: onOpen == null
                ? null
                : () => onOpen!(item['path'].toString()),
          ),
      ],
    );
  }
}

class _Editor extends StatelessWidget {
  const _Editor({
    required this.file,
    required this.controller,
    required this.dirty,
    required this.busy,
    required this.output,
    required this.onChanged,
    required this.onSave,
    required this.onCommand,
  });
  final Json? file;
  final TextEditingController controller;
  final bool dirty;
  final String? busy, output;
  final VoidCallback onChanged, onSave;
  final ValueChanged<String> onCommand;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Container(
        padding: const EdgeInsets.fromLTRB(12, 7, 8, 7),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                file?['path']?.toString() ?? 'Select a file',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            FilledButton.tonalIcon(
              onPressed: dirty && busy == null ? onSave : null,
              icon: busy == 'save'
                  ? const SizedBox.square(
                      dimension: 15,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_outlined, size: 17),
              label: const Text('Save'),
            ),
          ],
        ),
      ),
      Expanded(
        child: file == null
            ? const Center(child: Text('Choose a file from the workspace.'))
            : TextField(
                controller: controller,
                onChanged: (_) => onChanged(),
                expands: true,
                maxLines: null,
                minLines: null,
                keyboardType: TextInputType.multiline,
                textAlignVertical: TextAlignVertical.top,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12.5,
                  height: 1.45,
                ),
                decoration: const InputDecoration(
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.all(14),
                ),
              ),
      ),
      Container(
        width: double.infinity,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerLow,
          border: Border(
            top: BorderSide(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 7,
              runSpacing: 7,
              children: [
                for (final command in const [
                  'lint',
                  'typecheck',
                  'test',
                  'build',
                  'start_preview',
                ])
                  OutlinedButton(
                    onPressed: busy == null && !dirty
                        ? () => onCommand(command)
                        : null,
                    child: Text(
                      busy == command ? 'Running…' : _humanize(command),
                    ),
                  ),
              ],
            ),
            if (output != null) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                constraints: const BoxConstraints(maxHeight: 120),
                padding: const EdgeInsets.all(10),
                color: const Color(0xFF061C1E),
                child: SingleChildScrollView(
                  child: SelectableText(
                    output!,
                    style: const TextStyle(
                      color: Color(0xFFD3E9E2),
                      fontFamily: 'monospace',
                      fontSize: 11,
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    ],
  );
}

class _RecoveryRail extends StatelessWidget {
  const _RecoveryRail({
    required this.checkpoints,
    required this.activity,
    required this.currentCheckpointId,
    required this.onRestore,
  });
  final List<Json> checkpoints, activity;
  final String? currentCheckpointId;
  final ValueChanged<Json> onRestore;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(12),
    children: [
      Text('RECOVERY', style: Theme.of(context).textTheme.labelMedium),
      const SizedBox(height: 7),
      if (checkpoints.isEmpty)
        const Text('No checkpoints yet.')
      else
        for (final item in checkpoints.take(8))
          ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            leading: Icon(
              item['id'] == currentCheckpointId
                  ? Icons.check_circle_rounded
                  : Icons.history_rounded,
              size: 19,
            ),
            title: Text(
              item['label']?.toString() ?? 'Checkpoint',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12),
            ),
            subtitle: Text(
              '${item['fileCount'] ?? 0} files · revision ${item['sessionRevision'] ?? '—'}',
              style: const TextStyle(fontSize: 10.5),
            ),
            onTap: item['id'] == currentCheckpointId
                ? null
                : () => onRestore(item),
          ),
      const Divider(),
      Text('ACTIVITY', style: Theme.of(context).textTheme.labelMedium),
      const SizedBox(height: 6),
      for (final item in activity)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.circle, size: 7),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  _humanize(item['eventType']?.toString() ?? 'activity'),
                  style: const TextStyle(fontSize: 11.5),
                ),
              ),
            ],
          ),
        ),
    ],
  );
}

class _MobileBuilderBody extends StatefulWidget {
  const _MobileBuilderBody({
    required this.tree,
    required this.file,
    required this.controller,
    required this.dirty,
    required this.busy,
    required this.output,
    required this.checkpoints,
    required this.activity,
    required this.currentCheckpointId,
    required this.onOpen,
    required this.onChanged,
    required this.onSave,
    required this.onCommand,
    required this.onRestore,
  });
  final List<Json> tree, checkpoints, activity;
  final Json? file;
  final TextEditingController controller;
  final bool dirty;
  final String? busy, output, currentCheckpointId;
  final ValueChanged<String>? onOpen;
  final VoidCallback onChanged, onSave;
  final ValueChanged<String> onCommand;
  final ValueChanged<Json> onRestore;
  @override
  State<_MobileBuilderBody> createState() => _MobileBuilderBodyState();
}

class _MobileBuilderBodyState extends State<_MobileBuilderBody> {
  int tab = 0;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.all(8),
        child: SegmentedButton<int>(
          segments: const [
            ButtonSegment(
              value: 0,
              label: Text('Code'),
              icon: Icon(Icons.code_rounded),
            ),
            ButtonSegment(
              value: 1,
              label: Text('Files'),
              icon: Icon(Icons.folder_outlined),
            ),
            ButtonSegment(
              value: 2,
              label: Text('Recovery'),
              icon: Icon(Icons.history_rounded),
            ),
          ],
          selected: {tab},
          onSelectionChanged: (value) => setState(() => tab = value.first),
        ),
      ),
      Expanded(
        child: switch (tab) {
          0 => _Editor(
            file: widget.file,
            controller: widget.controller,
            dirty: widget.dirty,
            busy: widget.busy,
            output: widget.output,
            onChanged: widget.onChanged,
            onSave: widget.onSave,
            onCommand: widget.onCommand,
          ),
          1 => _FileRail(
            tree: widget.tree,
            selectedPath: widget.file?['path']?.toString(),
            onOpen: widget.onOpen,
          ),
          _ => _RecoveryRail(
            checkpoints: widget.checkpoints,
            activity: widget.activity,
            currentCheckpointId: widget.currentCheckpointId,
            onRestore: widget.onRestore,
          ),
        },
      ),
    ],
  );
}

class _EmptyBuilder extends StatelessWidget {
  const _EmptyBuilder({
    required this.project,
    required this.error,
    required this.loading,
    required this.onCreate,
    required this.onRetry,
  });
  final Project project;
  final Object? error;
  final bool loading;
  final VoidCallback onCreate, onRetry;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      Container(
        padding: const EdgeInsets.all(22),
        decoration: BoxDecoration(
          color: const Color(0xFF061C1E),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFF1E5752)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.code_rounded, color: Color(0xFF72E0C0), size: 31),
            const SizedBox(height: 14),
            const Text(
              'Build Studio',
              style: TextStyle(
                color: Color(0xFFF3F8EF),
                fontSize: 24,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 7),
            Text(
              'Create an isolated, project-scoped workspace for ${project.title}. Files, checks, checkpoints, and repository delivery remain governed by the same backend as web.',
              style: const TextStyle(color: Color(0xFFB9CFCA), height: 1.45),
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: loading ? null : onCreate,
              icon: loading
                  ? const SizedBox.square(
                      dimension: 17,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.add_rounded),
              label: Text(
                loading ? 'Creating workspace' : 'Create Build Studio',
              ),
            ),
          ],
        ),
      ),
      if (error != null)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: _BuilderError(error: error!, retry: onRetry),
        ),
    ],
  );
}

class _BuilderError extends StatelessWidget {
  const _BuilderError({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.errorContainer,
    child: ListTile(
      leading: const Icon(Icons.warning_amber_rounded),
      title: const Text('Build Studio needs attention'),
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
String _verificationSummary(Json verification) {
  final checks = (verification['checks'] as List? ?? const []).whereType<Map>();
  return [
    'Verification ${verification['status'] ?? 'unknown'}',
    for (final check in checks)
      '${check['command']}: ${check['status']} · exit ${check['exitCode']}',
  ].join('\n');
}
