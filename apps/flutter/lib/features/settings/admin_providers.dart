import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'admin_controller.dart';
import 'admin_registry.dart';
import 'admin_repository.dart';

final adminRepositoryProvider = Provider<AdminRepository>(
  (ref) => AdminRepository(ref.watch(apiClientProvider)),
);

final adminControllerProvider =
    ChangeNotifierProvider.family<AdminController, String>((ref, id) {
      final module = adminModules.firstWhere((item) => item.id == id);
      return AdminController(ref.watch(adminRepositoryProvider), module)
        ..refresh();
    });
