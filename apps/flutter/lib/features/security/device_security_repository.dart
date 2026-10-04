import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'device_security.dart';

class ApiDeviceSecurityRepository implements DeviceSecurityRepository {
  const ApiDeviceSecurityRepository(this.api, {this.authority, this.canAccess});

  final ApiClient api;
  final NativeRequestAuthority? authority;
  final bool Function()? canAccess;

  void _requireCurrent() {
    if (canAccess?.call() == false) {
      throw StateError('Device access changed. Reload to continue.');
    }
    authority?.requireCurrent(api.apiBaseUrl);
  }

  @override
  Future<List<MobileDeviceSession>> loadDevices() async {
    _requireCurrent();
    final owner = authority;
    final response = owner == null
        ? await api.getJsonFresh(NativePaths.devicesList)
        : await api.getJsonAuthorized(
            NativePaths.devicesList,
            authority: owner,
          );
    _requireCurrent();
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
  ) async {
    _requireCurrent();
    final data = {
      'action': action == DeviceLifecycleAction.revoke
          ? 'revoke'
          : 'remote_wipe',
    };
    final owner = authority;
    final response = owner == null
        ? await api.postJson(NativePaths.devicesChange(id), data: data)
        : await api.postJsonAuthorized(
            NativePaths.devicesChange(id),
            authority: owner,
            data: data,
          );
    _requireCurrent();
    final result = MobileDeviceSession.fromJson(response);
    if (result.id != id ||
        result.current ||
        (action == DeviceLifecycleAction.revoke
            ? result.state != 'revoked'
            : !{'wipe_pending', 'wiped'}.contains(result.state))) {
      throw const FormatException(
        'The requested device change could not be confirmed. Refresh the device list.',
      );
    }
    return result;
  }
}
