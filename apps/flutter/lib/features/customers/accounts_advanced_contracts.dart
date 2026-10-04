import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';

enum AccountAdvancedKind {
  health('customers.health', 'Health history'),
  intelligence('customers.intelligence', 'Risks, commitments and timeline'),
  workflows('customers.workflows', 'Workflow history'),
  salesforce('customers.salesforce.status', 'Salesforce status');

  const AccountAdvancedKind(this.operation, this.label);
  final String operation, label;
}

const _factorKeys = ['adoption', 'support', 'engagement', 'commercial'];
const _workflowIds = [
  'onboarding',
  'adoption_review',
  'risk_escalation',
  'renewal_planning',
  'qbr_ebr',
  'meeting_prep_follow_up',
  'support_escalation',
  'expansion_discovery',
];
const _sfObjects = [
  'Account',
  'Contact',
  'Opportunity',
  'Case',
  'Task',
  'Event',
  'Asset',
  'Contract',
];
const _sfCreate = ['Contact', 'Task', 'Case', 'Opportunity'];
const _sfUpdate = ['Account', 'Contact', 'Task', 'Note', 'Case', 'Opportunity'];
void _bp(Object? value) => accountInt(value, max: 10000);
void _revision(Object? value, String id) {
  final text = accountText(value, 300);
  accountRequire(text.startsWith('$id:v'));
  accountInt(int.tryParse(text.substring(id.length + 2)), min: 1);
}

List<AccountJson> _rows(Object? value, int max) =>
    accountList(value, max, accountMap);
void _strings(Object? value, int max, {int length = 240, int min = 0}) {
  final rows = accountList(value, max, (value) => accountText(value, length));
  accountRequire(rows.length >= min);
}

void _evidence(Object? value) {
  final rows = _rows(value, 50);
  accountRequire(rows.isNotEmpty);
  for (final row in rows) {
    accountEvidence(row);
  }
}

class AccountAdvancedRead {
  const AccountAdvancedRead(this.kind, this.raw, this.context);
  final AccountAdvancedKind kind;
  final AccountJson raw;
  final AccountContext context;
  static Future<AccountAdvancedRead> parse(
    AccountAdvancedKind kind,
    AccountJson response,
    AccountsOwner owner,
    String workspace,
    String? selected,
  ) async {
    final context = AccountContext.parse(
      response['context'],
      workspaceId: workspace,
    );
    switch (kind) {
      case AccountAdvancedKind.health:
        accountKeys(response, [
          'context',
          'policy',
          'score',
          'history',
          'serviceReceipt',
        ]);
        await _policy(response['policy']);
        final history = _rows(response['history'], 100);
        accountUnique(
          history.map((row) => accountText(row['scoreRevisionId'])),
        );
        for (final score in [
          if (response['score'] != null) accountMap(response['score']),
          ...history,
        ]) {
          await _score(score, owner, workspace, selected!);
        }
        await accountReadReceipt(
          response,
          owner,
          'app.customer_accounts.health.show',
          'customer_health_score',
          response['score'] == null ? 0 : 1,
        );
      case AccountAdvancedKind.intelligence:
        accountKeys(response, ['context', 'intelligence', 'serviceReceipt']);
        await _intelligence(accountMap(response['intelligence']), selected!);
        await accountReadReceipt(
          response,
          owner,
          'app.customer_accounts.intelligence.show',
          'customer_success_intelligence',
          1,
        );
      case AccountAdvancedKind.workflows:
        accountKeys(response, ['context', 'pack', 'runs', 'serviceReceipt']);
        await _workflows(response, owner, workspace, selected!);
        await accountReadReceipt(
          response,
          owner,
          'app.customer_accounts.workflows.list',
          'customer_success_workflow',
          (response['runs'] as List).length,
        );
      case AccountAdvancedKind.salesforce:
        await _salesforce(response, workspace);
    }
    return AccountAdvancedRead(kind, accountFreeze(response), context);
  }
}

