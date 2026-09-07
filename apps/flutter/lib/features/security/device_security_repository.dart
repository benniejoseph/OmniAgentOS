import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'device_security.dart';

class ApiDeviceSecurityRepository implements DeviceSecurityRepository {
  const ApiDeviceSecurityRepository(this.api);

  final ApiClient api;

  @override
  Future<List<MobileDeviceSession>> loadDevices() async {
    final response = await api.getJson(NativePaths.devicesList);
    final values = response['devices'];
    if (values is! List) {
      throw const FormatException('The device list response is invalid.');
    }
    return values
        .whereType<Map>()
        .map(
          (value) =>
              MobileDeviceSession.fromJson(Map<String, dynamic>.from(value)),
        )
        .toList(growable: false);
  }

  @override
  Future<MobileDeviceSession> changeDevice(
    String id,
    DeviceLifecycleAction action,
  ) async => MobileDeviceSession.fromJson(
    await api.postJson(
      NativePaths.devicesChange(id),
      data: {
        'action': switch (action) {
          DeviceLifecycleAction.revoke => 'revoke',
          DeviceLifecycleAction.remoteWipe => 'remote_wipe',
        },
      },
    ),
  );
}
