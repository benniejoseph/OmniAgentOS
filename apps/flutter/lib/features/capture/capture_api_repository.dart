import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'capture_controller.dart';
import 'capture_models.dart';
import 'capture_outbox.dart';
import 'capture_projection.dart';

class ApiCaptureRepository
    implements
        CaptureRepository,
        CaptureAssetRepository,
        FreshCaptureRepository {
  const ApiCaptureRepository(this.api, {required this.authorityCurrent});
  final ApiClient api;
  final bool Function(CaptureOwnerBinding owner) authorityCurrent;
  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) async {
    if (!draft.valid ||
        !owner.pinned ||
        owner.role == null ||
        owner.tenantId.isEmpty ||
        owner.actorId.isEmpty) {
      throw const FormatException(
        'A valid Capture draft and owner are required.',
      );
    }
    final authority = NativeRequestAuthority(
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.canonicalUserId!,
      role: owner.role!,
      apiBaseUrl: owner.apiOrigin!,
      isCurrent: () => authorityCurrent(owner),
    );
    authority.requireCurrent(api.apiBaseUrl);
    final originalHash = draft.file == null
        ? null
        : (await Sha256().hash(draft.file!.bytes)).bytes
              .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
              .join();
    authority.requireCurrent(api.apiBaseUrl);
    final ownerHash = await owner.sha256();
    authority.requireCurrent(api.apiBaseUrl);
    final json = await api.postMultipart(
      NativePaths.captureCreate,
      fields: {
        'content': draft.content,
        'title': draft.title,
        'tags': draft.tags.join(','),
      },
      bytes: draft.file?.bytes,
      filename: draft.file?.name,
      contentType: draft.file?.contentType,
      headers: {
        'idempotency-key': idempotencyKey,
        'x-request-id': idempotencyKey,
        'x-omni-correlation-id': idempotencyKey,
        'x-asael-capture-owner-sha256': ownerHash,
      },
      authority: authority,
    );
    final job = captureRecord(json['job']),
        capture = captureRecord(json['capture']);
    final expectedType = draft.file == null
        ? 'knowledge.ingest'
        : 'capture.asset.process';
    if (job['type'] != expectedType) {
      throw const FormatException(
        'Capture returned a different processing job type.',
      );
    }
    final asset = json['asset'] == null
        ? null
        : CaptureAssetSnapshot.fromJson(json['asset']);
    final source = captureText(capture['source'], maximum: 512),
        jobId = captureText(job['id']);
    if (draft.file != null &&
        (asset == null ||
            asset.tenantId != owner.tenantId ||
            asset.actorId != owner.actorId ||
            source != asset.source ||
            asset.ingestJobId != jobId ||
            asset.byteCount != draft.file!.byteLength ||
            asset.contentSha256 != originalHash)) {
      throw const FormatException(
        'Capture did not confirm this exact owner, original and processing job.',
      );
    }
    if (draft.file == null && source != 'capture://quick-note') {
      throw const FormatException(
        'Capture returned an unsupported note source.',
      );
    }
    final tags = capture['tags'];
    if (tags is! List || tags.length > 50) {
      throw const FormatException('Capture returned invalid tags.');
    }
    return CaptureReceipt(
      jobId: jobId,
      title: captureText(capture['title']),
      tags: List.unmodifiable(tags.map((tag) => captureText(tag, maximum: 80))),
      jobStatus: captureMember(job['status'], captureJobStates),
      progressStage: captureProgressStage(job['progress']),
      lastError: captureOptionalText(job['lastError']),
      source: source,
      asset: asset,
    );
  }

  @override
  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  }) => readJobFresh(jobId, owner: owner, cancelToken: CancelToken());

  @override
  Future<CaptureJobSnapshot> readJobFresh(
    String jobId, {
    required CaptureOwnerBinding owner,
    required CancelToken cancelToken,
  }) async {
    if (owner.tenantId.trim().isEmpty || owner.actorId.trim().isEmpty) {
      throw const FormatException('A Capture owner is required.');
    }
    final json = await api.getJsonFreshCancelable(
      NativePaths.operationsJob(jobId),
      cancelToken: cancelToken,
    );
    final job = captureRecord(json['job']);
    final returnedId = captureText(job['id']);
    final status = captureMember(job['status'], captureJobStates);
    if (returnedId != jobId ||
        !const {
          'capture.asset.process',
          'knowledge.ingest',
        }.contains(job['type'])) {
      throw const FormatException(
        'The Capture service returned an invalid processing job.',
      );
    }
    return CaptureJobSnapshot(
      id: returnedId,
      status: status,
      progressStage: captureProgressStage(job['progress']),
      lastError: captureOptionalText(job['lastError']),
      documentId: job['result'] == null
          ? null
          : captureOptionalId(captureRecord(job['result'])['documentId']),
    );
  }

  @override
  Future<CaptureAssetSnapshot> readAsset(
    String id, {
    required CaptureOwnerBinding owner,
    required CancelToken cancelToken,
  }) async {
    final json = await api.getJsonFreshCancelable(
      NativePaths.captureAssetGet(id),
      cancelToken: cancelToken,
    );
    final asset = CaptureAssetSnapshot.fromJson(json['asset']);
    if (asset.id != id ||
        asset.tenantId != owner.tenantId ||
        asset.actorId != owner.actorId) {
      throw const FormatException(
        'The original does not match this exact Capture owner and identity.',
      );
    }
    return asset;
  }

  @override
  Future<Uint8List> downloadOriginal(
    CaptureAssetSnapshot asset, {
    required CaptureOwnerBinding owner,
  }) async {
    if (!asset.contentAvailable ||
        asset.tenantId != owner.tenantId ||
        asset.actorId != owner.actorId) {
      throw const FormatException(
        'Refresh the exact authorized original before saving.',
      );
    }
    final bytes = await api.getBytes(
      NativePaths.captureAssetGet(asset.id, content: true),
      maximumBytes: asset.byteCount,
    );
    final hash = await Sha256().hash(bytes);
    final hex = hash.bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
    if (bytes.length != asset.byteCount || hex != asset.contentSha256) {
      throw const FormatException(
        'The original changed or failed its content identity check.',
      );
    }
    return bytes;
  }
}
