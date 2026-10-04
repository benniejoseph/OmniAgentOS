import 'package:asael/features/security/security_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security_test_support.dart';

SecurityAccessContext _context(Map<String, dynamic> json) =>
    SecurityAccessContext.parse(
      json,
      tenantId: 'tenant-a',
      actorId: 'owner@example.test',
      userId: securityUser,
      role: 'admin',
    );
void main() {
  test('authoritative RBAC array and exact mobile identity project only explanatory rules', () {
    final context = _context(securityContextJson());
    expect(context.rules.map((rule) => rule.action), [
      'read.security',
      'read.context',
    ]);
    expect(context.rules.first.roles, [
      SecurityRole.admin,
      SecurityRole.system,
    ]);
    expect(context.userId, securityUser);
    final malformed = securityContextJson();
    (malformed['policy'] as Map)['rbacRules'] = {
      'admin': ['read.security'],
    };
    expect(() => _context(malformed), throwsFormatException);
  });
  for (final field in ['tenantId', 'actorId', 'role', 'source', 'userId']) {
    test(
      'context $field disagreement rejects the entire admitted identity',
      () {
        final json = securityContextJson(), context = json['context'] as Map;
        if (field == 'userId') {
          (context['auth'] as Map)[field] =
              '22222222-2222-4222-8222-222222222222';
        } else {
          context[field] = field == 'role' ? 'operator' : 'other';
        }
        expect(() => _context(json), throwsA(isA<SecurityIdentityMismatch>()));
      },
    );
  }
  test(
    'unsupported context role is an identity refusal before enum decoding',
    () {
      final json = securityContextJson();
      (json['context'] as Map)['role'] = 'owner';
      expect(() => _context(json), throwsA(isA<SecurityIdentityMismatch>()));
    },
  );
  test('tenant audit retains other actors and separates displayed rows from 200-record aggregate', () {
    final value = SecurityAudits.parse(
      securityAuditsJson(),
      tenantId: 'tenant-a',
    );
    expect(value.rows.single.actorId, 'other@example.test');
    expect(value.rows.single.decision, SecurityDecision.deny);
    expect(value.total, 120);
    expect(value.rows, hasLength(1));
    final independent = securityAuditsJson();
    independent['stats'] = {
      'total': 0,
      'byDecision': <String, dynamic>{},
      'byRole': <String, dynamic>{},
    };
    expect(SecurityAudits.parse(independent, tenantId: 'tenant-a').total, 0);
    final foreign = securityAuditsJson();
    foreign['records'] = [securityAuditJson(tenant: 'tenant-other')];
    expect(
      () => SecurityAudits.parse(foreign, tenantId: 'tenant-a'),
      throwsFormatException,
    );
  });
  for (final malformed in [
    'decision',
    'role',
    'partition',
    'role partition',
    'limit',
    'duplicate',
    'date',
  ]) {
    test('audit rejects $malformed evidence', () {
      final json = securityAuditsJson(),
          row = (json['records'] as List).single as Map,
          stats = json['stats'] as Map;
      switch (malformed) {
        case 'decision':
          row['decision'] = 'approved';
        case 'role':
          row['actorRole'] = 'owner';
        case 'partition':
          (stats['byDecision'] as Map)['allow'] = 114;
        case 'role partition':
          (stats['byRole'] as Map)['admin'] = 111;
        case 'limit':
          json['records'] = List.generate(
            51,
            (index) => securityAuditJson(id: 'audit-$index'),
          );
        case 'duplicate':
          json['records'] = [securityAuditJson(), securityAuditJson()];
        case 'date':
          row['createdAt'] = '2026-02-30T02:00:00.000Z';
      }
      expect(
        () => SecurityAudits.parse(json, tenantId: 'tenant-a'),
        throwsFormatException,
      );
    });
  }
  test('isolation preserves catalog assessment, independent failed evaluation and branch-specific child counts', () {
    final passing = SecurityIsolation.parse(
      securityIsolationJson(),
      tenantId: 'tenant-a',
    );
    expect(passing.assessment, SecurityAssessment.passing);
    expect(passing.latestEval!.runStatus, SecurityRunStatus.completed);
    expect(passing.latestEval!.resultStatus, SecurityResultStatus.fail);
    final degraded = SecurityIsolation.parse(
      securityIsolationJson(unclassified: true),
      tenantId: 'tenant-a',
    );
    expect(degraded.failing, 0);
    expect(degraded.assessment, SecurityAssessment.degraded);
    expect(degraded.unclassified, ['omni_unclassified']);
    final failed = SecurityIsolation.parse(
      securityIsolationJson(failedChild: true),
      tenantId: 'tenant-a',
    );
    expect(failed.expectedChildren, 1);
    expect(failed.protectedChildren, 0);
    final noDatabase = SecurityIsolation.parse(
      securityIsolationJson(configured: false),
      tenantId: 'tenant-a',
    );
    expect(noDatabase.assessment, SecurityAssessment.notConfigured);
    expect(noDatabase.tables, hasLength(2));
    expect(noDatabase.expectedChildren, 1);
    expect(noDatabase.protectedChildren, 0);
    final absent = securityIsolationJson();
    (absent['report'] as Map).remove('latestEval');
    expect(
      SecurityIsolation.parse(absent, tenantId: 'tenant-a').latestEval,
      isNull,
    );
  });
  for (final malformed in [
    'tenant',
    'pass boolean',
    'count',
    'issues',
    'children',
    'duplicate',
    'unclassified',
    'date',
    'assessment',
  ]) {
    test('isolation rejects inconsistent $malformed evidence', () {
      final json = securityIsolationJson(),
          report = json['report'] as Map,
          summary = report['summary'] as Map,
          rows = report['tables'] as List;
      switch (malformed) {
        case 'tenant':
          report['tenantId'] = 'other';
        case 'pass boolean':
          (rows.first as Map)['policyPresent'] = false;
        case 'count':
          summary['protectedTables'] = 1;
        case 'issues':
          summary['rlsDisabled'] = ['omni_items'];
        case 'children':
          summary['childTables'] = 0;
        case 'duplicate':
          rows[1] = rows[0];
        case 'unclassified':
          summary['unclassifiedTables'] = ['omni_unclassified'];
        case 'date':
          report['checkedAt'] = '2026-13-01T00:00:00Z';
        case 'assessment':
          report['status'] = 'secure';
      }
      expect(
        () => SecurityIsolation.parse(json, tenantId: 'tenant-a'),
        throwsFormatException,
      );
    });
  }
  test(
    'retention requires all18 bounded day windows and consistent configuration',
    () {
      final value = SecurityRetention.parse(securityRetentionJson());
      expect(value.days, hasLength(18));
      expect(value.days.values, everyElement(30));
      expect(value.automaticSweep, isTrue);
      final local = SecurityRetention.parse(
        securityRetentionJson(postgres: false),
      );
      expect(local.backend, SecurityRetentionBackend.boundedLocal);
      expect(local.automaticSweep, isFalse);
      for (final window in SecurityRetentionWindow.values) {
        for (final bad in [null, 0, 3651, 1.5]) {
          final json = securityRetentionJson();
          (json['policy'] as Map)[window.name] = bad;
          expect(() => SecurityRetention.parse(json), throwsFormatException);
        }
      }
      final contradiction = securityRetentionJson();
      contradiction['automaticSweep'] = false;
      expect(
        () => SecurityRetention.parse(contradiction),
        throwsFormatException,
      );
    },
  );
}
