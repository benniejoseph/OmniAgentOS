import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'agent_council.dart';

class ApiAgentCouncilRepository
    implements
        AgentCouncilRepository,
        AgentCouncilControlRepository,
        AgentCouncilDetailRepository {
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

  @override
  Future<AgentCouncilCancellation> cancel({
    required String executionId,
    required int expectedRevision,
    required String reason,
    required String idempotencyKey,
  }) async {
    if (executionId.trim().isEmpty || executionId.length > 240) {
      throw ArgumentError.value(executionId, 'executionId');
    }
    if (expectedRevision < 0) {
      throw ArgumentError.value(expectedRevision, 'expectedRevision');
    }
    final normalizedReason = reason.trim();
    if (normalizedReason.isEmpty || normalizedReason.length > 500) {
      throw ArgumentError.value(reason, 'reason');
    }
    if (idempotencyKey.isEmpty || idempotencyKey.length > 512) {
      throw ArgumentError.value(idempotencyKey, 'idempotencyKey');
    }
    return AgentCouncilCancellation.fromJson(
      await api.postJson(
        NativePaths.agentsTasksCancel(executionId),
        data: {
          'expectedRevision': expectedRevision,
          'reason': normalizedReason,
        },
        headers: {'idempotency-key': idempotencyKey},
      ),
    );
  }

  @override
  Future<AgentTaskDetail> loadTaskDetail(String executionId) async {
    if (executionId.trim().isEmpty || executionId.length > 240) {
      throw ArgumentError.value(executionId, 'executionId');
    }
    return AgentTaskDetail.fromJson(
      await api.getJsonFresh(NativePaths.agentsTasksShow(executionId)),
    );
  }
}
