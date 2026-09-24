import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:mime/mime.dart';
import 'package:path/path.dart' as path;

import 'capture_batch_view.dart';
import 'capture_controller.dart';
import 'capture_models.dart';

const captureDropFilenameMaxRunes = 180;
const captureDropFilenameMaxBytes = 240;

class CaptureDropContext {
  const CaptureDropContext({
    this.title = '',
    this.note = '',
    this.tags = const [],
  });

  final String title;
  final String note;
  final List<String> tags;
}

class CaptureDropSummary {
  const CaptureDropSummary({
    required this.queued,
    required this.failed,
    this.directories = 0,
    this.unsupported = 0,
    this.invalidNames = 0,
    this.empty = 0,
    this.tooLarge = 0,
    this.duplicates = 0,
    this.full = 0,
    this.changed = 0,
    this.unreadable = 0,
    this.cleanupFailed = 0,
    this.busy = false,
  });

  final int queued;
  final int failed;
  final int directories;
  final int unsupported;
  final int invalidNames;
  final int empty;
  final int tooLarge;
  final int duplicates;
  final int full;
  final int changed;
  final int unreadable;
  final int cleanupFailed;
  final bool busy;

  bool get hasProblems => failed > 0 || cleanupFailed > 0;

  CaptureDropSummary withCleanupFailures(int value) => CaptureDropSummary(
    queued: queued,
    failed: failed,
    directories: directories,
    unsupported: unsupported,
    invalidNames: invalidNames,
    empty: empty,
    tooLarge: tooLarge,
    duplicates: duplicates,
    full: full,
    changed: changed,
    unreadable: unreadable,
    cleanupFailed: value,
    busy: busy,
  );

  String get message {
    if (busy) {
      return 'Finish the active secure queue before dropping more files.';
    }
    final result = <String>[
      if (queued > 0)
        '$queued ${queued == 1 ? 'file' : 'files'} encrypted and queued',
      if (directories > 0)
        '$directories ${directories == 1 ? 'folder' : 'folders'} skipped',
      if (unsupported > 0) '$unsupported unsupported',
      if (invalidNames > 0) '$invalidNames unsafe or overlong name',
      if (empty > 0) '$empty empty',
      if (tooLarge > 0) '$tooLarge over 5 MB',
      if (duplicates > 0) '$duplicates duplicate',
      if (full > 0) '$full beyond secure queue capacity',
      if (changed > 0) '$changed changed while being read',
      if (unreadable > 0) '$unreadable unavailable',
      if (cleanupFailed > 0)
        '$cleanupFailed temporary ${cleanupFailed == 1 ? 'copy needs' : 'copies need'} cleanup',
    ];
    if (result.isEmpty) return 'No files were added.';
    return '${result.join(' · ')}.';
  }
}

enum CaptureDropEntityType { file, directory, other }

abstract interface class CaptureDropSource {
  String get name;
  String get sourcePath;
  bool get fromPromise;
  Uint8List? get securityBookmark;

  Future<CaptureDropEntityType> entityType();
  Future<int> length();
  Future<DateTime> lastModified();
  Stream<Uint8List> openRead(int start, int end);
}

class DesktopCaptureDropSource implements CaptureDropSource {
  DesktopCaptureDropSource(this.item);

  final DropItem item;

  @override
  String get name => item.name;

  @override
  String get sourcePath => item.path;

  @override
  bool get fromPromise => item.fromPromise;

  @override
  Uint8List? get securityBookmark => item.extraAppleBookmark;

  @override
  Future<CaptureDropEntityType> entityType() async {
    if (item is DropItemDirectory) return CaptureDropEntityType.directory;
    final type = await FileSystemEntity.type(item.path, followLinks: true);
    return switch (type) {
      FileSystemEntityType.file => CaptureDropEntityType.file,
      FileSystemEntityType.directory => CaptureDropEntityType.directory,
      _ => CaptureDropEntityType.other,
    };
  }

  @override
  Future<int> length() => item.length();

  @override
  Future<DateTime> lastModified() => item.lastModified();

  @override
  Stream<Uint8List> openRead(int start, int end) => item.openRead(start, end);
}

