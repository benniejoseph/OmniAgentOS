import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/legacy.dart';
import 'package:path_provider/path_provider.dart';

import 'companion_providers.dart';
import 'companion_repository.dart';

enum CompanionPersonality {
  butler('Butler', 'British poise and dry wit'),
  playful('Playful', 'Quick wit and friendly banter');

  const CompanionPersonality(this.label, this.description);
  final String label;
  final String description;
}

typedef CompanionPersonalityReader = Future<CompanionPersonality> Function();

/// Presentation preference only. It cannot change the selected agent, context,
/// tool permissions, or the closed remote Companion preferences contract.
final companionPersonalityProvider =
    ChangeNotifierProvider<CompanionPersonalityController>(
      (ref) =>
          CompanionPersonalityController(ref.watch(companionScopeProvider))
            ..initialize(),
    );

class CompanionPersonalityController extends ChangeNotifier {
  CompanionPersonalityController(this.scope);

  final CompanionScope? scope;
  CompanionPersonality personality = CompanionPersonality.butler;
  String? persistenceNotice;
  bool _disposed = false;
  int _revision = 0;
  Future<void>? _initialLoad;
  Future<void> _writes = Future<void>.value();
  Future<File>? _file;
  StreamSubscription<FileSystemEvent>? _watcher;
  Timer? _reload;

  bool get available => scope != null && !_disposed;

  Future<void> initialize() => _initialLoad ??= _load();

  /// Call once when a message, voice conversation, or spoken reply begins.
  /// The caller retains the value through retries and the lifetime of a call.
  Future<CompanionPersonality> readSelection() async {
    await initialize();
    if (!available) {
      throw StateError('The signed-in account changed. Try again.');
    }
    return personality;
  }

  Future<File> _preferenceFile() => _file ??= () async {
    final owner = scope!;
    final digest = await Sha256().hash(
      utf8.encode(
        jsonEncode([
          'asael.companion-personality:1',
          owner.deployment,
          owner.tenantId,
          owner.actorId,
        ]),
      ),
    );
    final key = digest.bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
    final support = await getApplicationSupportDirectory();
    return File(
      '${support.path}${Platform.pathSeparator}companion-personality-$key.json',
    );
  }();

  Future<void> _load() async {
    if (!available) return;
    final revision = _revision;
    try {
      final file = await _preferenceFile();
      await _observe(file);
      if (!available || revision != _revision) return;
      var next = CompanionPersonality.butler;
      if (await file.exists()) {
        final value = jsonDecode(await file.readAsString());
        if (value is Map &&
            value['version'] == 1 &&
            value['personality'] == 'playful') {
          next = CompanionPersonality.playful;
        }
      }
      if (!available || revision != _revision) return;
      if (personality != next) {
        personality = next;
        notifyListeners();
      }
    } catch (_) {
      // A missing or unavailable local preference never prevents conversation.
    }
  }

  Future<void> _observe(File file) async {
    // Auxiliary native windows share the owner's preference. Ignore temporary
    // write files and keep an unsaved in-memory choice if persistence failed.
    if (_watcher != null || !available) return;
    try {
      await file.parent.create(recursive: true);
      if (!available || _watcher != null) return;
      _watcher = file.parent.watch().listen(
        (event) {
          final relevant =
              event.path == file.path ||
              (event is FileSystemMoveEvent && event.destination == file.path);
          if (!available || !relevant) return;
          _reload?.cancel();
          _reload = Timer(const Duration(milliseconds: 180), () async {
            await _writes;
            if (available && persistenceNotice == null) await _load();
          });
        },
        onError: (Object _) {
          /* Optional observation; the current window keeps its choice. */
        },
      );
    } catch (_) {
      /* Reading the saved choice remains available without observation. */
    }
  }

  Future<void> setPersonality(CompanionPersonality value) {
    if (!available) return Future<void>.value();
    _revision++;
    personality = value;
    persistenceNotice = null;
    notifyListeners();
    final revision = _revision;
    _writes = _writes.then((_) async {
      File? temporary;
      try {
        final file = await _preferenceFile();
        if (!available) return;
        await file.parent.create(recursive: true);
        if (!available) return;
        temporary = File(
          '${file.path}.$pid.${DateTime.now().microsecondsSinceEpoch}.$revision.tmp',
        );
        await temporary.writeAsString(
          jsonEncode({'version': 1, 'personality': value.name}),
          flush: true,
        );
        if (!available) return;
        await temporary.rename(file.path);
        temporary = null;
      } catch (_) {
        if (available && revision == _revision) {
          persistenceNotice = 'Using this personality for now. It could not be saved on this device.';
          notifyListeners();
        }
      } finally {
        try {
          if (temporary != null && await temporary.exists()) {
            await temporary.delete();
          }
        } catch (_) {
          /* A failed preference write must not prevent later attempts. */
        }
      }
    });
    return _writes;
  }

  @override
  void dispose() {
    _disposed = true;
    _revision++;
    _reload?.cancel();
    unawaited(_watcher?.cancel());
    super.dispose();
  }
}
