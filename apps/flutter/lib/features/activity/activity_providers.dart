import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../auth/application/session_controller.dart';
import 'activity.dart';
import 'activity_api_repository.dart';

final activityRepositoryProvider = Provider<ActivityRepository>(
  (ref) => ApiActivityRepository(ref.watch(apiClientProvider)),
);
final activityControllerProvider = ChangeNotifierProvider<ActivityController>((
  ref,
) {
  final owner = ref.watch(sessionOwnerKeyProvider);
  ref.watch(sessionControllerProvider.select((state) => state.value?.role));
  final controller = ActivityController(ref.watch(activityRepositoryProvider));
  if (owner != null) unawaited(controller.refresh());
  return controller;
});
