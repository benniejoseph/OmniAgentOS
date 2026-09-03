import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'today.dart';
import 'today_api_repository.dart';

final todayRepositoryProvider = Provider<TodayRepository>(
  (ref) => ApiTodayRepository(ref.watch(apiClientProvider)),
);
final todayControllerProvider = ChangeNotifierProvider<TodayController>(
  (ref) => TodayController(ref.watch(todayRepositoryProvider))..refresh(),
);
