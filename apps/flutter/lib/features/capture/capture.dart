import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';
import 'package:go_router/go_router.dart';

import '../../app/platform/mobile_presentation.dart';
import '../../app/mobile/mobile_page_scaffold.dart';

import '../../app/macos/macos_page_scaffold.dart';
import 'capture_batch_view.dart';
import 'capture_controller.dart';
import 'capture_drop_intake.dart';
import 'capture_models.dart';
import 'capture_outbox.dart';
import 'capture_recording.dart';
import 'capture_recording_panel.dart';
import 'capture_receipt_panel.dart';
import 'library_view.dart';

export 'capture_controller.dart';
export 'capture_models.dart';

bool get _isMacOS => !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;
bool get _isDesktop =>
    !kIsWeb &&
    const {
      TargetPlatform.macOS,
      TargetPlatform.windows,
      TargetPlatform.linux,
    }.contains(defaultTargetPlatform);

enum CaptureMode { note, record, upload }

/// Static diagnostic categories only: platform messages can contain paths.
@visibleForTesting
String captureFileSelectionFailureCategory(Object error) => switch (error) {
  PlatformException(
    code: 'ENTITLEMENT_NOT_FOUND' || 'ENTITLEMENT_CHECK_FAILED',
  ) =>
    'picker_configuration',
  MissingPluginException() => 'picker_unavailable',
  _ => 'selection_failed',
};

@visibleForTesting
bool shouldRecoverInterruptedImagePick({
  bool? isWeb,
  TargetPlatform? platform,
}) =>
    !(isWeb ?? kIsWeb) &&
    (platform ?? defaultTargetPlatform) == TargetPlatform.android;

class CaptureView extends StatefulWidget {
  const CaptureView({
    super.key,
    required this.controller,
    this.onOpenKnowledge,
    this.recorder,
  });
  final CaptureController controller;
  final VoidCallback? onOpenKnowledge;
  final CaptureRecorder? recorder;
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
  CaptureMode mode = CaptureMode.note;
  bool _mobileEditorOpen = false;
  late CaptureRecordingController recording;
  int _scopeGeneration = 0, _intakeEpoch = 0;
  bool get _busy =>
      !widget.controller.canWrite ||
      widget.controller.busy ||
      picking ||
      dropping ||
      recording.busy ||
      recording.microphoneActive ||
      !recording.microphoneStateKnown;
  bool _current(CaptureController controller, int generation, int epoch) =>
      mounted &&
      identical(controller, widget.controller) &&
      controller.current(generation) &&
      epoch == _intakeEpoch;

  @override
  void initState() {
    super.initState();
    dropIntake = CaptureDropIntake(widget.controller);
    _scopeGeneration = widget.controller.generation;
    recording = CaptureRecordingController(
      widget.controller,
      widget.recorder ?? NativeCaptureRecorder(),
    );
    widget.controller.addListener(_authorityChanged);
    // image_picker's lost-data handoff is an Android lifecycle recovery API.
    // Calling it on macOS throws before the user has selected anything and
    // leaves Capture showing a false attachment failure on first open.
    if (shouldRecoverInterruptedImagePick()) {
      unawaited(recoverInterruptedImagePick());
    }
  }

  void _clearDraft() {
    _intakeEpoch++;
    title.clear();
    note.clear();
    tags.clear();
    // CaptureController snapshots admitted attachments, so clearing this UI
    // draft cannot alter an upload already admitted by the owner-scoped queue.
    attachment?.bytes.fillRange(0, attachment!.bytes.length, 0);
    attachment = null;
    attachmentKind = CaptureKind.text;
    attachmentError = null;
    batchFiles.clear();
    dropSummary = null;
    picking = dropping = false;
    _mobileEditorOpen = false;
  }

  void _authorityChanged() {
    if (_scopeGeneration == widget.controller.generation &&
        widget.controller.available) {
      return;
    }
    _scopeGeneration = widget.controller.generation;
    _clearDraft();
    if (mounted) {
      setState(() {});
    }
  }

