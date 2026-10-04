import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_private_action_contracts.dart';

bool _maintenance(String kind) {
  memoryRequire(const ['maintenance', 'graph'].contains(kind));
  return kind == 'maintenance';
}

String deterministicOperation(String kind) =>
    _maintenance(kind) ? 'memory.maintenance.run' : 'memory.graph.rebuild';
String deterministicContract(String kind) => _maintenance(kind)
    ? 'asael-memory-maintenance-read:1'
    : 'asael-memory-graph-rebuild-read:1';
String deterministicService(String kind) => _maintenance(kind)
    ? 'app.memory.maintenance.native'
    : 'app.memory.graph.native.rebuild';
String deterministicResource(String kind) =>
    _maintenance(kind) ? 'memory_maintenance' : 'memory_graph';
Future<String> deterministicTarget(KnowledgeOwner owner, String kind) async =>
    'private-memory-action:${await memorySha({'scope': privateActionScope(owner), 'operation': deterministicOperation(kind)})}';
Future<String> deterministicPolicy(String kind) => memorySha(
  _maintenance(kind)
      ? {
          'version': 1,
          'maximumEligibleMemories': 500,
          'purposesUnchanged': true,
          'policy': {
            'version': 1,
            'duplicateRateTarget': 0.01,
            'deduplication': {
              'match': 'normalized_exact_claim',
              'canonicalOrder': [
                'pinned',
                'confidence',
                'usage',
                'oldest',
                'id',
              ],
              'disposition': 'reversible_archive',
              'pinnedRecordsAreProtected': true,
            },
            'decay': {
              'mutatesHistoricalTruth': false,
              'minimumMultiplier': 0.35,
              'pinnedMultiplier': 1.35,
              'halfLifeDaysByTier': {
                'working': 3,
                'episodic': 30,
                'semantic': 180,
                'procedural': 365,
                'preference': 365,
                'decision': 365,
                'commitment': 90,
                'summary': 90,
              },
            },
            'promotion': {
              'sourceTier': 'episodic',
              'targetTier': 'procedural',
              'reviewRequired': true,
              'minimumVerifiedOccurrences': 2,
              'exactClaimRequired': true,
            },
            'archive': {
              'reversible': true,
              'separateFromDeletion': true,
              'excludedFromRetrieval': true,
            },
          },
        }
      : {
          'version': 1,
          'algorithm': 'existing-private-cohort-graph:1',
          'maximumMemories': 2000,
          'maximumTraces': 1000,
          'maximumNodes': 10000,
          'maximumEdges': 20000,
          'sources': 'active-unarchived-current-private-memory-and-traces-wholly-within-it',
        },
);
KnowledgeJson _pin(Object? value, String kind) {
  final maintenance = _maintenance(kind);
  final pin = privateActionObject(
    value,
    maintenance
        ? 'policyVersion eligibleMemoryCount inventorySha256 planSha256 policySha256 reviewSha256'
        : 'memoryCount traceCount sourceManifestSha256 graphPolicySha256 reviewSha256',
  );
  if (maintenance) {
    memoryRequire(pin['policyVersion'] == 1);
    privateActionCount(pin['eligibleMemoryCount'], 500);
  } else {
    privateActionCount(pin['memoryCount'], 2000);
    privateActionCount(pin['traceCount'], 1000);
  }
  for (final field
      in maintenance
          ? ['inventorySha256', 'planSha256', 'policySha256', 'reviewSha256']
          : ['sourceManifestSha256', 'graphPolicySha256', 'reviewSha256']) {
    memoryHash(pin[field]);
  }
  return pin;
}

Future<void> verifyDeterministicPin(Object? value, String kind) async {
  final pin = _pin(value, kind);
  memoryRequire(
    pin['reviewSha256'] == await memorySha({...pin}..remove('reviewSha256')) &&
        pin[_maintenance(kind) ? 'policySha256' : 'graphPolicySha256'] ==
            await deterministicPolicy(kind),
  );
}