Future<void> _policy(Object? value) async {
  final row = accountMap(value);
  accountKeys(row, [
    'schemaVersion',
    'contractVersion',
    'policyVersion',
    'name',
    'factors',
    'freshnessConfidenceMultipliers',
    'conflictingEvidenceMultiplierBasisPoints',
    'statusThresholds',
    'policyId',
    'policySha256',
  ]);
  accountRequire(
    row['schemaVersion'] == 1 &&
        row['contractVersion'] == 'p10.12-customer-health:1' &&
        row['policyVersion'] == 'asael-customer-health:1',
  );
  accountText(row['name'], 180);
  final factors = _rows(row['factors'], 4);
  accountRequire(factors.length == 4);
  accountUnique(
    factors.map((factor) => accountEnum(factor['factorKey'], _factorKeys)),
  );
  var total = 0;
  for (final factor in factors) {
    accountKeys(factor, [
      'factorKey',
      'label',
      'description',
      'weightBasisPoints',
      'acceptedFactKinds',
      'healthDimensions',
      'aggregation',
      'missingInputBehavior',
    ]);
    accountText(factor['label'], 120);
    accountText(factor['description'], 500);
    total += accountInt(factor['weightBasisPoints'], min: 1, max: 10000);
    final kinds = accountList(
      factor['acceptedFactKinds'],
      12,
      (value) => accountEnum(value, accountKinds),
    );
    accountRequire(kinds.isNotEmpty);
    accountUnique(kinds);
    final dimensions = accountList(
      factor['healthDimensions'],
      20,
      (value) => accountText(value, 80),
    );
    accountUnique(dimensions);
    accountRequire(
      dimensions.every((value) => RegExp(r'^[a-z0-9_-]+$').hasMatch(value)) &&
          factor['aggregation'] == 'confidence_weighted_mean' &&
          factor['missingInputBehavior'] == 'exclude_score_lower_confidence',
    );
  }
  accountRequire(total == 10000);
  final multipliers = accountMap(row['freshnessConfidenceMultipliers']);
  accountKeys(multipliers, ['fresh', 'stale', 'future', 'expired', 'unknown']);
  for (final value in multipliers.values) {
    _bp(value);
  }
  accountRequire(multipliers['future'] == 0 && multipliers['expired'] == 0);
  _bp(row['conflictingEvidenceMultiplierBasisPoints']);
  final thresholds = accountMap(row['statusThresholds']);
  accountKeys(thresholds, [
    'healthyMinimumBasisPoints',
    'watchMinimumBasisPoints',
  ]);
  for (final value in thresholds.values) {
    _bp(value);
  }
  accountRequire(
    (thresholds['healthyMinimumBasisPoints'] as int) >
        (thresholds['watchMinimumBasisPoints'] as int),
  );
  final body = {...row}
    ..remove('policyId')
    ..remove('policySha256');
  final sha = await accountSha(body);
  accountRequire(
    row['policySha256'] == sha &&
        row['policyId'] == 'customer-health-policy:$sha',
  );
}

Future<void> _score(
  AccountJson row,
  AccountsOwner owner,
  String workspace,
  String selected,
) async {
  accountKeys(row, [
    'schemaVersion',
    'contractVersion',
    'tenantId',
    'workspaceId',
    'accountId',
    'scoreId',
    'scoreRevisionId',
    'revision',
    'previousScoreRevisionId',
    'evaluationId',
    'accountRevisionId',
    'accountSha256',
    'inputSha256',
    'policy',
    'scoreBasisPoints',
    'status',
    'confidenceBasisPoints',
    'coverageBasisPoints',
    'factors',
    'suggestions',
    'authority',
    'evaluatedByActorId',
    'evaluatedAt',
    'scoreSha256',
  ]);
  accountRequire(
    row['schemaVersion'] == 1 &&
        row['contractVersion'] == 'p10.12-customer-health:1' &&
        row['tenantId'] == owner.tenantId &&
        row['workspaceId'] == workspace &&
        row['accountId'] == selected &&
        row['authority'] == 'deterministic_policy',
  );
  final id =
          'customer-health-score:${await accountSha({'tenantId': owner.tenantId, 'workspaceId': workspace, 'accountId': selected})}',
      revision = accountInt(row['revision'], min: 1);
  accountRequire(
    row['scoreId'] == id &&
        row['scoreRevisionId'] == '$id:v$revision' &&
        row['previousScoreRevisionId'] ==
            (revision == 1 ? null : '$id:v${revision - 1}'),
  );
  _revision(row['accountRevisionId'], selected);
  accountHash(row['accountSha256']);
  accountHash(row['inputSha256']);
  accountId(row['evaluationId'], 'customer-health-evaluation');
  accountId(row['evaluatedByActorId']);
  accountDate(row['evaluatedAt']);
  final status = accountEnum(row['status'], [
    'healthy',
    'watch',
    'at_risk',
    'unknown',
  ]);
  accountRequire((row['scoreBasisPoints'] == null) == (status == 'unknown'));
  if (row['scoreBasisPoints'] != null) {
    _bp(row['scoreBasisPoints']);
  }
  _bp(row['confidenceBasisPoints']);
  _bp(row['coverageBasisPoints']);
  await _policy(row['policy']);
  final factors = _rows(row['factors'], 4);
  accountRequire(factors.length == 4);
  accountUnique(
    factors.map((factor) => accountEnum(factor['factorKey'], _factorKeys)),
  );
  for (final factor in factors) {
    accountKeys(factor, [
      'factorKey',
      'label',
      'weightBasisPoints',
      'scoreBasisPoints',
      'confidenceBasisPoints',
      'evidenceState',
      'evidence',
    ]);
    accountText(factor['label'], 120);
    accountInt(factor['weightBasisPoints'], min: 1, max: 10000);
    _bp(factor['confidenceBasisPoints']);
    final state = accountEnum(factor['evidenceState'], [
      'available',
      'missing',
      'unscorable',
      'stale_only',
    ]);
    accountRequire(
      (factor['scoreBasisPoints'] == null) ==
          ['missing', 'unscorable'].contains(state),
    );
    if (factor['scoreBasisPoints'] == null) {
      accountRequire(factor['confidenceBasisPoints'] == 0);
    } else {
      _bp(factor['scoreBasisPoints']);
    }
    final evidence = _rows(factor['evidence'], 5000);
    accountRequire(state != 'missing' || evidence.isEmpty);
    for (final item in evidence) {
      accountKeys(item, [
        'factId',
        'factRevisionId',
        'factSha256',
        'sourceRevisionId',
        'sourceRevisionSha256',
        'valueSha256',
        'freshnessStatus',
        'rawScoreBasisPoints',
        'sourceConfidenceBasisPoints',
        'freshnessMultiplierBasisPoints',
        'conflictMultiplierBasisPoints',
        'effectiveConfidenceBasisPoints',
      ]);
      _revision(
        item['factRevisionId'],
        accountId(item['factId'], 'customer-fact'),
      );
      accountId(item['sourceRevisionId']);
      for (final key in ['factSha256', 'sourceRevisionSha256', 'valueSha256']) {
        accountHash(item[key]);
      }
      accountEnum(item['freshnessStatus'], [
        'fresh',
        'stale',
        'future',
        'expired',
        'unknown',
      ]);
      for (final key in [
        'sourceConfidenceBasisPoints',
        'freshnessMultiplierBasisPoints',
        'conflictMultiplierBasisPoints',
        'effectiveConfidenceBasisPoints',
      ]) {
        _bp(item[key]);
      }
      if (item['rawScoreBasisPoints'] != null) {
        _bp(item['rawScoreBasisPoints']);
      }
    }
  }
  final suggestions = _rows(row['suggestions'], 20);
  accountUnique(
    suggestions.map(
      (value) => accountId(value['suggestionId'], 'customer-health-suggestion'),
    ),
  );
  for (final value in suggestions) {
    accountKeys(value, [
      'suggestionId',
      'suggestionKind',
      'statement',
      'citedFactRevisionIds',
      'citedFactSha256s',
      'confidenceBasisPoints',
      'origin',
      'authoritative',
      'createdAt',
    ]);
    accountEnum(value['suggestionKind'], [
      'next_action',
      'factor_review',
      'input_gap',
    ]);
    accountText(value['statement'], 1000);
    final ids = accountList(value['citedFactRevisionIds'], 20, accountId),
        hashes = accountList(value['citedFactSha256s'], 20, accountHash);
    accountRequire(
      ids.isNotEmpty &&
          ids.length == hashes.length &&
          value['authoritative'] == false,
    );
    accountUnique(ids);
    accountUnique(hashes);
    _bp(value['confidenceBasisPoints']);
    accountDate(value['createdAt']);
    final origin = accountMap(value['origin']);
    accountKeys(origin, ['kind', 'providerId', 'modelId', 'promptSha256']);
    accountRequire(origin['kind'] == 'model');
    accountId(origin['providerId']);
    accountId(origin['modelId']);
    accountHash(origin['promptSha256']);
    accountRequire(
      value['suggestionId'] ==
          'customer-health-suggestion:${await accountSha({...value}..remove('suggestionId'))}',
    );
  }
  await accountDigest(row, 'scoreSha256');
}

