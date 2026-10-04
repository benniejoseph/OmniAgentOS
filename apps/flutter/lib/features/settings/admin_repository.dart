import '../../core/network/api_client.dart';
import 'admin_models.dart';

class AdminRepository {
  const AdminRepository(this._api, {this.authority, this.canAccess});
  final ApiClient _api;
  final NativeRequestAuthority? authority;
  final bool Function()? canAccess;

  void _requireCurrent() {
    if (canAccess?.call() == false) {
      throw StateError('Workspace access changed. Reload to continue.');
    }
    authority?.requireCurrent(_api.apiBaseUrl);
  }

  Future<AdminSnapshot> load(AdminModule module) async {
    _requireCurrent();
    final values = <String, Map<String, dynamic>>{};
    final failures = <String, Object>{};
    await Future.wait(
      module.endpoints.map((endpoint) async {
        try {
          _requireCurrent();
          final owner = authority;
          final result = owner == null
              ? await _api.getJsonFresh(endpoint.path)
              : await _api.getJsonAuthorized(endpoint.path, authority: owner);
          _requireCurrent();
          values[endpoint.path] = result;
        } catch (error) {
          failures[endpoint.path] = error;
        }
      }),
    );
    _requireCurrent();
    return AdminSnapshot(values, failures, DateTime.now());
  }

  Future<Map<String, dynamic>> run(AdminAction action) {
    _requireCurrent();
    final owner = authority;
    return owner == null
        ? _api.postJson(action.path, data: action.payload)
        : _api.postJsonAuthorized(
            action.path,
            authority: owner,
            data: action.payload,
          );
  }
}