  @override
  void didUpdateWidget(covariant CaptureView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.controller, widget.controller)) {
      return;
    }
    oldWidget.controller.removeListener(_authorityChanged);
    recording.dispose();
    _clearDraft();
    mode = CaptureMode.note;
    _scopeGeneration = widget.controller.generation;
    dropIntake = CaptureDropIntake(widget.controller);
    recording = CaptureRecordingController(
      widget.controller,
      widget.recorder ?? NativeCaptureRecorder(),
    );
    widget.controller.addListener(_authorityChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_authorityChanged);
    recording.dispose();
    _clearDraft();
    title.dispose();
    note.dispose();
    tags.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (_busy) {
      return;
    }
    if (batchFiles.isNotEmpty) {
      await submitBatch();
      return;
    }
    final controller = widget.controller;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    final ok = await controller.submit(
      CaptureDraft(
        title: title.text,
        content: note.text,
        tags: tags.text
            .split(',')
            .map((tag) => tag.trim())
            .where((tag) => tag.isNotEmpty)
            .toList(),
        file: attachment,
        kind: attachment == null ? CaptureKind.text : attachmentKind,
      ),
    );
    if (!mounted || !ok || !_current(controller, generation, epoch)) {
      return;
    }
    final queued = controller.lastSubmitQueued;
    setState(_clearDraft);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          queued
              ? 'Saved encrypted on this device. Review the queue for retry status.'
              : 'The Capture service accepted this source. Processing is shown separately.',
        ),
      ),
    );
  }

  Future<void> submitBatch() async {
    if (_busy) {
      return;
    }
    final controller = widget.controller;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    bool current() => _current(controller, generation, epoch);
    final selected = List<SelectedCaptureFile>.from(batchFiles),
        sharedTitle = title.text.trim(),
        sharedNote = note.text;
    final sharedTags = tags.text
        .split(',')
        .map((tag) => tag.trim())
        .where((tag) => tag.isNotEmpty)
        .toList();
    final result = await controller.submitBatch(
      selected.map((item) => item.file.name).toList(),
      (index) async {
        final selectedFile = selected[index];
        final length = await selectedFile.file.length();
        if (!current()) {
          throw StateError('Capture access changed.');
        }
        if (length != selectedFile.length ||
            length < 1 ||
            length > captureAttachmentMaxBytes) {
          throw const FormatException(
            'The file changed after selection. Choose it again.',
          );
        }
        final bytes = await selectedFile.file.readAsBytes();
        if (!current() || bytes.length != length) {
          bytes.fillRange(0, bytes.length, 0);
          throw const FormatException(
            'The complete file could not be read in the current Capture session.',
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
    if (!mounted || !current() || result.queued == 0) {
      return;
    }
    setState(_clearDraft);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          '${result.queued} encrypted and queued${result.failed == 0 ? '.' : '; ${result.failed} were not added.'} Review transfer and processing below.',
        ),
      ),
    );
  }

  Future<void> pickBatchDocuments() async {
    if (_busy) {
      return;
    }
    final controller = widget.controller;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    bool current() => _current(controller, generation, epoch);
    setState(() {
      picking = true;
      attachmentError = null;
    });
    try {
      final files = await FilePicker.pickFiles(
        dialogTitle: 'Choose capture files',
        type: FileType.custom,
        allowedExtensions: captureDocumentExtensions,
      );
      if (!current() || files.isEmpty) {
        return;
      }
      final known = batchFiles.map((item) => item.key).toSet();
      final capacity =
          (captureBatchMaxFiles - controller.pending.length - batchFiles.length)
              .clamp(0, captureBatchMaxFiles);
      var accepted = 0, duplicate = 0, empty = 0, tooLarge = 0, full = 0;
      final additions = <SelectedCaptureFile>[];
      for (final file in files) {
        final length = await file.length();
        if (!current()) {
          return;
        }
        final key = captureSelectionKey(file.name, length);
        if (known.contains(key)) {
          duplicate++;
        } else if (length < 1) {
          empty++;
        } else if (length > captureAttachmentMaxBytes) {
          tooLarge++;
        } else if (accepted >= capacity) {
          full++;
        } else {
          known.add(key);
          additions.add(SelectedCaptureFile(file: file, length: length));
          accepted++;
        }
      }
      if (!current()) {
        return;
      }
      setState(() {
        attachment?.bytes.fillRange(0, attachment!.bytes.length, 0);
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
    } catch (error) {
      final category = captureFileSelectionFailureCategory(error);
      debugPrint('Capture file selection failed: $category');
      if (current()) {
        setState(
          () => attachmentError =
              category == 'picker_configuration' ||
                  category == 'picker_unavailable'
              ? 'The file chooser is unavailable in this app build. Update Asael and try again.'
              : 'The selected files could not be opened. Try choosing them again.',
        );
      }
    } finally {
      if (current()) {
        setState(() => picking = false);
      }
    }
  }

  Future<void> submitDroppedFiles(List<CaptureDropSource> sources) async {
    if (_busy || _dropDisabled) {
      return;
    }
    final controller = widget.controller, intake = dropIntake;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    bool current() => _current(controller, generation, epoch);
    setState(() {
      dropping = true;
      dropSummary = null;
      attachmentError = null;
    });
    try {
      final result = await intake.submit(
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
      if (current()) {
        setState(() => dropSummary = result);
      }
    } finally {
      if (current()) {
        setState(() => dropping = false);
      }
    }
  }

  bool get _dropDisabled =>
      !widget.controller.canWrite ||
      dropping ||
      dropIntake.busy ||
      widget.controller.busy ||
      widget.controller.pending.length >= captureBatchMaxFiles ||
      widget.controller.batchItems.any(
        (item) => const {
          CaptureBatchState.queued,
          CaptureBatchState.uploading,
        }.contains(item.state),
      );

  Future<void> pickMeetingMedia() => pickWithFilePicker(
    kind: CaptureKind.meetingMedia,
    extensions: const ['mp3', 'm4a', 'wav', 'ogg', 'mp4', 'webm'],
    dialogTitle: 'Choose audio or video',
  );
  Future<void> pickWithFilePicker({
    required CaptureKind kind,
    required List<String> extensions,
    required String dialogTitle,
  }) async {
    if (_busy) {
      return;
    }
    final controller = widget.controller;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    bool current() => _current(controller, generation, epoch);
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
      if (!current() || file == null) {
        return;
      }
      final length = await file.length();
      if (!current()) {
        return;
      }
      if (length < 1 || length > captureAttachmentMaxBytes) {
        throw const FormatException('Choose a non-empty file up to 5 MB.');
      }
      final bytes = await file.readAsBytes();
      if (bytes.length != length) {
        bytes.fillRange(0, bytes.length, 0);
        throw const FormatException('The file changed while reading.');
      }
      _setAttachment(file.name, bytes, kind, current: current);
    } catch (_) {
      if (current()) {
        setState(
          () => attachmentError = 'This item could not be attached. Choose a supported file up to 5 MB.',
        );
      }
    } finally {
      if (current()) {
        setState(() => picking = false);
      }
    }
  }

  Future<void> pickImage(ImageSource source, CaptureKind kind) async {
    if (_busy) {
      return;
    }
    final controller = widget.controller;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    bool current() => _current(controller, generation, epoch);
    setState(() {
      picking = true;
      attachmentError = null;
    });
    try {
      final file = await imagePicker.pickImage(
        source: source,
        requestFullMetadata: false,
      );
      if (!current() || file == null) {
        return;
      }
      final length = await file.length();
      if (!current()) {
        return;
      }
      if (length < 1 || length > captureAttachmentMaxBytes) {
        throw const FormatException('Choose a non-empty image up to 5 MB.');
      }
      final bytes = await file.readAsBytes();
      if (bytes.length != length) {
        bytes.fillRange(0, bytes.length, 0);
        throw const FormatException('The image changed while reading.');
      }
      _setAttachment(file.name, bytes, kind, current: current);
    } catch (_) {
      if (current()) {
        setState(
          () => attachmentError =
              'This image could not be attached. Choose an image up to 5 MB.',
        );
      }
    } finally {
      if (current()) {
        setState(() => picking = false);
      }
    }
  }

  Future<void> recoverInterruptedImagePick() async {
    final controller = widget.controller;
    final generation = controller.generation, epoch = ++_intakeEpoch;
    bool current() => _current(controller, generation, epoch);
    try {
      final recovered = await imagePicker.retrieveLostData();
      if (!current() || recovered.isEmpty || recovered.file == null) {
        return;
      }
      final file = recovered.file!, length = await recovered.file!.length();
      if (!current()) {
        return;
      }
      if (length < 1 || length > captureAttachmentMaxBytes) {
        throw const FormatException('Choose a non-empty image up to 5 MB.');
      }
      final bytes = await file.readAsBytes();
      if (bytes.length != length) {
        bytes.fillRange(0, bytes.length, 0);
        throw const FormatException('The recovered image changed.');
      }
      _setAttachment(file.name, bytes, CaptureKind.image, current: current);
    } catch (_) {
      if (current()) {
        setState(
          () => attachmentError = 'The interrupted image selection could not be recovered. Choose it again.',
        );
      }
    }
  }

  void _setAttachment(
    String name,
    Uint8List bytes,
    CaptureKind kind, {
    required bool Function() current,
  }) {
    if (!current()) {
      bytes.fillRange(0, bytes.length, 0);
      return;
    }
    setState(() {
      batchFiles.clear();
      attachment?.bytes.fillRange(0, attachment!.bytes.length, 0);
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

  Widget _mobileStudio(CaptureController controller) {
    final theme = Theme.of(context);
    final hasDraft =
        title.text.isNotEmpty ||
        note.text.isNotEmpty ||
        tags.text.isNotEmpty ||
        attachment != null ||
        batchFiles.isNotEmpty;
    void open(CaptureMode next) => setState(() {
      mode = next;
      _mobileEditorOpen = true;
    });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Capture', style: theme.textTheme.headlineLarge),
                  const SizedBox(height: 8),
                  Text(
                    'A place for every thought.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            IconButton.filledTonal(
              tooltip: 'Saved sources',
              onPressed: controller.available
                  ? () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const NativeLibraryPage(),
                      ),
                    )
                  : null,
              icon: const Icon(Icons.folder_open_outlined),
            ),
          ],
        ),
        const SizedBox(height: 28),
        MobileSurface(
          spotlight: true,
          padding: EdgeInsets.zero,
          child: Builder(
            builder: (context) => InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: _busy ? null : () => context.go('/capture?section=listen'),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(
                          Icons.graphic_eq_rounded,
                          size: 30,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                        const Spacer(),
                        const Icon(Icons.arrow_outward_rounded, size: 22),
                      ],
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'Be in the moment.',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Turn conversations into notes, people and next steps.',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        height: 1.5,
                      ),
                    ),
                    const SizedBox(height: 20),
                    const MobileStatusPill(
                      label: 'Open Listen',
                      icon: Icons.mic_none_rounded,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 24),
        Text(
          'What would you like to keep?',
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 14),
        LayoutBuilder(
          builder: (context, constraints) {
            final wide =
                constraints.maxWidth >= 340 &&
                MediaQuery.textScalerOf(context).scale(14) < 22;
            final width = wide
                ? (constraints.maxWidth - 12) / 2
                : constraints.maxWidth;
            return Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                SizedBox(
                  width: width,
                  child: _MobileCaptureChoice(
                    icon: Icons.edit_note_rounded,
                    title: 'Write a note',
                    subtitle: 'Ideas, links, reminders',
                    onTap: _busy ? null : () => open(CaptureMode.note),
                  ),
                ),
                SizedBox(
                  width: width,
                  child: _MobileCaptureChoice(
                    icon: Icons.document_scanner_outlined,
                    title: 'Scan a moment',
                    subtitle: 'A page, slide or photo',
                    onTap: _busy
                        ? null
                        : () {
                            open(CaptureMode.upload);
                            pickImage(ImageSource.camera, CaptureKind.scan);
                          },
                  ),
                ),
                SizedBox(
                  width: width,
                  child: _MobileCaptureChoice(
                    icon: Icons.file_upload_outlined,
                    title: 'Add files',
                    subtitle: 'Documents and media',
                    onTap: _busy ? null : () => open(CaptureMode.upload),
                  ),
                ),
                SizedBox(
                  width: width,
                  child: _MobileCaptureChoice(
                    icon: Icons.mic_none_rounded,
                    title: 'Voice note',
                    subtitle: 'Say what’s on your mind',
                    onTap: _busy ? null : () => open(CaptureMode.record),
                  ),
                ),
              ],
            );
          },
        ),
        if (hasDraft) ...[
          const SizedBox(height: 20),
          MobileActionTile(
            icon: Icons.edit_outlined,
            title: 'Continue your capture',
            subtitle: 'Your unfinished draft is still here',
            onTap: () => setState(() => _mobileEditorOpen = true),
          ),
        ],
        if (!controller.available || !controller.canWrite) ...[
          const SizedBox(height: 20),
          Text(
            !controller.available ? 'Unlock Asael to save something new.' : 'You can read saved sources. Write access is needed to add new ones.',
          ),
        ],
        if (controller.error != null) ...[
          const SizedBox(height: 16),
          Text(
            'Something needs your attention. Open your capture to review it.',
            style: TextStyle(color: theme.colorScheme.error),
          ),
        ],
      ],
    );
  }

  Widget _mobileForm(CaptureController controller) {
    final scheme = Theme.of(context).colorScheme;
    if (!_mobileEditorOpen) {
      return _mobileStudio(controller);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            IconButton(
              tooltip: 'Back to Capture',
              onPressed: _busy
                  ? null
                  : () => setState(() => _mobileEditorOpen = false),
              icon: const Icon(Icons.arrow_back_rounded),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      mode == CaptureMode.note
                          ? 'New note'
                          : mode == CaptureMode.record
                          ? 'Voice note'
                          : 'Add files',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Keep the thought. ATLAS keeps the context.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Saved sources',
              onPressed: controller.available
                  ? () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const NativeLibraryPage(),
                      ),
                    )
                  : null,
              icon: const Icon(Icons.folder_open_outlined),
            ),
          ],
        ),
        const SizedBox(height: 12),
        MobileSegmentBar<CaptureMode>(
          items: const [
            (
              value: CaptureMode.note,
              label: 'Note',
              icon: Icons.edit_note_rounded,
            ),
            (
              value: CaptureMode.upload,
              label: 'Files',
              icon: Icons.attach_file_rounded,
            ),
            (
              value: CaptureMode.record,
              label: 'Voice note',
              icon: Icons.mic_none_rounded,
            ),
          ],
          value: mode,
          onChanged: (value) {
            if (!_busy) setState(() => mode = value);
          },
        ),
        const SizedBox(height: 20),
        if (!controller.available)
          const Text('Unlock Asael to save something new.'),
        if (controller.available && !controller.canWrite)
          const Text(
            'You can read and recover saved sources. Saving new content needs write access.',
          ),
        if (mode == CaptureMode.upload) ...[
          MobileActionTile(
            icon: Icons.file_upload_outlined,
            title: 'Choose files',
            subtitle: 'Documents, images and more',
            onTap: _busy ? null : pickBatchDocuments,
          ),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy
                      ? null
                      : () => pickImage(ImageSource.gallery, CaptureKind.image),
                  icon: const Icon(Icons.image_outlined),
                  label: const Text('Photos'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : pickMeetingMedia,
                  icon: const Icon(Icons.audio_file_outlined),
                  label: const Text('Audio / video'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'Up to 25 queued items · 5 MB per file',
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
          if (picking || dropping) const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (mode == CaptureMode.record) ...[
          CaptureRecordingPanel(
            controller: recording,
            onAttach: (audio) {
              if (!controller.canWrite) {
                audio.bytes.fillRange(0, audio.bytes.length, 0);
                return;
              }
              setState(() {
                attachment?.bytes.fillRange(0, attachment!.bytes.length, 0);
                attachment = audio;
                attachmentKind = CaptureKind.meetingMedia;
                batchFiles.clear();
              });
            },
          ),
          const SizedBox(height: 16),
        ],
        if (attachment != null)
          Align(
            alignment: Alignment.centerLeft,
            child: InputChip(
              avatar: const Icon(Icons.insert_drive_file_outlined, size: 18),
              label: Text(
                '${attachment!.name} · ${_fileSize(attachment!.bytes.length)}',
                overflow: TextOverflow.ellipsis,
              ),
              onDeleted: _busy
                  ? null
                  : () => setState(() {
                      attachment?.bytes.fillRange(
                        0,
                        attachment!.bytes.length,
                        0,
                      );
                      attachment = null;
                      attachmentKind = CaptureKind.text;
                    }),
            ),
          ),
        if (batchFiles.isNotEmpty)
          CaptureSelectionPanel(
            files: batchFiles,
            onRemove: _busy
                ? null
                : (item) => setState(() => batchFiles.remove(item)),
          ),
        if (attachmentError != null)
          Semantics(
            liveRegion: true,
            child: Text(
              attachmentError!,
              style: TextStyle(color: scheme.error),
            ),
          ),
        TextField(
          key: const Key('capture-note'),
          controller: note,
          enabled: !_busy,
          minLines: mode == CaptureMode.note ? 9 : 3,
          maxLines: 12,
          maxLength: 20000,
          decoration: InputDecoration(
            hintText: mode == CaptureMode.note
                ? 'An idea, a thought, something to remember…'
                : 'What should ATLAS know about this?',
            alignLabelWithHint: true,
            filled: true,
            fillColor: scheme.surface,
            contentPadding: const EdgeInsets.all(24),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(16),
              borderSide: BorderSide.none,
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(16),
              borderSide: BorderSide.none,
            ),
            counterText: '',
          ),
        ),
        const SizedBox(height: 8),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('Add details'),
          subtitle: const Text('Title, tags or a short voice note'),
          expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
              ? AnimationStyle.noAnimation
              : null,
          children: [
            TextField(
              key: const Key('capture-title'),
              controller: title,
              enabled: !_busy,
              maxLength: 240,
              decoration: const InputDecoration(
                labelText: 'Title (optional)',
                counterText: '',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('capture-tags'),
              controller: tags,
              enabled: !_busy,
              decoration: const InputDecoration(
                labelText: 'Tags',
                hintText: 'Ideas, work, personal',
              ),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: _busy
                  ? null
                  : () => setState(() => mode = CaptureMode.record),
              icon: const Icon(Icons.mic_none_rounded),
              label: const Text('Record a voice note'),
            ),
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: Text(
                'Pasted links are saved as text. Files may need review if only some content can be read.',
              ),
            ),
          ],
        ),
        if (controller.loadingOutbox) const LinearProgressIndicator(),
        if (controller.error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              controller.error is CaptureOutboxIntegrityException
                  ? 'Saved captures could not be verified. Nothing was uploaded.'
                  : 'Could not save this capture. Your draft is still here.',
              style: TextStyle(color: scheme.error),
            ),
          ),
        const SizedBox(height: 12),
        FilledButton.icon(
          key: const Key('capture-submit'),
          onPressed: _busy ? null : submit,
          icon: const Icon(Icons.add_rounded),
          label: Text(
            controller.batchQueueing
                ? 'Preparing files…'
                : controller.submitting
                ? 'Saving…'
                : batchFiles.isNotEmpty
                ? 'Save ${batchFiles.length} files'
                : 'Save capture',
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final body = ListenableBuilder(
      listenable: Listenable.merge([widget.controller, recording]),
      builder: (context, _) => SingleChildScrollView(
        key: const Key('capture-workspace-scroll'),
        padding: const EdgeInsets.all(20),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1120),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final controller = widget.controller;
                final form = usesMobilePresentation()
                    ? _mobileForm(controller)
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            'Keep the source. Add the context.',
                            style: Theme.of(context).textTheme.headlineSmall,
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            'Save a note, record audio, or add files. Transfer, extraction and indexing each have their own state.',
                          ),
                          Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: OutlinedButton.icon(
                              key: const Key('capture-open-library'),
                              onPressed: controller.available
                                  ? () => Navigator.of(context).push(
                                      MaterialPageRoute<void>(
                                        builder: (_) =>
                                            const NativeLibraryPage(),
                                      ),
                                    )
                                  : null,
                              style: OutlinedButton.styleFrom(
                                minimumSize: const Size(48, 48),
                              ),
                              icon: const Icon(
                                Icons.folder_copy_outlined,
                                size: 18,
                              ),
                              label: const Text(
                                'Open Library and version history',
                              ),
                            ),
                          ),
                          const SizedBox(height: 16),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (final value in CaptureMode.values)
                                ChoiceChip(
                                  key: Key('capture-mode-${value.name}'),
                                  selected: mode == value,
                                  label: Text(switch (value) {
                                    CaptureMode.note => 'Note',
                                    CaptureMode.record => 'Record',
                                    CaptureMode.upload => 'Upload',
                                  }),
                                  onSelected: _busy
                                      ? null
                                      : (_) => setState(() => mode = value),
                                ),
                            ],
                          ),
                          if (!controller.available)
                            const Padding(
                              padding: EdgeInsets.only(top: 12),
                              child: Text(
                                'Capture is locked or unavailable. Sign in or unlock to continue.',
                              ),
                            ),
                          if (controller.available && !controller.canWrite)
                            const Padding(
                              padding: EdgeInsets.only(top: 12),
                              child: Text(
                                'This role can inspect sources and recover or discard local copies. Saving, recording, and queue replay require write access.',
                              ),
                            ),
                          const SizedBox(height: 16),
                          TextField(
                            key: const Key('capture-title'),
                            controller: title,
                            enabled: !_busy,
                            maxLength: 240,
                            decoration: const InputDecoration(
                              labelText: 'Title',
                              helperText: 'Optional; a batch uses this as its collection label',
                            ),
                          ),
                          if (mode == CaptureMode.record) ...[
                            CaptureRecordingPanel(
                              controller: recording,
                              onAttach: (audio) {
                                if (!controller.canWrite) {
                                  audio.bytes.fillRange(
                                    0,
                                    audio.bytes.length,
                                    0,
                                  );
                                  return;
                                }
                                setState(() {
                                  attachment?.bytes.fillRange(
                                    0,
                                    attachment!.bytes.length,
                                    0,
                                  );
                                  attachment = audio;
                                  attachmentKind = CaptureKind.meetingMedia;
                                  batchFiles.clear();
                                });
                              },
                            ),
                            const SizedBox(height: 16),
                          ],
                          if (mode == CaptureMode.upload) ...[
                            if (_isDesktop)
                              CaptureDropSurface(
                                enabled: !_dropDisabled && !_busy,
                                busy: dropping || dropIntake.busy,
                                remainingCapacity:
                                    (captureBatchMaxFiles -
                                            controller.pending.length)
                                        .clamp(0, captureBatchMaxFiles),
                                onDrop: submitDroppedFiles,
                              ),
                            if (dropSummary != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: Text(dropSummary!.message),
                              ),
                            const SizedBox(height: 12),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                if (!_isDesktop)
                                  OutlinedButton.icon(
                                    onPressed: _busy
                                        ? null
                                        : () => pickImage(
                                            ImageSource.camera,
                                            CaptureKind.scan,
                                          ),
                                    icon: const Icon(
                                      Icons.document_scanner_outlined,
                                    ),
                                    label: const Text('Scan page'),
                                  ),
                                FilledButton.tonalIcon(
                                  onPressed: _busy ? null : pickBatchDocuments,
                                  icon: const Icon(Icons.library_add_outlined),
                                  label: const Text('Choose files'),
                                ),
                                OutlinedButton.icon(
                                  onPressed: _busy
                                      ? null
                                      : () => pickImage(
                                          ImageSource.gallery,
                                          CaptureKind.image,
                                        ),
                                  icon: const Icon(Icons.image_outlined),
                                  label: const Text('Choose image'),
                                ),
                                OutlinedButton.icon(
                                  onPressed: _busy ? null : pickMeetingMedia,
                                  icon: const Icon(Icons.audio_file_outlined),
                                  label: const Text('Choose audio or video'),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            const Text(
                              'Up to 25 queued items, 5 MB per file and 64 MB total encrypted storage. A supported upload does not guarantee complete extraction.',
                            ),
                            if (picking || dropping)
                              const LinearProgressIndicator(),
                            const SizedBox(height: 12),
                          ],
                          if (attachment != null)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: InputChip(
                                label: Text(
                                  '${attachment!.name} · ${_fileSize(attachment!.bytes.length)}',
                                ),
                                onDeleted: _busy
                                    ? null
                                    : () => setState(() {
                                        attachment?.bytes.fillRange(
                                          0,
                                          attachment!.bytes.length,
                                          0,
                                        );
                                        attachment = null;
                                        attachmentKind = CaptureKind.text;
                                      }),
                              ),
                            ),
                          if (batchFiles.isNotEmpty)
                            CaptureSelectionPanel(
                              files: batchFiles,
                              onRemove: _busy
                                  ? null
                                  : (item) =>
                                        setState(() => batchFiles.remove(item)),
                            ),
                          if (attachmentError != null)
                            Semantics(
                              liveRegion: true,
                              child: Text(
                                attachmentError!,
                                style: TextStyle(
                                  color: Theme.of(context).colorScheme.error,
                                ),
                              ),
                            ),
                          TextField(
                            key: const Key('capture-note'),
                            controller: note,
                            enabled: !_busy,
                            minLines: 4,
                            maxLines: 12,
                            maxLength: 20000,
                            decoration: const InputDecoration(
                              labelText: 'Note or context',
                              helperText: 'A pasted or shared link stays note text. This does not fetch the linked page.',
                              alignLabelWithHint: true,
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            key: const Key('capture-tags'),
                            controller: tags,
                            enabled: !_busy,
                            decoration: const InputDecoration(
                              labelText: 'Tags',
                              hintText: 'research, launch, idea',
                            ),
                          ),
                          if (controller.loadingOutbox)
                            const Padding(
                              padding: EdgeInsets.only(top: 12),
                              child: LinearProgressIndicator(),
                            ),
                          if (controller.error != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 12),
                              child: Text(
                                controller.error
                                        is CaptureOutboxIntegrityException
                                    ? 'Encrypted captures could not be verified. Nothing was uploaded.'
                                    : 'This capture could not be saved. Your draft is retained.',
                                style: TextStyle(
                                  color: Theme.of(context).colorScheme.error,
                                ),
                              ),
                            ),
                          const SizedBox(height: 20),
                          FilledButton.icon(
                            key: const Key('capture-submit'),
                            onPressed: _busy ? null : submit,
                            icon: const Icon(Icons.add_box_outlined),
                            label: Text(
                              controller.batchQueueing
                                  ? 'Encrypting batch…'
                                  : controller.submitting
                                  ? 'Saving capture…'
                                  : batchFiles.isNotEmpty
                                  ? 'Queue ${batchFiles.length} files'
                                  : 'Save capture',
                            ),
                          ),
                        ],
                      );
                final status = Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    CaptureReceiptPanel(
                      controller: controller,
                      onOpenKnowledge: widget.onOpenKnowledge,
                    ),
                    if (controller.batchItems.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      CaptureBatchProgressPanel(controller: controller),
                    ],
                    if (controller.pendingWithoutBatch.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      _CaptureOutboxPanel(controller: controller),
                    ],
                    if (controller.supportsLegacyRecovery &&
                        (controller.legacyInventory == null ||
                            controller.legacyInventory!.count > 0 ||
                            controller.legacyInventory!.unreadableCount > 0 ||
                            controller.legacyInventory!.limited ||
                            controller.legacyCleanupNotice != null)) ...[
                      const SizedBox(height: 16),
                      _CaptureLegacyRecoveryPanel(controller: controller),
                    ],
                  ],
                );
                if (constraints.maxWidth >= 980 &&
                    MediaQuery.textScalerOf(context).scale(1) <= 1.4) {
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 3, child: form),
                      const SizedBox(width: 24),
                      Expanded(flex: 2, child: status),
                    ],
                  );
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [form, const SizedBox(height: 24), status],
                );
              },
            ),
          ),
        ),
      ),
    );
    return _isMacOS
        ? MacosPageScaffold(
            title: 'Capture',
            description:
                'Notes, audio and original files with visible processing.',
            icon: Icons.add_box_outlined,
            body: body,
          )
        : Scaffold(
            appBar: usesMobilePresentation()
                ? null
                : AppBar(title: const Text('Capture')),
            body: body,
          );
  }
}

