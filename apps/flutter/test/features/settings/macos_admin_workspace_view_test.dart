import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/settings/admin_models.dart';
import 'package:asael/features/settings/admin_providers.dart';
import 'package:asael/features/settings/admin_repository.dart';
import 'package:asael/features/settings/macos_admin_workspace_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Monitoring adapts cleanly throughout the desktop threshold band',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      for (final width in <double>[880, 1040, 1120, 1180, 1240]) {
        tester.view.physicalSize = Size(width, 760);
        await tester.pumpWidget(_app(key: ValueKey(width)));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('macos-admin-area-workspace-split')),
          findsOneWidget,
        );
        expect(
          find.byKey(
            ValueKey(
              width == 1040
                  ? 'macos-admin-health-wide'
                  : 'macos-admin-health-compact',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            ValueKey(
              width < 1156
                  ? 'macos-admin-toolbar-compact'
                  : 'macos-admin-toolbar-wide',
            ),
          ),
          findsOneWidget,
        );
        if (width < 1120) {
          expect(find.byType(FloatingActionButton), findsOneWidget);
          expect(
            find.byKey(const ValueKey('macos-admin-operations-inspector')),
            findsNothing,
          );
        } else {
          expect(find.byType(FloatingActionButton), findsNothing);
          expect(
            find.byKey(const ValueKey('macos-admin-operations-inspector')),
            findsOneWidget,
          );
        }
        expect(tester.takeException(), isNull, reason: 'width $width');
      }
    },
  );

  testWidgets('Monitoring reflows toolbar, health, and evidence when compact', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(680, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('macos-admin-toolbar-compact')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('macos-admin-health-compact')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('macos-admin-area-workspace-stacked')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('macos-admin-filter-menu')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}

Widget _app({Key? key}) => ProviderScope(
  key: key,
  overrides: [
    sessionControllerProvider.overrideWith(_OwnerSessionController.new),
    adminRepositoryProvider.overrideWithValue(_AdminRepository()),
  ],
  child: MaterialApp(
    theme: MacosAppTheme.light(),
    home: const MacosAdminWorkspaceView(moduleId: 'monitoring'),
  ),
);

class _OwnerSessionController extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-test',
    actorId: 'actor:test',
    userId: 'user-test',
    email: 'owner@example.com',
    displayName: 'Owner',
    workspaceName: 'Asael',
    role: 'owner',
  );
}

class _AdminRepository implements AdminRepository {
  @override
  Future<AdminSnapshot> load(AdminModule module) async => AdminSnapshot(
    {
      for (final endpoint in module.endpoints)
        endpoint.path: <String, dynamic>{
          'status': 'healthy',
          'checked': true,
          'latencyMs': 24,
        },
    },
    const {},
    DateTime(2026, 9, 18, 12, 30),
  );

  @override
  Future<Map<String, dynamic>> run(AdminAction action) async => const {
    'accepted': true,
  };
}
