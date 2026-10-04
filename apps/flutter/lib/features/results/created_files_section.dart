import 'package:flutter/material.dart';

import 'created_file_export.dart';
import 'result_contracts.dart';
import 'results.dart';

class CreatedFilesSection extends StatefulWidget {
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
  State<CreatedFilesSection> createState() => _CreatedFilesSectionState();
}

class _CreatedFilesSectionState extends State<CreatedFilesSection> {
  String? _savingId, _notice;
  int _page = 0;
  @override
  void didUpdateWidget(covariant CreatedFilesSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _savingId = _notice = null;
      _page = 0;
    }
    if (_page * 3 >= widget.files.length) {
      _page = 0;
    }
  }

  @override
  Widget build(BuildContext context) {
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
            const Text(
              'Private generated files · separate from Knowledge and recall',
            ),
            if (!widget.exporter.available)
              const Text(
                'Saving private files is unavailable on this platform. Open Results in the desktop app to save this exact version.',
              ),
            Text(
              '${read.label}${read.loaded ? ' · ${widget.files.length} returned files' : ' · Count unavailable'}',
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
                          '${artifact.kind.name} · Version ${artifact.version} · ${artifact.byteCount == null ? 'Size unavailable' : '${artifact.byteCount} bytes'}',
                        ),
                        if (artifact.ready)
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
