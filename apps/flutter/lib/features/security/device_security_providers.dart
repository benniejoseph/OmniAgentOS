import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/data/session_repository.dart';
import 'device_security.dart';
import 'device_security_repository.dart';

final deviceSecurityRepositoryProvider =
    Provider.autoDispose<DeviceSecurityRepository>((ref) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      return ApiDeviceSecurityRepository(
        ref.watch(apiClientProvider),
        authority: access?.authority,
        canAccess: () => ref.mounted && access != null && access.current,
      );
    });

final deviceSecurityControllerProvider =
    ChangeNotifierProvider.autoDispose<DeviceSecurityController>((ref) {
      final sessions = ref.watch(sessionRepositoryProvider);
      final access = ref.watch(nativeWorkspaceAccessProvider);
      return DeviceSecurityController(
        repository: ref.watch(deviceSecurityRepositoryProvider),
        readBiometricEnabled: sessions.isBiometricEnabled,
        readBiometricAvailable: sessions.isBiometricAvailable,
        changeBiometricEnabled: sessions.setBiometricEnabled,
        canAccess: () => ref.mounted && access != null && access.current,
      )..refresh();
    });
