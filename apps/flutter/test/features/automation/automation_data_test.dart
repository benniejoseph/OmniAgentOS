import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/automation/automation_api_repository.dart';
import 'package:asael/features/automation/automation_controller.dart';
import 'package:asael/features/automation/automation_models.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _previewSha =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _occurrenceId =
    'workflow_schedule_occurrence_1111111111111111111111111111111111111111';
const _receiptId =
    'workflow_schedule_receipt_2222222222222222222222222222222222222222';
const _leaseId =
    'policy_lease_333333333333333333333333333333333333333333333333';
const _consumptionReceiptId =
    'policy_lease_receipt_444444444444444444444444444444444444444444444444';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('parses the nested truthful integrations overview', () {
    final inventory = AutomationConnectionInventory.fromResponse({
      'overview': {
        'state': 'partial',
        'generatedAt': '2026-09-19T09:00:00.000Z',
        'installed': [
          {
            'id': 'gmail',
            'name': 'Gmail',
            'kind': 'google_service',
            'adapter': 'native',
            'state': 'working',
            'connected': true,
            'manageable': true,
            'permissions': {'mode': 'read_write'},
            'sync': {'status': 'current'},
            'nextAction': 'No action needed.',
          },
        ],
        'suggestions': [
          {
            'id': 'github',
            'name': 'GitHub',
            'adapter': 'mcp',
            'state': 'setup_available',
            'detail': 'Connect when needed.',
            'capabilities': ['Repositories'],
          },
        ],
      },
    });

    expect(inventory.state, 'partial');
    expect(inventory.installed.single.name, 'Gmail');
    expect(inventory.installed.single.permissionMode, 'read_write');
    expect(inventory.installed.single.syncStatus, 'current');
    expect(inventory.suggestions.single.capabilities, ['Repositories']);
    expect(
      AutomationPlugin.fromJson({
        'pluginId': 'plugin.state-only',
        'version': '1.0.0',
        'name': 'State-only Plugin',
        'state': 'disabled',
      }).status,
      'disabled',
    );
    expect(
      AutomationPlugin.fromJson({
        'pluginId': 'plugin.imported',
        'version': '1.0.0',
        'name': 'Imported Plugin',
        'catalogSource': 'installed_manifest',
      }).catalogSource,
      'installed_manifest',
    );
  });

  test(
    'loads every source concurrently and retains a source-level failure',
    () async {
      final api = _ConcurrentApiClient();
      final future = ApiAutomationRepository(api).load();
      await Future<void>.delayed(Duration.zero);

      expect(api.pending.keys, {
        NativePaths.skillsList,
        NativePaths.integrationsOverview(),
        NativePaths.adminConnectors,
        NativePaths.adminTools,
        NativePaths.adminWorkflows,
        NativePaths.adminTriggers,
        NativePaths.pluginsList,
      });
      expect(api.queries[NativePaths.adminWorkflows], {'limit': 24});
      expect(api.queries[NativePaths.adminTriggers], {'limit': 48});

      api.complete(NativePaths.skillsList, {'skills': const []});
      api.complete(NativePaths.integrationsOverview(), {
        'overview': {
          'state': 'empty',
          'generatedAt': '2026-09-19T09:00:00.000Z',
          'installed': const [],
          'suggestions': const [],
        },
      });
      api.complete(NativePaths.adminConnectors, {'connectors': const []});
      api.fail(
        NativePaths.adminTools,
        const ApiException('Tool inventory is unavailable.', statusCode: 503),
      );
      api.complete(NativePaths.adminWorkflows, {'runs': const []});
      api.complete(NativePaths.adminTriggers, {'triggers': const []});
      api.complete(NativePaths.pluginsList, {
        'plugins': const [],
        'installations': const [],
        'storage': 'canonical_database',
      });

      final snapshot = await future;
      expect(snapshot.failureCount, 1);
      expect(snapshot.tools.hasError, isTrue);
      expect(snapshot.tools.error, contains('Tool inventory is unavailable'));
      expect(snapshot.skills.isReady, isTrue);
      expect(snapshot.connections.isReady, isTrue);
      expect(snapshot.plugins.isReady, isTrue);
    },
  );

  test('binds Plugin mutations to idempotency, digest, and revision', () async {
    final api = _MutationApiClient();
    final repository = ApiAutomationRepository(api);
    final plugin = _plugin();

    final preview = await repository.previewCatalogPlugin(
      plugin,
      idempotencyKey: 'preview-one',
    );
    expect(api.lastPath, NativePaths.pluginsPreview);
    expect(api.lastHeaders?['Idempotency-Key'], 'preview-one');
    expect(api.lastData?['manifestSha256'], _sha);
    expect(preview.previewSha256, _previewSha);

    await repository.installPlugin(preview, idempotencyKey: 'install-one');
    expect(api.lastPath, NativePaths.pluginsInstall);
    expect(api.lastHeaders?['Idempotency-Key'], 'install-one');
    expect(api.lastData, {
      'previewId': 'plugin-preview:test-111111',
      'manifestSha256': _sha,
    });

    await repository.setPluginEnabled(
      plugin,
      enabled: false,
      idempotencyKey: 'disable-one',
    );
    expect(api.lastMethod, 'PATCH');
    expect(api.lastData, {'action': 'disable', 'expectedRevision': 4});

    await repository.uninstallPlugin(plugin, idempotencyKey: 'uninstall-one');
    expect(api.lastMethod, 'DELETE');
    expect(api.lastHeaders?['Idempotency-Key'], 'uninstall-one');
    expect(api.lastData, {'expectedRevision': 4});
  });

  test('loads exact schedule and content-free PolicyLease history', () async {
    final api = _ScheduleApiClient();
    final repository = ApiAutomationRepository(api);

    final detail = await repository.loadSchedule('trigger/one');

    expect(api.path, NativePaths.automationScheduleShow('trigger/one'));
    expect(detail.trigger.id, 'trigger/one');
    expect(detail.occurrences.single.authoritySha256, _sha);
    expect(detail.receipts.single.receiptSha256, _previewSha);
    expect(detail.policyLeasesAvailable, isTrue);
    expect(detail.policyLeases.single.toolId, 'calendar.events.create');
    expect(detail.policyLeases.single.status, 'consumed');
    expect(detail.policyLeases.single.consumptionReceiptSha256, _sha);
  });

  test(
    'rejects schedule history that contains content or grants authority',
    () {
      final content = _scheduleResponse();
      final policy = Map<String, dynamic>.from(content['policyLeases']! as Map);
      final outcome = Map<String, dynamic>.from(
        (policy['outcomes']! as List).single as Map,
      )..['contentIncluded'] = true;
      policy['outcomes'] = [outcome];
      content['policyLeases'] = policy;
      expect(
        () => AutomationScheduleDetail.fromResponse(content),
        throwsFormatException,
      );

      final authority = _scheduleResponse();
      final authorityPolicy = Map<String, dynamic>.from(
        authority['policyLeases']! as Map,
      );
      final authorityOutcome = Map<String, dynamic>.from(
        (authorityPolicy['outcomes']! as List).single as Map,
      )..['leaseGrantsAuthority'] = true;
      authorityPolicy['outcomes'] = [authorityOutcome];
      authority['policyLeases'] = authorityPolicy;
      expect(
        () => AutomationScheduleDetail.fromResponse(authority),
        throwsFormatException,
      );
    },
  );

  test('requires an exact PolicyLease projection envelope', () {
    final missingVersion = _scheduleResponse();
    final missingVersionPolicy = Map<String, dynamic>.from(
      missingVersion['policyLeases']! as Map,
    )..remove('version');
    missingVersion['policyLeases'] = missingVersionPolicy;
    expect(
      () => AutomationScheduleDetail.fromResponse(missingVersion),
      throwsFormatException,
    );

    final missingAvailability = _scheduleResponse();
    final missingAvailabilityPolicy = Map<String, dynamic>.from(
      missingAvailability['policyLeases']! as Map,
    )..remove('available');
    missingAvailability['policyLeases'] = missingAvailabilityPolicy;
    expect(
      () => AutomationScheduleDetail.fromResponse(missingAvailability),
      throwsFormatException,
    );

    final unavailableWithOutcomes = _scheduleResponse();
    final unavailablePolicy = Map<String, dynamic>.from(
      unavailableWithOutcomes['policyLeases']! as Map,
    )..['available'] = false;
    unavailableWithOutcomes['policyLeases'] = unavailablePolicy;
    expect(
      () => AutomationScheduleDetail.fromResponse(unavailableWithOutcomes),
      throwsFormatException,
    );

    final unavailable = _scheduleResponse();
    final unavailableEmptyPolicy =
        Map<String, dynamic>.from(unavailable['policyLeases']! as Map)
          ..['available'] = false
          ..['outcomes'] = const [];
    unavailable['policyLeases'] = unavailableEmptyPolicy;
    expect(
      AutomationScheduleDetail.fromResponse(unavailable).policyLeasesAvailable,
      isFalse,
    );
  });

  test('rejects malformed schedule occurrence evidence', () {
    for (final mutation in <String, Object?>{
      'id': 'occurrence-one',
      'kind': 'timer',
      'status': 'running',
      'authoritySha256': 'not-a-digest',
      'scheduledFor': '2026-09-22T03:00:00+00:00',
      'updatedAt': 'not-a-timestamp',
      'attemptCount': 1.5,
    }.entries) {
      expect(
        () => AutomationScheduleDetail.fromResponse(
          _scheduleResponseWithOccurrence(mutation.key, mutation.value),
        ),
        throwsFormatException,
        reason: 'Occurrence ${mutation.key} must fail closed.',
      );
    }

    final reversedTime = _scheduleResponseWithOccurrence(
      'updatedAt',
      '2026-09-22T02:59:59.000Z',
    );
    expect(
      () => AutomationScheduleDetail.fromResponse(reversedTime),
      throwsFormatException,
    );
    final invalidList = _scheduleResponse()..['occurrences'] = [null];
    expect(
      () => AutomationScheduleDetail.fromResponse(invalidList),
      throwsFormatException,
    );
  });

  test('rejects malformed schedule receipt evidence', () {
    for (final mutation in <String, Object?>{
      'id': 'receipt-one',
      'occurrenceId': 'occurrence-one',
      'status': 'running',
      'receiptSha256': 'not-a-digest',
      'stateSha256': 'not-a-digest',
      'recordedAt': '2026-09-22',
    }.entries) {
      expect(
        () => AutomationScheduleDetail.fromResponse(
          _scheduleResponseWithReceipt(mutation.key, mutation.value),
        ),
        throwsFormatException,
        reason: 'Receipt ${mutation.key} must fail closed.',
      );
    }
    final invalidList = _scheduleResponse()..['receipts'] = ['not-a-record'];
    expect(
      () => AutomationScheduleDetail.fromResponse(invalidList),
      throwsFormatException,
    );
  });

  test('enforces closed PolicyLease statuses and consumption evidence', () {
    for (final mutation in <String, Object?>{
      'leaseId': 'policy-lease-one',
      'occurrenceId': 'occurrence-one',
      'status': 'active',
      'bindingIndex': -1,
      'issuedAt': '2026-09-22T03:00:00+00:00',
      'expiresAt': '2026-09-22T02:59:59.000Z',
      'consumptionReceiptId': 'consumption-one',
      'consumptionReceiptSha256': 'not-a-digest',
    }.entries) {
      expect(
        () => AutomationScheduleDetail.fromResponse(
          _scheduleResponseWithPolicyLease(mutation.key, mutation.value),
        ),
        throwsFormatException,
        reason: 'PolicyLease ${mutation.key} must fail closed.',
      );
    }

    for (final missing in const [
      'consumedAt',
      'consumptionReceiptId',
      'consumptionReceiptSha256',
    ]) {
      expect(
        () => AutomationScheduleDetail.fromResponse(
          _scheduleResponseWithPolicyLease(missing, null),
        ),
        throwsFormatException,
        reason: 'A consumed PolicyLease requires $missing.',
      );
    }

    final issuedWithReceipt = _scheduleResponseWithPolicyLease(
      'status',
      'issued',
    );
    expect(
      () => AutomationScheduleDetail.fromResponse(issuedWithReceipt),
      throwsFormatException,
    );
    final consumedAtExpiry = _scheduleResponseWithPolicyLease(
      'consumedAt',
      '2026-09-22T03:15:00.000Z',
    );
    expect(
      () => AutomationScheduleDetail.fromResponse(consumedAtExpiry),
      throwsFormatException,
    );
    final missingBindingIndex = _scheduleResponseWithPolicyLease(
      'bindingIndex',
      null,
    );
    expect(
      () => AutomationScheduleDetail.fromResponse(missingBindingIndex),
      throwsFormatException,
    );
    final malformedOutcomes = _scheduleResponse();
    final malformedPolicy = Map<String, dynamic>.from(
      malformedOutcomes['policyLeases']! as Map,
    )..['outcomes'] = ['not-a-record'];
    malformedOutcomes['policyLeases'] = malformedPolicy;
    expect(
      () => AutomationScheduleDetail.fromResponse(malformedOutcomes),
      throwsFormatException,
    );

    for (final status in const ['issued', 'expired']) {
      final response = _scheduleResponseWithPolicyLease('status', status);
      final policy = Map<String, dynamic>.from(
        response['policyLeases']! as Map,
      );
      final lease =
          Map<String, dynamic>.from((policy['outcomes']! as List).single as Map)
            ..['consumedAt'] = null
            ..['consumptionReceiptId'] = null
            ..['consumptionReceiptSha256'] = null;
      policy['outcomes'] = [lease];
      response['policyLeases'] = policy;
      expect(
        AutomationScheduleDetail.fromResponse(response)
            .policyLeases
            .single
            .status,
        status,
      );
    }
  });

  test(
    'controller exposes partial refresh state and completes reviewed install',
    () async {
      final repository = _ControllerRepository();
      final now = DateTime.utc(2026, 9, 19, 10);
      final controller = AutomationController(
        repository,
        canManage: true,
        mutationsAvailable: true,
        now: () => now,
      );

      await controller.refresh();
      expect(controller.snapshot.failureCount, 1);
      expect(controller.refreshedAt, now);

      final preview = await controller.previewCatalogPlugin(_plugin());
      expect(preview?.previewSha256, _previewSha);
      expect(
        repository.idempotencyKeys.single,
        startsWith('native-plugin-preview-'),
      );
      expect(await controller.installPreview(), isTrue);
      expect(controller.pluginPreview, isNull);
      expect(controller.notice, contains('installed'));
      expect(repository.pluginLoads, 1);
    },
  );

  test(
    'controller re-previews a retained imported manifest directly',
    () async {
      final repository = _ControllerRepository();
      final controller = AutomationController(
        repository,
        canManage: true,
        mutationsAvailable: true,
      );
      final imported = AutomationPlugin.fromJson({
        'pluginId': 'plugin.imported',
        'version': '1.0.0',
        'name': 'Imported Plugin',
        'catalogSource': 'installed_manifest',
        'manifestSha256': _sha,
        'installed': false,
        'status': 'uninstalled',
        'manifest': {'schemaVersion': 1, 'pluginId': 'plugin.imported'},
      });

      expect(await controller.previewCatalogPlugin(imported), isNotNull);
      expect(repository.previewedManifests, [imported.manifest]);
      expect(repository.catalogPreviews, 0);
    },
  );

  test('rejects oversized or non-object Plugin manifests locally', () {
    expect(() => parseAutomationPluginManifest('[]'), throwsFormatException);
    expect(
      () => parseAutomationPluginManifest(
        '{"schemaVersion":1,"value":"${List.filled(automationPluginManifestMaxBytes, 'x').join()}"}',
      ),
      throwsFormatException,
    );
  });
}