Future<void> _intelligence(AccountJson row, String selected) async {
  accountKeys(row, [
    'policyVersion',
    'generatedAt',
    'portfolio',
    'nextBestAction',
    'risks',
    'commitments',
    'approvals',
    'timeline',
    'projectionSha256',
  ]);
  accountRequire(
    row['policyVersion'] == 'p10.14-customer-success-intelligence:1',
  );
  accountDate(row['generatedAt']);
  final portfolio = await CustomerPortfolioItem.parse(row['portfolio']);
  accountRequire(
    portfolio.id == selected &&
        accountCanonical(row['nextBestAction']) ==
            accountCanonical(portfolio.recommendation),
  );
  final risks = _rows(row['risks'], 250),
      commitments = _rows(row['commitments'], 500),
      approvals = _rows(row['approvals'], 100),
      timeline = _rows(row['timeline'], 250);
  accountUnique(
    risks.map((value) => accountId(value['riskId'], 'customer-success-risk')),
  );
  accountUnique(
    commitments.map(
      (value) => '${value['meetingId']}\u0000${value['commitmentId']}',
    ),
  );
  accountUnique(
    approvals.map((value) => '${value['kind']}\u0000${value['approvalId']}'),
  );
  accountUnique(
    timeline.map(
      (value) => accountId(value['eventId'], 'customer-success-timeline'),
    ),
  );
  for (final value in risks) {
    accountKeys(value, [
      'riskId',
      'source',
      'severity',
      'status',
      'title',
      'reason',
      'evidence',
      'freshness',
      'riskSha256',
    ]);
    accountEnum(value['source'], [
      'account',
      'fact',
      'health',
      'workflow',
      'commitment',
      'data_quality',
    ]);
    accountEnum(value['severity'], ['low', 'medium', 'high', 'critical']);
    accountEnum(value['status'], ['open', 'mitigating']);
    accountText(value['title'], 500);
    accountText(value['reason'], 1000);
    _evidence(value['evidence']);
    accountFreshness(value['freshness']);
    await accountDigest(value, 'riskSha256');
  }
  for (final value in commitments) {
    accountKeys(value, [
      'commitmentId',
      'meetingId',
      'meetingRevisionId',
      'summary',
      'owner',
      'dueAt',
      'status',
      'workItemId',
      'evidence',
      'freshness',
      'commitmentSha256',
    ]);
    for (final key in ['commitmentId', 'meetingId', 'meetingRevisionId']) {
      accountText(value[key], 300);
    }
    accountText(value['summary'], 2000);
    accountNullable(value['owner'], accountText);
    accountNullable(value['dueAt'], accountDate);
    accountNullable(value['workItemId'], (value) => accountText(value, 300));
    accountEnum(value['status'], [
      'recorded',
      'accepted',
      'completed',
      'dismissed',
    ]);
    _evidence(value['evidence']);
    accountFreshness(value['freshness']);
    await accountDigest(value, 'commitmentSha256');
  }
  for (final value in approvals) {
    accountKeys(value, [
      'kind',
      'approvalId',
      'title',
      'status',
      'riskLevel',
      'reason',
      'createdAt',
      'projectId',
      'runId',
      'approvalSha256',
    ]);
    accountEnum(value['kind'], ['tool', 'workflow']);
    accountText(value['approvalId'], 300);
    accountText(value['title'], 300);
    accountEnum(value['status'], [
      'approval_required',
      'reconciliation_required',
      'waiting_approval',
    ]);
    accountInt(value['riskLevel'], max: 3);
    accountNullable(value['reason'], (value) => accountText(value, 1000));
    accountDate(value['createdAt']);
    accountNullable(value['projectId'], (value) => accountText(value, 300));
    accountNullable(value['runId'], (value) => accountText(value, 300));
    await accountDigest(value, 'approvalSha256');
  }
  for (final value in timeline) {
    accountKeys(value, [
      'eventId',
      'kind',
      'occurredAt',
      'title',
      'summary',
      'evidence',
    ]);
    accountEnum(value['kind'], [
      'account_revision',
      'fact_revision',
      'health_evaluation',
      'workflow_started',
      'workflow_outcome',
      'meeting_commitment',
    ]);
    accountDate(value['occurredAt']);
    accountText(value['title'], 300);
    accountText(value['summary'], 2000);
    _evidence(value['evidence']);
  }
  await accountDigest(row, 'projectionSha256');
}

