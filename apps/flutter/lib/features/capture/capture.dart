import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';

import '../../core/network/api_exception.dart';
import 'capture_outbox.dart';

class CaptureDraft {
  const CaptureDraft({
    required this.content,
    this.title = '',
    this.tags = const [],
    this.file,
    this.kind = CaptureKind.text,
  });
  final String content, title;
  final List<String> tags;
  final CaptureAttachment? file;
  final CaptureKind kind;
  bool get valid => validationError == null;
  String? get validationError {
    if (content.trim().isEmpty && file == null) {
      return 'Add a note or attachment.';
    }
    if (content.length > 20000) {
      return 'Notes must be 20,000 characters or shorter.';
    }
    if (title.length > 240) return 'Titles must be 240 characters or shorter.';
    if (tags.length > 50 || tags.any((tag) => tag.trim().length > 80)) {
      return 'Use at most 50 tags, each 80 characters or shorter.';
    }
    if (file != null &&
        (file!.bytes.isEmpty || file!.bytes.length > 5 * 1024 * 1024)) {
      return 'Choose a non-empty attachment up to 5 MB.';
    }
    return null;
  }
}

enum CaptureKind { text, scan, image, file, meetingMedia }

class CaptureAttachment {
  const CaptureAttachment({
    required this.name,
    required this.bytes,
    required this.contentType,
  });
  final String name, contentType;
  final Uint8List bytes;
}

class CaptureReceipt {
  const CaptureReceipt({
    required this.jobId,
    required this.title,
    required this.tags,
  });
  final String jobId, title;
  final List<String> tags;
}

abstract interface class CaptureRepository {
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  });
}

class CaptureController extends ChangeNotifier {
  CaptureController(this.repository, this.outbox, this.owner);
  final CaptureRepository repository;
  final CaptureOutbox outbox;
  final CaptureOwnerBinding? owner;
  bool submitting = false, loadingOutbox = false, syncing = false;
  bool lastSubmitQueued = false;
  Object? error;
  Object? syncError;
  CaptureReceipt? receipt;
  List<CaptureOutboxEntry> pending = const [];

  Future<void> initialize() async {
    if (owner == null || loadingOutbox || syncing) return;
    final generation = _generation;
    loadingOutbox = true;
    _emit();
    try {
      final restored = await outbox.list(owner!);
      if (generation != _generation) return;
      pending = restored;
      error = null;
    } catch (e) {
      error = e;
    } finally {
      loadingOutbox = false;
      _emit();
    }
    if (generation != _generation) return;
    if (pending.isNotEmpty) await syncPending();
  }

  Future<bool> submit(CaptureDraft draft) async {
    if (submitting || owner == null) return false;
    if (!draft.valid) {
      error = FormatException(draft.validationError!);
      _emit();
      return false;
    }
    submitting = true;
    error = null;
    syncError = null;
    lastSubmitQueued = false;
    receipt = null;
    _emit();
    try {
      final entry = await outbox.enqueue(owner!, draft);
      pending = await outbox.list(owner!);
      _emit();
      try {
        receipt = await repository.submit(
          entry.draft,
          idempotencyKey: entry.idempotencyKey,
          owner: owner!,
        );
        await outbox.remove(owner!, entry.id);
        pending = await outbox.list(owner!);
      } catch (e) {
        syncError = e;
        lastSubmitQueued = true;
      }
      return true;
    } catch (e) {
      error = e;
      return false;
    } finally {
      submitting = false;
      _emit();
    }
  }

  Future<void> syncPending() async {
    if (owner == null || syncing || submitting || loadingOutbox) return;
    final generation = _generation;
    syncing = true;
    syncError = null;
    _emit();
    try {
      final entries = await outbox.list(owner!);
      for (final entry in entries) {
        try {
          receipt = await repository.submit(
            entry.draft,
            idempotencyKey: entry.idempotencyKey,
            owner: owner!,
          );
          await outbox.remove(owner!, entry.id);
        } catch (e) {
          syncError = e;
          if (_stopBatchAfter(e)) break;
        }
      }
      final restored = await outbox.list(owner!);
      if (generation == _generation) pending = restored;
    } catch (e) {
      error = e;
    } finally {
      syncing = false;
      _emit();
    }
  }

  Future<void> discard(String entryId) async {
    if (owner == null || syncing || submitting) return;
    try {
      await outbox.remove(owner!, entryId);
      pending = await outbox.list(owner!);
      syncError = null;
    } catch (e) {
      error = e;
    }
    _emit();
  }

  void lock() {
    _generation += 1;
    pending = const [];
    receipt = null;
    error = null;
    syncError = null;
    _emit();
  }

  int _generation = 0;
  bool _disposed = false;

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    super.dispose();
  }
}

