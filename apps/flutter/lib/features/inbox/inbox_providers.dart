import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'inbox.dart';
import 'inbox_api_repository.dart';

final inboxRepositoryProvider = Provider<InboxRepository>(
  (ref) => ApiInboxRepository(ref.watch(apiClientProvider)),
);
final inboxControllerProvider = ChangeNotifierProvider<InboxController>(
  (ref) => InboxController(ref.watch(inboxRepositoryProvider))..refresh(),
);
