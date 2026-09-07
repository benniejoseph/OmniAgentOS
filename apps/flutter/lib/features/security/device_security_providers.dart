import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../auth/data/session_repository.dart';
import 'device_security.dart';
import 'device_security_repository.dart';

final deviceSecurityRepositoryProvider = Provider<DeviceSecurityRepository>(
  (ref) => ApiDeviceSecurityRepository(ref.watch(apiClientProvider)),
);

final deviceSecurityControllerProvider =
    ChangeNotifierProvider<DeviceSecurityController>((ref) {
      final sessions = ref.watch(sessionRepositoryProvider);
      return DeviceSecurityController(
        repository: ref.watch(deviceSecurityRepositoryProvider),
        readBiometricEnabled: sessions.isBiometricEnabled,
        readBiometricAvailable: sessions.isBiometricAvailable,
        changeBiometricEnabled: sessions.setBiometricEnabled,
      )..refresh();
    });
