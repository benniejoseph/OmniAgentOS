import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/agent_skill_contracts.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_contracts.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const catalogAt = '2026-10-04T12:00:00.000Z';
const catalogSkill = <String, dynamic>{
  'name': 'Research notes',
  'description': 'Review public references',
  'instructions': 'Read the assigned sources and record supported conclusions.',
  'category': 'research',
  'status': 'active',
  'toolIds': <String>[],
  'tags': ['research'],
  'knowledgeTags': ['sources'],
};
SecureSessionStore catalogSecureStore() =>
    SecureSessionStore(const FlutterSecureStorage());
NativeWorkspaceAccess catalogAccess(
  ApiClient api, {
  String role = 'operator',
  String actor = 'owner@example.test',
  bool Function()? current,
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: 'tenant-catalog',
    actorId: actor,
    canonicalUserId: '11111111-1111-4111-8111-111111111111',
    role: role,
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  role != 'viewer',
);
SpecialistApiClient catalogClient(
  CatalogApi api,
  SpecialistRecoveryStore recovery, {
  String role = 'operator',
  String actor = 'owner@example.test',
  bool Function()? current,
}) => SpecialistApiClient(
  catalogAccess(api, role: role, actor: actor, current: current),
  catalogSecureStore(),
  recovery,
  'agents',
);

Future<SpecialistJson> catalogEnvelope(
  AgentSkillOwner owner,
  SpecialistJson body, {
  required String operation,
  required String action,
  required String resource,
  int count = 1,
  AgentSkillIntent? intent,
}) async {
  final scope = intent == null
      ? null
      : {
          'version': 1,
          'tenantId': owner.tenantId,
          'initiatingActorId': owner.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': owner.actorId,
          'workspaceId': null,
          'projectId': null,
          'missionId': null,
          'delegationId': null,
          'correlationId': intent.key,
          'causationId': intent.resourceId ?? 'skills:create',
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': intent.operation == 'agent.delete'
              ? 'agent.move_to_trash'
              : intent.operation == 'skill.delete'
              ? 'skill.move_to_trash'
              : intent.operation,
        };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': action,
    'resourceType': resource,
    'accessMode': intent == null ? 'read' : 'mutation',
    'eventContract': intent == null
        ? 'read_only:no_domain_mutation'
        : 'agent-skill-native-events.v1',
    'authoritySha256': await specialistSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'role': owner.role,
      'executionScope': scope,
    }),
    'idempotencyKeySha256': intent?.keySha256,
    'outcomeSha256': await specialistSha(body),
    'resourceCount': count,
    'occurredAt': catalogAt,
  };
  return {
    ...body,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await specialistSha(receipt),
    },
  };
}

Future<SpecialistJson> catalogReview(
  AgentSkillOwner owner,
  String operation, {
  String id = 'skill:one',
}) async {
  final agent = operation == 'agent.delete';
  final resource = <String, dynamic>{
    if (!agent) ...catalogSkill,
    if (agent) ...{
      'name': 'Research Agent',
      'role': 'Research assistant',
      'description': 'Review assigned public material',
      'instructions': 'Read assigned sources and record supported conclusions.',
      'persona': {
        'schemaVersion': 1,
        'charter': 'Review assigned sources',
        'operatingStyle': 'Use evidence for conclusions',
        'voice': 'Clear and concise',
        'visualIdentity': 'Quiet specialist',
        'allowedDomains': ['Research'],
        'escalationBehavior': 'Ask when scope is unclear',
        'successMeasures': ['Supported conclusions'],
      },
      'status': 'ready',
      'accent': 'blue',
      'modelPolicy': 'auto',
      'autonomy': 'governed',
      'approvalPolicy': 'risk_based',
      'memoryScope': 'session',
      'skillIds': <String>[],
      'toolIds': <String>[],
    },
    'id': id,
    'tenantId': owner.tenantId,
    'actorId': owner.actorId,
    'slug': 'research',
    if (!agent) 'version': 1,
    'createdAt': catalogAt,
    'updatedAt': catalogAt,
  };
  final pin = {
    'operation': operation,
    'resourceType': agent ? 'custom_agent' : 'agent_skill',
    'resourceId': id,
    'resourceVersion': agent ? null : 1,
    'resourceSha256': await specialistSha(resource),
    'impactSha256': await specialistSha({'affected': []}),
  };
  SpecialistJson? preview;
  if (operation != 'skill.update') {
    final body = {
      'version': 'p9.3-trash-preview:1',
      'action': 'trash',
      'trashId': null,
      'resourceType': pin['resourceType'],
      'resourceId': id,
      'lifecycleRevision': 0,
      'targetSha256': await specialistSha(pin),
      'effectSummary':
          'Move this configuration to Trash and remove its active assignments.',
      'reversible': true,
      'issuedAt': catalogAt,
      'expiresAt': '2099-10-04T12:10:00.000Z',
    };
    preview = {...body, 'previewSha256': await specialistSha(body)};
  }
  final row = {
    'pin': pin,
    'agent': agent ? resource : null,
    'skill': agent ? null : resource,
    'affectedAgents': <Object?>[],
    'agentLifecycle': agent
        ? {
            'releaseState': 'active',
            'releaseRevision': 1,
            'activeDefinitionVersion': 1,
            'latestDefinitionVersion': 1,
            'principalGeneration': 1,
            'principalState': 'held',
          }
        : null,
    'preview': preview,
  };
  return catalogEnvelope(
    owner,
    {'contract': agentSkillReadContract, 'scope': owner.scope, 'review': row},
    operation: agent
        ? 'app.agents.native.delete.review'
        : 'app.skills.native.mutation.review',
    action: 'manage.workflow',
    resource: pin['resourceType'] as String,
  );
}