class _ConcurrentApiClient extends ApiClient {
  _ConcurrentApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final pending = <String, Completer<Map<String, dynamic>>>{};
  final queries = <String, Map<String, dynamic>?>{};

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) {
    queries[path] = query;
    return (pending[path] = Completer<Map<String, dynamic>>()).future;
  }

  void complete(String path, Map<String, dynamic> value) =>
      pending[path]!.complete(value);

  void fail(String path, Object error) => pending[path]!.completeError(error);
}

class _MutationApiClient extends ApiClient {
  _MutationApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  String? lastMethod, lastPath;
  Map<String, dynamic>? lastData, lastHeaders;

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    _record('POST', path, data, headers);
    return path == NativePaths.pluginsPreview
        ? _previewResponse()
        : _mutationResponse();
  }

  @override
  Future<Map<String, dynamic>> patchJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    _record('PATCH', path, data, headers);
    return _mutationResponse();
  }

  @override
  Future<Map<String, dynamic>> deleteJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
  }) async {
    _record('DELETE', path, data, headers);
    return _mutationResponse();
  }

  void _record(
    String method,
    String path,
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  ) {
    lastMethod = method;
    lastPath = path;
    lastData = data;
    lastHeaders = headers;
  }
}

class _ScheduleApiClient extends ApiClient {
  _ScheduleApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  String? path;

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    this.path = path;
    return _scheduleResponse();
  }
}