/// A file already copied into Asael's private App Group intake directory.
///
/// It has no security-scoped bookmark because the native host and Share
/// Extension share the same explicitly entitled container. The native host
/// validates containment before exposing a path; this source still rejects
/// links and re-checks stable metadata before encryption.
class AppGroupCaptureDropSource implements CaptureDropSource {
  AppGroupCaptureDropSource(String sourcePath)
    : _file = File(sourcePath),
      _name = path.basename(sourcePath);

  final File _file;
  final String _name;

  @override
  String get name => _name;

  @override
  String get sourcePath => _file.path;

  @override
  bool get fromPromise => false;

  @override
  Uint8List? get securityBookmark => null;

  @override
  Future<CaptureDropEntityType> entityType() async {
    final type = await FileSystemEntity.type(_file.path, followLinks: false);
    return switch (type) {
      FileSystemEntityType.file => CaptureDropEntityType.file,
      FileSystemEntityType.directory => CaptureDropEntityType.directory,
      _ => CaptureDropEntityType.other,
    };
  }

  @override
  Future<int> length() => _file.length();

  @override
  Future<DateTime> lastModified() => _file.lastModified();

  @override
  Stream<Uint8List> openRead(int start, int end) =>
      _file.openRead(start, end).map(Uint8List.fromList);
}

abstract interface class CaptureDropSecurityAccess {
  Future<bool> start(Uint8List bookmark);
  Future<bool> stop(Uint8List bookmark);
}

class DesktopCaptureDropSecurityAccess implements CaptureDropSecurityAccess {
  const DesktopCaptureDropSecurityAccess();

  @override
  Future<bool> start(Uint8List bookmark) => DesktopDrop.instance
      .startAccessingSecurityScopedResource(bookmark: bookmark);

  @override
  Future<bool> stop(Uint8List bookmark) => DesktopDrop.instance
      .stopAccessingSecurityScopedResource(bookmark: bookmark);
}

abstract interface class CaptureDropPromiseCleanup {
  Future<void> cleanup(CaptureDropSource source);
}

class DesktopCaptureDropPromiseCleanup implements CaptureDropPromiseCleanup {
  DesktopCaptureDropPromiseCleanup({String? systemTemporaryPath})
    : _systemTemporaryPath = systemTemporaryPath ?? Directory.systemTemp.path;

  final String _systemTemporaryPath;

  @override
  Future<void> cleanup(CaptureDropSource source) async {
    final sourceName = normalizeCaptureDropFilename(source.name);
    final pathName = normalizeCaptureDropFilename(
      path.basename(source.sourcePath),
    );
    if (!source.fromPromise ||
        sourceName == null ||
        sourceName != pathName ||
        !isSafeDesktopDropPromisePath(
          source.sourcePath,
          systemTemporaryPath: _systemTemporaryPath,
        )) {
      return;
    }
    final type = await FileSystemEntity.type(
      source.sourcePath,
      followLinks: false,
    );
    if (type == FileSystemEntityType.file) {
      await File(source.sourcePath).delete();
    } else if (type == FileSystemEntityType.link) {
      await Link(source.sourcePath).delete();
    } else if (type != FileSystemEntityType.notFound) {
      return;
    }

    final parent = Directory(path.dirname(source.sourcePath));
    if (!await parent.exists()) return;
    final isEmpty = await parent.list(followLinks: false).isEmpty;
    if (isEmpty) await parent.delete();
  }
}

bool isSafeDesktopDropPromisePath(
  String candidate, {
  required String systemTemporaryPath,
}) {
  if (!_validSourcePath(candidate) || !_validSourcePath(systemTemporaryPath)) {
    return false;
  }
  final dropsRoot = path.normalize(
    path.absolute(path.join(systemTemporaryPath, 'Drops')),
  );
  final normalized = path.normalize(path.absolute(candidate));
  if (!path.isWithin(dropsRoot, normalized)) return false;
  final relative = path.relative(normalized, from: dropsRoot);
  final parts = path.split(relative);
  if (parts.length != 2) return false;
  return RegExp(r'^\d{8}_\d{6}_\d{3}Z$').hasMatch(parts.first) &&
      normalizeCaptureDropFilename(parts.last) != null;
}

String? normalizeCaptureDropFilename(String rawName) {
  if (rawName.contains(RegExp(r'[\x00-\x1f\x7f-\x9f/\\]')) ||
      rawName.contains(RegExp(r'[\u202a-\u202e\u2066-\u2069]'))) {
    return null;
  }
  final normalized = rawName.trim().replaceAll(RegExp(r' {2,}'), ' ');
  if (normalized.isEmpty || normalized == '.' || normalized == '..') {
    return null;
  }
  if (normalized.runes.length > captureDropFilenameMaxRunes ||
      utf8.encode(normalized).length > captureDropFilenameMaxBytes) {
    return null;
  }
  return normalized;
}

