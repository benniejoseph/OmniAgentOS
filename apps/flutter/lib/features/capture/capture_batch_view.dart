import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'capture_controller.dart';
import 'capture_models.dart';

class CaptureSelectionPanel extends StatelessWidget {
  const CaptureSelectionPanel({
    super.key,
    required this.files,
    required this.onRemove,
  });

  final List<SelectedCaptureFile> files;
  final ValueChanged<SelectedCaptureFile> onRemove;

  @override
  Widget build(BuildContext context) {
    final totalBytes = files.fold<int>(0, (total, item) => total + item.length);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.folder_copy_outlined,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  '${files.length} ${files.length == 1 ? 'document' : 'documents'} selected · ${_fileSize(totalBytes)}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'Each file becomes its own cited knowledge source. Files are read and encrypted only after you queue the batch.',
          ),
          const SizedBox(height: 10),
          for (final item in files)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.description_outlined),
              title: Text(
                item.file.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(_fileSize(item.length)),
              trailing: IconButton(
                tooltip: 'Remove from batch',
                onPressed: () => onRemove(item),
                icon: const Icon(Icons.close_rounded),
              ),
            ),
        ],
      ),
    );
  }
}

class CaptureBatchProgressPanel extends StatelessWidget {
  const CaptureBatchProgressPanel({super.key, required this.controller});

  final CaptureController controller;

  @override
  Widget build(BuildContext context) {
    final items = controller.batchItems;
    final completed = items
        .where((item) => item.state == CaptureBatchState.completed)
        .length;
    final failed = items
        .where((item) => item.state == CaptureBatchState.failed)
        .length;
    final active = items.length - completed - failed;
    final hasRefreshable = items.any(
      (item) => item.state == CaptureBatchState.processing && item.retryable,
    );
    final localIds = controller.pending.map((entry) => entry.id).toSet();
    final hasFinished =
        completed > 0 ||
        items.any(
          (item) =>
              item.state == CaptureBatchState.failed &&
              !item.retryable &&
              !localIds.contains(item.id),
        );
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.primaryContainer.withValues(alpha: 0.42),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: scheme.primary.withValues(alpha: 0.24)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.account_tree_outlined, color: scheme.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Document processing',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      '$active active · $completed indexed${failed > 0 ? ' · $failed need attention' : ''}',
                    ),
                  ],
                ),
              ),
              if (hasRefreshable)
                IconButton(
                  tooltip: 'Refresh processing status',
                  onPressed: controller.syncing
                      ? null
                      : () => unawaited(controller.refreshBatchProgress()),
                  icon: const Icon(Icons.refresh_rounded),
                ),
              if (hasFinished)
                TextButton(
                  onPressed: controller.clearFinishedBatchItems,
                  child: const Text('Clear finished'),
                ),
            ],
          ),
          if (active > 0) ...[
            const SizedBox(height: 10),
            LinearProgressIndicator(
              value: items.isEmpty ? null : (completed + failed) / items.length,
            ),
          ],
          const SizedBox(height: 8),
          for (final item in items)
            _CaptureBatchItemTile(controller: controller, item: item),
        ],
      ),
    );
  }
}

class _CaptureBatchItemTile extends StatelessWidget {
  const _CaptureBatchItemTile({required this.controller, required this.item});

