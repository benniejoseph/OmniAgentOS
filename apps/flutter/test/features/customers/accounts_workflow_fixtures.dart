import 'dart:async';

import 'package:asael/features/customers/accounts_advanced_contracts.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:asael/features/customers/accounts_workflow_contracts.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

AccountJson workflowInput() => {
  'workflowId': 'onboarding',
  'objective': 'Prepare a reviewed customer onboarding plan',
  'targetDate': null,
  'successCriteria': ['Review the first milestone'],
  'productNames': <String>[],
  'stakeholderIds': <String>[],
};
Future<AccountJson> workflowDefinition() => sealAccount({
  'schemaVersion': 1,
  'contractVersion': 'p10.13-customer-success-workflow:1',
  'packVersion': 'asael-csm-pack:1',
  'workflowId': 'onboarding',
  'name': 'Customer onboarding',
  'description': 'Prepare a reviewed plan.',
  'inputFields': [
    {
      'fieldId': 'objective',
      'label': 'Objective',
      'valueType': 'text',
      'required': true,
      'allowedValues': <String>[],
    },
    {
      'fieldId': 'targetDate',
      'label': 'Target date',
      'valueType': 'timestamp',
      'required': false,
      'allowedValues': <String>[],
    },
    {
      'fieldId': 'successCriteria',
      'label': 'Success criteria',
      'valueType': 'text_list',
      'required': true,
      'allowedValues': <String>[],
    },
    {
      'fieldId': 'productNames',
      'label': 'Products',
      'valueType': 'text_list',
      'required': false,
      'allowedValues': <String>[],
    },
    {
      'fieldId': 'stakeholderIds',
      'label': 'Stakeholders',
      'valueType': 'id_list',
      'required': false,
      'allowedValues': <String>[],
    },
  ],
  'acceptanceCriteria': ['Owned next checkpoint'],
  'artifacts': [
    {
      'artifactKey': 'success_plan',
      'title': 'Success plan',
      'description': 'The reviewed plan',
      'required': true,
    },
  ],
  'evidenceRequirements': [
    {
      'evidenceKey': 'account_snapshot',
      'title': 'Account evidence',
      'description': 'Cite current facts',
      'required': true,
      'allowedSourceKinds': ['account_fact'],
    },
  ],
  'projectTemplate': {
    'title': 'Customer plan',
    'objective': 'Review the customer plan',
    'status': 'active',
    'tasks': [
      {
        'key': 'plan',
        'title': 'Build the plan',
        'detail': 'Create a reviewed artifact',
        'priority': 'medium',
        'agentId': 'atlas',
        'dependsOnKeys': <String>[],
      },
    ],
  },
  'defaultNextAction': 'Review current evidence.',
  'externalActionPolicy': {
    'communicationMode': 'draft_only_until_governed_delivery',
    'crmMode': 'proposal_only_until_governed_write',
    'allowedCommunicationToolIds': ['app.communications.drafts.create'],
    'allowedCrmToolIdPrefixes': ['app.customer_accounts.salesforce.'],
    'directExternalEffectsAllowed': false,
  },
}, 'definitionSha256');

Future<AccountWorkflowIntent> workflowIntent({
  String key = 'workflow-key',
  CustomerAccountSummary? account,
  AccountJson? run,
}) async => AccountWorkflowIntent.prepare(
  healthOwner,
  accountWorkspace,
  key,
  account ?? await healthAccount(),
  await workflowDefinition(),
  run == null
      ? workflowInput()
      : {
          'status': 'blocked',
          'summary': 'Missing current evidence.',
          'artifactReceipts': <Object>[],
          'nextAction': 'Read new evidence.',
        },
  run: run,
);