class CaptureDropIntake {
  CaptureDropIntake(
    this.controller, {
    CaptureDropSecurityAccess? securityAccess,
    CaptureDropPromiseCleanup? promiseCleanup,
  }) : _securityAccess =
           securityAccess ?? const DesktopCaptureDropSecurityAccess(),
       _promiseCleanup = promiseCleanup ?? DesktopCaptureDropPromiseCleanup();

  final CaptureController controller;
  final CaptureDropSecurityAccess _securityAccess;
  final CaptureDropPromiseCleanup _promiseCleanup;
  bool _busy = false;

  bool get busy => _busy;

  Future<CaptureDropSummary> submit(
    List<CaptureDropSource> sources, {
    CaptureDropContext context = const CaptureDropContext(),
  }) async {
    if (sources.isEmpty) {
      return const CaptureDropSummary(queued: 0, failed: 0);
    }
    if (_busy ||
        controller.owner == null ||
        controller.batchQueueing ||
        controller.submitting ||
        controller.syncing) {
      final cleanupFailed = await _cleanupAll(sources);
      return CaptureDropSummary(
        queued: 0,
        failed: sources.length,
        unreadable: sources.length,
        cleanupFailed: cleanupFailed,
        busy: true,
      );
    }

    _busy = true;
    var directories = 0;
    var unsupported = 0;
    var invalidNames = 0;
    var empty = 0;
    var tooLarge = 0;
    var duplicates = 0;
    var full = 0;
    var changed = 0;
    var unreadable = 0;
    var loadFailures = 0;
    var cleanupFailed = 0;
    late CaptureDropSummary summary;
    final accepted = <_AcceptedCaptureDrop>[];
    final known = <String>{
      for (final entry in controller.pending)
        if (entry.draft.file case final file?)
          if (normalizeCaptureDropFilename(file.name) case final name?)
            captureSelectionKey(name, file.byteLength),
    };
    final available = (captureBatchMaxFiles - controller.pending.length).clamp(
      0,
      captureBatchMaxFiles,
    );

    try {
      for (final source in sources) {
        if (accepted.length >= available) {
          full += 1;
          continue;
        }
        if (!_validSourcePath(source.sourcePath)) {
          invalidNames += 1;
          continue;
        }
        final name = normalizeCaptureDropFilename(source.name);
        if (name == null) {
          invalidNames += 1;
          continue;
        }
        try {
          final metadata = await _withSecurityAccess(source, () async {
            final entityType = await source.entityType();
            if (entityType == CaptureDropEntityType.directory) {
              throw const _CaptureDropDirectoryException();
            }
            if (entityType != CaptureDropEntityType.file) {
              throw const _CaptureDropUnreadableException();
            }
            if (!_isSupportedCaptureDropName(name)) {
              throw const _CaptureDropUnsupportedException();
            }
            final length = await source.length();
            if (length < 1) throw const _CaptureDropEmptyException();
            if (length > captureAttachmentMaxBytes) {
              throw const _CaptureDropTooLargeException();
            }
            return _CaptureDropMetadata(
              length: length,
              lastModified: await source.lastModified(),
            );
          });
          final key = captureSelectionKey(name, metadata.length);
          if (!known.add(key)) {
            duplicates += 1;
            continue;
          }
          accepted.add(
            _AcceptedCaptureDrop(
              source: source,
              name: name,
              length: metadata.length,
              lastModified: metadata.lastModified,
            ),
          );
        } on _CaptureDropDirectoryException {
          directories += 1;
        } on _CaptureDropUnsupportedException {
          unsupported += 1;
        } on _CaptureDropEmptyException {
          empty += 1;
        } on _CaptureDropTooLargeException {
          tooLarge += 1;
        } catch (_) {
          unreadable += 1;
        }
      }

      final result = await controller.submitBatch(
        accepted.map((item) => item.name).toList(growable: false),
        (index) async {
          final item = accepted[index];
          try {
            final bytes = await _readStableFile(item);
            final filenameTitle = captureBatchTitle(item.name);
            final sharedTitle = context.title.trim();
            final itemTitle = sharedTitle.isEmpty
                ? filenameTitle
                : '$sharedTitle · $filenameTitle';
            return CaptureDraft(
              title: itemTitle.length <= 240
                  ? itemTitle
                  : itemTitle.substring(0, 240),
              content: context.note,
              tags: context.tags,
              file: CaptureAttachment(
                name: item.name,
                bytes: bytes,
                contentType:
                    lookupMimeType(item.name, headerBytes: bytes) ??
                    'application/octet-stream',
              ),
              kind: bulkCaptureKind(item.name),
            );
          } on _CaptureDropChangedException {
            changed += 1;
            loadFailures += 1;
            throw const FormatException(
              'The file changed while it was being read. Drop it again.',
            );
          } on _CaptureDropTooLargeException {
            tooLarge += 1;
            loadFailures += 1;
            throw const FormatException('Choose a file up to 5 MB.');
          } on _CaptureDropEmptyException {
            empty += 1;
            loadFailures += 1;
            throw const FormatException('Choose a non-empty file.');
          } catch (_) {
            unreadable += 1;
            loadFailures += 1;
            throw const FormatException(
              'This file could not be read securely. Drop it again.',
            );
          }
        },
      );
      final uncategorizedLoadFailures = (result.failed - loadFailures).clamp(
        0,
        result.failed,
      );
      unreadable += uncategorizedLoadFailures;
      summary = CaptureDropSummary(
        queued: result.queued,
        failed: sources.length - accepted.length + result.failed,
        directories: directories,
        unsupported: unsupported,
        invalidNames: invalidNames,
        empty: empty,
        tooLarge: tooLarge,
        duplicates: duplicates,
        full: full,
        changed: changed,
        unreadable: unreadable,
      );
    } finally {
      cleanupFailed = await _cleanupAll(sources);
      _busy = false;
      if (cleanupFailed > 0) {
        // The queue result is already durable. Cleanup remains best-effort and
        // never broadens deletion beyond desktop_drop's own temp/Drops path.
      }
    }
    return summary.withCleanupFailures(cleanupFailed);
  }

