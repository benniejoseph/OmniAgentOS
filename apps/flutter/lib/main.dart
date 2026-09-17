import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/asael_app.dart';
import 'app/router/app_router.dart';
import 'features/computer_use/local_computer.dart';

void main(List<String> arguments) {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    ProviderScope(
      overrides: [
        appInitialLocationProvider.overrideWithValue(
          initialAppLocation(arguments),
        ),
        localComputerWindowContextProvider.overrideWithValue(
          LocalComputerWindowContext.fromArguments(arguments),
        ),
      ],
      child: const AsaelApp(),
    ),
  );
}