Future<AccountJson> workflowRun(AccountWorkflowIntent intent) async {
  final previous = intent.reviewedRun,
      request = intent.request,
      revision = intent.start ? 1 : (request['expectedRunRevision'] as int) + 1;
  final input = intent.start ? request['input'] : previous!['input'];
  final outcome = await sealAccount({
    'status': intent.start ? 'in_progress' : request['status'],
    'summary': intent.start ? '' : request['summary'],
    'artifactReceipts': intent.start ? <Object>[] : request['artifactReceipts'],
    'nextAction': intent.start
        ? intent.definition['defaultNextAction']
        : request['nextAction'],
    'recordedByActorId': 'actor:$accountUser',
    'recordedAt': accountStamp,
  }, 'receiptSha256');
  return sealAccount({
    'schemaVersion': 1,
    'contractVersion': 'p10.13-customer-success-workflow:1',
    'tenantId': accountTenant,
    'workspaceId': accountWorkspace,
    'accountId': intent.account,
    'accountRevisionId':
        previous?['accountRevisionId'] ??
        '${intent.account}:v${request['expectedAccountRevision']}',
    'accountRevision':
        previous?['accountRevision'] ?? request['expectedAccountRevision'],
    'accountSha256':
        previous?['accountSha256'] ?? request['expectedAccountSha256'],
    'runId': intent.runId,
    'runRevisionId': '${intent.runId}:v$revision',
    'revision': revision,
    'previousRunRevisionId': revision == 1
        ? null
        : '${intent.runId}:v${revision - 1}',
    'workflowId': 'onboarding',
    'definitionSha256': intent.definition['definitionSha256'],
    'input': input,
    'inputSha256': await accountSha(input),
    'owner': {
      'ownerKind': 'actor',
      'ownerId': 'actor:$accountUser',
      'displayName': 'Owner',
    },
    'ownerActorId': 'actor:$accountUser',
    'projectId': 'project:workflow-fixture',
    'projectTaskIds': [
      {'taskKey': 'plan', 'projectTaskId': 'task:plan'},
    ],
    'allowedPurposeIds': ['customer_success.account.read'],
    'outcome': outcome,
  }, 'runSha256');
}

Future<AccountJson> workflowAcceptance(AccountWorkflowIntent intent) async {
  final run = await workflowRun(intent), request = intent.request;
  return sealAccount({
    'schemaVersion': 1,
    'contract': 'customer-success-workflow-acceptance:1',
    for (final field in [
      'operation',
      'tenantId',
      'workspaceId',
      'accountId',
      'runId',
      'canonicalActorId',
      'idempotencyKeySha256',
    ])
      field: intent.identity[field],
    'requestSha256': intent.requestSha256,
    'reviewedAccountRevisionId':
        '${intent.account}:v${request['expectedAccountRevision']}',
    'reviewedAccountRevision': request['expectedAccountRevision'],
    'reviewedAccountSha256': request['expectedAccountSha256'],
    'runAccountRevisionId': run['accountRevisionId'],
    'runAccountRevision': run['accountRevision'],
    'runAccountSha256': run['accountSha256'],
    for (final field in [
      'workflowId',
      'definitionSha256',
      'inputSha256',
      'runRevisionId',
      'runSha256',
      'projectId',
      'projectTaskIds',
    ])
      field: run[field],
    'runRevision': run['revision'],
    'outcomeStatus': run['outcome']['status'],
    'outcomeReceiptSha256': run['outcome']['receiptSha256'],
    'acceptedAt': accountStamp,
    'effectAuthority': 'none',
  }, 'acceptanceSha256');
}

