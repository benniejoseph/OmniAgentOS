import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'meetings.dart';
import 'meetings_api_repository.dart';

final meetingsRepositoryProvider = Provider<MeetingsRepository>(
  (ref) => ApiMeetingsRepository(ref.watch(apiClientProvider)),
);

final meetingsControllerProvider = ChangeNotifierProvider<MeetingsController>(
  (ref) => MeetingsController(ref.watch(meetingsRepositoryProvider))..refresh(),
);
