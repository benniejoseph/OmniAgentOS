import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'builder_contracts.dart';
import 'builder_controller.dart';
import 'builder_providers.dart';
import 'builder_widgets.dart';

class NativeBuilderView extends ConsumerWidget {
  const NativeBuilderView({
    super.key,
    required this.projectId,
    this.exactArtifactId,
    this.desktop = false,
    this.active = true,
    this.controller,
    this.externalOpener,
  });
  final String projectId;
  final String? exactArtifactId;
  final bool desktop, active;
  final BuilderController? controller;
  final NativeBuilderExternalOpener? externalOpener;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final BuilderController value =
        controller ??
        ref.watch<BuilderController>(builderControllerProvider(projectId));
    if (value.projectId != projectId) {
      return const Center(
        child: Text('The exact Builder project is unavailable.'),
      );
    }
    return NativeBuilderWorkspace(
      key: ObjectKey(value),
      controller: value,
      exactArtifactId: exactArtifactId,
      desktop: desktop,
      active: active,
      externalOpener: externalOpener,
    );
  }
}

class NativeBuilderWorkspace extends StatefulWidget {
  const NativeBuilderWorkspace({
    super.key,
    required this.controller,
    this.exactArtifactId,
    this.desktop = false,
    this.active = true,
    this.externalOpener,
  });
  final BuilderController controller;
  final String? exactArtifactId;
  final bool desktop, active;
  final NativeBuilderExternalOpener? externalOpener;
  @override
  State<NativeBuilderWorkspace> createState() => _NativeBuilderWorkspaceState();
}

