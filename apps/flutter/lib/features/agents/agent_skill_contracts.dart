import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/network/native_workspace_access.dart';
import 'specialist_contracts.dart';

const agentSkillReadContract = 'asael-agent-skill-read:1';
const agentSkillCategories = [
  'research',
  'creation',
  'analysis',
  'memory',
  'automation',
  'personal',
];
const _skillFields = {
  'name',
  'description',
  'instructions',
  'category',
  'status',
  'toolIds',
  'tags',
  'knowledgeTags',
};

SpecialistJson agentSkillExact(Object? value, Set<String> fields) {
  final row = specialistMap(value);
  specialistRequire(
    row.length == fields.length && row.keys.every(fields.contains),
    'The catalog response has an unexpected shape.',
  );
  return row;
}

String agentSkillText(Object? value, int maximum, {int minimum = 1}) {
  specialistRequire(
    value is String &&
        value.length >= minimum &&
        value.length <= maximum &&
        value == value.trim(),
  );
  return value as String;
}

String agentSkillId(Object? value) {
  final id = agentSkillText(value, 200);
  specialistRequire(RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(id));
  return id;
}

String agentSkillHash(Object? value) {
  final text = agentSkillText(value, 64);
  specialistRequire(RegExp(r'^[a-f0-9]{64}$').hasMatch(text));
  return text;
}

