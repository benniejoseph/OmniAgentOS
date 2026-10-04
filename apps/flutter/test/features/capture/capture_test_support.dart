import 'dart:async';
import 'dart:typed_data';

import 'package:asael/features/capture/capture_controller.dart';
import 'package:asael/features/capture/capture_models.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:asael/features/capture/capture_projection.dart';
import 'package:asael/features/capture/capture_recording.dart';
import 'package:dio/dio.dart';

const captureTestOwner = CaptureOwnerBinding(
  tenantId: 'tenant',
  actorId: 'actor',
  canonicalUserId: 'user-one',
  apiOrigin: 'https://capture.test',
  role: 'operator',
);
const captureTestHash =
    '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
Map<String, dynamic> captureTestAssetJson({
  String id = 'asset:東京/full%2F',
  String actor = 'actor',
  String status = 'queued',
  String extraction = 'pending',
  String? documentId,
}) => {
  'id': id,
  'tenantId': 'tenant',
  'actorId': actor,
  'filename': 'source.pdf',
  'mediaType': 'application/pdf',
  'byteCount': 3,
  'contentSha256': captureTestHash,
  'status': status,
  'extractionStatus': extraction,
  'ingestJobId': 'job-one',
  'knowledgeDocumentId': ?documentId,
  'contentAvailable': true,
};
CaptureDraft captureTestDraft() => CaptureDraft(
  content: 'Context',
  title: 'Exact original',
  file: CaptureAttachment(
    name: 'source.pdf',
    bytes: Uint8List.fromList([1, 2, 3]),
    contentType: 'application/pdf',
  ),
  kind: CaptureKind.file,
);

class CaptureTestOutbox implements CaptureOutbox {
  final entries = <CaptureOutboxEntry>[];
  Future<void> Function()? beforeList, beforeEnqueue;
  int removals = 0;
  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) async {
    await beforeEnqueue?.call();
    final id = 'capture-${entries.length}';
    final entry = CaptureOutboxEntry(
      id: id,
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.canonicalUserId,
      apiOrigin: owner.apiOrigin,
      createdAt: DateTime.utc(2026, 10, 4),
      idempotencyKey: 'capture-offline-$id',
      draft: draft,
    );
    entries.add(entry);
    return entry;
  }

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) async {
    await beforeList?.call();
    return entries.where(owner.owns).toList();
  }

  @override
  Future<CaptureOutboxEntry?> get(
    CaptureOwnerBinding owner,
    String entryId,
  ) async {
    final entry = entries
        .where((entry) => owner.owns(entry) && entry.id == entryId)
        .firstOrNull;
    if (entry == null) return null;
    final draft = entry.draft, file = entry.draft.file;
    return CaptureOutboxEntry(
      id: entry.id,
      tenantId: entry.tenantId,
      actorId: entry.actorId,
      canonicalUserId: entry.canonicalUserId,
      apiOrigin: entry.apiOrigin,
      createdAt: entry.createdAt,
      idempotencyKey: entry.idempotencyKey,
      draft: CaptureDraft(
        content: draft.content,
        title: draft.title,
        kind: draft.kind,
        tags: draft.tags,
        file: file == null
            ? null
            : CaptureAttachment(
                name: file.name,
                contentType: file.contentType,
                bytes: Uint8List.fromList(file.bytes),
              ),
      ),
    );
  }

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) async {
    removals++;
    entries.removeWhere((entry) => owner.owns(entry) && entry.id == entryId);
  }
}

class CaptureTestRepository
    implements
        CaptureRepository,
        FreshCaptureRepository,
        CaptureAssetRepository {
  Future<CaptureReceipt> Function(CaptureDraft) submitter = (draft) async =>
      CaptureReceipt(
        jobId: 'job-one',
        title: draft.title,
        tags: const [],
        source: draft.file == null
            ? 'capture://quick-note'
            : 'capture:asset:asset:東京/full%2F',
        asset: draft.file == null
            ? null
            : CaptureAssetSnapshot.fromJson(captureTestAssetJson()),
      );
  Future<CaptureJobSnapshot> Function(String) jobReader = (id) async =>
      CaptureJobSnapshot(
        id: id,
        status: 'running',
        progressStage: 'extracting',
      );
  Future<CaptureAssetSnapshot> Function(String) assetReader = (_) async =>
      CaptureAssetSnapshot.fromJson(captureTestAssetJson());
  final submissions = <CaptureDraft>[],
      keys = <String>[],
      cancelTokens = <CancelToken>[];
  int downloads = 0;
  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) {
    submissions.add(draft);
    keys.add(idempotencyKey);
    return submitter(draft);
  }

  @override
  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  }) => jobReader(jobId);
  @override
  Future<CaptureJobSnapshot> readJobFresh(
    String jobId, {
    required CaptureOwnerBinding owner,
    required CancelToken cancelToken,
  }) {
    cancelTokens.add(cancelToken);
    return jobReader(jobId);
  }

  @override
  Future<CaptureAssetSnapshot> readAsset(
    String id, {
    required CaptureOwnerBinding owner,
    required CancelToken cancelToken,
  }) {
    cancelTokens.add(cancelToken);
    return assetReader(id);
  }

  @override
  Future<Uint8List> downloadOriginal(
    CaptureAssetSnapshot asset, {
    required CaptureOwnerBinding owner,
  }) async {
    downloads++;
    return Uint8List.fromList([1, 2, 3]);
  }
}

class CaptureTestRecorder implements CaptureRecorder {
  final states = StreamController<bool>.broadcast();
  Future<bool> Function() permission = () async => true;
  Future<void> Function()? beforeStart, beforeStop;
  bool active = false,
      stopFails = false,
      cancelFails = false,
      stateFails = false;
  int starts = 0, stops = 0, cancels = 0;
  @override
  Stream<bool> get recordingChanges => states.stream;
  @override
  Future<bool> hasPermission() => permission();
  @override
  Future<bool> isRecording() async {
    if (stateFails) throw StateError('Synthetic status failure');
    return active;
  }

  @override
  Future<void> start() async {
    starts++;
    await beforeStart?.call();
    active = true;
    states.add(true);
  }

  @override
  Future<CaptureAttachment?> stop() async {
    stops++;
    await beforeStop?.call();
    if (stopFails) throw StateError('Synthetic stop failure');
    active = false;
    states.add(false);
    return CaptureAttachment(
      name: 'audio-note.wav',
      bytes: Uint8List.fromList([1, 2, 3]),
      contentType: 'audio/wav',
    );
  }

  @override
  Future<void> cancel() async {
    cancels++;
    if (cancelFails) throw StateError('Synthetic cancel failure');
    active = false;
    if (!states.isClosed) states.add(false);
  }

  @override
  Future<void> dispose() async {
    active = false;
    await states.close();
  }
}
