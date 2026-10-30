import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Optional review images, not pixel-baseline or physical-device evidence.
/// Keep font input explicit so the Flutter test font cannot masquerade as UI.
Future<void> loadNativeReviewFont() async {
  if (Platform.environment['ASAEL_UI_CAPTURE_DIR'] == null) return;
  final font = Platform.environment['ASAEL_UI_FONT_PATH'];
  if (font == null || !File(font).existsSync()) {
    throw StateError(
      'UI captures require ASAEL_UI_FONT_PATH to a review font.',
    );
  }
  final bytes = ByteData.sublistView(await File(font).readAsBytes());
  for (final family in ['Roboto', '.AppleSystemUIFont']) {
    final loader = FontLoader(family)..addFont(Future.value(bytes));
    await loader.load();
  }
  final icons = FontLoader('MaterialIcons')
    ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
  await icons.load();
}

Future<void> captureNativeSurface(
  WidgetTester tester,
  Key boundaryKey,
  String name,
) async {
  final output = Platform.environment['ASAEL_UI_CAPTURE_DIR'];
  if (output == null) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(boundaryKey),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      if (bytes == null) throw StateError('No image for $name');
      final directory = Directory(output)..createSync(recursive: true);
      await File('${directory.path}/$name.png').writeAsBytes(
        bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
      );
    } finally {
      image.dispose();
    }
  });
}