void validateDeterministicRequest(KnowledgeJson body, String? id, String kind) {
  privateActionObject(body, 'contract review');
  memoryRequire(
    body['contract'] ==
            (_maintenance(kind)
                ? 'asael-memory-maintenance-run:1'
                : 'asael-memory-graph-rebuild:1') &&
        id != null &&
        RegExp(r'^private-memory-action:[a-f0-9]{64}$').hasMatch(id),
  );
  _pin(body['review'], kind);
}

Future<KnowledgeJson> deterministicIntent(
  MemorySubmission sent,
  String kind,
) async => {
  'contract': 'asael-private-memory-action-intent:1',
  'operation': deterministicOperation(kind),
  'scope': privateActionScope(sent.owner),
  'resourceId': await deterministicTarget(sent.owner, kind),
  'keySha256': await privateActionKey(sent),
  'request': sent.body,
};

class KnowledgeMaintenanceReview {
  const KnowledgeMaintenanceReview(this.raw, this.kind, this.review);
  final KnowledgeJson raw, review;
  final String kind;
  bool get eligible => review['eligible'] == true;
  KnowledgeJson? get pin => review['pin'] == null
      ? null
      : knowledgeMap(review['pin'], 'Private maintenance review');
  KnowledgeJson get decisionBody => {
    'contract': _maintenance(kind)
        ? 'asael-memory-maintenance-run:1'
        : 'asael-memory-graph-rebuild:1',
    'review': pin,
  };
  static Future<KnowledgeMaintenanceReview> parse(
    Object? value,
    KnowledgeOwner owner,
    String kind,
  ) async {
    final maintenance = _maintenance(kind),
        row = privateActionObject(
          value,
          'contract scope review serviceReceipt',
        );
    final review = privateActionObject(
      row['review'],
      maintenance
          ? 'eligible reason excludedMemoryCount pin'
          : 'eligible reason pin',
    );
    memoryRequire(
      review['eligible'] is bool &&
          (review['reason'] == null ||
              const [
                'scope_too_large',
                'write_permission_required',
              ].contains(review['reason'])) &&
          review['eligible'] ==
              (review['reason'] == null && review['pin'] != null),
    );
    if (maintenance) {
      privateActionCount(review['excludedMemoryCount'], 9007199254740991);
    }
    if (review['pin'] != null) {
      await verifyDeterministicPin(review['pin'], kind);
    }
    await privateActionReceipt(
      row,
      owner,
      contract: deterministicContract(kind),
      service: '${deterministicService(kind)}.review',
      resourceType: deterministicResource(kind),
      count: 1,
    );
    return KnowledgeMaintenanceReview(
      freezeKnowledgeJson(row) as KnowledgeJson,
      kind,
      freezeKnowledgeJson(review) as KnowledgeJson,
    );
  }
}

