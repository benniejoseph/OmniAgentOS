import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/auth/presentation/login_screen.dart';
import 'package:asael/features/auth/presentation/session_bootstrap_screen.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Mac sign-in is focused and submits through SessionController', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1024, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    late _SessionController controller;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionControllerProvider.overrideWith(() {
            controller = _SessionController();
            return controller;
          }),
        ],
        child: MaterialApp(
          theme: MacosAppTheme.light(),
          home: const LoginScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sign in to Asael'), findsOneWidget);
    expect(find.text('Private workspace'), findsOneWidget);
    expect(find.text('One place to\nmove work forward.'), findsNothing);

    await tester.enterText(
      find.byKey(const ValueKey('macos-login-email')),
      'operator@example.com',
    );
    await tester.enterText(
      find.byKey(const ValueKey('macos-login-password')),
      'private-password',
    );
    await tester.tap(find.byKey(const ValueKey('macos-login-submit')));
    await tester.pump();

    expect(controller.email, 'operator@example.com');
    expect(controller.password, 'private-password');
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('Mac bootstrap presents native protected-session progress', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1024, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionControllerProvider.overrideWith(_SessionController.new),
        ],
        child: MaterialApp(
          theme: MacosAppTheme.light(),
          home: const SessionBootstrapScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Opening your private workspace'), findsOneWidget);
    expect(
      find.text('Protected session check · Started just now'),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('macos-bootstrap-loading')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('Mac bootstrap explains a longer protected-session restore', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1024, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionControllerProvider.overrideWith(_SessionController.new),
        ],
        child: MaterialApp(
          theme: MacosAppTheme.light(),
          home: const SessionBootstrapScreen(),
        ),
      ),
    );
    await tester.pump();

    expect(find.textContaining('Still checking this Mac'), findsNothing);

    await tester.pump(const Duration(seconds: 12));
    await tester.pump(const Duration(milliseconds: 160));

    expect(find.textContaining('Still checking this Mac'), findsOneWidget);
    expect(
      find.text('Protected storage check · Taking longer than usual'),
      findsOneWidget,
    );
    expect(find.textContaining('on first launch'), findsOneWidget);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });
}

class _SessionController extends SessionController {
  String? email;
  String? password;

  @override
  Future<AppSession?> build() async => null;

  @override
  Future<bool> signIn(String email, String password) async {
    this.email = email;
    this.password = password;
    return true;
  }
}