Future<void> _workflows(
  AccountJson response,
  AccountsOwner owner,
  String workspace,
  String selected,
) async {
  final pack = _rows(response['pack'], 8), runs = _rows(response['runs'], 100);
  accountRequire(pack.length == 8);
  accountUnique(
    pack.map((row) => accountEnum(row['workflowId'], _workflowIds)),
  );
  final definitions = <String, String>{};
  for (final row in pack) {
    accountKeys(row, [
      'schemaVersion',
      'contractVersion',
      'packVersion',
      'workflowId',
      'name',
      'description',
      'inputFields',
      'acceptanceCriteria',
      'artifacts',
      'evidenceRequirements',
      'projectTemplate',
      'defaultNextAction',
      'externalActionPolicy',
      'definitionSha256',
    ]);
    accountRequire(
      row['schemaVersion'] == 1 &&
          row['contractVersion'] == 'p10.13-customer-success-workflow:1' &&
          row['packVersion'] == 'asael-csm-pack:1',
    );
    accountText(row['name'], 120);
    accountText(row['description'], 1000);
    accountText(row['defaultNextAction'], 500);
    _strings(row['acceptanceCriteria'], 20, length: 500, min: 1);
    final fields = _rows(row['inputFields'], 20),
        artifacts = _rows(row['artifacts'], 20),
        evidence = _rows(row['evidenceRequirements'], 20);
    accountRequire(
      fields.length >= 3 && artifacts.isNotEmpty && evidence.isNotEmpty,
    );
    accountUnique(fields.map((value) => accountText(value['fieldId'], 80)));
    accountUnique(
      artifacts.map((value) => accountText(value['artifactKey'], 80)),
    );
    accountUnique(
      evidence.map((value) => accountText(value['evidenceKey'], 80)),
    );
    for (final field in fields) {
      accountKeys(field, [
        'fieldId',
        'label',
        'valueType',
        'required',
        'allowedValues',
      ]);
      accountRequire(
        RegExp(r'^[a-z][a-zA-Z0-9]*$').hasMatch(field['fieldId'] as String),
      );
      accountText(field['label'], 120);
      accountEnum(field['valueType'], [
        'text',
        'text_list',
        'id',
        'id_list',
        'timestamp',
        'enum',
        'money',
      ]);
      accountBool(field['required']);
      _strings(field['allowedValues'], 20, length: 80);
    }
    for (final value in [...artifacts, ...evidence]) {
      final isEvidence = value.containsKey('evidenceKey');
      accountKeys(value, [
        isEvidence ? 'evidenceKey' : 'artifactKey',
        'title',
        'description',
        'required',
        if (isEvidence) 'allowedSourceKinds',
      ]);
      accountText(value['title'], 180);
      accountText(value['description'], 1000);
      accountBool(value['required']);
      if (isEvidence) {
        accountRequire(
          accountList(
            value['allowedSourceKinds'],
            10,
            (value) => accountEnum(value, [
              'account_fact',
              'customer_health',
              'meeting',
              'project_artifact',
              'support_case',
              'crm_revision',
              'operator_confirmation',
            ]),
          ).isNotEmpty,
        );
      }
    }
    final policy = accountMap(row['externalActionPolicy']);
    accountKeys(policy, [
      'communicationMode',
      'crmMode',
      'allowedCommunicationToolIds',
      'allowedCrmToolIdPrefixes',
      'directExternalEffectsAllowed',
    ]);
    accountRequire(
      policy['communicationMode'] == 'draft_only_until_governed_delivery' &&
          policy['crmMode'] == 'proposal_only_until_governed_write' &&
          policy['directExternalEffectsAllowed'] == false &&
          accountCanonical(policy['allowedCommunicationToolIds']) ==
              '["app.communications.drafts.create"]' &&
          accountCanonical(policy['allowedCrmToolIdPrefixes']) ==
              '["app.customer_accounts.salesforce."]',
    );
    _projectTemplate(accountMap(row['projectTemplate']));
    await accountDigest(row, 'definitionSha256');
    definitions[row['workflowId'] as String] =
        row['definitionSha256'] as String;
  }
  accountUnique(
    runs.map((row) => accountId(row['runId'], 'customer-success-run')),
  );
  for (final row in runs) {
    accountKeys(row, [
      'schemaVersion',
      'contractVersion',
      'tenantId',
      'workspaceId',
      'accountId',
      'accountRevisionId',
      'accountRevision',
      'accountSha256',
      'runId',
      'runRevisionId',
      'revision',
      'previousRunRevisionId',
      'workflowId',
      'definitionSha256',
      'input',
      'inputSha256',
      'owner',
      'ownerActorId',
      'projectId',
      'projectTaskIds',
      'allowedPurposeIds',
      'outcome',
      'runSha256',
    ]);
    accountRequire(
      row['schemaVersion'] == 1 &&
          row['contractVersion'] == 'p10.13-customer-success-workflow:1' &&
          row['tenantId'] == owner.tenantId &&
          row['workspaceId'] == workspace &&
          row['accountId'] == selected,
    );
    final revision = accountInt(row['revision'], min: 1), id = row['runId'];
    accountRequire(
      row['runRevisionId'] == '$id:v$revision' &&
          row['previousRunRevisionId'] ==
              (revision == 1 ? null : '$id:v${revision - 1}') &&
          row['accountRevisionId'] ==
              '$selected:v${accountInt(row['accountRevision'], min: 1)}',
    );
    accountHash(row['accountSha256']);
    accountEnum(row['workflowId'], _workflowIds);
    accountRequire(definitions[row['workflowId']] == row['definitionSha256']);
    final input = accountMap(row['input']);
    accountRequire(input['workflowId'] == row['workflowId']);
    _workflowInput(input);
    accountRequire(row['inputSha256'] == await accountSha(input));
    accountSemanticOwner(row['owner']);
    accountId(row['ownerActorId']);
    accountId(row['projectId']);
    final tasks = _rows(row['projectTaskIds'], 20);
    accountRequire(tasks.isNotEmpty);
    for (final value in tasks) {
      accountKeys(value, ['taskKey', 'projectTaskId']);
      accountId(value['taskKey']);
      accountId(value['projectTaskId']);
    }
    accountUnique(tasks.map((value) => value['taskKey'] as String));
    accountUnique(tasks.map((value) => value['projectTaskId'] as String));
    accountRequire(
      accountCanonical(row['allowedPurposeIds']) ==
          '["customer_success.account.read"]',
    );
    final outcome = accountMap(row['outcome']);
    accountKeys(outcome, [
      'status',
      'summary',
      'artifactReceipts',
      'nextAction',
      'recordedByActorId',
      'recordedAt',
      'receiptSha256',
    ]);
    accountEnum(outcome['status'], [
      'in_progress',
      'completed',
      'blocked',
      'cancelled',
    ]);
    accountRequire(
      outcome['summary'] is String &&
          (outcome['summary'] as String).length <= 4000 &&
          (outcome['summary'] as String).trim() == outcome['summary'],
    );
    accountText(outcome['nextAction'], 500);
    accountId(outcome['recordedByActorId']);
    accountDate(outcome['recordedAt']);
    final receipts = _rows(outcome['artifactReceipts'], 20);
    for (final value in receipts) {
      accountKeys(value, [
        'artifactKey',
        'projectArtifactId',
        'evidenceKeys',
        'evidenceRefs',
      ]);
      accountText(value['artifactKey'], 80);
      accountId(value['projectArtifactId']);
      _strings(value['evidenceKeys'], 20, length: 80);
      _strings(value['evidenceRefs'], 100);
    }
    accountRequire(
      outcome['status'] != 'in_progress' ||
          outcome['summary'] == '' && receipts.isEmpty,
    );
    await accountDigest(outcome, 'receiptSha256');
    await accountDigest(row, 'runSha256');
  }
}