  final CaptureController controller;
  final CaptureBatchItem item;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (item.state) {
      CaptureBatchState.queued => (Icons.schedule_rounded, scheme.outline),
      CaptureBatchState.uploading => (
        Icons.cloud_upload_outlined,
        scheme.primary,
      ),
      CaptureBatchState.processing => (
        Icons.auto_awesome_rounded,
        scheme.tertiary,
      ),
      CaptureBatchState.completed => (
        Icons.check_circle_rounded,
        scheme.primary,
      ),
      CaptureBatchState.failed => (Icons.error_outline_rounded, scheme.error),
    };
    final hasLocalCopy = controller.pending.any((entry) => entry.id == item.id);
    final action = switch (item.state) {
      CaptureBatchState.failed when item.retryable => IconButton(
        tooltip: 'Retry upload',
        onPressed: controller.syncing
            ? null
            : () => unawaited(controller.retryBatchItem(item.id)),
        icon: const Icon(Icons.refresh_rounded),
      ),
      CaptureBatchState.processing when item.retryable => IconButton(
        tooltip: 'Refresh processing status',
        onPressed: controller.syncing
            ? null
            : () => unawaited(controller.retryBatchItem(item.id)),
        icon: const Icon(Icons.refresh_rounded),
      ),
      CaptureBatchState.failed when hasLocalCopy => IconButton(
        tooltip: 'Discard encrypted local copy',
        onPressed: controller.syncing
            ? null
            : () => _confirmBatchDiscard(context, controller, item.id),
        icon: const Icon(Icons.delete_outline_rounded),
      ),
      _ => null,
    };
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading:
          item.state == CaptureBatchState.uploading ||
              item.state == CaptureBatchState.processing
          ? SizedBox.square(
              dimension: 22,
              child: CircularProgressIndicator(strokeWidth: 2.2, color: color),
            )
          : Icon(icon, color: color),
      title: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        [
          _captureBatchStateLabel(item.state),
          if (item.progressStage != null) _humanizeStage(item.progressStage!),
          if (item.detail != null) item.detail!,
        ].join(' · '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: action,
    );
  }
}

Future<void> _confirmBatchDiscard(
  BuildContext context,
  CaptureController controller,
  String entryId,
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Discard the local copy?'),
      content: const Text(
        'This removes the encrypted device copy. It does not delete a source already accepted by the server.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Keep'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(dialogContext, true),
          child: const Text('Discard'),
        ),
      ],
    ),
  );
  if (confirmed == true) await controller.discard(entryId);
}

const captureDocumentExtensions = <String>[
  'txt',
  'text',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'log',
  'rtf',
  'tex',
  'sql',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'sass',
  'less',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'sh',
  'zsh',
  'toml',
  'ini',
  'cfg',
  'conf',
  'srt',
  'vtt',
  'eml',
  'ics',
  'vcf',
  'ipynb',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'xlsx',
  'xlsm',
  'pptx',
  'ppsx',
  'odt',
  'ods',
  'odp',
  'epub',
  'pdf',
  'docx',
];

class SelectedCaptureFile {
  const SelectedCaptureFile({required this.file, required this.length});

  final PlatformFile file;
  final int length;
  String get key => captureSelectionKey(file.name, length);
}

String captureSelectionKey(String name, int length) =>
    '${name.trim().toLowerCase()}\u0000$length';

String? captureSelectionMessage({
  required int duplicate,
  required int empty,
  required int tooLarge,
  required int full,
}) {
  final reasons = <String>[
    if (tooLarge > 0) '$tooLarge over 5 MB',
    if (empty > 0) '$empty empty',
    if (duplicate > 0) '$duplicate duplicate',
    if (full > 0) '$full beyond the available encrypted outbox capacity',
  ];
  if (reasons.isEmpty) return null;
  final count = duplicate + empty + tooLarge + full;
  return '$count ${count == 1 ? 'file was' : 'files were'} not added (${reasons.join(', ')}).';
}

String captureBatchTitle(String filename) {
  final value = filename
      .trim()
      .replaceFirst(RegExp(r'\.[^.]+$'), '')
      .replaceAll(RegExp(r'[_-]+'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return value.isEmpty ? 'Untitled capture' : value;
}

CaptureKind bulkCaptureKind(String filename) {
  final extension = filename.split('.').last.toLowerCase();
  return const {'mp3', 'm4a', 'wav', 'ogg', 'mp4', 'webm'}.contains(extension)
      ? CaptureKind.meetingMedia
      : CaptureKind.file;
}

String _captureBatchStateLabel(CaptureBatchState state) => switch (state) {
  CaptureBatchState.queued => 'Queued',
  CaptureBatchState.uploading => 'Uploading',
  CaptureBatchState.processing => 'Processing',
  CaptureBatchState.completed => 'Completed',
  CaptureBatchState.failed => 'Needs attention',
};

String _humanizeStage(String value) {
  final normalized = value.trim().replaceAll(RegExp(r'[_-]+'), ' ');
  if (normalized.isEmpty) return 'Working';
  return '${normalized[0].toUpperCase()}${normalized.substring(1)}';
}

String _fileSize(int bytes) => bytes >= 1024 * 1024
    ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB'
    : '${(bytes / 1024).ceil()} KB';