bool _stopBatchAfter(Object error) =>
    error is! ApiException ||
    error.statusCode == null ||
    error.statusCode == 401 ||
    error.statusCode == 403 ||
    error.statusCode == 408 ||
    error.statusCode == 429 ||
    (error.statusCode ?? 0) >= 500;

class CaptureView extends StatefulWidget {
  const CaptureView({super.key, required this.controller});
  final CaptureController controller;
  @override
  State<CaptureView> createState() => _CaptureViewState();
}

class _CaptureViewState extends State<CaptureView> {
  final title = TextEditingController(),
      note = TextEditingController(),
      tags = TextEditingController();
  final imagePicker = ImagePicker();
  CaptureAttachment? attachment;
  CaptureKind attachmentKind = CaptureKind.text;
  String? attachmentError;
  bool picking = false;

  @override
  void initState() {
    super.initState();
    unawaited(recoverInterruptedImagePick());
  }

  @override
  void dispose() {
    title.dispose();
    note.dispose();
    tags.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    final ok = await widget.controller.submit(
      CaptureDraft(
        title: title.text,
        content: note.text,
        tags: tags.text
            .split(',')
            .map((e) => e.trim())
            .where((e) => e.isNotEmpty)
            .toList(),
        file: attachment,
        kind: attachment == null ? CaptureKind.text : attachmentKind,
      ),
    );
    if (ok && mounted) {
      title.clear();
      note.clear();
      tags.clear();
      setState(() {
        attachment = null;
        attachmentKind = CaptureKind.text;
        attachmentError = null;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            widget.controller.lastSubmitQueued
                ? 'Saved encrypted on this device. It will sync after reconnecting.'
                : 'Capture queued for your knowledge base',
          ),
        ),
      );
    }
  }

  Future<void> pickAttachment() async {
    if (picking) return;
    setState(() {
      picking = true;
      attachmentError = null;
    });
    try {
      final file = await FilePicker.pickFile(
        dialogTitle: 'Choose a capture file',
        type: FileType.custom,
        allowedExtensions: const [
          'txt',
          'md',
          'csv',
          'json',
          'html',
          'xml',
          'yaml',
          'log',
          'rtf',
          'sql',
          'js',
          'ts',
          'tsx',
          'py',
          'swift',
          'kt',
          'toml',
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
        ],
      );
      if (file == null) return;
      final length = await file.length();
      if (length == 0 || length > 5 * 1024 * 1024) {
        throw const FormatException('Choose a non-empty file up to 5 MB.');
      }
      final bytes = await file.readAsBytes();
      if (!mounted) return;
      setState(() {
        attachment = CaptureAttachment(
          name: file.name,
          bytes: bytes,
          contentType:
              lookupMimeType(file.name, headerBytes: bytes) ??
              'application/octet-stream',
        );
        attachmentKind = CaptureKind.file;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          attachmentError = 'This file could not be attached. Choose a supported file up to 5 MB.';
        });
      }
    } finally {
      if (mounted) setState(() => picking = false);
    }
  }

  Future<void> pickMeetingMedia() => pickWithFilePicker(
    kind: CaptureKind.meetingMedia,
    extensions: const ['mp3', 'm4a', 'wav', 'ogg', 'mp4', 'webm'],
    dialogTitle: 'Choose meeting audio or video',
  );

  Future<void> pickWithFilePicker({
    required CaptureKind kind,
    required List<String> extensions,
    required String dialogTitle,
  }) async {
    if (picking) return;
    setState(() {
      picking = true;
      attachmentError = null;
    });
    try {
      final file = await FilePicker.pickFile(
        dialogTitle: dialogTitle,
        type: FileType.custom,
        allowedExtensions: extensions,
      );
      if (file == null) return;
      final length = await file.length();
      if (length == 0 || length > 5 * 1024 * 1024) {
        throw const FormatException('Choose a non-empty file up to 5 MB.');
      }
      final bytes = await file.readAsBytes();
      _setAttachment(file.name, bytes, kind);
    } catch (_) {
      _setAttachmentError();
    } finally {
      if (mounted) setState(() => picking = false);
    }
  }

  Future<void> pickImage(ImageSource source, CaptureKind kind) async {
    if (picking) return;
    setState(() {
      picking = true;
      attachmentError = null;
    });
    try {
      final file = await imagePicker.pickImage(
        source: source,
        imageQuality: 90,
        maxWidth: 2400,
        requestFullMetadata: false,
      );
      if (file == null) return;
      final length = await file.length();
      if (length == 0 || length > 5 * 1024 * 1024) {
        throw const FormatException('Choose a non-empty image up to 5 MB.');
      }
      _setAttachment(file.name, await file.readAsBytes(), kind);
    } catch (_) {
      _setAttachmentError();
    } finally {
      if (mounted) setState(() => picking = false);
    }
  }

  Future<void> recoverInterruptedImagePick() async {
    try {
      final recovered = await imagePicker.retrieveLostData();
      if (recovered.isEmpty || recovered.file == null) return;
      final file = recovered.file!;
      final length = await file.length();
      if (length == 0 || length > 5 * 1024 * 1024) {
        throw const FormatException('Choose a non-empty image up to 5 MB.');
      }
      _setAttachment(file.name, await file.readAsBytes(), CaptureKind.image);
    } catch (_) {
      _setAttachmentError();
    }
  }

  void _setAttachment(String name, Uint8List bytes, CaptureKind kind) {
    if (!mounted) return;
    setState(() {
      attachment = CaptureAttachment(
        name: name,
        bytes: bytes,
        contentType:
            lookupMimeType(name, headerBytes: bytes) ??
            'application/octet-stream',
      );
      attachmentKind = kind;
      attachmentError = null;
    });
  }

  void _setAttachmentError() {
    if (!mounted) return;
    setState(() {
      attachmentError = 'This item could not be attached. Choose a supported file up to 5 MB.';
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Capture')),
    body: ListenableBuilder(
      listenable: widget.controller,
      builder: (_, _) => LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 800;
          final form = <Widget>[
            Text(
              'Capture what matters',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              'Notes are queued, indexed, and kept searchable with their source.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: 24),
            TextField(
              controller: title,
              decoration: const InputDecoration(
                labelText: 'Title',
                helperText: 'Optional, a title is generated when left empty',
                prefixIcon: Icon(Icons.title_rounded),
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: picking || widget.controller.submitting
                      ? null
                      : () => pickImage(ImageSource.camera, CaptureKind.scan),
                  icon: const Icon(Icons.document_scanner_outlined),
                  label: const Text('Scan page'),
                ),
                OutlinedButton.icon(
                  onPressed: picking || widget.controller.submitting
                      ? null
                      : () => pickImage(ImageSource.gallery, CaptureKind.image),
                  icon: const Icon(Icons.add_photo_alternate_outlined),
                  label: const Text('Add image'),
                ),
                OutlinedButton.icon(
                  onPressed: picking || widget.controller.submitting
                      ? null
                      : pickAttachment,
                  icon: const Icon(Icons.attach_file_rounded),
                  label: const Text('Attach file'),
                ),
                OutlinedButton.icon(
                  onPressed: picking || widget.controller.submitting
                      ? null
                      : pickMeetingMedia,
                  icon: const Icon(Icons.video_file_outlined),
                  label: const Text('Meeting media'),
                ),
                if (picking)
                  const Padding(
                    padding: EdgeInsets.all(10),
                    child: SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
              ],
            ),
            if (attachment != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: InputChip(
                  avatar: const Icon(Icons.description_outlined, size: 18),
                  label: Text(
                    '${attachment!.name} · ${_fileSize(attachment!.bytes.length)}',
                  ),
                  onDeleted: widget.controller.submitting
                      ? null
                      : () => setState(() {
                          attachment = null;
                          attachmentKind = CaptureKind.text;
                        }),
                ),
              ),
            if (attachmentError != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  attachmentError!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 12),
            TextField(
              controller: note,
              minLines: 7,
              maxLines: 16,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Note',
                hintText:
                    'Paste a thought, link, meeting note, or research fragment',
                alignLabelWithHint: true,
                prefixIcon: Padding(
                  padding: EdgeInsets.only(bottom: 120),
                  child: Icon(Icons.edit_note_rounded),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: tags,
              decoration: const InputDecoration(
                labelText: 'Tags',
                hintText: 'research, launch, idea',
                prefixIcon: Icon(Icons.tag_rounded),
              ),
            ),
            if (widget.controller.loadingOutbox)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: LinearProgressIndicator(),
              ),
            if (widget.controller.pending.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: _CaptureOutboxPanel(controller: widget.controller),
              ),
            if (widget.controller.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  widget.controller.error is CaptureOutboxIntegrityException
                      ? 'Encrypted captures could not be verified. Nothing was uploaded.'
                      : 'Could not save this capture. Your draft is still here.',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (widget.controller.syncError != null &&
                widget.controller.pending.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  'The capture service is unavailable. Retry after reconnecting.',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: widget.controller.submitting ? null : submit,
              icon: widget.controller.submitting
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.bolt_rounded),
              label: Text(
                widget.controller.submitting
                    ? 'Saving capture…'
                    : 'Save capture',
              ),
            ),
          ];
          final receipt = AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            switchInCurve: Curves.easeOutCubic,
            child: widget.controller.receipt == null
                ? const _CaptureGuide(key: ValueKey('guide'))
                : _CaptureSuccess(
                    key: const ValueKey('success'),
                    receipt: widget.controller.receipt!,
                  ),
          );
          return SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1080),
                child: wide
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            flex: 3,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: form,
                            ),
                          ),
                          const SizedBox(width: 28),
                          Expanded(flex: 2, child: receipt),
                        ],
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          ...form,
                          const SizedBox(height: 24),
                          receipt,
                        ],
                      ),
              ),
            ),
          );
        },
      ),
    ),
  );
}

