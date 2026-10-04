import 'dart:convert';

import 'accounts_advanced_contracts.dart';
import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';

const accountWorkflowReadContract = 'customer-success-workflow-read:1';
const accountWorkflowRevisionLimit = 2147483647;

AccountJson _currentAccount(Object? value, String id) {
  final row = accountMap(value);
  accountKeys(row, ['accountId', 'revisionId', 'revision', 'accountSha256']);
  final revision = accountInt(
    row['revision'],
    min: 1,
    max: accountWorkflowRevisionLimit,
  );
  accountRequire(
    row['accountId'] == id && row['revisionId'] == '$id:v$revision',
  );
  accountHash(row['accountSha256']);
  return accountFreeze(row);
}

void accountWorkflowArtifacts(Object? value) {
  final rows = accountList(value, 20, accountMap);
  String key(Object? value) {
    final text = accountText(value, 80);
    accountRequire(RegExp(r'^[a-z][a-z0-9_]{1,79}$').hasMatch(text));
    return text;
  }

  accountUnique(rows.map((row) => key(row['artifactKey'])));
  for (final row in rows) {
    accountKeys(row, [
      'artifactKey',
      'projectArtifactId',
      'evidenceKeys',
      'evidenceRefs',
    ]);
    accountId(row['projectArtifactId']);
    accountList(row['evidenceKeys'], 20, key);
    accountList(row['evidenceRefs'], 100, accountId);
  }
}

class AccountWorkflowIntent {
  const AccountWorkflowIntent._(
    this.owner,
    this.workspaceId,
    this.key,
    this.accountName,
    this.identity,
    this.requestSha256,
    this.definition,
    this.reviewedRun,
  );
  final AccountsOwner owner;
  final String workspaceId, key, accountName, requestSha256;
  final AccountJson identity, definition;
  final AccountJson? reviewedRun;
  bool get start => identity['operation'] == 'start';
  String get operation =>
      start ? 'customers.workflows.start' : 'customers.workflows.outcome';
  String get account => identity['accountId'] as String;
  String get runId => identity['runId'] as String;
  AccountJson get request => accountMap(identity['request']);
  AccountJson get body => {
    'contract': start
        ? 'customer-success-workflow-start-request:1'
        : 'customer-success-workflow-outcome-request:1',
    'workspaceId': workspaceId,
    ...request,
  };
  AccountJson get stored => {
    'workspaceId': workspaceId,
    'key': key,
    'accountName': accountName,
    'identity': identity,
    'requestSha256': requestSha256,
    'definition': definition,
    'reviewedRun': reviewedRun,
  };

  static Future<AccountWorkflowIntent> prepare(
    AccountsOwner owner,
    String workspace,
    String key,
    CustomerAccountSummary account,
    AccountJson definition,
    AccountJson values, {
    AccountJson? run,
  }) async {
    accountRequire(
      account.raw['tenantId'] == owner.tenantId &&
          account.raw['workspaceId'] == workspace &&
          account.raw['ownerActorId'] == 'actor:${owner.userId}',
    );
    if (run != null) {
      accountKeys(values, [
        'status',
        'summary',
        'artifactReceipts',
        'nextAction',
      ]);
    }
    return _build(
      owner,
      workspace,
      key,
      account.name,
      account.id,
      {
        'expectedAccountRevision': account.revision,
        'expectedAccountSha256': account.sha256,
        'expectedDefinitionSha256': definition['definitionSha256'],
        if (run == null)
          'input': values
        else ...{
          'runId': run['runId'],
          'expectedRunRevision': run['revision'],
          'expectedRunSha256': run['runSha256'],
          ...values,
        },
      },
      definition,
      run,
    );
  }