void _projectTemplate(AccountJson row) {
  accountKeys(row, ['title', 'objective', 'status', 'tasks']);
  accountText(row['title'], 180);
  accountText(row['objective'], 2000);
  accountEnum(row['status'], ['draft', 'active']);
  final tasks = _rows(row['tasks'], 20),
      dependencies = <String, List<String>>{};
  accountUnique(tasks.map((task) => accountText(task['key'], 80)));
  accountUnique(tasks.map((task) => accountText(task['title']).toLowerCase()));
  for (final task in tasks) {
    accountKeys(task, [
      'key',
      'title',
      'detail',
      'priority',
      'agentId',
      'dependsOnKeys',
    ]);
    final key = accountId(task['key']);
    accountRequire(
      task['detail'] is String &&
          (task['detail'] as String).length <= 1000 &&
          (task['detail'] as String).trim() == task['detail'],
    );
    accountEnum(task['priority'], ['low', 'medium', 'high']);
    accountEnum(task['agentId'], [
      'atlas',
      'scout',
      'forge',
      'sentinel',
      'mnemosyne',
    ]);
    final links = accountList(task['dependsOnKeys'], 20, (value) {
      accountId(value);
      return accountText(value, 80);
    });
    accountUnique(links);
    accountRequire(!links.contains(key));
    dependencies[key] = links;
  }
  final visiting = <String>{}, visited = <String>{};
  void visit(String key) {
    accountRequire(dependencies.containsKey(key) && !visiting.contains(key));
    if (visited.contains(key)) {
      return;
    }
    visiting.add(key);
    for (final child in dependencies[key]!) {
      visit(child);
    }
    visiting.remove(key);
    visited.add(key);
  }

  for (final key in dependencies.keys) {
    visit(key);
  }
}

