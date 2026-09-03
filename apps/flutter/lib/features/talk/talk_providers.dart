import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'talk.dart';
import 'talk_api_repository.dart';

final talkRepositoryProvider = Provider<TalkRepository>(
  (ref) => ApiTalkRepository(ref.watch(apiClientProvider)),
);
final talkControllerProvider = ChangeNotifierProvider<TalkController>(
  (ref) => TalkController(ref.watch(talkRepositoryProvider)),
);