int _integer(Object? value, {int minimum = 1, int maximum = 2147483647}) {
  specialistRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

DateTime _at(Object? value) {
  final text = agentSkillText(value, 40), parsed = DateTime.tryParse(text);
  specialistRequire(
    parsed != null &&
        RegExp(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$').hasMatch(text) &&
        parsed.toUtc().toIso8601String() == text,
  );
  return parsed!;
}

List<String> _strings(
  Object? value,
  int count,
  int width, {
  int minimum = 1,
  bool ids = false,
}) {
  specialistRequire(value is List && value.length <= count);
  final values = (value as List)
      .map(
        (item) => ids
            ? agentSkillId(item)
            : agentSkillText(item, width, minimum: minimum),
      )
      .toList();
  specialistRequire(values.toSet().length == values.length);
  return values;
}

Future<String> agentSkillRawSha(String value) async =>
    (await Sha256().hash(utf8.encode(value))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();

class AgentSkillOwner {
  AgentSkillOwner(
    this.tenantId,
    this.actorId,
    this.canonicalActorId,
    this.role,
    this.apiBaseUrl,
  ) {
    agentSkillText(tenantId, 240);
    agentSkillText(actorId, 240);
    specialistRequire(
      RegExp(
        r'^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
      ).hasMatch(canonicalActorId),
    );
    specialistRequire(['viewer', 'operator', 'admin', 'system'].contains(role));
  }
  factory AgentSkillOwner.fromAccess(NativeWorkspaceAccess access) =>
      AgentSkillOwner(
        access.authority.tenantId,
        access.authority.actorId,
        'actor:${access.authority.canonicalUserId.toLowerCase()}',
        access.authority.role,
        access.authority.apiBaseUrl,
      );
  final String tenantId, actorId, canonicalActorId, role, apiBaseUrl;
  SpecialistJson get scope => {
    'tenantId': tenantId,
    'ownerActorId': actorId,
    'canonicalActorId': canonicalActorId,
  };
  void requireScope(Object? value) {
    final row = agentSkillExact(value, {
      'tenantId',
      'ownerActorId',
      'canonicalActorId',
    });
    specialistRequire(
      specialistCanonical(row) == specialistCanonical(scope),
      'This result belongs to another catalog owner.',
    );
  }

  Future<String> authority({AgentSkillIntent? intent}) async => specialistSha({
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'tenantId': tenantId,
    'actorId': actorId,
    'role': role,
    'executionScope': intent == null
        ? null
        : {
            'version': 1,
            'tenantId': tenantId,
            'initiatingActorId': actorId,
            'executingPrincipalType': 'user',
            'executingPrincipalId': actorId,
            'workspaceId': null,
            'projectId': null,
            'missionId': null,
            'delegationId': null,
            'contextGrantIds': <String>[],
            'capabilityGrantIds': <String>[],
            'correlationId': intent.key.length <= 256
                ? intent.key
                : 'idempotency-key:${await specialistSha(intent.key)}',
            'causationId': intent.resourceId ?? 'skills:create',
            'purpose': switch (intent.operation) {
              'agent.delete' => 'agent.move_to_trash',
              'skill.delete' => 'skill.move_to_trash',
              final operation => operation,
            },
          },
  });
}

SpecialistJson validateAgentSkillInput(Object? value, {bool patch = false}) {
  final row = specialistMap(value);
  specialistRequire(
    row.isNotEmpty &&
        row.keys.every(_skillFields.contains) &&
        (patch || row.length == _skillFields.length),
  );
  for (final (key, min, max) in [
    ('name', 2, 120),
    ('description', 2, 500),
    ('instructions', 10, 12000),
  ]) {
    if (row.containsKey(key)) {
      agentSkillText(row[key], max, minimum: min);
    }
  }
  if (row.containsKey('category')) {
    specialistRequire(agentSkillCategories.contains(row['category']));
  }
  if (row.containsKey('status')) {
    specialistRequire(['active', 'disabled'].contains(row['status']));
  }
  for (final key in ['toolIds', 'tags', 'knowledgeTags']) {
    if (row.containsKey(key)) {
      _strings(
        row[key],
        key == 'toolIds' ? 40 : 30,
        key == 'toolIds' ? 120 : 100,
      );
    }
  }
  return specialistFreeze(row);
}

SpecialistJson _pin(Object? value) {
  final pin = agentSkillExact(value, {
    'operation',
    'resourceType',
    'resourceId',
    'resourceVersion',
    'resourceSha256',
    'impactSha256',
  });
  specialistRequire(
    ['agent.delete', 'skill.update', 'skill.delete'].contains(pin['operation']),
  );
  final agent = pin['operation'] == 'agent.delete';
  specialistRequire(
    pin['resourceType'] == (agent ? 'custom_agent' : 'agent_skill'),
  );
  agentSkillId(pin['resourceId']);
  if (agent) {
    specialistRequire(pin['resourceVersion'] == null);
  } else {
    _integer(pin['resourceVersion']);
  }
  agentSkillHash(pin['resourceSha256']);
  agentSkillHash(pin['impactSha256']);
  return pin;
}

Future<void> _preview(Object? value, SpecialistJson pin) async {
  final row = agentSkillExact(value, {
    'version',
    'action',
    'trashId',
    'resourceType',
    'resourceId',
    'lifecycleRevision',
    'targetSha256',
    'effectSummary',
    'reversible',
    'issuedAt',
    'expiresAt',
    'previewSha256',
  });
  specialistRequire(
    row['version'] == 'p9.3-trash-preview:1' &&
        row['action'] == 'trash' &&
        row['trashId'] == null &&
        row['lifecycleRevision'] == 0 &&
        row['resourceType'] == pin['resourceType'] &&
        row['resourceId'] == pin['resourceId'] &&
        row['reversible'] is bool,
  );
  agentSkillText(row['effectSummary'], 500);
  final issued = _at(row['issuedAt']), expires = _at(row['expiresAt']);
  specialistRequire(
    expires.isAfter(issued) && row['targetSha256'] == await specialistSha(pin),
  );
  final body = {...row}..remove('previewSha256');
  specialistRequire(
    agentSkillHash(row['previewSha256']) == await specialistSha(body),
  );
}

Future<void> _service(
  SpecialistJson value,
  AgentSkillOwner owner, {
  required String operation,
  required String resource,
  required String action,
  AgentSkillIntent? intent,
  required int count,
}) async {
  final row = agentSkillExact(value['serviceReceipt'], {
    'schemaVersion',
    'receiptKind',
    'boundaryVersion',
    'operation',
    'action',
    'resourceType',
    'accessMode',
    'eventContract',
    'authoritySha256',
    'idempotencyKeySha256',
    'outcomeSha256',
    'resourceCount',
    'occurredAt',
    'receiptSha256',
  });
  specialistRequire(
    row['schemaVersion'] == 1 &&
        row['receiptKind'] == 'app_service_receipt' &&
        row['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        row['operation'] == operation &&
        row['action'] == action &&
        row['resourceType'] == resource &&
        row['accessMode'] == (intent == null ? 'read' : 'mutation') &&
        row['eventContract'] ==
            (intent == null
                ? 'read_only:no_domain_mutation'
                : 'agent-skill-native-events.v1') &&
        row['resourceCount'] == count &&
        row['idempotencyKeySha256'] == intent?.keySha256,
  );
  _at(row['occurredAt']);
  final receiptBody = {...row}..remove('receiptSha256'),
      body = {...value}..remove('serviceReceipt');
  specialistRequire(
    agentSkillHash(row['receiptSha256']) == await specialistSha(receiptBody) &&
        agentSkillHash(row['outcomeSha256']) == await specialistSha(body) &&
        agentSkillHash(row['authoritySha256']) ==
            await owner.authority(intent: intent),
    'The service receipt does not bind this exact decision and current account.',
  );
}

class AgentSkillReview {
  AgentSkillReview._(this.raw);
  final SpecialistJson raw;
  SpecialistJson get pin => specialistMap(raw['pin']);
  SpecialistJson get resource => specialistMap(
    raw[pin['resourceType'] == 'custom_agent' ? 'agent' : 'skill'],
  );
  SpecialistJson? get preview =>
      raw['preview'] == null ? null : specialistMap(raw['preview']);
  bool get unexpired =>
      preview == null ||
      _at(preview!['expiresAt']).isAfter(DateTime.now().toUtc());
  static Future<AgentSkillReview> parse(
    Object? value,
    AgentSkillOwner owner,
    String operation,
    String id,
  ) async {
    final response = agentSkillExact(value, {
      'contract',
      'scope',
      'review',
      'serviceReceipt',
    });
    specialistRequire(response['contract'] == agentSkillReadContract);
    owner.requireScope(response['scope']);
    final row = agentSkillExact(response['review'], {
          'pin',
          'agent',
          'skill',
          'affectedAgents',
          'agentLifecycle',
          'preview',
        }),
        pin = _pin(row['pin']);
    specialistRequire(pin['operation'] == operation && pin['resourceId'] == id);
    final agent = operation == 'agent.delete';
    specialistRequire(row[agent ? 'skill' : 'agent'] == null);
    final resource = specialistMap(row[agent ? 'agent' : 'skill']);
    final recordFields = {
      'id',
      'tenantId',
      'actorId',
      'slug',
      'createdAt',
      'updatedAt',
    };
    if (!agent) {
      agentSkillExact(resource, {...recordFields, ..._skillFields, 'version'});
      validateAgentSkillInput({
        for (final field in _skillFields) field: resource[field],
      });
      specialistRequire(
        _integer(resource['version']) == pin['resourceVersion'] &&
            row['agentLifecycle'] == null,
      );
    } else {
      agentSkillExact(resource, {
        ...recordFields,
        'name',
        'role',
        'description',
        'instructions',
        'persona',
        'status',
        'accent',
        'modelPolicy',
        'autonomy',
        'approvalPolicy',
        'memoryScope',
        'skillIds',
        'toolIds',
      });
      for (final (field, maximum) in [
        ('name', 120),
        ('role', 120),
        ('description', 700),
        ('instructions', 12000),
      ]) {
        agentSkillText(
          resource[field],
          maximum,
          minimum: field == 'instructions' ? 10 : 2,
        );
      }
      specialistRequire(
        ['ready', 'learning', 'paused'].contains(resource['status']) &&
            [
              'emerald',
              'blue',
              'amber',
              'violet',
              'rose',
            ].contains(resource['accent']) &&
            [
              'auto',
              'openai_fast',
              'openai_reasoning',
              'gemini_fast',
              'anthropic_fast',
              'anthropic_reasoning',
            ].contains(resource['modelPolicy']) &&
            ['assist', 'governed', 'execute'].contains(resource['autonomy']) &&
            [
              'always',
              'risk_based',
              'read_only',
            ].contains(resource['approvalPolicy']) &&
            ['session', 'project', 'all'].contains(resource['memoryScope']),
      );
      _strings(resource['skillIds'], 8, 120);
      _strings(resource['toolIds'], 50, 120);
      final persona = agentSkillExact(resource['persona'], {
        'schemaVersion',
        'charter',
        'operatingStyle',
        'voice',
        'visualIdentity',
        'allowedDomains',
        'escalationBehavior',
        'successMeasures',
      });
      specialistRequire(persona['schemaVersion'] == 1);
      for (final (field, maximum) in [
        ('charter', 2000),
        ('operatingStyle', 2000),
        ('voice', 500),
        ('visualIdentity', 500),
        ('escalationBehavior', 1000),
      ]) {
        agentSkillText(persona[field], maximum, minimum: 2);
      }
      for (final (field, maximum) in [
        ('allowedDomains', 120),
        ('successMeasures', 200),
      ]) {
        final values = _strings(persona[field], 20, maximum, minimum: 2);
        specialistRequire(
          values.map((item) => item.toLowerCase()).toSet().length ==
              values.length,
        );
      }
      final lifecycle = agentSkillExact(row['agentLifecycle'], {
        'releaseState',
        'releaseRevision',
        'activeDefinitionVersion',
        'latestDefinitionVersion',
        'principalGeneration',
        'principalState',
      });
      specialistRequire(
        ['active', 'retired'].contains(lifecycle['releaseState']) &&
            ['held', 'active', 'revoked'].contains(lifecycle['principalState']),
      );
      for (final key in [
        'releaseRevision',
        'activeDefinitionVersion',
        'latestDefinitionVersion',
        'principalGeneration',
      ]) {
        _integer(lifecycle[key], maximum: 9007199254740991);
      }
    }
    agentSkillText(resource['slug'], 80);
    _at(resource['createdAt']);
    _at(resource['updatedAt']);
    specialistRequire(
      resource['id'] == id &&
          resource['tenantId'] == owner.tenantId &&
          resource['actorId'] == owner.actorId &&
          await specialistSha(resource) == pin['resourceSha256'],
    );
    specialistRequire(
      row['affectedAgents'] is List &&
          (row['affectedAgents'] as List).length <= 100,
    );
    final ids = <String>{};
    for (final item in row['affectedAgents'] as List) {
      final affected = agentSkillExact(item, {'id', 'name'});
      specialistRequire(ids.add(agentSkillId(affected['id'])));
      agentSkillText(affected['name'], 120);
    }
    if (operation == 'skill.update') {
      specialistRequire(row['preview'] == null);
    } else {
      await _preview(row['preview'], pin);
    }
    await _service(
      response,
      owner,
      operation: agent
          ? 'app.agents.native.delete.review'
          : 'app.skills.native.mutation.review',
      resource: pin['resourceType'] as String,
      action: 'manage.workflow',
      count: 1,
    );
    return AgentSkillReview._(specialistFreeze(row));
  }
}

class AgentSkillIntent {
  AgentSkillIntent._(this.owner, this.key, this.raw, this.requestSha256);
  final AgentSkillOwner owner;
  final String key, requestSha256;
  final SpecialistJson raw;
  String get operation => raw['operation'] as String;
  String? get resourceId => raw['resourceId'] as String?;
  String get resourceType =>
      operation == 'agent.delete' ? 'custom_agent' : 'agent_skill';
  String get keySha256 => raw['keySha256'] as String;
  SpecialistJson get request => specialistMap(raw['request']);
  String get serviceOperation => operation == 'agent.delete'
      ? 'app.agents.native.delete'
      : 'app.skills.native.${operation.split('.').last}';
  SpecialistJson toJson() => {
    'key': key,
    'role': owner.role,
    'apiBaseUrl': owner.apiBaseUrl,
    'intent': raw,
    'requestSha256': requestSha256,
  };
  static Future<AgentSkillIntent> prepare(
    AgentSkillOwner owner,
    String key,
    SpecialistJson request,
  ) async {
    specialistRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final create = request['contract'] == 'asael-skill-create:1';
    if (create) {
      agentSkillExact(request, {'contract', 'skill'});
      validateAgentSkillInput(request['skill']);
    } else if (request['contract'] == 'asael-skill-update:1') {
      agentSkillExact(request, {'contract', 'review', 'change'});
      specialistRequire(_pin(request['review'])['operation'] == 'skill.update');
      validateAgentSkillInput(request['change'], patch: true);
    } else {
      agentSkillExact(request, {'contract', 'review', 'preview'});
      specialistRequire(request['contract'] == 'asael-agent-skill-delete:1');
      final pin = _pin(request['review']);
      specialistRequire(pin['operation'] != 'skill.update');
      await _preview(request['preview'], pin);
    }
    specialistRequire(
      utf8.encode(jsonEncode(request)).length <=
          (request['contract'] == 'asael-agent-skill-delete:1' ? 16384 : 65536),
    );
    final pin = create ? null : specialistMap(request['review']);
    final raw = specialistFreeze({
      'contract': 'asael-agent-skill-intent:1',
      'scope': owner.scope,
      'operation': create ? 'skill.create' : pin!['operation'],
      'resourceId': create ? null : pin!['resourceId'],
      'keySha256': await agentSkillRawSha('${owner.tenantId}\u0000$key'),
      'request': request,
    });
    return AgentSkillIntent._(owner, key, raw, await specialistSha(raw));
  }

  static Future<AgentSkillIntent> restore(
    Object? value,
    AgentSkillOwner owner,
  ) async {
    final stored = agentSkillExact(value, {
          'key',
          'role',
          'apiBaseUrl',
          'intent',
          'requestSha256',
        }),
        raw = agentSkillExact(stored['intent'], {
          'contract',
          'scope',
          'operation',
          'resourceId',
          'keySha256',
          'request',
        });
    owner.requireScope(raw['scope']);
    specialistRequire(stored['apiBaseUrl'] == owner.apiBaseUrl);
    final original = AgentSkillOwner(
      owner.tenantId,
      owner.actorId,
      owner.canonicalActorId,
      agentSkillText(stored['role'], 20),
      owner.apiBaseUrl,
    );
    final intent = await prepare(
      original,
      agentSkillText(stored['key'], 512),
      specialistMap(raw['request']),
    );
    specialistRequire(
      specialistCanonical(raw) == specialistCanonical(intent.raw) &&
          stored['requestSha256'] == intent.requestSha256,
    );
    return intent;
  }
}

class AgentSkillAcceptance {
  AgentSkillAcceptance._(
    this.raw,
    this.response,
    this.mutation,
    this.receiptRole,
  );
  final SpecialistJson raw, response;
  final bool mutation;
  final String receiptRole;
  SpecialistJson toJson() => {
    'response': response,
    'mutation': mutation,
    'receiptRole': receiptRole,
  };
  static Future<AgentSkillAcceptance?> parse(
    Object? value,
    AgentSkillOwner owner,
    AgentSkillIntent intent, {
    required bool mutation,
  }) async {
    final response = agentSkillExact(value, {
      'contract',
      'scope',
      'acceptance',
      'serviceReceipt',
      if (mutation) 'replayed',
    });
    specialistRequire(
      response['contract'] == agentSkillReadContract &&
          (!mutation || response['replayed'] is bool),
    );
    owner.requireScope(response['scope']);
    owner.requireScope(intent.raw['scope']);
    final agent = intent.operation == 'agent.delete';
    await _service(
      response,
      owner,
      operation: mutation
          ? intent.serviceOperation
          : agent
          ? 'app.agents.native.mutations.show'
          : 'app.skills.native.mutations.show',
      resource: intent.resourceType,
      action: mutation ? 'manage.workflow' : 'read',
      intent: mutation ? intent : null,
      count: response['acceptance'] == null ? 0 : 1,
    );
    if (response['acceptance'] == null) {
      specialistRequire(!mutation);
      return null;
    }
    final row = agentSkillExact(response['acceptance'], {
      'contract',
      'id',
      'scope',
      'operation',
      'resourceType',
      'resourceId',
      'keySha256',
      'requestSha256',
      'reviewSha256',
      'beforeVersion',
      'afterVersion',
      'beforeResourceSha256',
      'afterResourceSha256',
      'affectedAgentIds',
      'trash',
      'acceptedAt',
      'acceptanceSha256',
    });
    owner.requireScope(row['scope']);
    agentSkillId(row['resourceId']);
    _at(row['acceptedAt']);
    specialistRequire(
      row['contract'] == 'asael-agent-skill-acceptance:1' &&
          row['operation'] == intent.operation &&
          row['resourceType'] == intent.resourceType &&
          row['keySha256'] == intent.keySha256 &&
          row['requestSha256'] == intent.requestSha256 &&
          row['id'] ==
              'agent-skill-acceptance:${await specialistSha({'scope': owner.scope, 'keySha256': intent.keySha256})}',
    );
    final body = {...row}..remove('acceptanceSha256');
    specialistRequire(
      agentSkillHash(row['acceptanceSha256']) == await specialistSha(body),
    );
    _strings(row['affectedAgentIds'], 100, 200, ids: true);
    if (intent.operation == 'skill.create') {
      specialistRequire(
        row['reviewSha256'] == null &&
            row['beforeVersion'] == null &&
            row['beforeResourceSha256'] == null &&
            row['afterVersion'] == 1 &&
            row['trash'] == null,
      );
      agentSkillHash(row['afterResourceSha256']);
    } else {
      final pin = specialistMap(intent.request['review']);
      specialistRequire(
        row['resourceId'] == intent.resourceId &&
            row['reviewSha256'] == await specialistSha(pin) &&
            row['beforeResourceSha256'] == pin['resourceSha256'] &&
            row['beforeVersion'] == pin['resourceVersion'],
      );
      if (intent.operation == 'skill.update') {
        specialistRequire(
          _integer(row['afterVersion']) == _integer(row['beforeVersion']) + 1 &&
              row['trash'] == null,
        );
        agentSkillHash(row['afterResourceSha256']);
      } else {
        specialistRequire(
          row['afterVersion'] == null && row['afterResourceSha256'] == null,
        );
        final trash = agentSkillExact(row['trash'], {
          'trashId',
          'previewSha256',
          'targetSha256',
          'snapshotSha256',
          'receiptSha256',
          'compensation',
        });
        specialistRequire(
          RegExp(r'^trash:[0-9a-f-]{36}$')
                  .hasMatch(agentSkillText(trash['trashId'], 42)) &&
              trash['previewSha256'] ==
                  intent.request['preview']['previewSha256'] &&
              trash['targetSha256'] == row['reviewSha256'] &&
              trash['compensation'] ==
                  (agent ? 'equivalent_action' : 'exact_restore'),
        );
        agentSkillHash(trash['snapshotSha256']);
        agentSkillHash(trash['receiptSha256']);
      }
    }
    return AgentSkillAcceptance._(
      specialistFreeze(row),
      specialistFreeze(response),
      mutation,
      owner.role,
    );
  }

  static Future<AgentSkillAcceptance> restore(
    Object? value,
    AgentSkillOwner owner,
    AgentSkillIntent intent,
  ) async {
    final stored = agentSkillExact(value, {
      'response',
      'mutation',
      'receiptRole',
    });
    specialistRequire(stored['mutation'] is bool);
    final caller = AgentSkillOwner(
      owner.tenantId,
      owner.actorId,
      owner.canonicalActorId,
      agentSkillText(stored['receiptRole'], 20),
      owner.apiBaseUrl,
    );
    final accepted = await parse(
      stored['response'],
      caller,
      intent,
      mutation: stored['mutation'] as bool,
    );
    specialistRequire(accepted != null);
    return accepted!;
  }
}