  static Future<AccountWorkflowIntent> _build(
    AccountsOwner owner,
    String workspace,
    String key,
    String name,
    String id,
    AccountJson request,
    AccountJson definition,
    AccountJson? run,
  ) async {
    accountRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    accountRequire(accountId(workspace).startsWith('workspace:'));
    accountId(id, 'customer-account');
    accountText(name);
    accountInt(
      request['expectedAccountRevision'],
      min: 1,
      max: accountWorkflowRevisionLimit,
    );
    accountHash(request['expectedAccountSha256']);
    await validateAccountWorkflowData(
      {
        'pack': [definition],
        'runs': [?run],
      },
      owner,
      workspace,
      id,
      completePack: false,
      exactOwner: true,
    );
    accountRequire(
      request['expectedDefinitionSha256'] == definition['definitionSha256'],
    );
    if (run == null) {
      accountKeys(request, [
        'expectedAccountRevision',
        'expectedAccountSha256',
        'expectedDefinitionSha256',
        'input',
      ]);
      final input = accountMap(request['input']);
      accountWorkflowInput(input);
      accountRequire(input['workflowId'] == definition['workflowId']);
    } else {
      accountKeys(request, [
        'expectedAccountRevision',
        'expectedAccountSha256',
        'expectedDefinitionSha256',
        'runId',
        'expectedRunRevision',
        'expectedRunSha256',
        'status',
        'summary',
        'artifactReceipts',
        'nextAction',
      ]);
      accountRequire(
        request['runId'] == run['runId'] &&
            request['expectedRunRevision'] == run['revision'] &&
            request['expectedRunSha256'] == run['runSha256'] &&
            (run['revision'] as int) < accountWorkflowRevisionLimit &&
            !const {
              'completed',
              'cancelled',
            }.contains(accountMap(run['outcome'])['status']),
      );
      accountEnum(request['status'], ['completed', 'blocked', 'cancelled']);
      accountText(request['summary'], 4000);
      accountText(request['nextAction'], 500);
      accountWorkflowArtifacts(request['artifactReceipts']);
      accountRequire(
        (request['expectedAccountRevision'] as int) >=
                (run['accountRevision'] as int) &&
            (request['expectedAccountRevision'] != run['accountRevision'] ||
                request['expectedAccountSha256'] == run['accountSha256']),
      );
    }
    final target = run == null
        ? 'customer-success-run:${await accountSha({'tenantId': owner.tenantId, 'workspaceId': workspace, 'accountId': id, 'idempotencyKey': key})}'
        : accountId(run['runId'], 'customer-success-run');
    final identity = accountFreeze({
      'schemaVersion': 1,
      'contract': 'customer-success-workflow-intent:1',
      'operation': run == null ? 'start' : 'outcome',
      'tenantId': owner.tenantId,
      'workspaceId': workspace,
      'accountId': id,
      'runId': target,
      'canonicalActorId': 'actor:${owner.userId}',
      'idempotencyKeySha256': await accountRawSha(
        '${owner.tenantId}\u0000$key',
      ),
      'request': request,
    });
    final result = AccountWorkflowIntent._(
      owner,
      workspace,
      key,
      name,
      identity,
      await accountSha(identity),
      accountFreeze(definition),
      run == null ? null : accountFreeze(run),
    );
    accountRequire(
      utf8.encode(jsonEncode(result.body)).length <=
          (run == null ? 32768 : 131072),
      'This workflow request exceeds its published size limit. Shorten the input without dropping required evidence.',
    );
    return result;
  }

  static Future<AccountWorkflowIntent> restore(
    Object? value,
    AccountsOwner owner,
    String workspace,
  ) async {
    final row = accountMap(value);
    accountKeys(row, [
      'workspaceId',
      'key',
      'accountName',
      'identity',
      'requestSha256',
      'definition',
      'reviewedRun',
    ]);
    accountRequire(row['workspaceId'] == workspace);
    final identity = accountMap(row['identity']);
    final restored = await _build(
      owner,
      workspace,
      accountText(row['key'], 512),
      accountText(row['accountName']),
      accountId(identity['accountId'], 'customer-account'),
      accountMap(identity['request']),
      accountMap(row['definition']),
      row['reviewedRun'] == null ? null : accountMap(row['reviewedRun']),
    );
    accountRequire(
      accountCanonical(identity) == accountCanonical(restored.identity) &&
          row['requestSha256'] == restored.requestSha256,
    );
    return restored;
  }

