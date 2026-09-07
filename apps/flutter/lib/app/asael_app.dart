import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'router/app_router.dart';
import 'theme/app_theme.dart';
import '../features/auth/application/session_controller.dart';
import '../features/capture/capture_providers.dart';

class AsaelApp extends ConsumerStatefulWidget {
  const AsaelApp({super.key});

  @override
  ConsumerState<AsaelApp> createState() => _AsaelAppState();
}

class _AsaelAppState extends ConsumerState<AsaelApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(
        ref.read(sessionControllerProvider.notifier).lockForBiometrics(),
      );
      ref.read(captureControllerProvider).lock();
    } else if (state == AppLifecycleState.resumed) {
      unawaited(ref.read(captureControllerProvider).syncPending());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(captureOutboxLifecycleProvider);
    return MaterialApp.router(
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
}