Future<AccountJson> workflowResponse(
  AccountWorkflowIntent intent, {
  bool mutation = true,
  bool found = true,
  bool replayed = false,
  CustomerAccountSummary? current,
  AccountJson? acceptance,
}) async {
  final body = <String, dynamic>{
    'contract': accountWorkflowReadContract,
    'context': healthContext(),
    'currentAccount': {
      'accountId': intent.account,
      'revisionId':
          current?.revisionId ??
          '${intent.account}:v${intent.request['expectedAccountRevision']}',
      'revision':
          current?.revision ?? intent.request['expectedAccountRevision'],
      'accountSha256':
          current?.sha256 ?? intent.request['expectedAccountSha256'],
    },
    'acceptance': found ? acceptance ?? await workflowAcceptance(intent) : null,
    if (mutation) 'replayed': replayed,
  };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': accountBoundary,
    'operation': mutation
        ? intent.start
              ? 'app.customer_accounts.workflows.start'
              : 'app.customer_accounts.workflows.outcome.record'
        : 'app.customer_accounts.workflows.mutations.show',
    'action': mutation
        ? intent.start
              ? 'run.agent'
              : 'manage.workflow'
        : 'read',
    'resourceType': mutation && !intent.start
        ? 'customer_success_workflow_outcome'
        : 'customer_success_workflow',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? intent.start
              ? 'customer-success-workflow-events.v1+projects.atomic-events.v1'
              : 'customer-success-workflow-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': mutation
        ? await intent.authorityHash()
        : await accountSha({
            'boundaryVersion': accountBoundary,
            'tenantId': intent.owner.tenantId,
            'actorId': intent.owner.actorId,
            'role': intent.owner.role,
            'executionScope': null,
          }),
    'idempotencyKeySha256': mutation
        ? intent.identity['idempotencyKeySha256']
        : null,
    'outcomeSha256': await accountSha(body),
    'resourceCount': found ? 1 : 0,
    'occurredAt': accountStamp,
  };
  return {
    ...body,
    'serviceReceipt': await sealAccount(receipt, 'receiptSha256'),
  };
}

class WorkflowRepository extends Fake
    implements
        AccountsRepository,
        AccountsAdvancedRepository,
        AccountsWorkflowRepository,
        AccountsMutationRepository {
  WorkflowRepository(this.account, this.definition);
  CustomerAccountSummary account;
  final AccountJson definition;
  @override
  final access = AccountsAccess(
    owner: healthOwner,
    ready: true,
    operations: const {
      'customers.get',
      'customers.workflows',
      'customers.workflows.start',
      'customers.workflows.outcome',
      'customers.workflows.get',
      'customers.workflows.mutations.get',
    },
  );
  @override
  bool authorityCurrent() => access.readable;
  Object? writeFailure;
  bool found = true;
  final writes = <AccountWorkflowIntent>[],
      recoveries = <AccountWorkflowIntent>[];
  Completer<CustomerDetail>? heldDetail;
  Future<void> Function(AccountWorkflowIntent)? beforeWrite;
  @override
  Future<CustomerDetail> detail(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) => heldDetail?.future ?? healthDetail(account);
  @override
  Future<AccountAdvancedRead> advanced(
    AccountAdvancedKind kind,
    CancelToken cancel, {
    required String workspaceId,
    String? accountId,
  }) async => AccountAdvancedRead(kind, {
    'pack': [definition],
    'runs': <Object>[],
  }, AccountContext.parse(healthContext(), workspaceId: workspaceId));
  @override
  Future<AccountWorkflowAcceptance> mutateWorkflow(
    AccountWorkflowIntent intent, {
    required bool Function() isCurrent,
  }) async {
    await beforeWrite?.call(intent);
    accountRequire(isCurrent());
    writes.add(intent);
    if (writeFailure != null) {
      throw writeFailure!;
    }
    return AccountWorkflowAcceptance.parse(
      await workflowResponse(intent),
      intent,
      mutation: true,
    );
  }

  @override
  Future<AccountWorkflowAcceptance> readWorkflowAcceptance(
    AccountWorkflowIntent intent,
    CancelToken cancel,
  ) async {
    recoveries.add(intent);
    return AccountWorkflowAcceptance.parse(
      await workflowResponse(
        intent,
        mutation: false,
        found: found,
        current: account,
      ),
      intent,
      mutation: false,
    );
  }
}
