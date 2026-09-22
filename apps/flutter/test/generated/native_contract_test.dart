import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('retains current and previous contract compatibility', () {
    expect(NativeContract.currentVersion, 24);
    expect(NativeContract.previousVersion, 23);
    expect(NativeContract.supportedVersions, [24, 23]);
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
            'supportedVersions': [24, 23],
          },
        },
      }),
      returnsNormally,
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