Future<SpecialistJson> catalogAcceptance(AgentSkillIntent intent) async {
  final create = intent.operation == 'skill.create',
      update = intent.operation == 'skill.update',
      agent = intent.operation == 'agent.delete',
      pin = intent.request['review'] as Map?;
  final reviewSha = pin == null ? null : await specialistSha(pin);
  final beforeVersion = pin == null ? null : pin['resourceVersion'];
  final afterVersion = create
      ? 1
      : update
      ? (beforeVersion as int) + 1
      : null;
  final body = {
    'contract': 'asael-agent-skill-acceptance:1',
    'id':
        'agent-skill-acceptance:${await specialistSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'operation': intent.operation,
    'resourceType': intent.resourceType,
    'resourceId': intent.resourceId ?? 'skill:created',
    'keySha256': intent.keySha256,
    'requestSha256': intent.requestSha256,
    'reviewSha256': reviewSha,
    'beforeVersion': beforeVersion,
    'afterVersion': afterVersion,
    'beforeResourceSha256': pin == null ? null : pin['resourceSha256'],
    'afterResourceSha256': create || update
        ? await specialistSha(catalogSkill)
        : null,
    'affectedAgentIds': <String>[],
    'trash': create || update
        ? null
        : {
            'trashId': 'trash:11111111-1111-4111-8111-111111111111',
            'previewSha256': intent.request['preview']['previewSha256'],
            'targetSha256': reviewSha,
            'snapshotSha256': await specialistSha('snapshot'),
            'receiptSha256': await specialistSha('trash receipt'),
            'compensation': agent ? 'equivalent_action' : 'exact_restore',
          },
    'acceptedAt': catalogAt,
  };
  return {...body, 'acceptanceSha256': await specialistSha(body)};
}

Future<SpecialistJson> catalogResult(
  AgentSkillOwner owner,
  AgentSkillIntent intent, {
  required bool mutation,
  bool found = true,
}) async => catalogEnvelope(
  owner,
  {
    'contract': agentSkillReadContract,
    'scope': owner.scope,
    'acceptance': found ? await catalogAcceptance(intent) : null,
    if (mutation) 'replayed': false,
  },
  operation: mutation
      ? intent.serviceOperation
      : intent.operation == 'agent.delete'
      ? 'app.agents.native.mutations.show'
      : 'app.skills.native.mutations.show',
  action: mutation ? 'manage.workflow' : 'read',
  resource: intent.resourceType,
  count: found ? 1 : 0,
  intent: mutation ? intent : null,
);

class CatalogApi extends ApiClient {
  CatalogApi() : super(Dio(), Dio(), catalogSecureStore());
  int writes = 0, reads = 0;
  bool loseResponse = false, receiptFound = true;
  AgentSkillIntent? submitted;
  Future<void>? admission;
  final admitted = Completer<void>();
  void Function()? beforeWrite;
  @override
  String get apiBaseUrl => 'https://catalog.example.test';
  AgentSkillOwner _owner(NativeRequestAuthority authority) => AgentSkillOwner(
    authority.tenantId,
    authority.actorId,
    'actor:${authority.canonicalUserId}',
    authority.role,
    apiBaseUrl,
  );
  @override
  Future<SpecialistJson> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    SpecialistJson? query,
    CancelToken? cancelToken,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    reads++;
    if (path.contains('/mutations/')) {
      return catalogResult(
        _owner(authority),
        submitted!,
        mutation: false,
        found: receiptFound,
      );
    }
    final uri = Uri.parse(path), id = Uri.decodeComponent(uri.pathSegments[2]);
    return catalogReview(
      _owner(authority),
      path.contains('deletion-review')
          ? 'agent.delete'
          : uri.queryParameters['operation'] == 'update'
          ? 'skill.update'
          : 'skill.delete',
      id: id,
    );
  }

  Future<SpecialistJson> _write(
    NativeRequestAuthority authority,
    SpecialistJson? data,
    SpecialistJson? headers,
  ) async {
    if (!admitted.isCompleted) admitted.complete();
    if (admission != null) await admission;
    authority.requireCurrent(apiBaseUrl);
    beforeWrite?.call();
    writes++;
    submitted = await AgentSkillIntent.prepare(
      _owner(authority),
      headers!['Idempotency-Key'] as String,
      data!,
    );
    if (loseResponse) throw StateError('Response lost after commit.');
    return catalogResult(_owner(authority), submitted!, mutation: true);
  }

  @override
  Future<SpecialistJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    SpecialistJson? data,
    SpecialistJson? headers,
  }) => _write(authority, data, headers);
  @override
  Future<SpecialistJson> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    SpecialistJson? data,
    SpecialistJson? headers,
  }) => _write(authority, data, headers);
  @override
  Future<SpecialistJson> deleteJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    SpecialistJson? data,
    SpecialistJson? query,
    SpecialistJson? headers,
  }) => _write(authority, data, headers);
}