class _ControllerRepository implements AutomationRepository {
  final idempotencyKeys = <String>[];
  final previewedManifests = <AutomationJson>[];
  int catalogPreviews = 0;
  int pluginLoads = 0;

  @override
  Future<AutomationSnapshot> load() async => const AutomationSnapshot(
    skills: AutomationResource.ready([]),
    connections: AutomationResource.failed('Connections unavailable.'),
    mcp: AutomationResource.ready([]),
    tools: AutomationResource.ready([]),
    workflows: AutomationResource.ready([]),
    triggers: AutomationResource.ready([]),
    plugins: AutomationResource.ready(
      AutomationPluginCatalog(
        plugins: [],
        installations: [],
        storage: 'canonical_database',
        raw: {},
      ),
    ),
  );

  @override
  Future<AutomationScheduleDetail> loadSchedule(String triggerId) =>
      throw UnimplementedError();

  @override
  Future<AutomationResource<AutomationPluginCatalog>> loadPlugins() async {
    pluginLoads += 1;
    return const AutomationResource.ready(
      AutomationPluginCatalog(
        plugins: [],
        installations: [],
        storage: 'canonical_database',
        raw: {},
      ),
    );
  }

  @override
  Future<AutomationPluginPreview> previewCatalogPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  }) async {
    catalogPreviews += 1;
    idempotencyKeys.add(idempotencyKey);
    return AutomationPluginPreview.fromResponse(_previewResponse());
  }

  @override
  Future<AutomationPluginPreview> previewManifest(
    AutomationJson manifest, {
    required String idempotencyKey,
  }) async {
    previewedManifests.add(manifest);
    idempotencyKeys.add(idempotencyKey);
    return AutomationPluginPreview.fromResponse(_previewResponse());
  }

  @override
  Future<AutomationPluginMutation> installPlugin(
    AutomationPluginPreview preview, {
    required String idempotencyKey,
  }) async => AutomationPluginMutation.fromResponse(_mutationResponse());

  @override
  Future<AutomationPluginMutation> setPluginEnabled(
    AutomationPlugin plugin, {
    required bool enabled,
    required String idempotencyKey,
  }) async => AutomationPluginMutation.fromResponse(_mutationResponse());

  @override
  Future<AutomationPluginMutation> uninstallPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  }) async => AutomationPluginMutation.fromResponse(_mutationResponse());
}

