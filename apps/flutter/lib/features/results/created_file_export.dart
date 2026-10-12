import 'dart:io';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as path;

import '../../core/network/api_client.dart';

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

/// A local destination binding, never an authorization grant. Callers may add
/// an exact file/version reference to prevent a different artifact reusing it.
String createdFileExportScopeKey(
  NativeRequestAuthority authority, {
  String purpose = 'archive',
}) => [
  NativeRequestAuthority.normalizeApiBaseUrl(authority.apiBaseUrl),
  authority.tenantId,
  authority.actorId,
  authority.canonicalUserId,
  authority.role,
  purpose,
].map(Uri.encodeComponent).join('|');

class AndroidPreparedFileDestination {
  const AndroidPreparedFileDestination({
    required this.filename,
    required this.requestedFilename,
  });
  final String filename;
  final String requestedFilename;
}

/// Android's document picker intentionally suspends the protected workspace.
/// Choosing therefore receives NO private bytes. After the normal unlock, a
/// fresh owner-scoped controller must explicitly start the save and download.
/// The native handle is process-local, one-use, owner-bound and short-lived.
class AndroidCreatedFileExportAdapter implements CreatedFileExportAdapter {
  const AndroidCreatedFileExportAdapter({required this.scopeKey});
  final String scopeKey;
  static const _channel = MethodChannel('app.omniagent.omniagent/file_export');

  @override
  bool get available =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  Future<void> prepareDestination({required String filename}) async {
    if (!available) {
      throw UnsupportedError('Android file saving is unavailable.');
    }
    await _channel.invokeMethod<void>('chooseDestination', {
      'scopeKey': scopeKey,
      'filename': filename,
    });
  }

  Future<AndroidPreparedFileDestination?> preparedDestination() async {
    if (!available) return null;
    final value = await _channel.invokeMapMethod<String, dynamic>(
      'preparedDestination',
      {'scopeKey': scopeKey},
    );
    final filename = value?['filename'];
    final requestedFilename = value?['requestedFilename'];
    if (filename is! String ||
        filename.isEmpty ||
        requestedFilename is! String ||
        requestedFilename.isEmpty) {
      return null;
    }
    return AndroidPreparedFileDestination(
      filename: filename,
      requestedFilename: requestedFilename,
    );
  }

  @override
  Future<String?> selectDestination({required String filename}) async {
    if (!available) return null;
    final value = await _channel.invokeMapMethod<String, dynamic>(
      'preparedDestination',
      {'scopeKey': scopeKey},
    );
    return value?['requestedFilename'] == filename && value?['handle'] is String
        ? value!['handle'] as String
        : null;
  }

  @override
  Future<void> writeBytes(
    String destination,
    Uint8List bytes, {
    required bool Function() isCurrent,
  }) async {
    if (!available || !isCurrent()) throw const CreatedFileExportScopeChanged();
    // No asynchronous preparation occurs between the scope check and native
    // write admission. Android independently requires a resumed, unlocked host.
    await _channel.invokeMethod<void>('writePrepared', {
      'scopeKey': scopeKey,
      'handle': destination,
      'bytes': bytes,
    });
  }
}

/// The installed desktop file_selector implementations return a destination
/// without writing a file. file_picker.saveFile instead accepts private bytes
/// before its native dialog and cannot recheck scope after that dialog returns.
/// iOS/web need their own destination-then-write adapters before export
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