String _fileSize(int bytes) => bytes >= 1024 * 1024
    ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB'
    : '${(bytes / 1024).ceil()} KB';

class _CaptureGuide extends StatelessWidget {
  const _CaptureGuide({super.key});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.hub_outlined, color: Theme.of(context).colorScheme.primary),
        const SizedBox(height: 16),
        Text(
          'What happens next',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 12),
        const _GuideRow(
          icon: Icons.enhanced_encryption_outlined,
          text: 'Encrypted on this device before upload',
        ),
        const _GuideRow(
          icon: Icons.manage_search_rounded,
          text: 'Indexed for semantic search',
        ),
        const _GuideRow(
          icon: Icons.link_rounded,
          text: 'Connected to related knowledge',
        ),
      ],
    ),
  );
}

class _GuideRow extends StatelessWidget {
  const _GuideRow({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Row(
      children: [
        Icon(icon, size: 19),
        const SizedBox(width: 10),
        Expanded(child: Text(text)),
      ],
    ),
  );
}

class _CaptureOutboxPanel extends StatelessWidget {
  const _CaptureOutboxPanel({required this.controller});
  final CaptureController controller;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.secondaryContainer,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.lock_clock_outlined),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '${controller.pending.length} encrypted ${controller.pending.length == 1 ? 'capture' : 'captures'} waiting',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            TextButton.icon(
              onPressed: controller.syncing ? null : controller.syncPending,
              icon: controller.syncing
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.sync_rounded),
              label: const Text('Sync'),
            ),
          ],
        ),
        Text(
          controller.syncError == null
              ? 'These items sync only for this signed-in workspace.'
              : 'Sync paused. The encrypted originals remain on this device.',
        ),
        const SizedBox(height: 8),
        for (final entry in controller.pending.take(4))
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(_captureKindIcon(entry.draft.kind)),
            title: Text(_captureKindLabel(entry.draft.kind)),
            subtitle: Text(_queuedTime(entry.createdAt)),
            trailing: IconButton(
              tooltip: 'Discard encrypted capture',
              icon: const Icon(Icons.delete_outline_rounded),
              onPressed: controller.syncing
                  ? null
                  : () => _confirmDiscard(context, entry),
            ),
          ),
        if (controller.pending.length > 4)
          Text('+ ${controller.pending.length - 4} more encrypted captures'),
      ],
    ),
  );

  Future<void> _confirmDiscard(
    BuildContext context,
    CaptureOutboxEntry entry,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Discard this capture?'),
        content: const Text(
          'This permanently removes the encrypted local copy before it syncs.',
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
    if (confirmed == true) await controller.discard(entry.id);
  }
}

