import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import 'admin_controller.dart';
import 'admin_registry.dart';
import 'admin_repository.dart';

final adminRepositoryProvider = Provider.autoDispose<AdminRepository>((ref) {
  final access = ref.watch(nativeWorkspaceAccessProvider);
  return AdminRepository(
    ref.watch(apiClientProvider),
    authority: access?.authority,
    canAccess: () =>
        ref.mounted && access != null && access.current && access.canManage,
  );
});

final adminControllerProvider = ChangeNotifierProvider.autoDispose
    .family<AdminController, String>((ref, id) {
      final module = adminModules.firstWhere((item) => item.id == id);
      return AdminController(ref.watch(adminRepositoryProvider), module)
        ..refresh();
    });