void _workflowInput(AccountJson row) {
  final kind = accountEnum(row['workflowId'], _workflowIds);
  const fields = <String, List<String>>{
    'onboarding': ['successCriteria', 'productNames', 'stakeholderIds'],
    'adoption_review': [
      'periodStartAt',
      'periodEndAt',
      'adoptionGoals',
      'productIds',
    ],
    'risk_escalation': [
      'riskTitle',
      'severity',
      'signals',
      'executiveSponsorId',
    ],
    'renewal_planning': [
      'renewalAt',
      'renewalGoals',
      'amountMinor',
      'currency',
    ],
    'qbr_ebr': [
      'reviewKind',
      'meetingAt',
      'periodStartAt',
      'periodEndAt',
      'audience',
      'agendaObjectives',
    ],
    'meeting_prep_follow_up': [
      'meetingId',
      'phase',
      'participantIds',
      'meetingObjectives',
    ],
    'support_escalation': [
      'caseIds',
      'severity',
      'customerImpact',
      'requestedOutcome',
    ],
    'expansion_discovery': [
      'hypotheses',
      'stakeholderIds',
      'discoveryWindowEndAt',
    ],
  };
  accountKeys(row, ['workflowId', 'objective', 'targetDate', ...fields[kind]!]);
  accountText(row['objective'], 2000);
  accountNullable(row['targetDate'], accountDate);
  for (final key in [
    'periodStartAt',
    'periodEndAt',
    'renewalAt',
    'meetingAt',
    'discoveryWindowEndAt',
  ]) {
    if (row.containsKey(key)) {
      accountDate(row[key]);
    }
  }
  if (row.containsKey('periodEndAt')) {
    accountRequire(
      (row['periodEndAt'] as String).compareTo(row['periodStartAt'] as String) >
          0,
    );
  }
  for (final key in [
    'successCriteria',
    'adoptionGoals',
    'signals',
    'renewalGoals',
    'audience',
    'agendaObjectives',
    'meetingObjectives',
    'hypotheses',
  ]) {
    if (row.containsKey(key)) {
      _strings(row[key], 20, length: 500, min: 1);
    }
  }
  for (final key in [
    'stakeholderIds',
    'productIds',
    'participantIds',
    'caseIds',
  ]) {
    if (row.containsKey(key)) {
      final values = accountList(
        row[key],
        key == 'productIds' ? 20 : 50,
        accountId,
      );
      if (key == 'participantIds' ||
          key == 'caseIds' ||
          kind == 'expansion_discovery') {
        accountRequire(values.isNotEmpty);
      }
    }
  }
  if (kind == 'onboarding') {
    _strings(row['productNames'], 20);
  }
  if (kind == 'risk_escalation') {
    accountText(row['riskTitle'], 500);
    accountEnum(row['severity'], ['low', 'medium', 'high', 'critical']);
    accountNullable(row['executiveSponsorId'], accountId);
  }
  if (kind == 'renewal_planning') {
    accountRequire((row['amountMinor'] == null) == (row['currency'] == null));
    if (row['amountMinor'] != null) {
      accountInt(row['amountMinor']);
      accountRequire(
        RegExp(r'^[A-Z]{3}$').hasMatch(accountText(row['currency'], 3)),
      );
    }
  }
  if (kind == 'qbr_ebr') {
    accountEnum(row['reviewKind'], ['qbr', 'ebr']);
  }
  if (kind == 'meeting_prep_follow_up') {
    accountId(row['meetingId']);
    accountEnum(row['phase'], ['prep', 'follow_up']);
  }
  if (kind == 'support_escalation') {
    accountEnum(row['severity'], ['medium', 'high', 'critical']);
    accountText(row['customerImpact'], 2000);
    accountText(row['requestedOutcome'], 1000);
  }
}

