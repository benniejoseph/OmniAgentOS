import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/asael_app.dart';
import 'app/router/app_router.dart';

void main(List<String> arguments) {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    ProviderScope(
      overrides: [
        appInitialLocationProvider.overrideWithValue(
          initialAppLocation(arguments),
        ),
      ],
      child: const AsaelApp(),
    ),
  );
}
