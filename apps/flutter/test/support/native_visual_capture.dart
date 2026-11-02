import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Optional review images, not pixel-baseline or physical-device evidence.
/// Load the shipped fonts so Flutter's test font cannot masquerade as UI.
Future<void> loadNativeReviewFont() async {
  if (Platform.environment['ASAEL_UI_CAPTURE_DIR'] == null) return;
  final poppins = FontLoader('Poppins');
  for (final face in ['Regular', 'Medium', 'SemiBold', 'Italic']) {
    poppins.addFont(rootBundle.load('assets/fonts/poppins/Poppins-$face.ttf'));
  }
  await poppins.load();
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