class _NativeBuilderWorkspaceState extends State<NativeBuilderWorkspace>
    with WidgetsBindingObserver {
  final _editor = TextEditingController(),
      _search = TextEditingController(),
      _branch = TextEditingController(),
      _title = TextEditingController(),
      _note = TextEditingController(),
      _confirmation = TextEditingController();
  String? _uiError;
  Timer? _expiryTimer;
  String? _expiryIdentity;
  BuilderController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    c.addListener(_changed);
    c.setActive(widget.active, notify: false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.active) {
        unawaited(c.initialize());
      }
    });
  }

  @override
  void didUpdateWidget(covariant NativeBuilderWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active != oldWidget.active) {
      if (!widget.active) {
        unawaited(c.persist().catchError((Object _) {}));
      }
      c.setActive(widget.active, notify: false);
      if (widget.active) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && widget.active) {
            unawaited(c.initialize());
          }
        });
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      c.setActive(widget.active);
      if (widget.active) {
        unawaited(c.initialize());
      }
    } else {
      unawaited(c.persist().catchError((Object _) {}));
      c.setActive(false);
    }
  }

  void _setText(TextEditingController controller, String value) {
    if (controller.text != value) {
      controller.value = TextEditingValue(
        text: value,
        selection: TextSelection.collapsed(offset: value.length),
      );
    }
  }

  void _changed() {
    if (!mounted) {
      return;
    }
    if (!c.available) {
      for (final field in [
        _editor,
        _search,
        _branch,
        _title,
        _note,
        _confirmation,
      ]) {
        field.clear();
      }
      _uiError = null;
    } else {
      _setText(_editor, c.draft);
      _setText(_search, c.search);
      _setText(_branch, c.branch);
      _setText(_title, c.title);
      _setText(_note, c.reviewNote);
      _setText(_confirmation, c.confirmation);
    }
    final release = c.selectedRelease, identity = c.confirmationBasis;
    if (identity != _expiryIdentity) {
      _expiryIdentity = identity;
      _expiryTimer?.cancel();
      if (release != null) {
        final delay = builderDate(release.raw['expiresAt'])
            .difference(c.now().toUtc());
        if (delay > Duration.zero) {
          _expiryTimer = Timer(delay, () {
            if (mounted) {
              setState(() {});
            }
          });
        }
      }
    }
    setState(() {});
  }

  Future<void> _run(Future<void> Function() action) async {
    final owner = c.access.owner?.key;
    try {
      if (mounted) {
        setState(() => _uiError = null);
      }
      await action();
    } catch (error) {
      if (mounted && c.available && c.access.owner?.key == owner) {
        setState(() => _uiError = '$error');
      }
    }
  }

  Future<void> _confirm(
    String label,
    String detail,
    Future<void> Function() action,
  ) async {
    final basis = c.decisionBasis;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(label),
        content: SingleChildScrollView(child: SelectableText(detail)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(label),
          ),
        ],
      ),
    );
    if (!mounted || accepted != true || !c.available) {
      return;
    }
    if (basis != c.decisionBasis) {
      setState(
        () => _uiError = 'The reviewed target changed. Inspect its current exact identity before confirming again.',
      );
      return;
    }
    await _run(action);
  }

  bool _currentLink(Uri uri) {
    final snapshot = c.snapshot;
    if (snapshot == null) return false;
    return [
      snapshot.preview?.toString(),
      c.selectedDeployment?.raw['deploymentUrl'],
      c.selectedRelease?.raw['deploymentUrl'],
      ...snapshot
          .records('delivery')
          .map((record) => record.raw['pullRequestUrl']),
    ].any((value) => builderExternalUri(value) == uri);
  }

  Future<void> _open(Uri uri) async {
    final opener = widget.externalOpener,
        basis = c.decisionBasis,
        generation = c.access.generation;
    if (opener == null ||
        !c.available ||
        !c.fresh ||
        builderExternalUri(uri.toString()) == null ||
        !_currentLink(uri)) {
      return;
    }
    await _run(() async {
      final opened = await opener.open(
        uri,
        isCurrent: () =>
            mounted &&
            c.available &&
            c.fresh &&
            c.decisionBasis == basis &&
            c.access.generation == generation &&
            _currentLink(uri),
      );
      if (mounted && c.available && !opened) {
        setState(
          () => _uiError = 'The platform could not open this exact link. No browser was opened by Builder.',
        );
      }
    });
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    c.setActive(false, notify: false);
    _expiryTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    for (final field in [
      _editor,
      _search,
      _branch,
      _title,
      _note,
      _confirmation,
    ]) {
      field.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) {
      return const SizedBox.shrink();
    }
    if (!c.available) {
      return const Scaffold(
        body: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Build is unavailable while session, role or protected access is being checked.',
            ),
          ),
        ),
      );
    }
    final snapshot = c.snapshot, session = snapshot?.session;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyS, meta: true): () {
          if (c.canChangeWorkspace && c.dirty && c.fileMatchesSession) {
            unawaited(_run(c.saveFile));
          }
        },
        const SingleActivator(LogicalKeyboardKey.keyS, control: true): () {
          if (c.canChangeWorkspace && c.dirty && c.fileMatchesSession) {
            unawaited(_run(c.saveFile));
          }
        },
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Build', overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              tooltip: 'Refresh Builder',
              onPressed: c.loading || c.acting
                  ? null
                  : () => _run(c.initialize),
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final wide =
                  widget.desktop &&
                  constraints.maxWidth >= 1000 &&
                  MediaQuery.textScalerOf(context).scale(16) < 24;
              return SingleChildScrollView(
                key: builderStorageKey(c, 'scroll'),
                padding: EdgeInsets.all(widget.desktop ? 24 : 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Work / Build',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                    BuilderIdentity('Project', c.projectId),
                    if (widget.exactArtifactId != null) ...[
                      BuilderIdentity(
                        'Requested artifact identity',
                        widget.exactArtifactId!,
                      ),
                      const BuilderNotice(
                        'This full identity comes from the current navigation. Artifact content is not independently verified here. Builder actions target the current project and exact sandbox records. Reopen the same exact link to restore this context.',
                      ),
                    ],
                    const BuilderNotice(
                      'Live server evidence only. Local drafts and action targets are encrypted for recovery. Builder has no offline execution queue and never retries an uncertain effect automatically.',
                    ),
                    if (c.loading)
                      const LinearProgressIndicator(
                        semanticsLabel: 'Refreshing exact Builder state',
                      ),
                    if (c.readError != null)
                      BuilderNotice(
                        'Workspace refresh unavailable. ${c.readError}',
                        error: true,
                      ),
                    if (c.recoveryError != null)
                      BuilderNotice(
                        'Protected recovery unavailable. ${c.recoveryError}',
                        error: true,
                      ),
                    if (_uiError != null) BuilderNotice(_uiError!, error: true),
                    if (c.actionError != null)
                      BuilderNotice(c.actionError!, error: true),
                    if (c.blocked.isNotEmpty) BuilderNotice(c.blocked),
                    if (c.localRecoveryPending)
                      const BuilderNotice(
                        'Local recovery has pending edits. Save local recovery before closing the app.',
                      ),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        BuilderActionButton(
                          'Refresh snapshot',
                          c.loading || c.acting
                              ? null
                              : () => _run(c.initialize),
                        ),
                        BuilderActionButton(
                          'Save local recovery',
                          c.recoveryReady && !c.acting
                              ? () => _run(c.persist)
                              : null,
                        ),
                      ],
                    ),
                    BuilderOutcomePanel(controller: c),
                    if (snapshot == null && !c.loading)
                      const BuilderNotice(
                        'No current Builder snapshot is available. Retry the live read; counts and provider state are unknown.',
                      ),
                    if (snapshot != null && session == null) ...[
                      Text(
                        'Create an isolated workspace',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const Text(
                        'A TypeScript starter will be created for this exact project.',
                      ),
                      BuilderActionButton(
                        'Create build workspace',
                        c.writable
                            ? () => _confirm(
                                'Create build workspace',
                                'Create an isolated sandbox for project ${c.projectId}?',
                                c.create,
                              )
                            : null,
                        primary: true,
                      ),
                    ],
                    if (snapshot != null && session != null) ...[
                      BuilderIdentity(
                        'Sandbox · ${session.status} · revision ${session.revision}',
                        session.id,
                      ),
                      if (!session.running)
                        BuilderNotice(
                          'Sandbox ${session.status}. Its recorded history remains available. The current API has no resume-sandbox action.',
                        ),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          BuilderActionButton(
                            'Save checkpoint',
                            c.canChangeWorkspace && !c.dirty
                                ? () => _run(c.checkpoint)
                                : null,
                          ),
                          BuilderActionButton(
                            'Restart preview',
                            c.canChangeWorkspace && !c.dirty
                                ? () => _run(() => c.command('start_preview'))
                                : null,
                          ),
                          BuilderActionButton(
                            'Stop sandbox',
                            c.canChangeWorkspace && !c.dirty
                                ? () => _confirm(
                                    'Stop sandbox',
                                    'Stop sandbox ${session.id}? Running work and its live preview stop. Checkpoints and evidence remain recorded.',
                                    c.stop,
                                  )
                                : null,
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      if (wide)
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(flex: 2, child: _browser()),
                            const SizedBox(width: 24),
                            Expanded(flex: 3, child: _canvas()),
                          ],
                        )
                      else ...[
                        _browser(),
                        const SizedBox(height: 16),
                        _canvas(),
                      ],
                      const SizedBox(height: 16),
                      _records(),
                      BuilderEvidencePanel(controller: c),
                    ],
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _browser() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final (value, label) in [
            ('files', 'Files'),
            ('checkpoints', 'Restore'),
            ('activity', 'Activity'),
            ('delivery', 'Delivery'),
          ])
            ChoiceChip(
              label: Text(label),
              selected: c.rail == value,
              onSelected: c.acting ? null : (_) => c.choose(nextRail: value),
              materialTapTargetSize: MaterialTapTargetSize.padded,
              padding: const EdgeInsets.all(10),
            ),
        ],
      ),
      const SizedBox(height: 12),
      switch (c.rail) {
        'checkpoints' => _checkpoints(),
        'activity' => _activity(),
        'delivery' => _delivery(),
        _ => _files(),
      },
    ],
  );
  Widget _files() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      TextField(
        controller: _search,
        enabled: !c.acting && c.running,
        maxLength: 240,
        decoration: const InputDecoration(
          labelText: 'Search source files',
          helperText: 'At least two characters. Empty search restores the bounded tree.',
        ),
        onSubmitted: (value) => _run(() => c.searchFiles(value)),
      ),
      BuilderActionButton(
        'Search files',
        !c.acting && c.running
            ? () => _run(() => c.searchFiles(_search.text))
            : null,
      ),
      if (c.fileLoading)
        const LinearProgressIndicator(semanticsLabel: 'Reading source files'),
      if (c.fileError != null)
        BuilderNotice('Source read unavailable. ${c.fileError}', error: true),
      const Text(
        'Bounded file tree: up to 500 files; search returns up to 100. Older or omitted files are not enumerated.',
      ),
      if (c.tree.where((row) => row.kind == 'file').isEmpty && !c.fileLoading)
        const BuilderNotice('No source files in the loaded result.'),
      ...c.tree
          .where((row) => row.kind == 'file')
          .map(
            (row) => ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(row.path),
              subtitle: Text(
                row.size == null ? 'Size unavailable' : '${row.size} bytes',
              ),
              selected: c.selectedFilePath == row.path,
              minVerticalPadding: 12,
              onTap: c.acting || !c.running
                  ? null
                  : () {
                      if (c.dirty) {
                        _confirm(
                          'Discard this local edit',
                          'Opening ${row.path} replaces the unsaved draft for ${c.selectedFile?.path}.',
                          () => c.openFile(row.path, allowDiscard: true),
                        );
                      } else {
                        _run(() => c.openFile(row.path));
                      }
                    },
            ),
          ),
    ],
  );
  Widget _checkpoints() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text(
        'Up to 20 recent checkpoints. Older history is unavailable here.',
      ),
      if (c.snapshot!.records('checkpoint').isEmpty)
        const BuilderNotice('No recorded checkpoints.'),
      ...c.snapshot!
          .records('checkpoint')
          .map(
            (record) => Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      record.text('label'),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    BuilderIdentity('Checkpoint', record.id),
                    BuilderIdentity(
                      'Workspace SHA-256',
                      record.text('workspaceSha256'),
                    ),
                    Text(
                      '${record.number('fileCount')} files · ${record.text('createdAt')}',
                    ),
                    if (record.raw['expiresAt'] != null)
                      Text('Restore expires ${record.text('expiresAt')}'),
                    BuilderActionButton(
                      record.id == c.snapshot?.session?.checkpointId
                          ? 'Current checkpoint'
                          : 'Restore checkpoint',
                      c.canChangeWorkspace &&
                              !c.dirty &&
                              record.id != c.snapshot?.session?.checkpointId &&
                              (record.raw['expiresAt'] == null ||
                                  builderDate(record.raw['expiresAt'])
                                      .isAfter(c.now().toUtc()))
                          ? () => _confirm(
                              'Restore checkpoint',
                              'Restore ${record.id} in sandbox ${c.snapshot!.session!.id}? A recovery checkpoint of the current workspace is sealed first.',
                              () => c.restore(record.id),
                            )
                          : null,
                    ),
                  ],
                ),
              ),
            ),
          ),
    ],
  );
  Widget _activity() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text('Up to 40 recent events. This is a bounded activity history.'),
      if (c.snapshot!.records('activity').isEmpty)
        const BuilderNotice('No recent Builder activity.'),
      ...c.snapshot!
          .records('activity')
          .map(
            (event) => ExpansionTile(
              key: builderStorageKey(c, 'activity:${event.id}'),
              tilePadding: EdgeInsets.zero,
              title: Text(event.text('eventType')),
              subtitle: Text(event.text('occurredAt')),
              children: [
                BuilderIdentity('Event', event.id),
                ...event
                    .object('detail')
                    .entries
                    .where(
                      (entry) => const {
                        'path',
                        'command',
                        'verdict',
                        'checkpointId',
                        'verificationId',
                        'workspaceSha256',
                        'repositoryFullName',
                        'branchName',
                        'sourceRunId',
                      }.contains(entry.key),
                    )
                    .map(
                      (entry) => BuilderIdentity(entry.key, '${entry.value}'),
                    ),
              ],
            ),
          ),
    ],
  );
  Widget _canvas() {
    final preview = c.snapshot?.preview;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          children: [
            for (final view in ['preview', 'code'])
              ChoiceChip(
                label: Text(view == 'preview' ? 'Preview' : 'Code'),
                selected: c.canvas == view,
                onSelected: c.acting ? null : (_) => c.choose(nextCanvas: view),
                materialTapTargetSize: MaterialTapTargetSize.padded,
                padding: const EdgeInsets.all(10),
              ),
          ],
        ),
        const SizedBox(height: 12),
        if (c.canvas == 'preview') ...[
          const Icon(Icons.web_asset_outlined, size: 40),
          const SizedBox(height: 12),
          const Text('Isolated preview'),
          BuilderNotice(
            preview == null
                ? 'An isolated HTTPS preview is unavailable in this snapshot.'
                : widget.externalOpener == null
                ? 'The exact preview is available, but this native host has not supplied an external-open capability. No embedded page is loaded.'
                : 'Open the current isolated preview explicitly in the platform browser. No preview token is retained in local recovery.',
          ),
          BuilderActionButton(
            'Open exact preview',
            preview != null &&
                    widget.externalOpener != null &&
                    c.fresh &&
                    c.running
                ? () => _open(preview)
                : null,
          ),
        ],
        if (c.canvas == 'code') ...[
          BuilderIdentity(
            'Exact file',
            c.selectedFile?.path ?? 'No complete file loaded',
          ),
          if (c.selectedFile != null)
            BuilderIdentity('Loaded SHA-256', c.selectedFile!.sha256),
          if (c.dirty)
            const BuilderNotice(
              'Unsaved source edit. The original SHA-256 remains the write precondition.',
            ),
          if (!c.fileMatchesSession && c.selectedFile != null)
            const BuilderNotice(
              'This retained source is not verified against the current sandbox. Refresh before saving or deleting.',
            ),
          TextField(
            controller: _editor,
            readOnly: c.acting || !c.access.writable || c.selectedFile == null,
            maxLength: 500000,
            minLines: 12,
            maxLines: 26,
            keyboardType: TextInputType.multiline,
            autocorrect: false,
            enableSuggestions: false,
            style: const TextStyle(fontFamily: 'monospace'),
            decoration: const InputDecoration(
              labelText: 'Source code',
              alignLabelWithHint: true,
              counterText: '',
            ),
            onChanged: c.editDraft,
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              BuilderActionButton(
                'Save file',
                c.canChangeWorkspace &&
                        c.dirty &&
                        c.fileMatchesSession &&
                        !c.fileLoading
                    ? () => _run(c.saveFile)
                    : null,
                primary: true,
              ),
              BuilderActionButton(
                'Delete file',
                c.canChangeWorkspace && !c.dirty && c.fileMatchesSession
                    ? () => _confirm(
                        'Delete file',
                        'Delete ${c.selectedFile!.path} at SHA-256 ${c.selectedFile!.sha256} from sandbox ${c.snapshot!.session!.id}?',
                        c.deleteFile,
                      )
                    : null,
              ),
            ],
          ),
          if (c.conflictingFile != null) ...[
            const BuilderNotice(
              'The saved source or sandbox changed. Your local draft is retained. Inspect the current file before selecting a revision.',
            ),
            ExpansionTile(
              key: builderStorageKey(
                c,
                'file-conflict:${c.fileSessionId}:${c.conflictingFile!.path}:${c.conflictingFile!.sha256}',
              ),
              title: const Text('Inspect current saved file'),
              children: [
                BuilderIdentity('Current SHA-256', c.conflictingFile!.sha256),
                SelectableText(c.conflictingFile!.content),
              ],
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                BuilderActionButton(
                  'Use current saved file',
                  !c.acting
                      ? () => _confirm(
                          'Replace local draft',
                          'Discard the local draft and use the current exact saved file?',
                          () => c.resolveFileConflict(keepDraft: false),
                        )
                      : null,
                ),
                BuilderActionButton(
                  'Keep draft against reviewed revision',
                  !c.acting
                      ? () => _confirm(
                          'Keep reviewed draft',
                          'Use current SHA-256 ${c.conflictingFile!.sha256} as the new precondition for your retained draft? This does not save the file.',
                          () => c.resolveFileConflict(keepDraft: true),
                        )
                      : null,
                ),
              ],
            ),
          ],
        ],
        const SizedBox(height: 16),
        Text('Focused checks', style: Theme.of(context).textTheme.titleMedium),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final command in ['lint', 'typecheck', 'test', 'build'])
              BuilderActionButton(
                command,
                c.canChangeWorkspace && !c.dirty
                    ? () => _run(() => c.command(command))
                    : null,
              ),
          ],
        ),
        if (c.commandOutput != null)
          ExpansionTile(
            key: builderStorageKey(c, 'command-output:${c.outcome?.key}'),
            title: const Text('Command output · bounded'),
            initiallyExpanded: true,
            children: [SelectableText(c.commandOutput!)],
          ),
        BuilderActionButton(
          'Run deterministic verification',
          c.canChangeWorkspace && !c.dirty && c.snapshot?.checkpoint != null
              ? () => _run(c.verify)
              : null,
        ),
        const Text(
          'Delivery also requires a passing Sentinel review for the exact checkpoint. Use the governed web review workflow when that receipt is absent.',
        ),
      ],
    );
  }

  Widget _records() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text(
        'Exact recent records: 20 deployments, 20 releases, 10 verifications. Totals and older pages are unavailable.',
      ),
      const SizedBox(height: 12),
      BuilderRecordSelector(
        label: 'Preview deployment record',
        records: c.snapshot!.records('deployment'),
        value: c.deploymentId,
        enabled: !c.acting,
        select: (id) => c.choose(deployment: id),
      ),
      const SizedBox(height: 12),
      BuilderRecordSelector(
        label: 'Production release record',
        records: c.snapshot!.records('release'),
        value: c.releaseId,
        enabled: !c.acting,
        select: (id) => c.choose(release: id),
      ),
      const SizedBox(height: 12),
      BuilderRecordSelector(
        label: 'Verification record',
        records: c.snapshot!.records('verification'),
        value: c.verificationId,
        enabled: !c.acting,
        select: (id) => c.choose(verification: id),
      ),
    ],
  );
  Widget _delivery() {
    final snapshot = c.snapshot!,
        binding = snapshot.repository,
        release = c.selectedRelease,
        preview = c.selectedDeployment;
    final missingRepo =
        c.repositoryId != null &&
        !c.repositories.any((row) => row.id == c.repositoryId);
    final githubReady = snapshot.github['configured'] == true,
        vercelReady = snapshot.vercel['configured'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Repository handoff',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        if (!githubReady)
          BuilderNotice(
            'GitHub App setup required. Missing: ${(snapshot.github['missing'] as List).join(', ')}',
          ),
        BuilderActionButton(
          'Load authorized repositories',
          githubReady && !c.acting && !c.repositoriesLoading
              ? () => _run(c.loadRepositories)
              : null,
        ),
        if (c.repositoriesError != null)
          BuilderNotice(
            'Repositories unavailable. ${c.repositoriesError}',
            error: true,
          ),
        if (c.repositoriesLoading)
          const LinearProgressIndicator(
            semanticsLabel: 'Reading authorized repositories',
          ),
        if (c.repositories.isEmpty &&
            c.repositoriesError == null &&
            !c.repositoriesLoading)
          const Text(
            'No repository options loaded. Empty availability is not an authorization grant.',
          ),
        DropdownButtonFormField<String>(
          key: ValueKey(c.repositoryId),
          initialValue: c.repositoryId,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Repository'),
          items: [
            if (missingRepo)
              DropdownMenuItem(
                value: c.repositoryId,
                child: const Text('Exact repository unavailable'),
              ),
            ...c.repositories.map(
              (row) => DropdownMenuItem(
                value: row.id,
                child: Text(
                  '${row.label} · ${row.private ? 'private' : 'public'}',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ],
          onChanged: c.acting
              ? null
              : (id) {
                  if (id != null) {
                    c.choose(repositoryChoice: id);
                  }
                },
        ),
        if (c.repositoryId != null)
          BuilderIdentity('Repository ID', c.repositoryId!),
        if (binding != null) ...[
          BuilderIdentity('Binding', binding.id),
          BuilderIdentity('Exact base commit', binding.text('baseSha')),
          Text(
            'Binding revision ${binding.number('revision')} · ${binding.text('defaultBranch')}',
          ),
        ],
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            BuilderActionButton(
              'Bind repository',
              c.canChangeWorkspace &&
                      !c.dirty &&
                      !missingRepo &&
                      c.repositoryId != null &&
                      c.repositoriesError == null
                  ? () => _run(c.bindRepository)
                  : null,
            ),
            BuilderActionButton(
              'Open bound repository revision',
              c.canChangeWorkspace && !c.dirty && binding != null
                  ? () => _confirm(
                      'Open bound repository revision',
                      'Replace sandbox files with ${binding.text('repositoryFullName')} at commit ${binding.text('baseSha')}? A recovery checkpoint is sealed first.',
                      c.checkoutRepository,
                    )
                  : null,
            ),
          ],
        ),
        TextField(
          controller: _branch,
          enabled: !c.acting,
          maxLength: 120,
          decoration: const InputDecoration(labelText: 'New branch'),
          onChanged: (value) => c.editHandoff(nextBranch: value),
        ),
        TextField(
          controller: _title,
          enabled: !c.acting,
          maxLength: 180,
          decoration: const InputDecoration(
            labelText: 'Draft pull request title',
          ),
          onChanged: (value) => c.editHandoff(nextTitle: value),
        ),
        TextField(
          controller: _note,
          enabled: !c.acting,
          maxLength: 8000,
          minLines: 3,
          maxLines: 6,
          decoration: const InputDecoration(labelText: 'Review note'),
          onChanged: (value) => c.editHandoff(nextNote: value),
        ),
        BuilderActionButton(
          'Secret-scan and open draft PR',
          c.canChangeWorkspace &&
                  !c.dirty &&
                  binding != null &&
                  c.deliveryVerification != null &&
                  c.title.trim().length >= 3 &&
                  c.branch.trim().isNotEmpty
              ? () => _confirm(
                  'Open draft pull request',
                  'Create a new branch ${c.branch.trim()} in ${binding.text('repositoryFullName')} using checkpoint ${snapshot.checkpoint?.id} and verification ${c.deliveryVerification?.id}? The default branch is not written directly.',
                  c.createPullRequest,
                )
              : null,
          primary: true,
        ),
        ...snapshot
            .records('delivery')
            .map(
              (record) => ExpansionTile(
                key: builderStorageKey(c, 'delivery:${record.id}'),
                title: Text('${record.text('branchName')} · ${record.status}'),
                children: [
                  BuilderIdentity('Delivery', record.id),
                  BuilderIdentity(
                    'Commit',
                    record.text('commitSha').isEmpty
                        ? 'Not acknowledged'
                        : record.text('commitSha'),
                  ),
                  BuilderIdentity('Checkpoint', record.text('checkpointId')),
                  BuilderIdentity(
                    'Verification',
                    record.text('verificationId'),
                  ),
                  if (builderExternalUri(record.raw['pullRequestUrl']) != null)
                    BuilderActionButton(
                      'Open exact pull request',
                      widget.externalOpener != null && c.fresh
                          ? () => _open(
                              builderExternalUri(record.raw['pullRequestUrl'])!,
                            )
                          : null,
                    ),
                ],
              ),
            ),
        const SizedBox(height: 20),
        if (preview != null &&
            builderExternalUri(preview.raw['deploymentUrl']) != null)
          BuilderActionButton(
            'Open selected deployment',
            widget.externalOpener != null && c.fresh
                ? () => _open(builderExternalUri(preview.raw['deploymentUrl'])!)
                : null,
          ),
        Text(
          'Preview and production',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        if (!vercelReady)
          BuilderNotice(
            'Vercel setup required. Missing: ${(snapshot.vercel['missing'] as List).join(', ')}',
          ),
        BuilderIdentity(
          'Current sealed checkpoint',
          snapshot.checkpoint?.id ?? 'No current seal',
        ),
        BuilderIdentity(
          'Selected current passing delivery verification',
          c.deliveryVerification?.id ?? 'No matching passing Sentinel review',
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            BuilderActionButton(
              'Create verified preview',
              c.canChangeWorkspace &&
                      !c.dirty &&
                      vercelReady &&
                      c.deliveryVerification != null
                  ? () => _confirm(
                      'Create verified preview',
                      'Upload checkpoint ${snapshot.checkpoint?.id} and verification ${c.deliveryVerification?.id} to an isolated Vercel preview?',
                      c.deployPreview,
                    )
                  : null,
            ),
            BuilderActionButton(
              'Refresh selected preview evidence',
              c.writable && preview != null
                  ? () => _run(() => c.refreshEvidence('deployment'))
                  : null,
            ),
            BuilderActionButton(
              'Prepare production review',
              c.canChangeWorkspace && !c.dirty && preview?.status == 'ready'
                  ? () => _run(c.prepareRelease)
                  : null,
            ),
          ],
        ),
        if (release != null) ...[
          BuilderIdentity('Selected production release', release.id),
          if (builderExternalUri(release.raw['deploymentUrl']) != null)
            BuilderActionButton(
              'Open selected production deployment',
              widget.externalOpener != null && c.fresh
                  ? () =>
                        _open(builderExternalUri(release.raw['deploymentUrl'])!)
                  : null,
            ),
          BuilderIdentity('Release digest', release.text('releaseDigest')),
          Text('Review expires ${release.text('expiresAt')}'),
          if (release.text('deploymentId') != preview?.id)
            const BuilderNotice(
              'This release belongs to a different selected preview. Select its exact deployment before confirming production.',
            ),
          if (release.object('migrationEvidence')['status'] != 'not_declared')
            const BuilderNotice(
              'Database migration files are declared. Production is blocked by the existing release policy.',
            ),
          TextField(
            controller: _confirmation,
            enabled: !c.acting && c.access.writable,
            decoration: const InputDecoration(
              labelText: 'Type RELEASE for this exact review',
            ),
            autocorrect: false,
            enableSuggestions: false,
            onChanged: c.confirm,
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              BuilderActionButton(
                'Release exact preview to production',
                c.canRelease
                    ? () => _confirm(
                        'Release exact preview to production',
                        'Release ${release.id} with digest ${release.text('releaseDigest')} from preview ${release.text('deploymentId')}? This is a production action.',
                        c.releaseProduction,
                      )
                    : null,
                primary: true,
              ),
              BuilderActionButton(
                'Refresh selected production evidence',
                c.writable
                    ? () => _run(() => c.refreshEvidence('release'))
                    : null,
              ),
            ],
          ),
          const BuilderNotice(
            'Rollback is recorded evidence only. The published API has no rollback action. Provider status is refreshed on explicit request; this view does not silently poll with mutation requests.',
          ),
        ],
      ],
    );
  }
}
