import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/legacy.dart';
import 'package:path_provider/path_provider.dart';

import 'companion_providers.dart';
import 'companion_repository.dart';

enum VoiceAppearance {
  companion('Companion'),
  perch('Perch');

  const VoiceAppearance(this.label);
  final String label;
}

/// This device's presentation preference, separate from the closed remote
/// companion-preferences contract. The address binds deployment and owner.
final voiceAppearanceProvider =
    ChangeNotifierProvider<VoiceAppearanceController>(
      (ref) =>
          VoiceAppearanceController(ref.watch(companionScopeProvider))..load(),
    );

class VoiceAppearanceController extends ChangeNotifier {
  VoiceAppearanceController(this.scope);
  final CompanionScope? scope;
  VoiceAppearance appearance = VoiceAppearance.companion;
  String? persistenceNotice;
  bool _disposed = false;
  int _revision = 0;
  Future<void> _writes = Future<void>.value();
  Future<File>? _file;
  StreamSubscription<FileSystemEvent>? _watcher;
  Timer? _reload;

  bool get available => scope != null && !_disposed;

  Future<File> _preferenceFile() => _file ??= () async {
    final owner = scope!;
    final digest = await Sha256().hash(
      utf8.encode(
        jsonEncode([
          'asael.voice-appearance:1',
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
      '${support.path}${Platform.pathSeparator}voice-appearance-$key.json',
    );
  }();

  Future<void> load() async {
    if (!available) return;
    final revision = _revision;
    try {
      final file = await _preferenceFile();
      if (!available || revision != _revision) return;
      var next = VoiceAppearance.companion;
      if (await file.exists()) {
        final value = jsonDecode(await file.readAsString());
        if (value is Map &&
            value['version'] == 1 &&
            value['appearance'] == 'perch') {
          next = VoiceAppearance.perch;
        }
      }
      if (!available || revision != _revision) return;
      if (appearance != next) {
        appearance = next;
        notifyListeners();
      }
      // Other native workspace engines can change the same owner's setting.
      // Watching the containing directory also survives atomic file replacement.
      if (_watcher == null) {
        await file.parent.create(recursive: true);
        if (!available) return;
        _watcher = file.parent.watch().listen(
          (event) {
            if (!available || !event.path.contains(file.uri.pathSegments.last))
              return;
            _reload?.cancel();
            _reload = Timer(const Duration(milliseconds: 180), () async {
              await _writes;
              if (available) await load();
            });
          },
          onError: (Object _) {
            /* Optional presentation observation. */
          },
        );
      }
    } catch (_) {
      // An unavailable device preference never blocks voice or its controls.
    }
  }

  Future<void> setAppearance(VoiceAppearance value) {
    if (!available) return Future<void>.value();
    _revision++;
    appearance = value;
    persistenceNotice = null;
    notifyListeners();
    final revision = _revision;
    _writes = _writes.then((_) async {
      try {
        final file = await _preferenceFile();
        if (!available) return;
        await file.parent.create(recursive: true);
        if (!available) return;
        final temporary = File(
          '${file.path}.$pid.${DateTime.now().microsecondsSinceEpoch}.$revision.tmp',
        );
        await temporary.writeAsString(
          jsonEncode({'version': 1, 'appearance': value.name}),
          flush: true,
        );
        if (!available) {
          await temporary.delete();
          return;
        }
        await temporary.rename(file.path);
      } catch (_) {
        if (available && revision == _revision) {
          persistenceNotice = 'Using this appearance for now. It could not be saved on this device.';
          notifyListeners();
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
