import 'dart:async';

import 'package:asael/features/builder/builder_external_opener.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('explicit HTTPS open probes capability before one OS launch', () async {
    final order = <String>[];
    final uri = Uri.parse('https://sandbox.example.test/?token=ephemeral');
    final opener = UrlLauncherBuilderOpener(
      canOpen: (candidate) async {
        expect(candidate, uri);
        order.add('capability');
        return true;
      },
      launch: (candidate) async {
        expect(candidate, uri);
        order.add('launch');
        return true;
      },
    );
    expect(
      await opener.open(
        uri,
        isCurrent: () {
          order.add('scope');
          return true;
        },
      ),
      isTrue,
    );
    expect(order, ['scope', 'capability', 'scope', 'launch']);
  });
  test(
    'owner or reviewed target changed during capability lookup prevents launch',
    () async {
      final held = Completer<bool>();
      var current = true, launches = 0;
      final opener = UrlLauncherBuilderOpener(
        canOpen: (_) => held.future,
        launch: (_) async {
          launches++;
          return true;
        },
      );
      final opening = opener.open(
        Uri.parse('https://preview.example.test'),
        isCurrent: () => current,
      );
      current = false;
      held.complete(true);
      expect(await opening, isFalse);
      expect(launches, 0);
    },
  );
  test('unavailable host and unsafe URLs never launch', () async {
    var probes = 0, launches = 0;
    final opener = UrlLauncherBuilderOpener(
      canOpen: (_) async {
        probes++;
        return false;
      },
      launch: (_) async {
        launches++;
        return true;
      },
    );
    for (final uri in [
      'http://preview.test',
      'file:///private/secret',
      'https://user:password@preview.test',
      'javascript:alert(1)',
    ]) {
      expect(await opener.open(Uri.parse(uri), isCurrent: () => true), isFalse);
    }
    expect(probes, 0);
    expect(
      await opener.open(
        Uri.parse('https://preview.test'),
        isCurrent: () => true,
      ),
      isFalse,
    );
    expect(probes, 1);
    expect(launches, 0);
  });
}