class KnowledgeMaintenanceRead {
  const KnowledgeMaintenanceRead(this.raw, this.acceptance);
  final KnowledgeJson raw;
  final KnowledgeJson? acceptance;
  static Future<KnowledgeMaintenanceRead> parse(
    Object? value,
    KnowledgeOwner owner,
    String kind, {
    required String keyHash,
    MemorySubmission? sent,
    bool mutation = false,
  }) async {
    final maintenance = _maintenance(kind),
        row = privateActionObject(
          value,
          'contract scope acceptance serviceReceipt${mutation ? ' replayed' : ''}',
        );
    memoryHash(keyHash);
    if (mutation) {
      memoryRequire(
        sent != null && row['replayed'] is bool && row['acceptance'] != null,
      );
    }
    final accepted = row['acceptance'] == null
        ? null
        : privateActionObject(
            row['acceptance'],
            'contract id operation scope resourceId keySha256 requestSha256 reviewSha256 acceptedAt result acceptanceSha256',
          );
    if (accepted != null) {
      final scope = privateActionScope(owner);
      for (final field in [
        'keySha256',
        'requestSha256',
        'reviewSha256',
        'acceptanceSha256',
      ]) {
        memoryHash(accepted[field]);
      }
      privateActionInstant(accepted['acceptedAt']);
      memoryRequire(
        accepted['contract'] ==
                (maintenance
                    ? 'asael-memory-maintenance-acceptance:1'
                    : 'asael-memory-graph-rebuild-acceptance:1') &&
            accepted['operation'] == deterministicOperation(kind) &&
            privateActionSame(accepted['scope'], scope) &&
            accepted['keySha256'] == keyHash &&
            accepted['id'] ==
                'private-action-acceptance:${await memorySha({'scope': scope, 'keySha256': keyHash})}' &&
            accepted['resourceId'] == await deterministicTarget(owner, kind) &&
            accepted['acceptanceSha256'] ==
                await memorySha({...accepted}..remove('acceptanceSha256')),
      );
      final result = privateActionObject(
        accepted['result'],
        maintenance
            ? 'policyVersion scanned eligible exactDuplicateGroups autoArchivedDuplicates pinnedDuplicateConflicts promotionReviewsCreated expiredArchived duplicateRateBefore duplicateRateAfter duplicateRateTarget'
            : 'memoryCount traceCount nodeCount edgeCount',
      );
      if (maintenance) {
        memoryRequire(
          result['policyVersion'] == 1 && result['duplicateRateTarget'] == 0.01,
        );
        for (final field in [
          'scanned',
          'eligible',
          'autoArchivedDuplicates',
          'pinnedDuplicateConflicts',
          'expiredArchived',
        ]) {
          privateActionCount(result[field], 500);
        }
        for (final field in [
          'exactDuplicateGroups',
          'promotionReviewsCreated',
        ]) {
          privateActionCount(result[field], 250);
        }
        for (final field in ['duplicateRateBefore', 'duplicateRateAfter']) {
          final rate = result[field];
          memoryRequire(rate is num && rate.isFinite && rate >= 0 && rate <= 1);
        }
      } else {
        for (final entry in const {
          'memoryCount': 2000,
          'traceCount': 1000,
          'nodeCount': 10000,
          'edgeCount': 20000,
        }.entries) {
          privateActionCount(result[entry.key], entry.value);
        }
      }
      if (sent != null) {
        await verifyDeterministicPin(sent.body['review'], kind);
        final pin = sent.body['review'] as Map;
        memoryRequire(
          sent.id == accepted['resourceId'] &&
              keyHash == await privateActionKey(sent) &&
              accepted['requestSha256'] ==
                  await memorySha(await deterministicIntent(sent, kind)) &&
              accepted['reviewSha256'] == pin['reviewSha256'],
        );
        memoryRequire(
          maintenance
              ? result['scanned'] == pin['eligibleMemoryCount']
              : result['memoryCount'] == pin['memoryCount'] &&
                    result['traceCount'] == pin['traceCount'],
        );
      }
    }
    await privateActionReceipt(
      row,
      owner,
      contract: deterministicContract(kind),
      service: '${deterministicService(kind)}.${mutation ? 'run' : 'get'}',
      resourceType: deterministicResource(kind),
      count: accepted == null ? 0 : 1,
      sent: mutation ? sent : null,
      purpose: maintenance
          ? 'api.memory.maintenance.run'
          : 'api.memory.graph.rebuild',
      eventContract: maintenance
          ? 'memory-maintenance-native-events.v1'
          : 'memory-graph-native-events.v1',
    );
    return KnowledgeMaintenanceRead(
      freezeKnowledgeJson(row) as KnowledgeJson,
      accepted == null ? null : freezeKnowledgeJson(accepted) as KnowledgeJson,
    );
  }
}

abstract interface class KnowledgeMaintenanceRepository {
  bool supportsMaintenance(String kind);
  Future<KnowledgeMaintenanceReview> reviewMaintenance(String kind);
  Future<KnowledgeMaintenanceRead> readMaintenance(
    String kind,
    String keySha256,
  );
}
