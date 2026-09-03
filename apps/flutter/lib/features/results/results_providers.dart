import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'results.dart';
import 'results_api_repository.dart';

final resultsRepositoryProvider = Provider<ResultsRepository>(
  (ref) => ApiResultsRepository(ref.watch(apiClientProvider)),
);
final resultsControllerProvider = ChangeNotifierProvider<ResultsController>(
  (ref) => ResultsController(ref.watch(resultsRepositoryProvider))..refresh(),
);
