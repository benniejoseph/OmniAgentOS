import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../auth/application/session_controller.dart';
import '../auth/application/biometric_session_lock_controller.dart';

import 'created_file_export.dart';
import 'result_contracts.dart';
import 'results.dart';

class CreatedFilesSection extends ConsumerStatefulWidget {
  const CreatedFilesSection({
    super.key,
    required this.controller,
    required this.files,
    this.dense = false,
    this.exporter = const ScopedCreatedFileExporter(),
  });
  final ResultsController controller;
  final List<GeneratedArtifactSummary> files;
  final bool dense;
  final ScopedCreatedFileExporter exporter;
  @override
  ConsumerState<CreatedFilesSection> createState() =>
      _CreatedFilesSectionState();
}

class _CreatedFilesSectionState extends ConsumerState<CreatedFilesSection>
    with WidgetsBindingObserver {
  final Map<String, Future<AndroidPreparedFileDestination?>> _destinations = {};
  bool get _android =>
      !kIsWeb &&
      defaultTargetPlatform == TargetPlatform.android &&
      widget.exporter.adapter is DesktopCreatedFileExportAdapter;
  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (mounted)
      setState(() {
        _destinations.clear();
        _savingId = null;
      });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  NativeRequestAuthority? _androidAuthority() {
    final sessionState = ref.read(sessionControllerProvider);
    final session = sessionState.value;
    final api = ref.read(apiClientProvider);
    final access = widget.controller.access;
    if (!_foreground ||
        sessionState.isLoading ||
        sessionState.hasError ||
        session == null ||
        session.userId.isEmpty ||
        ref
            .read(biometricSessionLockControllerProvider)
            .state
            .blocksInteraction ||
        !widget.controller.readable ||
        access?.tenantId != session.tenantId ||
        access?.actorId != session.actorId ||
        access?.role != session.role)
      return null;
    final controller = widget.controller;
    return NativeRequestAuthority(
      tenantId: session.tenantId,
      actorId: session.actorId,
      canonicalUserId: session.userId,
      role: session.role,
      apiBaseUrl: api.apiBaseUrl,
      isCurrent: () {
        if (!mounted ||
            !_foreground ||
            !identical(widget.controller, controller) ||
            !identical(ref.read(apiClientProvider), api) ||
            !controller.readable ||
            ref
                .read(biometricSessionLockControllerProvider)
                .state
                .blocksInteraction)
          return false;
        final state = ref.read(sessionControllerProvider),
            current = state.value;
        return !state.isLoading &&
            !state.hasError &&
            current != null &&
            current.tenantId == session.tenantId &&
            current.actorId == session.actorId &&
            current.userId == session.userId &&
            current.role == session.role;
      },
    );
  }

  String? _savingId, _notice;
  int _page = 0;
  @override
  void didUpdateWidget(covariant CreatedFilesSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _savingId = _notice = null;
      _destinations.clear();
      _page = 0;
    }
    if (_page * 3 >= widget.files.length) {
      _page = 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_android) {
      ref.watch(sessionControllerProvider);
      ref.watch(biometricSessionLockControllerProvider);
      ref.watch(apiClientProvider);
    }
    final read = widget.controller.readFor(ResultsSource.createdFiles);
    return Material(
      key: const Key('created-files-section'),
      color: Theme.of(context).colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Created files',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const Text('Documents, presentations and files made for you.'),
            if (!_android && !widget.exporter.available)
              const Text(
                'Saving private files is unavailable on this platform. Open Results in the desktop app to save this exact version.',
              ),
            Text(
              '${read.label}${read.loaded ? ' · ${widget.files.length} files' : ''}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (read.error != null) SelectableText(read.error!),
            if (_notice != null)
              Semantics(liveRegion: true, child: Text(_notice!)),
            if (widget.files.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  read.state == ResultsAvailability.partial
                      ? 'No valid file metadata is available; some returned records were omitted.'
                      : read.retained
                      ? 'No created files were in the last successful window. The current source could not be checked.'
                      : read.loaded
                      ? 'No created files were returned in this window.'
                      : 'Created files have not been successfully checked.',
                ),
              ),
            for (final artifact in widget.files.skip(_page * 3).take(3))
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Material(
                  key: Key('created-file-${artifact.id}'),
                  color: Theme.of(context).colorScheme.surfaceContainerLow,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                    side: BorderSide(
                      color: Theme.of(context).colorScheme.outlineVariant,
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          artifact.title,
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        Text(_status(artifact.status)),
                        Text(
                          '${artifact.kind.name} · Version ${artifact.version} · ${_fileSize(artifact.byteCount)}',
                        ),
                        if (artifact.ready && _android)
                          _androidSaveControl(artifact),
                        if (artifact.ready && !_android)
                          OutlinedButton.icon(
                            key: Key('created-file-save-${artifact.id}'),
                            onPressed:
                                widget.exporter.available &&
                                    _savingId == null &&
                                    widget.controller.fileCurrent(artifact)
                                ? () => _save(artifact)
                                : null,
                            icon: const Icon(Icons.save_alt),
                            label: Text(
                              _savingId == artifact.id
                                  ? 'Saving exact file…'
                                  : 'Save file as…',
                            ),
                          ),
                        if (artifact.ready &&
                            !widget.controller.fileCurrent(artifact))
                          const Text(
                            'Refresh this source before saving the exact file version.',
                          ),
                        ExpansionTile(
                          expansionAnimationStyle:
                              MediaQuery.disableAnimationsOf(context)
                              ? AnimationStyle.noAnimation
                              : null,
                          tilePadding: EdgeInsets.zero,
                          title: const Text('File identity and version'),
                          children: [
                            SelectableText(
                              'File ID: ${artifact.id}\nFilename: ${artifact.filename}\nVersion: ${artifact.version}\nMedia type: ${artifact.mediaType}\nCreated: ${artifact.createdAt.toIso8601String()}\nUpdated: ${artifact.updatedAt.toIso8601String()}\nQueued: ${artifact.queuedAt.toIso8601String()}${artifact.readyAt == null ? '' : '\nReady: ${artifact.readyAt!.toIso8601String()}'}${artifact.failedAt == null ? '' : '\nFailed: ${artifact.failedAt!.toIso8601String()}'}',
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            if (widget.files.length > 3)
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  TextButton(
                    onPressed: _page > 0 ? () => setState(() => _page--) : null,
                    child: const Text('Previous files'),
                  ),
                  Text(
                    'Files page ${_page + 1} of ${(widget.files.length + 2) ~/ 3}',
                  ),
                  TextButton(
                    onPressed: (_page + 1) * 3 < widget.files.length
                        ? () => setState(() => _page++)
                        : null,
                    child: const Text('Next files'),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _androidSaveControl(GeneratedArtifactSummary artifact) {
    final authority = _androidAuthority();
    if (authority == null)
      return const Text('Unlock and refresh to save this file.');
    if (artifact.byteCount != null && artifact.byteCount! > 32 * 1024 * 1024) {
      return const Text(
        'This file is larger than the phone save limit. Save it from the Mac app.',
      );
    }
    final adapter = AndroidCreatedFileExportAdapter(
      scopeKey: createdFileExportScopeKey(
        authority,
        purpose: 'created-file:${artifact.id}:${artifact.version}',
      ),
    );
    final future = _destinations.putIfAbsent(
      adapter.scopeKey,
      adapter.preparedDestination,
    );
    return FutureBuilder<AndroidPreparedFileDestination?>(
      future: future,
      builder: (context, snapshot) {
        final destination = snapshot.data;
        final busy = _savingId != null;
        final enabled =
            !busy &&
            authority.isCurrent() &&
            widget.controller.fileCurrent(artifact);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 8),
            if (destination != null) ...[
              Text('Ready to save: ${destination.filename}'),
              const SizedBox(height: 8),
              FilledButton.icon(
                onPressed: enabled
                    ? () => _saveAndroid(artifact, adapter, authority)
                    : null,
                icon: const Icon(Icons.download_outlined),
                label: Text(
                  _savingId == artifact.id ? 'Saving file…' : 'Save file',
                ),
              ),
            ] else
              const Text(
                'Choose a location, then return here to save. You may be asked to unlock Asael.',
              ),
            TextButton.icon(
              onPressed: enabled
                  ? () => _chooseAndroid(artifact, adapter, authority)
                  : null,
              icon: const Icon(Icons.folder_open_outlined),
              label: Text(
                destination == null
                    ? 'Choose save location'
                    : 'Change save location',
              ),
            ),
          ],
        );
      },
    );
  }

  Future<void> _chooseAndroid(
    GeneratedArtifactSummary artifact,
    AndroidCreatedFileExportAdapter adapter,
    NativeRequestAuthority authority,
  ) async {
    if (_savingId != null ||
        !authority.isCurrent() ||
        !widget.controller.fileCurrent(artifact))
      return;
    setState(() {
      _savingId = artifact.id;
      _notice = null;
    });
    try {
      // Android chooses an empty destination only. Saving private bytes is a
      // separate explicit action from a fresh, normally unlocked workspace.
      await adapter.prepareDestination(filename: artifact.filename);
    } catch (_) {
      if (authority.isCurrent())
        setState(
          () => _notice = 'The save location could not be opened. Try again.',
        );
    } finally {
      if (authority.isCurrent())
        setState(() {
          _savingId = null;
          _destinations.remove(adapter.scopeKey);
        });
    }
  }

  Future<void> _saveAndroid(
    GeneratedArtifactSummary artifact,
    AndroidCreatedFileExportAdapter adapter,
    NativeRequestAuthority authority,
  ) async {
    final controller = widget.controller,
        generation = widget.controller.generation;
    bool current() =>
        mounted &&
        authority.isCurrent() &&
        identical(controller, widget.controller) &&
        generation == controller.generation &&
        controller.fileCurrent(artifact);
    if (_savingId != null || !current()) return;
    setState(() {
      _savingId = artifact.id;
      _notice = null;
    });
    try {
      final outcome = await ScopedCreatedFileExporter(adapter: adapter).save(
        filename: artifact.filename,
        loadBytes: () => controller.downloadCreatedFile(artifact),
        isCurrent: current,
      );
      if (current())
        setState(
          () => _notice = switch (outcome) {
            CreatedFileExportOutcome.saved =>
              'File saved to your chosen location.',
            CreatedFileExportOutcome.canceled =>
              'Choose a save location again, then tap Save file.',
            CreatedFileExportOutcome.scopeChanged => 'Your session or the file changed. Refresh and choose a location again.',
            CreatedFileExportOutcome.unavailable =>
              'Saving is unavailable on this phone.',
          },
        );
    } catch (_) {
      if (current())
        setState(
          () => _notice =
              'The file could not be saved. Choose a location again and retry.',
        );
    } finally {
      if (mounted && identical(controller, widget.controller))
        setState(() {
          _savingId = null;
          _destinations.remove(adapter.scopeKey);
        });
    }
  }

  Future<void> _save(GeneratedArtifactSummary artifact) async {
    final controller = widget.controller,
        generation = widget.controller.generation;
    if (_savingId != null ||
        !widget.exporter.available ||
        !controller.fileCurrent(artifact)) {
      return;
    }
    setState(() {
      _savingId = artifact.id;
      _notice = null;
    });
    bool current() =>
        mounted &&
        identical(controller, widget.controller) &&
        generation == controller.generation &&
        controller.fileCurrent(artifact);
    try {
      final outcome = await widget.exporter.save(
        filename: artifact.filename,
        loadBytes: () => controller.downloadCreatedFile(artifact),
        isCurrent: current,
      );
      if (mounted && identical(controller, widget.controller)) {
        if (outcome == CreatedFileExportOutcome.scopeChanged) {
          setState(
            () => _notice = 'Results access or the file version changed. Refresh and choose a save location again.',
          );
        } else if (current()) {
          setState(
            () => _notice = switch (outcome) {
              CreatedFileExportOutcome.saved => 'The selected file was saved.',
              CreatedFileExportOutcome.canceled =>
                'Save dialog closed. No file was saved.',
              CreatedFileExportOutcome.unavailable =>
                'Saving private files is unavailable on this platform.',
              CreatedFileExportOutcome.scopeChanged => null,
            },
          );
        }
      }
    } catch (_) {
      if (current()) {
        setState(
          () => _notice = 'This exact file could not be saved. Refresh its metadata and try again.',
        );
      }
    } finally {
      if (mounted && identical(controller, widget.controller)) {
        setState(() => _savingId = null);
      }
    }
  }
}

String _status(GeneratedArtifactStatus status) => switch (status) {
  GeneratedArtifactStatus.queued => 'Private · Queued',
  GeneratedArtifactStatus.rendering => 'Private · Rendering',
  GeneratedArtifactStatus.ready => 'Private · Ready',
  GeneratedArtifactStatus.failed => 'Private · Failed',
};

String _fileSize(int? bytes) => bytes == null
    ? 'Size unavailable'
    : bytes >= 1024 * 1024
    ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB'
    : bytes >= 1024
    ? '${(bytes / 1024).toStringAsFixed(0)} KB'
    : '$bytes bytes';