Future<void> _salesforce(AccountJson response, String workspace) async {
  accountKeys(response, [
    'context',
    'health',
    'findings',
    'writes',
    'authorizeUrl',
    'webhook',
  ]);
  final health = accountMap(response['health']);
  accountKeys(health, [
    'schemaVersion',
    'contractVersion',
    'configured',
    'connected',
    'connectionId',
    'workspaceId',
    'status',
    'accessMode',
    'objectScope',
    'purposeScope',
    'cursor',
    'lagSeconds',
    'lastSuccessfulSyncAt',
    'lastWebhookAt',
    'lastReplayIdSha256',
    'actionableError',
    'evaluatedAt',
  ]);
  accountRequire(
    health['schemaVersion'] == 1 &&
        health['contractVersion'] == 'p10.10-salesforce-read-sync:1' &&
        health['workspaceId'] == workspace &&
        health['accessMode'] == 'read_only',
  );
  accountBool(health['configured']);
  final connected = accountBool(health['connected']);
  accountNullable(
    health['connectionId'],
    (value) => accountId(value, 'salesforce-connection'),
  );
  accountRequire(!connected || health['connectionId'] != null);
  accountEnum(health['status'], [
    'configuration_required',
    'disconnected',
    'idle',
    'backfilling',
    'syncing',
    'healthy',
    'degraded',
    'error',
  ]);
  final objects = accountList(
    health['objectScope'],
    8,
    (value) => accountEnum(value, _sfObjects),
  );
  accountRequire(objects.length == 8);
  accountUnique(objects);
  accountRequire(
    accountCanonical(health['purposeScope']) ==
        '["customer_success.account.read","customer_success.crm_sync"]',
  );
  accountNullable(health['lagSeconds'], accountInt);
  accountNullable(health['lastSuccessfulSyncAt'], accountDate);
  accountNullable(health['lastWebhookAt'], accountDate);
  accountNullable(health['lastReplayIdSha256'], accountHash);
  accountDate(health['evaluatedAt']);
  if (health['cursor'] != null) {
    final cursor = accountMap(health['cursor']);
    accountKeys(cursor, ['version', 'objects']);
    accountRequire(cursor['version'] == 1);
    final objects = accountMap(cursor['objects']);
    accountKeys(objects, _sfObjects);
    for (final raw in objects.values) {
      final value = accountMap(raw);
      accountKeys(value, [
        'phase',
        'nextRecordsPath',
        'upperBoundAt',
        'watermarkAt',
        'watermarkExternalId',
        'pagesSettled',
        'recordsSettled',
      ]);
      accountEnum(value['phase'], ['pending', 'backfill', 'delta', 'current']);
      if (value['nextRecordsPath'] != null) {
        accountRequire(
          accountText(
            value['nextRecordsPath'],
            2000,
          ).startsWith('/services/data/'),
        );
      }
      accountNullable(value['upperBoundAt'], accountDate);
      accountNullable(value['watermarkAt'], accountDate);
      if (value['watermarkExternalId'] != null) {
        accountRequire(
          RegExp(r'^[A-Za-z0-9]{15,18}$')
                  .hasMatch(accountText(value['watermarkExternalId'], 18)) &&
              value['watermarkAt'] != null,
        );
      }
      accountInt(value['pagesSettled']);
      accountInt(value['recordsSettled']);
    }
  }
  if (health['actionableError'] != null) {
    final error = accountMap(health['actionableError']);
    accountKeys(error, ['code', 'message', 'action', 'occurredAt']);
    accountEnum(error['code'], [
      'authorization_expired',
      'insufficient_scope',
      'provider_unavailable',
      'rate_limited',
      'cursor_expired',
      'schema_changed',
      'record_conflict',
      'webhook_invalid',
      'internal_error',
    ]);
    accountEnum(error['action'], [
      'reconnect',
      'review_permissions',
      'retry',
      'restart_backfill',
      'review_conflict',
      'contact_support',
    ]);
    accountText(error['message'], 500);
    accountDate(error['occurredAt']);
  }
  final findings = _rows(response['findings'], 50);
  accountUnique(
    findings.map((row) => accountId(row['findingId'], 'salesforce-finding')),
  );
  for (final row in findings) {
    accountKeys(row, [
      'findingId',
      'objectType',
      'externalIdSha256',
      'localRevisionId',
      'remoteRevisionId',
      'findingKind',
      'findingSha256',
      'observedAt',
    ]);
    accountEnum(row['objectType'], _sfObjects);
    accountHash(row['externalIdSha256']);
    accountNullable(
      row['localRevisionId'],
      (value) => accountId(value, 'salesforce-revision'),
    );
    accountNullable(
      row['remoteRevisionId'],
      (value) => accountId(value, 'salesforce-revision'),
    );
    accountEnum(row['findingKind'], [
      'missing_local',
      'missing_remote',
      'revision_mismatch',
      'concurrent_revision',
    ]);
    accountDate(row['observedAt']);
    accountRequire(
      row['findingId'] ==
          'salesforce-finding:${accountHash(row['findingSha256'])}',
    );
  }
  final writes = accountMap(response['writes']);
  accountKeys(writes, [
    'configured',
    'enabled',
    'mode',
    'createObjects',
    'updateObjects',
    'operations',
  ]);
  accountRequire(writes['mode'] == 'approval_required');
  final configured = accountBool(writes['configured']),
      enabled = accountBool(writes['enabled']);
  accountRequire(!configured || enabled);
  final creates = accountList(
        writes['createObjects'],
        4,
        (value) => accountEnum(value, _sfCreate),
      ),
      updates = accountList(
        writes['updateObjects'],
        6,
        (value) => accountEnum(value, _sfUpdate),
      );
  accountRequire(creates.length == 4 && updates.length == 6);
  accountUnique(creates);
  accountUnique(updates);
  final operations = _rows(writes['operations'], 25);
  accountUnique(
    operations.map((row) => accountId(row['operationId'], 'salesforce-write')),
  );
  for (final row in operations) {
    await _salesforceWrite(row);
  }
  final webhook = accountMap(response['webhook']);
  accountKeys(webhook, ['endpoint', 'signature', 'configured']);
  accountRequire(
    webhook['endpoint'] == '/api/webhooks/salesforce' &&
        webhook['signature'] == 'hmac-sha256-v1',
  );
  accountBool(webhook['configured']);
  accountRequire(
    response['authorizeUrl'] ==
        '/api/oauth/salesforce/authorize?returnTo=${Uri.encodeComponent('/app/accounts')}&workspaceId=${Uri.encodeComponent(workspace)}',
  );
}