AutomationPlugin _plugin() => AutomationPlugin.fromJson({
  'pluginId': 'plugin.test',
  'version': '1.0.0',
  'name': 'Test Plugin',
  'description': 'A test declarative Plugin.',
  'publisher': {'name': 'Test'},
  'manifestSha256': _sha,
  'installed': true,
  'status': 'enabled',
  'installationId': 'plugin-installation:test-111111',
  'revision': 4,
  'componentCounts': {'skills': 1, 'mcpTemplates': 0, 'workflowTemplates': 0},
  'manifest': {'schemaVersion': 1},
});

Map<String, dynamic> _previewResponse() => {
  'preview': {
    'previewId': 'plugin-preview:test-111111',
    'pluginId': 'plugin.test',
    'pluginVersion': '1.0.0',
    'name': 'Test Plugin',
    'manifestSha256': _sha,
    'previewSha256': _previewSha,
    'effects': ['Creates one Skill.'],
    'limitations': ['Creates no credentials.'],
    'expiresAt': '2099-09-19T10:15:00.000Z',
  },
  'manifest': {'schemaVersion': 1},
};

Map<String, dynamic> _scheduleResponse() => {
  'trigger': {
    'id': 'trigger/one',
    'name': 'Morning briefing',
    'status': 'active',
    'source': 'schedule',
    'workflowMode': 'orchestrate',
  },
  'preview': {
    'occurrences': ['2026-09-23T03:00:00.000Z'],
  },
  'occurrences': [
    {
      'id': _occurrenceId,
      'kind': 'scheduled',
      'status': 'completed',
      'scheduledFor': '2026-09-22T03:00:00.000Z',
      'workflowRunId': 'workflow-one',
      'failureCode': null,
      'attemptCount': 1,
      'authoritySha256': _sha,
      'updatedAt': '2026-09-22T03:05:00.000Z',
    },
  ],
  'receipts': [
    {
      'id': _receiptId,
      'occurrenceId': _occurrenceId,
      'status': 'completed',
      'receiptSha256': _previewSha,
      'stateSha256': _sha,
      'recordedAt': '2026-09-22T03:05:00.000Z',
    },
  ],
  'policyLeases': {
    'version': 'scheduled-policy-lease-outcomes:1',
    'available': true,
    'contentIncluded': false,
    'outcomes': [
      {
        'leaseId': _leaseId,
        'leaseSha256': _sha,
        'occurrenceId': _occurrenceId,
        'executionId': 'execution-one',
        'toolId': 'calendar.events.create',
        'status': 'consumed',
        'bindingIndex': 0,
        'bindingSha256': _previewSha,
        'toolContractSha256': _sha,
        'policySha256': _previewSha,
        'influenceManifestSha256': _sha,
        'issuedAt': '2026-09-22T03:00:00.000Z',
        'expiresAt': '2026-09-22T03:15:00.000Z',
        'consumedAt': '2026-09-22T03:01:00.000Z',
        'consumptionReceiptId': _consumptionReceiptId,
        'consumptionReceiptSha256': _sha,
        'contentIncluded': false,
        'leaseGrantsAuthority': false,
      },
    ],
  },
};

