import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/asael_app.dart';
import 'app/router/app_router.dart';
import 'core/sync/reconnect_coordinator.dart';
import 'features/computer_use/local_computer.dart';
import 'features/push/mobile_push.dart';

Future<void> main(List<String> arguments) async {
  WidgetsFlutterBinding.ensureInitialized();
  final windowContext = LocalComputerWindowContext.fromArguments(arguments);
  try {
    await initializeAsaelPushHandling();
  } catch (value) {
    // Push is an optional launch surface. A missing or temporarily unavailable
    // platform plugin must never prevent the authenticated app from opening.
    debugPrint('Native push launch handoff is unavailable: $value');
  }
  runApp(
    ProviderScope(
      overrides: [
        appInitialLocationProvider.overrideWithValue(
          initialAppLocation(arguments),
        ),
        localComputerWindowContextProvider.overrideWithValue(windowContext),
        primaryNativeRuntimeProvider.overrideWithValue(
          windowContext.role == LocalComputerWindowRole.primary,
        ),
      ],
      child: const AsaelApp(),
    ),
  );
}
