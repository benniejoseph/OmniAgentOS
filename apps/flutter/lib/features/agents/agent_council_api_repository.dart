import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'agent_council.dart';

class ApiAgentCouncilRepository implements AgentCouncilRepository {
  const ApiAgentCouncilRepository(this.api);

  final ApiClient api;

  @override
  Future<AgentCouncilProjection> load({int limit = 60}) async {
    if (limit < 1 || limit > 100) {
      throw RangeError.range(limit, 1, 100, 'limit');
    }
    return AgentCouncilProjection.fromJson(
      await api.getJsonFresh(NativePaths.agentsCouncil(limit: limit)),
    );
  }
}