Map<String, dynamic> _scheduleResponseWithOccurrence(
  String key,
  Object? value,
) {
  final response = _scheduleResponse();
  final occurrence = Map<String, dynamic>.from(
    (response['occurrences']! as List).single as Map,
  )..[key] = value;
  response['occurrences'] = [occurrence];
  return response;
}

Map<String, dynamic> _scheduleResponseWithReceipt(String key, Object? value) {
  final response = _scheduleResponse();
  final receipt = Map<String, dynamic>.from(
    (response['receipts']! as List).single as Map,
  )..[key] = value;
  response['receipts'] = [receipt];
  return response;
}

Map<String, dynamic> _scheduleResponseWithPolicyLease(
  String key,
  Object? value,
) {
  final response = _scheduleResponse();
  final policy = Map<String, dynamic>.from(response['policyLeases']! as Map);
  final lease = Map<String, dynamic>.from(
    (policy['outcomes']! as List).single as Map,
  )..[key] = value;
  policy['outcomes'] = [lease];
  response['policyLeases'] = policy;
  return response;
}

Map<String, dynamic> _mutationResponse() => {
  'installation': {
    'installationId': 'plugin-installation:test-111111',
    'pluginId': 'plugin.test',
    'name': 'Test Plugin',
    'state': 'enabled',
    'revision': 5,
    'manifestSha256': _sha,
  },
  'manifest': {'schemaVersion': 1},
  'activation': {'explanation': 'Test Plugin was installed.'},
};
