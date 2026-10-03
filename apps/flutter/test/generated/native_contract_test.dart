import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('retains current and previous contract compatibility', () {
    expect(NativeContract.currentVersion, 32);
    expect(NativeContract.previousVersion, 31);
    expect(NativeContract.supportedVersions, [32, 31]);
    expect(NativeContract.supports(30), isFalse);
    expect(NativeContract.supports(33), isFalse);
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

  test('publishes all ten authoritative Responsibility paths with exact encoding', () {
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
    expect(NativePaths.responsibilitiesGet(id, view: 'review'), '$path?view=review');
    expect(NativePaths.responsibilitiesChange(id), path);
    expect(NativePaths.responsibilitiesReferences, '/api/responsibilities/references');
    expect(
      NativePaths.responsibilitiesLifecycleGet(id, view: 'activation'),
      '$path/lifecycle?view=activation',
    );
    expect(NativePaths.responsibilitiesLifecycleChange(id), '$path/lifecycle');
    expect(
      NativePaths.responsibilitiesObservationsList(id, limit: 25),
      '$path/observations?limit=25',
    );
    expect(
      NativePaths.responsibilitiesNotificationsGet(id, view: 'enable'),
      '$path/notifications?view=enable',
    );
    expect(NativePaths.responsibilitiesNotificationsChange(id), '$path/notifications');
    expect(NativeContract.supportsOperation('responsibilities.observations.create'), isFalse);
    expect(NativeContract.supportsOperation('responsibilities.notifications.send'), isFalse);
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
