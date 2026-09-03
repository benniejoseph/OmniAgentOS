import '../../core/network/api_client.dart';
import 'admin_models.dart';

class AdminRepository {
  const AdminRepository(this._api);
  final ApiClient _api;

  Future<AdminSnapshot> load(AdminModule module) async {
    final values = <String, Map<String, dynamic>>{};
    final failures = <String, Object>{};
    await Future.wait(
      module.endpoints.map((endpoint) async {
        try {
          values[endpoint.path] = await _api.getJson(endpoint.path);
        } catch (error) {
          failures[endpoint.path] = error;
        }
      }),
    );
    return AdminSnapshot(values, failures, DateTime.now());
  }

  Future<Map<String, dynamic>> run(AdminAction action) =>
      _api.postJson(action.path, data: action.payload);
}