String _captureKindLabel(CaptureKind kind) => switch (kind) {
  CaptureKind.text => 'Text note',
  CaptureKind.scan => 'Scanned page',
  CaptureKind.image => 'Image',
  CaptureKind.file => 'File',
  CaptureKind.meetingMedia => 'Meeting media',
};

IconData _captureKindIcon(CaptureKind kind) => switch (kind) {
  CaptureKind.text => Icons.notes_rounded,
  CaptureKind.scan => Icons.document_scanner_outlined,
  CaptureKind.image => Icons.image_outlined,
  CaptureKind.file => Icons.description_outlined,
  CaptureKind.meetingMedia => Icons.video_file_outlined,
};

String _queuedTime(DateTime createdAt) {
  final local = createdAt.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return 'Saved ${local.month}/${local.day} at $hour:$minute';
}

class _CaptureSuccess extends StatelessWidget {
  const _CaptureSuccess({super.key, required this.receipt});
  final CaptureReceipt receipt;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primaryContainer,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          Icons.check_circle_rounded,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(height: 14),
        Text('Capture queued', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 6),
        Text(
          receipt.title.isEmpty ? 'Your note is being indexed.' : receipt.title,
        ),
        if (receipt.tags.isNotEmpty) ...[
          const SizedBox(height: 14),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: receipt.tags
                .map(
                  (tag) => Chip(
                    label: Text(tag),
                    visualDensity: VisualDensity.compact,
                  ),
                )
                .toList(),
          ),
        ],
      ],
    ),
  );
}
