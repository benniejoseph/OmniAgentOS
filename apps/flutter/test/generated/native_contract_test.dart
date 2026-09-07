import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('retains current and previous contract compatibility', () {
    expect(NativeContract.currentVersion, 2);
    expect(NativeContract.previousVersion, 1);
    expect(NativeContract.supportedVersions, [2, 1]);
    expect(NativePaths.workspacesTasksUpdate('project one', 'task/two'),
        '/api/projects/project%20one/tasks/task%2Ftwo');
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
            'supportedVersions': [3, 2],
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
            'supportedVersions': [4, 3],
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
      () => NativeConversationEvents.parse(
        'delta',
        {'type': 'done', 'response': 'not a delta'},
      ),
      throwsFormatException,
    );
    expect(
      () => NativeConversationEvents.parse(
        'invented',
        {'type': 'invented'},
      ),
      throwsFormatException,
    );
  });
}
