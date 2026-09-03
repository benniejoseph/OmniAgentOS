import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'router/app_router.dart';
import 'theme/app_theme.dart';

class AsaelApp extends ConsumerWidget {
  const AsaelApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    title: 'Asael',
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light(),
    darkTheme: AppTheme.dark(),
    highContrastTheme: AppTheme.light(highContrast: true),
    highContrastDarkTheme: AppTheme.dark(highContrast: true),
    themeMode: ThemeMode.system,
    routerConfig: ref.watch(appRouterProvider),
  );
}
