import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'missions.dart';
import 'missions_api_repository.dart';

final missionsRepositoryProvider = Provider<MissionsRepository>(
  (ref) => ApiMissionsRepository(ref.watch(apiClientProvider)),
);
final missionsControllerProvider = ChangeNotifierProvider<MissionsController>(
  (ref) => MissionsController(ref.watch(missionsRepositoryProvider))..refresh(),
);
