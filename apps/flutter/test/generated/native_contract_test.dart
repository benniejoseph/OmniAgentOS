import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'publishes exact private Memory promotion review and recovery paths',
    () {
      expect(
        NativeContract.supportsOperation('memory.promotions.decide'),
        isTrue,
      );
      expect(NativePaths.memoryPromotionsDecide, '/api/memory/promotions');
      expect(
        NativePaths.memoryPromotionsList(status: 'pending', limit: 25),
        '/api/memory/promotions?status=pending&limit=25',
      );
      expect(
        NativePaths.memoryPromotionsRead(
          'review:one',
          acceptanceKeySha256: 'a' * 64,
        ),
        '/api/memory/promotions/review%3Aone?acceptanceKeySha256=${'a' * 64}',
      );
    },
  );
  test('publishes exact Account health evaluation and recovery paths', () {
    expect(
      NativeContract.supportsOperation('customers.health.evaluate'),
      isTrue,
    );
    expect(
      NativeContract.supportsOperation('customers.health.evaluations.get'),
      isTrue,
    );
    expect(
      NativePaths.customersHealthEvaluate('customer-account:one'),
      '/api/customer-accounts/customer-account%3Aone/health',
    );
    expect(
      NativePaths.customersHealthEvaluationsGet(
        'customer-account:one',
        'customer-health-evaluation:two',
        workspaceId: 'workspace:one',
      ),
      '/api/customer-accounts/customer-account%3Aone/health/evaluations/customer-health-evaluation%3Atwo?workspaceId=workspace%3Aone',
    );
  });

  test('retains current and previous contract compatibility', () {
    expect(NativeContract.currentVersion, 47);
    expect(NativeContract.previousVersion, 46);
    expect(NativeContract.supportedVersions, [47, 46]);
    expect(NativeContract.supports(44), isFalse);
    expect(NativeContract.supports(43), isFalse);
    expect(NativeContract.supports(42), isFalse);
    expect(NativeContract.supports(45), isFalse);
    expect(NativeContract.supports(46), isTrue);
    expect(NativeContract.supports(47), isTrue);
    expect(
      NativePaths.meetingsList(
        workspaceId: 'workspace:one',
        status: 'scheduled',
        limit: 100,
      ),
      '/api/meetings?workspaceId=workspace%3Aone&status=scheduled&limit=100',
    );
    expect(
      NativePaths.meetingsGet('meeting:one', workspaceId: 'workspace:one'),
      '/api/meetings/meeting%3Aone?workspaceId=workspace%3Aone',
    );
    expect(
      NativePaths.meetingsCommitmentsList(
        'meeting:one',
        workspaceId: 'workspace:one',
      ),
      '/api/meetings/meeting%3Aone/commitments?workspaceId=workspace%3Aone',
    );
    expect(NativePaths.meetingsCreate, '/api/meetings');
    expect(
      NativePaths.meetingsUpdate('meeting:one'),
      '/api/meetings/meeting%3Aone',
    );
    expect(
      NativePaths.meetingsCommitmentsPropose('meeting:one'),
      '/api/meetings/meeting%3Aone/commitments',
    );
    expect(
      NativePaths.meetingsCommitmentsResolve('meeting:one'),
      '/api/meetings/meeting%3Aone/commitments',
    );
    expect(
      NativePaths.workspacesTasksUpdate('project one', 'task/two'),
      '/api/projects/project%20one/tasks/task%2Ftwo',
    );
    expect(
      NativePaths.memoryList(threadId: 'thread/one', limit: 40),
      '/api/memory?threadId=thread%2Fone&limit=40',
    );
    expect(
      NativePaths.captureAssetGet('asset one', content: true),
      '/api/capture/assets/asset%20one?content=1',
    );
    expect(
      NativePaths.artifactsContent('artifact one', version: 3),
      '/api/artifacts/artifact%20one/content?version=3',
    );
    expect(
      NativePaths.artifactsList(kind: 'presentation', limit: 50),
      '/api/artifacts?kind=presentation&limit=50',
    );
    expect(
      NativeContract.supportsOperation('evidence.run.computerFrame'),
      isFalse,
    );
    expect(NativeContract.supportsOperation('agents.council'), isTrue);
    expect(NativeContract.supportsOperation('agents.tasks.cancel'), isTrue);
    expect(NativeContract.supportsOperation('promptQueue.list'), isTrue);
    expect(NativeContract.supportsOperation('promptQueue.dispatch'), isTrue);
    expect(NativeContract.supportsOperation('agents.release.show'), isTrue);
    expect(NativeContract.supportsOperation('agents.release.manage'), isTrue);
    expect(NativeContract.supportsOperation('agents.adaptations.list'), isTrue);
    expect(
      NativeContract.supportsOperation('agents.adaptations.manage'),
      isTrue,
    );
    expect(NativeContract.supportsOperation('agents.tasks.show'), isTrue);
    expect(
      NativeContract.supportsOperation('automation.schedule.show'),
      isTrue,
    );
    expect(
      NativeContract.supportsOperation('notifications.dispositions.list'),
      isTrue,
    );
    expect(NativeContract.supportsOperation('agents.release.retire'), isFalse);
    expect(
      NativeContract.supportsOperation('voice.realtime.session.start'),
      isTrue,
    );
    expect(NativeContract.supportsOperation('voice.speech.stream'), isTrue);
    expect(NativePaths.promptQueueList, '/api/command/prompt-queue');
    expect(
      NativePaths.promptQueueDispatch('queue/one'),
      '/api/command/prompt-queue/queue%2Fone/dispatch',
    );
    expect(
      NativePaths.agentsCouncil(limit: 25),
      '/api/agents/council?limit=25',
    );
    expect(
      NativePaths.agentsTasksCancel('execution/one'),
      '/api/agents/tasks/execution%2Fone/cancel',
    );
  });

  test(
    'publishes all ten authoritative Responsibility paths with exact encoding',
    () {
      for (final operation in [
        'responsibilities.list',
        'responsibilities.create',
        'responsibilities.get',
        'responsibilities.change',
        'responsibilities.references',
        'responsibilities.lifecycle.get',
        'responsibilities.lifecycle.change',
        'responsibilities.observations.list',
        'responsibilities.notifications.get',
        'responsibilities.notifications.change',
      ]) {
        expect(NativeContract.supportsOperation(operation), isTrue);
      }
      final id = 'responsibility:${List.filled(64, 'a').join()}';
      final path = '/api/responsibilities/${Uri.encodeComponent(id)}';
      expect(NativePaths.responsibilitiesList(), '/api/responsibilities');
      expect(
        NativePaths.responsibilitiesList(limit: 100),
        '/api/responsibilities?limit=100',
      );
      expect(NativePaths.responsibilitiesCreate, '/api/responsibilities');
      expect(NativePaths.responsibilitiesGet(id), path);
      expect(
        NativePaths.responsibilitiesGet(id, view: 'review'),
        '$path?view=review',
      );
      expect(NativePaths.responsibilitiesChange(id), path);
      expect(
        NativePaths.responsibilitiesReferences,
        '/api/responsibilities/references',
      );
      expect(
        NativePaths.responsibilitiesLifecycleGet(id, view: 'activation'),
        '$path/lifecycle?view=activation',
      );
      expect(
        NativePaths.responsibilitiesLifecycleChange(id),
        '$path/lifecycle',
      );
      expect(
        NativePaths.responsibilitiesObservationsList(id, limit: 25),
        '$path/observations?limit=25',
      );
      expect(
        NativePaths.responsibilitiesNotificationsGet(id, view: 'enable'),
        '$path/notifications?view=enable',
      );
      expect(
        NativePaths.responsibilitiesNotificationsChange(id),
        '$path/notifications',
      );
      expect(
        NativeContract.supportsOperation(
          'responsibilities.observations.create',
        ),
        isFalse,
      );
      expect(
        NativeContract.supportsOperation('responsibilities.notifications.send'),
        isFalse,
      );
    },
  );

  test('publishes exact private Memory review paths', () {
    for (final operation in [
      'memory.reconciliation.list',
      'memory.reconciliation.read',
      'memory.reconciliation.resolve',
    ]) {
      expect(NativeContract.supportsOperation(operation), isTrue);
    }
    expect(
      NativePaths.memoryReconciliationList(
        contract: 'asael-memory-reconciliation-read:1',
        status: 'pending',
        limit: 50,
      ),
      '/api/memory/reconciliation?contract=asael-memory-reconciliation-read%3A1&status=pending&limit=50',
    );
    final key = List.filled(64, 'a').join();
    expect(
      NativePaths.memoryReconciliationRead(
        'review:one',
        acceptanceKeySha256: key,
      ),
      '/api/memory/reconciliation/review%3Aone?acceptanceKeySha256=$key',
    );
    expect(
      NativePaths.memoryReconciliationResolve,
      '/api/memory/reconciliation',
    );
  });

  test('publishes exact consent and calendar recovery paths', () {
    final key = List.filled(64, 'a').join();
    expect(
      NativePaths.memoryPersonalContextConsentGet(
        contract: 'asael-personal-context-consent-read:1',
      ),
      '/api/memory/personal-context-consent?contract=asael-personal-context-consent-read%3A1',
    );
    expect(
      NativePaths.memoryPersonalContextConsentDecide,
      '/api/memory/personal-context-consent',
    );
    expect(
      NativePaths.memoryPersonalContextConsentDecisionGet(key),
      '/api/memory/personal-context-consent/decisions/$key',
    );
    expect(NativePaths.meetingsCalendarGet, '/api/meetings/calendar');
    expect(NativePaths.meetingsCalendarSync, '/api/meetings/calendar/sync');
    expect(
      NativePaths.meetingsCalendarSyncGet(
        'meeting-calendar-sync:$key',
        acceptanceKeySha256: key,
      ),
      '/api/meetings/calendar/sync/meeting-calendar-sync%3A$key?acceptanceKeySha256=$key',
    );
  });

  test('verifies advertised server compatibility with legacy fallback', () {
    expect(
      () => NativeContract.verifyBootstrap(const <String, dynamic>{}),
      returnsNormally,
    );
    expect(
      () => NativeContract.verifyBootstrap({
        'api': {
          'nativeContract': {
            'id': NativeContract.id,
            'supportedVersions': NativeContract.supportedVersions,
          },
        },
      }),
      returnsNormally,
    );
    // A service that has not published this client's contract yet.
    expect(
      () => NativeContract.verifyBootstrap({
        'api': {
          'nativeContract': {
            'id': NativeContract.id,
            'supportedVersions': [
              NativeContract.previousVersion,
              NativeContract.previousVersion - 1,
            ],
          },
        },
      }),
      throwsFormatException,
    );
    expect(
      () => NativeContract.verifyBootstrap({
        'api': {
          'nativeContract': {
            'id': NativeContract.id,
            'supportedVersions': [13, 12],
          },
        },
      }),
      throwsFormatException,
    );
  });

  test('publishes the native Automation Studio operations', () {
    expect(NativeContract.supportsOperation('integrations.overview'), isTrue);
    expect(NativeContract.supportsOperation('plugins.preview'), isTrue);
    expect(NativeContract.supportsOperation('plugins.install'), isTrue);
    expect(NativeContract.supportsOperation('plugins.change'), isTrue);
    expect(NativeContract.supportsOperation('plugins.uninstall'), isTrue);
    expect(NativePaths.integrationsOverview(), '/api/integrations/overview');
    expect(NativePaths.pluginsPreview, '/api/plugins/preview');
    expect(NativePaths.pluginsInstall, '/api/plugins/install');
    expect(
      NativePaths.pluginsChange('installation/one'),
      '/api/plugins/installation%2Fone',
    );
    expect(
      NativePaths.pluginsUninstall('installation/one'),
      '/api/plugins/installation%2Fone',
    );
  });

  test('retains scoped search paths with exact result encoding', () {
    for (final operation in [
      'content.search',
      'content.search.work.get',
      'content.search.memory.get',
    ]) {
      expect(NativeContract.supportsOperation(operation), isTrue);
    }
    expect(
      NativePaths.contentSearch(
        q: 'budget',
        provider: 'work',
        cursor: 'cursor:one',
      ),
      '/api/content-search?q=budget&provider=work&cursor=cursor%3Aone',
    );
    expect(
      NativePaths.contentSearchWorkGet('project:one', task: 'task:two'),
      '/api/content-search/work/project%3Aone?task=task%3Atwo',
    );
    expect(
      NativePaths.contentSearchMemoryGet('memory:one'),
      '/api/content-search/memory/memory%3Aone',
    );
  });

  test('publishes reviewed connector and Google action recovery paths', () {
    for (final operation in [
      'google.personal.actions.review',
      'google.personal.actions.submit',
      'google.personal.actions.read',
      'connectors.native.list',
      'connectors.native.review',
      'connectors.native.act',
      'connectors.native.actions.get',
    ]) {
      expect(NativeContract.supportsOperation(operation), isTrue);
    }
    final key = List.filled(64, 'a').join();
    expect(
      NativePaths.googlePersonalActionsReview,
      '/api/oauth/google/actions',
    );
    expect(
      NativePaths.googlePersonalActionsSubmit,
      '/api/oauth/google/actions',
    );
    expect(
      NativePaths.googlePersonalActionsRead(key),
      '/api/oauth/google/actions/$key',
    );
    expect(NativePaths.connectorsNativeList, '/api/connectors/native');
    for (final kind in ['mcp', 'openapi']) {
      expect(
        NativePaths.connectorsNativeReview(kind, 'connector:one'),
        '/api/connectors/native/$kind/connector%3Aone/review',
      );
    }
    expect(NativePaths.connectorsNativeAct, '/api/connectors/native/actions');
    expect(
      NativePaths.connectorsNativeActionsGet(key),
      '/api/connectors/native/actions/$key',
    );
  });

  test('publishes separate exact saved credential removal recovery paths', () {
    expect(
      NativeContract.supportsOperation(
        'connectors.native.credentialRemovals.submit',
      ),
      isTrue,
    );
    expect(
      NativeContract.supportsOperation(
        'connectors.native.credentialRemovals.read',
      ),
      isTrue,
    );
    expect(
      NativePaths.connectorsNativeCredentialRemovalsSubmit,
      '/api/connectors/native/credential-removals',
    );
    final key = List.filled(64, 'b').join();
    expect(
      NativePaths.connectorsNativeCredentialRemovalsRead(key),
      '/api/connectors/native/credential-removals/$key',
    );
  });

  test('publishes exact MCP Trash preview and independent receipt paths', () {
    for (final operation in [
      'connectors.native.trash.preview',
      'connectors.native.trash.submit',
      'connectors.native.trash.read',
    ]) {
      expect(NativeContract.supportsOperation(operation), isTrue);
    }
    expect(
      NativePaths.connectorsNativeTrashPreview('connector:one'),
      '/api/connectors/native/mcp/connector%3Aone/trash-preview',
    );
    expect(
      NativePaths.connectorsNativeTrashSubmit,
      '/api/connectors/native/trash-actions',
    );
    final key = List.filled(64, 'c').join();
    expect(
      NativePaths.connectorsNativeTrashRead(key),
      '/api/connectors/native/trash-actions/$key',
    );
  });

  test(
    'publishes exact MCP discovery submission recovery and owner close paths',
    () {
      for (final operation in [
        'connectors.native.mcpDiscoveries.submit',
        'connectors.native.mcpDiscoveries.read',
        'connectors.native.mcpDiscoveries.close',
      ]) {
        expect(NativeContract.supportsOperation(operation), isTrue);
      }
      final key = 'd' * 64;
      expect(
        NativePaths.connectorsNativeMcpDiscoveriesSubmit,
        '/api/connectors/native/mcp-discoveries',
      );
      expect(
        NativePaths.connectorsNativeMcpDiscoveriesRead(key),
        '/api/connectors/native/mcp-discoveries/$key',
      );
      expect(
        NativePaths.connectorsNativeMcpDiscoveriesClose(key),
        '/api/connectors/native/mcp-discoveries/$key/close',
      );
    },
  );

  test('publishes authenticated generated artifact inventory and bytes', () {
    expect(NativeContract.supportsOperation('artifacts.list'), isTrue);
    expect(NativeContract.supportsOperation('artifacts.content'), isTrue);
    expect(
      NativePaths.artifactsContent('artifact/one'),
      '/api/artifacts/artifact%2Fone/content',
    );
  });

  test('rejects unknown and mismatched stream event discriminants', () {
    expect(
      NativeConversationEvents.parse('delta', {'type': 'delta', 'text': 'ok'}),
      containsPair('text', 'ok'),
    );
    expect(
      () => NativeConversationEvents.parse('delta', {
        'type': 'done',
        'response': 'not a delta',
      }),
      throwsFormatException,
    );
    expect(
      () => NativeConversationEvents.parse('invented', {'type': 'invented'}),
      throwsFormatException,
    );
  });
}
