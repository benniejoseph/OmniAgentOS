import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';

import 'capture_batch_view.dart';
import 'capture_controller.dart';
import 'capture_drop_intake.dart';
import 'capture_models.dart';
import 'capture_outbox.dart';

export 'capture_controller.dart';
export 'capture_models.dart';

bool get _isMacOS => !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

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
  late CaptureDropIntake dropIntake;
  CaptureAttachment? attachment;
  final List<SelectedCaptureFile> batchFiles = [];
  CaptureKind attachmentKind = CaptureKind.text;
  String? attachmentError;
  CaptureDropSummary? dropSummary;
  bool dropping = false;
  bool picking = false;

  @override
  void initState() {
    super.initState();
    dropIntake = CaptureDropIntake(widget.controller);
    unawaited(recoverInterruptedImagePick());
  }

  @override
  void didUpdateWidget(covariant CaptureView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.controller, widget.controller)) return;
    dropIntake = CaptureDropIntake(widget.controller);
    dropping = false;
    dropSummary = null;
  }

  @override
  void dispose() {
    title.dispose();
    note.dispose();
    tags.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (batchFiles.isNotEmpty) {
      await submitBatch();
      return;
    }
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

  Future<void> submitBatch() async {
    final selected = List<SelectedCaptureFile>.from(batchFiles);
    final sharedTitle = title.text.trim();
    final sharedNote = note.text;
    final sharedTags = tags.text
        .split(',')
        .map((tag) => tag.trim())
        .where((tag) => tag.isNotEmpty)
        .toList();
    final result = await widget.controller.submitBatch(
      selected.map((item) => item.file.name).toList(),
      (index) async {
        final selectedFile = selected[index];
        final currentLength = await selectedFile.file.length();
        if (currentLength != selectedFile.length ||
            currentLength < 1 ||
            currentLength > captureAttachmentMaxBytes) {
          throw const FormatException(
            'The file changed after selection. Choose it again.',
          );
        }
        final bytes = await selectedFile.file.readAsBytes();
        if (bytes.length != currentLength) {
          throw const FormatException(
            'The complete file could not be read. Choose it again.',
          );
        }
        final filenameTitle = captureBatchTitle(selectedFile.file.name);
        final itemTitle = sharedTitle.isEmpty
            ? filenameTitle
            : '$sharedTitle · $filenameTitle';
        return CaptureDraft(
          title: itemTitle.length <= 240
              ? itemTitle
              : itemTitle.substring(0, 240),
          content: sharedNote,
          tags: sharedTags,
          file: CaptureAttachment(
            name: selectedFile.file.name,
            bytes: bytes,
            contentType:
                lookupMimeType(selectedFile.file.name, headerBytes: bytes) ??
                'application/octet-stream',
          ),
          kind: bulkCaptureKind(selectedFile.file.name),
        );
      },
    );
    if (!mounted || result.queued == 0) return;
    title.clear();
    note.clear();
    tags.clear();
    setState(() {
      batchFiles.clear();
      attachmentError = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.failed == 0
              ? '${result.queued} ${result.queued == 1 ? 'document' : 'documents'} encrypted and queued. Processing continues in the background.'
              : '${result.queued} queued; ${result.failed} could not be added. Review the batch below.',
        ),
      ),
    );
  }

  Future<void> pickBatchDocuments() async {
    if (picking || !_isMacOS) return;
    setState(() {
      picking = true;
      attachmentError = null;
    });
    try {
      final files = await FilePicker.pickFiles(
        dialogTitle: 'Choose documents or transcripts',
        type: FileType.custom,
        allowedExtensions: captureDocumentExtensions,
      );
      if (files.isEmpty) return;
      final known = batchFiles.map((item) => item.key).toSet();
      final available =
          (captureBatchMaxFiles -
                  widget.controller.pending.length -
                  batchFiles.length)
              .clamp(0, captureBatchMaxFiles);
      var accepted = 0;
      var duplicate = 0;
      var empty = 0;
      var tooLarge = 0;
      var full = 0;
      final additions = <SelectedCaptureFile>[];
      for (final file in files) {
        final length = await file.length();
        final key = captureSelectionKey(file.name, length);
        if (known.contains(key)) {
          duplicate += 1;
        } else if (length < 1) {
          empty += 1;
        } else if (length > captureAttachmentMaxBytes) {
          tooLarge += 1;
        } else if (accepted >= available) {
          full += 1;
        } else {
          known.add(key);
          additions.add(SelectedCaptureFile(file: file, length: length));
          accepted += 1;
        }
      }
      if (!mounted) return;
      setState(() {
        attachment = null;
        attachmentKind = CaptureKind.text;
        batchFiles.addAll(additions);
        attachmentError = captureSelectionMessage(
          duplicate: duplicate,
          empty: empty,
          tooLarge: tooLarge,
          full: full,
        );
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          attachmentError = 'These files could not be selected. Choose supported documents up to 5 MB each.';
        });
      }
    } finally {
      if (mounted) setState(() => picking = false);
    }
  }

  Future<void> submitDroppedFiles(List<CaptureDropSource> sources) async {
    if (dropping || _dropDisabled) return;
    setState(() {
      dropping = true;
      dropSummary = null;
      attachmentError = null;
    });
    try {
      final result = await dropIntake.submit(
        sources,
        context: CaptureDropContext(
          title: title.text,
          note: note.text,
          tags: tags.text
              .split(',')
              .map((tag) => tag.trim())
              .where((tag) => tag.isNotEmpty)
              .toList(),
        ),
      );
      if (!mounted) return;
      setState(() => dropSummary = result);
      if (result.queued > 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '${result.queued} ${result.queued == 1 ? 'file is' : 'files are'} encrypted and queued. Indexing continues in the background.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => dropping = false);
    }
  }

  bool get _dropDisabled {
    final activeTransfer = widget.controller.batchItems.any(
      (item) =>
          item.state == CaptureBatchState.queued ||
          item.state == CaptureBatchState.uploading,
    );
    return dropping ||
        dropIntake.busy ||
        widget.controller.pending.length >= captureBatchMaxFiles ||
        widget.controller.batchQueueing ||
        widget.controller.submitting ||
        widget.controller.syncing ||
        activeTransfer;
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
        allowedExtensions: captureDocumentExtensions,
      );
      if (file == null) return;
      final length = await file.length();
      if (length == 0 || length > captureAttachmentMaxBytes) {
        throw const FormatException('Choose a non-empty file up to 5 MB.');
      }
      final bytes = await file.readAsBytes();
      if (!mounted) return;
      setState(() {
        batchFiles.clear();
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
      if (length == 0 || length > captureAttachmentMaxBytes) {
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
      if (length == 0 || length > captureAttachmentMaxBytes) {
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
      if (length == 0 || length > captureAttachmentMaxBytes) {
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
      batchFiles.clear();
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
              _isMacOS
                  ? 'Capture a thought or queue a transcript collection. Every document keeps its source and real processing status.'
                  : 'Notes are queued, indexed, and kept searchable with their source.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            if (_isMacOS) ...[
              const SizedBox(height: 18),
              CaptureDropSurface(
                enabled: !_dropDisabled,
                busy: dropping || dropIntake.busy,
                remainingCapacity:
                    (captureBatchMaxFiles - widget.controller.pending.length)
                        .clamp(0, captureBatchMaxFiles),
                onDrop: submitDroppedFiles,
              ),
              if (dropSummary != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8, left: 4),
                  child: Text(
                    dropSummary!.message,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: dropSummary!.hasProblems
                          ? Theme.of(context).colorScheme.error
                          : Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ),
            ],
            const SizedBox(height: 24),
            TextField(
              controller: title,
              decoration: const InputDecoration(
                labelText: 'Title',
                helperText:
                    'Optional; for a batch this becomes the collection label',
                prefixIcon: Icon(Icons.title_rounded),
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (!_isMacOS)
                  OutlinedButton.icon(
                    onPressed: picking || widget.controller.submitting
                        ? null
                        : () => pickImage(ImageSource.camera, CaptureKind.scan),
                    icon: const Icon(Icons.document_scanner_outlined),
                    label: const Text('Scan page'),
                  ),
                if (_isMacOS)
                  FilledButton.tonalIcon(
                    onPressed:
                        picking ||
                            widget.controller.submitting ||
                            widget.controller.batchQueueing
                        ? null
                        : pickBatchDocuments,
                    icon: const Icon(Icons.library_add_outlined),
                    label: const Text('Add documents in bulk'),
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
            if (batchFiles.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: CaptureSelectionPanel(
                  files: batchFiles,
                  onRemove: (item) => setState(() => batchFiles.remove(item)),
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
            if (widget.controller.batchItems.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: CaptureBatchProgressPanel(controller: widget.controller),
              ),
            if (widget.controller.pendingWithoutBatch.isNotEmpty)
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
              onPressed:
                  widget.controller.submitting ||
                      widget.controller.batchQueueing ||
                      widget.controller.syncing
                  ? null
                  : submit,
              icon:
                  widget.controller.submitting ||
                      widget.controller.batchQueueing
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.bolt_rounded),
              label: Text(
                widget.controller.batchQueueing
                    ? 'Encrypting batch…'
                    : widget.controller.submitting
                    ? 'Saving capture…'
                    : batchFiles.isNotEmpty
                    ? 'Queue ${batchFiles.length} ${batchFiles.length == 1 ? 'document' : 'documents'}'
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
                constraints: BoxConstraints(maxWidth: _isMacOS ? 1320 : 1080),
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
  Widget build(BuildContext context) {
    final entries = controller.pendingWithoutBatch;
    return Container(
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
                  '${entries.length} encrypted ${entries.length == 1 ? 'capture' : 'captures'} waiting',
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
          for (final entry in entries.take(4))
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
          if (entries.length > 4)
            Text('+ ${entries.length - 4} more encrypted captures'),
        ],
      ),
    );
  }

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
