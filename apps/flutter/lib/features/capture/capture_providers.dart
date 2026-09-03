import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'capture.dart';
import 'capture_api_repository.dart';

final captureRepositoryProvider = Provider<CaptureRepository>(
  (ref) => ApiCaptureRepository(ref.watch(apiClientProvider)),
);
final captureControllerProvider = ChangeNotifierProvider<CaptureController>(
  (ref) => CaptureController(ref.watch(captureRepositoryProvider)),
);
