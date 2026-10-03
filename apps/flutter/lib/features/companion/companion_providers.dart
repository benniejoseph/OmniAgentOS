import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/config/app_config.dart';
import '../../core/network/api_client.dart';
import '../auth/application/session_controller.dart';
import 'companion_controller.dart';
import 'companion_models.dart';
import 'companion_repository.dart';

final companionDeploymentProvider = Provider<String>(
  (_) => AppConfig.apiBaseUrl,
);
final companionScopeProvider = Provider<CompanionScope?>((ref) {
  final deployment = ref.watch(companionDeploymentProvider);
  final owner = ref.watch(sessionOwnerKeyProvider);
  final role = ref.watch(
    sessionControllerProvider.select((value) => value.value?.role),
  );
  if (owner == null || role == null) return null;
  return (
    deployment: deployment,
    tenantId: owner.tenantId,
    actorId: owner.actorId,
    role: role,
  );
});

final companionRepositoryProvider = Provider<CompanionRepository>((ref) {
  final scope = ref.watch(companionScopeProvider);
  final api = ref.watch(apiClientProvider);
  return scope == null
      ? const _UnavailableCompanionRepository()
      : ApiCompanionRepository(api, scope);
});
final companionControllerProvider = ChangeNotifierProvider<CompanionController>(
  (ref) {
    final scope = ref.watch(companionScopeProvider);
    final controller = CompanionController(
      ref.watch(companionRepositoryProvider),
    );
    if (scope != null) unawaited(controller.refresh());
    return controller;
  },
);

class _UnavailableCompanionRepository implements CompanionRepository {
  const _UnavailableCompanionRepository();
  Never _unavailable() =>
      throw const FormatException('Sign in to read your Companion settings.');
  @override
  Future<CompanionResponse> read(CancelToken cancelToken) async =>
      _unavailable();
  @override
  Future<CompanionWritePolicy> readPolicy(CancelToken cancelToken) async =>
      _unavailable();
  @override
  Future<CompanionResponse> submit(CompanionSubmission submission) async =>
      _unavailable();
  @override
  Future<({List<CompanionConversation> threads, int omitted})> conversations(
    CancelToken cancelToken,
  ) async => _unavailable();
}