  Future<Uint8List> _readStableFile(_AcceptedCaptureDrop item) =>
      _withSecurityAccess(item.source, () async {
        final beforeLength = await item.source.length();
        final beforeModified = await item.source.lastModified();
        if (beforeLength != item.length ||
            beforeModified != item.lastModified ||
            beforeLength < 1) {
          throw const _CaptureDropChangedException();
        }
        if (beforeLength > captureAttachmentMaxBytes) {
          throw const _CaptureDropTooLargeException();
        }

        final bytes = BytesBuilder(copy: false);
        var byteCount = 0;
        await for (final chunk in item.source.openRead(
          0,
          captureAttachmentMaxBytes + 1,
        )) {
          if (chunk.isEmpty) continue;
          byteCount += chunk.length;
          if (byteCount > captureAttachmentMaxBytes) {
            throw const _CaptureDropTooLargeException();
          }
          bytes.add(chunk);
        }
        final afterLength = await item.source.length();
        final afterModified = await item.source.lastModified();
        if (byteCount == 0) throw const _CaptureDropEmptyException();
        if (byteCount != item.length ||
            afterLength != item.length ||
            afterModified != item.lastModified) {
          throw const _CaptureDropChangedException();
        }
        return bytes.takeBytes();
      });

  Future<T> _withSecurityAccess<T>(
    CaptureDropSource source,
    Future<T> Function() action,
  ) async {
    final bookmark = source.securityBookmark;
    if (bookmark == null || bookmark.isEmpty) return action();
    final started = await _securityAccess.start(bookmark);
    if (!started) throw const _CaptureDropUnreadableException();
    try {
      return await action();
    } finally {
      final stopped = await _securityAccess.stop(bookmark);
      if (!stopped) throw const _CaptureDropUnreadableException();
    }
  }

  Future<int> _cleanupAll(List<CaptureDropSource> sources) async {
    var failed = 0;
    for (final source in sources) {
      try {
        await _promiseCleanup.cleanup(source);
      } catch (_) {
        failed += 1;
      }
    }
    return failed;
  }
}

class CaptureDropSurface extends StatefulWidget {
  const CaptureDropSurface({
    super.key,
    required this.enabled,
    required this.busy,
    required this.remainingCapacity,
    required this.onDrop,
  });