  Future<String> authorityHash() async => accountSha({
    'boundaryVersion': accountBoundary,
    'tenantId': owner.tenantId,
    'actorId': owner.actorId,
    'role': owner.role,
    'executionScope': {
      'version': 1,
      'tenantId': owner.tenantId,
      'initiatingActorId': owner.actorId,
      'executingPrincipalType': 'user',
      'executingPrincipalId': owner.actorId,
      'workspaceId': workspaceId,
      'projectId': null,
      'missionId': null,
      'delegationId': null,
      'correlationId': key.length <= 256
          ? key
          : 'idempotency-key:${await accountSha(key)}',
      'causationId': start ? account : runId,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': start
          ? 'api.customer-success-workflow.start'
          : 'api.customer-success-workflow.outcome',
    },
  });
}

class AccountWorkflowAcceptance {
  const AccountWorkflowAcceptance._(
    this.raw,
    this.currentAccount,
    this.acceptance,
  );
  final AccountJson raw, currentAccount;
  final AccountJson? acceptance;
  static Future<AccountWorkflowAcceptance> parse(
    Object? value,
    AccountWorkflowIntent intent, {
    required bool mutation,
  }) async {
    final row = accountMap(value);
    accountRequire(utf8.encode(jsonEncode(row)).length <= 131072);
    accountKeys(row, [
      'contract',
      'context',
      'currentAccount',
      'acceptance',
      if (mutation) 'replayed',
      'serviceReceipt',
    ]);
    accountRequire(row['contract'] == accountWorkflowReadContract);
    final context = AccountContext.parse(
          row['context'],
          workspaceId: intent.workspaceId,
        ),
        current = _currentAccount(row['currentAccount'], intent.account);
    if (mutation) {
      accountBool(row['replayed']);
      accountRequire(
        context.accessLevel != 'reader' && row['acceptance'] != null,
      );
    }
    AccountJson? accepted;
    if (row['acceptance'] != null) {
      accepted = accountMap(row['acceptance']);
      accountKeys(accepted, [
        'schemaVersion',
        'contract',
        'operation',
        'tenantId',
        'workspaceId',
        'accountId',
        'runId',
        'canonicalActorId',
        'idempotencyKeySha256',
        'requestSha256',
        'reviewedAccountRevisionId',
        'reviewedAccountRevision',
        'reviewedAccountSha256',
        'runAccountRevisionId',
        'runAccountRevision',
        'runAccountSha256',
        'workflowId',
        'definitionSha256',
        'inputSha256',
        'runRevisionId',
        'runRevision',
        'runSha256',
        'projectId',
        'projectTaskIds',
        'outcomeStatus',
        'outcomeReceiptSha256',
        'acceptedAt',
        'effectAuthority',
        'acceptanceSha256',
      ]);
      for (final field in [
        'tenantId',
        'workspaceId',
        'accountId',
        'runId',
        'canonicalActorId',
        'operation',
        'idempotencyKeySha256',
      ]) {
        accountRequire(accepted[field] == intent.identity[field]);
      }
      final request = intent.request, original = intent.reviewedRun;
      final revision = accountInt(
        accepted['runRevision'],
        min: 1,
        max: accountWorkflowRevisionLimit,
      );
      accountRequire(
        accepted['schemaVersion'] == 1 &&
            accepted['contract'] == 'customer-success-workflow-acceptance:1' &&
            accepted['requestSha256'] == intent.requestSha256 &&
            accepted['effectAuthority'] == 'none' &&
            accepted['reviewedAccountRevision'] ==
                request['expectedAccountRevision'] &&
            accepted['reviewedAccountRevisionId'] ==
                '${intent.account}:v${request['expectedAccountRevision']}' &&
            accepted['reviewedAccountSha256'] ==
                request['expectedAccountSha256'] &&
            accepted['definitionSha256'] ==
                request['expectedDefinitionSha256'] &&
            accepted['workflowId'] == intent.definition['workflowId'] &&
            accepted['runRevisionId'] == '${intent.runId}:v$revision',
      );
      accountHash(accepted['runSha256']);
      accountId(accepted['projectId']);
      accountDate(accepted['acceptedAt']);
      final mappings = accountList(accepted['projectTaskIds'], 20, accountMap);
      accountRequire(mappings.isNotEmpty);
      for (final item in mappings) {
        accountKeys(item, ['taskKey', 'projectTaskId']);
        accountId(item['taskKey']);
        accountId(item['projectTaskId']);
      }
      accountUnique(mappings.map((item) => item['taskKey'] as String));
      accountUnique(mappings.map((item) => item['projectTaskId'] as String));
      if (intent.start) {
        final input = accountMap(request['input']);
        final taskKeys = accountList(
          accountMap(intent.definition['projectTemplate'])['tasks'],
          20,
          accountMap,
        ).map((task) => task['key']).toList();
        accountRequire(
          revision == 1 &&
              accepted['outcomeStatus'] == 'in_progress' &&
              accepted['runAccountRevisionId'] ==
                  accepted['reviewedAccountRevisionId'] &&
              accepted['runAccountRevision'] ==
                  accepted['reviewedAccountRevision'] &&
              accepted['runAccountSha256'] ==
                  accepted['reviewedAccountSha256'] &&
              accepted['inputSha256'] == await accountSha(input) &&
              accountCanonical(
                    mappings.map((item) => item['taskKey']).toList(),
                  ) ==
                  accountCanonical(taskKeys),
        );
      } else {
        accountRequire(
          revision == (request['expectedRunRevision'] as int) + 1 &&
              accepted['outcomeStatus'] == request['status'],
        );
        for (final entry in const {
          'runAccountRevisionId': 'accountRevisionId',
          'runAccountRevision': 'accountRevision',
          'runAccountSha256': 'accountSha256',
          'inputSha256': 'inputSha256',
          'projectId': 'projectId',
          'projectTaskIds': 'projectTaskIds',
        }.entries) {
          accountRequire(
            accountCanonical(accepted[entry.key]) ==
                accountCanonical(original![entry.value]),
          );
        }
      }
      final outcome = {
        'status': intent.start ? 'in_progress' : request['status'],
        'summary': intent.start ? '' : request['summary'],
        'artifactReceipts': intent.start
            ? <Object>[]
            : request['artifactReceipts'],
        'nextAction': intent.start
            ? intent.definition['defaultNextAction']
            : request['nextAction'],
        'recordedByActorId': 'actor:${intent.owner.userId}',
        'recordedAt': accepted['acceptedAt'],
      };
      accountRequire(
        accepted['outcomeReceiptSha256'] == await accountSha(outcome),
      );
      await accountDigest(accepted, 'acceptanceSha256');
      accountRequire(
        (current['revision'] as int) >=
                (request['expectedAccountRevision'] as int) &&
            (current['revision'] != request['expectedAccountRevision'] ||
                current['accountSha256'] == request['expectedAccountSha256']),
      );
      if (mutation && row['replayed'] == false) {
        accountRequire(
          current['revision'] == request['expectedAccountRevision'] &&
              current['accountSha256'] == request['expectedAccountSha256'],
        );
      }
    }
    if (mutation) {
      final receipt = accountMap(row['serviceReceipt']);
      accountKeys(receipt, [
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
      ]);
      accountRequire(
        receipt['schemaVersion'] == 1 &&
            receipt['receiptKind'] == 'app_service_receipt' &&
            receipt['boundaryVersion'] == accountBoundary &&
            receipt['operation'] ==
                (intent.start
                    ? 'app.customer_accounts.workflows.start'
                    : 'app.customer_accounts.workflows.outcome.record') &&
            receipt['action'] ==
                (intent.start ? 'run.agent' : 'manage.workflow') &&
            receipt['resourceType'] ==
                (intent.start
                    ? 'customer_success_workflow'
                    : 'customer_success_workflow_outcome') &&
            receipt['accessMode'] == 'mutation' &&
            receipt['eventContract'] ==
                (intent.start
                    ? 'customer-success-workflow-events.v1+projects.atomic-events.v1'
                    : 'customer-success-workflow-events.v1') &&
            receipt['resourceCount'] == 1 &&
            receipt['authoritySha256'] == await intent.authorityHash() &&
            receipt['idempotencyKeySha256'] ==
                intent.identity['idempotencyKeySha256'] &&
            receipt['outcomeSha256'] ==
                await accountSha({...row}..remove('serviceReceipt')),
      );
      accountDate(receipt['occurredAt']);
      await accountDigest(receipt, 'receiptSha256');
    } else {
      await accountReadReceipt(
        row,
        intent.owner,
        'app.customer_accounts.workflows.mutations.show',
        'customer_success_workflow',
        accepted == null ? 0 : 1,
      );
    }
    return AccountWorkflowAcceptance._(
      accountFreeze(row),
      current,
      accepted == null ? null : accountFreeze(accepted),
    );
  }
}

