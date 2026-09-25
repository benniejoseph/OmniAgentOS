import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/legacy.dart';
import 'package:path_provider/path_provider.dart';

final appThemeModeProvider = ChangeNotifierProvider<AppThemeModeController>(
  (ref) => AppThemeModeController()..load(),
);

class AppThemeModeController extends ChangeNotifier {
  ThemeMode _mode = ThemeMode.system;
  bool _loaded = false;

  ThemeMode get mode => _mode;
  bool get loaded => _loaded;

  Future<void> load() async {
    if (_loaded) return;
    try {
      final file = await _preferenceFile();
      if (await file.exists()) {
        final payload = jsonDecode(await file.readAsString());
        if (payload is Map<String, dynamic>) {
          _mode = _themeModeFromName(payload['themeMode']);
        }
      }
    } catch (_) {
      // Appearance preferences are optional. A corrupt or unavailable local
      // preference falls back to the operating system without blocking Asael.
      _mode = ThemeMode.system;
    } finally {
      _loaded = true;
      notifyListeners();
    }
  }

  Future<void> setMode(ThemeMode mode) async {
    if (_mode == mode && _loaded) return;
    _mode = mode;
    _loaded = true;
    notifyListeners();
    try {
      final file = await _preferenceFile();
      await file.parent.create(recursive: true);
      await file.writeAsString(
        jsonEncode({'version': 1, 'themeMode': mode.name}),
        flush: true,
      );
    } catch (_) {
      // Keep the selected theme for this session even when local persistence
      // is temporarily unavailable.
    }
  }

  Future<File> _preferenceFile() async {
    final directory = await getApplicationSupportDirectory();
    return File(
      '${directory.path}${Platform.pathSeparator}appearance-v1.json',
    );
  }
}

ThemeMode _themeModeFromName(Object? value) => switch (value) {
  'light' => ThemeMode.light,
  'dark' => ThemeMode.dark,
  _ => ThemeMode.system,
};
