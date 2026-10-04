import 'dart:io';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as path;

enum CreatedFileExportOutcome { saved, canceled, scopeChanged, unavailable }

class CreatedFileExportScopeChanged implements Exception {
  const CreatedFileExportScopeChanged();
}

/// Destination selection must never receive the private bytes. Every adapter
/// must check `isCurrent` at its write boundary, after its last asynchronous
/// preparation step and before admitting a filesystem or platform write.
abstract interface class CreatedFileExportAdapter {
  bool get available;
  Future<String?> selectDestination({required String filename});
  Future<void> writeBytes(
    String destination,
    Uint8List bytes, {
    required bool Function() isCurrent,
  });
}

/// The installed desktop file_selector implementations return a destination
/// without writing a file. file_picker.saveFile instead accepts private bytes
/// before its native dialog and cannot recheck scope after that dialog returns.
/// iOS/Android/web need their own destination-then-write adapters before export
/// can be offered there; do not fall back to the eager file_picker API.
class DesktopCreatedFileExportAdapter implements CreatedFileExportAdapter {
  const DesktopCreatedFileExportAdapter();

  @override
  bool get available =>
      !kIsWeb &&
      const {
        TargetPlatform.macOS,
        TargetPlatform.windows,
        TargetPlatform.linux,
      }.contains(defaultTargetPlatform);

  @override
  Future<String?> selectDestination({required String filename}) async {
    if (!available) {
      throw UnsupportedError(
        'Private file export is unavailable on this platform.',
      );
    }
    final selected = await FileSelectorPlatform.instance.getSaveLocation(
      acceptedTypeGroups: [
        XTypeGroup(
          label: 'Created file',
          extensions: [path.extension(filename).replaceFirst('.', '')],
        ),
      ],
      options: SaveDialogOptions(
        suggestedName: filename,
        confirmButtonText: 'Save',
      ),
    );
    if (selected == null) {
      return null;
    }
    _validateDestination(selected.path);
    return selected.path;
  }

  @override
  Future<void> writeBytes(
    String destination,
    Uint8List bytes, {
    required bool Function() isCurrent,
  }) async {
    if (!available) {
      throw UnsupportedError(
        'Private file export is unavailable on this platform.',
      );
    }
    _validateDestination(destination);
    if (!isCurrent()) {
      throw const CreatedFileExportScopeChanged();
    }
    // There is deliberately no await between the authority check and write
    // admission. A change while the destination dialog was open cannot export.
    await File(destination).writeAsBytes(bytes, flush: true);
  }

  void _validateDestination(String destination) {
    if (!path.isAbsolute(destination) || destination.contains('\u0000')) {
      throw const FormatException(
        'The save dialog did not return a local destination.',
      );
    }
  }
}

class ScopedCreatedFileExporter {
  const ScopedCreatedFileExporter({
    this.adapter = const DesktopCreatedFileExportAdapter(),
  });
  final CreatedFileExportAdapter adapter;
  bool get available => adapter.available;

  Future<CreatedFileExportOutcome> save({
    required String filename,
    required Future<Uint8List> Function() loadBytes,
    required bool Function() isCurrent,
  }) async {
    if (!isCurrent()) {
      return CreatedFileExportOutcome.scopeChanged;
    }
    if (!available) {
      return CreatedFileExportOutcome.unavailable;
    }
    try {
      final destination = await adapter.selectDestination(filename: filename);
      if (!isCurrent()) {
        return CreatedFileExportOutcome.scopeChanged;
      }
      if (destination == null) {
        return CreatedFileExportOutcome.canceled;
      }
      final bytes = await loadBytes();
      if (!isCurrent()) {
        return CreatedFileExportOutcome.scopeChanged;
      }
      await adapter.writeBytes(destination, bytes, isCurrent: isCurrent);
      return CreatedFileExportOutcome.saved;
    } on CreatedFileExportScopeChanged {
      return CreatedFileExportOutcome.scopeChanged;
    }
  }
}