class AccountWorkflowRun {
  const AccountWorkflowRun._(
    this.raw,
    this.context,
    this.run,
    this.definition,
    this.progress,
  );
  final AccountJson raw, run, progress;
  final AccountJson? definition;
  final AccountContext context;
  static Future<AccountWorkflowRun> parse(
    Object? value,
    AccountsOwner owner,
    String workspace,
    String account,
    String runId,
  ) async {
    accountId(runId, 'customer-success-run');
    final row = accountMap(value);
    accountRequire(utf8.encode(jsonEncode(row)).length <= 1048576);
    accountKeys(row, [
      'contract',
      'context',
      'currentAccount',
      'run',
      'definition',
      'definitionAvailability',
      'projectProgress',
      'serviceReceipt',
    ]);
    accountRequire(row['contract'] == accountWorkflowReadContract);
    final context = AccountContext.parse(
          row['context'],
          workspaceId: workspace,
        ),
        current = _currentAccount(row['currentAccount'], account);
    final run = accountMap(row['run']),
        definition = row['definition'] == null
            ? null
            : accountMap(row['definition']);
    accountRequire(
      run['runId'] == runId &&
          (definition == null
              ? row['definitionAvailability'] == 'unavailable'
              : row['definitionAvailability'] == 'available'),
    );
    await validateAccountWorkflowData(
      {
        'pack': [?definition],
        'runs': [run],
      },
      owner,
      workspace,
      account,
      completePack: false,
      exactOwner: true,
    );
    accountRequire(
      (current['revision'] as int) >= (run['accountRevision'] as int) &&
          (current['revision'] != run['accountRevision'] ||
              current['accountSha256'] == run['accountSha256']),
    );
    final progress = accountMap(row['projectProgress']);
    if (progress['state'] == 'unavailable') {
      accountKeys(progress, ['state']);
    } else {
      accountKeys(progress, [
        'state',
        'projectId',
        'status',
        'autonomyMode',
        'executionStatus',
        'tasks',
        'artifacts',
        'artifactsMayBeIncomplete',
      ]);
      accountRequire(
        progress['state'] == 'available' &&
            progress['projectId'] == run['projectId'],
      );
      accountEnum(progress['status'], [
        'draft',
        'active',
        'completed',
        'archived',
      ]);
      accountEnum(progress['autonomyMode'], [
        'manual',
        'supervised',
        'autonomous',
      ]);
      accountEnum(progress['executionStatus'], [
        'idle',
        'running',
        'paused',
        'waiting_approval',
        'completed',
        'failed',
      ]);
      accountBool(progress['artifactsMayBeIncomplete']);
      final tasks = accountList(progress['tasks'], 20, accountMap),
          artifacts = accountList(progress['artifacts'], 100, accountMap);
      accountUnique(tasks.map((task) => accountId(task['id'])));
      accountUnique(artifacts.map((item) => accountId(item['id'])));
      for (final task in tasks) {
        accountKeys(task, ['id', 'title', 'status']);
        accountRequire(
          task['title'] is String &&
              (task['title'] as String).length <= 500 &&
              (run['projectTaskIds'] as List).any(
                (mapping) => mapping['projectTaskId'] == task['id'],
              ),
        );
        accountEnum(task['status'], ['open', 'doing', 'done']);
      }
      for (final artifact in artifacts) {
        accountKeys(artifact, ['id', 'title', 'status', 'evidenceRefs']);
        accountRequire(
          artifact['title'] is String &&
              (artifact['title'] as String).length <= 500,
        );
        accountEnum(artifact['status'], ['verified', 'failed']);
        accountList(artifact['evidenceRefs'], 100, accountId);
      }
    }
    await accountReadReceipt(
      row,
      owner,
      'app.customer_accounts.workflows.show',
      'customer_success_workflow',
      1,
    );
    return AccountWorkflowRun._(
      accountFreeze(row),
      context,
      accountFreeze(run),
      definition == null ? null : accountFreeze(definition),
      accountFreeze(progress),
    );
  }
}
