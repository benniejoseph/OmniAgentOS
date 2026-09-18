import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('retains current and previous contract compatibility', () {
    expect(NativeContract.currentVersion, 15);
    expect(NativeContract.previousVersion, 14);
    expect(NativeContract.supportedVersions, [15, 14]);
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
      NativeContract.supportsOperation('evidence.run.computerFrame'),
      isFalse,
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
            'supportedVersions': [15, 14],
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