  final bool enabled;
  final bool busy;
  final int remainingCapacity;
  final Future<void> Function(List<CaptureDropSource> sources) onDrop;

  @override
  State<CaptureDropSurface> createState() => _CaptureDropSurfaceState();
}

class _CaptureDropSurfaceState extends State<CaptureDropSurface> {
  bool hovering = false;

  @override
  void didUpdateWidget(covariant CaptureDropSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if ((!widget.enabled || widget.busy || widget.remainingCapacity == 0) &&
        hovering) {
      hovering = false;
    }
  }

  void _setHovering(bool value) {
    if (!mounted || hovering == value) return;
    setState(() => hovering = value);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final active =
        widget.enabled && !widget.busy && widget.remainingCapacity > 0;
    return DropTarget(
      enable: active,
      onDragEntered: (_) => _setHovering(true),
      onDragExited: (_) => _setHovering(false),
      onDragDone: (details) {
        _setHovering(false);
        if (!active) return;
        unawaited(
          widget.onDrop(
            details.files
                .map<CaptureDropSource>(DesktopCaptureDropSource.new)
                .toList(growable: false),
          ),
        );
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutCubic,
        width: double.infinity,
        constraints: const BoxConstraints(minHeight: 126),
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 20),
        decoration: BoxDecoration(
          color: hovering
              ? scheme.primaryContainer.withValues(alpha: 0.72)
              : scheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: hovering
                ? scheme.primary
                : scheme.outlineVariant.withValues(alpha: active ? 1 : 0.55),
            width: hovering ? 1.8 : 1,
          ),
          boxShadow: hovering
              ? [
                  BoxShadow(
                    color: scheme.primary.withValues(alpha: 0.12),
                    blurRadius: 24,
                    spreadRadius: 2,
                  ),
                ]
              : null,
        ),
        child: Row(
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: scheme.primaryContainer,
                shape: BoxShape.circle,
              ),
              child: Icon(
                widget.busy
                    ? Icons.lock_clock_outlined
                    : Icons.move_to_inbox_outlined,
                color: scheme.primary,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    hovering
                        ? 'Release to secure this batch'
                        : 'Drop to encrypt and queue',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 5),
                  Text(
                    active
                        ? '${widget.remainingCapacity} secure queue ${widget.remainingCapacity == 1 ? 'slot' : 'slots'} available · supported files up to 5 MB each'
                        : widget.remainingCapacity == 0
                        ? 'The secure queue is full. Let an upload finish or discard a local copy.'
                        : 'Finish the active queue or upload before adding more files.',
                    style: Theme.of(context).textTheme.bodyMedium
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Folders stay on your Mac. Every accepted file becomes one cited knowledge source.',
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Icon(
              active ? Icons.add_rounded : Icons.pause_rounded,
              color: active ? scheme.primary : scheme.outline,
            ),
          ],
        ),
      ),
    );
  }
}

class _AcceptedCaptureDrop {
  const _AcceptedCaptureDrop({
    required this.source,
    required this.name,
    required this.length,
    required this.lastModified,
  });

  final CaptureDropSource source;
  final String name;
  final int length;
  final DateTime lastModified;
}

class _CaptureDropMetadata {
  const _CaptureDropMetadata({
    required this.length,
    required this.lastModified,
  });

  final int length;
  final DateTime lastModified;
}

bool _validSourcePath(String value) =>
    value.isNotEmpty &&
    value.length <= 8192 &&
    !value.contains(RegExp(r'[\x00-\x1f\x7f]'));

bool _isSupportedCaptureDropName(String value) {
  final dot = value.lastIndexOf('.');
  if (dot <= 0 || dot == value.length - 1) return false;
  return captureDocumentExtensions.contains(
    value.substring(dot + 1).toLowerCase(),
  );
}

class _CaptureDropDirectoryException implements Exception {
  const _CaptureDropDirectoryException();
}

class _CaptureDropEmptyException implements Exception {
  const _CaptureDropEmptyException();
}

class _CaptureDropUnsupportedException implements Exception {
  const _CaptureDropUnsupportedException();
}

class _CaptureDropTooLargeException implements Exception {
  const _CaptureDropTooLargeException();
}

class _CaptureDropChangedException implements Exception {
  const _CaptureDropChangedException();
}

class _CaptureDropUnreadableException implements Exception {
  const _CaptureDropUnreadableException();
}
