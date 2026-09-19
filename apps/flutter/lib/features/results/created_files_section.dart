import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'results.dart';

class CreatedFilesSection extends StatefulWidget {
  const CreatedFilesSection({
    super.key,
    required this.controller,
    required this.files,
    this.dense = false,
  });

  final ResultsController controller;
  final List<GeneratedArtifactSummary> files;
  final bool dense;

  @override
  State<CreatedFilesSection> createState() => _CreatedFilesSectionState();
}

class _CreatedFilesSectionState extends State<CreatedFilesSection> {
  String? _savingId;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: const Key('created-files-section'),
      height: widget.files.isEmpty
          ? 102
          : widget.dense
          ? 182
          : 194,
      padding: EdgeInsets.fromLTRB(
        widget.dense ? 16 : 12,
        10,
        widget.dense ? 16 : 12,
        11,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow.withValues(alpha: .72),
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  color: scheme.primaryContainer,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(
                  Icons.folder_copy_outlined,
                  size: 17,
                  color: scheme.primary,
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Created files',
                      style: Theme.of(context).textTheme.titleSmall
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    Text(
                      'Private files created by Asael · separate from Knowledge and RAG',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              if (widget.files.isNotEmpty)
                Text(
                  '${widget.files.length}',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: scheme.primary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 9),
          Expanded(
            child: widget.files.isEmpty
                ? Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Files generated in future runs will stay available here.',
                      style: Theme.of(context).textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  )
                : LayoutBuilder(
                    builder: (context, constraints) {
                      final width = constraints.maxWidth < 600
                          ? (constraints.maxWidth - 8)
                                .clamp(220, 340)
                                .toDouble()
                          : widget.dense
                          ? 286.0
                          : 310.0;
                      return ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: widget.files.length,
                        separatorBuilder: (_, _) => const SizedBox(width: 9),
                        itemBuilder: (context, index) => SizedBox(
                          width: width,
                          child: _CreatedFileCard(
                            artifact: widget.files[index],
                            saving: _savingId == widget.files[index].id,
                            onSave: widget.files[index].ready
                                ? () => _save(widget.files[index])
                                : null,
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Future<void> _save(GeneratedArtifactSummary artifact) async {
    if (_savingId != null || !artifact.ready) return;
    setState(() => _savingId = artifact.id);
    try {
      final bytes = await widget.controller.downloadCreatedFile(artifact);
      if (!mounted) return;
      final saved = await FilePicker.saveFile(
        dialogTitle: 'Save ${artifact.filename}',
        fileName: artifact.filename,
        bytes: bytes,
      );
      if (mounted && saved != null) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('${artifact.filename} saved.')));
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('This created file could not be downloaded.'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _savingId = null);
    }
  }
}

class _CreatedFileCard extends StatelessWidget {
  const _CreatedFileCard({
    required this.artifact,
    required this.saving,
    required this.onSave,
  });

  final GeneratedArtifactSummary artifact;
  final bool saving;
  final VoidCallback? onSave;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = _statusColor(scheme, artifact.status);
    return Material(
      key: Key('created-file-${artifact.id}'),
      color: scheme.surface,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.fromLTRB(11, 9, 8, 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 52,
              decoration: BoxDecoration(
                color: color.withValues(alpha: .11),
                borderRadius: BorderRadius.circular(9),
              ),
              child: Icon(_kindIcon(artifact.kind), color: color, size: 23),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    artifact.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${_kindLabel(artifact.kind)} · v${artifact.version}${artifact.byteCount == null ? '' : ' · ${_humanBytes(artifact.byteCount!)}'}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      Icon(Icons.lock_outline_rounded, size: 12, color: color),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          _statusLabel(artifact.status),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: color,
                                fontWeight: FontWeight.w600,
                              ),
                        ),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        MaterialLocalizations.of(context)
                            .formatShortDate(artifact.updatedAt.toLocal()),
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ],
                  ),
                  if (artifact.status == GeneratedArtifactStatus.rendering ||
                      artifact.status == GeneratedArtifactStatus.queued) ...[
                    const SizedBox(height: 5),
                    LinearProgressIndicator(
                      minHeight: 2,
                      color: color,
                      backgroundColor: color.withValues(alpha: .12),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 4),
            if (onSave != null)
              IconButton(
                key: Key('created-file-save-${artifact.id}'),
                tooltip: 'Save ${artifact.filename} as…',
                onPressed: saving ? null : onSave,
                icon: saving
                    ? const SizedBox.square(
                        dimension: 17,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.download_rounded, size: 20),
              )
            else
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 7),
                child: Icon(
                  artifact.status == GeneratedArtifactStatus.failed
                      ? Icons.error_outline_rounded
                      : Icons.schedule_rounded,
                  size: 19,
                  color: color,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

IconData _kindIcon(GeneratedArtifactKind kind) => switch (kind) {
  GeneratedArtifactKind.document => Icons.description_outlined,
  GeneratedArtifactKind.presentation => Icons.slideshow_rounded,
  GeneratedArtifactKind.spreadsheet => Icons.table_chart_outlined,
  GeneratedArtifactKind.pdf => Icons.picture_as_pdf_outlined,
};

String _kindLabel(GeneratedArtifactKind kind) => switch (kind) {
  GeneratedArtifactKind.document => 'Document',
  GeneratedArtifactKind.presentation => 'Presentation',
  GeneratedArtifactKind.spreadsheet => 'Spreadsheet',
  GeneratedArtifactKind.pdf => 'PDF',
};

String _statusLabel(GeneratedArtifactStatus status) => switch (status) {
  GeneratedArtifactStatus.queued => 'Private · Queued',
  GeneratedArtifactStatus.rendering => 'Private · Rendering',
  GeneratedArtifactStatus.ready => 'Private · Ready',
  GeneratedArtifactStatus.failed => 'Private · Failed',
};

Color _statusColor(ColorScheme scheme, GeneratedArtifactStatus status) =>
    switch (status) {
      GeneratedArtifactStatus.queued ||
      GeneratedArtifactStatus.rendering => scheme.tertiary,
      GeneratedArtifactStatus.ready => scheme.primary,
      GeneratedArtifactStatus.failed => scheme.error,
    };

String _humanBytes(int value) {
  if (value < 1024) return '$value B';
  if (value < 1024 * 1024) return '${(value / 1024).toStringAsFixed(1)} KB';
  return '${(value / (1024 * 1024)).toStringAsFixed(1)} MB';
}