String _fileSize(int bytes) => bytes >= 1024 * 1024
    ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB'
    : '${(bytes / 1024).ceil()} KB';

class _MobileCaptureChoice extends StatelessWidget {
  const _MobileCaptureChoice({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.onTap,
  });
  final IconData icon;
  final String title, subtitle;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => MobileSurface(
    padding: EdgeInsets.zero,
    child: InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 28, color: Theme.of(context).colorScheme.primary),
            const SizedBox(height: 24),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(
              subtitle,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _CaptureLegacyRecoveryPanel extends StatelessWidget {
  const _CaptureLegacyRecoveryPanel({required this.controller});
  final CaptureController controller;

  @override
  Widget build(BuildContext context) {
    final inventory = controller.legacyInventory;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Older device queue',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          Text(
            inventory == null
                ? 'Check for older encrypted files that cannot be linked to this account.'
                : '${inventory.count} unclaimed encrypted ${inventory.count == 1 ? 'file' : 'files'} · ${_fileSize(inventory.encryptedBytes)}',
          ),
          const Text(
            'These files stay on this device and count toward its queue limit. Their contents and prior owners are not shown.',
          ),
          if (inventory?.limited == true)
            const Text(
              'This is a bounded inventory. After cleanup, check again for additional files.',
            ),
          if ((inventory?.unreadableCount ?? 0) > 0)
            Text(
              '${inventory!.unreadableCount} local encrypted files could not be classified and will be kept.',
            ),
          if (controller.legacyRecoveryError != null)
            Text(controller.legacyRecoveryError!),
          if (controller.legacyCleanupNotice != null)
            Semantics(
              liveRegion: true,
              child: Text(controller.legacyCleanupNotice!),
            ),
          if (controller.inspectingLegacy) const LinearProgressIndicator(),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              TextButton(
                key: const Key('capture-legacy-refresh'),
                onPressed: !controller.available || controller.busy
                    ? null
                    : controller.refreshLegacyInventory,
                child: const Text('Check older queue'),
              ),
              if ((inventory?.count ?? 0) > 0)
                OutlinedButton(
                  key: const Key('capture-review-legacy-cleanup'),
                  onPressed: !controller.available || controller.busy
                      ? null
                      : () => _confirm(context),
                  child: const Text('Review local cleanup'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _confirm(BuildContext context) async {
    final generation = controller.generation;
    final reviewed = await controller.refreshLegacyInventory();
    if (!context.mounted ||
        !controller.current(generation) ||
        reviewed == null ||
        reviewed.count == 0) {
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        scrollable: true,
        title: const Text('Discard older encrypted files?'),
        content: Text(
          'Permanently remove these ${reviewed.count} unclaimed encrypted files (${_fileSize(reviewed.encryptedBytes)}) from this device? '
          'Their original contents cannot be recovered here. Current account captures and captures pinned to other accounts will be kept. '
          'This does not undo anything already accepted by the service.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Keep files'),
          ),
          FilledButton(
            key: const Key('capture-confirm-legacy-cleanup'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Discard older files'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await controller.discardLegacyInventory(
        reviewed,
        reviewedGeneration: generation,
      );
    }
  }
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
                onPressed: !controller.canWrite || controller.syncing
                    ? null
                    : controller.syncPending,
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
                ? 'These items belong to this account and API origin. Review them, then choose Sync to retry with their existing request keys. Restoring this queue does not upload it. Older unverified entries remain quarantined.'
                : 'Sync paused. The encrypted originals remain on this device.',
          ),
          const SizedBox(height: 8),
          for (final entry in entries.take(4))
            Material(
              type: MaterialType.transparency,
              child: ListTile(
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
    final generation = controller.generation;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Discard this capture?'),
        content: const Text(
          'This removes the encrypted device copy. It does not undo a source already accepted by the service.',
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
    if (confirmed == true) {
      await controller.discard(entry.id, reviewedGeneration: generation);
    }
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
