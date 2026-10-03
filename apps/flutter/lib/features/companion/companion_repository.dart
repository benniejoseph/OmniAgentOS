import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'companion_controller.dart';
import 'companion_models.dart';

typedef CompanionScope = ({
  String deployment,
  String tenantId,
  String actorId,
  String role,
});

Future<String> companionOwnerDigest(String tenantId, String actorId) async {
  final digest = await Sha256().hash(
    utf8.encode('asael.companion-owner:1\u0000$tenantId\u0000$actorId'),
  );
  return digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
}

class ApiCompanionRepository implements CompanionRepository {
  ApiCompanionRepository(this.api, this.scope);
  final ApiClient api;
  final CompanionScope scope;
  late final Future<String> _digest = companionOwnerDigest(
    scope.tenantId,
    scope.actorId,
  );

  Future<CompanionJson> _headers() async => {
    'x-asael-companion-owner-sha256': await _digest,
  };

  Future<CompanionJson> _get(
    String path,
    CancelToken cancel, {
    CompanionJson? query,
  }) async {
    final headers = await _headers();
    if (cancel.isCancelled) {
      throw const FormatException('Companion read was disposed.');
    }
    return api
        .getJsonFreshCancelable(
          path,
          query: query,
          headers: headers,
          cancelToken: cancel,
        )
        .timeout(
          const Duration(seconds: 15),
          onTimeout: () {
            cancel.cancel('companion_read_timeout');
            throw const FormatException('Companion read did not finish.');
          },
        );
  }

  @override
  Future<CompanionResponse> read(CancelToken cancelToken) async =>
      CompanionResponse.fromJson(
        await _get(NativePaths.companionPreferencesGet, cancelToken),
      );

  @override
  Future<CompanionWritePolicy> readPolicy(CancelToken cancelToken) async {
    final payload = await _get(NativePaths.bootstrapGet, cancelToken);
    NativeContract.verifyBootstrap(payload);
    final context = payload['context'];
    final membership = payload['membership'];
    if (payload['authenticated'] != true ||
        context is! Map ||
        context['tenantId'] != scope.tenantId ||
        context['actorId'] != scope.actorId ||
        context['role'] != scope.role ||
        membership is! Map ||
        membership['role'] != scope.role) {
      throw const FormatException(
        'Preference access belongs to a different account.',
      );
    }
    final policy = payload['nativeClientPolicy'];
    final capabilities = policy is Map ? policy['mutationCapabilities'] : null;
    final enrollment = capabilities is Map
        ? capabilities['companion.preferences.update']
        : null;
    final permissions = payload['permissions'];
    final active =
        enrollment is Map &&
        enrollment['state'] == 'active' &&
        enrollment['minimumContractVersion'] is int &&
        (enrollment['minimumContractVersion'] as int) >= 31 &&
        (enrollment['minimumContractVersion'] as int) <=
            NativeContract.currentVersion &&
        permissions is List &&
        permissions.contains('manage.own_preferences');
    return CompanionWritePolicy(
      active: active,
      reason: active
          ? 'This installation can save your own Companion preferences.'
          : 'Preference writes are unavailable for this installation. Refresh after updating or checking account access.',
    );
  }

  @override
  Future<CompanionResponse> submit(CompanionSubmission submission) async {
    final headers = await _headers();
    headers['Idempotency-Key'] = submission.key;
    final response = await api.patchJson(
      NativePaths.companionPreferencesUpdate,
      data: submission.toJson(),
      headers: headers,
    );
    return CompanionResponse.fromJson(response, submission: submission);
  }

  @override
  Future<({List<CompanionConversation> threads, int omitted})> conversations(
    CancelToken cancelToken,
  ) async => parseCompanionConversations(
    await _get(NativePaths.threadsList(limit: 100), cancelToken),
    tenantId: scope.tenantId,
    actorId: scope.actorId,
  );
}