Future<void> _salesforceWrite(AccountJson row) async {
  accountKeys(row, [
    'operationId',
    'toolExecutionId',
    'toolId',
    'objectType',
    'action',
    'customerAccountId',
    'providerRecordIdSha256',
    'requestSha256',
    'expectedTargetStateSha256',
    'state',
    'providerAcknowledgementSha256',
    'observedTargetStateSha256',
    'verificationReasonCode',
    'commit',
    'attemptCount',
    'lastAttemptAt',
    'completedAt',
    'createdAt',
    'updatedAt',
  ]);
  final execution = accountText(row['toolExecutionId']),
      object = accountEnum(row['objectType'], _sfUpdate),
      action = accountEnum(row['action'], ['create', 'update']);
  accountRequire(action != 'create' || _sfCreate.contains(object));
  accountRequire(
    row['toolId'] ==
            'app.customer_accounts.salesforce.${object.toLowerCase()}.$action' &&
        row['operationId'] ==
            'salesforce-write:${await accountRawSha('p10.11\u0000$execution')}',
  );
  accountId(row['customerAccountId'], 'customer-account');
  accountHash(row['requestSha256']);
  accountHash(row['expectedTargetStateSha256']);
  for (final field in [
    'providerRecordIdSha256',
    'providerAcknowledgementSha256',
    'observedTargetStateSha256',
  ]) {
    accountNullable(row[field], accountHash);
  }
  accountNullable(
    row['verificationReasonCode'],
    (value) => accountEnum(value, [
      'state_matched',
      'target_missing',
      'state_mismatch',
    ]),
  );
  final state = accountEnum(row['state'], ['prepared', 'verified', 'failed']),
      attempts = accountInt(row['attemptCount']);
  accountRequire((attempts == 0) == (row['lastAttemptAt'] == null));
  accountNullable(row['lastAttemptAt'], accountDate);
  accountNullable(row['completedAt'], accountDate);
  accountDate(row['createdAt']);
  accountDate(row['updatedAt']);
  if (state == 'prepared') {
    accountRequire(
      [
        'commit',
        'completedAt',
        'providerAcknowledgementSha256',
        'observedTargetStateSha256',
        'verificationReasonCode',
      ].every((key) => row[key] == null),
    );
  } else {
    final commit = accountMap(row['commit']);
    accountKeys(commit, [
      'schemaVersion',
      'contractVersion',
      'operationId',
      'toolId',
      'objectType',
      'action',
      'providerRecordIdSha256',
      'providerModifiedAt',
      'providerAcknowledgement',
      'providerAcknowledgementId',
      'providerAcknowledgementSha256',
      'expectedTargetStateSha256',
      'observedTargetStateSha256',
      'verificationState',
      'verificationReasonCode',
    ]);
    accountRequire(
      row['completedAt'] != null &&
          commit['schemaVersion'] == 1 &&
          commit['contractVersion'] == 'p10.11-salesforce-guarded-write:1' &&
          commit['verificationState'] == state,
    );
    for (final field in [
      'operationId',
      'toolId',
      'objectType',
      'action',
      'providerRecordIdSha256',
      'providerAcknowledgementSha256',
      'expectedTargetStateSha256',
      'observedTargetStateSha256',
      'verificationReasonCode',
    ]) {
      accountRequire(commit[field] == row[field]);
    }
    accountHash(commit['providerRecordIdSha256']);
    accountHash(commit['providerAcknowledgementSha256']);
    accountEnum(commit['providerAcknowledgement'], [
      'provider_response',
      'provider_idempotency_reconciliation',
    ]);
    accountRequire(
      RegExp(r'^salesforce_ack_[a-f0-9]{48}$')
          .hasMatch(accountText(commit['providerAcknowledgementId'])),
    );
    accountNullable(commit['providerModifiedAt'], accountDate);
    accountRequire(
      (state == 'verified') ==
              (commit['verificationReasonCode'] == 'state_matched' &&
                  commit['observedTargetStateSha256'] ==
                      commit['expectedTargetStateSha256']) &&
          (commit['verificationReasonCode'] == 'target_missing') ==
              (commit['providerModifiedAt'] == null),
    );
  }
}
